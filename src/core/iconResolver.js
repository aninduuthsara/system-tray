import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

const FALLBACK_ICON_NAME = 'application-x-executable';

function getCoglContext() {
    return global.stage?.get_context?.()?.get_backend?.()?.get_cogl_context?.() ?? null;
}

/**
 * Convert network-byte-order ARGB (SNI IconPixmap) into RGBA_8888 Uint8Array.
 * @param {Uint8Array|number[]} argbBytes
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array|null}
 */
function convertArgbToRgba(argbBytes, width, height) {
    const expectedLen = width * height * 4;
    if (!argbBytes || argbBytes.length < expectedLen)
        return null;

    const rgba = new Uint8Array(expectedLen);
    for (let i = 0; i < expectedLen; i += 4) {
        const a = argbBytes[i];
        const r = argbBytes[i + 1];
        const g = argbBytes[i + 2];
        const b = argbBytes[i + 3];
        rgba[i] = r;
        rgba[i + 1] = g;
        rgba[i + 2] = b;
        rgba[i + 3] = a;
    }
    return rgba;
}

function createGIconFromPixmaps(pixmaps) {
    if (!Array.isArray(pixmaps) || pixmaps.length === 0)
        return null;

    const coglContext = getCoglContext();
    if (!coglContext)
        return null;

    // Pick the highest-resolution valid pixmap to prevent blurriness
    let best = null;
    let bestArea = 0;
    for (const entry of pixmaps) {
        if (!entry)
            continue;
        const w = entry.width ?? entry[0] ?? 0;
        const h = entry.height ?? entry[1] ?? 0;
        const data = entry.data ?? entry[2];
        if (w > 0 && h > 0 && data && data.length >= w * h * 4) {
            const area = w * h;
            if (area > bestArea) {
                bestArea = area;
                best = {w, h, data};
            }
        }
    }

    if (!best)
        return null;

    const rgba = convertArgbToRgba(best.data, best.w, best.h);
    if (!rgba)
        return null;

    try {
        const content = St.ImageContent.new_with_preferred_size(best.w, best.h);
        content.set_bytes(
            coglContext,
            GLib.Bytes.new(rgba),
            Cogl.PixelFormat.RGBA_8888,
            best.w,
            best.h,
            best.w * 4
        );
        return content;
    } catch (e) {
        console.debug(`[SystemTray] Failed to build St.ImageContent: ${e.message}`);
        return null;
    }
}

async function fileExistsAsync(file, cancellable) {
    try {
        await new Promise((resolve, reject) => {
            file.query_info_async(
                'standard::type',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_LOW,
                cancellable,
                (src, res) => {
                    try {
                        src.query_info_finish(res);
                        resolve(true);
                    } catch (err) {
                        reject(err);
                    }
                }
            );
        });
        return true;
    } catch {
        return false;
    }
}

export class IconResolver {
    constructor() {
        this._cache = new Map(); // cacheKey -> Gio.Icon
        this._cancellable = new Gio.Cancellable();
    }

    _makeCacheKey(record) {
        const sniSig = [];
        for (const item of record.sniItems.values())
            sniSig.push(`${item.iconName ?? ''}|${item.iconThemePath ?? ''}|${item.iconPixmap?.length ?? 0}`);

        return `${record.canonicalId}::${record.customIcon ?? ''}::${sniSig.join(',')}`;
    }

    _resolveSyncGIcon(record) {
        // 1. User Custom Icon
        if (record.customIcon) {
            if (record.customIcon.startsWith('/'))
                return Gio.FileIcon.new(Gio.File.new_for_path(record.customIcon));
            return Gio.ThemedIcon.new_with_default_fallbacks(record.customIcon);
        }

        // 2. Native Desktop AppInfo Icon (Crisp SVG / Full-Res PNG)
        if (record.desktopAppInfo) {
            const desktopIcon = record.desktopAppInfo.get_icon();
            if (desktopIcon)
                return desktopIcon;
        }

        // 3. SNI Properties (File path -> Colorful Theme Name -> Largest Pixmap)
        for (const item of record.sniItems.values()) {
            if (item.iconName) {
                if (item.iconName.startsWith('/'))
                    return Gio.FileIcon.new(Gio.File.new_for_path(item.iconName));

                // Prefer colorful app icon over monochrome -symbolic tray icon
                const colorName = item.iconName.replace(/-symbolic$/i, '');
                if (colorName && colorName !== item.iconName)
                    return Gio.ThemedIcon.new_from_names([colorName, item.iconName]);

                return Gio.ThemedIcon.new_with_default_fallbacks(item.iconName);
            }

            if (item.iconPixmap) {
                const pixmapIcon = createGIconFromPixmaps(item.iconPixmap);
                if (pixmapIcon)
                    return pixmapIcon;
            }
        }

        // 4. Generic App Fallback
        return Gio.ThemedIcon.new(FALLBACK_ICON_NAME);
    }

    /**
     * Async lookup for custom SNI IconThemePath folders (non-blocking).
     */
    async _tryResolveThemePathIcon(record, cacheKey, stIcon) {
        if (record.desktopAppInfo?.get_icon() || record.customIcon)
            return;

        for (const item of record.sniItems.values()) {
            if (!item.iconThemePath || !item.iconName || item.iconName.startsWith('/'))
                continue;

            const candidates = [
                `${item.iconThemePath}/${item.iconName}.svg`,
                `${item.iconThemePath}/${item.iconName}.png`,
                `${item.iconThemePath}/hicolor/scalable/apps/${item.iconName}.svg`,
                `${item.iconThemePath}/hicolor/64x64/apps/${item.iconName}.png`,
                `${item.iconThemePath}/hicolor/48x48/apps/${item.iconName}.png`,
                `${item.iconThemePath}/hicolor/32x32/apps/${item.iconName}.png`,
            ];

            for (const path of candidates) {
                if (this._cancellable.is_cancelled())
                    return;

                const file = Gio.File.new_for_path(path);
                if (await fileExistsAsync(file, this._cancellable)) {
                    const fileIcon = Gio.FileIcon.new(file);
                    this._cache.set(cacheKey, fileIcon);
                    try {
                        stIcon.gicon = fileIcon;
                    } catch {
                        // Widget destroyed before async resolve completed
                    }
                    return;
                }
            }
        }
    }

    /**
     * Create a crisp, full-color St.Icon widget for an AppRecord.
     * @param {object} record
     * @param {number} size
     * @returns {St.Icon}
     */
    createIconWidget(record, size = 28) {
        const cacheKey = this._makeCacheKey(record);
        let gicon = this._cache.get(cacheKey);

        if (!gicon) {
            gicon = this._resolveSyncGIcon(record);
            this._cache.set(cacheKey, gicon);
        }

        const iconWidget = new St.Icon({
            gicon,
            icon_size: size,
            style_class: 'system-tray-app-icon',
        });

        // Upgrade in-place asynchronously if SNI provides a custom IconThemePath file
        this._tryResolveThemePathIcon(record, cacheKey, iconWidget).catch(() => {});

        return iconWidget;
    }

    clearCache() {
        this._cache.clear();
    }

    destroy() {
        this._cancellable.cancel();
        this._cache.clear();
    }
}