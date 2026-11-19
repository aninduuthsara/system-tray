import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ActionsManager} from './src/core/actionsManager.js';
import {IconResolver} from './src/core/iconResolver.js';
import {ApplicationRegistry} from './src/core/registry.js';
import {CustomWatcher} from './src/discovery/customWatcher.js';
import {SniWatcher} from './src/discovery/sniWatcher.js';
import {SystemdWatcher} from './src/discovery/systemdWatcher.js';
import {SystemTrayIndicator} from './src/ui/topBarIndicator.js';

export default class SystemTrayExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // 1. Core Brain & Action Engines
        this._registry = new ApplicationRegistry(this._settings);
        this._iconResolver = new IconResolver();
        this._actionsManager = new ActionsManager(this._registry, this._settings);

        // 2. Discovery Adapters
        this._systemdWatcher = new SystemdWatcher(this._registry, this._settings);
        this._sniWatcher = new SniWatcher(this._registry, this._settings);
        this._customWatcher = new CustomWatcher(this._registry, this._settings);

        this._actionsManager.setSniWatcher(this._sniWatcher);

        // 3. Top Bar UI
        this._createIndicator();

        this._settingsSignalId = this._settings.connect('changed', (_s, key) => {
            if (key === 'panel-position' || key === 'panel-index')
                this._createIndicator();
        });

        // 4. Start Event-Driven Watchers
        this._sniWatcher.start();
        this._systemdWatcher.start().catch(e => {
            console.error(`[SystemTray] SystemdWatcher startup error: ${e.message}`);
        });
        this._customWatcher.start().catch(e => {
            console.error(`[SystemTray] CustomWatcher startup error: ${e.message}`);
        });
    }

    _createIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (Main.panel.statusArea[this.uuid]) {
            Main.panel.statusArea[this.uuid].destroy();
        }

        const position = this._settings?.get_string('panel-position') ?? 'right';
        const index = this._settings?.get_int('panel-index') ?? 0;

        this._indicator = new SystemTrayIndicator({
            registry: this._registry,
            iconResolver: this._iconResolver,
            actionsManager: this._actionsManager,
            sniWatcher: this._sniWatcher,
            customWatcher: this._customWatcher,
            settings: this._settings,
            extensionDir: this.dir,
            onOpenPreferences: () => this.openPreferences(),
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator, index, position);
    }

    disable() {
        if (this._settings && this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }

        // Reverse teardown: UI -> Watchers -> Core -> Settings
        this._indicator?.destroy();
        this._indicator = null;

        this._customWatcher?.destroy();
        this._customWatcher = null;

        this._sniWatcher?.destroy();
        this._sniWatcher = null;

        this._systemdWatcher?.destroy();
        this._systemdWatcher = null;

        this._actionsManager?.destroy();
        this._actionsManager = null;

        this._iconResolver?.destroy();
        this._iconResolver = null;

        this._registry?.destroy();
        this._registry = null;

        this._settings = null;
    }
}