# Silksong: iPad Safari optimization audit

> **Baseline document:** this audit and its CSV inventories describe the original checkout. A subsequent implementation changed the player and assets; see [the current implementation status and limitations](../README.md).

**Inspected checkout:** `bcbe014765f2f6ca4b1d82ac25755a0299a600ab`
**Date:** 2026-10-14
**Target:** Safari on an iPad with 6 GB physical RAM; exact model and iPadOS version not yet supplied.
**Status:** Static audit, not an iPad benchmark. No game assets or runtime code have been changed or deleted.

## Conclusion

There are substantial optimization opportunities, but **this is primarily a memory/loading architecture problem, not a “delete a few videos” problem**.

1. The HTML downloads a **1.94 GiB split ZIP in its entirety**, then extracts it in the browser before launching Unity.
2. The compiled WebAssembly module declares **2,048 MiB initial linear memory**, with a **4,080 MiB maximum**.
3. Large asset groups and desktop-oriented texture formats need attention after startup is fixed.
4. The fork's page currently resolves assets against **a different upstream repository**. Local asset changes would not necessarily be used.
5. This checkout contains a **compiled Unity web player, not the editable Unity project**. Safe loader changes are possible here; source-level scene, texture, audio and quality optimization is substantially easier with the Unity project.

A 6 GB iPad does not give one Safari tab a guaranteed 6 GB budget. OS, browser, WebAssembly, JavaScript, decoded audio/video and GPU allocations all compete for memory. The exact process-kill threshold is not established by this audit, and no fixed “safe Safari RAM limit” should be promised.

## 1. What is actually in the repository?

Sizes below use MiB/GiB (powers of 1024), not decimal MB/GB. They exclude `.git` history and these audit documents.

| Content | Count | Stored size |
|---|---:|---:|
| Tracked files, total | 292 | 2,428,647,729 bytes / 2.26 GiB |
| `StreamingAssets/aa/WebGL.zip.part1` through `.part100` | 100 | 1,986.64 MiB |
| Loose `StreamingAssets/aa/WebGL/*.bundle` files | 144 | 237.40 MiB |
| `StreamingAssets/VideoClip/*.webm` | 26 | 53.57 MiB |
| `Build/*` | 4 | 34.05 MiB |
| `TemplateData/*`, including icons | 11 | 0.022 MiB |

The ZIP contains **21 additional bundles**, expanding to **2,371.34 MiB** of bundle files. None of those 21 exists in the loose `WebGL/` folder. They are explicitly listed in `.gitignore`. **The archive and loose bundles are not redundant copies of one another.**

Together, the archive entries and loose folder provide **165 bundles**, totaling **2,608.74 MiB** before Unity's internal block decompression. All 165 filenames occur in `catalog.bin`; that establishes catalog presence, not which assets are reachable in a particular playthrough.

The bundle headers identify **Unity 6000.0.50f1**. `settings.json` identifies **Addressables 2.4.6**, with `m_maxConcurrentWebRequests: 3`. The HTML ZIP downloader bypasses that concurrency setting.

There are no Unity `Assets/`, `ProjectSettings/` or `Packages/` project directories, or C# gameplay source files in this checkout.

## 2. Highest-priority problems and fixes

### P0 — Stop loading upstream assets unintentionally

**Evidence:** `index.html:4` sets the base URL to `web-ports/hollow-knight-silksong@master`, and `index.html:231` loads that upstream's loader at `@latest`. `Build/w-pt.loader.js:72` overrides `streamingAssetsUrl` using the `<base>` element.

**Fix:** Make the page, loader, framework, WASM, catalog and bundles come from one controlled deployment/version. Prefer consistent relative URLs, or an explicitly pinned asset host. Adjust the loader's hard-coded `<base>` access too: simply removing the element currently makes that line fail.

Do this before testing reductions. Otherwise a locally modified file might never be requested, or different versions of the loader and assets might be mixed.

### P0 — Remove the all-assets ZIP installation step from Safari

**Evidence in `index.html`:**

- Lines 111–145 retain response chunks, then copy each part into a contiguous `Uint8Array`.
- Lines 149–156 start all 100 fetches with `Promise.all`, retain every result, and create a combined `Blob`.
- Line 74 passes that complete blob to `JSZip.loadAsync`.
- Lines 81–97 inflate **ten bundle files concurrently** and write their blobs into Cache Storage.
- Lines 175–179 require this installation to finish before Unity starts.

This creates multi-gigabyte input and extraction workloads. Actual peak resident memory depends on Safari's blob backing, garbage collection and cache implementation; the archive size must not be presented as an exact measured RAM peak. Nevertheless, this is a clear high-risk startup design.

**Preferred fix:** Extract the 21 bundles **during deployment, not on the iPad**, publish them at their catalog-expected paths, and let Addressables request bundles as needed. Preserve filenames and bytes for a delivery-only migration; verify CRCs and all requested paths. The two largest extracted bundles are about 481 and 334 MiB, so choose hosting that supports files of those sizes rather than attempting to add them as ordinary oversized Git blobs.

Once the replacement is working, remove the ZIP installation code, JSZip script inclusion and its dedicated install cache. The `.part*` files and `jszip.js` can then be omitted from the web deployment. This removes the mandatory whole-ZIP installation, **not the game's need for the underlying assets**. A startup scene may still immediately need large bundles.

**If hosting must retain split files:** a more complex fallback is an indexed, per-bundle reader that fetches only necessary ZIP ranges/parts, decompresses only the requested bundle with backpressure, and limits concurrency. The host must support the required request/range behavior. This is not achieved by changing `Promise.all` to a loop while still collecting the entire ZIP in memory.

Moving the same whole-archive operation into a Web Worker may improve responsiveness but does not eliminate its memory consumption. A PWA/home-screen install is not a memory-limit bypass either.

### P0 — Revisit the compiled 2 GiB initial heap

I decompressed `Build/w-pt.wasm.unityweb` and read its WASM memory section:

- Initial: **32,768 × 64 KiB pages = 2,048 MiB**.
- Maximum: **65,280 pages = 4,080 MiB**.
- The framework exports that WASM memory as `Kk`; it does not construct an externally configurable `INITIAL_MEMORY` in the inspected JavaScript.
- `getHeapMax()` returns `4278190080`.
- `_emscripten_resize_heap` tries approximately 20% geometric growth, with an extra-allocation cap of 512 MiB, and smaller retries.

This is a declared linear-memory size, **not proof that 2 GiB of physical RAM is resident immediately**. It is still an important configuration to revisit on Safari.

**Preferred fix:** Rebuild with measured, smaller initial memory; trial 256–512 MiB as starting experiments, not guaranteed adequate values. Tune growth against representative scenes. Check the compiled output after rebuilding.

With only this compiled build, a carefully validated binary-memory-minimum patch could be investigated separately. It must respect active data segments, stack/static requirements and early allocations, and survive startup/gameplay testing. Adding a small `TOTAL_MEMORY` value to the HTML is not evidence of a successful reduction. Artificially lowering the maximum without reducing real demand can merely replace a Safari reload with an out-of-memory abort.

### P1 — Reduce drawing resolution, without confusing this with texture memory

The wrapper fills the window and supplies no `devicePixelRatio` override. The framework defaults to `window.devicePixelRatio` and matches canvas size. The `width=960 height=600` HTML attributes therefore are not a reliable fixed render budget.

**First test:** cap `devicePixelRatio` at 1. For a stronger low-memory profile, explicitly control drawing-buffer size using the supported canvas-size configuration and a landscape render target near 960×600 or 1280×720, preserving the game's aspect ratio. Test orientation changes and touch coordinate mapping. Add a mobile viewport declaration and appropriate safe-area layout.

At the same CSS size, DPR 2 → 1 means **one-quarter as many rendered pixels**. That can reduce render-target memory, fill rate and GPU work; it does **not** quarter all game memory or shrink source sprite atlases.

Keep `preserveDrawingBuffer: false`, which the loader already sets. Do not count that as a new optimization. The framework already contains an `antialias: false` default in one context-creation path; inspect actual runtime context attributes and Unity render settings before claiming that disabling MSAA will save anything.

## 3. Large asset groups: what to optimize, not blindly delete

These are actual bundle sizes, after ZIP extraction where applicable. UnityFS expanded block totals are also shown to identify scale. **They are not measurements of simultaneously live RAM:** LZ4 blocks and individual assets may be accessed on demand.

| Bundle filename prefix | Bundle MiB | Expanded block MiB | Recommended action |
|---|---:|---:|---|
| `packed-scenes-hornet_scenes_all_…` | 480.95 | 3,248.96 | Rebuild scene groups by area/scene; profile loading and release across transitions. Essential gameplay. |
| `packed-collections_assets_all_…` | 333.68 | 1,914.04 | Inspect shared dependencies and asset residency; split only with a rebuilt dependency graph. |
| `packed-cinematics_assets_all_…` | 217.70 | 218.82 | Remove embedded movie payloads only after establishing which video delivery path is actually used. |
| `packed-sprites-scenery_assets_all_…` | 191.45 | 879.33 | Reduce scenery atlas resolution, use supported GPU compression, separate regional assets. |
| `packed-audio-hornetmusic_assets_all_…` | 175.22 | 177.18 | Lazy-load and release music; avoid unnecessary browser-side decoding/copies. |
| `packed-prefabs_assets_all_…` | 140.29 | 671.24 | Rebuild grouping and shared dependencies; essential objects must remain available. |
| `packed-animations-props_assets_all_…` | 120.42 | 509.92 | Reduce and partition atlases; the name does not mean the contents are only animation keyframes. |
| `packed-sprites-ui_assets_all_…` | 112.33 | 112.33 | Inspect texture sizes and duplicates; this bundle's block is uncompressed. |
| `packed-audio-hornetvoices_assets_all_…` | 108.50 | 117.45 | Downsample suitable effects/voices and load locally; do not strip gameplay sound cues indiscriminately. |
| `packed-audio-sfx_assets_all_…` | 95.46 | 101.07 | Reduce sample rate/channels selectively and release unused clips. |
| `packed-animations-hornet_assets_all_…` | 85.43 | 361.32 | Optimize player atlases carefully; essential player animations. |
| `packed-fonts_assets_all_…` | 50.93 | 117.13 | Optional single-language build with rebuilt font/fallback references. |

Most inspected blocks use LZ4HC already. Repacking everything with a “better compression ratio” is not a substitute for reducing resident textures or loaded assets, and ZIP/gzip compression is distinct from GPU texture compression.

Full hashed names and sizes are in `ipad-audit-bundles.csv`.

### Textures: an important iPad-specific target

Across all 165 bundles, the metadata contains **2,771 Texture2D records**: 1,382 RGBA32, 1,351 DXT5, 29 DXT1, 8 RGB24 and 1 Alpha8. **330 records have Read/Write enabled**, and the largest inspected dimensions are **8192×4096**. The sum of declared image sizes is 7.23 GiB across the whole asset set; this is neither a deduplicated texture total nor a simultaneous runtime-memory measurement.

These include **desktop DXT1/DXT5 textures**. Do not assume an iPad exposes S3TC/DXT support: query WebGL extensions on the exact device and inspect Unity's chosen upload/fallback path. Unsupported compressed textures may cause decompression, extra memory and stalls. In particular, the large `packed-collections` bundle contains 468 DXT5 Texture2D records; it is not merely a small list of object references.

Preferred rebuild changes:

- Use an iPad-compatible GPU-compressed variant, such as ASTC where the browser exposes it; validate ETC2 or another appropriate fallback. Do not merely rename DXT data.
- Reduce width and height of oversized atlases together. At unchanged format/mip policy, halving both dimensions reduces the affected pixel storage by about **75%**; it does not reduce all game RAM by 75%.
- Preserve sprite rects, pivots, borders and animation references when repacking. Shrinking raw images without updating sprite metadata can break rendering.
- Disable Read/Write on textures only where CPU access is unnecessary.
- Keep UI/text legible and avoid reducing detailed gameplay silhouettes too aggressively.
- Release Addressables handles and unused scene assets at sensible transitions. Released WASM allocations can be reused without shrinking the browser's linear-memory buffer.

Example: a single 4096×4096 RGBA32 image is 64 MiB before mipmaps. DXT5 at that resolution is about 16 MiB before mipmaps; an unsupported-format expansion can therefore be costly. These are format calculations, not observed iPad allocations.

### Audio: runtime residency matters more than muting

The inspected framework copies compressed audio out of the WASM heap in `_JS_Sound_Load` and has both decoded Web Audio and compressed media-element paths. It forces the decode path for clips under 131,072 bytes. Thus JavaScript/browser audio memory can exist in addition to the Unity heap.

The music bundle contains 180 AudioClips; their serialized load type is already `Streaming`. Simply proposing “switch music to streaming” would overlook this. Confirm the actual WebGL runtime behavior instead. Many other clips already use `CompressedInMemory`, but small-clip decoding can still occur.

Try lazy clip loading, unloading old tracks, fewer simultaneous voices, and suitable mono/downsampled effects. Lower bitrate mainly shrinks transfer/storage; lower sample rate/channel count affects decoded PCM size. Muting a track does not necessarily unload it. Desktop Unity audio import behavior must not be assumed identical in WebGL.

## 4. What can be removed or reduced?

### A. Real cutscene candidates — conditional, not safe blind deletions

| Content | Current size | Conditions |
|---|---:|---|
| All 26 `StreamingAssets/VideoClip/*.webm` files | 53.57 MiB | Implement a valid skip path, or replace with lower-resolution compatible clips. Preserve transition, completion and save/progression behavior. |
| `packed-cinematics_assets_all_5ec2ac5cfb98b69438cb91f6e253bbbc.bundle` | 217.70 MiB | Contains 26 VideoClips, **26 MonoBehaviours and 17 AudioClips**, not just disposable video bytes. Rebuild/strip payloads selectively. |
| `packed-animations-cutscene_assets_all_6088ab681e63b034a1b602249209347d.bundle` | 22.89 MiB | Contains cutscene animation/texture content; retain any assets used by playable transitions. Requires dependency checks. |
| `packed-audio-cinematics_assets_all_0e913cdd2d9e2cc715f27d82f5cc397a.bundle` | 4.46 MiB | Remove only where cutscene scripts no longer request it. |
| `packed-scenes-cinematic_*`, opening-sequence and ending scene bundles | See inventory | Scene logic may perform essential transitions. Replace with functional minimal scenes or edit callers; do not return 404s. |

The loose WebMs are VP9, approximately 1080p, mostly 30 fps; the two non-`_30` Bellbeast travel variants are 60 fps. The cinematics bundle has VideoClip records with matching names and embedded resource payloads. This is evidence of two representations of the cinematics, **not proof that either whole representation is unused**.

Options, in preference order:

1. Keep the story with 540p/720p, 30 fps clips and a tested hardware-friendly codec. Consider H.264/MP4 for the specific iPad/Safari combination, but update requested URLs/MIME types and verify alpha/aspect/audio requirements. Renaming `.mp4` bytes to `.webm` is not a fix.
2. Add an explicit “skip cinematics” mode whose game-side completion path performs the same required state changes.
3. If source changes are unavailable, investigate valid short replacement clips while preserving referenced names. This still requires testing video-end callbacks, scripted timing, separate audio tracks and state transitions. Empty/zero-byte files are unsafe.

Useful loose-file targets include `Intro_Cinematic.webm` (6.39 MiB), `Ending_A.webm` (5.78 MiB), `Lace_Battle.webm` (5.54 MiB), `Ending_E.webm` (4.15 MiB), and `Ending_C.webm` (3.99 MiB). Every clip is listed in `ipad-audit-videos.csv`.

The four main cutscene categories in the table total roughly **298.62 MiB** of stored payload. That is an upper-bound content category size, **not a guaranteed safe saving**, and certainly not 298.62 MiB of guaranteed live RAM reduction.

### B. Optional content requiring a rebuilt dependency graph

- **Vibration assets:** `packed-audio-vibrationfiles_assets_all_b6d16adc2f46677d45046b5f3c6aff41.bundle` is 6.37 MiB and contains 315 AudioClips plus MonoBehaviours/TextAssets. Candidate for a no-haptics profile, but remove its consumers/references too. Its filename alone is not permission to delete it.
- **Unused font/language coverage:** the font bundle is 50.93 MiB. An English-only edition might reduce it, but retain necessary glyphs, fallback fonts, UI and user-name coverage. Savings require actual font usage analysis.
- **Credits and decorative menu content:** candidates for simplification after checking end-game flow; small compared with core scenes/textures.
- **Assets with Hollow Knight-looking names:** `grimm`, `knight`, `gods_glory`, etc. are investigation candidates only. Reused names do not prove unused content. The catalog still mentions their bundles.

### C. Low-risk deployment cleanup — negligible memory benefit

- The unreferenced light-theme logos/progress bars, `TemplateData/icons/*` duplicates and `TemplateData/webmemd-icon.png` can be excluded after a final reference check. These total only about **16 KiB**. Keep the dark logo/progress assets used by CSS and the referenced favicon.
- `StreamingAssets/aa/AddressablesLink/link.xml` is approximately 113 KiB of build/linker metadata. It is a candidate to omit from a static player deployment, not something to delete from an editable source build indiscriminately.
- `jszip.js` is about 365 KiB, removable **only after replacing the ZIP loader**.
- `WebGL.zip.part*` can be omitted from deployment **only once all 21 replacement bundle URLs work**. They are not an immediate 1.94 GiB reduction of required game content.

Deleting files never requested by the browser reduces hosting/repository size, not gameplay RAM or frame time. There is no substantial, proven-safe “junk assets” deletion list in this checkout.

## 5. Reliability issues beyond raw memory

- **False cache success:** extraction catches per-file errors and still writes `CACHE_COMPLETE`. A quota failure can therefore leave an incomplete cache that future launches trust. Publish completion only after verification, or preferably eliminate this mandatory install cache.
- **Cache keys:** the global fetch override matches only URL basenames, ignoring directories, origin and method. It also assumes non-string fetch arguments have `.url`, which is not true of a standard `URL` object. Use narrowly scoped, canonical, versioned asset requests rather than patching every fetch.
- **Storage failures:** `caches.open` is assumed to work for every fetch. Handle unavailable storage, quota pressure and eviction without trapping the game in a failed install loop. Cache Storage is persistent storage, not inherently permanently resident RAM, but reads/writes and extraction have transient memory costs.
- **Layered caches:** Unity's loader also contains its own caching machinery. Audit which storage layers actually receive bundles before retaining a second all-assets install cache.
- **Versioning:** use hashes/build IDs, not a fixed global completion marker combined with mutable upstream `master`/`latest` paths.
- **Compression delivery:** the three `.unityweb` files are gzip streams. Decompressed sizes are 44.79 MiB data, 0.60 MiB framework JS and 78.75 MiB WASM. Serve correct encoding/content-type headers and avoid double compression. Validate the actual host response; it was not fetched in this audit. Proper server delivery can avoid JavaScript decompression fallback but does not shrink game heap/texture needs.
- **Input/audio:** the page has no explicit on-screen gamepad. Confirm whether the compiled game supplies usable touch controls; otherwise choose controller support or a tested touch overlay. Use a tap-to-start flow for audio/user activation. Engine gamepad/video-touch code alone does not establish a playable touch control scheme.
- **Backgrounding/saves:** test tab switching, screen lock, audio resume and save persistence. Handle visibility/context-loss events gracefully. Do not implement repeated automatic reloads that hide the failure or lose progress.

## 6. Recommended implementation order

### Phase 1 — Changes feasible around the existing build

1. Fix deployment URLs and loader path handling.
2. Publish the missing bundles separately and remove browser-wide ZIP installation.
3. Correct cache integrity/error handling and use a single deliberate caching strategy.
4. Add an iPad display profile, DPR cap, mobile viewport and explicit start/input flow.
5. Capture real-device startup/network/frame-time evidence before changing gameplay content.

**Expected benefit:** much lower startup pressure, less unnecessary downloading and reduced rendering cost. **Not a promise that every scene fits Safari.**

### Phase 2 — Build/runtime memory work

1. Rebuild/test smaller initial heap and growth settings, or separately validate a compiled-only experiment.
2. Produce mobile texture variants and reduce oversized atlases.
3. Split monolithic Addressables groups by area and release old handles/assets.
4. Improve audio residency and verify compressed-vs-decoded paths.
5. Add reduced/disabled cinematics with correct progression behavior.
6. Test an optional 30 fps low-power profile through an actual game/runtime frame-rate control, not merely by throttling a CSS animation or indiscriminately replacing `requestAnimationFrame`.

Texture/bundle repacking without source is possible in some cases but must preserve serialized references and regenerate matching size/hash/CRC/catalog data where required. It is materially riskier than a normal Unity rebuild.

### Phase 3 — Prove stability on the actual iPad

Test cold and warm starts; storage unavailable/full/evicted; all available control methods; orientation changes; the intro and travel cutscenes; representative complex areas/bosses; repeated area changes and deaths; a long play session; background/resume; and save/reload.

Record:

- Time and downloaded bytes to title and first playable area.
- WASM `HEAPU8.buffer.byteLength`, sampled modestly through the Unity instance.
- Frame-time distribution/stutters, not just average FPS.
- Safari Web Inspector memory/timeline and device process-kill evidence where available.
- Actual WebGL texture extensions, render-buffer dimensions, context losses and console failures.
- Storage usage/quota estimates and missing/failed network requests.

Do not rely on `performance.memory` as a Safari measurement or interpret WASM heap size as total process memory. A desktop browser test is useful for correctness but does not certify iPad stability.

## 7. Audit scope and evidence

The audit inventories every tracked path; inspects all split ZIP entries, all 165 bundle headers, the catalog/settings, HTML/CSS/loader, decompressed framework/data/WASM metadata, and all 26 WebM headers. Texture/audio/video object metadata was examined in **all 165 bundles**, using UnityPy 1.25.4, without rendering images or playing the game. The five largest expanded bundles were read using disk-backed streaming to avoid materializing their multi-gigabyte contents in the analysis process. ZIP/WASM/UnityFS/WebM structural metadata was also inspected with Python parsers. There are 9,344 AudioClip records across the bundles; these are not all necessarily loaded at once.

In the bundle CSV, `texture_declared_bytes` sums serialized `m_CompleteImageSize` values; it is not a process-memory measurement. `block_compression` keys 0 and 3 mean uncompressed and LZ4HC, respectively. `audio_load_type_counts` keys 0, 1 and 2 mean DecompressOnLoad, CompressedInMemory and Streaming; WebGL's eventual browser decoding path may differ from those import labels.

The Addressables dependency graph and gameplay call paths have **not** been fully reconstructed. Catalog filename presence and asset names are not reachability proofs. No arbitrary asset has been declared safely removable merely because it looks unfamiliar.

Supporting files:

- `ipad-audit-files.csv` — every original tracked file and byte size.
- `ipad-audit-bundles.csv` — every bundle, including ZIP-only entries, sizes and asset-type summaries.
- `ipad-audit-videos.csv` — every loose clip, bytes, codecs, dimensions, frame rate and duration.

**Still needed before promising playability:** exact iPad model/iPadOS version, preferred input method, and whether an editable Unity project is available. The earlier Hollow Knight optimization is useful experience, but this build's measured packaging and heap settings must be addressed on their own merits.
