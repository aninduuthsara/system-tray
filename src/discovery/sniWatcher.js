import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const WATCHER_BUS_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_OBJECT_PATH = '/StatusNotifierWatcher';

const SNI_IFACE = 'org.kde.StatusNotifierItem';
const DBUSMENU_IFACE = 'com.canonical.dbusmenu';
const DBUS_PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const GENERIC_SNI_NAMES = new Set([
    'electron', 'node', 'python', 'python3', 'java', 'bash', 'sh', 'zsh',
    'bwrap', 'xdg-dbus-proxy', 'mainthread', 'chrome', 'chromium',
]);

const WATCHER_INTERFACE_XML = `
<node>
  <interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
      <arg type="s" direction="in" name="service"/>
    </method>
    <method name="RegisterStatusNotifierHost">
      <arg type="s" direction="in" name="service"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
      <arg type="s" name="service"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
      <arg type="s" name="service"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
  </interface>
</node>`;

function dbusCallAsync(busName, objectPath, interfaceName, methodName, parameters, replyType, cancellable, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call(
            busName,
            objectPath,
            interfaceName,
            methodName,
            parameters,
            replyType,
            Gio.DBusCallFlags.NONE,
            timeoutMs,
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

function stripMnemonic(label) {
    if (!label || typeof label !== 'string')
        return '';
    // DBusMenu escapes literal underscore as __ and uses single _ as shortcut mnemonic
    return label.replace(/__/g, '\u0000').replace(/_/g, '').replace(/\u0000/g, '_').trim();
}

function parsePixmaps(rawArray) {
    if (!Array.isArray(rawArray))
        return null;
    const parsed = [];
    for (const entry of rawArray) {
        if (!Array.isArray(entry) || entry.length < 3)
            continue;
        const [width, height, bytes] = entry;
        if (width > 0 && height > 0 && bytes)
            parsed.push({width, height, data: bytes});
    }
    return parsed.length > 0 ? parsed : null;
}

async function readCgroupInfoAsync(pid, cancellable) {
    if (!pid || pid <= 1)
        return {unitName: '', flatpakId: ''};

    const out = {unitName: '', flatpakId: ''};
    const decoder = new TextDecoder();

    try {
        const cgFile = Gio.File.new_for_path(`/proc/${pid}/cgroup`);
        const bytes = await new Promise((resolve, reject) => {
            cgFile.load_contents_async(cancellable, (src, res) => {
                try {
                    const [ok, contents] = src.load_contents_finish(res);
                    resolve(ok ? contents : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (bytes) {
            const text = decoder.decode(bytes).trim();
            const parts = text.split('/');
            const last = parts[parts.length - 1] ?? '';
            if (last.endsWith('.scope') || last.endsWith('.service'))
                out.unitName = last;
        }
    } catch {
        // Ignore
    }

    try {
        const fpFile = Gio.File.new_for_path(`/proc/${pid}/root/.flatpak-info`);
        const bytes = await new Promise((resolve, reject) => {
            fpFile.load_contents_async(cancellable, (src, res) => {
                try {
                    const [ok, contents] = src.load_contents_finish(res);
                    resolve(ok ? contents : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (bytes) {
            const text = decoder.decode(bytes);
            const m = text.match(/^name=(.+)$/m);
            if (m?.[1])
                out.flatpakId = m[1].trim();
        }
    } catch {
        // Not a Flatpak or no permission
    }

    // Read /proc/<pid>/comm & cmdline so generic IDs (e.g. chrome_status_icon_1) resolve real app
    const hints = [];
    try {
        const commFile = Gio.File.new_for_path(`/proc/${pid}/comm`);
        const bytes = await new Promise((resolve, reject) => {
            commFile.load_contents_async(cancellable, (src, res) => {
                try {
                    const [ok, contents] = src.load_contents_finish(res);
                    resolve(ok ? contents : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (bytes) {
            const comm = decoder.decode(bytes).trim();
            if (comm && !GENERIC_SNI_NAMES.has(comm.toLowerCase()))
                hints.push(comm);
        }
    } catch {
        // Ignore
    }

    try {
        const cmdFile = Gio.File.new_for_path(`/proc/${pid}/cmdline`);
        const bytes = await new Promise((resolve, reject) => {
            cmdFile.load_contents_async(cancellable, (src, res) => {
                try {
                    const [ok, contents] = src.load_contents_finish(res);
                    resolve(ok ? contents : null);
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (bytes) {
            const args = decoder.decode(bytes).split('\0').filter(Boolean);
            for (const arg of args.slice(0, 4)) {
                if (arg.startsWith('-'))
                    continue;
                const cleanBase = arg.split('/').pop()
                    ?.replace(/\.(appimage|asar|exe|sh)$/i, '')
                    ?.replace(/-[\d.]+.*$/, '') ?? '';
                if (cleanBase && cleanBase.length >= 3 && !GENERIC_SNI_NAMES.has(cleanBase.toLowerCase()))
                    hints.push(cleanBase);
            }
        }
    } catch {
        // Ignore
    }

    out.nameHints = [...new Set(hints)];
    return out;
}

export class SniWatcher {
    /**
     * @param {import('../core/registry.js').ApplicationRegistry} registry
     * @param {Gio.Settings} settings
     */
    constructor(registry, settings) {
        this._registry = registry;
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();

        this._items = new Map(); // sniKey -> itemData
        this._itemSignals = new Map(); // sniKey -> number[]
        this._pendingRefreshTimers = new Map(); // sniKey -> sourceId

        this._dbusImpl = null;
        this._nameOwnerId = 0;
        this._nameOwnerChangedId = 0;
        this._settingsSignalId = 0;
        this._running = false;
    }

    // DBus Read Properties for org.kde.StatusNotifierWatcher
    get RegisteredStatusNotifierItems() {
        return [...this._items.keys()];
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }

    start() {
        if (this._settings) {
            if (!this._settingsSignalId) {
                this._settingsSignalId = this._settings.connect('changed::enable-sni-watcher', () => {
                    if (this._settings.get_boolean('enable-sni-watcher'))
                        this._activateWatcher();
                    else
                        this._deactivateWatcher();
                });
            }
            if (!this._settings.get_boolean('enable-sni-watcher'))
                return;
        }

        this._activateWatcher();
    }

    _activateWatcher() {
        if (this._running)
            return;
        this._running = true;

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(WATCHER_INTERFACE_XML, this);
        try {
            this._dbusImpl.export(Gio.DBus.session, WATCHER_OBJECT_PATH);
        } catch (e) {
            console.debug(`[SystemTray] Failed to export SNI Watcher: ${e.message}`);
            this._dbusImpl = null;
            this._running = false;
            return;
        }

        this._nameOwnerChangedId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, _oldOwner, newOwner] = params.recursiveUnpack();
                if (!newOwner)
                    this._removeItemsForOwner(name);
            }
        );

        this._nameOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            WATCHER_BUS_NAME,
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
            () => {
                // Bus acquired: announce host readiness
                try {
                    this._dbusImpl?.emit_signal('StatusNotifierHostRegistered', null);
                } catch {
                    // Ignore
                }
            },
            null,
            () => {
                // Name lost (another tray watcher claimed it)
                console.debug('[SystemTray] Lost org.kde.StatusNotifierWatcher name ownership');
            }
        );
    }

    _deactivateWatcher() {
        if (!this._running)
            return;
        this._running = false;

        for (const timerId of this._pendingRefreshTimers.values())
            GLib.source_remove(timerId);
        this._pendingRefreshTimers.clear();

        if (this._nameOwnerChangedId) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerChangedId);
            this._nameOwnerChangedId = 0;
        }

        if (this._nameOwnerId) {
            Gio.bus_unown_name(this._nameOwnerId);
            this._nameOwnerId = 0;
        }

        if (this._dbusImpl) {
            try {
                this._dbusImpl.unexport();
            } catch {
                // Ignore
            }
            this._dbusImpl = null;
        }

        for (const sniKey of [...this._items.keys()])
            this._unregisterItem(sniKey);
    }

    // DBus Method: RegisterStatusNotifierItem(in s service)
    RegisterStatusNotifierItemAsync(params, invocation) {
        const [service] = params;
        const sender = invocation.get_sender();
        invocation.return_value(null);

        if (!this._running || !service || typeof service !== 'string')
            return;

        let busName;
        let objectPath;

        if (service.startsWith('/')) {
            busName = sender;
            objectPath = service;
        } else {
            busName = service;
            objectPath = '/StatusNotifierItem';
        }

        if (!busName || !objectPath)
            return;

        const sniKey = `${busName}${objectPath}`;
        this._registerAndInspectItem(sniKey, busName, objectPath, sender).catch(() => {});
    }

    // DBus Method: RegisterStatusNotifierHost(in s service)
    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_value(null);
        try {
            this._dbusImpl?.emit_signal('StatusNotifierHostRegistered', null);
        } catch {
            // Ignore
        }
    }

    async _registerAndInspectItem(sniKey, busName, objectPath, sender) {
        if (this._cancellable.is_cancelled())
            return;

        const isNew = !this._items.has(sniKey);

        // Resolve PID & unique owner so crashes are caught reliably
        let pid = 0;
        let uniqueName = sender || busName;
        try {
            const [pidReply, ownerReply] = await Promise.allSettled([
                dbusCallAsync(
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    'GetConnectionUnixProcessID',
                    new GLib.Variant('(s)', [busName]),
                    new GLib.VariantType('(u)'),
                    this._cancellable
                ),
                busName.startsWith(':')
                    ? Promise.resolve(null)
                    : dbusCallAsync(
                        'org.freedesktop.DBus',
                        '/org/freedesktop/DBus',
                        'org.freedesktop.DBus',
                        'GetNameOwner',
                        new GLib.Variant('(s)', [busName]),
                        new GLib.VariantType('(s)'),
                        this._cancellable
                    ),
            ]);

            if (pidReply.status === 'fulfilled' && pidReply.value)
                [pid] = pidReply.value.recursiveUnpack();
            if (ownerReply.status === 'fulfilled' && ownerReply.value)
                [uniqueName] = ownerReply.value.recursiveUnpack();
        } catch {
            // Non-fatal
        }

        const props = await this._fetchItemProperties(busName, objectPath);
        if (this._cancellable.is_cancelled() || !props)
            return;

        const itemData = {
            key: sniKey,
            busName,
            uniqueName,
            objectPath,
            pid,
            id: props.Id || '',
            title: props.Title || '',
            status: props.Status || 'Active',
            iconName: props.IconName || '',
            iconThemePath: props.IconThemePath || '',
            iconPixmap: parsePixmaps(props.IconPixmap),
            menuPath: typeof props.Menu === 'string' && props.Menu.startsWith('/') ? props.Menu : '',
            itemIsMenu: Boolean(props.ItemIsMenu),
        };

        this._items.set(sniKey, itemData);

        if (isNew) {
            this._subscribeItemSignals(sniKey, busName, objectPath);
            try {
                this._dbusImpl?.emit_signal(
                    'StatusNotifierItemRegistered',
                    new GLib.Variant('(s)', [sniKey])
                );
            } catch {
                // Ignore
            }
        }

        // Extract toolTip title fallback if Title is empty
const cg = await readCgroupInfoAsync(itemData.pid, this._cancellable);
        if (this._cancellable.is_cancelled())
            return;

        const isGenericId = /^(chrome_status_icon|status_icon|tray_icon|\d+)$/i.test(itemData.id || '');
        let displayName = itemData.title || (!isGenericId ? itemData.id : '');
        if (!displayName && Array.isArray(props.ToolTip) && props.ToolTip[2])
            displayName = String(props.ToolTip[2]);
        if (!displayName && cg.nameHints?.length > 0)
            displayName = cg.nameHints[0];

        this._registry.upsertSource('sni', {
            sniKey,
            sniId: !isGenericId && itemData.id ? itemData.id : undefined,
            appId: cg.flatpakId || undefined,
            unitName: cg.unitName || undefined,
            packaging: cg.flatpakId ? 'flatpak' : undefined,
            nameHint: cg.nameHints?.[0] || undefined,
            aliases: cg.nameHints ?? [],
            displayName: displayName || undefined,
            pid: itemData.pid,
            sniData: itemData,
        });
    }

    async _fetchItemProperties(busName, objectPath) {
        try {
            const reply = await dbusCallAsync(
                busName,
                objectPath,
                DBUS_PROPS_IFACE,
                'GetAll',
                new GLib.Variant('(s)', [SNI_IFACE]),
                new GLib.VariantType('(a{sv})'),
                this._cancellable
            );
            const [props] = reply.recursiveUnpack();
            return props ?? {};
        } catch {
            // Fallback: fetch individual properties safely for non-compliant apps
            const propNames = ['Id', 'Title', 'Status', 'IconName', 'IconThemePath', 'IconPixmap', 'Menu', 'ItemIsMenu'];
            const results = await Promise.allSettled(
                propNames.map(prop =>
                    dbusCallAsync(
                        busName,
                        objectPath,
                        DBUS_PROPS_IFACE,
                        'Get',
                        new GLib.Variant('(ss)', [SNI_IFACE, prop]),
                        new GLib.VariantType('(v)'),
                        this._cancellable
                    ).then(r => [prop, r.recursiveUnpack()[0]])
                )
            );

            const collected = {};
            let gotAny = false;
            for (const res of results) {
                if (res.status === 'fulfilled') {
                    const [k, v] = res.value;
                    collected[k] = v;
                    gotAny = true;
                }
            }
            return gotAny ? collected : null;
        }
    }

    _subscribeItemSignals(sniKey, busName, objectPath) {
        if (this._itemSignals.has(sniKey))
            return;

        const subIds = [];
        const refreshSignals = ['NewIcon', 'NewTitle', 'NewAttentionIcon', 'NewToolTip'];
        for (const member of refreshSignals) {
            subIds.push(
                Gio.DBus.session.signal_subscribe(
                    busName,
                    SNI_IFACE,
                    member,
                    objectPath,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    () => this._scheduleRefreshItem(sniKey)
                )
            );
        }

        subIds.push(
            Gio.DBus.session.signal_subscribe(
                busName,
                SNI_IFACE,
                'NewStatus',
                objectPath,
                null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    const [newStatus] = params.recursiveUnpack();
                    const item = this._items.get(sniKey);
                    if (!item)
                        return;
                    item.status = newStatus || 'Active';
                    this._registry.upsertSource('sni', {
                        sniKey,
                        sniId: item.id || undefined,
                        pid: item.pid,
                        sniData: item,
                    });
                }
            )
        );

        this._itemSignals.set(sniKey, subIds);
    }

    _scheduleRefreshItem(sniKey) {
        if (this._pendingRefreshTimers.has(sniKey))
            return;

        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            this._pendingRefreshTimers.delete(sniKey);
            const existing = this._items.get(sniKey);
            if (existing)
                this._registerAndInspectItem(sniKey, existing.busName, existing.objectPath, existing.uniqueName).catch(() => {});
            return GLib.SOURCE_REMOVE;
        });
        this._pendingRefreshTimers.set(sniKey, id);
    }

    _removeItemsForOwner(ownerName) {
        if (!ownerName)
            return;
        for (const [sniKey, item] of [...this._items.entries()]) {
            if (item.busName === ownerName || item.uniqueName === ownerName)
                this._unregisterItem(sniKey);
        }
    }

    _unregisterItem(sniKey) {
        const timerId = this._pendingRefreshTimers.get(sniKey);
        if (timerId) {
            GLib.source_remove(timerId);
            this._pendingRefreshTimers.delete(sniKey);
        }

        const sigIds = this._itemSignals.get(sniKey);
        if (sigIds) {
            for (const id of sigIds)
                Gio.DBus.session.signal_unsubscribe(id);
            this._itemSignals.delete(sniKey);
        }

        if (this._items.delete(sniKey)) {
            this._registry.removeSource('sni', sniKey);
            try {
                this._dbusImpl?.emit_signal(
                    'StatusNotifierItemUnregistered',
                    new GLib.Variant('(s)', [sniKey])
                );
            } catch {
                // Ignore
            }
        }
    }

    // -------------------------------------------------------------------------
    // Lazy DBusMenu Client (Native App Menu Options & Graceful Quit)
    // -------------------------------------------------------------------------

    async _callAboutToShow(item, menuId = 0) {
        if (!item?.menuPath)
            return;
        try {
            await dbusCallAsync(
                item.busName,
                item.menuPath,
                DBUSMENU_IFACE,
                'AboutToShow',
                new GLib.Variant('(i)', [menuId]),
                new GLib.VariantType('(b)'),
                this._cancellable,
                600
            );
        } catch {
            // Optional on some implementations
        }
    }

    _parseMenuNode(node) {
        if (!Array.isArray(node) || node.length < 3)
            return null;

        const [id, props, rawChildren] = node;
        const visible = props?.visible !== false;
        if (!visible)
            return null;

        const type = props?.type === 'separator' ? 'separator' : 'standard';
        const label = stripMnemonic(props?.label ?? '');
        const enabled = props?.enabled !== false;
        const toggleType = props?.['toggle-type'] ?? '';
        const toggleState = props?.['toggle-state'] ?? 0;

        const children = [];
        if (Array.isArray(rawChildren)) {
            for (const child of rawChildren) {
                const parsed = this._parseMenuNode(child);
                if (parsed)
                    children.push(parsed);
            }
        }

        return {
            id,
            type,
            label,
            enabled,
            toggleType,
            toggleState,
            children,
        };
    }

    /**
     * Fetch native DBusMenu items lazily when user opens "More Options (⋮)".
     */
    async getMenuItems(item) {
        if (!item?.menuPath)
            return [];

        await this._callAboutToShow(item, 0);

        try {
            const reply = await dbusCallAsync(
                item.busName,
                item.menuPath,
                DBUSMENU_IFACE,
                'GetLayout',
                new GLib.Variant('(iias)', [0, -1, []]),
                new GLib.VariantType('(u(ia{sv}av))'),
                this._cancellable,
                2500
            );
            const [_revision, rootNode] = reply.recursiveUnpack();
            const parsedRoot = this._parseMenuNode(rootNode);
            return parsedRoot?.children ?? [];
        } catch (e) {
            console.debug(`[SystemTray] DBusMenu GetLayout failed: ${e.message}`);
            return [];
        }
    }

    async activateMenuItem(item, menuId) {
        if (!item?.menuPath || !Number.isInteger(menuId))
            return false;

        try {
            const timestamp = Math.floor(Date.now() / 1000);
            await dbusCallAsync(
                item.busName,
                item.menuPath,
                DBUSMENU_IFACE,
                'Event',
                new GLib.Variant('(isvu)', [
                    menuId,
                    'clicked',
                    new GLib.Variant('i', 0),
                    timestamp,
                ]),
                null,
                this._cancellable,
                2000
            );
            return true;
        } catch (e) {
            console.debug(`[SystemTray] DBusMenu Event failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Safely locate and trigger a genuine "Quit" / "Exit" menu action (ignores "Close to tray").
     */
    async triggerQuitAction(item) {
        const items = await this.getMenuItems(item);
        if (items.length === 0)
            return false;

        const matchQuit = /^(quit|exit)(\s+[\w.-]+)?$/i;

        const searchTree = nodes => {
            for (const node of nodes) {
                if (node.type !== 'separator' && node.enabled && matchQuit.test(node.label))
                    return node;
                if (node.children?.length > 0) {
                    const found = searchTree(node.children);
                    if (found)
                        return found;
                }
            }
            return null;
        };

        const quitNode = searchTree(items);
        if (!quitNode)
            return false;

        return this.activateMenuItem(item, quitNode.id);
    }

    destroy() {
        this._cancellable.cancel();
        this._deactivateWatcher();

        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }
    }
}