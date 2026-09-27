import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { getWallpaperAlpha, getWallpaperPromptColor } from '../main/alphaManager.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    resolveSlideshowXmlContent,
} from '../main/constants.js';
import { blendPixbufs } from '../main/wallpaperUtils.js';
import { _log, GDM_CROSSFADE_DURATION, resolveGdmAccessibleUri } from './gdmUtils.js';

export class GdmWallpaperManager {
    constructor(gdmManager) {
        this._gdm = gdmManager;
        this.backgroundGroup = null;
        this.bgManagers = [];
        this.monitorsChangedId = null;
        this.appliedWallpaperUser = undefined;
        this.appliedWallpaperSignature = null;
        this.currentWallpaperMetadata = null;
        this.sharedWallpaperMonitor = null;
        this.sharedWallpaperRefreshId = null;
        this._slideshowTimerId = null;
        this._currentSlideshowSignature = null;
    }

    setup(dialog, dialogParent) {
        this.backgroundGroup = new Clutter.Actor();
        dialogParent.add_child(this.backgroundGroup);
        dialogParent.set_child_below_sibling(this.backgroundGroup, dialog);

        this.bgManagers = [];
        this.monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this.updateBackgrounds();
            this._gdm._syncLockscreenMessageLayout();
            this._gdm._positionAuthPrompt();
            this._gdm._positionUserList();
        });

        this.updateBackgrounds();
        this.setupSharedWallpaperMonitor();
    }

    teardown() {
        this._stopSlideshowLoop();

        if (this.monitorsChangedId) {
            Main.layoutManager.disconnect(this.monitorsChangedId);
            this.monitorsChangedId = null;
        }

        if (this.sharedWallpaperRefreshId) {
            GLib.source_remove(this.sharedWallpaperRefreshId);
            this.sharedWallpaperRefreshId = null;
        }

        if (this.sharedWallpaperMonitor) {
            this.sharedWallpaperMonitor.disconnectObject(this);
            this.sharedWallpaperMonitor = null;
        }

        for (let i = 0; i < this.bgManagers.length; i++) {
            if (this.bgManagers[i]._bms_pipeline)
                this.bgManagers[i]._bms_pipeline.destroy();
            this.bgManagers[i].destroy();
        }
        this.bgManagers = [];

        if (this.backgroundGroup) {
            this.backgroundGroup.destroy();
            this.backgroundGroup = null;
        }

        this.appliedWallpaperUser = undefined;
        this.appliedWallpaperSignature = null;
        this.currentWallpaperMetadata = null;
    }

    createBackground(monitorIndex) {
        const monitor = Main.layoutManager.monitors[monitorIndex];

        const createWidget = () => new St.Widget({
            style_class: 'screen-shield-background',
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            effect: new Shell.BlurEffect({ name: 'blur' }),
        });

        const widgetA = createWidget();
        const widgetB = createWidget();

        widgetA.opacity = 0;
        widgetB.opacity = 0;

        this.backgroundGroup.add_child(widgetA);
        this.backgroundGroup.add_child(widgetB);

        this.bgManagers.push({
            widgetA,
            widgetB,
            activeIsA: true,
            destroy() {
                widgetA.destroy();
                widgetB.destroy();
            }
        });
    }

    updateBackgroundEffects() {
        if (!this.backgroundGroup) return;
        for (const widget of this.backgroundGroup.get_children()) {
            const effect = widget.get_effect('blur');
            if (effect) {
                effect.set({
                    brightness: 1.0,
                    radius: 0,
                });
            }
        }
    }

    setPromptBackgroundBlur(active, animate = true) {
        const scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const radius = active ? PROMPT_BLUR_RADIUS * scaleFactor : 0;
        const brightness = active ? PROMPT_BLUR_BRIGHTNESS : 1.0;

        for (const widget of this.backgroundGroup?.get_children() ?? []) {
            const effect = widget.get_effect('blur');
            if (!effect)
                continue;

            effect.set_enabled(true);
            widget.remove_transition('@effects.blur.radius');
            widget.remove_transition('@effects.blur.brightness');
            if (animate) {
                widget.ease_property('@effects.blur.radius', radius, {
                    duration: GDM_CROSSFADE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                widget.ease_property('@effects.blur.brightness', brightness, {
                    duration: GDM_CROSSFADE_DURATION,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            } else {
                effect.set({ radius, brightness });
            }
        }
    }

    updateBackgrounds() {
        if (!this.backgroundGroup) return;

        for (let i = 0; i < this.bgManagers.length; i++) {
            if (this.bgManagers[i]._bms_pipeline)
                this.bgManagers[i]._bms_pipeline.destroy();
            this.bgManagers[i].destroy();
        }

        this.bgManagers = [];
        this.backgroundGroup.destroy_all_children();

        for (let i = 0; i < Main.layoutManager.monitors.length; i++)
            this.createBackground(i);

        this.updateBackgroundEffects();
        this.appliedWallpaperUser = undefined;
        this.appliedWallpaperSignature = null;
        this.applyWallpaper();
    }

    setupSharedWallpaperMonitor() {
        if (this.sharedWallpaperMonitor)
            return;

        try {
            const dir = Gio.File.new_for_path('/var/tmp');
            this.sharedWallpaperMonitor = dir.monitor_directory(
                Gio.FileMonitorFlags.NONE,
                null
            );

            this.sharedWallpaperMonitor.connectObject('changed', (_monitor, file, _otherFile, eventType) => {
                const path = file?.get_path() ?? '';
                const name = file?.get_basename() ?? '';
                const isRelevant = name.startsWith('wack-shared-wallpaper-') && name.endsWith('.json');
                if (!isRelevant)
                    return;

                if (eventType !== Gio.FileMonitorEvent.CHANGED &&
                    eventType !== Gio.FileMonitorEvent.CREATED &&
                    eventType !== Gio.FileMonitorEvent.CHANGES_DONE_HINT &&
                    eventType !== Gio.FileMonitorEvent.MOVED_IN) {
                    return;
                }

                _log(`[WACK/GdmManager] Shared wallpaper metadata changed: ${path}`);
                this.queueSharedWallpaperRefresh();
            }, this);
        } catch (e) {
            _log('[WACK/GdmManager] Failed to monitor shared wallpaper metadata: ' + e);
        }
    }

    queueSharedWallpaperRefresh() {
        if (this.sharedWallpaperRefreshId)
            GLib.source_remove(this.sharedWallpaperRefreshId);

        this.sharedWallpaperRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this.sharedWallpaperRefreshId = null;

            const activeUserName = this._gdm._dialog?._user?.get_user_name() ?? null;
            this.applyWallpaper(activeUserName);
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this.sharedWallpaperRefreshId, '[WACK] GdmWallpaperManager.sharedWallpaperRefresh');
    }

    buildWallpaperSignature(resolvedUserName, metadata) {
        return JSON.stringify({
            username: resolvedUserName ?? null,
            source_uri: metadata?.source_uri ?? null,
            resolved_slide_path: metadata?.resolved_slide_path ?? null,
            resolved_slide_progress: metadata?.resolved_slide_progress ?? null,
            uri: metadata?.uri ?? null,
            style: metadata?.style ?? null,
            primary_color: metadata?.primary_color ?? null,
            secondary_color: metadata?.secondary_color ?? null,
            shading_type: metadata?.shading_type ?? null,
            is_color: metadata?.is_color ?? null,
            clockAlpha: metadata?.clockAlpha ?? null,
            clockFormat: metadata?.clockFormat ?? null,
            dateStyle: metadata?.dateStyle ?? null,
            promptColor: metadata?.promptColor ?? null,
            cursorBlink: metadata?.cursorBlink ?? null,
            lockscreenMode: metadata?.lockscreenMode ?? null,
            lockscreenMessageEnable: metadata?.lockscreenMessageEnable ?? null,
            lockscreenMessageText: metadata?.lockscreenMessageText ?? null,
        });
    }

    /**
     * Pre-warm the wallpaper pixel cache for the given user so that when
     * applyWallpaper() fires the colour is already resolved and the prompt
     * vibrancy update is instant — no mid-crossfade snap.
     *
     * Called from _beginVerificationForItem (the moment a user tile is
     * clicked, before _showPrompt / onUserSelected / applyWallpaper).
     */
    saveGdmWallpaperMetadata(metadata) {
        if (!metadata) return;
        try {
            const metaFile = Gio.File.new_for_path('/var/tmp/wack-shared-wallpaper-gdm.json');
            metaFile.replace_contents(
                JSON.stringify(metadata),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            metaFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            _log('[WACK/GdmManager] Failed to save GDM wallpaper metadata: ' + e);
        }
    }

    /**
     * Pre-warm the wallpaper pixel cache for the given user so that when
     * applyWallpaper() fires the colour is already resolved and the prompt
     * vibrancy update is instant — no mid-crossfade snap.
     *
     * Called from _beginVerificationForItem (the moment a user tile is
     * clicked, before _showPrompt / onUserSelected / applyWallpaper).
     */
    async prewarmAllWallpaperColors() {
        try {
            const dir = Gio.File.new_for_path('/var/tmp');
            if (!dir.query_exists(null))
                return;

            const enumerator = dir.enumerate_children(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                null
            );
            const userNames = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('wack-shared-wallpaper-') && name.endsWith('.json')) {
                    const rawName = name.replace('wack-shared-wallpaper-', '').replace('.json', '');
                    userNames.push(rawName);
                }
            }
            enumerator.close(null);

            for (const name of userNames) {
                await this.prewarmUserWallpaperColor(name);
            }
        } catch (e) {
            _log('[WACK/GdmManager] prewarmAllWallpaperColors error: ' + e);
        }
    }

    async prewarmUserWallpaperColor(userName) {
        if (!userName) return;

        let metadata = null;
        let metaFile = Gio.File.new_for_path(`/var/tmp/wack-shared-wallpaper-${userName}.json`);
        if (!metaFile.query_exists(null) && userName === 'gdm')
            metaFile = Gio.File.new_for_path('/var/tmp/wack-shared-wallpaper-gdm.json');

        if (!metaFile.query_exists(null))
            return;

        try {
            const [ok, contents] = metaFile.load_contents(null);
            if (ok)
                metadata = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            _log('[WACK/GdmManager] prewarmUserWallpaperColor: failed to read metadata: ' + e);
            return;
        }

        if (!metadata) return;

        const currentVibrancyMode = this._gdm._extension ? this._gdm._extension.getSettings().get_string('prompt-vibrancy') : 'tonal';
        const promptColor = metadata.promptColor;

        const isPromptImageValid = promptColor?.imagePath &&
            Gio.File.new_for_path(promptColor.imagePath).query_exists(null);

        const isSolid = (currentVibrancyMode === 'tonal' || currentVibrancyMode === 'less');

        const isColorValid = promptColor &&
            promptColor.r != null &&
            promptColor.g != null &&
            promptColor.b != null &&
            (promptColor.vibrancyMode === currentVibrancyMode || !promptColor.vibrancyMode) &&
            (isSolid || isPromptImageValid);

        if (isColorValid)
            return;

        const uri = resolveGdmAccessibleUri(metadata);
        if (!uri) return;

        try {
            const color = await getWallpaperPromptColor({
                uri,
                isColor: metadata.is_color,
                primaryColor: metadata.primary_color,
                secondaryColor: metadata.secondary_color,
                shadingType: metadata.shading_type,
                wellH: 0,
                yCenterFraction: null,
                promptBounds: null,
                cancelBounds: null,
                avatarBounds: null,
                a11yBounds: null,
                sessionBounds: null,
                vibrancyMode: currentVibrancyMode,
            });

            if (color) {
                metadata.promptColor = color;
                metadata.promptVibrancyMode = currentVibrancyMode;
                if (userName === 'gdm' || !metadata.username) {
                    this.saveGdmWallpaperMetadata(metadata);
                } else {
                    metaFile.replace_contents(
                        JSON.stringify(metadata),
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null
                    );
                    metaFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                }
            }
        } catch (e) {
            _log('[WACK/GdmManager] prewarmUserWallpaperColor: sample failed: ' + e);
        }
    }

    applyWallpaper(requestedUserName = null) {
        try {
            this.prewarmAllWallpaperColors().catch(() => {});
            if (!this.backgroundGroup) {
                this.backgroundGroup = new Clutter.Actor();
                this._gdm._dialogParent.add_child(this.backgroundGroup);
                this._gdm._dialogParent.set_child_below_sibling(this.backgroundGroup, this._gdm._dialog);
                this.bgManagers = [];
            }

            if (!this.bgManagers || this.bgManagers.length === 0) {
                for (let i = 0; i < Main.layoutManager.monitors.length; i++)
                    this.createBackground(i);
                this.updateBackgroundEffects();
                this.appliedWallpaperUser = undefined;
            }

            let resolvedUserName = requestedUserName;
            let metaFile = null;

            if (!resolvedUserName) {
                try {
                    const dir = Gio.File.new_for_path('/var/tmp');
                    if (dir.query_exists(null)) {
                        const enumerator = dir.enumerate_children(
                            'standard::name,time::modified',
                            Gio.FileQueryInfoFlags.NONE,
                            null
                        );
                        let maxMtime = 0;
                        let info;
                        while ((info = enumerator.next_file(null)) !== null) {
                            const name = info.get_name();
                            if (name.startsWith('wack-shared-wallpaper-') && name.endsWith('.json') && name !== 'wack-shared-wallpaper-gdm.json') {
                                const mtime = info.get_attribute_uint64('time::modified');
                                if (mtime > maxMtime) {
                                    maxMtime = mtime;
                                    metaFile = Gio.File.new_for_path(`/var/tmp/${name}`);
                                }
                            }
                        }
                    }
                } catch (err) {
                    _log('[WACK/GdmManager] Failed to find most recent user wallpaper: ' + err);
                }
            } else {
                metaFile = Gio.File.new_for_path(`/var/tmp/wack-shared-wallpaper-${resolvedUserName}.json`);
            }

            let metadata = null;
            if (metaFile && metaFile.query_exists(null)) {
                const [loadSuccess, contents] = metaFile.load_contents(null);
                if (loadSuccess) {
                    metadata = JSON.parse(new TextDecoder().decode(contents));
                }
                if (!resolvedUserName && metadata) {
                    resolvedUserName = metadata.username;
                }
            }

            if (!metadata) {
                const gdmMetaFile = Gio.File.new_for_path('/var/tmp/wack-shared-wallpaper-gdm.json');
                if (gdmMetaFile.query_exists(null)) {
                    try {
                        const [loadSuccess, contents] = gdmMetaFile.load_contents(null);
                        if (loadSuccess) {
                            const cachedGdmMeta = JSON.parse(new TextDecoder().decode(contents));
                            const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                            const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
                            const colorScheme = interfaceSettings.get_enum('color-scheme');
                            const currentUri = bgSettings.get_string(colorScheme === 1 ? 'picture-uri-dark' : 'picture-uri');
                            const currentStyle = bgSettings.get_enum('picture-options');
                            const currentPrimary = bgSettings.get_string('primary-color');

                            if (cachedGdmMeta &&
                                cachedGdmMeta.source_uri === currentUri &&
                                cachedGdmMeta.style === currentStyle &&
                                cachedGdmMeta.primary_color === currentPrimary) {
                                metadata = cachedGdmMeta;
                            }
                        }
                    } catch (e) {
                        _log('[WACK/GdmManager] Failed to read GDM wallpaper metadata fallback: ' + e);
                    }
                }
            }

            if (!metadata) {
                try {
                    const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                    const interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
                    const colorScheme = interfaceSettings.get_enum('color-scheme');
                    const style = bgSettings.get_enum('picture-options');
                    const uri = bgSettings.get_string(colorScheme === 1 ? 'picture-uri-dark' : 'picture-uri');
                    const primaryColor = bgSettings.get_string('primary-color');
                    const secondaryColor = bgSettings.get_string('secondary-color');
                    const shadingType = bgSettings.get_enum('color-shading-type');
                    const isColor = (style === 0);

                    metadata = {
                        username: 'gdm',
                        source_uri: uri,
                        uri: uri,
                        style: style,
                        primary_color: primaryColor,
                        secondary_color: secondaryColor,
                        shading_type: shadingType,
                        is_color: isColor,
                        clockFormat: interfaceSettings.get_string('clock-format'),
                        dateStyle: 'full',
                        clockAlpha: 0.6,
                        promptColor: null,
                        promptVibrancy: true,
                        cursorBlink: true,
                        lockscreenMode: 'cupertino',
                        lockscreenMessageText: '',
                        lockscreenMessageEnable: false,
                    };
                    this.saveGdmWallpaperMetadata(metadata);
                } catch (e) {
                    _log('[WACK/GdmManager] Failed to cook initial GDM metadata: ' + e);
                }
            }

            // Synchronously resolve active slideshow frame at this exact instant (prevents stale frame or missing /var/tmp files after hours of shutdown)
            let xmlText = metadata?.slideshow_xml_text || null;
            if (!xmlText && metadata?.source_uri && (metadata.source_uri.endsWith('.xml') || metadata.source_uri.endsWith('.xml.in'))) {
                try {
                    const srcFile = metadata.source_uri.startsWith('file://')
                        ? Gio.File.new_for_uri(metadata.source_uri)
                        : Gio.File.new_for_path(metadata.source_uri);
                    if (srcFile.query_exists(null)) {
                        const [ok, bytes] = srcFile.load_contents(null);
                        if (ok) {
                            xmlText = new TextDecoder().decode(bytes);
                        }
                    }
                } catch (_) {}
            }

            if (xmlText && !metadata?.is_color) {
                const resolved = resolveSlideshowXmlContent(xmlText, metadata?.color_scheme ?? 0);
                if (resolved?.filePath) {
                    const cachedPath = metadata.uri?.startsWith('file://') ? metadata.uri.substring(7) : metadata.uri;
                    const cachedExists = cachedPath && Gio.File.new_for_path(cachedPath).query_exists(null);

                    if (!resolved.isTransition || !cachedExists) {
                        const slideUri = resolved.filePath.startsWith('file://') ? resolved.filePath : `file://${resolved.filePath}`;
                        metadata.uri = slideUri;
                        metadata.resolved_slide_path = resolved.filePath;
                        metadata.resolved_slide_progress = resolved.isTransition ? Math.round(resolved.progress * 100) / 100 : 0.0;
                    }
                }
            } else if (metadata && !metadata.is_color) {
                const accessibleUri = resolveGdmAccessibleUri(metadata);
                if (accessibleUri) {
                    metadata.uri = accessibleUri;
                }
            }

            this.currentWallpaperMetadata = metadata;
            this._gdm._currentWallpaperMetadata = metadata;
            this._gdm._updateLockscreenMessage(metadata);
            const wallpaperSignature = this.buildWallpaperSignature(resolvedUserName, metadata);

            _log(`[WACK/GdmManager] _applyWallpaper resolved user: ${resolvedUserName}`);

            const clock = this._gdm._clockManager?.clock ?? this._gdm._gdmClock;
            if (clock) {
                if (clock.setClockFormat)
                    clock.setClockFormat(metadata?.clockFormat ?? null);
                if (clock.setDateStyle)
                    clock.setDateStyle(metadata?.dateStyle ?? 'full');
                const userLocale = this._gdm._dialog?._user?.get_language() || metadata?.userLocale || null;
                if (clock.setLocale)
                    clock.setLocale(userLocale);
            }

            let alphaPromise;
            if (metadata) {
                if (metadata.clockAlpha != null && !xmlText) {
                    alphaPromise = Promise.resolve(metadata.clockAlpha);
                } else {
                    alphaPromise = getWallpaperAlpha({
                        uri: metadata.uri,
                        isColor: metadata.is_color,
                        primaryColor: metadata.primary_color,
                        secondaryColor: metadata.secondary_color,
                        shadingType: metadata.shading_type,
                        textLuminance: 1.0,
                    });
                }
            } else {
                const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                const uri = bgSettings.get_string('picture-uri');
                const style = bgSettings.get_enum('picture-options');
                const primaryColor = bgSettings.get_string('primary-color');
                const secondaryColor = bgSettings.get_string('secondary-color');
                const shadingType = bgSettings.get_enum('color-shading-type');
                const isColor = (style === 0);

                alphaPromise = getWallpaperAlpha({
                    uri,
                    isColor,
                    primaryColor,
                    secondaryColor,
                    shadingType,
                    textLuminance: 1.0,
                });
            }

            alphaPromise.then(alpha => {
                this._gdm._lastClockAlpha = alpha;
                const activeClock = this._gdm._clockManager?.clock ?? this._gdm._gdmClock;
                if (activeClock)
                    activeClock.setWallpaperAlpha(alpha);
                if (this._gdm._promptStyling)
                    this._gdm._promptStyling.updatePromptMessageStyle(null, alpha);
            }).catch(e => {
                _log('[WACK/GdmManager] Failed to compute dynamic alpha: ' + e);
            });

            this._gdm._updateCupertinoPromptBackground(metadata).catch(e => {
                _log('[WACK/GdmManager] Failed to compute prompt background: ' + e);
            });
            this._gdm._updateBottomButtonsBackground(metadata).catch(e => {
                _log('[WACK/GdmManager] Failed to compute bottom buttons background: ' + e);
            });

            if (xmlText && !metadata?.is_color) {
                this._startSlideshowLoop(xmlText, metadata);
            } else {
                this._stopSlideshowLoop();
            }

            if (this.appliedWallpaperUser === resolvedUserName &&
                this.appliedWallpaperSignature === wallpaperSignature) {
                return;
            }

            let success = false;
            if (metadata) {
                for (const bgManager of this.bgManagers) {
                    let activeWidget = bgManager.activeIsA ? bgManager.widgetA : bgManager.widgetB;
                    let targetWidget = bgManager.activeIsA ? bgManager.widgetB : bgManager.widgetA;

                    let styleStr = '';
                    if (metadata.is_color) {
                        if (metadata.shading_type === 0) {
                            styleStr = `background-color: ${metadata.primary_color};`;
                        } else {
                            let dir = metadata.shading_type === 1 ? 'vertical' : 'horizontal';
                            styleStr = `background-gradient-direction: ${dir}; background-gradient-start: ${metadata.primary_color}; background-gradient-end: ${metadata.secondary_color};`;
                        }
                    } else {
                        let bgSize = 'cover';
                        let bgPos = 'center';
                        let bgRepeat = 'no-repeat';
                        switch (metadata.style) {
                            case 0:
                            case 2: bgSize = 'auto'; break;
                            case 3: bgSize = 'contain'; break;
                            case 4: bgSize = '100% 100%'; break;
                            case 5:
                            case 6: bgSize = 'cover'; break;
                            case 1: bgSize = 'auto'; bgRepeat = 'repeat'; bgPos = 'top left'; break;
                        }
                        styleStr = `background-image: url("${metadata.uri}"); background-size: ${bgSize}; background-position: ${bgPos}; background-repeat: ${bgRepeat};`;
                    }
                    _log(`[WACK/GdmManager] setting inline CSS background on St.Widget`);
                    targetWidget.set_style(styleStr);

                    let isFirstRun = this.appliedWallpaperUser === undefined;

                    if (isFirstRun) {
                        targetWidget.remove_transition('opacity');
                        activeWidget.remove_transition('opacity');
                        targetWidget.opacity = 255;
                        activeWidget.opacity = 0;
                    } else {
                        targetWidget.ease({
                            opacity: 255,
                            duration: GDM_CROSSFADE_DURATION,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                        activeWidget.ease({
                            opacity: 0,
                            duration: GDM_CROSSFADE_DURATION,
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        });
                    }

                    bgManager.activeIsA = !bgManager.activeIsA;
                }
                success = true;
            }

            if (!success) {
                _log(`[WACK/GdmManager] falling back to org.gnome.desktop.background settings`);
                const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
                const uri = bgSettings.get_string('picture-uri');
                const style = bgSettings.get_enum('picture-options');
                if (uri) {
                    for (const bgManager of this.bgManagers) {
                        let activeWidget = bgManager.activeIsA ? bgManager.widgetA : bgManager.widgetB;
                        let targetWidget = bgManager.activeIsA ? bgManager.widgetB : bgManager.widgetA;

                        let bgSize = 'cover';
                        let bgPos = 'center';
                        let bgRepeat = 'no-repeat';
                        switch (style) {
                            case 0:
                            case 2: bgSize = 'auto'; break;
                            case 3: bgSize = 'contain'; break;
                            case 4: bgSize = '100% 100%'; break;
                            case 5:
                            case 6: bgSize = 'cover'; break;
                            case 1: bgSize = 'auto'; bgRepeat = 'repeat'; bgPos = 'top left'; break;
                        }
                        let styleStr = `background-image: url("${uri}"); background-size: ${bgSize}; background-position: ${bgPos}; background-repeat: ${bgRepeat};`;
                        targetWidget.set_style(styleStr);

                        let isFirstRun = this.appliedWallpaperUser === undefined;

                        if (isFirstRun) {
                            targetWidget.remove_transition('opacity');
                            activeWidget.remove_transition('opacity');
                            targetWidget.opacity = 255;
                            activeWidget.opacity = 0;
                        } else {
                            targetWidget.ease({
                                opacity: 255,
                                duration: GDM_CROSSFADE_DURATION,
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                            activeWidget.ease({
                                opacity: 0,
                                duration: GDM_CROSSFADE_DURATION,
                                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            });
                        }

                        bgManager.activeIsA = !bgManager.activeIsA;
                    }
                }
            }
            this.appliedWallpaperUser = resolvedUserName;
            this.appliedWallpaperSignature = wallpaperSignature;
        } catch (e) {
            _log('[WACK/GdmManager] Failed to apply wallpaper: ' + e);
        }
    }

    _stopSlideshowLoop() {
        if (this._slideshowTimerId) {
            GLib.source_remove(this._slideshowTimerId);
            this._slideshowTimerId = null;
        }
        this._currentSlideshowSignature = null;
    }

    _cleanupOldGdmActiveFiles(keepTimestamp) {
        try {
            const dir = Gio.File.new_for_path('/var/tmp');
            if (dir.query_exists(null)) {
                const enumerator = dir.enumerate_children(
                    'standard::name',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const name = info.get_name();
                    if (name.startsWith('wack-shared-wallpaper-gdm-active-') && name.endsWith('.jpg')) {
                        const tsStr = name.replace('wack-shared-wallpaper-gdm-active-', '').replace('.jpg', '');
                        if (tsStr !== String(keepTimestamp)) {
                            try {
                                const oldFile = Gio.File.new_for_path(`/var/tmp/${name}`);
                                oldFile.delete(null);
                            } catch (_) {}
                        }
                    }
                }
            }
        } catch (_) {}
    }

    _startSlideshowLoop(xmlText, metadata) {
        this._stopSlideshowLoop();

        const colorScheme = metadata?.color_scheme ?? 0;
        const resolved = resolveSlideshowXmlContent(xmlText, colorScheme);
        if (!resolved)
            return;

        const currentProgressStep = resolved.isTransition
            ? Math.round(resolved.progress * 100) / 100
            : 0.0;
        const signature = resolved.isTransition
            ? `trans:${resolved.from}->${resolved.to}:${currentProgressStep}`
            : `static:${resolved.filePath}`;

        if (metadata?.resolved_slide_path === resolved.filePath &&
            (metadata?.resolved_slide_progress ?? 0.0) === currentProgressStep) {
            this._currentSlideshowSignature = signature;
        }

        this._runSlideshowTick(xmlText, metadata).catch(e => {
            _log('[WACK/GdmManager] Initial slideshow tick error: ' + e);
        });
    }

    async _runSlideshowTick(xmlText, metadata) {
        if (!xmlText || !this.backgroundGroup)
            return;

        const colorScheme = metadata?.color_scheme ?? 0;
        const resolved = resolveSlideshowXmlContent(xmlText, colorScheme);
        if (!resolved)
            return;

        const currentProgressStep = resolved.isTransition
            ? Math.round(resolved.progress * 100) / 100
            : 0.0;
        const signature = resolved.isTransition
            ? `trans:${resolved.from}->${resolved.to}:${currentProgressStep}`
            : `static:${resolved.filePath}`;

        if (this._currentSlideshowSignature !== signature) {
            this._currentSlideshowSignature = signature;
            await this._applySlideshowFrame(resolved, metadata);
        }

        let nextDelayMs;
        if (resolved.isTransition) {
            const stepSec = Math.max(2, Math.min(10, (resolved.duration || 60) / 64));
            nextDelayMs = Math.max(1000, Math.min(stepSec * 1000, (resolved.remainingDuration * 1000) + 100));
        } else {
            nextDelayMs = Math.max(1000, (resolved.remainingDuration * 1000) + 500);
        }

        this._slideshowTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, nextDelayMs, () => {
            this._slideshowTimerId = null;
            this._runSlideshowTick(xmlText, metadata).catch(e => {
                _log('[WACK/GdmManager] Slideshow timer tick error: ' + e);
            });
            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._slideshowTimerId, '[WACK] GdmWallpaperManager.slideshowTimer');
    }

    async _applySlideshowFrame(resolved, metadata) {
        if (!resolved || !metadata || !this.backgroundGroup)
            return;

        let targetUri = null;
        if (resolved.isTransition && resolved.from && resolved.to) {
            try {
                const fileFrom = Gio.File.new_for_path(resolved.from);
                const fileTo = Gio.File.new_for_path(resolved.to);
                if (fileFrom.query_exists(null) && fileTo.query_exists(null)) {
                    const pbFrom = GdkPixbuf.Pixbuf.new_from_file(resolved.from);
                    const pbTo = GdkPixbuf.Pixbuf.new_from_file(resolved.to);
                    const MAX_DIM = 2560;

                    const w = pbFrom.get_width();
                    const h = pbFrom.get_height();
                    let scaleW = w;
                    let scaleH = h;
                    if (w > MAX_DIM || h > MAX_DIM) {
                        if (w > h) {
                            scaleW = MAX_DIM;
                            scaleH = Math.round((h * MAX_DIM) / w);
                        } else {
                            scaleH = MAX_DIM;
                            scaleW = Math.round((w * MAX_DIM) / h);
                        }
                    }

                    const scaledFrom = (scaleW !== w || scaleH !== h)
                        ? pbFrom.scale_simple(scaleW, scaleH, GdkPixbuf.InterpType.BILINEAR)
                        : pbFrom;
                    const scaledTo = (scaleW !== pbTo.get_width() || scaleH !== pbTo.get_height())
                        ? pbTo.scale_simple(scaleW, scaleH, GdkPixbuf.InterpType.BILINEAR)
                        : pbTo;

                    const blended = blendPixbufs(scaledFrom, scaledTo, resolved.progress);
                    if (blended) {
                        const timestamp = Date.now();
                        const targetPath = `/var/tmp/wack-shared-wallpaper-gdm-active-${timestamp}.jpg`;
                        blended.savev(targetPath, 'jpeg', ['quality'], ['80']);
                        const destFile = Gio.File.new_for_path(targetPath);
                        destFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                        targetUri = `file://${targetPath}`;
                        this._cleanupOldGdmActiveFiles(timestamp);
                        _log('[WACK/GdmManager] Slideshow engine: blended active transition frame to ' + targetPath);
                    }
                }
            } catch (err) {
                _log('[WACK/GdmManager] Slideshow engine blend error: ' + err);
            }
        }

        if (!targetUri && resolved.filePath) {
            targetUri = resolved.filePath.startsWith('file://') ? resolved.filePath : `file://${resolved.filePath}`;
        }

        if (!targetUri)
            return;

        metadata.uri = targetUri;
        metadata.resolved_slide_path = resolved.filePath;
        metadata.resolved_slide_progress = resolved.isTransition
            ? Math.round(resolved.progress * 100) / 100
            : 0.0;

        for (const bgManager of this.bgManagers) {
            const activeWidget = bgManager.activeIsA ? bgManager.widgetA : bgManager.widgetB;
            const targetWidget = bgManager.activeIsA ? bgManager.widgetB : bgManager.widgetA;

            let bgSize = 'cover';
            let bgPos = 'center';
            let bgRepeat = 'no-repeat';
            switch (metadata.style) {
                case 0:
                case 2: bgSize = 'auto'; break;
                case 3: bgSize = 'contain'; break;
                case 4: bgSize = '100% 100%'; break;
                case 5:
                case 6: bgSize = 'cover'; break;
                case 1: bgSize = 'auto'; bgRepeat = 'repeat'; bgPos = 'top left'; break;
            }
            const styleStr = `background-image: url("${targetUri}"); background-size: ${bgSize}; background-position: ${bgPos}; background-repeat: ${bgRepeat};`;
            targetWidget.set_style(styleStr);

            targetWidget.ease({
                opacity: 255,
                duration: GDM_CROSSFADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            activeWidget.ease({
                opacity: 0,
                duration: GDM_CROSSFADE_DURATION,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            bgManager.activeIsA = !bgManager.activeIsA;
        }

        try {
            const alpha = await getWallpaperAlpha({
                uri: targetUri,
                isColor: false,
                primaryColor: metadata.primary_color,
                secondaryColor: metadata.secondary_color,
                shadingType: metadata.shading_type,
                textLuminance: 1.0,
            });
            this._gdm._lastClockAlpha = alpha;
            const activeClock = this._gdm._clockManager?.clock ?? this._gdm._gdmClock;
            if (activeClock)
                activeClock.setWallpaperAlpha(alpha);
            if (this._gdm._promptStyling)
                this._gdm._promptStyling.updatePromptMessageStyle(null, alpha);
        } catch (e) {
            _log('[WACK/GdmManager] Failed to compute slideshow alpha: ' + e);
        }

        try {
            const currentVibrancyMode = this._gdm._extension ? this._gdm._extension.getSettings().get_string('prompt-vibrancy') : 'tonal';
            const color = await getWallpaperPromptColor({
                uri: targetUri,
                isColor: false,
                primaryColor: metadata.primary_color,
                secondaryColor: metadata.secondary_color,
                shadingType: metadata.shading_type,
                wellH: 0,
                yCenterFraction: null,
                promptBounds: null,
                cancelBounds: null,
                avatarBounds: null,
                a11yBounds: null,
                sessionBounds: null,
                vibrancyMode: currentVibrancyMode,
            });
            if (color) {
                metadata.promptColor = color;
                metadata.promptVibrancyMode = currentVibrancyMode;
                this._gdm._updateCupertinoPromptBackground(metadata).catch(() => {});
                this._gdm._updateBottomButtonsBackground(metadata).catch(() => {});
            }
        } catch (e) {
            _log('[WACK/GdmManager] Failed to sample slideshow prompt color: ' + e);
        }
    }
}
