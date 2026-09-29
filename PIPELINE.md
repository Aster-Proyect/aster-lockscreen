# WACK Lockscreen Clock — Cache Pipeline Forensic Architecture Report

> **Investigation Mode:** Read-only Forensic Audit  
> **Status:** Current State Source-of-Truth  
> **Target:** GNOME Shell Extension `wack-lockscreen-clock@rinzler69-wastaken.github.com`

---

## A. Executive Architecture Summary

The cache system in WACK (Sonoma Lockscreen) is a **hybrid multi-tier caching, sampling, and cross-session IPC pipeline** spanning user desktop sessions and the GDM (login screen) greeter. It solves a core performance and security constraint in GNOME Shell: extracting ambient color, computing APCA contrast, blurring high-resolution wallpapers, and passing desktop wallpaper configurations across unprivileged user sessions into the GDM session (`gdm` user) without blocking the Clutter UI thread on screen lock or user switching.

The system is composed of four distinct caching tiers:
1. **L1 In-Memory Object Cache (`alphaCache.js`)**: An in-memory LRU `Map` (capacity 64) with state machine transitions (`UNINITIALIZED` -> `LOADING` -> `READY`), serializing to disk via async debounced JSON envelopes with schema versioning (`CACHE_SCHEMA_VERSION = 1`) and algorithm versioning (`PROMPT_VISUAL_ALGORITHM_VERSION = 27`).
2. **L2 Disk Value Cache (`/var/tmp/wack/cache`)**: Per-user JSON files (`wack-wallpaper-alpha-cache-<user>.json`, mode `0600`) containing computed scalar clock alphas and serialized prompt visual objects (`PromptVisualState`).
3. **L3 Processed Image Slice Cache (`/var/tmp/wack/vibrancy`)**: Rendered blurred PNG bitmap chips (`wack-prompt-blur-<user>-<hash>.png`, mode `0644`) partitioned into static (`/general`) and dynamic XML slideshow subdirectories (pruned via LRU/mtime with a cap of 4 dynamic slideshow folders).
4. **L4 Cross-Session Shared State & Transcoded Wallpaper Cache (`/var/tmp/wack/shared`)**: World-readable shared JSON metadata (`wack-shared-wallpaper-<user>.json`, mode `0644`) and downscaled/blended JPEG wallpapers (`wack-shared-wallpaper-<user>-<timestamp>.jpg`, max dimension 2560px, JPEG quality 80) that allow the GDM greeter (`GdmThemeStore` / `GdmWallpaperView`) to display wallpaper and styling without access to encrypted or `0700` user home directories.

---

## B. Repository Components

| File / Component | Type | Responsibility in Cache Pipeline |
| :--- | :--- | :--- |
| `src/main/alphaCache.js` | Cache Store / Persistence | Manages the in-memory LRU `Map`, async disk loading/saving, JSON serialization/deserialization, cache schema validation, and cache-wide disk flushes. |
| `src/main/alphaManager.js` | Generator / Cache Manager | Coordinates cache queries for clock alpha and prompt color. Constructs composite cache keys, triggers pixbuf loading/downsampling/blurring, writes PNG slices, executes slide precaching, and performs directory pruning. |
| `src/main/wallpaperSampler.js` | Computation Engine | Implements 2-pass box blur (`fastBoxBlur`), dynamic downsampling (1x vs 2x), cropped sub-pixbuf extraction, spatial region average color sampling, texture noise analysis, and pixel overlay blending. |
| `src/main/wallpaperUtils.js` | Extraction / Transformation | Resolves URI/file paths, parses GNOME XML slideshows, queries file `mtime` and `size`, performs coordinate transformations (`mapScreenToSourceCoords`), blends dual-slide transition pixbufs (`blendPixbufs`), and loads scaled pixbufs from async streams. |
| `src/main/colorUtils.js` | Visual Algorithm Engine | Pure math and color perception calculations: APCA contrast calculation, relative luminance, CIE L* perceptual lightness, RGB/HSL conversions, and authoritative prompt visual state resolution (`resolvePromptVisualState`, `resolveBaseVisualPolicy`). Stores `PROMPT_VISUAL_ALGORITHM_VERSION`. |
| `crossSessionManager.js` | Exporter / Serializer | Watches user background/theme GSettings and filesystem changes; downscales active wallpaper to <= 2560px JPEG; blends transition frames; writes metadata and wallpaper copies to `/var/tmp/wack/shared/`. |
| `src/pro/gdmThemePipeline.js` | GDM Greeter Store & Viewer | `GdmThemeStore`: Monitors `/var/tmp/wack/shared/`, reads user metadata, manages idle queue draining (`_drainOne`), holds in-memory `_paletteCache`, synchronizes slideshow progression timers (`_armSlideClock`).<br>`GdmWallpaperView`: Multi-monitor Clutter actor view pooling up to 4 cached wallpaper texture stacks per monitor (`_createStack`, `_evict`). |
| `src/pro/gdmWallpaperManager.js` | GDM Coordinator | Instantiates and controls `GdmThemeStore` and `GdmWallpaperView`, monitors shared directory changes (`setupSharedWallpaperMonitor`), applies cached themes to clock, prompt, and messages. |
| `src/main/wallpaperManager.js` | Local View Manager | Manages the user lockscreen custom wallpaper overlay actor (`Clutter.Actor` with `Shell.BlurEffect`). |
| `src/main/promptStyling.js` | UI Consumer | Consumes cached `PromptVisualState` and `imagePath` to inject CSS background styles, box-shadows, and dim-veil overlays into prompt entry and action buttons. |
| `src/pro/gdmPromptStyling.js` | GDM UI Consumer | Consumes cached GDM palette and applies background styles/box-shadows to GDM login entries and buttons. |
| `src/main/wackClock.js` | UI Consumer | Consumes scalar `clockAlpha` and `promptColor` to style date/time typography and hint text. |
| `src/main/notificationManager.js` | UI Consumer | Consumes `promptColor` / `visualState` to calculate card background rgba and inverse styling for notification blur cards. |
| `src/main/cupertinoPromptManager.js` | UI Consumer | Injects cached avatar colors, hint typography styles, and prompt blur settings into the Cupertino rest prompt. |
| `extension.js` | Lifecycle Coordinator | Initializes cache (`initCache()`), kicks off background precaching (`precacheSlideshow()`), triggers refresh on screen lock (`active-changed`) and resume (`prepare-for-sleep`), tears down on `disable()`. |
| `prefs.js` | Admin Utility | Exposes manual "Flush Cache" UI action row invoking `_flushWackCache()`. |

---

## C. End-to-End Pipeline

```
[SOURCE INPUTS]
  ├── GSettings (org.gnome.desktop.background, org.gnome.desktop.interface)
  ├── Custom Wallpaper Path (GSettings: org.gnome.shell.extensions.wack-lockscreen-clock)
  ├── Raw Image Files (/usr/share/backgrounds/*, ~/.local/share/backgrounds/*)
  └── Dynamic XML Slideshows (e.g. adwaita-d.xml)
       │
       ▼
[STAGE 1: DETECTION & SOURCE RESOLUTION] (wallpaperUtils.js: resolveWallpaperSource)
  ├── Detect file vs color vs XML slideshow
  ├── If XML: parse <starttime>, <static>, <transition> (constants.js: resolveSlideshowXmlContent)
  │    ├── If in transition: resolve 'from', 'to', and 'progress' (0.00..1.00)
  │    └── If static: resolve current slide filePath
  └── Query Gio.File: mtime and standard::size
       │
       ▼
[STAGE 2: CACHE KEY / IDENTITY COMPUTATION] (alphaManager.js)
  ├── Compute composite strings:
  │    ├── Clock Alpha Key:
  │    │   `${targetUri}_${mtime}_${size}_${isColor}_${primary}_${secondary}_${shading}_${textLum}${progKey}`
  │    └── Prompt Vibrancy Key:
  │        `prompt_grad_${targetUri}_${mtime}_${size}_${isColor}_${primary}_${secondary}_${shading}_${options}_${monW}x${monH}_${bounds}_cb${cancelBounds}_av${avatarBounds}_a11y${a11yBounds}_sess${sessionBounds}_b${BLUR_R}_pbr${BLUR_BRIGHT}_chov${...}_cact${...}_cover_vis${PROMPT_VIS_VER}_vm${vibrancyMode}${progKey}`
  │
  ├── CHECK L1 IN-MEMORY MAP (_cache.has(key)) ─────────────────────────────┐
  │    ├── [HIT]: Return in-memory value immediately (0ms)                   │
  │    └── [MISS]: Proceed to computation                                   │
  │                                                                          │
  ▼                                                                          │
[STAGE 3: EXTRACTION & TRANSFORMATION] (wallpaperUtils.js, wallpaperSampler.js)│
  ├── Load scaled source image: loadScaledWallpaperPixbuf()                  │
  │    ├── For Alpha: 256x256 pixbuf (preserveAspectRatio=true)              │
  │    └── For Prompt: monitorWidth x monitorHeight pixbuf                   │
  │         └── (If XML transition: blendPixbufs(pbFrom, pbTo, progress))    │
  ├── Crop to normalized target coordinates (Prompt, Cancel, Avatar, etc.)   │
  └── Analyze pixel buffers:                                                 │
       ├── Luminance / noise sampling                                        │
       └── If Vibrancy is 'acrylic'/'blur':                                  │
            ├── Dynamic downsampling (1x if r<16px, 2x if r>=16px)           │
            ├── 2-pass fastBoxBlur()                                         │
            ├── Apply frosted-glass overlay & bright-hue darkening           │
            └── Save PNG slice: /var/tmp/wack/vibrancy/.../wack-prompt-blur-*.png
       │                                                                     │
       ▼                                                                     │
[STAGE 4: COLOR PERCEPTION & VISUAL POLICY] (colorUtils.js)                  │
  ├── analyzePerceptualColor() -> relative luminance, CIE L*, chroma, noise │
  ├── resolvePromptVisualState() -> overlay RGBA, shadowAlpha, treatment     │
  └── applyPromptVisualState() -> per-control colors (Cancel, Avatar, etc.)  │
       │                                                                     │
       ▼                                                                     │
[STAGE 5: SERIALIZATION & PERSISTENCE] (alphaCache.js)                       │
  ├── L1 Store: _cache.set(key, result) (LRU order refreshed)                │
  ├── Debounced Save: saveCache() -> Promise.resolve() -> _flushSave()       │
  │    └── Write /var/tmp/wack/cache/wack-wallpaper-alpha-cache-<user>.json  │
  │         Envelope: { __schema__: 1, __visual_version__: 27, entries: {} } │
  │                                                                          │
  ▼                                                                          │
[STAGE 6: CROSS-SESSION EXPORT] (crossSessionManager.js)                     │
  ├── Downscale wallpaper to <= 2560px JPEG (quality 80)                     │
  ├── Save to /var/tmp/wack/shared/wack-shared-wallpaper-<user>-<ts>.jpg     │
  ├── Write /var/tmp/wack/shared/wack-shared-wallpaper-<user>.json           │
  └── Clean up older shared wallpaper files for this user                    │
       │                                                                     │
       ▼                                                                     │
[STAGE 7: CONSUMPTION & RENDERING]                                           │
  ├── User Session:                                                          │
  │    ├── WackClock: setWallpaperAlpha(alpha, promptColor)                  │
  │    ├── Prompt Entry: CSS background-image url(PNG) or gradient / shadow  │
  │    ├── NotificationManager: setVibrancyInverse(promptColor)              │
  │    └── CupertinoPrompt: avatar button background & hint label styling    │
  └── GDM Session (via GdmThemeStore & GdmWallpaperView):                    │
       ├── FileMonitor on /var/tmp/wack/shared/ -> loadUser()                 │
       ├── Adopt shipped palette or drain compute queue via idle handler     │
       └── Present multi-monitor texture stacks and style GDM auth prompt ───┘
```

---

## D. Call Graph

### 1. Cache Creation & Warmup Call Chain
```
extension.js: enable()
  ├── initCache() [src/main/alphaCache.js]
  │    └── load_contents_async(/var/tmp/wack/cache/wack-wallpaper-alpha-cache-<user>.json)
  │         └── Populates _cache Map
  │
  ├── _updateClockAlphaAndPromptColor() [extension.js]
  │    ├── resolveWallpaperSource(uri) [src/main/wallpaperUtils.js]
  │    ├── precacheSlideshow(params) [src/main/alphaManager.js] (if XML)
  │    │    └── Background loop iterating all <static> slides:
  │    │         ├── getWallpaperPromptColor(slideParams)
  │    │         └── getWallpaperAlpha(slideParams)
  │    │
  │    ├── getWallpaperAlpha(params) [src/main/alphaManager.js]
  │    │    ├── hasCache(cacheKey) -> false
  │    │    ├── loadScaledWallpaperPixbuf(targetFilePath, 256, 256, true)
  │    │    ├── Loop pixels -> average RGB & texture noise diff
  │    │    ├── getApcaContrast() + chroma discount + noise factor
  │    │    ├── setCache(cacheKey, alpha)
  │    │    └── saveCache()
  │    │
  │    └── getWallpaperPromptColor(params) [src/main/alphaManager.js]
  │         ├── hasCache(cacheKey) -> false
  │         ├── loadScaledWallpaperPixbuf(targetFilePath, targetW, targetH, false)
  │         ├── sampleRegionAverageColor() / createBlurredPromptSlice()
  │         │    └── fastBoxBlur() -> sliceResult.pixbuf.savev(PNG)
  │         ├── resolvePromptVisualState() + applyPromptVisualState()
  │         ├── setCache(cacheKey, result)
  │         └── saveCache()
  │
  └── crossSessionManager.js: setClockAlphaAndPromptColor(alpha, promptColor)
       └── _saveWallpaper()
            ├── GdkPixbuf downscale to 2560px max -> savev(JPEG, quality 80)
            └── replace_contents(/var/tmp/wack/shared/wack-shared-wallpaper-<user>.json)
```

### 2. Cache Read / Lookup Call Chain
```
Screen Lock Event / Settings Change:
  └── extension.js: _updateClockAlphaAndPromptColor()
       ├── getWallpaperAlpha(params)
       │    ├── hasCache(cacheKey) -> true
       │    └── return getCache(cacheKey) -> [LRU touch] -> returns number
       │
       └── getWallpaperPromptColor(params)
            ├── hasCache(cacheKey) -> true
            ├── cached = getCache(cacheKey)
            ├── Validation:
            │    ├── If vibrancyMode in ['tonal', 'less']: cached.r != null && hasAllButtons -> return cached
            │    └── If vibrancyMode in ['acrylic', 'blur']: file_exists(cached.imagePath) && hasAllButtons -> return cached
            └── [On validation failure]: falls through to recompute
```

### 3. Invalidation & Eviction Call Chain
```
In-Memory Eviction (Capacity Limit):
  └── alphaCache.js: setCache(key, value)
       └── if (_cache.size >= MAX_CACHE_ENTRIES [64])
            └── _cache.delete(_cache.keys().next().value) [Oldest LRU entry dropped]

Stale File Invalidation (Schema / Version Mismatch):
  └── alphaCache.js: initCache()
       └── load_contents_async()
            └── if (data.__schema__ !== 1 || data.__visual_version__ !== 27)
                 └── file.delete_async() [Deletes entire user cache JSON file]

Disk Slice Pruning:
  └── alphaManager.js: getWallpaperPromptColor() (acrylic mode)
       ├── Prunes sibling slice PNGs: deletes wack-prompt-blur-<user>-* that do not end in -<hash>.png
       ├── Prunes stray files in /var/tmp/wack/vibrancy
       └── Prunes dynamic slideshow directories: sorts by mtime, deletes directories beyond MAX_DYNAMIC_DIRS (4)

Manual Flush:
  └── prefs.js: _flushWackCache() / alphaCache.js: flushAllCache()
       ├── clearCache() (increments _generation, clears Map)
       ├── Deletes all files in /var/tmp/wack/cache/
       ├── Deletes all non-general folders in /var/tmp/wack/vibrancy/
       ├── Deletes all files in /var/tmp/wack/shared/
       ├── Deletes legacy files in /var/tmp/wack-*
       └── Re-creates directories with mode 01777
```

---

## E. Cache Identity Model

Cache identity is constructed through explicit composite string keys and cryptographic checksums:

### 1. Clock Alpha Key (`alphaManager.js:103`)
```
${targetUri}_${mtime}_${size}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${textLuminance}${progressKey}
```
*   `targetUri`: Normalized URI (`file:///...` or resolved XML static slide path).
*   `mtime`: 64-bit unsigned integer modification timestamp of the underlying source image file.
*   `size`: 64-bit file byte size.
*   `isColor`: Boolean flag indicating solid/gradient color background.
*   `primaryColor` / `secondaryColor`: Hex strings (e.g. `#2e3436`).
*   `shadingType`: Integer enum (`0`=Solid, `1`=Vertical, `2`=Horizontal).
*   `textLuminance`: Floating point number (default `1.0` for white text).
*   `progressKey`: `_prog<0.00..1.00>` (only present for dynamic slideshow transitions, rounded to 2 decimal places).

### 2. Prompt Vibrancy Key (`alphaManager.js:444`)
```
prompt_grad_${targetUri}_${mtime}_${size}_${isColor}_${primaryColor}_${secondaryColor}_${shadingType}_${pictureOptions}_${monitorWidth}x${monitorHeight}_${boundsKey}_cb${cancelBoundsKey}_av${avatarBoundsKey}_a11y${a11yBoundsKey}_sess${sessionBoundsKey}_b${PROMPT_BLUR_RADIUS}_pbr${PROMPT_BLUR_BRIGHTNESS}_chov${CANCEL_BUTTON_HOVER_OVERLAY_ALPHA}_cact${CANCEL_BUTTON_ACTIVE_OVERLAY_ALPHA}_cover_vis${PROMPT_VISUAL_ALGORITHM_VERSION}_vm${vibrancyMode}${progressKey}
```
*   Captures all source identity parameters (`targetUri`, `mtime`, `size`, `primaryColor`, `secondaryColor`, `shadingType`).
*   Captures display environment: `pictureOptions` (`zoom`, `scaled`, `stretched`, etc.) and `monitorWidth x monitorHeight`.
*   Captures spatial coordinates (normalized to 4 decimal places): `boundsKey` (prompt entry), `cancelBoundsKey`, `avatarBoundsKey`, `a11yBoundsKey`, `sessionBoundsKey`.
*   Captures visual tuning constants: `PROMPT_BLUR_RADIUS` (50), `PROMPT_BLUR_BRIGHTNESS` (1.0), hover/active alphas.
*   Captures algorithm generation version: `PROMPT_VISUAL_ALGORITHM_VERSION` (27).
*   Captures mode: `vibrancyMode` (`tonal`, `less`, `acrylic`, `blur`).
*   Captures transition state: `progressKey`.

### 3. Blurred Slice Image File Identity (`alphaManager.js:691`)
```
hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, cacheKey, -1).substring(0, 8)
filePath = `${targetDir}/wack-prompt-blur-${userName}-${hash}.png`
```
*   `targetDir`: `/var/tmp/wack/vibrancy/general` (for static wallpapers) or `/var/tmp/wack/vibrancy/<sanitizedXmlName>` (for XML slideshows).
*   `hash`: First 8 hexadecimal characters of the MD5 checksum of the full prompt vibrancy `cacheKey`.

### 4. Shared Cross-Session Wallpaper Identity (`crossSessionManager.js:179`)
```
filePath = `/var/tmp/wack/shared/wack-shared-wallpaper-${userName}-${timestamp}.jpg`
metaPath = `/var/tmp/wack/shared/wack-shared-wallpaper-${userName}.json`
```

### 5. GDM In-Memory Palette Key (`gdmThemePipeline.js:266`)
```
paletteKey = `${imageKey}|${vibrancyMode}`
```
*   `imageKey`: For transitions: `${slide.from}>${slide.to}@${slide.progress}`; for static: `slide.filePath` or resolved GDM URI.

---

## F. Validity & Freshness Model

| Aspect | Validation Mechanism | Current Reality / Implementation |
| :--- | :--- | :--- |
| **JSON Schema Integrity** | `data.__schema__ === CACHE_SCHEMA_VERSION (1)` | Verified on file load in `alphaCache.js:114`. If mismatched, file is deleted asynchronously. |
| **Visual Algorithm Version** | `data.__visual_version__ === PROMPT_VISUAL_ALGORITHM_VERSION (27)` | Verified on file load in `alphaCache.js:115`. Mismatch causes entire cache file deletion. |
| **Entry Structural Validation** | `_validateCacheEntry(key, value)` | Keys must be strings (1..4096 chars). Numbers must be finite 0.0..1.0. Objects must have valid RGB fields (`0..255`), `useInverse` boolean, and finite `shadowAlpha`. |
| **Source File Changes** | `mtime` and `size` in composite key | Monitored by polling/event triggers. If source file is modified or replaced, key changes, resulting in a cache miss. |
| **Slice Image File Existence** | `Gio.File.query_exists(null)` | On cache hit in `acrylic`/`blur` mode, `alphaManager.js:456` verifies `cached.imagePath` still physically exists on disk before accepting the cached result. |
| **Shared Metadata Freshness** | Content comparison in `crossSessionManager.js:253` | Checks `source_uri`, `source_mtime`, `source_size`, `style`, `primary_color`, `secondary_color`, `shading_type`, `resolved_slide_path`, and `resolved_slide_progress`. If matched and target JPEG exists, reuse; else re-render. |
| **GDM Palette Freshness** | `_isPaletteValid(theme)` in `gdmThemePipeline.js:269` | Validates that palette mode matches current `_vibrancy`, palette image matches `theme.image`, and for non-solid modes, that `imagePath` exists on disk. |

---

## G. Invalidation Matrix

| Trigger | Detection Mechanism | Invalidation Action | Rebuild? | Owner |
| :--- | :--- | :--- | :--- | :--- |
| **Wallpaper Image Content Modified** | `getFileMtimeAndSize()` returns new `mtime`/`size` | Cache key mismatch (old key orphaned in LRU) | Yes, on next query | `alphaManager.js` |
| **Wallpaper Selection / URI Changed** | `changed::picture-uri[-dark]` signal on `bgSettings` | Sequence number incremented (`_wallpaperUpdateSeq++`), new query issued | Yes | `extension.js`, `crossSessionManager.js` |
| **Prompt Bounds / Layout Relayout** | `allocation` event or monitor geometry change | Bounds in composite key changes | Yes | `alphaManager.js`, `promptStyling.js` |
| **Vibrancy Mode Changed** | `changed::prompt-vibrancy` signal on `settings` | Key suffix `_vm<mode>` changes; GDM enqueues all themes | Yes | `alphaManager.js`, `gdmThemePipeline.js` |
| **Algorithm Version Bumped** | Code constant `PROMPT_VISUAL_ALGORITHM_VERSION` modified | `initCache()` detects version mismatch on disk read -> deletes JSON file | Yes, lazy rebuild | `alphaCache.js` |
| **XML Slideshow Step Transition** | `GLib.timeout_add` timer (`_armSlideClock`) expires | `progress` step changes -> key `_prog<P>` changes | Yes (pre-cached during idle) | `alphaManager.js`, `gdmThemePipeline.js` |
| **Resume from Sleep / Hibernate** | `prepare-for-sleep` signal on `Main.screenShield._loginManager` | Re-triggers `_updateClockAlphaAndPromptColor()` | Yes (hits cache if static, rebuilds if transitioned) | `extension.js` |
| **Manual User Cache Flush** | User clicks "Flush Cache" in Extension Preferences | `flushAllCache()` / `_flushWackCache()` deletes `/var/tmp/wack/*` files | Yes, on subsequent lock | `prefs.js`, `alphaCache.js` |
| **Slice Image Deleted / Missing** | `Gio.File.query_exists(cached.imagePath)` is `false` | Cache hit rejected in `alphaManager.js:456` | Yes, re-runs slice blur & generation | `alphaManager.js` |
| **Extension Disable** | `disable()` lifecycle hook | `clearCache()` called: increments `_generation`, clears in-memory Map | No (disk files retained) | `extension.js` |

---

## H. Storage Model

### 1. Filesystem Directory Layout
```
/var/tmp/wack/                         [drwxrwxrwt (1777)] Sticky base root
├── cache/                             [drwxrwxrwt (1777)] JSON value caches
│   └── wack-wallpaper-alpha-cache-<username>.json  [0600, owner: <user>]
├── shared/                            [drwxrwxrwt (1777)] Cross-session IPC exchange
│   ├── wack-shared-wallpaper-<username>.json       [0644, owner: <user>]
│   └── wack-shared-wallpaper-<username>-<ts>.jpg   [0644, owner: <user>]
└── vibrancy/                          [drwxrwxrwt (1777)] Processed PNG slices
    ├── general/                       [drwxrwxrwt (1777)] Slices for static wallpapers
    │   └── wack-prompt-blur-<user>-<hash>.png      [0644, owner: <user>]
    └── <sanitized_xml_slideshow_name>/[drwxrwxrwt (1777)] Slices for dynamic wallpapers
        └── wack-prompt-blur-<user>-<hash>.png      [0644, owner: <user>]
```

### 2. File Formats & Serialization
*   **Alpha Cache JSON Envelope (`alphaCache.js:170`)**:
    ```json
    {
      "__schema__": 1,
      "__visual_version__": 27,
      "entries": {
        "<cacheKey>": 0.684,
        "<promptCacheKey>": {
          "r": 45, "g": 52, "b": 60,
          "start": { "r": 50, "g": 58, "b": 68 },
          "end": { "r": 42, "g": 48, "b": 55 },
          "noise": 0.012,
          "direction": "none",
          "vibrancyMode": "tonal",
          "imagePath": null,
          "cancelColor": { "r": 55, "g": 62, "b": 72, "useInverse": false },
          "avatarColor": { "r": 55, "g": 62, "b": 72, "useInverse": false },
          "a11yColor": { "r": 48, "g": 55, "b": 64, "useInverse": false },
          "sessionColor": { "r": 48, "g": 55, "b": 64, "useInverse": false },
          "shadowAlpha": 0.045,
          "useInverse": false,
          "visualState": { ... }
        }
      }
    }
    ```
*   **Shared Wallpaper Metadata Envelope (`crossSessionManager.js:428`)**:
    ```json
    {
      "username": "user",
      "source_uri": "file:///usr/share/backgrounds/gnome/adwaita-d.xml",
      "source_mtime": 1727000000,
      "source_size": 2048,
      "slideshow_xml_text": "<background>...",
      "color_scheme": 1,
      "resolved_slide_path": "/usr/share/backgrounds/gnome/adwaita-dark.jpg",
      "resolved_slide_progress": 0.0,
      "uri": "file:///var/tmp/wack/shared/wack-shared-wallpaper-user-1727500000000.jpg",
      "style": 2,
      "primary_color": "#000000",
      "secondary_color": "#000000",
      "shading_type": 0,
      "is_color": false,
      "clockFormat": "24h",
      "dateStyle": "full",
      "userLocale": "en_US.UTF-8",
      "clockAlpha": 0.65,
      "promptColor": { ... },
      "promptVibrancy": true,
      "promptVibrancyMode": "tonal",
      "cursorBlink": true,
      "lockscreenMode": "cupertino",
      "lockscreenMessageText": "",
      "lockscreenMessageEnable": false
    }
    ```

### 3. Filesystem Write Semantics & Permissions
*   **JSON Cache Writes (`alphaCache.js:186`)**: Uses `replace_contents_async()` with `Gio.FileCreateFlags.REPLACE_DESTINATION` (atomic temporary file + rename semantics provided by GVFS). Mode is set post-write to `0600`.
*   **Shared Metadata Writes (`crossSessionManager.js:457`, `gdmWallpaperManager.js:188`)**: Uses synchronous `replace_contents()` with `Gio.FileCreateFlags.REPLACE_DESTINATION`, followed by `set_attribute_uint32('unix::mode', 0o644)`.
*   **PNG Blur Slice Writes (`alphaManager.js:716`)**: Uses synchronous `GdkPixbuf.Pixbuf.savev(filePath, 'png', [], [])`, directly overwriting the destination file, followed by `set_attribute_uint32('unix::mode', 0o644)`.
*   **JPEG Downscaled Wallpaper Writes (`crossSessionManager.js:357, 403`)**: Uses `GdkPixbuf.Pixbuf.savev(targetPath, 'jpeg', ['quality'], ['80'])` with a timestamped filename, followed by unlinking older timestamped user JPEGs.

---

## I. Lifecycle State Machine

```
[ IN-MEMORY STATE MACHINE (alphaCache.js) ]

               ┌──────────────────────────────────────────────┐
               │                                              │
               ▼                                              │
      [ UNINITIALIZED ] ─── initCache() ───► [ LOADING ]     │
               ▲                                  │           │
               │                           load success       │
               │                                  │           │
          clearCache()                            ▼           │
               │                              [ READY ]       │
               │                                  │           │
               │                             setCache()       │
               │                             saveCache()      │
               │                                  │           │
               │                             _flushSave()     │
               │                                  │           │
               │                              (_saving=true)  │
               │                                  │           │
               └──────────────────────────────────┴───────────┘


[ PERSISTENCE & SAMPLING LIFECYCLE ]

       [ Input Event ]
              │
              ▼
   [ Key Generation ]
              │
              ├─► In-Memory Cache Match? ───────────► [ HIT: Return cached ]
              │
              ▼ (Miss)
   [ Load / Scale Pixbuf ]
              │
              ├─► [ Sample Average Colors ]
              │
              └─► [ Acrylic / Blur Mode? ]
                        │
                        ├─► Dynamic Downsample & BoxBlur
                        ├─► Write Slice PNG (/var/tmp/wack/vibrancy)
                        └─► Prune Old Slices & Dynamic Dirs
              │
              ▼
   [ Resolve Prompt Visual State ]
              │
              ▼
   [ Populate In-Memory LRU Map ] (Evict oldest if > 64)
              │
              ▼
   [ Debounced Save Scheduled ] (Promise Microtask)
              │
              ▼
   [ Async Atomic Write to Disk JSON ] (/var/tmp/wack/cache)
              │
              ▼
   [ CrossSessionManager Sync ] -> Write Shared JPEG & Metadata
```

---

## J. Concurrency Model

### 1. Concurrency Actors
*   **Main Thread Async Operations**: GNOME Shell is single-threaded (SpiderMonkey event loop + GLib main context). Multiple concurrent asynchronous operations (`load_contents_async`, `read_async`, `replace_contents_async`, `query_info_async`) interleave across event loop ticks.
*   **Multi-Process Interactions**:
    *   User session running `crossSessionManager.js` writes to `/var/tmp/wack/shared/` and `/var/tmp/wack/vibrancy/`.
    *   GDM greeter session running as user `gdm` reads from `/var/tmp/wack/shared/` via `Gio.FileMonitor` and `GdmThemeStore`.
    *   Preferences dialog (`prefs.js`) running in a separate sub-process or in-process flushing `/var/tmp/wack/`.
*   **Background Workers / Timers**:
    *   `precacheSlideshow()` background warmup running unawaited async chains on startup and lock.
    *   `_slideTimerId` slideshow progression timers in `alphaManager.js` and `gdmThemePipeline.js`.
    *   `GdmThemeStore._idleId` idle priority queue drainer (`_drainOne`).

### 2. Synchronization Mechanisms & Races
*   **Generation Counter (`_generation` in `alphaCache.js`)**: Guard variable incremented on `clearCache()`. Asynchronous `initCache()` and `_flushSave()` callbacks compare local generation snapshots (`currentGen`) against `_generation` to discard stale async I/O completions.
*   **Sequence Monotonicity (`_wallpaperUpdateSeq` in `extension.js`)**: Incremented before async wallpaper analysis; results returning with `seq !== this._wallpaperUpdateSeq` are discarded to prevent race-induced visual flickering on rapid wallpaper changes.
*   **Save Request Latching (`_saving`, `_dirty`, `_saveRequested`, `_saveScheduled`)**: Implements non-overlapping sequential file writes. If a save is requested while a previous async write is in flight, `_saveRequested` is latched and executed on completion.
*   **GDM Idle Queue Lock (`_busy` in `gdmThemePipeline.js`)**: Prevents overlapping `_drainOne()` executions while processing pending user themes.
*   **Identified Race Hazards**:
    1.  *Read-while-write in Shared Directory*: `crossSessionManager.js` writes metadata synchronously (`replace_contents`), but `GdmWallpaperManager` triggers on `Gio.FileMonitorEvent.CHANGED`. If `loadUser()` executes concurrently while `crossSessionManager` writes the accompanying downscaled JPEG, GDM may encounter a missing or partially copied JPEG file.
    2.  *Slice Generation Stampede*: If multiple requests for the same uncached XML slide transition occur in rapid succession before the first completes, both will concurrently downsample, blur, and overwrite the same PNG slice on disk.

---

## K. Failure Matrix

| Failure Scenario | Current Behavior | Recovery Mechanism | Residual State |
| :--- | :--- | :--- | :--- |
| **Cache Directory Missing (`/var/tmp/wack/cache`)** | `_ensureCacheDirectory()` checks and recreates directory with mode `01777` | Automatic directory creation | Directory created |
| **Corrupted / Invalid JSON Cache File** | JSON parse throws error in `initCache()` catch block | `file.delete_async()` removes the corrupted file; `_state` transitions to `READY` | Broken file removed, fresh in-memory cache |
| **Incompatible Cache Schema or Visual Version** | Version check fails in `initCache()` (`__schema__ !== 1 \|\| __visual_version__ !== 27`) | Discards stale file via `file.delete_async()`; starts with empty in-memory Map | Stale cache purged from disk |
| **Missing Slice PNG on Disk** | Cache validation checks `Gio.File.query_exists(cached.imagePath)` | Hit is rejected; falls through to re-run full pixbuf scale and box blur | New slice PNG regenerated and written |
| **Wallpaper Image Load Error / Unreadable Source** | `try...catch` block in `alphaManager.js:218, 916` catches exception | Falls back to default RGB `{ r: 40, g: 40, b: 40 }` and baseline alpha `0.6` | Fallback entry cached |
| **XML Slideshow Syntax Error** | RegEx / XML parser returns `null` or throws | Falls back to static color or dark grey default | No slideshow entry cached |
| **Disk Full / Permission Denied during Save** | `replace_contents_async` or `savev` throws | Error caught in `catch (e)` block; logged via `_logError` | In-memory cache continues serving reads; disk write dropped |
| **GDM Accessing Unreadable User Home Wallpaper** | `resolveGdmAccessibleUri()` checks file existence | Falls back to shared world-readable copy `/var/tmp/wack/shared/` or fallback theme | GDM fallback theme rendered |
| **Concurrent Disconnection during Async Load** | `_generation !== currentGen` check fires | Callback resolves immediately without populating `_cache` | Stale data discarded |

---

## L. Ownership Matrix

| Responsibility | Current Owner | Evidence (File & Line) |
| :--- | :--- | :--- |
| **Cache Key Computation** | `alphaManager.js` | `src/main/alphaManager.js:103` (`getWallpaperAlpha`), `alphaManager.js:444` (`getWallpaperPromptColor`) |
| **In-Memory Cache Storage** | `alphaCache.js` | `src/main/alphaCache.js:25` (`const _cache = new Map()`) |
| **Cache Serialization / Deserialization** | `alphaCache.js` | `src/main/alphaCache.js:108` (`JSON.parse`), `alphaCache.js:178` (`JSON.stringify`) |
| **Cache File Persistence** | `alphaCache.js` | `src/main/alphaCache.js:186` (`file.replace_contents_async`) |
| **Blur & Image Processing** | `wallpaperSampler.js` | `src/main/wallpaperSampler.js:13` (`fastBoxBlur`), `wallpaperSampler.js:82` (`createBlurredPromptSlice`) |
| **Color Policy Decisions** | `colorUtils.js` | `src/main/colorUtils.js:331` (`resolvePromptVisualState`), `colorUtils.js:257` (`resolveBaseVisualPolicy`) |
| **Disk Cleanup / Eviction Policies** | `alphaManager.js` & `alphaCache.js` | `src/main/alphaManager.js:750` (slice pruning), `src/main/alphaManager.js:805` (slideshow dir pruning), `src/main/alphaCache.js:273` (`flushAllCache`) |
| **Cross-Session State Export** | `crossSessionManager.js` | `crossSessionManager.js:137` (`_saveWallpaper`), `crossSessionManager.js:457` (`replace_contents`) |
| **GDM State Ingestion & Queueing** | `gdmThemePipeline.js` | `src/pro/gdmThemePipeline.js:24` (`GdmThemeStore`), `gdmThemePipeline.js:346` (`_drainOne`) |
| **GDM Multi-Monitor Texture Caching** | `gdmThemePipeline.js` | `src/pro/gdmThemePipeline.js:575` (`GdmWallpaperView._monitors[].stacks`) |

---

## M. Sources of Truth

| State Domain | Authoritative Source of Truth | Derived / Cached Representations |
| :--- | :--- | :--- |
| **User Wallpaper Configuration** | GNOME GSettings (`org.gnome.desktop.background`) & Extension Settings | `crossSessionManager.js` metadata file (`wack-shared-wallpaper-<user>.json`) |
| **Active Wallpaper Pixels** | Raw wallpaper image file on disk (`/usr/share/backgrounds/...`) | Scaled Pixbufs, Shared JPEG (`/var/tmp/wack/shared/*.jpg`), Blurred PNG slices (`/var/tmp/wack/vibrancy/.../*.png`) |
| **Perceptual Color & Visual Rules** | Pure functions in `colorUtils.js` (`PROMPT_VISUAL_ALGORITHM_VERSION = 27`) | Cached `PromptVisualState` objects in `alphaCache.js` and GDM `_paletteCache` |
| **Computed Clock Alpha & Prompt Colors** | `alphaCache.js` in-memory `Map` (authoritative during session runtime) | Disk JSON (`/var/tmp/wack/cache/wack-wallpaper-alpha-cache-<user>.json`) |
| **GDM Active Theme / Styling** | `GdmThemeStore._themes` Map (keyed by username) | `GdmWallpaperView._monitors[].stacks` Clutter actors |

---

## N. Observability

### 1. Existing Diagnostics & Logging
*   `_log()` / `_logError()` wrappers across `mainUtils.js` and `gdmUtils.js` writing to `console.debug` / `console.error` (viewable via `journalctl -f -o cat /usr/bin/gnome-shell`).
*   Logging emitted on:
    *   `[WACK/AlphaManager] Failed to read/scale wallpaper for luminance`
    *   `[WACK/AlphaManager] Failed to save blurred prompt slice`
    *   `[WACK/AlphaManager] Failed to clean old slice cache`
    *   `[WACK/AlphaManager] Pre-cache slide error for <file>`
    *   `[WACK/CrossSession] Wallpaper file modified on disk, triggering save`
    *   `[WACK/CrossSession] Successfully optimized and saved resolved wallpaper JPEG`
    *   `[WACK/GdmWallpaperManager] Failed to monitor shared wallpaper directory`
    *   `[WACK/ThemeStore] loadUserSync <user>` / `_drainOne` errors

### 2. Observability Gaps
*   **Cache Hit / Miss Telemetry**: No logging or counters indicating whether a lookup resulted in an L1 memory hit, L2 disk hit, or L3 generation miss.
*   **Performance Metrics / Timings**: No timing logs measuring duration of `fastBoxBlur()`, pixbuf downscaling, or disk I/O.
*   **Cache Size / Memory Footprint Visibility**: No runtime query to inspect the current size or memory usage of `_cache` or `_paletteCache`.

---

## O. Test Coverage

### 1. Existing Test Inventory
*   **Unit / Integration Tests**: No automated test suites (`test/`, `spec/`, or Mocha/Jasmine/GTest files) exist in the repository.
*   **Diagnostic Scripts**: `scripts/gdm-troubleshoot.sh` acts as an executable diagnostic tool for GDM dconf override inspection and repair.

### 2. Uncovered Critical Behaviors
*   Cache serialization / deserialization roundtrip validation.
*   Cache eviction logic when `MAX_CACHE_ENTRIES` (64) is reached.
*   Cache invalidation on `PROMPT_VISUAL_ALGORITHM_VERSION` increment.
*   Multi-user collision safety in `/var/tmp/wack/`.
*   Asynchronous race recovery when `clearCache()` interrupts an in-flight `initCache()`.
*   XML slideshow time calculation across DST changes and leap days.

---

## P. Architectural Smells

### 1. Duplicated Cache Cleaning Logic
*   **Evidence**: Identical filesystem traversal and deletion code for `/var/tmp/wack/cache`, `/var/tmp/wack/vibrancy`, `/var/tmp/wack/shared`, and legacy `/var/tmp` files is duplicated across `alphaCache.js:273` (`flushAllCache`) and `prefs.js:65` (`_flushWackCache`).
*   **Consequence**: Maintenance hazard where changes to directory structure, permissions, or pruning rules in one file leave the other stale or broken.

### 2. Direct Filesystem Pruning Inside Color Computation Path
*   **Evidence**: `alphaManager.js:748-830` performs synchronous filesystem enumeration, deletion of sibling slice PNGs, and directory deletions of dynamic slideshow folders directly inside the `getWallpaperPromptColor()` computation loop.
*   **Consequence**: Disk I/O latency and directory locks are injected directly into the user interaction / lockscreen rendering path.

### 3. Synchronous Heavy I/O on Settings Changes
*   **Evidence**: `crossSessionManager.js:137` executes synchronous `GdkPixbuf.Pixbuf.new_from_file()`, `scale_simple()`, `savev()`, and `replace_contents()` on the main Clutter thread whenever background settings change.
*   **Consequence**: Can introduce frame drops or momentary UI stutters in GNOME Shell when changing wallpapers or switching light/dark color schemes.

### 4. Fragmented Cache Identity Construction
*   **Evidence**: Cache keys are constructed manually via template literal strings in `alphaManager.js:103` and `alphaManager.js:444` spanning over 20 concatenated parameters, while GDM uses a separate `_paletteKey()` convention in `gdmThemePipeline.js:266`.
*   **Consequence**: Fragile key generation where adding or renaming a visual parameter in one module silently breaks cache invalidation or causes cache misses in another.

---

## Q. Critical Unknowns

1.  **Multi-Seat GDM Behavior**: Whether systems with multi-seat GDM configurations (`seat0`, `seat1`) create separate `/var/tmp/wack/` namespace collisions if users on different seats share the same username.
2.  **SELinux / AppArmor Mandatory Access Controls on /var/tmp**: On certain strict distributions (e.g. Fedora Silverblue / openSUSE MicroOS), whether cross-user reads from `/var/tmp/wack/shared/` by the `gdm` user are blocked by default SELinux transitions (`xdg_cache_t` vs `gdm_t`).
