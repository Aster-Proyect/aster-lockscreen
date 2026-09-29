import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { CUPERTINO_PROMPT_VERTICAL_FRACTION, CUPERTINO_CHIP_VERTICAL_FRACTION } from './constants.js';
import { _logError } from './mainUtils.js';
import {
    parseHexColor,
    getApcaContrast,
    rgbToHsl,
    hslToRgb,
    PROMPT_SHADOW_FLOOR,
    resolvePromptVisualState,
    applyPromptVisualState,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
    PROMPT_VISUAL_ALGORITHM_VERSION,
} from './colorUtils.js';
import {
    resolveWallpaperSource,
    getFileMtimeAndSize,
    loadScaledWallpaperPixbuf,
    getWallpaperFileInfo,
    blendPixbufs,
} from './wallpaperUtils.js';
import { createBlurredPromptSlice, sampleRegionAverageColor } from './wallpaperSampler.js';
import {
    PROMPT_BLUR_RADIUS,
    PROMPT_BLUR_BRIGHTNESS,
    CANCEL_BUTTON_HOVER_OVERLAY_ALPHA,
    CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA,
    CANCEL_BUTTON_WIDTH,
    CANCEL_BUTTON_HEIGHT,
    CANCEL_BUTTON_X_OFFSET,
    CANCEL_BUTTON_Y_OFFSET,
    AVATAR_BUTTON_WIDTH,
    AVATAR_BUTTON_HEIGHT,
    AVATAR_BUTTON_X_OFFSET,
    AVATAR_BUTTON_Y_OFFSET,
    A11Y_BUTTON_WIDTH,
    A11Y_BUTTON_HEIGHT,
    A11Y_BUTTON_X_OFFSET,
    A11Y_BUTTON_Y_OFFSET,
    SESSION_BUTTON_WIDTH,
    SESSION_BUTTON_HEIGHT,
    SESSION_BUTTON_X_OFFSET,
    SESSION_BUTTON_Y_OFFSET,
} from './constants.js';
import {
    initCache,
    saveCache,
    clearCache as clearPersistentCache,
    flushAllCache,
    getCache,
    setCache,
    hasCache,
    scheduleVibrancyPruning,
    ensureCacheDirectory,
    CacheMetrics,
} from './alphaCache.js';
import {
    createClockAlphaIdentity,
    serializeClockAlphaIdentity,
    createPromptVibrancyIdentity,
    serializePromptVibrancyIdentity,
    formatBoundsKey,
    computeSliceHash,
    resolveSlicePath,
} from './cacheIdentity.js';

export { initCache, flushAllCache };

let _bgSettings = null;
const _inFlightAlphaQueries = new Map();
const _inFlightPromptQueries = new Map();

function getBgSettings() {
    if (!_bgSettings)
        _bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
    return _bgSettings;
}

export function clearCache() {
    clearPersistentCache();
    _inFlightAlphaQueries.clear();
    _inFlightPromptQueries.clear();
    _bgSettings = null;
}

/**
 * Calculates the ideal clock opacity (alpha) based on the background color/wallpaper behind it.
 * Uses single-flight request coalescing to prevent redundant parallel calculations.
 *
 * @param {Object} params
 * @returns {Promise<number>}
 */
export async function getWallpaperAlpha(params) {
    const {
        uri,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        textLuminance = 1.0,
    } = params;

    await initCache();

    const { targetUri, targetFilePath, transitionInfo } = await resolveWallpaperSource(uri);
    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const identity = createClockAlphaIdentity({
        targetUri,
        mtime,
        size,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        textLuminance,
        transitionInfo,
    });
    const cacheKey = serializeClockAlphaIdentity(identity);

    if (hasCache(cacheKey))
        return getCache(cacheKey);

    // Single-flight coalescing: await an identical in-flight query if active
    if (_inFlightAlphaQueries.has(cacheKey)) {
        CacheMetrics.coalescedRequests++;
        return _inFlightAlphaQueries.get(cacheKey);
    }

    const queryPromise = (async () => {
        let bgR = 40, bgG = 40, bgB = 40; // Dark grey default fallback
        let bgNoise = 0.0;

        if (isColor) {
            const c1 = parseHexColor(primaryColor);
            const c2 = parseHexColor(secondaryColor);
            if (shadingType === 0) {
                bgR = c1.r;
                bgG = c1.g;
                bgB = c1.b;
            } else if (shadingType === 1) {
                // Upper third average is roughly 17.5% of the transition from color1 to color2
                bgR = c1.r + (c2.r - c1.r) * 0.175;
                bgG = c1.g + (c2.g - c1.g) * 0.175;
                bgB = c1.b + (c2.b - c1.b) * 0.175;
            } else {
                // Horizontal gradient average across the screen
                bgR = (c1.r + c2.r) / 2;
                bgG = (c1.g + c2.g) / 2;
                bgB = (c1.b + c2.b) / 2;
            }
        } else if (targetFilePath) {
            try {
                let pixbuf;
                if (transitionInfo?.isTransition && transitionInfo.from && transitionInfo.to) {
                    const [pbFrom, pbTo] = await Promise.all([
                        loadScaledWallpaperPixbuf(transitionInfo.from, 256, 256, true),
                        loadScaledWallpaperPixbuf(transitionInfo.to, 256, 256, true),
                    ]);
                    pixbuf = blendPixbufs(pbFrom, pbTo, transitionInfo.progress);
                } else {
                    pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, 256, 256, true);
                }

                const pbWidth = pixbuf.get_width();
                const pbHeight = pixbuf.get_height();
                const pixels = pixbuf.get_pixels();
                const channels = pixbuf.get_n_channels();
                const rowstride = pixbuf.get_rowstride();

                const bgSettings = getBgSettings();
                const pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';

                const monitor = Main.layoutManager?.primaryMonitor || { width: 1920, height: 1080 };
                const monitorWidth = monitor.width;
                const monitorHeight = monitor.height;
                const monitorAspect = monitorWidth / monitorHeight;
                const pbAspect = pbWidth / pbHeight;

                let visibleX = 0, visibleY = 0, visibleW = pbWidth, visibleH = pbHeight;

                if (pictureOptions === 'zoom' || pictureOptions === 'spanned') {
                    if (pbAspect > monitorAspect) {
                        visibleW = pbHeight * monitorAspect;
                        visibleX = (pbWidth - visibleW) / 2;
                    } else if (pbAspect < monitorAspect) {
                        visibleH = pbWidth / monitorAspect;
                        visibleY = (pbHeight - visibleH) / 2;
                    }
                }

                const xStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * 0.25)));
                const xEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * 0.75)));
                const yStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * 0.05)));
                const yEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * 0.35)));

                let rSum = 0, gSum = 0, bSum = 0;
                let diffSum = 0;
                let count = 0;
                let diffCount = 0;

                for (let y = yStart; y < yEnd; y++) {
                    for (let x = xStart; x < xEnd; x++) {
                        const offset = y * rowstride + x * channels;
                        const r = pixels[offset];
                        const g = pixels[offset + 1];
                        const b = pixels[offset + 2];

                        rSum += r;
                        gSum += g;
                        bSum += b;
                        count++;

                        if (x < xEnd - 1 && y < yEnd - 1) {
                            const offsetRight = y * rowstride + (x + 1) * channels;
                            const offsetDown = (y + 1) * rowstride + x * channels;

                            const rR = pixels[offsetRight], gR = pixels[offsetRight + 1], bR = pixels[offsetRight + 2];
                            const rD = pixels[offsetDown], gD = pixels[offsetDown + 1], bD = pixels[offsetDown + 2];

                            const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
                            const lumR = (0.2126 * rR + 0.7152 * gR + 0.0722 * bR) / 255.0;
                            const lumD = (0.2126 * rD + 0.7152 * gD + 0.0722 * bD) / 255.0;

                            diffSum += (Math.abs(lum - lumR) + Math.abs(lum - lumD)) / 2.0;
                            diffCount++;
                        }
                    }
                }

                if (count > 0) {
                    bgR = rSum / count;
                    bgG = gSum / count;
                    bgB = bSum / count;
                }

                if (diffCount > 0) {
                    bgNoise = diffSum / diffCount;
                }
            } catch (e) {
                _logError(`[WACK/AlphaManager] Failed to read/scale wallpaper for luminance: ${e}`);
            }
        }

        const contrastLc = getApcaContrast(255, 255, 255, bgR, bgG, bgB);
        const absLc = Math.abs(contrastLc);
        const contrastFactor = Math.max(0, Math.min(1, (60.0 - absLc) / 40.0));

        const maxVal = Math.max(bgR, bgG, bgB);
        const minVal = Math.min(bgR, bgG, bgB);
        const chroma = (maxVal - minVal) / 255.0;
        let factor = contrastFactor * (1.0 - 0.5 * chroma);

        if (bgNoise > 0.0) {
            const bgLuminance = (0.2126 * bgR + 0.7152 * bgG + 0.0722 * bgB) / 255.0;
            const noiseScale = Math.min(1.0, 0.4 + 0.6 * (bgLuminance / 0.35));
            const noiseFactor = Math.min(1.0, bgNoise * 25.0) * noiseScale;
            factor = Math.max(factor, noiseFactor);
        }

        const alpha = 0.6 + (0.25 * factor);

        setCache(cacheKey, alpha);
        saveCache();
        return alpha;
    })();

    _inFlightAlphaQueries.set(cacheKey, queryPromise);
    try {
        return await queryPromise;
    } finally {
        _inFlightAlphaQueries.delete(cacheKey);
    }
}

/**
 * Samples the wallpaper behind the Cupertino password prompt and resolves an
 * opaque chip color. Coalesces concurrent identical calculations and schedules
 * background disk pruning without blocking the Clutter UI thread.
 *
 * @param {Object} params
 * @returns {Promise<{r: number, g: number, b: number}>}
 */
export async function getWallpaperPromptColor(params) {
    const {
        uri,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        wellH = 0,
        yCenterFraction = null,
        promptBounds = null,
        cancelBounds = null,
        avatarBounds = null,
        a11yBounds = null,
        sessionBounds = null,
        vibrancyMode = 'tonal',
    } = params;

    await initCache();

    const { targetUri, targetFilePath, transitionInfo, isXml, xmlName } = await resolveWallpaperSource(uri);
    let pictureOptions = params.pictureOptions;
    if (typeof pictureOptions === 'number') {
        const styleMap = {
            0: 'none',
            1: 'wallpaper',
            2: 'centered',
            3: 'scaled',
            4: 'stretched',
            5: 'zoom',
            6: 'spanned',
        };
        pictureOptions = styleMap[pictureOptions] || 'zoom';
    } else if (!pictureOptions) {
        const bgSettings = getBgSettings();
        pictureOptions = bgSettings ? bgSettings.get_string('picture-options') : 'zoom';
    }

    const monitor = Main.layoutManager?.primaryMonitor;
    const monitorWidth = monitor ? monitor.width : 1920;
    const monitorHeight = monitor ? monitor.height : 1080;

    let normX1, normX2, normY1, normY2;
    if (promptBounds &&
        promptBounds.x1 != null &&
        promptBounds.x2 != null &&
        promptBounds.x2 > promptBounds.x1 &&
        promptBounds.y1 != null &&
        promptBounds.y2 != null &&
        promptBounds.y2 > promptBounds.y1 &&
        promptBounds.x1 >= 0 &&
        promptBounds.x2 <= 1 &&
        promptBounds.y1 >= 0 &&
        promptBounds.y2 <= 1) {
        normX1 = promptBounds.x1;
        normX2 = promptBounds.x2;
        normY1 = promptBounds.y1;
        normY2 = promptBounds.y2;
    } else {
        const halfW = (promptBounds?.x2 && promptBounds?.x1)
            ? (promptBounds.x2 - promptBounds.x1) / 2
            : (170 / monitorWidth) / 2;
        normX1 = Math.max(0, 0.50 - halfW);
        normX2 = Math.min(1, 0.50 + halfW);
        const halfH = 18 / monitorHeight;
        const targetY = (yCenterFraction != null && yCenterFraction > 0 && yCenterFraction < 1)
            ? yCenterFraction
            : (CUPERTINO_CHIP_VERTICAL_FRACTION ?? 0.9025);
        normY1 = Math.max(0, targetY - halfH);
        normY2 = Math.min(1, targetY + halfH);
    }

    // Cancel button bounds
    let normCancelX1, normCancelX2, normCancelY1, normCancelY2;
    const offsetX = CANCEL_BUTTON_X_OFFSET / monitorWidth;
    const offsetY = CANCEL_BUTTON_Y_OFFSET / monitorHeight;
    const btnHalfW = (CANCEL_BUTTON_WIDTH / 2) / monitorWidth;
    const btnHalfH = (CANCEL_BUTTON_HEIGHT / 2) / monitorHeight;

    if (cancelBounds &&
        cancelBounds.x1 != null && cancelBounds.x2 != null &&
        cancelBounds.x2 > cancelBounds.x1) {
        normCancelX1 = Math.max(0, Math.min(1, cancelBounds.x1 + offsetX));
        normCancelX2 = Math.max(0, Math.min(1, cancelBounds.x2 + offsetX));
        normCancelY1 = Math.max(0, Math.min(1, cancelBounds.y1 + offsetY));
        normCancelY2 = Math.max(0, Math.min(1, cancelBounds.y2 + offsetY));
    } else {
        const baseCenterX = normX1 - (12 / monitorWidth) - btnHalfW;
        const baseCenterY = (normY1 + normY2) / 2;
        const centerX = baseCenterX + offsetX;
        const centerY = baseCenterY + offsetY;
        normCancelX1 = Math.max(0, Math.min(1, centerX - btnHalfW));
        normCancelX2 = Math.max(0, Math.min(1, centerX + btnHalfW));
        normCancelY1 = Math.max(0, Math.min(1, centerY - btnHalfH));
        normCancelY2 = Math.max(0, Math.min(1, centerY + btnHalfH));
    }

    // Avatar bounds
    let normAvatarX1, normAvatarX2, normAvatarY1, normAvatarY2;
    const avOffsetX = AVATAR_BUTTON_X_OFFSET / monitorWidth;
    const avOffsetY = AVATAR_BUTTON_Y_OFFSET / monitorHeight;
    const avatarHalfW = (AVATAR_BUTTON_WIDTH / 2) / monitorWidth;
    const avatarHalfH = (AVATAR_BUTTON_HEIGHT / 2) / monitorHeight;

    if (avatarBounds &&
        avatarBounds.x1 != null && avatarBounds.x2 != null &&
        avatarBounds.x2 > avatarBounds.x1) {
        normAvatarX1 = Math.max(0, Math.min(1, avatarBounds.x1 + avOffsetX));
        normAvatarX2 = Math.max(0, Math.min(1, avatarBounds.x2 + avOffsetX));
        normAvatarY1 = Math.max(0, Math.min(1, avatarBounds.y1 + avOffsetY));
        normAvatarY2 = Math.max(0, Math.min(1, avatarBounds.y2 + avOffsetY));
    } else {
        normAvatarX1 = Math.max(0, 0.50 - avatarHalfW + avOffsetX);
        normAvatarX2 = Math.min(1, 0.50 + avatarHalfW + avOffsetX);
        const anchorH = wellH > 0 ? Math.floor(wellH * 1.3) : 108;
        const targetStackY = Math.floor(monitorHeight * CUPERTINO_PROMPT_VERTICAL_FRACTION) - anchorH;
        normAvatarY1 = Math.max(0, (targetStackY / monitorHeight) + avOffsetY);
        normAvatarY2 = Math.min(1, ((targetStackY + AVATAR_BUTTON_HEIGHT) / monitorHeight) + avOffsetY);
    }

    // A11y button bounds
    let normA11yX1, normA11yX2, normA11yY1, normA11yY2;
    const a11yHalfW = (A11Y_BUTTON_WIDTH / 2) / monitorWidth;
    const a11yHalfH = (A11Y_BUTTON_HEIGHT / 2) / monitorHeight;

    if (a11yBounds &&
        a11yBounds.x1 != null && a11yBounds.x2 != null &&
        a11yBounds.x2 > a11yBounds.x1 &&
        a11yBounds.y1 != null && a11yBounds.y2 != null &&
        a11yBounds.y2 > a11yBounds.y1) {
        normA11yX1 = Math.max(0, Math.min(1, a11yBounds.x1));
        normA11yX2 = Math.max(0, Math.min(1, a11yBounds.x2));
        normA11yY1 = Math.max(0, Math.min(1, a11yBounds.y1));
        normA11yY2 = Math.max(0, Math.min(1, a11yBounds.y2));
    } else {
        const a11yOffsetX = A11Y_BUTTON_X_OFFSET / monitorWidth;
        const a11yOffsetY = A11Y_BUTTON_Y_OFFSET / monitorHeight;
        const fallbackA11yCenterX = 1.0 - (24 + A11Y_BUTTON_WIDTH / 2) / monitorWidth + a11yOffsetX;
        const fallbackA11yCenterY = 1.0 - (24 + A11Y_BUTTON_HEIGHT / 2) / monitorHeight + a11yOffsetY;
        normA11yX1 = Math.max(0, Math.min(1, fallbackA11yCenterX - a11yHalfW));
        normA11yX2 = Math.max(0, Math.min(1, fallbackA11yCenterX + a11yHalfW));
        normA11yY1 = Math.max(0, Math.min(1, fallbackA11yCenterY - a11yHalfH));
        normA11yY2 = Math.max(0, Math.min(1, fallbackA11yCenterY + a11yHalfH));
    }

    // Session button bounds
    let normSessionX1, normSessionX2, normSessionY1, normSessionY2;
    const sessionHalfW = (SESSION_BUTTON_WIDTH / 2) / monitorWidth;
    const sessionHalfH = (SESSION_BUTTON_HEIGHT / 2) / monitorHeight;

    if (sessionBounds &&
        sessionBounds.x1 != null && sessionBounds.x2 != null &&
        sessionBounds.x2 > sessionBounds.x1 &&
        sessionBounds.y1 != null && sessionBounds.y2 != null &&
        sessionBounds.y2 > sessionBounds.y1) {
        normSessionX1 = Math.max(0, Math.min(1, sessionBounds.x1));
        normSessionX2 = Math.max(0, Math.min(1, sessionBounds.x2));
        normSessionY1 = Math.max(0, Math.min(1, sessionBounds.y1));
        normSessionY2 = Math.max(0, Math.min(1, sessionBounds.y2));
    } else {
        const sessionOffsetX = SESSION_BUTTON_X_OFFSET / monitorWidth;
        const sessionOffsetY = SESSION_BUTTON_Y_OFFSET / monitorHeight;
        const fallbackSessionCenterX = 1.0 - (24 + A11Y_BUTTON_WIDTH + 12 + SESSION_BUTTON_WIDTH / 2) / monitorWidth + sessionOffsetX;
        const fallbackSessionCenterY = 1.0 - (24 + SESSION_BUTTON_HEIGHT / 2) / monitorHeight + sessionOffsetY;
        normSessionX1 = Math.max(0, Math.min(1, fallbackSessionCenterX - sessionHalfW));
        normSessionX2 = Math.max(0, Math.min(1, fallbackSessionCenterX + sessionHalfW));
        normSessionY1 = Math.max(0, Math.min(1, fallbackSessionCenterY - sessionHalfH));
        normSessionY2 = Math.max(0, Math.min(1, fallbackSessionCenterY + sessionHalfH));
    }

    const { mtime, size } = await getFileMtimeAndSize(targetFilePath);

    const boundsKey = formatBoundsKey(normX1, normX2, normY1, normY2);
    const cancelBoundsKey = formatBoundsKey(normCancelX1, normCancelX2, normCancelY1, normCancelY2);
    const avatarBoundsKey = formatBoundsKey(normAvatarX1, normAvatarX2, normAvatarY1, normAvatarY2);
    const a11yBoundsKey = formatBoundsKey(normA11yX1, normA11yX2, normA11yY1, normA11yY2);
    const sessionBoundsKey = formatBoundsKey(normSessionX1, normSessionX2, normSessionY1, normSessionY2);

    const identity = createPromptVibrancyIdentity({
        targetUri,
        mtime,
        size,
        isColor,
        primaryColor,
        secondaryColor,
        shadingType,
        pictureOptions,
        monitorWidth,
        monitorHeight,
        boundsKey,
        cancelBoundsKey,
        avatarBoundsKey,
        a11yBoundsKey,
        sessionBoundsKey,
        blurRadius: PROMPT_BLUR_RADIUS,
        blurBrightness: PROMPT_BLUR_BRIGHTNESS,
        cancelHoverAlpha: CANCEL_BUTTON_HOVER_OVERLAY_ALPHA,
        cancelActiveAlpha: CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA,
        algorithmVersion: PROMPT_VISUAL_ALGORITHM_VERSION,
        vibrancyMode,
        transitionInfo,
    });
    const cacheKey = serializePromptVibrancyIdentity(identity);

    if (hasCache(cacheKey)) {
        const cached = getCache(cacheKey);
        if (cached && cached.start && cached.end && cached.visualState?.overlay) {
            const hasAvatar = !!cached.avatarColor;
            const hasA11y = !!cached.a11yColor;
            const hasSession = !!cached.sessionColor;
            const hasCancel = !!cached.cancelColor;
            if (vibrancyMode === 'tonal' || vibrancyMode === 'less') {
                if (cached.r != null && hasAvatar && hasA11y && hasSession && hasCancel)
                    return { ...cached, transitionInfo: transitionInfo ?? null };
            } else {
                const hasPromptImg = cached.imagePath && Gio.File.new_for_path(cached.imagePath).query_exists(null);
                if (hasPromptImg && hasAvatar && hasA11y && hasSession && hasCancel)
                    return { ...cached, transitionInfo: transitionInfo ?? null };
            }
        }
    }

    // Single-flight coalescing: await an identical in-flight query if active
    if (_inFlightPromptQueries.has(cacheKey)) {
        CacheMetrics.coalescedRequests++;
        return _inFlightPromptQueries.get(cacheKey);
    }

    const queryPromise = (async () => {
        let sampledStart = null;
        let sampledEnd = null;
        let sampledPrimary = null;
        let promptVisualState = null;
        let sampledCancelColor = null;
        let sampledAvatarColor = null;
        let sampledA11yColor = null;
        let sampledSessionColor = null;
        let direction = 'vertical';
        let imagePath = null;
        let shadowAlpha = undefined;

        if (isColor) {
            const c1 = parseHexColor(primaryColor);
            const c2 = parseHexColor(secondaryColor);

            if (shadingType === 0) {
                const hsl = rgbToHsl(c1.r, c1.g, c1.b);
                const specularL = Math.min(1.0, hsl.l + 0.05);
                sampledStart = hslToRgb(hsl.h, hsl.s, specularL);
                sampledEnd = { ...c1 };
                sampledPrimary = { ...c1 };
            } else if (shadingType === 1) {
                const y1 = normY1;
                const y2 = normY2;
                const yt = (normY1 + normY2) / 2;
                sampledStart = {
                    r: Math.round(c1.r + (c2.r - c1.r) * y1),
                    g: Math.round(c1.g + (c2.g - c1.g) * y1),
                    b: Math.round(c1.b + (c2.b - c1.b) * y1),
                };
                sampledEnd = {
                    r: Math.round(c1.r + (c2.r - c1.r) * y2),
                    g: Math.round(c1.g + (c2.g - c1.g) * y2),
                    b: Math.round(c1.b + (c2.b - c1.b) * y2),
                };
                sampledPrimary = {
                    r: Math.round(c1.r + (c2.r - c1.r) * yt),
                    g: Math.round(c1.g + (c2.g - c1.g) * yt),
                    b: Math.round(c1.b + (c2.b - c1.b) * yt),
                };
            } else {
                direction = 'horizontal';
                const x1 = normX1;
                const x2 = normX2;
                const xt = (normX1 + normX2) / 2;
                sampledStart = {
                    r: Math.round(c1.r + (c2.r - c1.r) * x1),
                    g: Math.round(c1.g + (c2.g - c1.g) * x1),
                    b: Math.round(c1.b + (c2.b - c1.b) * x1),
                };
                sampledEnd = {
                    r: Math.round(c1.r + (c2.r - c1.r) * x2),
                    g: Math.round(c1.g + (c2.g - c1.g) * x2),
                    b: Math.round(c1.b + (c2.b - c1.b) * x2),
                };
                sampledPrimary = {
                    r: Math.round(c1.r + (c2.r - c1.r) * xt),
                    g: Math.round(c1.g + (c2.g - c1.g) * xt),
                    b: Math.round(c1.b + (c2.b - c1.b) * xt),
                };
            }

            promptVisualState = resolvePromptVisualState(sampledPrimary, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
            shadowAlpha = promptVisualState.shadowAlpha;
            sampledStart = applyPromptVisualState(sampledStart, promptVisualState, { preblend: true });
            sampledEnd = applyPromptVisualState(sampledEnd, promptVisualState, { preblend: true });
            sampledPrimary = applyPromptVisualState(sampledPrimary, promptVisualState, { preblend: true });
            sampledAvatarColor = applyPromptVisualState(
                { r: sampledPrimary.rawR, g: sampledPrimary.rawG, b: sampledPrimary.rawB },
                promptVisualState,
                { preblend: true }
            );

            let rawCancel;
            let rawA11y;
            let rawSession;
            if (shadingType === 0) {
                rawCancel = { ...c1 };
                rawA11y = { ...c1 };
                rawSession = { ...c1 };
            } else if (shadingType === 1) {
                const ytCancel = (normCancelY1 + normCancelY2) / 2;
                rawCancel = {
                    r: Math.round(c1.r + (c2.r - c1.r) * ytCancel),
                    g: Math.round(c1.g + (c2.g - c1.g) * ytCancel),
                    b: Math.round(c1.b + (c2.b - c1.b) * ytCancel),
                };
                const ytA11y = (normA11yY1 + normA11yY2) / 2;
                rawA11y = {
                    r: Math.round(c1.r + (c2.r - c1.r) * ytA11y),
                    g: Math.round(c1.g + (c2.g - c1.g) * ytA11y),
                    b: Math.round(c1.b + (c2.b - c1.b) * ytA11y),
                };
                const ytSess = (normSessionY1 + normSessionY2) / 2;
                rawSession = {
                    r: Math.round(c1.r + (c2.r - c1.r) * ytSess),
                    g: Math.round(c1.g + (c2.g - c1.g) * ytSess),
                    b: Math.round(c1.b + (c2.b - c1.b) * ytSess),
                };
            } else {
                const xtCancel = (normCancelX1 + normCancelX2) / 2;
                rawCancel = {
                    r: Math.round(c1.r + (c2.r - c1.r) * xtCancel),
                    g: Math.round(c1.g + (c2.g - c1.g) * xtCancel),
                    b: Math.round(c1.b + (c2.b - c1.b) * xtCancel),
                };
                const xtA11y = (normA11yX1 + normA11yX2) / 2;
                rawA11y = {
                    r: Math.round(c1.r + (c2.r - c1.r) * xtA11y),
                    g: Math.round(c1.g + (c2.g - c1.g) * xtA11y),
                    b: Math.round(c1.b + (c2.b - c1.b) * xtA11y),
                };
                const xtSess = (normSessionX1 + normSessionX2) / 2;
                rawSession = {
                    r: Math.round(c1.r + (c2.r - c1.r) * xtSess),
                    g: Math.round(c1.g + (c2.g - c1.g) * xtSess),
                    b: Math.round(c1.b + (c2.b - c1.b) * xtSess),
                };
            }

            sampledCancelColor = applyPromptVisualState(
                rawCancel,
                promptVisualState,
                { preblend: true }
            );
            sampledA11yColor = applyPromptVisualState(
                rawA11y,
                resolvePromptVisualState(rawA11y, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
            sampledSessionColor = applyPromptVisualState(
                rawSession,
                resolvePromptVisualState(rawSession, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        } else if (targetFilePath) {
            try {
                const fileInfo = await getWallpaperFileInfo(targetFilePath);
                let targetW = monitorWidth;
                let targetH = monitorHeight;
                if (fileInfo && fileInfo.width > 0 && fileInfo.height > 0) {
                    const origW = fileInfo.width;
                    const origH = fileInfo.height;
                    if (pictureOptions === 'stretched') {
                        targetW = monitorWidth;
                        targetH = monitorHeight;
                    } else if (pictureOptions === 'scaled') {
                        const scale = Math.min(monitorWidth / origW, monitorHeight / origH);
                        targetW = Math.max(1, Math.round(origW * scale));
                        targetH = Math.max(1, Math.round(origH * scale));
                    } else {
                        // zoom / spanned / default: cover
                        const scale = Math.max(monitorWidth / origW, monitorHeight / origH);
                        targetW = Math.max(1, Math.round(origW * scale));
                        targetH = Math.max(1, Math.round(origH * scale));
                    }
                }

                let pixbuf;
                if (transitionInfo?.isTransition && transitionInfo.from && transitionInfo.to) {
                    const [pbFrom, pbTo] = await Promise.all([
                        loadScaledWallpaperPixbuf(transitionInfo.from, targetW, targetH, false),
                        loadScaledWallpaperPixbuf(transitionInfo.to, targetW, targetH, false),
                    ]);
                    pixbuf = blendPixbufs(pbFrom, pbTo, transitionInfo.progress);
                } else {
                    pixbuf = await loadScaledWallpaperPixbuf(targetFilePath, targetW, targetH, false);
                }

                const pbWidth = pixbuf.get_width();
                const pbHeight = pixbuf.get_height();
                const monitorAspect = monitorWidth / monitorHeight;
                const pbAspect = pbWidth / pbHeight;

                let visibleX = 0, visibleY = 0, visibleW = pbWidth, visibleH = pbHeight;
                if (pictureOptions === 'zoom' || pictureOptions === 'spanned') {
                    if (pbAspect > monitorAspect) {
                        visibleW = pbHeight * monitorAspect;
                        visibleX = (pbWidth - visibleW) / 2;
                    } else if (pbAspect < monitorAspect) {
                        visibleH = pbWidth / monitorAspect;
                        visibleY = (pbHeight - visibleH) / 2;
                    }
                } else if (pictureOptions === 'scaled') {
                    if (pbAspect > monitorAspect) {
                        visibleH = pbWidth / monitorAspect;
                        visibleY = (pbHeight - visibleH) / 2;
                    } else if (pbAspect < monitorAspect) {
                        visibleW = pbHeight * monitorAspect;
                        visibleX = (pbWidth - visibleW) / 2;
                    }
                }

                const xStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normX1)));
                const xEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normX2)));
                const yStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normY1)));
                const yEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normY2)));

                const mappedBounds = {
                    x1: xStart / pbWidth,
                    x2: xEnd / pbWidth,
                    y1: yStart / pbHeight,
                    y2: yEnd / pbHeight,
                };

                if (vibrancyMode === 'tonal' || vibrancyMode === 'less') {
                    const sampled = sampleRegionAverageColor(pixbuf, mappedBounds) || { r: 40, g: 40, b: 40 };
                    promptVisualState = resolvePromptVisualState(sampled, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
                    sampledPrimary = applyPromptVisualState(sampled, promptVisualState, { preblend: true });
                    sampledStart = sampledPrimary;
                    sampledEnd = sampledPrimary;
                    direction = 'none';

                    shadowAlpha = promptVisualState.shadowAlpha ?? PROMPT_SHADOW_FLOOR;

                    const cxStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normCancelX1)));
                    const cxEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normCancelX2)));
                    const cyStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normCancelY1)));
                    const cyEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normCancelY2)));

                    const cancelMappedBounds = {
                        x1: cxStart / pbWidth,
                        x2: cxEnd / pbWidth,
                        y1: cyStart / pbHeight,
                        y2: cyEnd / pbHeight,
                    };
                    const rawCancel = sampleRegionAverageColor(pixbuf, cancelMappedBounds) || sampled || { r: 40, g: 40, b: 40 };
                    sampledCancelColor = applyPromptVisualState(
                        rawCancel,
                        promptVisualState,
                        { preblend: true }
                    );
                } else {
                    const userName = GLib.get_user_name();
                    const hash = computeSliceHash(cacheKey);
                    const { targetDir, filePath } = resolveSlicePath(userName, hash, isXml, xmlName);

                    ensureCacheDirectory(targetDir);

                    const actualCropW = Math.max(1, xEnd - xStart);
                    const actualCropH = Math.max(1, yEnd - yStart);
                    const targetDestH = 40;
                    const targetDestW = Math.max(1, Math.round(targetDestH * (actualCropW / actualCropH)));
                    const sliceResult = createBlurredPromptSlice(pixbuf, mappedBounds, targetDestW, targetDestH, PROMPT_BLUR_RADIUS, PROMPT_BLUR_BRIGHTNESS);
                    if (sliceResult?.pixbuf) {
                        try {
                            const tmpPath = `${filePath}.tmp.${GLib.random_int()}`;
                            sliceResult.pixbuf.savev(tmpPath, 'png', [], []);
                            const tmpFile = Gio.File.new_for_path(tmpPath);
                            tmpFile.set_attribute_uint32('unix::mode', 0o644, Gio.FileQueryInfoFlags.NONE, null);
                            const destFile = Gio.File.new_for_path(filePath);
                            tmpFile.move(destFile, Gio.FileCopyFlags.OVERWRITE, null, null);

                            imagePath = filePath;
                            shadowAlpha = sliceResult.shadowAlpha;
                            sampledPrimary = sliceResult.avgColor;
                            sampledStart = sliceResult.avgColor;
                            sampledEnd = sliceResult.avgColor;
                            direction = 'none';
                            promptVisualState = sliceResult.visualState
                                ?? resolvePromptVisualState(sliceResult.avgColor, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);

                            // Schedule asynchronous background pruning
                            scheduleVibrancyPruning(targetDir, hash);
                        } catch (saveErr) {
                            _logError(`[WACK/AlphaManager] Failed to save blurred prompt slice: ${saveErr}`);
                        }
                    }

                    // Sample dedicated color for cancel button
                    const cxStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normCancelX1)));
                    const cxEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normCancelX2)));
                    const cyStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normCancelY1)));
                    const cyEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normCancelY2)));

                    const cancelMappedBounds = {
                        x1: cxStart / pbWidth,
                        x2: cxEnd / pbWidth,
                        y1: cyStart / pbHeight,
                        y2: cyEnd / pbHeight,
                    };

                    const rawCancelColor = sampleRegionAverageColor(pixbuf, cancelMappedBounds) || sampledPrimary || { r: 40, g: 40, b: 40 };
                    sampledCancelColor = applyPromptVisualState(rawCancelColor, promptVisualState, { preblend: true });
                }

                // Decoupled chrome sampling (avatar, a11y, session)
                const avXStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normAvatarX1)));
                const avXEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normAvatarX2)));
                const avYStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normAvatarY1)));
                const avYEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normAvatarY2)));

                const avatarMappedBounds = {
                    x1: avXStart / pbWidth,
                    x2: avXEnd / pbWidth,
                    y1: avYStart / pbHeight,
                    y2: avYEnd / pbHeight,
                };

                const rawAvatarColor = sampleRegionAverageColor(pixbuf, avatarMappedBounds) || sampledPrimary || { r: 40, g: 40, b: 40 };
                if (!promptVisualState) {
                    promptVisualState = resolvePromptVisualState(
                        sampledPrimary || rawAvatarColor,
                        CUPERTINO_PROMPT_WHITE_BLEND_ALPHA
                    );
                }
                sampledAvatarColor = applyPromptVisualState(rawAvatarColor, promptVisualState, { preblend: true });

                const a11yXStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normA11yX1)));
                const a11yXEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normA11yX2)));
                const a11yYStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normA11yY1)));
                const a11yYEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normA11yY2)));

                const a11yMappedBounds = {
                    x1: a11yXStart / pbWidth,
                    x2: a11yXEnd / pbWidth,
                    y1: a11yYStart / pbHeight,
                    y2: a11yYEnd / pbHeight,
                };

                const rawA11yColor = sampleRegionAverageColor(pixbuf, a11yMappedBounds) || sampledPrimary || { r: 40, g: 40, b: 40 };
                sampledA11yColor = applyPromptVisualState(
                    rawA11yColor,
                    resolvePromptVisualState(rawA11yColor, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                    { preblend: true }
                );

                const sessionXStart = Math.max(0, Math.min(pbWidth - 1, Math.round(visibleX + visibleW * normSessionX1)));
                const sessionXEnd = Math.max(1, Math.min(pbWidth, Math.round(visibleX + visibleW * normSessionX2)));
                const sessionYStart = Math.max(0, Math.min(pbHeight - 1, Math.round(visibleY + visibleH * normSessionY1)));
                const sessionYEnd = Math.max(1, Math.min(pbHeight, Math.round(visibleY + visibleH * normSessionY2)));

                const sessionMappedBounds = {
                    x1: sessionXStart / pbWidth,
                    x2: sessionXEnd / pbWidth,
                    y1: sessionYStart / pbHeight,
                    y2: sessionYEnd / pbHeight,
                };

                const rawSessionColor = sampleRegionAverageColor(pixbuf, sessionMappedBounds) || sampledPrimary || { r: 40, g: 40, b: 40 };
                sampledSessionColor = applyPromptVisualState(
                    rawSessionColor,
                    resolvePromptVisualState(rawSessionColor, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                    { preblend: true }
                );
            } catch (e) {
                _logError(`[WACK/AlphaManager] Failed to sample wallpaper for prompt color: ${e}`);
            }
        }

        if (!sampledPrimary) {
            const fallback = { r: 40, g: 40, b: 40 };
            sampledPrimary = fallback;
            sampledStart = fallback;
            sampledEnd = fallback;
        }

        if (!sampledCancelColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledCancelColor = applyPromptVisualState(
                raw,
                promptVisualState ?? resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (!sampledAvatarColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledAvatarColor = applyPromptVisualState(
                raw,
                promptVisualState ?? resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (!sampledA11yColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledA11yColor = applyPromptVisualState(
                raw,
                resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (!sampledSessionColor) {
            const raw = sampledPrimary || { r: 40, g: 40, b: 40 };
            sampledSessionColor = applyPromptVisualState(
                raw,
                resolvePromptVisualState(raw, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA),
                { preblend: true }
            );
        }

        if (shadowAlpha === undefined) {
            shadowAlpha = promptVisualState?.shadowAlpha ?? PROMPT_SHADOW_FLOOR;
        }

        const result = {
            r: sampledPrimary.r,
            g: sampledPrimary.g,
            b: sampledPrimary.b,
            start: { r: sampledStart.r, g: sampledStart.g, b: sampledStart.b },
            end: { r: sampledEnd.r, g: sampledEnd.g, b: sampledEnd.b },
            noise: promptVisualState?.noise ?? sampledPrimary?.noise ?? 0.0,
            direction: direction,
            vibrancyMode: vibrancyMode,
            imagePath: imagePath,
            cancelColor: sampledCancelColor,
            avatarColor: sampledAvatarColor,
            a11yColor: sampledA11yColor,
            sessionColor: sampledSessionColor,
            shadowAlpha: shadowAlpha,
            useInverse: promptVisualState?.useInverse ?? false,
            visualState: promptVisualState,
            transitionInfo: transitionInfo ?? null,
        };

        setCache(cacheKey, result);
        saveCache();
        return result;
    })();

    _inFlightPromptQueries.set(cacheKey, queryPromise);
    try {
        return await queryPromise;
    } finally {
        _inFlightPromptQueries.delete(cacheKey);
    }
}

const _precachedXmls = new Set();

/**
 * Parses all static slide files from an XML slideshow and warms the alpha and
 * prompt color cache for each slide in background idle, ensuring 0ms lookups.
 *
 * @param {Object} params Wallpaper parameters
 */
export async function precacheSlideshow(params) {
    const { uri } = params;
    if (!uri || !uri.toLowerCase().endsWith('.xml'))
        return;

    const vibrancyMode = params.vibrancyMode ?? 'tonal';
    const precacheKey = `${uri}|${vibrancyMode}`;
    if (_precachedXmls.has(precacheKey))
        return;

    _precachedXmls.add(precacheKey);

    let xmlText = null;
    try {
        const file = uri.startsWith('file://') ? Gio.File.new_for_uri(uri) : Gio.File.new_for_path(uri);
        if (file.query_exists(null)) {
            const [ok, contents] = await file.load_contents_async(null);
            if (ok)
                xmlText = new TextDecoder().decode(contents);
        }
    } catch (_) {
        return;
    }

    if (!xmlText)
        return;

    const fileMatches = xmlText.matchAll(/<static[^>]*>[\s\S]*?<file>\s*([^<]+)\s*<\/file>[\s\S]*?<\/static>/g);
    const files = new Set();
    for (const match of fileMatches) {
        if (match[1]) {
            const trimmed = match[1].trim();
            if (trimmed)
                files.add(trimmed);
        }
    }

    if (files.size === 0)
        return;

    await initCache();

    for (const filePath of files) {
        try {
            const slideFile = Gio.File.new_for_path(filePath);
            if (!slideFile.query_exists(null))
                continue;

            const slideUri = slideFile.get_uri();
            const slideParams = {
                ...params,
                uri: slideUri,
            };

            await Promise.all([
                getWallpaperPromptColor(slideParams),
                getWallpaperAlpha({ ...slideParams, textLuminance: 1.0 }),
            ]);
        } catch (e) {
            _logError(`[WACK/AlphaManager] Pre-cache slide error for ${filePath}: ${e}`);
        }
    }
}
