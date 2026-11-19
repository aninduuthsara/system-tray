import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PackagingType} from '../core/registry.js';

const CUSTOM_SCAN_INTERVAL_SEC = 12;

function enumerateBatchAsync(enumerator, count, cancellable) {
    return new Promise((resolve, reject) => {
        enumerator.next_files_async(count, GLib.PRIORITY_LOW, cancellable, (src, res) => {
            try {
                resolve(src.next_files_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function readProcBytesAsync(path, cancellable) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (src, res) => {
            try {
                const [ok, contents] = src.load_contents_finish(res);
                resolve(ok ? contents : null);
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function getSymlinkTargetAsync(path, cancellable) {
    try {
        const file = Gio.File.new_for_path(path);
        const info = await new Promise((resolve, reject) => {
            file.query_info_async(
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
        return info.get_symlink_target() ?? '';
    } catch {
        return '';
    }
}

export class CustomWatcher {
    /**
     * @param {import('../core/registry.js').ApplicationRegistry} registry
     * @param {Gio.Settings} settings
     */
    constructor(registry, settings) {
        this._registry = registry;
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();

        this._rules = [];
        this._activeRuleIds = new Set();
        this._currentUid = null;
        this._timerId = 0;
        this._settingsSignalId = 0;
        this._scanning = false;
        this._rescanQueued = false;
    }

    async start() {
        await this._resolveCurrentUid();
        this._loadRules();

        if (this._settings) {
            this._settingsSignalId = this._settings.connect('changed::custom-watched-apps', () => {
                this._loadRules();
                this._syncTimer();
                this.refreshNow().catch(() => {});
            });
        }

        this._syncTimer();
        if (this._rules.length > 0)
            await this.refreshNow();
    }

    async _resolveCurrentUid() {
        try {
            const selfFile = Gio.File.new_for_path('/proc/self');
            const info = await new Promise((resolve, reject) => {
                selfFile.query_info_async(
                    'unix::uid',
                    Gio.FileQueryInfoFlags.NONE,
                    GLib.PRIORITY_LOW,
                    this._cancellable,
                    (src, res) => {
                        try {
                            resolve(src.query_info_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
            this._currentUid = info.get_attribute_uint32('unix::uid');
        } catch {
            this._currentUid = null;
        }
    }

    _loadRules() {
        const rawList = this._settings?.get_strv('custom-watched-apps') ?? [];
        const parsed = [];

        for (let i = 0; i < rawList.length; i++) {
            try {
                const obj = JSON.parse(rawList[i]);
                if (!obj || typeof obj !== 'object')
                    continue;
                if (!obj.pattern || typeof obj.pattern !== 'string')
                    continue;

                parsed.push({
                    id: String(obj.id || `rule-${i}-${obj.pattern}`),
                    name: String(obj.name || obj.pattern),
                    matchType: String(obj.matchType || 'cmdline').toLowerCase(),
                    pattern: obj.pattern.trim(),
                    desktopId: obj.desktopId ? String(obj.desktopId).trim() : '',
                    execPath: obj.execPath ? String(obj.execPath).trim() : '',
                    icon: obj.icon ? String(obj.icon).trim() : '',
                });
            } catch (e) {
                console.debug(`[SystemTray] Invalid custom-watched-apps JSON entry: ${e.message}`);
            }
        }

        this._rules = parsed;
    }

    _syncTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }

        // Zero background polling when user has no custom rules!
        if (this._rules.length === 0)
            return;

        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            CUSTOM_SCAN_INTERVAL_SEC,
            () => {
                this.refreshNow().catch(() => {});
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    /**
     * Run a fast, non-blocking async /proc scan for user-defined custom rules.
     * Called on startup, rule change, and on-demand when the Tray Popup opens.
     */
    async refreshNow() {
        if (this._cancellable.is_cancelled())
            return;

        if (this._rules.length === 0) {
            for (const oldId of this._activeRuleIds)
                this._registry.removeSource('custom', oldId);
            this._activeRuleIds.clear();
            return;
        }

        if (this._scanning) {
            this._rescanQueued = true;
            return;
        }

        this._scanning = true;
        try {
            const matches = await this._scanUserProcesses();
            if (this._cancellable.is_cancelled())
                return;

            const newActiveIds = new Set();
            for (const rule of this._rules) {
                const matched = matches.get(rule.id);
                if (!matched || matched.pids.length === 0)
                    continue;

                newActiveIds.add(rule.id);
                this._registry.upsertSource('custom', {
                    customRuleId: rule.id,
                    customRule: rule,
                    displayName: rule.name,
                    desktopId: rule.desktopId || undefined,
                    customIcon: rule.icon || undefined,
                    pids: matched.pids,
                    processCount: matched.pids.length,
                    packaging: matched.isAppImage ? PackagingType.APPIMAGE : PackagingType.CUSTOM,
                });
            }

            // Remove exited custom apps
            for (const oldId of this._activeRuleIds) {
                if (!newActiveIds.has(oldId))
                    this._registry.removeSource('custom', oldId);
            }
            this._activeRuleIds = newActiveIds;
        } catch (e) {
            console.debug(`[SystemTray] CustomWatcher scan failed: ${e.message}`);
        } finally {
            this._scanning = false;
            if (this._rescanQueued && !this._cancellable.is_cancelled()) {
                this._rescanQueued = false;
                this.refreshNow().catch(() => {});
            }
        }
    }

    async _scanUserProcesses() {
        const matches = new Map(); // rule.id -> { pids: number[], isAppImage: boolean }
        const decoder = new TextDecoder();

        // Collect all PIDs owned by current user
        const userPids = [];
        const procDir = Gio.File.new_for_path('/proc');
        const enumerator = await new Promise((resolve, reject) => {
            procDir.enumerate_children_async(
                'standard::name,standard::type,unix::uid',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW,
                this._cancellable,
                (src, res) => {
                    try {
                        resolve(src.enumerate_children_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });

        try {
            while (!this._cancellable.is_cancelled()) {
                const batch = await enumerateBatchAsync(enumerator, 64, this._cancellable);
                if (!batch || batch.length === 0)
                    break;

                for (const info of batch) {
                    if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                        continue;

                    const name = info.get_name();
                    if (!/^\d+$/.test(name))
                        continue;

                    if (this._currentUid !== null) {
                        const uid = info.get_attribute_uint32('unix::uid');
                        if (uid !== this._currentUid)
                            continue;
                    }

                    const pid = parseInt(name, 10);
                    if (pid > 1)
                        userPids.push(pid);
                }
            }
        } finally {
            try {
                enumerator.close(null);
            } catch {
                // Ignore
            }
        }

        const needExePath = this._rules.some(r => r.matchType === 'path');

        // Inspect user PIDs in small async chunks to avoid FD pressure
        const CHUNK_SIZE = 24;
        for (let i = 0; i < userPids.length && !this._cancellable.is_cancelled(); i += CHUNK_SIZE) {
            const chunk = userPids.slice(i, i + CHUNK_SIZE);
            await Promise.all(
                chunk.map(async pid => {
                    try {
                        const [commBytes, cmdBytes, exeTarget] = await Promise.all([
                            readProcBytesAsync(`/proc/${pid}/comm`, this._cancellable).catch(() => null),
                            readProcBytesAsync(`/proc/${pid}/cmdline`, this._cancellable).catch(() => null),
                            needExePath
                                ? getSymlinkTargetAsync(`/proc/${pid}/exe`, this._cancellable)
                                : Promise.resolve(''),
                        ]);

                        const comm = commBytes ? decoder.decode(commBytes).trim() : '';
                        const cmdline = cmdBytes
                            ? decoder.decode(cmdBytes).replace(/\0/g, ' ').trim()
                            : '';

                        if (!comm && !cmdline)
                            return;

                        const commLower = comm.toLowerCase();
                        const cmdLower = cmdline.toLowerCase();
                        const exeLower = exeTarget.toLowerCase();

                        for (const rule of this._rules) {
                            const patLower = rule.pattern.toLowerCase();
                            let hit = false;

                            if (rule.matchType === 'process') {
                                hit = commLower === patLower || commLower.includes(patLower);
                            } else if (rule.matchType === 'path') {
                                hit = exeLower.includes(patLower) || cmdLower.includes(patLower);
                            } else if (rule.matchType === 'desktop') {
                                const base = patLower.replace(/\.desktop$/, '');
                                hit = cmdLower.includes(base) || commLower === base;
                            } else {
                                // Default: 'cmdline'
                                hit = cmdLower.includes(patLower) || commLower.includes(patLower);
                            }

                            if (hit) {
                                let entry = matches.get(rule.id);
                                if (!entry) {
                                    entry = {pids: [], isAppImage: false};
                                    matches.set(rule.id, entry);
                                }
                                entry.pids.push(pid);
                                if (cmdLower.includes('.appimage') || exeLower.includes('.appimage'))
                                    entry.isAppImage = true;
                            }
                        }
                    } catch {
                        // Process exited mid-scan
                    }
                })
            );
        }

        return matches;
    }

    destroy() {
        this._cancellable.cancel();

        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }

        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        this._activeRuleIds.clear();
        this._rules = [];
    }
}