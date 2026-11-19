import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

export const AppState = Object.freeze({
    RUNNING: 'running',
    MINIMIZED: 'minimized',
    BACKGROUND: 'background',
    STOPPING: 'stopping',
    EXITED: 'exited',
});

export const PackagingType = Object.freeze({
    FLATPAK: 'flatpak',
    NATIVE: 'native',
    APPIMAGE: 'appimage',
    CUSTOM: 'custom',
    UNKNOWN: 'unknown',
});

const CONFIDENCE_THRESHOLD = 50;
const STOPPING_TTL_MS = 6000;
const EMIT_DEBOUNCE_MS = 80;

// System infrastructure prefixes/names that must NEVER appear as user apps
const SYSTEM_BLOCKLIST_PREFIXES = [
    'org.gnome.shell',
    'org.gnome.session',
    'org.gnome.settingsdaemon',
    'gsd-',
    'xdg-desktop-portal',
    'xdg-document-portal',
    'xdg-permission-store',
    'org.freedesktop.impl.portal',
    'at-spi',
    'ibus',
    'gvfs',
    'gnome-keyring',
    'gcr-',
    'goa-daemon',
    'org.gnome.onlineaccounts',
    'dconf-',
    'tracker-',
    'localsearch',
    'tinysparql',
    'pipewire',
    'wireplumber',
    'pulseaudio',
    'polkit-',
    'orca',
    'gnome-session',
    'mpris-proxy',
    'obexd',
    'evolution-alarm-notify',
    'evolution-source-registry',
    'evolution-calendar-factory',
    'evolution-addressbook-factory',
    'gnome-software-service',
];

function unescapeSystemdUnitPart(str) {
    if (!str)
        return '';
    return str.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
    );
}

export function normalizeId(raw) {
    if (!raw || typeof raw !== 'string')
        return '';
    return raw
        .trim()
        .replace(/\.desktop$/i, '')
        .toLowerCase();
}

export function extractAppIdFromUnit(unitName) {
    if (!unitName || typeof unitName !== 'string')
        return '';

    // Pattern 1: app-flatpak-org.telegram.desktop-12345.scope or app-gnome-com.obsproject.Studio-456.scope
    let match = unitName.match(/^app-(?:flatpak|gnome|kde|org\.gnome\.shell)?-?(.+?)(?:-\d+)?\.scope$/i);
    if (match?.[1])
        return unescapeSystemdUnitPart(match[1]);

    // Pattern 2: app-Motrix@autostart.service or app-org.telegram.desktop.service
    match = unitName.match(/^app-(.+?)(?:@autostart)?\.service$/i);
    if (match?.[1])
        return unescapeSystemdUnitPart(match[1]);

    // Pattern 3: dbus-:1.2-org.telegram.desktop@0.service
    match = unitName.match(/^dbus-:[\d.]+-(.+?)@\d+\.service$/i);
    if (match?.[1])
        return unescapeSystemdUnitPart(match[1]);

    return '';
}

export class ApplicationRegistry extends EventEmitter {
    /**
     * @param {Gio.Settings} settings
     */
    constructor(settings) {
        super();
        this._settings = settings;
        this._records = new Map(); // canonicalId -> AppRecord
        this._windowSignals = new Map(); // Meta.Window -> number[]
        this._shellSignals = [];
        this._gnomeActiveIds = new Set();
        this._desktopIndex = null;
        this._settingsSignalId = 0;
        this._emitTimeoutId = 0;
        this._stoppingTimers = new Map(); // canonicalId -> sourceId

        this._appSystem = Shell.AppSystem.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();

        this._connectShellSignals();
        this._connectSettingsSignals();
        this._syncGnomeRunningApps(false);
    }

    _connectShellSignals() {
        this._shellSignals.push({
            obj: this._appSystem,
            id: this._appSystem.connect('app-state-changed', () => {
                this._syncGnomeRunningApps(true);
                this._reconcileAllStates();
            }),
        });

        this._shellSignals.push({
            obj: this._appSystem,
            id: this._appSystem.connect('installed-changed', () => {
                this._desktopIndex = null;
            }),
        });

        this._shellSignals.push({
            obj: this._windowTracker,
            id: this._windowTracker.connect('tracked-windows-changed', () => {
                this._reconcileAllStates();
            }),
        });

        this._shellSignals.push({
            obj: global.display,
            id: global.display.connect('window-created', (_display, win) => {
                this._trackWindow(win);
                this._reconcileAllStates();
            }),
        });

        // Track existing windows at startup
        for (const actor of global.get_window_actors()) {
            const win = actor.get_meta_window?.() ?? actor.meta_window;
            if (win)
                this._trackWindow(win);
        }
    }

    _connectSettingsSignals() {
        if (!this._settings)
            return;

        this._settingsSignalId = this._settings.connect('changed', (_s, key) => {
            if (
                key === 'visibility-mode' ||
                key === 'ignored-app-ids' ||
                key === 'pinned-app-ids' ||
                key === 'show-process-count'
            ) {
                this._scheduleEmit();
            }
        });
    }

    _trackWindow(win) {
        if (!win || this._windowSignals.has(win))
            return;

        const ids = [
            win.connect('notify::minimized', () => this._reconcileAllStates()),
            win.connect('unmanaged', () => {
                this._untrackWindow(win);
                this._reconcileAllStates();
            }),
        ];
        this._windowSignals.set(win, ids);
    }

    _untrackWindow(win) {
        const ids = this._windowSignals.get(win);
        if (!ids)
            return;

        for (const id of ids) {
            try {
                win.disconnect(id);
            } catch {
                // Window already disposed
            }
        }
        this._windowSignals.delete(win);
    }

    /**
     * Resolve Shell.App / Gio.DesktopAppInfo cleanly without throwing.
     * @param {string[]} candidates
     */
    _getDesktopIndex() {
        if (this._desktopIndex)
            return this._desktopIndex;

        const index = new Map();
        try {
            for (const info of Gio.AppInfo.get_all()) {
                if (!(info instanceof Gio.DesktopAppInfo))
                    continue;
                if (info.get_nodisplay() || info.get_is_hidden())
                    continue;

                const id = info.get_id() ?? '';
                const baseId = id.replace(/\.desktop$/i, '').toLowerCase();
                const name = (info.get_name() || '').toLowerCase();
                const displayName = (info.get_display_name() || '').toLowerCase();
                const wmClass = (info.get_startup_wm_class?.() || '').toLowerCase();
                const exec = info.get_executable() || '';
                const execBase = exec ? GLib.path_get_basename(exec).toLowerCase() : '';

                const keys = [baseId, name, displayName, wmClass, execBase];
                const lastPart = baseId.includes('.') ? baseId.split('.').pop() : '';
                if (lastPart && lastPart.length >= 3)
                    keys.push(lastPart);

                for (const k of keys) {
                    if (k && k.length >= 2 && !index.has(k))
                        index.set(k, info);
                }
            }
        } catch {
            // Ignore
        }

        this._desktopIndex = index;
        return index;
    }

    _resolveDesktopApp(candidates) {
        const index = this._getDesktopIndex();

        for (const raw of candidates) {
            if (!raw)
                continue;

            const base = raw.replace(/\.desktop$/i, '');
            const desktopFilename = `${base}.desktop`;

            let shellApp = this._appSystem.lookup_app(desktopFilename);
            if (!shellApp)
                shellApp = this._appSystem.lookup_heuristic_basename(desktopFilename);

            if (shellApp) {
                return {
                    shellApp,
                    desktopAppInfo: shellApp.get_app_info?.() ?? null,
                    resolvedId: shellApp.get_id().replace(/\.desktop$/i, ''),
                };
            }

            try {
                const appInfo = Gio.DesktopAppInfo.new(desktopFilename);
                if (appInfo) {
                    return {
                        shellApp: null,
                        desktopAppInfo: appInfo,
                        resolvedId: appInfo.get_id().replace(/\.desktop$/i, ''),
                    };
                }
            } catch {
                // Fallback to desktop index (matches AppImage / Electron Exec & WMClass)
            }

            const indexedInfo = index.get(base.toLowerCase());
            if (indexedInfo) {
                const foundId = indexedInfo.get_id();
                const foundShell = foundId ? this._appSystem.lookup_app(foundId) : null;
                return {
                    shellApp: foundShell ?? null,
                    desktopAppInfo: indexedInfo,
                    resolvedId: foundId.replace(/\.desktop$/i, ''),
                };
            }
        }
        return {shellApp: null, desktopAppInfo: null, resolvedId: null};
    }

    /**
     * Find an existing AppRecord matching any of the provided identifiers/PIDs.
     */
    _findMatchingRecord(payload) {
        const {
            canonicalHint,
            appId,
            unitName,
            pids = [],
            sniKey,
            customRuleId,
            aliases = [],
        } = payload;

        const candidateNorms = new Set();
        for (const val of [canonicalHint, appId, ...aliases]) {
            const norm = normalizeId(val);
            if (norm)
                candidateNorms.add(norm);
        }

        for (const record of this._records.values()) {
            if (unitName && record.unitNames.has(unitName))
                return record;

            if (sniKey && record.sniItems.has(sniKey))
                return record;

            if (customRuleId && record.customRules.has(customRuleId))
                return record;

            for (const pid of pids) {
                if (pid > 0 && record.pids.has(pid))
                    return record;
            }

            if (candidateNorms.has(normalizeId(record.canonicalId)))
                return record;

            for (const alias of record.aliases) {
                if (candidateNorms.has(normalizeId(alias)))
                    return record;
            }
        }

        return null;
    }

    /**
     * Create or update an application record from any discovery source.
     * Sources: 'systemd' | 'sni' | 'portal' | 'custom'
     */
    upsertSource(source, payload) {
        const pids = [];
        if (Number.isInteger(payload.pid) && payload.pid > 0)
            pids.push(payload.pid);
        if (Array.isArray(payload.pids)) {
            for (const p of payload.pids) {
                if (Number.isInteger(p) && p > 0)
                    pids.push(p);
            }
        }

        // Attempt desktop resolution from given hints
        const unitExtractedId = extractAppIdFromUnit(payload.unitName);
        const desktopLookup = this._resolveDesktopApp([
            payload.desktopId,
            payload.appId,
            unitExtractedId,
            payload.sniId,
            payload.nameHint,
            ...(payload.aliases ?? []),
            payload.displayName,
        ]);

        const canonicalHint =
            desktopLookup.resolvedId ||
            payload.appId ||
            unitExtractedId ||
            (payload.customRuleId ? `custom:${payload.customRuleId}` : null) ||
            (payload.unitName ? `unit:${payload.unitName}` : null) ||
            (payload.sniKey ? `sni:${payload.sniKey}` : null);

        if (!canonicalHint)
            return null;

        const aliases = [
            payload.appId,
            payload.desktopId,
            unitExtractedId,
            payload.sniId,
            desktopLookup.resolvedId,
            ...(payload.aliases ?? []),
        ].filter(Boolean);

        let record = this._findMatchingRecord({
            canonicalHint,
            appId: payload.appId,
            unitName: payload.unitName,
            pids,
            sniKey: payload.sniKey,
            customRuleId: payload.customRuleId,
            aliases,
        });

        if (!record) {
            record = {
                canonicalId: canonicalHint,
                displayName: payload.displayName || canonicalHint,
                aliases: new Set(),
                pids: new Set(),
                unitNames: new Set(),
                sniItems: new Map(),
                customRules: new Map(),
                portalActive: false,
                systemdActive: false,
                gnomeActive: false,
                shellApp: null,
                desktopAppInfo: null,
                packaging: PackagingType.UNKNOWN,
                processCount: 0,
                confidence: 0,
                attention: false,
                state: AppState.BACKGROUND,
                stoppingUntil: 0,
                customIcon: null,
            };
            this._records.set(record.canonicalId, record);
        } else if (
            desktopLookup.resolvedId &&
            record.canonicalId.startsWith('sni:') &&
            !this._records.has(desktopLookup.resolvedId)
        ) {
            // Upgrade temporary SNI canonical ID to true desktop ID
            this._records.delete(record.canonicalId);
            record.canonicalId = desktopLookup.resolvedId;
            this._records.set(record.canonicalId, record);
        }

        // Merge metadata
        for (const a of aliases)
            record.aliases.add(a);
        for (const p of pids)
            record.pids.add(p);

        if (payload.unitName)
            record.unitNames.add(payload.unitName);

        if (desktopLookup.shellApp && !record.shellApp)
            record.shellApp = desktopLookup.shellApp;
        if (desktopLookup.desktopAppInfo && !record.desktopAppInfo)
            record.desktopAppInfo = desktopLookup.desktopAppInfo;

        if (source === 'systemd') {
            record.systemdActive = true;
            if (Number.isInteger(payload.processCount) && payload.processCount > 0)
                record.processCount = payload.processCount;
        } else if (source === 'gnome') {
            record.gnomeActive = true;
            if (!record.systemdActive && Number.isInteger(payload.processCount) && payload.processCount > 0)
                record.processCount = Math.max(record.processCount, payload.processCount);
        } else if (source === 'sni' && payload.sniKey) {
            record.sniItems.set(payload.sniKey, {
                ...payload.sniData,
                key: payload.sniKey,
                pid: payload.pid ?? 0,
            });
        } else if (source === 'portal') {
            record.portalActive = true;
        } else if (source === 'custom' && payload.customRuleId) {
            record.customRules.set(payload.customRuleId, payload.customRule ?? {});
            if (payload.customIcon)
                record.customIcon = payload.customIcon;
        }

        // Packaging detection
        if (payload.packaging && payload.packaging !== PackagingType.UNKNOWN)
            record.packaging = payload.packaging;
        else if (payload.unitName?.startsWith('app-flatpak-'))
            record.packaging = PackagingType.FLATPAK;
        else if (record.packaging === PackagingType.UNKNOWN && source === 'custom')
            record.packaging = PackagingType.CUSTOM;
        else if (record.packaging === PackagingType.UNKNOWN && record.desktopAppInfo)
            record.packaging = PackagingType.NATIVE;

        // Best human-readable Display Name priority:
        // Custom Name > Desktop AppInfo Name > SNI Title > Existing
        if (source === 'custom' && payload.displayName) {
            record.displayName = payload.displayName;
        } else if (record.desktopAppInfo) {
            const name = record.desktopAppInfo.get_display_name() || record.desktopAppInfo.get_name();
            if (name)
                record.displayName = name;
        } else if (
            payload.displayName &&
            !/^(dbus-|app-)/i.test(payload.displayName) &&
            (record.displayName === record.canonicalId ||
                /^(dbus-|app-)/i.test(record.displayName) ||
                record.displayName.includes('.'))
        ) {
            record.displayName = payload.displayName;
        }

        this._recomputeRecord(record);
        this._scheduleEmit();
        return record;
    }

    /**
     * Remove a specific discovery source from records when a unit/SNI/custom app exits.
     */
    removeSource(source, identifier) {
        let changed = false;

        for (const [canonicalId, record] of this._records.entries()) {
            let touched = false;

            if (source === 'systemd' && record.unitNames.has(identifier)) {
                record.unitNames.delete(identifier);
                if (record.unitNames.size === 0)
                    record.systemdActive = false;
                touched = true;
            } else if (source === 'gnome' && (record.canonicalId === identifier || record.aliases.has(identifier))) {
                record.gnomeActive = false;
                touched = true;
            } else if (source === 'sni' && record.sniItems.has(identifier)) {
                record.sniItems.delete(identifier);
                touched = true;
            } else if (source === 'portal' && (record.canonicalId === identifier || record.aliases.has(identifier))) {
                record.portalActive = false;
                touched = true;
            } else if (source === 'custom' && record.customRules.has(identifier)) {
                record.customRules.delete(identifier);
                touched = true;
            }

            if (!touched)
                continue;

            const hasActiveSource =
                record.systemdActive ||
                record.gnomeActive ||
                record.sniItems.size > 0 ||
                record.portalActive ||
                record.customRules.size > 0;

            if (!hasActiveSource) {
                this._clearStoppingTimer(canonicalId);
                record.state = AppState.EXITED;
                this._records.delete(canonicalId);
            } else {
                this._recomputeRecord(record);
            }
            changed = true;
        }

        if (changed)
            this._scheduleEmit();
    }

    /**
     * Mark an application as STOPPING while Quit / Force Quit is executing.
     */
    markStopping(canonicalId) {
        const record = this._records.get(canonicalId);
        if (!record)
            return;

        record.stoppingUntil = Date.now() + STOPPING_TTL_MS;
        record.state = AppState.STOPPING;

        this._clearStoppingTimer(canonicalId);
        const timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STOPPING_TTL_MS + 100, () => {
            this._stoppingTimers.delete(canonicalId);
            const current = this._records.get(canonicalId);
            if (current && current.stoppingUntil <= Date.now()) {
                current.stoppingUntil = 0;
                this._recomputeRecord(current);
                this._scheduleEmit();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._stoppingTimers.set(canonicalId, timerId);

        this._scheduleEmit();
    }

    _clearStoppingTimer(canonicalId) {
        const timerId = this._stoppingTimers.get(canonicalId);
        if (timerId) {
            GLib.source_remove(timerId);
            this._stoppingTimers.delete(canonicalId);
        }
    }

    _recomputeRecord(record) {
        // 1. Attention flag from any SNI item
        record.attention = false;
        for (const item of record.sniItems.values()) {
            if (item.status === 'NeedsAttention') {
                record.attention = true;
                break;
            }
        }

        // 2. Confidence score
        let score = 0;
        if (record.systemdActive)
            score += 45;
        if (record.gnomeActive)
            score += 55;
        if (record.desktopAppInfo)
            score += 35;
        if (record.sniItems.size > 0)
            score += 50;
        if (record.portalActive)
            score += 30;
        if (record.packaging === PackagingType.FLATPAK)
            score += 25;
        if (record.customRules.size > 0)
            score += 100;
        record.confidence = Math.min(100, score);

        // 3. Process count estimate
        if (record.systemdActive && record.processCount > 0) {
            record.processCount = Math.max(record.processCount, 1);
        } else {
            record.processCount = Math.max(record.pids.size, 1);
        }

        // 4. Lifecycle State
        if (record.stoppingUntil > Date.now()) {
            record.state = AppState.STOPPING;
            return;
        }

        const windows = this._getRecordNormalWindows(record);
        if (windows.length === 0) {
            record.state = AppState.BACKGROUND;
        } else {
            const hasVisible = windows.some(w => !w.minimized);
            record.state = hasVisible ? AppState.RUNNING : AppState.MINIMIZED;
        }
    }

    _getRecordNormalWindows(record) {
        const seen = new Set();
        const windows = [];

        if (record.shellApp) {
            for (const w of record.shellApp.get_windows()) {
                if (this._isNormalUserWindow(w) && !seen.has(w)) {
                    seen.add(w);
                    windows.push(w);
                }
            }
        }

        // Fallback PID window lookup (critical for custom binaries / AppImages)
        if (record.pids.size > 0) {
            for (const actor of global.get_window_actors()) {
                const w = actor.get_meta_window?.() ?? actor.meta_window;
                if (!w || seen.has(w))
                    continue;
                const pid = w.get_pid?.() ?? 0;
                if (pid > 0 && record.pids.has(pid) && this._isNormalUserWindow(w)) {
                    seen.add(w);
                    windows.push(w);
                }
            }
        }

        return windows;
    }

    _isNormalUserWindow(win) {
        if (!win)
            return false;
        if (win.is_skip_taskbar?.())
            return false;
        if (typeof win.is_hidden === 'function' && win.is_hidden())
            return false;
        const actor = win.get_compositor_private?.();
        if (actor && actor.visible === false)
            return false;
        const type = win.get_window_type?.();
        return type === Meta.WindowType.NORMAL;
    }

    reconcileNow() {
        this._syncGnomeRunningApps(false);
        this._reconcileAllStates();
    }

    _syncGnomeRunningApps(emitChanges = true) {
        const currentIds = new Set();
        for (const shellApp of this._appSystem.get_running()) {
            const desktopId = shellApp.get_id();
            if (!desktopId)
                continue;

            const appId = desktopId.replace(/\.desktop$/i, '');
            const pids = shellApp.get_pids?.() ?? [];
            const info = shellApp.get_app_info?.();
            const isFlatpak = Boolean(
                info?.get_string?.('X-Flatpak') ||
                info?.get_filename?.()?.includes('/flatpak/')
            );

            currentIds.add(appId);
            this.upsertSource('gnome', {
                appId,
                desktopId,
                pids,
                processCount: pids.length || 1,
                packaging: isFlatpak ? PackagingType.FLATPAK : PackagingType.NATIVE,
            });
        }

        for (const oldId of this._gnomeActiveIds) {
            if (!currentIds.has(oldId))
                this.removeSource('gnome', oldId);
        }
        this._gnomeActiveIds = currentIds;

        if (!emitChanges && this._emitTimeoutId) {
            GLib.source_remove(this._emitTimeoutId);
            this._emitTimeoutId = 0;
        }
    }

    _reconcileAllStates() {
        let changed = false;
        for (const record of this._records.values()) {
            const prevState = record.state;
            this._recomputeRecord(record);
            if (prevState !== record.state)
                changed = true;
        }
        if (changed)
            this._scheduleEmit();
    }

    /**
     * Dual-Guard Filter: eliminates OS/GNOME daemons and low-confidence helpers.
     */
    _isEligibleApp(record) {
        if (record.confidence < CONFIDENCE_THRESHOLD)
            return false;

        // Custom watchlist and explicit SNI tray apps always bypass helper filters
        const isExplicitUserOrTray = record.customRules.size > 0 || record.sniItems.size > 0;
        if (isExplicitUserOrTray)
            return true;

        const idLower = normalizeId(record.canonicalId);
        for (const prefix of SYSTEM_BLOCKLIST_PREFIXES) {
            if (idLower === prefix || idLower.startsWith(prefix))
                return false;
        }

        if (record.desktopAppInfo) {
            if (record.desktopAppInfo.get_nodisplay() || record.desktopAppInfo.get_is_hidden())
                return false;
        }

        return true;
    }

    getRecord(canonicalId) {
        return this._records.get(canonicalId) ?? null;
    }

    getAllEligibleApps() {
        const list = [];
        for (const record of this._records.values()) {
            if (this._isEligibleApp(record))
                list.push(record);
        }
        return list;
    }

    /**
     * Returns sorted applications matching the user's current visibility-mode and ignore list.
     */
    getVisibleApps() {
        const mode = this._settings?.get_string('visibility-mode') ?? 'background-only';
        const ignored = new Set((this._settings?.get_strv('ignored-app-ids') ?? []).map(normalizeId));
        const pinned = new Set((this._settings?.get_strv('pinned-app-ids') ?? []).map(normalizeId));

        const visible = [];
        for (const record of this._records.values()) {
            if (!this._isEligibleApp(record))
                continue;

            const normId = normalizeId(record.canonicalId);
            if (ignored.has(normId))
                continue;

            const isPinned = pinned.has(normId);
            let show = false;

            if (mode === 'all-running') {
                show = record.state !== AppState.EXITED;
            } else {
                // Default: 'background-only'
                show =
                    record.state === AppState.BACKGROUND ||
                    record.state === AppState.STOPPING;
            }

            if (show || isPinned)
                visible.push(record);
        }

        const stateRank = {
            [AppState.STOPPING]: 0,
            [AppState.BACKGROUND]: 1,
            [AppState.MINIMIZED]: 2,
            [AppState.RUNNING]: 3,
        };

        visible.sort((a, b) => {
            const aPinned = pinned.has(normalizeId(a.canonicalId)) ? 0 : 1;
            const bPinned = pinned.has(normalizeId(b.canonicalId)) ? 0 : 1;
            if (aPinned !== bPinned)
                return aPinned - bPinned;

            const rankDiff = (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9);
            if (rankDiff !== 0)
                return rankDiff;

            return a.displayName.localeCompare(b.displayName);
        });

        return visible;
    }

    /**
     * Used by actionsManager to get normal windows for focus/activation.
     */
    getWindowsForRecord(record) {
        return this._getRecordNormalWindows(record);
    }

    _scheduleEmit() {
        if (this._emitTimeoutId)
            return;

        this._emitTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EMIT_DEBOUNCE_MS, () => {
            this._emitTimeoutId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._emitTimeoutId) {
            GLib.source_remove(this._emitTimeoutId);
            this._emitTimeoutId = 0;
        }

        for (const timerId of this._stoppingTimers.values())
            GLib.source_remove(timerId);
        this._stoppingTimers.clear();

        for (const {obj, id} of this._shellSignals) {
            try {
                obj.disconnect(id);
            } catch {
                // Ignore
            }
        }
        this._shellSignals = [];

        for (const win of [...this._windowSignals.keys()])
            this._untrackWindow(win);

        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        this.disconnectAll();
        this._records.clear();
    }
}