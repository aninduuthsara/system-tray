import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PackagingType, extractAppIdFromUnit} from '../core/registry.js';

const SYSTEMD_BUS = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';
const SYSTEMD_UNIT_IFACE = 'org.freedesktop.systemd1.Unit';

const PORTAL_BUS = 'org.freedesktop.portal.Desktop';
const PORTAL_PATH = '/org/freedesktop/portal/desktop';
const PORTAL_BG_IFACE = 'org.freedesktop.background.Monitor';

const DBUS_PROPS_IFACE = 'org.freedesktop.DBus.Properties';

const UNIT_PATTERNS = ['app-*.scope', 'app-*.service', 'dbus-*.service'];

function dbusCallAsync(busName, objectPath, interfaceName, methodName, parameters, replyType, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            busName,
            objectPath,
            interfaceName,
            methodName,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            4000,
            cancellable,
            (conn, res) => {
                try {
                    resolve(conn.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            }
        );
    });
}

function isCandidateUnitName(unitName) {
    if (!unitName || typeof unitName !== 'string')
        return false;

    // Ignore terminal spawn scopes (e.g., htop/bash tabs inside terminal)
    if (unitName.startsWith('vte-spawn-'))
        return false;

    if (!unitName.endsWith('.scope') && !unitName.endsWith('.service'))
        return false;

    return (
        unitName.startsWith('app-') ||
        unitName.startsWith('dbus-')
    );
}

function isAppSlice(sliceName) {
    if (!sliceName || typeof sliceName !== 'string')
        return false;
    return sliceName === 'app.slice' || sliceName.startsWith('app-');
}

export class SystemdWatcher {
    /**
     * @param {import('../core/registry.js').ApplicationRegistry} registry
     * @param {Gio.Settings} settings
     */
    constructor(registry, settings) {
        this._registry = registry;
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();

        this._trackedUnits = new Map(); // unitName -> unitPath
        this._unitPathToName = new Map(); // unitPath -> unitName
        this._pendingInspectTimers = new Map(); // unitName -> sourceId
        this._followUpTimers = new Set();
        this._portalApps = new Set(); // appId strings currently reported by portal

        this._signalIds = [];
        this._portalSignalId = 0;
        this._settingsSignalId = 0;
        this._subscribed = false;
    }

    async start() {
        await this._subscribeSystemd();
        await this._scanActiveUnits();

        if (this._settings?.get_boolean('enable-portal-monitor'))
            await this._startPortalMonitor();

        if (this._settings) {
            this._settingsSignalId = this._settings.connect('changed::enable-portal-monitor', () => {
                if (this._settings.get_boolean('enable-portal-monitor'))
                    this._startPortalMonitor().catch(() => {});
                else
                    this._stopPortalMonitor();
            });
        }
    }

    async _subscribeSystemd() {
        try {
            await dbusCallAsync(
                SYSTEMD_BUS,
                SYSTEMD_PATH,
                SYSTEMD_MANAGER_IFACE,
                'Subscribe',
                null,
                null,
                this._cancellable
            );
            this._subscribed = true;
        } catch (e) {
            console.debug(`[SystemTray] Systemd Subscribe failed: ${e.message}`);
        }

        // 1. UnitNew
        this._signalIds.push(
            Gio.DBus.session.signal_subscribe(
                SYSTEMD_BUS,
                SYSTEMD_MANAGER_IFACE,
                'UnitNew',
                SYSTEMD_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [unitName, unitPath] = params.recursiveUnpack();
                    if (isCandidateUnitName(unitName))
                        this._scheduleInspectUnit(unitName, unitPath);
                }
            )
        );

        // 2. UnitRemoved
        this._signalIds.push(
            Gio.DBus.session.signal_subscribe(
                SYSTEMD_BUS,
                SYSTEMD_MANAGER_IFACE,
                'UnitRemoved',
                SYSTEMD_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [unitName] = params.recursiveUnpack();
                    this._handleUnitGone(unitName);
                }
            )
        );

        // 3. JobRemoved (detects completed start jobs cleanly)
        this._signalIds.push(
            Gio.DBus.session.signal_subscribe(
                SYSTEMD_BUS,
                SYSTEMD_MANAGER_IFACE,
                'JobRemoved',
                SYSTEMD_PATH,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [_id, _jobPath, unitName, result] = params.recursiveUnpack();
                    if (!isCandidateUnitName(unitName))
                        return;
                    if (result === 'done')
                        this._scheduleInspectUnit(unitName, this._trackedUnits.get(unitName) ?? null);
                }
            )
        );

        // 4. Unit PropertiesChanged (instant removal when ActiveState drops to inactive/failed)
        this._signalIds.push(
            Gio.DBus.session.signal_subscribe(
                SYSTEMD_BUS,
                DBUS_PROPS_IFACE,
                'PropertiesChanged',
                null,
                SYSTEMD_UNIT_IFACE,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, objPath, _iface, _signal, params) => {
                    const unitName = this._unitPathToName.get(objPath);
                    if (!unitName)
                        return;

                    const [_ifaceName, changed] = params.recursiveUnpack();
                    const activeState = changed?.ActiveState;
                    if (activeState === 'inactive' || activeState === 'failed' || activeState === 'deactivating')
                        this._handleUnitGone(unitName);
                    else if (activeState === 'active')
                        this._scheduleInspectUnit(unitName, objPath);
                }
            )
        );
    }

    async _scanActiveUnits() {
        try {
            const reply = await dbusCallAsync(
                SYSTEMD_BUS,
                SYSTEMD_PATH,
                SYSTEMD_MANAGER_IFACE,
                'ListUnitsByPatterns',
                new GLib.Variant('(asas)', [['active', 'activating', 'reloading'], UNIT_PATTERNS]),
                new GLib.VariantType('(a(ssssssouso))'),
                this._cancellable
            );

            const [units] = reply.recursiveUnpack();
            for (const entry of units) {
                const unitName = entry[0];
                const activeState = entry[3];
                const unitPath = entry[6];
                if (isCandidateUnitName(unitName) && (activeState === 'active' || activeState === 'activating'))
                    await this._inspectAndRegisterUnit(unitName, unitPath);
            }
        } catch (e) {
            console.debug(`[SystemTray] ListUnitsByPatterns error: ${e.message}`);
        }
    }

    _scheduleInspectUnit(unitName, unitPath) {
        if (this._pendingInspectTimers.has(unitName))
            return;

        // Short 60ms coalesce so newly spawned scope has its cgroup PIDs populated
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._pendingInspectTimers.delete(unitName);
            this._inspectAndRegisterUnit(unitName, unitPath).catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
        this._pendingInspectTimers.set(unitName, id);
    }

    async _inspectAndRegisterUnit(unitName, knownPath = null) {
        if (this._cancellable.is_cancelled())
            return;

        try {
            let unitPath = knownPath;
            if (!unitPath) {
                const pathReply = await dbusCallAsync(
                    SYSTEMD_BUS,
                    SYSTEMD_PATH,
                    SYSTEMD_MANAGER_IFACE,
                    'GetUnit',
                    new GLib.Variant('(s)', [unitName]),
                    new GLib.VariantType('(o)'),
                    this._cancellable
                );
                [unitPath] = pathReply.recursiveUnpack();
            }

            if (!unitPath)
                return;

            // Fetch unit active state & slice
            const specificIface = unitName.endsWith('.scope')
                ? 'org.freedesktop.systemd1.Scope'
                : 'org.freedesktop.systemd1.Service';

            const [unitPropsReply, specificPropsReply] = await Promise.all([
                dbusCallAsync(
                    SYSTEMD_BUS,
                    unitPath,
                    DBUS_PROPS_IFACE,
                    'GetAll',
                    new GLib.Variant('(s)', [SYSTEMD_UNIT_IFACE]),
                    new GLib.VariantType('(a{sv})'),
                    this._cancellable
                ),
                dbusCallAsync(
                    SYSTEMD_BUS,
                    unitPath,
                    DBUS_PROPS_IFACE,
                    'GetAll',
                    new GLib.Variant('(s)', [specificIface]),
                    new GLib.VariantType('(a{sv})'),
                    this._cancellable
                ),
            ]);

            const [unitProps] = unitPropsReply.recursiveUnpack();
            const [specificProps] = specificPropsReply.recursiveUnpack();

            const activeState = unitProps.ActiveState;
            if (activeState !== 'active' && activeState !== 'activating') {
                this._handleUnitGone(unitName);
                return;
            }

            const slice = specificProps.Slice ?? '';
            const isDbusApp = unitName.startsWith('dbus-') && Boolean(extractAppIdFromUnit(unitName));
            if (!isAppSlice(slice) && !isDbusApp)
                return;

            // Fetch all PIDs inside this cgroup (zero /proc polling)
            let pids = [];
            let cmdHint = '';
            let hasFlatpakCgroup = false;

            try {
                const procsReply = await dbusCallAsync(
                    SYSTEMD_BUS,
                    SYSTEMD_PATH,
                    SYSTEMD_MANAGER_IFACE,
                    'GetUnitProcesses',
                    new GLib.Variant('(s)', [unitName]),
                    new GLib.VariantType('(a(sus))'),
                    this._cancellable
                );
                const [procs] = procsReply.recursiveUnpack();
                for (const [cgroup, pid, cmd] of procs) {
                    if (pid > 1)
                        pids.push(pid);
                    if (!cmdHint && cmd)
                        cmdHint = cmd;
                    if (cgroup?.includes('flatpak'))
                        hasFlatpakCgroup = true;
                }
            } catch {
                const mainPid = specificProps.MainPID ?? 0;
                if (mainPid > 1)
                    pids.push(mainPid);
            }

            if (pids.length === 0 && activeState !== 'activating') {
                this._handleUnitGone(unitName);
                return;
            }

            this._trackedUnits.set(unitName, unitPath);
            this._unitPathToName.set(unitPath, unitName);

            // Detect packaging type
            let packaging = PackagingType.NATIVE;
            if (unitName.startsWith('app-flatpak-') || hasFlatpakCgroup)
                packaging = PackagingType.FLATPAK;
            else if (cmdHint.toLowerCase().includes('.appimage'))
                packaging = PackagingType.APPIMAGE;

            if (this._cancellable.is_cancelled())
                return;

            const extractedId = extractAppIdFromUnit(unitName);
            const rawDesc = unitProps.Description || '';
            const cleanDesc = /^(dbus-|app-)/i.test(rawDesc) ? '' : rawDesc;

            this._registry.upsertSource('systemd', {
                unitName,
                appId: extractedId || undefined,
                displayName: cleanDesc || extractedId || unitName,
                pids,
                processCount: pids.length || 1,
                packaging,
            });

            // One-shot follow-up check after 1.2s to catch newly spawned child processes (tabs/workers)
            const followId = GLib.timeout_add(GLib.PRIORITY_LOW, 1200, () => {
                this._followUpTimers.delete(followId);
                if (!this._cancellable.is_cancelled() && this._trackedUnits.has(unitName))
                    this._refreshSingleUnitCount(unitName).catch(() => {});
                return GLib.SOURCE_REMOVE;
            });
            this._followUpTimers.add(followId);
        } catch {
            // Unit already exited before inspection finished
        }
    }

    async _refreshSingleUnitCount(unitName) {
        try {
            const procsReply = await dbusCallAsync(
                SYSTEMD_BUS,
                SYSTEMD_PATH,
                SYSTEMD_MANAGER_IFACE,
                'GetUnitProcesses',
                new GLib.Variant('(s)', [unitName]),
                new GLib.VariantType('(a(sus))'),
                this._cancellable
            );
            const [procs] = procsReply.recursiveUnpack();
            const pids = [];
            for (const [_cgroup, pid] of procs) {
                if (pid > 1)
                    pids.push(pid);
            }
            if (pids.length > 0) {
                this._registry.upsertSource('systemd', {
                    unitName,
                    pids,
                    processCount: pids.length,
                });
            } else {
                this._handleUnitGone(unitName);
            }
        } catch {
            this._handleUnitGone(unitName);
        }
    }

    /**
     * Refresh real-time process counts for all running apps (called ONLY while popup is open).
     */
    async refreshProcessCounts() {
        if (this._cancellable.is_cancelled())
            return;

        // 1. Link any GNOME/SNI app that lacks a systemd unit yet via GetUnitByPID
        const linkTasks = [];
        for (const record of this._registry.getAllEligibleApps()) {
            if (record.unitNames.size > 0 || record.pids.size === 0)
                continue;

            const [firstPid] = record.pids;
            if (!firstPid || firstPid <= 1)
                continue;

            linkTasks.push(
                dbusCallAsync(
                    SYSTEMD_BUS,
                    SYSTEMD_PATH,
                    SYSTEMD_MANAGER_IFACE,
                    'GetUnitByPID',
                    new GLib.Variant('(u)', [firstPid]),
                    new GLib.VariantType('(o)'),
                    this._cancellable
                ).then(async reply => {
                    const [unitPath] = reply.recursiveUnpack();
                    if (!unitPath)
                        return;
                    const idReply = await dbusCallAsync(
                        SYSTEMD_BUS,
                        unitPath,
                        DBUS_PROPS_IFACE,
                        'Get',
                        new GLib.Variant('(ss)', [SYSTEMD_UNIT_IFACE, 'Id']),
                        new GLib.VariantType('(v)'),
                        this._cancellable
                    );
                    const [unitName] = idReply.recursiveUnpack();
                    if (unitName && isCandidateUnitName(unitName))
                        await this._inspectAndRegisterUnit(unitName, unitPath);
                }).catch(() => {})
            );
        }
        if (linkTasks.length > 0)
            await Promise.allSettled(linkTasks);

        // 2. Refresh live child process counts for all tracked units
        const countTasks = [...this._trackedUnits.keys()].map(u => this._refreshSingleUnitCount(u));
        if (countTasks.length > 0)
            await Promise.allSettled(countTasks);
    }
    _handleUnitGone(unitName) {
        const timerId = this._pendingInspectTimers.get(unitName);
        if (timerId) {
            GLib.source_remove(timerId);
            this._pendingInspectTimers.delete(unitName);
        }

        const unitPath = this._trackedUnits.get(unitName);
        if (unitPath) {
            this._trackedUnits.delete(unitName);
            this._unitPathToName.delete(unitPath);
        }

        this._registry.removeSource('systemd', unitName);
    }

    // -------------------------------------------------------------------------
    // XDG Background Portal Cross-Check (Flatpak)
    // -------------------------------------------------------------------------

    async _startPortalMonitor() {
        if (this._portalSignalId)
            return;

        this._portalSignalId = Gio.DBus.session.signal_subscribe(
            PORTAL_BUS,
            DBUS_PROPS_IFACE,
            'PropertiesChanged',
            PORTAL_PATH,
            PORTAL_BG_IFACE,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [_ifaceName, changed] = params.recursiveUnpack();
                if (changed?.BackgroundApps)
                    this._syncPortalApps(changed.BackgroundApps);
            }
        );

        await this._fetchPortalBackgroundApps();
    }

    async _fetchPortalBackgroundApps() {
        try {
            const reply = await dbusCallAsync(
                PORTAL_BUS,
                PORTAL_PATH,
                DBUS_PROPS_IFACE,
                'Get',
                new GLib.Variant('(ss)', [PORTAL_BG_IFACE, 'BackgroundApps']),
                new GLib.VariantType('(v)'),
                this._cancellable
            );
            const [variantValue] = reply.recursiveUnpack();
            if (Array.isArray(variantValue))
                this._syncPortalApps(variantValue);
        } catch {
            // Portal monitor not supported or no background apps yet
        }
    }

    _syncPortalApps(portalList) {
        const currentIds = new Set();

        for (const entry of portalList) {
            const appId = entry?.app_id;
            if (!appId)
                continue;

            // Cross-verify against live tracked systemd scopes to prevent upstream ghost bug (#2164)
            const hasLiveSystemdMatch = this._hasLiveUnitForAppId(appId);
            if (!hasLiveSystemdMatch)
                continue;

            currentIds.add(appId);
            this._registry.upsertSource('portal', {
                appId,
                packaging: PackagingType.FLATPAK,
            });
        }

        // Remove portal apps no longer present
        for (const oldId of this._portalApps) {
            if (!currentIds.has(oldId))
                this._registry.removeSource('portal', oldId);
        }
        this._portalApps = currentIds;
    }

    _hasLiveUnitForAppId(appId) {
        const existing = this._registry.getRecord(appId);
        if (existing && (existing.systemdActive || existing.sniItems.size > 0))
            return true;

        const lower = appId.toLowerCase();
        for (const unitName of this._trackedUnits.keys()) {
            if (unitName.toLowerCase().includes(lower))
                return true;
        }
        return false;
    }

    _stopPortalMonitor() {
        if (this._portalSignalId) {
            Gio.DBus.session.signal_unsubscribe(this._portalSignalId);
            this._portalSignalId = 0;
        }
        for (const appId of this._portalApps)
            this._registry.removeSource('portal', appId);
        this._portalApps.clear();
    }

    destroy() {
        this._cancellable.cancel();

        for (const id of this._pendingInspectTimers.values())
            GLib.source_remove(id);
        this._pendingInspectTimers.clear();

        for (const id of this._followUpTimers)
            GLib.source_remove(id);
        this._followUpTimers.clear();

        for (const sigId of this._signalIds)
            Gio.DBus.session.signal_unsubscribe(sigId);
        this._signalIds = [];

        this._stopPortalMonitor();

        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        if (this._subscribed) {
            this._subscribed = false;
            try {
                Gio.DBus.session.call(
                    SYSTEMD_BUS,
                    SYSTEMD_PATH,
                    SYSTEMD_MANAGER_IFACE,
                    'Unsubscribe',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    1000,
                    null,
                    null
                );
            } catch {
                // Ignore during shutdown
            }
        }

        this._trackedUnits.clear();
        this._unitPathToName.clear();
    }
}