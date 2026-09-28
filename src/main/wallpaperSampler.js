import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import { _logError } from './mainUtils.js';
import {
    resolvePromptVisualState,
    getPromptDarkenedHueColor,
    PROMPT_SHADOW_FLOOR,
    CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
    clamp01,
    clamp255,
} from './colorUtils.js';

function fastBoxBlur(srcPixels, w, h, stride, channels, r) {
    if (r <= 0 || w <= 0 || h <= 0)
        return srcPixels;

    const total = w * h * channels;
    const temp = new Uint8Array(total);
    const out = new Uint8Array(total);

    // Horizontal pass
    for (let y = 0; y < h; y++) {
        const rowOffset = y * stride;
        const tempRowOffset = y * w * channels;
        for (let c = 0; c < channels; c++) {
            let sum = 0;
            for (let x = -r; x <= r; x++) {
                const sx = Math.max(0, Math.min(w - 1, x));
                sum += srcPixels[rowOffset + sx * channels + c];
            }
            const count = 2 * r + 1;
            temp[tempRowOffset + c] = Math.round(sum / count);

            for (let x = 1; x < w; x++) {
                const addX = Math.min(w - 1, x + r);
                const subX = Math.max(0, x - r - 1);
                sum += srcPixels[rowOffset + addX * channels + c] - srcPixels[rowOffset + subX * channels + c];
                temp[tempRowOffset + x * channels + c] = Math.round(sum / count);
            }
        }
    }

    // Vertical pass
    for (let x = 0; x < w; x++) {
        for (let c = 0; c < channels; c++) {
            let sum = 0;
            for (let y = -r; y <= r; y++) {
                const sy = Math.max(0, Math.min(h - 1, y));
                sum += temp[sy * w * channels + x * channels + c];
            }
            const count = 2 * r + 1;
            out[x * channels + c] = Math.round(sum / count);

            for (let y = 1; y < h; y++) {
                const addY = Math.min(h - 1, y + r);
                const subY = Math.max(0, y - r - 1);
                sum += temp[addY * w * channels + x * channels + c] - temp[subY * w * channels + x * channels + c];
                out[y * w * channels + x * channels + c] = Math.round(sum / count);
            }
        }
    }

    return out;
}

/**
 * Creates a blurred wallpaper slice matching the password prompt chip bounds,
 * with dynamic downsampling and adaptive frosted glass white/dark blend.
 *
 * @param {GdkPixbuf.Pixbuf} srcPixbuf Source wallpaper pixbuf
 * @param {object} bounds Normalized crop coordinates { x1, x2, y1, y2 }
 * @param {number} destWidth Target prompt chip width in pixels
 * @param {number} destHeight Target prompt chip height in pixels
 * @param {number} blurRadius Blur radius in screen pixels
 * @param {number} brightness Brightness multiplier factor
 * @param {number} highlightAlpha Optional overlay highlight/tint alpha (0.0 - 1.0)
 * @param {number|null} whiteBlendAlpha Frosted glass white overlay alpha (defaults to CUPERTINO_PROMPT_WHITE_BLEND_ALPHA)
 * @param {object|null} visualState Optional already-resolved prompt visual state. When provided,
 *   overlay/inverse policy is applied as-is instead of being re-derived from this slice.
 * @returns {{pixbuf: GdkPixbuf.Pixbuf, avgColor: {r: number, g: number, b: number}, shadowAlpha: number, visualState: object}|null}
 */
export function createBlurredPromptSlice(
    srcPixbuf,
    bounds,
    destWidth = 320,
    destHeight = 40,
    blurRadius = 40,
    brightness = 1.0,
    highlightAlpha = 0.0,
    whiteBlendAlpha = CUPERTINO_PROMPT_WHITE_BLEND_ALPHA,
    visualState = null
) {
    if (!srcPixbuf)
        return null;

    const pbWidth = srcPixbuf.get_width();
    const pbHeight = srcPixbuf.get_height();

    const startX = Math.max(0, Math.min(pbWidth - 1, Math.floor(bounds.x1 * pbWidth)));
    const endX = Math.max(1, Math.min(pbWidth, Math.ceil(bounds.x2 * pbWidth)));
    const startY = Math.max(0, Math.min(pbHeight - 1, Math.floor(bounds.y1 * pbHeight)));
    const endY = Math.max(1, Math.min(pbHeight, Math.ceil(bounds.y2 * pbHeight)));

    const cropW = endX - startX;
    const cropH = endY - startY;

    if (cropW <= 0 || cropH <= 0)
        return null;

    if (blurRadius <= 0) {
        const rawPix = srcPixbuf.new_subpixbuf(startX, startY, cropW, cropH);
        let scaledPix = (cropW !== destWidth || cropH !== destHeight)
            ? rawPix.scale_simple(destWidth, destHeight, GdkPixbuf.InterpType.BILINEAR)
            : rawPix.copy();
        const pixels = scaledPix.get_pixels();
        const nChannels = scaledPix.get_n_channels();
        const stride = scaledPix.get_rowstride();
        const w = scaledPix.get_width();
        const h = scaledPix.get_height();
        const bFactor = Math.max(0, brightness);

        let sumR = 0, sumG = 0, sumB = 0;
        const total = w * h;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const off = y * stride + x * nChannels;
                sumR += pixels[off];
                sumG += pixels[off + 1];
                sumB += pixels[off + 2];
            }
        }
        const avgColor = {
            r: Math.round(sumR / total),
            g: Math.round(sumG / total),
            b: Math.round(sumB / total),
        };
        const resolvedState = visualState ?? resolvePromptVisualState(avgColor, whiteBlendAlpha);
        const overlayR = resolvedState.overlay.r;
        const overlayG = resolvedState.overlay.g;
        const overlayB = resolvedState.overlay.b;
        const blendAlpha = resolvedState.overlay.alpha;
        const invAlpha = 1 - blendAlpha;
        const hInv = highlightAlpha > 0 ? (1 - highlightAlpha) : 1;
        const hR = 255;
        const hG = 255;
        const hB = 255;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const off = y * stride + x * nChannels;
                let r = (pixels[off] * invAlpha + overlayR * blendAlpha) * bFactor;
                let g = (pixels[off + 1] * invAlpha + overlayG * blendAlpha) * bFactor;
                let b = (pixels[off + 2] * invAlpha + overlayB * blendAlpha) * bFactor;

                if (highlightAlpha > 0) {
                    r = r * hInv + hR * highlightAlpha;
                    g = g * hInv + hG * highlightAlpha;
                    b = b * hInv + hB * highlightAlpha;
                }

                pixels[off] = Math.max(0, Math.min(255, Math.round(r)));
                pixels[off + 1] = Math.max(0, Math.min(255, Math.round(g)));
                pixels[off + 2] = Math.max(0, Math.min(255, Math.round(b)));
            }
        }
        return {
            pixbuf: scaledPix,
            avgColor,
            shadowAlpha: resolvedState.shadowAlpha ?? PROMPT_SHADOW_FLOOR,
            visualState: resolvedState,
        };
    }

    try {
        // Calculate padding in pixbuf coordinates equivalent to blurRadius screen pixels
        const rInPixbuf = Math.round(blurRadius * (cropW / destWidth));

        const padStartX = Math.max(0, startX - rInPixbuf);
        const padEndX = Math.min(pbWidth, endX + rInPixbuf);
        const padStartY = Math.max(0, startY - rInPixbuf);
        const padEndY = Math.min(pbHeight, endY + rInPixbuf);

        const padW = padEndX - padStartX;
        const padH = padEndY - padStartY;
        if (padW <= 0 || padH <= 0)
            return null;

        const padCrop = srcPixbuf.new_subpixbuf(padStartX, padStartY, padW, padH);

        const scaleX = destWidth / cropW;
        const scaleY = destHeight / cropH;
        const workW = Math.max(2, Math.round(padW * scaleX));
        const workH = Math.max(2, Math.round(padH * scaleY));

        // Dynamic downsampling:
        // Use 1x for small blur radii (<16px) to avoid destroying fine details.
        // Use 2x for standard/large radii (>=16px) for optimal performance.
        const dsFactor = blurRadius >= 16 ? 2 : 1;
        const dsW = Math.max(2, Math.round(workW / dsFactor));
        const dsH = Math.max(2, Math.round(workH / dsFactor));
        const dsPix = dsFactor > 1
            ? padCrop.scale_simple(dsW, dsH, GdkPixbuf.InterpType.BILINEAR)
            : padCrop.scale_simple(workW, workH, GdkPixbuf.InterpType.BILINEAR);
        if (!dsPix)
            return null;

        const dsPixels = dsPix.get_pixels();
        const dsStride = dsPix.get_rowstride();
        const dsChannels = dsPix.get_n_channels();

        // 2 passes of box blur approximate a true Gaussian blur of the target radius
        const dsRadius = Math.max(1, Math.round((blurRadius / dsFactor) * 0.7));
        const pass1 = fastBoxBlur(dsPixels, dsW, dsH, dsStride, dsChannels, dsRadius);
        const pass2 = fastBoxBlur(pass1, dsW, dsH, dsW * dsChannels, dsChannels, dsRadius);

        // Crop the central prompt chip at downsampled scale
        const dsOffX = Math.round((startX - padStartX) * scaleX / dsFactor);
        const dsOffY = Math.round((startY - padStartY) * scaleY / dsFactor);
        const dsCropW = Math.round(destWidth / dsFactor);
        const dsCropH = Math.round(destHeight / dsFactor);

        const dsChipBytes = new Uint8Array(dsCropW * dsCropH * dsChannels);

        // Calculate chip average color to determine a uniform white/dark frosted glass blend
        let sumR = 0, sumG = 0, sumB = 0;
        const totalSamples = dsCropW * dsCropH;
        for (let y = 0; y < dsCropH; y++) {
            const clampedY = Math.max(0, Math.min(dsH - 1, y + dsOffY));
            for (let x = 0; x < dsCropW; x++) {
                const clampedX = Math.max(0, Math.min(dsW - 1, x + dsOffX));
                const srcOff = (clampedY * dsW + clampedX) * dsChannels;
                sumR += pass2[srcOff];
                sumG += pass2[srcOff + 1];
                sumB += pass2[srcOff + 2];
            }
        }
        const avgColor = {
            r: Math.round(sumR / totalSamples),
            g: Math.round(sumG / totalSamples),
            b: Math.round(sumB / totalSamples),
        };

        const resolvedState = visualState ?? resolvePromptVisualState(avgColor, whiteBlendAlpha);
        const overlayR = resolvedState.overlay.r;
        const overlayG = resolvedState.overlay.g;
        const overlayB = resolvedState.overlay.b;
        const blendAlpha = resolvedState.overlay.alpha;
        const shadowAlpha = resolvedState.shadowAlpha;

        const bFactor = Math.max(0, brightness);
        const invAlpha = 1 - blendAlpha;
        const hInv = highlightAlpha > 0 ? (1 - highlightAlpha) : 1;
        const hR = 255;
        const hG = 255;
        const hB = 255;

        const isBrightHue = resolvedState.isBrightHue ?? false;

        for (let y = 0; y < dsCropH; y++) {
            const clampedY = Math.max(0, Math.min(dsH - 1, y + dsOffY));
            for (let x = 0; x < dsCropW; x++) {
                const clampedX = Math.max(0, Math.min(dsW - 1, x + dsOffX));
                const srcOff = (clampedY * dsW + clampedX) * dsChannels;
                const dstOff = (y * dsCropW + x) * dsChannels;

                let srcR = pass2[srcOff];
                let srcG = pass2[srcOff + 1];
                let srcB = pass2[srcOff + 2];

                if (isBrightHue) {
                    const darkened = getPromptDarkenedHueColor({ r: srcR, g: srcG, b: srcB });
                    srcR = darkened.r;
                    srcG = darkened.g;
                    srcB = darkened.b;
                }

                let r = (srcR * invAlpha + overlayR * blendAlpha) * bFactor;
                let g = (srcG * invAlpha + overlayG * blendAlpha) * bFactor;
                let b = (srcB * invAlpha + overlayB * blendAlpha) * bFactor;

                if (highlightAlpha > 0) {
                    r = r * hInv + hR * highlightAlpha;
                    g = g * hInv + hG * highlightAlpha;
                    b = b * hInv + hB * highlightAlpha;
                }

                dsChipBytes[dstOff] = Math.max(0, Math.min(255, Math.round(r)));
                dsChipBytes[dstOff + 1] = Math.max(0, Math.min(255, Math.round(g)));
                dsChipBytes[dstOff + 2] = Math.max(0, Math.min(255, Math.round(b)));
                if (dsChannels === 4)
                    dsChipBytes[dstOff + 3] = pass2[srcOff + 3];
            }
        }

        const dsBytesObj = GLib.Bytes.new(dsChipBytes);
        const dsChipPixbuf = GdkPixbuf.Pixbuf.new_from_bytes(
            dsBytesObj,
            GdkPixbuf.Colorspace.RGB,
            dsChannels === 4,
            8,
            dsCropW,
            dsCropH,
            dsCropW * dsChannels
        );

        const finalPixbuf = dsFactor > 1
            ? dsChipPixbuf.scale_simple(destWidth, destHeight, GdkPixbuf.InterpType.BILINEAR)
            : dsChipPixbuf;

        return {
            pixbuf: finalPixbuf,
            avgColor,
            shadowAlpha,
            visualState: resolvedState,
        };
    } catch (e) {
        _logError(`[WACK/WallpaperSampler] createBlurredPromptSlice error: ${e}`);
        return null;
    }
}

/**
 * Samples a rectangular region from a source wallpaper pixbuf and computes its average color.
 *
 * @param {GdkPixbuf.Pixbuf} srcPixbuf Source wallpaper pixbuf
 * @param {object} bounds Normalized crop coordinates { x1, x2, y1, y2 }
 * @returns {{r: number, g: number, b: number}|null}
 */
export function sampleRegionAverageColor(srcPixbuf, bounds) {
    if (!srcPixbuf || !bounds)
        return null;

    const pbWidth = srcPixbuf.get_width();
    const pbHeight = srcPixbuf.get_height();

    const startX = Math.max(0, Math.min(pbWidth - 1, Math.floor(bounds.x1 * pbWidth)));
    const endX = Math.max(1, Math.min(pbWidth, Math.ceil(bounds.x2 * pbWidth)));
    const startY = Math.max(0, Math.min(pbHeight - 1, Math.floor(bounds.y1 * pbHeight)));
    const endY = Math.max(1, Math.min(pbHeight, Math.ceil(bounds.y2 * pbHeight)));

    const cropW = endX - startX;
    const cropH = endY - startY;
    if (cropW <= 0 || cropH <= 0)
        return null;

    const rawPix = srcPixbuf.new_subpixbuf(startX, startY, cropW, cropH);
    const pixels = rawPix.get_pixels();
    const nChannels = rawPix.get_n_channels();
    const stride = rawPix.get_rowstride();

    let sumR = 0, sumG = 0, sumB = 0;
    let diffSum = 0, diffCount = 0;
    const stepX = Math.max(1, Math.floor(cropW / 32));
    const stepY = Math.max(1, Math.floor(cropH / 32));
    let samples = 0;

    for (let y = 0; y < cropH; y += stepY) {
        const rowOff = y * stride;
        for (let x = 0; x < cropW; x += stepX) {
            const off = rowOff + x * nChannels;
            const r = pixels[off];
            const g = pixels[off + 1];
            const b = pixels[off + 2];
            sumR += r;
            sumG += g;
            sumB += b;
            samples++;

            if (x + stepX < cropW && y + stepY < cropH) {
                const offRight = rowOff + (x + stepX) * nChannels;
                const offDown = (y + stepY) * stride + x * nChannels;
                const rR = pixels[offRight], gR = pixels[offRight + 1], bR = pixels[offRight + 2];
                const rD = pixels[offDown], gD = pixels[offDown + 1], bD = pixels[offDown + 2];

                const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
                const lumR = (0.2126 * rR + 0.7152 * gR + 0.0722 * bR) / 255.0;
                const lumD = (0.2126 * rD + 0.7152 * gD + 0.0722 * bD) / 255.0;

                diffSum += (Math.abs(lum - lumR) + Math.abs(lum - lumD)) / 2.0;
                diffCount++;
            }
        }
    }

    if (samples === 0)
        return null;

    const noise = diffCount > 0 ? (diffSum / diffCount) : 0.0;

    return {
        r: clamp255(sumR / samples),
        g: clamp255(sumG / samples),
        b: clamp255(sumB / samples),
        noise: Math.max(0.0, noise),
    };
}

