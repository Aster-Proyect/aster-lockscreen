import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { PROMPT_VISUAL_ALGORITHM_VERSION } from './colorUtils.js';

export const CACHE_SCHEMA_VERSION = 1;
export const MAX_CACHE_ENTRIES = 64;

const userName = GLib.get_user_name();
const CACHE_FILE = `/var/tmp/wack-wallpaper-alpha-cache-${userName}.json`;

const _cache = new Map();
let _state = 'UNINITIALIZED'; // 'UNINITIALIZED' | 'LOADING' | 'READY'
let _generation = 0;
let _loadPromise = null;
let _saving = false;
let _saveRequested = false;
let _dirty = false;
let _saveScheduled = false;

function _isValidRgb(c) {
    return (
        c !== null &&
        typeof c === 'object' &&
        !Array.isArray(c) &&
        Number.isInteger(c.r) && c.r >= 0 && c.r <= 255 &&
        Number.isInteger(c.g) && c.g >= 0 && c.g <= 255 &&
        Number.isInteger(c.b) && c.b >= 0 && c.b <= 255
    );
}

function _validateCacheEntry(key, value) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 4096)
        return false;

    // Scalar alpha value (0.0 to 1.0)
    if (typeof value === 'number')
        return Number.isFinite(value) && value >= 0.0 && value <= 1.0;

    // Visual result object
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        if (!_isValidRgb(value))
            return false;
        if (value.start && !_isValidRgb(value.start))
            return false;
        if (value.end && !_isValidRgb(value.end))
            return false;
        if (value.cancelColor && !_isValidRgb(value.cancelColor))
            return false;
        if (value.avatarColor && !_isValidRgb(value.avatarColor))
            return false;
        if (value.a11yColor && !_isValidRgb(value.a11yColor))
            return false;
        if (value.sessionColor && !_isValidRgb(value.sessionColor))
            return false;
        if (typeof value.useInverse !== 'boolean')
            return false;
        if (typeof value.shadowAlpha !== 'number' || !Number.isFinite(value.shadowAlpha))
            return false;
        return true;
    }

    return false;
}

export function initCacheSync() {
    if (_state === 'READY')
        return;

    try {
        const file = Gio.File.new_for_path(CACHE_FILE);
        if (file.query_exists(null)) {
            const [success, contents] = file.load_contents(null);
            if (success && contents) {
                const decoded = new TextDecoder().decode(contents);
                const data = JSON.parse(decoded);

                if (
                    data &&
                    typeof data === 'object' &&
                    !Array.isArray(data) &&
                    data.__schema__ === CACHE_SCHEMA_VERSION &&
                    data.__visual_version__ === PROMPT_VISUAL_ALGORITHM_VERSION &&
                    data.entries &&
                    typeof data.entries === 'object' &&
                    !Array.isArray(data.entries)
                ) {
                    for (const [k, v] of Object.entries(data.entries)) {
                        if (!_cache.has(k) && _validateCacheEntry(k, v)) {
                            if (_cache.size >= MAX_CACHE_ENTRIES) {
                                const oldest = _cache.keys().next().value;
                                if (oldest !== undefined)
                                    _cache.delete(oldest);
                            }
                            _cache.set(k, v);
                        }
                    }
                }
            }
        }
    } catch (_) {
    } finally {
        _state = 'READY';
    }
}

export function initCache() {
    if (_state === 'READY')
        return Promise.resolve();

    if (_loadPromise)
        return _loadPromise;

    _state = 'LOADING';
    const currentGen = _generation;

    _loadPromise = new Promise((resolve) => {
        const file = Gio.File.new_for_path(CACHE_FILE);
        file.load_contents_async(null, (obj, res) => {
            try {
                if (_generation !== currentGen) {
                    resolve();
                    return;
                }

                const [success, contents] = file.load_contents_finish(res);
                if (success && contents) {
                    const decoded = new TextDecoder().decode(contents);
                    const data = JSON.parse(decoded);

                    if (
                        data &&
                        typeof data === 'object' &&
                        !Array.isArray(data) &&
                        data.__schema__ === CACHE_SCHEMA_VERSION &&
                        data.__visual_version__ === PROMPT_VISUAL_ALGORITHM_VERSION &&
                        data.entries &&
                        typeof data.entries === 'object' &&
                        !Array.isArray(data.entries)
                    ) {
                        for (const [k, v] of Object.entries(data.entries)) {
                            // In-memory entries created while loading are authoritative
                            if (!_cache.has(k) && _validateCacheEntry(k, v)) {
                                if (_cache.size >= MAX_CACHE_ENTRIES) {
                                    const oldest = _cache.keys().next().value;
                                    if (oldest !== undefined)
                                        _cache.delete(oldest);
                                }
                                _cache.set(k, v);
                            }
                        }
                    } else {
                        // Incompatible format or algorithm version mismatch: discard stale file
                        file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                    }
                }
            } catch (e) {
                // File missing, read error, or malformed JSON: safely reset
                try {
                    file.delete_async(GLib.PRIORITY_DEFAULT, null, null);
                } catch (_) {}
            } finally {
                if (_generation === currentGen)
                    _state = 'READY';
                _loadPromise = null;
                resolve();
            }
        });
    });

    return _loadPromise;
}

function _flushSave() {
    _saveScheduled = false;

    if (_saving) {
        _saveRequested = true;
        return;
    }

    if (!_dirty)
        return;

    _saving = true;
    _dirty = false;
    _saveRequested = false;

    const currentGen = _generation;
    const entriesObj = Object.fromEntries(_cache);
    const envelope = {
        __schema__: CACHE_SCHEMA_VERSION,
        __visual_version__: PROMPT_VISUAL_ALGORITHM_VERSION,
        entries: entriesObj,
    };

    let encoded;
    try {
        encoded = new TextEncoder().encode(JSON.stringify(envelope));
    } catch (e) {
        _saving = false;
        return;
    }

    const file = Gio.File.new_for_path(CACHE_FILE);
    file.replace_contents_async(
        encoded,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
        (obj, res) => {
            try {
                file.replace_contents_finish(res);
                try {
                    file.set_attribute_uint32('unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
                } catch (_) {}
            } catch (e) {
                // Non-fatal persistence error
            } finally {
                _saving = false;
                if (_generation === currentGen && (_saveRequested || _dirty)) {
                    _flushSave();
                }
            }
        }
    );
}

export function saveCache() {
    _dirty = true;
    if (!_saveScheduled) {
        _saveScheduled = true;
        Promise.resolve().then(() => {
            if (_saveScheduled)
                _flushSave();
        });
    }
}

export function clearCache() {
    _generation++;
    _state = 'UNINITIALIZED';
    _loadPromise = null;
    _cache.clear();
    _dirty = false;
    _saveRequested = false;
    _saveScheduled = false;
}

export function getCache(key) {
    if (typeof key !== 'string')
        return undefined;

    const val = _cache.get(key);
    if (val !== undefined) {
        // Refresh LRU order on access
        _cache.delete(key);
        _cache.set(key, val);
    }
    return val;
}

export function setCache(key, value) {
    if (!_validateCacheEntry(key, value))
        return false;

    if (_cache.has(key)) {
        _cache.delete(key);
    } else if (_cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = _cache.keys().next().value;
        if (oldest !== undefined)
            _cache.delete(oldest);
    }

    _cache.set(key, value);
    saveCache();
    return true;
}

export function hasCache(key) {
    if (typeof key !== 'string')
        return false;
    return _cache.has(key);
}
