import { createAssetFetch, readBodyWithProgress } from './asset-loader.js';

const $ = id => document.getElementById(id);
const canvas = $('unity-canvas');
const base = new URL('../', import.meta.url);
let instance, started = false, loadedAssetBytes = 0, lastStatusUpdate = 0;
const bindings = { jump: 'KeyZ', attack: 'KeyX', dash: 'KeyC', heal: 'KeyA', tool: 'KeyS' };
try {
  const saved = JSON.parse(localStorage.getItem('silksong-touch-bindings') || '{}');
  for (const action of Object.keys(bindings)) if (/^(Key[A-Z]|Space|ShiftLeft)$/.test(saved[action])) bindings[action] = saved[action];
} catch { /* Storage is optional. Never touch Unity's save database. */ }
const touchDevice = navigator.maxTouchPoints > 0;
$('touch-enabled').checked = touchDevice;
$('touch-toggle').checked = touchDevice;

function showError(error) {
  console.error(error);
  $('warning').textContent = `${error.message || error}\n\nReload this page to retry. If Safari reloads itself during gameplay, try the lower resolution. No saves or Unity databases are cleared by this player.`;
  $('warning').hidden = false;
  $('loading-panel').hidden = true;
  $('start-button').disabled = false;
}

async function cleanupLegacyInstaller() {
  try {
    if (!('caches' in window)) return;
    const names = await caches.keys();
    // Only the old ZIP installer. Do not erase unrelated origin storage/saves.
    await Promise.all(names.filter(n => /^hksilksongcache-v\d+$/.test(n)).map(n => caches.delete(n)));
  } catch (error) { console.info('Legacy cache cleanup skipped:', error.message); }
}

function assetProgress(event) {
  if (event.complete) loadedAssetBytes += event.loaded;
  const now = performance.now();
  if (!event.complete && now - lastStatusUpdate < 250) return;
  lastStatusUpdate = now;
  const title = event.name.replace(/^packed-/, '').split('_')[0];
  const text = event.complete ? '' : `${title}: ${(event.loaded / 1048576).toFixed(0)} / ${(event.total / 1048576).toFixed(0)} MiB`;
  $('asset-status').textContent = text;
  if (!$('loading-panel').hidden && text) $('loading-text').textContent = text;
}

$('start-button').addEventListener('click', async () => {
  if (started) return;
  started = true;
  $('start-button').disabled = true;
  const width = Number($('resolution').value);
  canvas.width = width; canvas.height = width * 5 / 8;
  $('start-panel').hidden = true;
  $('loading-panel').hidden = false;
  $('toolbar').hidden = false;
  setTouch($('touch-enabled').checked);
  canvas.focus({ preventScroll: true });
  try {
    if (!window.WebAssembly || !window.ReadableStream) throw new Error('This browser is too old for this player. Update iPadOS/Safari.');
    const nativeFetch = window.fetch.bind(window);
    const response = await nativeFetch(new URL('web/asset-manifest.json', base), { cache: 'no-cache' });
    if (!response.ok) throw new Error('Cannot load the asset index');
    const manifest = await response.json();
    window.fetch = createAssetFetch({ baseURL: base, manifest, fetcher: nativeFetch, onProgress: assetProgress, onError: showError });
    // No persistent storage is required to start. Cleanup runs independently.
    void cleanupLegacyInstaller();
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('Build/w-pt.loader.js', base).href;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Cannot load the Unity player script'));
      document.head.append(script);
    });
    const config = {
      dataUrl: new URL('Build/w-pt.data.unityweb', base).href,
      frameworkUrl: new URL('Build/w-pt.framework.js.unityweb', base).href,
      codeUrl: new URL('Build/w-pt.wasm.unityweb', base).href,
      streamingAssetsUrl: new URL('StreamingAssets', base).href,
      lowMemoryVideoUrl: new URL('StreamingAssets/VideoClip/placeholder.mp4', base).href,
      // Preserve the original product identifiers to avoid changing save identity.
      companyName: 'EDUrocks Group, Truffled, GN-Math',
      productName: 'Hollow Knight SilkSong', productVersion: '1.0',
      devicePixelRatio: 1, matchWebGLToCanvasSize: false,
      webglContextAttributes: { preserveDrawingBuffer: false, powerPreference: 1 },
      cacheControl: () => 'no-store',
      readBodyWithProgress,
      showBanner(message, type) {
        if (type === 'error') showError(new Error(message));
        else console.warn(message);
      },
    };
    instance = await createUnityInstance(canvas, config, progress => {
      $('progress').value = progress;
      if (!$('asset-status').textContent) $('loading-text').textContent = `Starting Unity… ${Math.round(progress * 100)}%`;
    });
    // Retained for diagnostics, not for forcing GC or editing save state.
    window.silksongInstance = instance;
    $('loading-panel').hidden = true;
    canvas.focus({ preventScroll: true });
  } catch (error) { showError(error); }
});

// Pointer-based multi-touch keyboard emulation. Keyboard/controller input is
// untouched. These are configurable defaults, not a claim about game bindings.
const heldPointers = new Map();
const heldCodes = new Map();
function keyInfo(code) {
  if (code.startsWith('Key')) return { key: code[3].toLowerCase(), keyCode: code.charCodeAt(3) };
  return { key: code === 'Space' ? ' ' : code === 'ShiftLeft' ? 'Shift' : code,
    keyCode: { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32, Enter: 13, Escape: 27, ShiftLeft: 16 }[code] };
}
function sendKey(type, code) {
  const info = keyInfo(code);
  canvas.dispatchEvent(new KeyboardEvent(type, { code, key: info.key, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true }));
}
function releasePointer(id) {
  const held = heldPointers.get(id);
  if (!held) return;
  heldPointers.delete(id);
  const count = heldCodes.get(held.code) - 1;
  if (count) heldCodes.set(held.code, count);
  else { heldCodes.delete(held.code); sendKey('keyup', held.code); }
  if (![...heldPointers.values()].some(v => v.button === held.button)) held.button.classList.remove('held');
}
function releaseAll() { for (const id of [...heldPointers.keys()]) releasePointer(id); }
for (const button of document.querySelectorAll('#touch-controls button')) {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    if (heldPointers.has(event.pointerId)) return;
    const code = button.dataset.key || bindings[button.dataset.action];
    canvas.focus({ preventScroll: true });
    heldPointers.set(event.pointerId, { code, button });
    const count = heldCodes.get(code) || 0;
    heldCodes.set(code, count + 1);
    if (!count) sendKey('keydown', code);
    button.classList.add('held');
    button.setPointerCapture(event.pointerId);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    button.addEventListener(type, event => { event.preventDefault(); releasePointer(event.pointerId); });
  }
  button.addEventListener('contextmenu', event => event.preventDefault());
}
window.addEventListener('blur', releaseAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
function setTouch(enabled) {
  releaseAll(); $('touch-controls').hidden = !enabled;
  $('touch-toggle').checked = enabled; $('touch-enabled').checked = enabled;
}
$('touch-toggle').addEventListener('change', event => setTouch(event.target.checked));
$('controls-button').addEventListener('click', () => { releaseAll(); $('controls-panel').hidden = false; });
$('close-controls').addEventListener('click', () => { $('controls-panel').hidden = true; canvas.focus({ preventScroll: true }); });
for (const action of Object.keys(bindings)) {
  const label = document.createElement('label'); label.textContent = action[0].toUpperCase() + action.slice(1);
  const select = document.createElement('select');
  for (const code of [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(c => `Key${c}`).concat(['Space', 'ShiftLeft'])) {
    const option = new Option(code.replace('Key', ''), code); select.add(option);
  }
  select.value = bindings[action];
  select.addEventListener('change', () => {
    releaseAll(); bindings[action] = select.value;
    try { localStorage.setItem('silksong-touch-bindings', JSON.stringify(bindings)); } catch { /* Optional. */ }
  });
  label.append(select); $('bindings').append(label);
}
$('diagnostics-button').addEventListener('click', () => { $('diagnostics').hidden = !$('diagnostics').hidden; updateStats(); });
function updateStats() {
  if ($('diagnostics').hidden || document.hidden) return;
  const heap = instance?.Module?.HEAPU8?.byteLength;
  $('diagnostics').textContent = `Drawing buffer: ${canvas.width} × ${canvas.height}\nWASM heap: ${heap ? (heap / 1048576).toFixed(0) + ' MiB' : 'starting'}\nZIP assets streamed: ${(loadedAssetBytes / 1048576).toFixed(0)} MiB\nHeap size is not total browser memory.`;
}
setInterval(updateStats, 2000);
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault(); releaseAll();
  showError(new Error('The graphics context was lost. Reload manually to restart; no automatic reload was attempted.'));
});
