import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {TrayPopupView} from './trayPopup.js';

export const SystemTrayIndicator = GObject.registerClass(
class SystemTrayIndicator extends PanelMenu.Button {
    _init(deps) {
        super._init(0.5, 'System Tray', false);

        this._registry = deps.registry;
        this._settings = deps.settings;
        this._extensionDir = deps.extensionDir;
        this._destroyed = false;
        this.add_style_class_name('system-tray-panel-button');

        // Top Bar Content (Icon + Count Badge)
        const panelBox = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'system-tray-panel-box',
            y_align: Clutter.ActorAlign.CENTER,
        });

        const iconFile = this._extensionDir.get_child('icons').get_child('system-tray-symbolic.svg');
        this._panelIcon = new St.Icon({
            gicon: Gio.FileIcon.new(iconFile),
            fallback_gicon: Gio.ThemedIcon.new('view-grid-symbolic'),
            style_class: 'system-status-icon system-tray-panel-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._badgeLabel = new St.Label({
            text: '0',
            style_class: 'system-tray-panel-badge',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        panelBox.add_child(this._panelIcon);
        panelBox.add_child(this._badgeLabel);
        this.add_child(panelBox);

        // Attach Libadwaita-style Popup View
        this._popupView = new TrayPopupView({
            registry: deps.registry,
            iconResolver: deps.iconResolver,
            actionsManager: deps.actionsManager,
            systemdWatcher: deps.systemdWatcher,
            sniWatcher: deps.sniWatcher,
            customWatcher: deps.customWatcher,
            settings: deps.settings,
            extensionDir: deps.extensionDir,
            onCloseMenu: () => this.menu?.close(),
            onOpenPreferences: deps.onOpenPreferences,
        });
        this.menu.actor.add_style_class_name('system-tray-menu-popup');
        this.menu.box.add_child(this._popupView.actor);

        this._menuSignalId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            this._popupView?.onMenuOpenStateChanged(isOpen);
            if (!isOpen)
                this._updateIndicatorState();
        });

        this._registrySignalId = this._registry.connect('changed', () => {
            this._updateIndicatorState();
        });

        this._settingsSignalId = this._settings?.connect('changed', (_s, key) => {
            if (key === 'auto-hide-indicator' || key === 'show-count-badge')
                this._updateIndicatorState();
        }) ?? 0;

        this.connect('destroy', () => {
            this._destroyed = true;
            this._disconnectSignals();
        });

        this._updateIndicatorState();
    }

    _disconnectSignals() {
        if (this._menuSignalId && this.menu) {
            try {
                this.menu.disconnect(this._menuSignalId);
            } catch {
                // Already disposed
            }
            this._menuSignalId = 0;
        }

        if (this._registry && this._registrySignalId) {
            this._registry.disconnect(this._registrySignalId);
            this._registrySignalId = 0;
        }

        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }
    }

    _updateIndicatorState() {
        if (this._destroyed || !this._badgeLabel || !this._badgeLabel.clutter_text)
            return;

        const visibleApps = this._registry.getVisibleApps();
        const count = visibleApps.length;
        const autoHide = this._settings?.get_boolean('auto-hide-indicator') ?? true;
        const showBadge = this._settings?.get_boolean('show-count-badge') ?? true;
        const hasAttention = visibleApps.some(app => app.attention);

        const badgeVisible = showBadge && count > 0;
        this._badgeLabel.set_text(String(count));
        this._badgeLabel.visible = badgeVisible;

        if (badgeVisible)
            this.add_style_class_name('system-tray-has-badge');
        else
            this.remove_style_class_name('system-tray-has-badge');

        if (hasAttention)
            this._badgeLabel.add_style_class_name('system-tray-panel-badge-attention');
        else
            this._badgeLabel.remove_style_class_name('system-tray-panel-badge-attention');

        // Keep button visible while popup menu is open so closing last app stays smooth
        const menuOpen = this.menu?.isOpen ?? false;
        this.visible = !autoHide || count > 0 || menuOpen;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;

        if (this._menuSignalId && this.menu) {
            this.menu.disconnect(this._menuSignalId);
            this._menuSignalId = 0;
        }

        if (this._registry && this._registrySignalId) {
            this._registry.disconnect(this._registrySignalId);
            this._registrySignalId = 0;
        }

        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        this._popupView?.destroy();
        this._popupView = null;

        super.destroy();
    }
});