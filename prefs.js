import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PANEL_POSITIONS = [
    {key: 'left', label: 'Left'},
    {key: 'center', label: 'Center'},
    {key: 'right', label: 'Right'},
];

const VISIBILITY_MODES = [
    {key: 'background-only', label: 'Background'},
    {key: 'all-running', label: 'All Apps'},
];

const FORCE_QUIT_MODES = [
    {key: 'immediate', label: 'Instant Kill'},
    {key: 'escalate', label: 'Safe Kill'},
];

const MATCH_TYPES = [
    {key: 'cmdline', label: 'Command Line Keyword'},
    {key: 'process', label: 'Process Name (/proc/comm)'},
    {key: 'path', label: 'Executable / AppImage Path'},
    {key: 'desktop', label: 'Desktop File ID'},
];

function clearListBox(listBox) {
    let child = listBox.get_first_child();
    while (child) {
        const next = child.get_next_sibling();
        listBox.remove(child);
        child = next;
    }
}

function bindComboRow(settings, key, comboRow, options, signalCleanups) {
    const model = Gtk.StringList.new(options.map(o => o.label));
    comboRow.set_model(model);

    const syncFromSettings = () => {
        const val = settings.get_string(key);
        const idx = Math.max(0, options.findIndex(o => o.key === val));
        if (comboRow.get_selected() !== idx)
            comboRow.set_selected(idx);
    };

    syncFromSettings();

    const sig1 = comboRow.connect('notify::selected', () => {
        const idx = comboRow.get_selected();
        const chosen = options[idx];
        if (chosen && settings.get_string(key) !== chosen.key)
            settings.set_string(key, chosen.key);
    });

    const sig2 = settings.connect(`changed::${key}`, syncFromSettings);
    signalCleanups.push(() => {
        comboRow.disconnect(sig1);
        settings.disconnect(sig2);
    });
}

export default class SystemTrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const signalCleanups = [];

        window.set_default_size(680, 720);
        window.set_search_enabled(true);

        window.connect('close-request', () => {
            for (const fn of signalCleanups) {
                try {
                    fn();
                } catch {
                    // Ignore
                }
            }
            signalCleanups.length = 0;
            return false;
        });

        window.add(this._buildGeneralPage(window, settings, signalCleanups));
        window.add(this._buildAboutPage(window));
    }

    // =========================================================================
    // Page 1: General Settings
    // =========================================================================

    _buildGeneralPage(window, settings, signalCleanups) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        // Group 1: Top Bar Indicator
        const topBarGroup = new Adw.PreferencesGroup({
            title: 'Top Bar',
        });

        const autoHideRow = new Adw.SwitchRow({
            title: 'Auto-Hide When Empty',
            subtitle: 'Hide the top bar button when zero matching apps are running.',
        });
        settings.bind('auto-hide-indicator', autoHideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        topBarGroup.add(autoHideRow);

        const badgeRow = new Adw.SwitchRow({
            title: 'Show App Count',
            subtitle: 'Display running app count next to the top bar icon.',
        });
        settings.bind('show-count-badge', badgeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        topBarGroup.add(badgeRow);

        const posRow = new Adw.ComboRow({
            title: 'Panel Position',
        });
        bindComboRow(settings, 'panel-position', posRow, PANEL_POSITIONS, signalCleanups);
        topBarGroup.add(posRow);

        page.add(topBarGroup);

        // Group 2: Apps & Termination
        const appsGroup = new Adw.PreferencesGroup({
            title: 'Apps &amp; Termination',
        });

        const visModeRow = new Adw.ComboRow({
            title: 'Current Mode',
        });
        bindComboRow(settings, 'visibility-mode', visModeRow, VISIBILITY_MODES, signalCleanups);
        appsGroup.add(visModeRow);

        const defaultModeRow = new Adw.ComboRow({
            title: 'Always Show Mode',
            subtitle: 'Preferred view mode when Always Lock is enabled.',
        });
        bindComboRow(settings, 'default-visibility-mode', defaultModeRow, VISIBILITY_MODES, signalCleanups);
        appsGroup.add(defaultModeRow);

        const lockModeRow = new Adw.SwitchRow({
            title: 'Always Lock Mode',
            subtitle: 'Reset to Always Show Mode every time the popup opens.',
        });
        settings.bind('always-use-default-mode', lockModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        const syncDefaultOnToggle = () => {
            if (settings.get_boolean('always-use-default-mode'))
                settings.set_string('visibility-mode', settings.get_string('default-visibility-mode'));
        };
        const lockSig1 = settings.connect('changed::always-use-default-mode', syncDefaultOnToggle);
        const lockSig2 = settings.connect('changed::default-visibility-mode', syncDefaultOnToggle);
        signalCleanups.push(() => {
            settings.disconnect(lockSig1);
            settings.disconnect(lockSig2);
        });
        appsGroup.add(lockModeRow);

        const procCountRow = new Adw.SwitchRow({
            title: 'App Type &amp; Process Count',
            subtitle: 'Show Flatpak / Native / Custom labels and active process count.',
        });
        settings.bind('show-process-count', procCountRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appsGroup.add(procCountRow);

        const fqModeRow = new Adw.ComboRow({
            title: 'Kill Behavior',
        });
        bindComboRow(settings, 'force-quit-mode', fqModeRow, FORCE_QUIT_MODES, signalCleanups);
        appsGroup.add(fqModeRow);

        const confirmRow = new Adw.SwitchRow({
            title: 'Confirm Before Kill',
            subtitle: 'Ask once ("Sure?") inside the Kill button before terminating.',
        });
        settings.bind('confirm-force-quit', confirmRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appsGroup.add(confirmRow);

        page.add(appsGroup);

        // Group 3: Custom Apps (Combined cleanly inside General)
        const addGroup = new Adw.PreferencesGroup({
            title: 'Custom Apps',
            description: 'Add standalone binaries, AppImages, or installed apps for guaranteed tracking.',
        });

        const pickInstalledRow = new Adw.ActionRow({
            title: 'Add Installed App',
            subtitle: 'Choose from installed desktop applications.',
            activatable: true,
        });
        pickInstalledRow.add_prefix(new Gtk.Image({icon_name: 'view-app-grid-symbolic'}));
        pickInstalledRow.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        pickInstalledRow.connect('activated', () => this._openInstalledAppPicker(window, settings));
        addGroup.add(pickInstalledRow);

        const addCustomRow = new Adw.ActionRow({
            title: 'Add Binary / AppImage / Keyword',
            subtitle: 'Match by command-line keyword, process name, or file path.',
            activatable: true,
        });
        addCustomRow.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
        addCustomRow.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        addCustomRow.connect('activated', () => this._openCustomRuleDialog(window, settings));
        addGroup.add(addCustomRow);

        page.add(addGroup);

        const listGroup = new Adw.PreferencesGroup({
            title: 'Watched Custom Apps',
        });
        page.add(listGroup);

        let renderedRows = [];
        const rebuildCustomList = () => {
            for (const r of renderedRows)
                listGroup.remove(r);
            renderedRows = [];

            const rules = this._readCustomRules(settings);
            if (rules.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: 'No custom apps added yet',
                    subtitle: 'Standard desktop and tray apps are detected automatically.',
                });
                listGroup.add(emptyRow);
                renderedRows.push(emptyRow);
                return;
            }

            for (const rule of rules) {
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(rule.name || rule.pattern, -1),
                    subtitle: GLib.markup_escape_text(
                        `Match (${rule.matchType}): ${rule.pattern}`,
                        -1
                    ),
                });

                const iconWidget = this._makeGtkIcon(rule.icon || 'application-x-executable');
                row.add_prefix(iconWidget);

                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove custom rule',
                    css_classes: ['flat', 'destructive-action'],
                });
                delBtn.connect('clicked', () => this._removeCustomRule(settings, rule.id));
                row.add_suffix(delBtn);

                listGroup.add(row);
                renderedRows.push(row);
            }
        };

        rebuildCustomList();
        const sig = settings.connect('changed::custom-watched-apps', rebuildCustomList);
        signalCleanups.push(() => settings.disconnect(sig));

        return page;
    }

    _readCustomRules(settings) {
        const raw = settings.get_strv('custom-watched-apps');
        const rules = [];
        for (const item of raw) {
            try {
                const parsed = JSON.parse(item);
                if (parsed && parsed.pattern)
                    rules.push(parsed);
            } catch {
                // Skip invalid
            }
        }
        return rules;
    }

    _upsertCustomRule(settings, newRule) {
        const list = this._readCustomRules(settings);
        const idx = list.findIndex(r => r.id === newRule.id);
        if (idx >= 0)
            list[idx] = newRule;
        else
            list.push(newRule);
        settings.set_strv('custom-watched-apps', list.map(r => JSON.stringify(r)));
    }

    _removeCustomRule(settings, ruleId) {
        const list = this._readCustomRules(settings).filter(r => r.id !== ruleId);
        settings.set_strv('custom-watched-apps', list.map(r => JSON.stringify(r)));
    }

    _makeGtkIcon(iconStr) {
        if (iconStr && iconStr.startsWith('/')) {
            return new Gtk.Image({
                file: iconStr,
                pixel_size: 28,
            });
        }
        if (iconStr && iconStr.startsWith('. ')) {
            try {
                const gicon = Gio.Icon.deserialize(GLib.Variant.new_string(iconStr));
                if (gicon)
                    return new Gtk.Image({gicon, pixel_size: 28});
            } catch {
                // Fallback below
            }
        }
        return new Gtk.Image({
            icon_name: iconStr || 'application-x-executable-symbolic',
            pixel_size: 28,
        });
    }

    _openInstalledAppPicker(parentWindow, settings) {
        const dialog = new Adw.Dialog({
            title: 'Select Installed Application',
            content_width: 460,
            content_height: 540,
        });

        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(new Adw.HeaderBar());

        const contentBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: 'Search installed apps…',
        });
        contentBox.append(searchEntry);

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: listBox,
        });
        contentBox.append(scrolled);

        const allApps = Gio.AppInfo.get_all()
            .filter(app => app.should_show())
            .sort((a, b) => (a.get_display_name() || '').localeCompare(b.get_display_name() || ''));

        const populate = query => {
            clearListBox(listBox);
            const q = query.trim().toLowerCase();

            for (const app of allApps) {
                const name = app.get_display_name() || app.get_name() || '';
                const id = app.get_id() || '';
                if (q && !name.toLowerCase().includes(q) && !id.toLowerCase().includes(q))
                    continue;

                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(name, -1),
                    subtitle: GLib.markup_escape_text(id.replace(/\.desktop$/i, ''), -1),
                    activatable: true,
                });

                const gicon = app.get_icon();
                if (gicon)
                    row.add_prefix(new Gtk.Image({gicon, pixel_size: 28}));
                else
                    row.add_prefix(new Gtk.Image({icon_name: 'application-x-executable', pixel_size: 28}));

                row.connect('activated', () => {
                    const exec = app.get_executable() || '';
                    const baseExec = exec ? GLib.path_get_basename(exec) : id.replace(/\.desktop$/i, '');
                    const iconObj = app.get_icon();
                    const iconStr =
                        iconObj?.get_names?.()?.[0] ||
                        iconObj?.get_file?.()?.get_path?.() ||
                        id.replace(/\.desktop$/i, '');

                    this._upsertCustomRule(settings, {
                        id: `desktop-${id.replace(/\.desktop$/i, '')}`,
                        name,
                        matchType: 'cmdline',
                        pattern: baseExec,
                        desktopId: id,
                        execPath: app.get_commandline() || exec,
                        icon: iconStr,
                    });
                    dialog.close();
                });

                listBox.append(row);
            }
        };

        populate('');
        searchEntry.connect('search-changed', () => populate(searchEntry.get_text()));

        toolbarView.set_content(contentBox);
        dialog.set_child(toolbarView);
        dialog.present(parentWindow);
    }

    _openCustomRuleDialog(parentWindow, settings) {
        const dialog = new Adw.Dialog({
            title: 'Add Custom App Rule',
            content_width: 460,
            content_height: 490,
        });

        const toolbarView = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        toolbarView.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            description: 'Define how System Tray should detect and open this application.',
        });

        const nameRow = new Adw.EntryRow({title: 'Display Name (e.g. Motrix)'});
        group.add(nameRow);

        const matchCombo = new Adw.ComboRow({
            title: 'Match Type',
            model: Gtk.StringList.new(MATCH_TYPES.map(m => m.label)),
            selected: 0,
        });
        group.add(matchCombo);

        const patternRow = new Adw.EntryRow({title: 'Match Pattern (keyword, process, or path)'});
        const browseBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Browse executable or AppImage',
            css_classes: ['flat'],
        });
        browseBtn.connect('clicked', () => {
            const fileDlg = new Gtk.FileDialog({
                title: 'Select Binary or AppImage',
                modal: true,
            });
            fileDlg.open(parentWindow, null, (dlg, res) => {
                try {
                    const file = dlg.open_finish(res);
                    const path = file?.get_path();
                    if (path) {
                        patternRow.set_text(path);
                        matchCombo.set_selected(2); // Executable / AppImage Path
                        if (!nameRow.get_text().trim())
                            nameRow.set_text(GLib.path_get_basename(path).replace(/\.appimage$/i, ''));
                        if (!execRow.get_text().trim())
                            execRow.set_text(path);
                    }
                } catch {
                    // Cancelled
                }
            });
        });
        patternRow.add_suffix(browseBtn);
        group.add(patternRow);

        const execRow = new Adw.EntryRow({title: 'Launch Command (Optional, for Open button)'});
        group.add(execRow);

        const iconRow = new Adw.EntryRow({title: 'Icon Name or File Path (Optional)'});
        const browseIconBtn = new Gtk.Button({
            icon_name: 'image-x-generic-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Browse PNG/SVG icon file',
            css_classes: ['flat'],
        });
        browseIconBtn.connect('clicked', () => {
            const fileDlg = new Gtk.FileDialog({
                title: 'Select App Icon',
                modal: true,
            });
            fileDlg.open(parentWindow, null, (dlg, res) => {
                try {
                    const file = dlg.open_finish(res);
                    const path = file?.get_path();
                    if (path)
                        iconRow.set_text(path);
                } catch {
                    // Cancelled
                }
            });
        });
        iconRow.add_suffix(browseIconBtn);
        group.add(iconRow);

        page.add(group);

        const saveBtn = new Gtk.Button({
            label: 'Save Rule',
            halign: Gtk.Align.END,
            margin_top: 12,
            margin_bottom: 16,
            margin_end: 18,
            css_classes: ['suggested-action', 'pill'],
        });
        saveBtn.connect('clicked', () => {
            const pattern = patternRow.get_text().trim();
            if (!pattern)
                return;

            const name = nameRow.get_text().trim() || GLib.path_get_basename(pattern);
            const matchType = MATCH_TYPES[matchCombo.get_selected()]?.key ?? 'cmdline';
            const execPath = execRow.get_text().trim();
            const icon = iconRow.get_text().trim();

            this._upsertCustomRule(settings, {
                id: `custom-${Date.now()}`,
                name,
                matchType,
                pattern,
                desktopId: matchType === 'desktop' ? pattern : '',
                execPath,
                icon,
            });
            dialog.close();
        });

        const wrapper = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        page.set_vexpand(true);
        wrapper.append(page);
        wrapper.append(saveBtn);

        toolbarView.set_content(wrapper);
        dialog.set_child(toolbarView);
        dialog.present(parentWindow);
    }

    // =========================================================================
    // Page 3: About
    // =========================================================================

    _buildAboutPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        // Hero Card with Main SVG Icon
        const heroGroup = new Adw.PreferencesGroup();
        const heroBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            halign: Gtk.Align.CENTER,
            margin_top: 18,
            margin_bottom: 12,
        });

        const iconFile = this.dir.get_child('icons').get_child('system-tray-symbolic.svg');
        const svgImage = iconFile.query_exists(null)
            ? Gtk.Image.new_from_file(iconFile.get_path())
            : new Gtk.Image({icon_name: 'view-grid-symbolic'});
        svgImage.set_pixel_size(72);

        const titleLabel = new Gtk.Label({
            label: 'System Tray',
            css_classes: ['title-1'],
        });

        const versionLabel = new Gtk.Label({
            label: 'Version 0.1 · Fedora 45 · GNOME 51.1',
            css_classes: ['dim-label'],
        });

        heroBox.append(svgImage);
        heroBox.append(titleLabel);
        heroBox.append(versionLabel);
        heroGroup.add(heroBox);
        page.add(heroGroup);

        // Developer & GitHub Group
        const infoGroup = new Adw.PreferencesGroup();

        const authorRow = new Adw.ActionRow({
            title: 'Developer',
            subtitle: 'Anindu Uthsara',
        });
        authorRow.add_prefix(new Gtk.Image({icon_name: 'avatar-default-symbolic'}));
        infoGroup.add(authorRow);

        const githubRow = new Adw.ActionRow({
            title: 'GitHub',
            subtitle: 'https://github.com/aninduuthsara',
            activatable: true,
        });
        const ghFile = this.dir.get_child('icons').get_child('github-symbolic.svg');
        const ghIcon = ghFile.query_exists(null)
            ? Gtk.Image.new_from_file(ghFile.get_path())
            : new Gtk.Image({icon_name: 'code-context-symbolic'});
        ghIcon.set_pixel_size(20);
        githubRow.add_prefix(ghIcon);
        githubRow.connect('activated', () => {
            new Gtk.UriLauncher({uri: 'https://github.com/aninduuthsara'}).launch(window, null, null);
        });
        infoGroup.add(githubRow);

        page.add(infoGroup);
        return page;
    }
}