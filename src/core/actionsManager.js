import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {normalizeId} from './registry.js';

const SYSTEMD_BUS = 'org.freedesktop.systemd1';
const SYSTEMD_PATH = '/org/freedesktop/systemd1';
const SYSTEMD_MANAGER_IFACE = 'org.freedesktop.systemd1.Manager';

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
            3000,
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

async function readTextFileAsync(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    const [bytes] = await new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (src, res) => {
            try {
                const [ok, contents] = src.load_contents_finish(res);
                resolve(ok ? [contents] : [null]);
            } catch (e) {
                reject(e);
            }
        });
    });
    if (!bytes)
        return '';
    return new TextDecoder().decode(bytes);
}

async function collectDescendantPidsAsync(rootPids, cancellable) {
    const visited = new Set();
    const queue = [...rootPids].filter(p => Number.isInteger(p) && p > 1);

    while (queue.length > 0 && !cancellable.is_cancelled()) {
        const pid = queue.shift();
        if (visited.has(pid))
            continue;
        visited.add(pid);

        try {
            const taskDir = Gio.File.new_for_path(`/proc/${pid}/task`);
            const enumerator = await new Promise((resolve, reject) => {
                taskDir.enumerate_children_async(
                    'standard::name',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_LOW,
                    cancellable,
                    (src, res) => {
                        try {
                            resolve(src.enumerate_children_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            let info;
            while ((info = enumerator.next_file(cancellable)) !== null) {
                const tid = info.get_name();
                try {
                    const childrenTxt = await readTextFileAsync(
                        `/proc/${pid}/task/${tid}/children`,
                        cancellable
                    );
                    for (const token of childrenTxt.trim().split(/\s+/)) {
                        const childPid = parseInt(token, 10);
                        if (Number.isInteger(childPid) && childPid > 1 && !visited.has(childPid))
                            queue.push(childPid);
                    }
                } catch {
                    // Thread may have exited
                }
            }
            enumerator.close(null);
        } catch {
            // Process may have exited
        }
    }

    return [...visited];
}

const NEVER_KILL_PARENTS = new Set([
    'systemd', 'gnome-shell', 'gdm', 'gdm-wayland-session', 'dbus-daemon', 'dbus-broker',
    'bash', 'zsh', 'sh', 'fish', 'dash', 'ptyxis', 'ptyxis-agent', 'gnome-terminal-server',
    'kgx', 'konsole', 'alacritty', 'kitty', 'wezterm-gui', 'flatpak-session-helper',
    'xdg-dbus-proxy', 'bwrap', 'init',
]);

async function getProcInfoAsync(pid, cancellable) {
    const info = {pid, ppid: 0, comm: '', exe: ''};
    try {
        const [statTxt, commTxt] = await Promise.all([
            readTextFileAsync(`/proc/${pid}/stat`, cancellable).catch(() => ''),
            readTextFileAsync(`/proc/${pid}/comm`, cancellable).catch(() => ''),
        ]);
        info.comm = commTxt.trim().toLowerCase();
        // /proc/<pid>/stat format: "pid (comm) state ppid ..."
        const rparen = statTxt.lastIndexOf(')');
        if (rparen > 0) {
            const fields = statTxt.slice(rparen + 2).trim().split(/\s+/);
            const ppid = parseInt(fields[1], 10);
            if (Number.isInteger(ppid) && ppid > 1)
                info.ppid = ppid;
        }
        const exeFile = Gio.File.new_for_path(`/proc/${pid}/exe`);
        const fInfo = await new Promise((resolve, reject) => {
            exeFile.query_info_async(
                'standard::symlink-target',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW,
                cancellable,
                (src, res) => {
                    try {
                        resolve(src.query_info_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
        info.exe = fInfo.get_symlink_target() ?? '';
    } catch {
        // Process may have exited or permission denied
    }
    return info;
}

async function resolveAppFamilyPidsAsync(seedPids, cancellable) {
    const roots = new Set();
    const seedInfos = [];

    for (const pid of seedPids) {
        if (!Number.isInteger(pid) || pid <= 1)
            continue;
        roots.add(pid);
        const info = await getProcInfoAsync(pid, cancellable);
        seedInfos.push(info);

        // Walk upward ONLY while parent belongs to the exact same app (e.g. Electron main process)
        let cur = info;
        for (let depth = 0; depth < 4 && cur.ppid > 1; depth++) {
            const pInfo = await getProcInfoAsync(cur.ppid, cancellable);
            if (!pInfo.comm || NEVER_KILL_PARENTS.has(pInfo.comm))
                break;

            const sameComm = cur.comm && pInfo.comm === cur.comm;
            const sameExe = cur.exe && pInfo.exe && cur.exe === pInfo.exe;
            const sameAppImageMount =
                cur.exe.includes('/tmp/.mount_') &&
                pInfo.exe.includes('/tmp/.mount_') &&
                cur.exe.split('/')[2] === pInfo.exe.split('/')[2];

            if (!sameComm && !sameExe && !sameAppImageMount)
                break;

            roots.add(pInfo.pid);
            cur = pInfo;
        }
    }

    // Collect all descendants downward from the root processes
    const family = await collectDescendantPidsAsync([...roots], cancellable);
    const familySet = new Set(family);

    // Also catch sibling processes sharing the exact same executable binary (safe against generic interpreters)
    const exeTargets = new Set(
        seedInfos
            .map(i => i.exe)
            .filter(e =>
                e &&
                !e.endsWith('/bash') &&
                !e.endsWith('/sh') &&
                !e.endsWith('/python3') &&
                !e.endsWith('/java') &&
                !e.endsWith('/electron')
            )
    );

    if (exeTargets.size > 0) {
        try {
            const procDir = Gio.File.new_for_path('/proc');
            const enumerator = await new Promise((resolve, reject) => {
                procDir.enumerate_children_async(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_LOW,
                    cancellable,
                    (src, res) => {
                        try {
                            resolve(src.enumerate_children_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            let fInfo;
            while ((fInfo = enumerator.next_file(cancellable)) !== null) {
                const name = fInfo.get_name();
                if (!/^\d+$/.test(name))
                    continue;
                const p = parseInt(name, 10);
                if (p <= 1 || familySet.has(p))
                    continue;
                try {
                    const exeFile = Gio.File.new_for_path(`/proc/${p}/exe`);
                    const linkInfo = await new Promise((resolve, reject) => {
                        exeFile.query_info_async(
                            'standard::symlink-target',
                            Gio.FileQueryInfoFlags.NONE,
                            GLib.PRIORITY_LOW,
                            cancellable,
                            (src, res) => {
                                try {
                                    resolve(src.query_info_finish(res));
                                } catch (e) {
                                    reject(e);
                                }
                            }
                        );
                    });
                    const target = linkInfo.get_symlink_target() ?? '';
                    if (exeTargets.has(target))
                        familySet.add(p);
                } catch {
                    // Different user or exited
                }
            }
            enumerator.close(null);
        } catch {
            // Ignore
        }
    }

    return [...familySet];
}

async function spawnKillAsync(signalNum, pids, cancellable) {
    const valid = [...new Set(pids)].filter(p => Number.isInteger(p) && p > 1);
    if (valid.length === 0)
        return false;

    const killBin = GLib.find_program_in_path('kill') || '/usr/bin/kill';
    const proc = Gio.Subprocess.new(
        [killBin, `-${signalNum}`, ...valid.map(String)],
        Gio.SubprocessFlags.STDERR_PIPE
    );
    return new Promise(resolve => {
        proc.wait_check_async(cancellable, (src, res) => {
            try {
                resolve(src.wait_check_finish(res));
            } catch {
                resolve(false);
            }
        });
    });
}

export class ActionsManager {
    /**
     * @param {import('./registry.js').ApplicationRegistry} registry
     * @param {Gio.Settings} settings
     */
    constructor(registry, settings) {
        this._registry = registry;
        this._settings = settings;
        this._sniWatcher = null;
        this._cancellable = new Gio.Cancellable();
        this._timers = new Set();
    }

    setSniWatcher(sniWatcher) {
        this._sniWatcher = sniWatcher;
    }

    _delay(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timers.add(id);
        });
    }

    _createActivationContext(record) {
        const timestamp = global.get_current_time();
        const launchContext = global.create_app_launch_context(timestamp, -1);
        const appInfo =
            record.desktopAppInfo ??
            Gio.AppInfo.create_from_commandline('true', record.displayName ?? 'App', Gio.AppInfoCreateFlags.NONE);

        const token = launchContext.get_startup_notify_id(appInfo, []);
        return {launchContext, token};
    }

    /**
     * 3-Tier Smart Open:
     * 1. Existing Meta.Window -> Main.activateWindow()
     * 2. SNI Item -> Wayland XdgActivation Token + Activate(0, 0)
     * 3. Desktop / Custom Launch -> Single-instance activation
     */
    async openApp(record) {
        if (!record)
            return false;

        // Tier 1: Focus existing window if any
        const windows = this._registry.getWindowsForRecord(record);
        if (windows.length > 0) {
            windows.sort((a, b) => (b.get_user_time?.() ?? 0) - (a.get_user_time?.() ?? 0));
            Main.activateWindow(windows[0]);
            return true;
        }

        // Tier 2: SNI Activation with Wayland XdgActivation Token
        for (const item of record.sniItems.values()) {
            const {launchContext, token} = this._createActivationContext(record);
            try {
                if (token) {
                    try {
                        await dbusCallAsync(
                            item.busName,
                            item.objectPath,
                            'org.kde.StatusNotifierItem',
                            'ProvideXdgActivationToken',
                            new GLib.Variant('(s)', [token]),
                            null,
                            this._cancellable
                        );
                    } catch {
                        // Optional method on some SNI implementations
                    }
                }

                try {
                    await dbusCallAsync(
                        item.busName,
                        item.objectPath,
                        'org.kde.StatusNotifierItem',
                        'Activate',
                        new GLib.Variant('(ii)', [0, 0]),
                        null,
                        this._cancellable
                    );
                    return true;
                } catch {
                    // Some Electron/Chromium tray apps use SecondaryActivate or menu open
                    await dbusCallAsync(
                        item.busName,
                        item.objectPath,
                        'org.kde.StatusNotifierItem',
                        'SecondaryActivate',
                        new GLib.Variant('(ii)', [0, 0]),
                        null,
                        this._cancellable
                    );
                    return true;
                }
            } catch {
                if (token) {
                    try {
                        launchContext.launch_failed(token);
                    } catch {
                        // Ignore
                    }
                }
            }
        }

        // Tier 3: Re-launch desktop entry (triggers single-instance window reveal)
        if (record.desktopAppInfo) {
            try {
                const {launchContext} = this._createActivationContext(record);
                record.desktopAppInfo.launch([], launchContext);
                return true;
            } catch (e) {
                console.debug(`[SystemTray] Desktop launch failed for ${record.canonicalId}: ${e.message}`);
            }
        }

        // Tier 3b: Custom Rule execPath fallback
        for (const rule of record.customRules.values()) {
            if (!rule.execPath)
                continue;
            try {
                const {launchContext} = this._createActivationContext(record);
                const customInfo = Gio.AppInfo.create_from_commandline(
                    rule.execPath,
                    record.displayName ?? rule.name ?? 'CustomApp',
                    Gio.AppInfoCreateFlags.NONE
                );
                customInfo.launch([], launchContext);
                return true;
            } catch (e) {
                console.debug(`[SystemTray] Custom launch failed: ${e.message}`);
            }
        }

        return false;
    }

    /**
     * Graceful Quit: SNI DBusMenu Quit -> GApplication.Quit -> SIGTERM
     */
    async quitApp(record) {
        if (!record)
            return false;

        this._registry.markStopping(record.canonicalId);

        // 1. Try native SNI DBusMenu Quit/Exit item (cleanest for OBS, Telegram, Motrix)
        if (this._sniWatcher && record.sniItems.size > 0) {
            for (const item of record.sniItems.values()) {
                try {
                    const quitTriggered = await this._sniWatcher.triggerQuitAction(item);
                    if (quitTriggered)
                        return true;
                } catch {
                    // Fallback below
                }
            }
        }

        // 2. Try GApplication DBus Quit if desktop ID is well-formed
        if (record.desktopAppInfo) {
            const busId = record.desktopAppInfo.get_id().replace(/\.desktop$/i, '');
            if (busId.includes('.')) {
                const objPath = `/${busId.replace(/\./g, '/')}`;
                try {
                    await dbusCallAsync(
                        busId,
                        objPath,
                        'org.freedesktop.Application',
                        'Quit',
                        new GLib.Variant('(a{sv})', [{}]),
                        null,
                        this._cancellable
                    );
                    return true;
                } catch {
                    // Not a GApplication
                }
            }
        }

        // 3. Systemd SIGTERM (15) to unit cgroup
        if (record.unitNames.size > 0) {
            await this._killSystemdUnits(record.unitNames, 15);
            return true;
        }

        // 4. Custom PID tree SIGTERM
        if (record.pids.size > 0) {
            const pids = await collectDescendantPidsAsync(record.pids, this._cancellable);
            await spawnKillAsync(15, pids, this._cancellable);
            return true;
        }

        return false;
    }

    /**
     * Force Quit (End Task): kills entire systemd cgroup or process tree with SIGKILL (9).
     */
    async _lookupAppUnitByPids(pids) {
        for (const pid of pids) {
            if (!Number.isInteger(pid) || pid <= 1)
                continue;
            try {
                const unitReply = await dbusCallAsync(
                    SYSTEMD_BUS,
                    SYSTEMD_PATH,
                    SYSTEMD_MANAGER_IFACE,
                    'GetUnitByPID',
                    new GLib.Variant('(u)', [pid]),
                    new GLib.VariantType('(o)'),
                    this._cancellable
                );
                const [unitPath] = unitReply.recursiveUnpack();
                if (!unitPath)
                    continue;

                const idReply = await dbusCallAsync(
                    SYSTEMD_BUS,
                    unitPath,
                    'org.freedesktop.DBus.Properties',
                    'Get',
                    new GLib.Variant('(ss)', ['org.freedesktop.systemd1.Unit', 'Id']),
                    new GLib.VariantType('(v)'),
                    this._cancellable
                );
                const [unitName] = idReply.recursiveUnpack();
                if (
                    unitName &&
                    !unitName.startsWith('vte-spawn-') &&
                    !unitName.startsWith('session') &&
                    (unitName.startsWith('app-') || unitName.startsWith('dbus-'))
                ) {
                    return unitName;
                }
            } catch {
                // Continue to next PID
            }
        }
        return null;
    }

    async forceQuitApp(record) {
        if (!record)
            return false;

        this._registry.markStopping(record.canonicalId);

        const mode = this._settings?.get_string('force-quit-mode') ?? 'immediate';
        const graceMs = this._settings?.get_int('force-quit-grace-ms') ?? 800;

        // Gather every known PID from all sources (systemd, shellApp, SNI, windows)
        const seedPids = new Set(record.pids);
        for (const p of record.shellApp?.get_pids?.() ?? []) {
            if (p > 1)
                seedPids.add(p);
        }
        for (const item of record.sniItems.values()) {
            if (item.pid > 1)
                seedPids.add(item.pid);
        }
        for (const win of this._registry.getWindowsForRecord(record)) {
            const wp = win.get_pid?.() ?? 0;
            if (wp > 1)
                seedPids.add(wp);
        }

        // Resolve systemd unit even if not yet linked
        const units = new Set(record.unitNames);
        if (units.size === 0 && seedPids.size > 0) {
            const discoveredUnit = await this._lookupAppUnitByPids(seedPids);
            if (discoveredUnit)
                units.add(discoveredUnit);
        }

        if (units.size > 0) {
            if (mode === 'escalate') {
                await this._killSystemdUnits(units, 15);
                await this._delay(graceMs);
                if (this._cancellable.is_cancelled())
                    return false;
            }
            await this._killSystemdUnits(units, 9);
        }

        // Always sweep any remaining app family / sibling processes if needed
        if (seedPids.size > 0) {
            const familyPids = await resolveAppFamilyPidsAsync([...seedPids], this._cancellable);
            if (familyPids.length > 0) {
                if (mode === 'escalate' && units.size === 0) {
                    await spawnKillAsync(15, familyPids, this._cancellable);
                    await this._delay(graceMs);
                    if (this._cancellable.is_cancelled())
                        return false;
                }
                await spawnKillAsync(9, familyPids, this._cancellable);
            }
        }

        await this._delay(250);
        if (!this._cancellable.is_cancelled())
            this._registry.reconcileNow();

        return true;
    }

    async _killSystemdUnits(unitNames, signalNum) {
        for (const unitName of unitNames) {
            try {
                await dbusCallAsync(
                    SYSTEMD_BUS,
                    SYSTEMD_PATH,
                    SYSTEMD_MANAGER_IFACE,
                    'KillUnit',
                    new GLib.Variant('(ssi)', [unitName, 'all', signalNum]),
                    null,
                    this._cancellable
                );
            } catch (e) {
                console.debug(`[SystemTray] KillUnit(${unitName}, ${signalNum}) skipped: ${e.message}`);
            }
        }
    }

    togglePinApp(canonicalId) {
        if (!this._settings)
            return;
        const norm = normalizeId(canonicalId);
        const list = this._settings.get_strv('pinned-app-ids');
        const idx = list.findIndex(id => normalizeId(id) === norm);
        if (idx >= 0)
            list.splice(idx, 1);
        else
            list.push(canonicalId);
        this._settings.set_strv('pinned-app-ids', list);
    }

    isPinned(canonicalId) {
        if (!this._settings)
            return false;
        const norm = normalizeId(canonicalId);
        return this._settings.get_strv('pinned-app-ids').some(id => normalizeId(id) === norm);
    }

    ignoreApp(canonicalId) {
        if (!this._settings)
            return;
        const norm = normalizeId(canonicalId);
        const list = this._settings.get_strv('ignored-app-ids');
        if (!list.some(id => normalizeId(id) === norm)) {
            list.push(canonicalId);
            this._settings.set_strv('ignored-app-ids', list);
        }
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        this._sniWatcher = null;
    }
}