import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {AppState, PackagingType} from '../core/registry.js';

const VISIBILITY_CYCLE = [
    {key: 'background-only', label: 'Background'},
    {key: 'all-running', label: 'All Apps'},
];

const PACKAGING_LABELS = {
    [PackagingType.FLATPAK]: 'Flatpak',
    [PackagingType.APPIMAGE]: 'AppImage',
    [PackagingType.CUSTOM]: 'Custom',
    [PackagingType.NATIVE]: 'Native',
    [PackagingType.UNKNOWN]: 'App',
};

const STATE_UI = {
    [AppState.BACKGROUND]: {label: 'Background', cls: 'system-tray-status-background'},
    [AppState.MINIMIZED]: {label: 'Minimized', cls: 'system-tray-status-minimized'},
    [AppState.RUNNING]: {label: 'Active', cls: 'system-tray-status-running'},
    [AppState.STOPPING]: {label: 'Stopping…', cls: 'system-tray-status-stopping'},
};

export class TrayPopupView {
    /**
     * @param {object} deps
     * @param {import('../core/registry.js').ApplicationRegistry} deps.registry
     * @param {import('../core/iconResolver.js').IconResolver} deps.iconResolver
     * @param {import('../core/actionsManager.js').ActionsManager} deps.actionsManager
     * @param {import('../discovery/sniWatcher.js').SniWatcher} deps.sniWatcher
     * @param {import('../discovery/customWatcher.js').CustomWatcher} deps.customWatcher
     * @param {Gio.Settings} deps.settings
     * @param {Function} deps.onCloseMenu
     * @param {Function} deps.onOpenPreferences
     */
    constructor(deps) {
        this._registry = deps.registry;
        this._iconResolver = deps.iconResolver;
        this._actions = deps.actionsManager;
        this._systemdWatcher = deps.systemdWatcher;
        this._sniWatcher = deps.sniWatcher;
        this._customWatcher = deps.customWatcher;
        this._settings = deps.settings;
        this._extensionDir = deps.extensionDir;
        this._onCloseMenu = deps.onCloseMenu;
        this._onOpenPreferences = deps.onOpenPreferences;

        this._confirmTimers = new Map(); // canonicalId -> timerId
        this._pendingConfirmIds = new Set();
        this._renderedCards = new Map(); // canonicalId -> { card, metaLabel, statusLabel }
        this._emptyView = null;
        this._renderedOrderSig = '';
        this._lastCardHeight = 68;
        this._liveTimerId = 0;
        this._measureIdleId = 0;
        this._isOpen = false;

        this._buildRoot();
        this._registrySignalId = this._registry.connect('changed', () => {
            if (this._isOpen)
                this.render();
        });
    }

    get actor() {
        return this._rootBox;
    }

    _buildRoot() {
        this._rootBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'system-tray-popup',
            x_expand: true,
        });

        // 1. Top Section (#36363a): 3-card Smooth Scrollable List (Hidden Scrollbar)
        const topSection = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'system-tray-top-section',
            x_expand: true,
        });

        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'system-tray-list-box',
            x_expand: true,
        });

        this._scrollView = new St.ScrollView({
            style_class: 'system-tray-scroll-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
        });
        this._scrollView.set_child(this._listBox);
        topSection.add_child(this._scrollView);
        this._rootBox.add_child(topSection);

        // 2. Bottom Dock Bar (#3f3f44): Refresh | Mode + Count | Settings
        const bottomBar = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'system-tray-bottom-bar',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const refreshBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'system-tray-bottom-btn-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshBox.add_child(new St.Icon({
            icon_name: 'view-refresh-symbolic',
            icon_size: 15,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        refreshBox.add_child(new St.Label({
            text: 'Refresh',
            style_class: 'system-tray-bottom-btn-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const refreshBtn = new St.Button({
            style_class: 'system-tray-bottom-btn',
            can_focus: true,
            accessible_name: 'Refresh apps',
            y_align: Clutter.ActorAlign.CENTER,
            child: refreshBox,
        });
        refreshBtn.connect('clicked', () => {
            this._systemdWatcher?.refreshProcessCounts().catch(() => {});
            this._customWatcher?.refreshNow().catch(() => {});
            this.render(true);
        });

        const modeBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'system-tray-mode-pill-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._modeLabel = new St.Label({
            text: 'Background',
            style_class: 'system-tray-mode-pill-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._modeCountLabel = new St.Label({
            text: '00',
            style_class: 'system-tray-mode-count',
            y_align: Clutter.ActorAlign.CENTER,
        });
        modeBox.add_child(this._modeLabel);
        modeBox.add_child(this._modeCountLabel);

        this._modeButton = new St.Button({
            style_class: 'system-tray-mode-pill',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: modeBox,
        });
        this._modeButton.connect('clicked', () => this._cycleVisibilityMode());

        const prefsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'system-tray-bottom-btn-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        prefsBox.add_child(new St.Icon({
            icon_name: 'emblem-system-symbolic',
            icon_size: 16,
            style_class: 'system-tray-settings-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        prefsBox.add_child(new St.Label({
            text: 'Settings',
            style_class: 'system-tray-bottom-btn-label',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const prefsBtn = new St.Button({
            style_class: 'system-tray-bottom-btn',
            can_focus: true,
            accessible_name: 'Open Settings',
            y_align: Clutter.ActorAlign.CENTER,
            child: prefsBox,
        });
        prefsBtn.connect('clicked', () => {
            this._onCloseMenu?.();
            this._onOpenPreferences?.();
        });

        bottomBar.add_child(refreshBtn);
        bottomBar.add_child(this._modeButton);
        bottomBar.add_child(prefsBtn);
        this._rootBox.add_child(bottomBar);

        this._updateModePillLabel();
    }

    onMenuOpenStateChanged(isOpen) {
        this._isOpen = isOpen;
        if (isOpen) {
            if (this._settings?.get_boolean('always-use-default-mode')) {
                const defMode = this._settings.get_string('default-visibility-mode');
                if (this._settings.get_string('visibility-mode') !== defMode)
                    this._settings.set_string('visibility-mode', defMode);
            }
            this._registry.reconcileNow();
            this._systemdWatcher?.refreshProcessCounts().catch(() => {});
            this._customWatcher?.refreshNow().catch(() => {});
            this._startLiveRefresh();
            this.render(true);
        } else {
            this._stopLiveRefresh();
            this._clearAllConfirmStates();
            if (this._settings?.get_boolean('always-use-default-mode')) {
                const defMode = this._settings.get_string('default-visibility-mode');
                if (this._settings.get_string('visibility-mode') !== defMode)
                    this._settings.set_string('visibility-mode', defMode);
            }
        }
    }

    _startLiveRefresh() {
        this._stopLiveRefresh();
        this._liveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            if (!this._isOpen) {
                this._liveTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._systemdWatcher?.refreshProcessCounts().catch(() => {});
            this._customWatcher?.refreshNow().catch(() => {});
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLiveRefresh() {
        if (this._liveTimerId) {
            GLib.source_remove(this._liveTimerId);
            this._liveTimerId = 0;
        }
    }

    _cycleVisibilityMode() {
        if (!this._settings)
            return;
        const current = this._settings.get_string('visibility-mode');
        const idx = VISIBILITY_CYCLE.findIndex(m => m.key === current);
        const next = VISIBILITY_CYCLE[(idx + 1) % VISIBILITY_CYCLE.length];
        this._settings.set_string('visibility-mode', next.key);
        this._updateModePillLabel();
        this.render(true);
    }

    _updateModePillLabel() {
        const current = this._settings?.get_string('visibility-mode') ?? 'background-only';
        const match = VISIBILITY_CYCLE.find(m => m.key === current) ?? VISIBILITY_CYCLE[0];
        this._modeLabel.set_text(match.label);
    }

    _getEmptyStateCopy() {
        const mode = this._settings?.get_string('visibility-mode') ?? 'background-only';
        return {
            'background-only': {
                title: 'No background apps running',
                sub: 'Apps closed to background will appear here',
            },
            'all-running': {
                title: 'No applications running',
                sub: 'Running desktop applications will appear here',
            },
        }[mode] ?? {
            title: 'No background apps running',
            sub: 'Background applications will appear here',
        };
    }

    render(forceRebuild = false) {
        this._updateModePillLabel();
        const allApps = this._registry.getVisibleApps();
        this._modeCountLabel.set_text(String(allApps.length).padStart(2, '0'));

        if (allApps.length === 0) {
            const copy = this._getEmptyStateCopy();
            if (this._emptyView) {
                // Update empty-state labels in-place (zero flash on mode switch or 80ms echo!)
                this._emptyView.titleLabel.set_text(copy.title);
                this._emptyView.subLabel.set_text(copy.sub);
                return;
            }
            this._renderedOrderSig = '__empty__';
            this._renderedCards.clear();
            this._listBox.destroy_all_children();
            this._emptyView = this._buildEmptyState(copy);
            this._listBox.add_child(this._emptyView.box);
            this._scrollView.set_height(-1);
            return;
        }

        const orderSig = allApps
            .map(a => `${a.canonicalId}:${a.displayName}:${a.attention ? 1 : 0}`)
            .join('|');

        // Fast in-place update when only process counts or states changed (preserves scroll!)
        if (!forceRebuild && orderSig === this._renderedOrderSig && !this._emptyView) {
            for (const record of allApps) {
                const refs = this._renderedCards.get(record.canonicalId);
                if (!refs)
                    continue;

                const stateInfo = STATE_UI[record.state] ?? STATE_UI[AppState.BACKGROUND];
                refs.statusLabel.set_text(stateInfo.label);
                refs.statusLabel.set_style_class_name(`system-tray-status-pill ${stateInfo.cls}`);

                if (refs.metaLabel) {
                    const pkg = PACKAGING_LABELS[record.packaging] ?? 'App';
                    const procText = record.processCount > 1 ? `${record.processCount} procs` : '1 proc';
                    refs.metaLabel.set_text(`${pkg} · ${procText}`);
                }
            }
            return;
        }

        this._emptyView = null;
        this._renderedOrderSig = orderSig;
        this._renderedCards.clear();
        this._listBox.destroy_all_children();

        for (const record of allApps)
            this._listBox.add_child(this._buildAppCard(record));

        this._syncScrollHeight(allApps.length);
    }

    /**
     * Superlative Cross-Monitor / Cross-DPI UI Height Manager:
     * Dynamically measures actual rendered card heights & theme spacing on any monitor/scale
     * so exactly min(3, appCount) cards fit cleanly with zero clipping and zero peeking.
     */
    _syncScrollHeight(appCount) {
        const visibleSlots = Math.min(3, appCount);
        const estSpacing = 12;
        const estHeight = visibleSlots * this._lastCardHeight + Math.max(0, visibleSlots - 1) * estSpacing;
        this._scrollView.set_height(estHeight);

        if (this._measureIdleId) {
            GLib.source_remove(this._measureIdleId);
            this._measureIdleId = 0;
        }

        this._measureIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._measureIdleId = 0;
            if (!this._listBox || !this._scrollView)
                return GLib.SOURCE_REMOVE;

            const children = this._listBox.get_children();
            if (children.length === 0)
                return GLib.SOURCE_REMOVE;

            let spacing = estSpacing;
            try {
                const node = this._listBox.get_theme_node();
                const themeSpacing = node?.get_length('spacing');
                if (themeSpacing > 0)
                    spacing = themeSpacing;
            } catch {
                // Keep default spacing
            }

            const count = Math.min(3, children.length);
            let total = 0;
            for (let i = 0; i < count; i++) {
                const [, natH] = children[i].get_preferred_height(-1);
                if (natH > 0) {
                    total += natH;
                    if (i === 0)
                        this._lastCardHeight = natH;
                }
            }
            total += Math.max(0, count - 1) * spacing;

            if (total > 0)
                this._scrollView.set_height(Math.ceil(total));

            return GLib.SOURCE_REMOVE;
        });
    }

    _buildEmptyState(copy) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'system-tray-empty-box',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const iconFile = this._extensionDir?.get_child('icons').get_child('system-tray-symbolic.svg');
        const emptyIcon = iconFile
            ? new St.Icon({
                gicon: Gio.FileIcon.new(iconFile),
                fallback_gicon: Gio.ThemedIcon.new('view-grid-symbolic'),
                style_class: 'system-tray-empty-icon',
                x_align: Clutter.ActorAlign.CENTER,
            })
            : new St.Icon({
                icon_name: 'view-grid-symbolic',
                style_class: 'system-tray-empty-icon',
                x_align: Clutter.ActorAlign.CENTER,
            });
        box.add_child(emptyIcon);

        const titleLabel = new St.Label({
            text: copy.title,
            style_class: 'system-tray-empty-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(titleLabel);

        const subLabel = new St.Label({
            text: copy.sub,
            style_class: 'system-tray-empty-sub',
            x_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(subLabel);

        return {box, titleLabel, subLabel};
    }

    _buildAppCard(record) {
        const isStopping = record.state === AppState.STOPPING;

        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: record.attention
                ? 'system-tray-app-card system-tray-app-card-attention'
                : 'system-tray-app-card',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // 1. Clickable App Bar (Icon + Name + Status -> Opens the App!)
        const openRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'system-tray-open-area-box',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        openRow.add_child(this._iconResolver.createIconWidget(record, 32));

        const infoCol = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'system-tray-info-col',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const nameLabel = new St.Label({
            text: record.displayName,
            style_class: 'system-tray-app-name',
            y_align: Clutter.ActorAlign.CENTER,
        });
        nameLabel.clutter_text.set_single_line_mode(true);
        nameLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        infoCol.add_child(nameLabel);

        const subRow = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'system-tray-subtitle-row',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const stateInfo = STATE_UI[record.state] ?? STATE_UI[AppState.BACKGROUND];
        const statusLabel = new St.Label({
            text: stateInfo.label,
            style_class: `system-tray-status-pill ${stateInfo.cls}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        subRow.add_child(statusLabel);

        let metaLabel = null;
        if (this._settings?.get_boolean('show-process-count') ?? true) {
            const pkg = PACKAGING_LABELS[record.packaging] ?? 'App';
            const procText = record.processCount > 1 ? `${record.processCount} procs` : '1 proc';
            metaLabel = new St.Label({
                text: `${pkg} · ${procText}`,
                style_class: 'system-tray-meta-text',
                y_align: Clutter.ActorAlign.CENTER,
            });
            metaLabel.clutter_text.set_single_line_mode(true);
            metaLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            subRow.add_child(metaLabel);
        }

        infoCol.add_child(subRow);
        openRow.add_child(infoCol);

        const openAreaBtn = new St.Button({
            style_class: 'system-tray-open-area',
            x_expand: true,
            can_focus: true,
            reactive: !isStopping,
            accessible_name: `Open ${record.displayName}`,
            child: openRow,
        });
        openAreaBtn.set_reactive(!isStopping);
        if (isStopping)
            openAreaBtn.add_style_pseudo_class('insensitive');
        openAreaBtn.connect('clicked', () => {
            this._onCloseMenu?.();
            this._actions.openApp(record).catch(() => {});
        });

        // 2. Always-Red Kill Button
        const isConfirming = this._pendingConfirmIds.has(record.canonicalId);
        const killBtn = new St.Button({
            label: isConfirming ? 'Sure?' : 'Kill',
            style_class: isConfirming ? 'system-tray-btn-kill-confirm' : 'system-tray-btn-kill',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: `Force Quit ${record.displayName}`,
        });
        killBtn.connect('clicked', () => this._onKillClicked(record, killBtn));

        card.add_child(openAreaBtn);
        card.add_child(killBtn);

        this._renderedCards.set(record.canonicalId, {
            card,
            statusLabel,
            metaLabel,
        });

        return card;
    }

    _onKillClicked(record, killBtn) {
        const needConfirm = this._settings?.get_boolean('confirm-force-quit') ?? false;
        const id = record.canonicalId;

        if (!needConfirm || this._pendingConfirmIds.has(id)) {
            this._clearConfirmState(id);
            this._actions.forceQuitApp(record).catch(() => {});
            return;
        }

        this._pendingConfirmIds.add(id);
        killBtn.set_label('Sure?');
        killBtn.set_style_class_name('system-tray-btn-kill-confirm');

        const timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._confirmTimers.delete(id);
            this._pendingConfirmIds.delete(id);
            if (this._isOpen)
                this.render();
            return GLib.SOURCE_REMOVE;
        });
        this._confirmTimers.set(id, timerId);
    }

    _clearConfirmState(canonicalId) {
        this._pendingConfirmIds.delete(canonicalId);
        const timerId = this._confirmTimers.get(canonicalId);
        if (timerId) {
            GLib.source_remove(timerId);
            this._confirmTimers.delete(canonicalId);
        }
    }

    _clearAllConfirmStates() {
        for (const timerId of this._confirmTimers.values())
            GLib.source_remove(timerId);
        this._confirmTimers.clear();
        this._pendingConfirmIds.clear();
    }

    destroy() {
        this._stopLiveRefresh();
        if (this._measureIdleId) {
            GLib.source_remove(this._measureIdleId);
            this._measureIdleId = 0;
        }
        this._renderedCards.clear();
        this._emptyView = null;
        this._clearAllConfirmStates();

        if (this._registry && this._registrySignalId) {
            this._registry.disconnect(this._registrySignalId);
            this._registrySignalId = 0;
        }

        this._rootBox?.destroy();
        this._rootBox = null;
    }
}