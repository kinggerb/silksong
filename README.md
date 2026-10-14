# Silksong — low-memory web player

**Play:** https://kinggerb.github.io/silksong/

This is an optimization pass over the compiled Unity web export. It is **not a Unity source project** and is **not certified crash-free on iPad Safari**.

## What changed

- Removed the mandatory 1.94 GiB browser ZIP installation and JSZip dependency. An indexed streaming loader requests only needed ZIP entries, processes one archive bundle at a time, honors backpressure/cancellation, and checks decoded length and CRC32. It also works when a static server ignores byte ranges, without buffering whole parts.
- Unity streaming requests no longer retain an additional full-size JavaScript copy of each bundle. Non-streaming downloads keep their normal byte buffers.
- Lowered compiled WASM initial memory from **2,048 to 512 MiB**, retaining growth. Reduced geometric over-allocation from 20%/512 MiB cap to 5%/32 MiB cap. This is not a cap on eventual game memory.
- Added native streaming gzip decoding, with a local streaming fallback. Fixed the old loader's unconditional gzip detection, which could double-decompress already decoded files.
- Replaced all **26 loose cutscenes** with valid **one-second, 160×90** black videos. The original WebM paths remain valid. iPad playback uses a small H.264 MP4 fallback.
- Repacked the embedded cinematic bundle from **228,270,727 to 5,182,979 bytes**, retaining object IDs, 26 MonoBehaviours and all 17 original audio payloads. Updated the catalog's bundle hash, CRC, byte size and catalog cache version. The replacement is served directly; the old embedded movie payloads in the archive are not requested by the new catalog/loader.
- Added a **960×600 default drawing buffer**, DPR 1, an optional 1280×800 setting, optional configurable multi-touch keyboard controls, and heap diagnostics. Rendering no longer scales automatically to the iPad's Retina pixel count.
- All assets now resolve to **this deployment**, rather than a mutable upstream repository. Catalog/build/replacement responses are revalidated. The only deleted browser cache is the legacy `hksilksongcache-vN` installer cache; Unity save databases are not cleared.
- Archive extraction is limited to one bundle at a time; Unity's existing three-request scheduler remains in place for other content. Removed unused template images and build-only linker metadata.

**Content trade-off:** cinematics are intentionally skipped visually. Some separate cinematic audio or script-controlled delays may remain. Every story/ending/transition has not been play-tested.

## Important limits

The original archive parts remain necessary for the 20 large bundles that have no loose replacement. Deleting those parts would break the game. The game may request many shared bundles early even though it no longer installs the entire archive in advance.

In a local Chromium/software-WebGL test, Unity started at 512 MiB and reached the language-selection screen. Its heap later grew to approximately **2.2 GiB** while loading shared content. That is **not** total process/GPU/audio memory. A 6 GB iPad's tab may still run out of memory. Desktop testing does not establish iPad performance or Safari compatibility.

The smoke test also reported a non-fatal `Couldn't find a Game Manager` message during startup and repeated sound-not-loaded messages. These are recorded, not silently suppressed. A longer test, including an experiment with a one-request Addressables scheduler, became unresponsive and timed out in the 3.8 GiB sandbox; it was terminated. That scheduler experiment was reverted. Full gameplay and device testing are still required, and the longer test is not counted as a pass.

Scene-group splitting, mobile texture recompression/atlas resizing, audio-residency changes and safe removal of shared fonts/haptics were **not** applied blindly to this compiled export. Those require a correctly rebuilt dependency graph and gameplay validation, preferably from the original Unity project. No arbitrary WASM maximum-memory cap or global animation-frame throttle is used.

For the original measurements and remaining opportunities, see [the baseline audit](docs/IPAD_SAFARI_AUDIT.md). Its CSV inventories describe the **pre-optimization** files, not the current deployment.

## Playing on iPad

1. Open the play link in Safari and refresh if you still see the old rainbow loading screen.
2. Leave resolution at **960×600**, tap **Start game**, and keep the tab foregrounded while shared assets load. The toolbar reports active archive downloads; the canvas may be black between startup stages.
3. Use a controller/keyboard, or enable touch controls. In **Controls**, match the emulated keys to the game's keyboard bindings. The initial defaults are arrows, Z/X/C/A/S, Enter and Escape; they are configurable rather than a claim about every in-game setup.
4. If audio is blocked, tap the game canvas. **Stats** shows the WASM heap, not Safari's total memory.
5. If Safari reloads the tab, note the iPad model, iPadOS version and scene. Lower resolution helps GPU load but cannot fix all shared-asset memory pressure.

## Development and checks

Requires Python 3 and Node 22+. Runtime libraries are vendored; the browser does not depend on an npm/CDN service.

```sh
npm test                         # loader, cancellation, integrity and WASM tests
python scripts/serve.py           # http://localhost:8000/silksong/
node scripts/verify-streaming.mjs # verify every indexed bundle against the running server
```

`npm ci` installs optional development/browser-test tools. `scripts/browser-smoke.mjs` and `scripts/video-smoke.mjs` use Chromium, not Safari. On a minimal Linux host, Chromium also needs its NSS/NSPR shared libraries; the packaged serverless Chromium distribution includes an AL2023 library archive for environments where that is appropriate.

To reproduce binary transformations (the audited base commit must be available locally):

```sh
python -m pip install -r scripts/requirements.txt
python scripts/replace_videos.py
python scripts/compact_cinematics.py
python scripts/patch_build.py
python scripts/generate_manifest.py
npm test
```

The repacker validates original CRC/size/hash positions before editing the binary catalog. It fails closed if the source build differs. Never edit ZIP parts without regenerating and validating the index. fflate is vendored under its MIT license in `web/vendor/`.

## Deployment

GitHub Pages publishes `master` at the repository root. Changes are developed on a feature branch, pushed, and merged through a pull request. Check the **Pages build/deployment status** after merging; a merged PR alone does not prove deployment succeeded.
