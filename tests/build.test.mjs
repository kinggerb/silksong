import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
const manifest = JSON.parse(fs.readFileSync(new URL('../web/asset-manifest.json', import.meta.url)));

test('patched WASM validates and instantiates with a 512 MiB heap', async () => {
  const bytes = gunzipSync(fs.readFileSync(new URL('../Build/w-pt.wasm.unityweb', import.meta.url)));
  assert.equal(bytes.length, manifest.builds['Build/w-pt.wasm.unityweb'].size);
  assert.ok(WebAssembly.validate(bytes));
  const module = await WebAssembly.compile(bytes);
  const imports = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    assert.equal(entry.kind, 'function');
    (imports[entry.module] ||= {})[entry.name] = () => 0;
  }
  // Validates active data placement. Does not run Unity's constructors/game loop.
  const instance = new WebAssembly.Instance(module, imports);
  assert.equal(instance.exports.Kk.buffer.byteLength, 512 * 1024 * 1024);
});
test('manifest covers exactly the remaining ZIP-only bundles and unchanged part layout', () => {
  assert.equal(Object.keys(manifest.entries).length, 20);
  assert.equal(manifest.parts.length, 100);
  let offset = 0;
  for (const part of manifest.parts) {
    assert.equal(part.offset, offset);
    assert.equal(fs.statSync(new URL('../' + part.path, import.meta.url)).size, part.size);
    offset += part.size;
  }
  for (const [name, entry] of Object.entries(manifest.entries)) {
    assert.ok(entry.offset + entry.compressedSize <= offset);
    assert.equal(fs.existsSync(new URL('../StreamingAssets/aa/WebGL/' + name, import.meta.url)), false);
  }
});
test('all 26 legacy video paths contain valid small WebM files', () => {
  const dir = new URL('../StreamingAssets/VideoClip/', import.meta.url);
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.webm'));
  assert.equal(names.length, 26);
  for (const name of names) {
    const bytes = fs.readFileSync(new URL(name, dir));
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3');
    assert.ok(bytes.length < 4096);
  }
  assert.ok(fs.statSync(new URL('placeholder.mp4', dir)).size < 4096);
});
test('build manifest lengths, safer growth and video URL patch match delivered files', () => {
  for (const [path, entry] of Object.entries(manifest.builds)) {
    assert.equal(gunzipSync(fs.readFileSync(new URL('../' + path, import.meta.url))).length, entry.size);
  }
  const framework = gunzipSync(fs.readFileSync(new URL('../Build/w-pt.framework.js.unityweb', import.meta.url))).toString();
  assert.ok(framework.includes('oldSize * (1 + .05 / cutDown)'));
  assert.ok(framework.includes('requestedSize + 33554432'));
  assert.ok(framework.includes('Module.lowMemoryVideoUrl'));
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('cdn.jsdelivr.net'));
  assert.ok(!html.includes('jszip'));
});
