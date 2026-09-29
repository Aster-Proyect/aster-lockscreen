import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    createClockAlphaIdentity,
    serializeClockAlphaIdentity,
    createPromptVibrancyIdentity,
    serializePromptVibrancyIdentity,
    computeSliceHash,
    resolveSlicePath,
    formatBoundsKey,
    formatProgressKey,
} from '../src/main/cacheIdentity.js';
import {
    setCache,
    getCache,
    hasCache,
    clearCache,
    flushAllCache,
    MAX_CACHE_ENTRIES,
    CacheMetrics,
} from '../src/main/alphaCache.js';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        passed++;
        print(`  ✓ ${testName}`);
    } else {
        failed++;
        printerr(`  ✗ FAIL: ${testName}`);
    }
}

print('Starting Cache Pipeline Unit Tests (GJS Environment)...');

// 1. Test Cache Identity Determinism
print('\n[1] Testing Cache Identity:');
const id1 = createClockAlphaIdentity({
    targetUri: 'file:///usr/share/backgrounds/image.jpg',
    mtime: 12345678,
    size: 1048576,
    isColor: false,
    primaryColor: '#000000',
    secondaryColor: '#ffffff',
    shadingType: 0,
    textLuminance: 1.0,
});
const key1 = serializeClockAlphaIdentity(id1);
const id2 = createClockAlphaIdentity({
    targetUri: 'file:///usr/share/backgrounds/image.jpg',
    mtime: 12345678,
    size: 1048576,
    isColor: false,
    primaryColor: '#000000',
    secondaryColor: '#ffffff',
    shadingType: 0,
    textLuminance: 1.0,
});
const key2 = serializeClockAlphaIdentity(id2);
assert(key1 === key2, 'Clock alpha canonical identity produces identical key strings');

const vId1 = createPromptVibrancyIdentity({
    targetUri: 'file:///usr/share/backgrounds/image.jpg',
    mtime: 12345678,
    size: 1048576,
    isColor: false,
    boundsKey: formatBoundsKey(0.4, 0.6, 0.8, 0.9),
    vibrancyMode: 'acrylic',
});
const vKey1 = serializePromptVibrancyIdentity(vId1);
const sliceHash1 = computeSliceHash(vKey1);
assert(sliceHash1.length === 8, 'Slice hash is 8 characters hex');

const slicePath1 = resolveSlicePath('testuser', sliceHash1, false, null);
assert(slicePath1.targetDir === '/var/tmp/wack/vibrancy/general', 'Static slice target dir is general');
assert(slicePath1.filePath.endsWith(`wack-prompt-blur-testuser-${sliceHash1}.png`), 'Static slice path formatted correctly');

const xmlSlicePath = resolveSlicePath('testuser', sliceHash1, true, 'adwaita-d.xml');
assert(xmlSlicePath.targetDir === '/var/tmp/wack/vibrancy/adwaita-d.xml', 'Dynamic XML slice target dir sanitized');

const progKey = formatProgressKey({ isTransition: true, progress: 0.456 });
assert(progKey === '_prog0.46', 'Transition progress rounded to 2 decimal places');

// 2. Test In-Memory L1 LRU and Capacity
print('\n[2] Testing L1 Cache & LRU:');
clearCache();
CacheMetrics.reset();

setCache('key_alpha_1', 0.65);
assert(hasCache('key_alpha_1'), 'Cache has key_alpha_1');
assert(getCache('key_alpha_1') === 0.65, 'Retrieved value matches stored value');
assert(CacheMetrics.l1Hits === 1, 'L1 hit counter incremented');

// Fill up to capacity
for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i++) {
    setCache(`bulk_key_${i}`, 0.5 + (i * 0.001));
}
assert(!hasCache('key_alpha_1'), 'Oldest entry evicted when capacity exceeded');
assert(hasCache(`bulk_key_${MAX_CACHE_ENTRIES + 9}`), 'Newest entry present');
assert(CacheMetrics.evictions === 11, 'Eviction count equals excess entries');

// 3. Test Entry Validation
print('\n[3] Testing Cache Entry Validation:');
const invalidScalar = setCache('bad_scalar', 1.5); // Alpha must be <= 1.0
assert(!invalidScalar, 'Rejects invalid scalar alpha > 1.0');

const validVisualState = {
    r: 50, g: 60, b: 70,
    start: { r: 50, g: 60, b: 70 },
    end: { r: 40, g: 50, b: 60 },
    cancelColor: { r: 55, g: 65, b: 75 },
    avatarColor: { r: 55, g: 65, b: 75 },
    a11yColor: { r: 50, g: 60, b: 70 },
    sessionColor: { r: 50, g: 60, b: 70 },
    useInverse: false,
    shadowAlpha: 0.15,
};
assert(setCache('valid_visual', validVisualState), 'Accepts valid PromptVisualState object');

const invalidVisualState = {
    r: 300, g: 60, b: 70, // r > 255
    useInverse: false,
    shadowAlpha: 0.15,
};
assert(!setCache('invalid_visual', invalidVisualState), 'Rejects visual state with out-of-range RGB');

// 5. Test Tonal Vibrancy & Visual Policy Wiring
print('\n[5] Testing Tonal Vibrancy & Visual Policy Wiring:');
import {
    resolvePromptVisualState,
    applyPromptVisualState,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
} from '../src/main/colorUtils.js';

// Bright wallpaper sample (e.g., pure white or bright pastel)
const brightSample = { r: 245, g: 245, b: 245, noise: 0.01 };
const brightVisualState = resolvePromptVisualState(brightSample, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
assert(brightVisualState.useInverse === true, 'Bright sample resolves useInverse === true');
assert(brightVisualState.isBrightSample === true, 'Bright sample resolves isBrightSample === true');

const preblendedBright = applyPromptVisualState(brightSample, brightVisualState, { preblend: true });
assert(preblendedBright.useInverse === true, 'Preblended bright result retains useInverse === true');
assert(preblendedBright.r < 245 && preblendedBright.g < 245 && preblendedBright.b < 245, 'Preblended bright result is dark inverse blended');

// Dark wallpaper sample (e.g., dark night scene)
const darkSample = { r: 30, g: 35, b: 40, noise: 0.01 };
const darkVisualState = resolvePromptVisualState(darkSample, CUPERTINO_PROMPT_WHITE_BLEND_ALPHA);
assert(darkVisualState.useInverse === false, 'Dark sample resolves useInverse === false');
assert(darkVisualState.isBrightSample === false, 'Dark sample resolves isBrightSample === false');

const preblendedDark = applyPromptVisualState(darkSample, darkVisualState, { preblend: true });
assert(preblendedDark.useInverse === false, 'Preblended dark result retains useInverse === false');
assert(preblendedDark.r > 30 && preblendedDark.g > 35 && preblendedDark.b > 40, 'Preblended dark result is white-frosted blended');

// 6. Test GDM Stack Key & Account Transition Differentiation
print('\n[6] Testing GDM Stack Key & Account Transition Differentiation:');

function testStackKey(theme) {
    const s = theme.slide;
    if (s !== null && s.isTransition)
        return `${s.from}>${s.to}`;
    if (theme.meta?.is_color)
        return `color:${theme.meta.primary_color}:${theme.meta.secondary_color}:${theme.meta.shading_type}`;
    return theme.image;
}

// Mock theme objects for two distinct users
const themeUserA = {
    userName: 'alice',
    meta: {
        is_color: false,
        uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-1000.jpg',
    },
    image: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-alice-1000.jpg',
    slide: null,
};

const themeUserB = {
    userName: 'bob',
    meta: {
        is_color: false,
        uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    },
    image: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    slide: null,
};

const themeUserASameAsB = {
    userName: 'charlie',
    meta: {
        is_color: false,
        uri: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    },
    image: 'file:///var/tmp/wack/shared/wack-shared-wallpaper-bob-2000.jpg',
    slide: null,
};

const themeColorA = {
    userName: 'dave',
    meta: {
        is_color: true,
        primary_color: '#0000ff',
        secondary_color: '#000000',
        shading_type: 0,
    },
    image: '',
    slide: null,
};

const themeColorB = {
    userName: 'eve',
    meta: {
        is_color: true,
        primary_color: '#ff0000',
        secondary_color: '#000000',
        shading_type: 0,
    },
    image: '',
    slide: null,
};

assert(testStackKey(themeUserA) !== testStackKey(themeUserB), 'Different static wallpapers produce different stack keys (A != B)');
assert(testStackKey(themeUserB) === testStackKey(themeUserASameAsB), 'Identical wallpapers across accounts share stack key (B == Charlie)');
assert(testStackKey(themeColorA) !== testStackKey(themeColorB), 'Different solid/gradient colors produce distinct stack keys (Dave != Eve)');

print('\n[7] Testing Account-Specific Vibrancy Mode & GDM Palette Indexing:');
function getPaletteKey(image, mode, fallbackMode = 'tonal') {
    const effectiveMode = mode ?? fallbackMode;
    return `${image}|${effectiveMode}`;
}

const userAccountTonal = { promptVibrancyMode: 'tonal' };
const userAccountAcrylic = { promptVibrancyMode: 'translucent' };

const imageUri = 'file:///var/tmp/wack/shared/wack-shared-wallpaper.jpg';
const keyTonal = getPaletteKey(imageUri, userAccountTonal.promptVibrancyMode);
const keyAcrylic = getPaletteKey(imageUri, userAccountAcrylic.promptVibrancyMode);

assert(keyTonal === `${imageUri}|tonal`, 'Tonal account produces tonal palette key');
assert(keyAcrylic === `${imageUri}|translucent`, 'Acrylic account produces translucent palette key');
assert(keyTonal !== keyAcrylic, 'Tonal and Acrylic accounts do not collide in palette cache');

print('\n[8] Testing Aspect Ratio Scaling & Cover Viewport Calculations:');
function computeVisibleViewport(origW, origH, monitorW, monitorH, pictureOptions = 'zoom') {
    let targetW = monitorW;
    let targetH = monitorH;
    if (origW > 0 && origH > 0) {
        if (pictureOptions === 'stretched') {
            targetW = monitorW;
            targetH = monitorH;
        } else if (pictureOptions === 'scaled') {
            const scale = Math.min(monitorW / origW, monitorH / origH);
            targetW = Math.max(1, Math.round(origW * scale));
            targetH = Math.max(1, Math.round(origH * scale));
        } else {
            // zoom / cover
            const scale = Math.max(monitorW / origW, monitorH / origH);
            targetW = Math.max(1, Math.round(origW * scale));
            targetH = Math.max(1, Math.round(origH * scale));
        }
    }

    const pbAspect = targetW / targetH;
    const monitorAspect = monitorW / monitorH;
    let visibleX = 0, visibleY = 0, visibleW = targetW, visibleH = targetH;
    if (pictureOptions === 'zoom') {
        if (pbAspect > monitorAspect) {
            visibleW = targetH * monitorAspect;
            visibleX = (targetW - visibleW) / 2;
        } else if (pbAspect < monitorAspect) {
            visibleH = targetW / monitorAspect;
            visibleY = (targetH - visibleH) / 2;
        }
    }
    return { targetW, targetH, visibleX, visibleY, visibleW, visibleH };
}

// 16:10 image on 16:9 monitor (1920x1200 on 1920x1080)
const cover1610 = computeVisibleViewport(1920, 1200, 1920, 1080, 'zoom');
assert(cover1610.targetW === 1920 && cover1610.targetH === 1200, '16:10 image scaled to 1920x1200 cover');
assert(cover1610.visibleW === 1920 && cover1610.visibleH === 1080, '16:10 visible viewport is 1920x1080');
assert(cover1610.visibleY === 60, '16:10 center-crop visibleY offset is 60px');

// 21:9 ultrawide image on 16:9 monitor (2560x1080 on 1920x1080)
const cover219 = computeVisibleViewport(2560, 1080, 1920, 1080, 'zoom');
assert(cover219.targetW === 2560 && cover219.targetH === 1080, '21:9 image scaled to 2560x1080 cover');
assert(cover219.visibleW === 1920 && cover219.visibleH === 1080, '21:9 visible viewport is 1920x1080');
assert(cover219.visibleX === 320, '21:9 center-crop visibleX offset is 320px');

print(`\n========================================`);
print(`Test Results: ${passed} Passed, ${failed} Failed`);
print(`========================================\n`);

if (failed > 0) {
    throw new Error(`${failed} tests failed`);
}
