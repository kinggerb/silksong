import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { createAssetFetch, readBodyWithProgress, updateCRC, decompressor, readRange, semaphore } from '../web/asset-loader.js';

const baseURL = 'https://example.test/silksong/';
const payload = new TextEncoder().encode('UnityFS: ' + 'a repeated, valid test payload. '.repeat(3000));
const crc32 = (updateCRC(0xffffffff, payload) ^ 0xffffffff) >>> 0;
function fixture({ ignoreRange = false, crc = crc32 } = {}) {
  const compressed = deflateRawSync(payload);
  const prefix = new Uint8Array(17).fill(42);
  const bytes = new Uint8Array(prefix.length + compressed.length + 23);
  bytes.set(prefix); bytes.set(compressed, prefix.length);
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 73) {
    parts.push({ path: `part${parts.length + 1}`, offset, size: Math.min(73, bytes.length - offset) });
  }
  const calls = [];
  const manifest = { parts, entries: { 'test.bundle': { offset: 17, compressedSize: compressed.length, size: payload.length, crc32: crc } }, builds: {} };
  async function fetcher(resource, options) {
    const url = new URL(resource instanceof Request ? resource.url : resource);
    const part = parts.find(p => url.pathname.endsWith('/' + p.path));
    calls.push({ url: url.href, options });
    if (!part) return new Response('passthrough');
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const begin = ignoreRange ? 0 : Number(first), end = ignoreRange ? part.size - 1 : Number(last);
    const body = bytes.slice(part.offset + begin, part.offset + end + 1);
    let pos = 0;
    return new Response(new ReadableStream({
      pull(c) { if (pos === body.length) c.close(); else { c.enqueue(body.slice(pos, pos + 11)); pos = Math.min(body.length, pos + 11); } },
    }), { status: ignoreRange ? 200 : 206, headers: ignoreRange ? {} : { 'Content-Range': `bytes ${begin}-${end}/${part.size}` } });
  }
  return { manifest, calls, fetcher };
}
for (const ignoreRange of [false, true]) {
  test(`streams a ZIP entry crossing parts (host ignores range: ${ignoreRange})`, async () => {
    const f = fixture({ ignoreRange });
    const fetch = createAssetFetch({ baseURL, ...f });
    const response = await fetch(new URL('StreamingAssets/aa/WebGL/test.bundle', baseURL));
    assert.equal(response.url, baseURL + 'StreamingAssets/aa/WebGL/test.bundle');
    assert.equal(response.headers.get('Content-Length'), String(payload.length));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
    assert.ok(f.calls.length > 1);
    assert.ok(f.calls.length < f.manifest.parts.length || f.calls.at(-1).options.headers.Range);
  });
}
test('rejects corruption rather than marking a broken install complete', async () => {
  const fetch = createAssetFetch({ baseURL, ...fixture({ crc: 1 }) });
  const response = await fetch(baseURL + 'StreamingAssets/aa/WebGL/test.bundle');
  await assert.rejects(response.arrayBuffer(), /integrity/);
});
test('precise paths, origins and non-GET requests pass through unchanged', async () => {
  const f = fixture(); const fetch = createAssetFetch({ baseURL, ...f });
  for (const resource of [new Request(baseURL + 'save', { method: 'POST', body: 'save' }), new URL('https://other.test/StreamingAssets/aa/WebGL/test.bundle'), baseURL + 'other/test.bundle']) {
    assert.equal(await (await fetch(resource)).text(), 'passthrough');
  }
});
test('streaming Unity downloads retain only length, while delivering every chunk', async () => {
  let received = 0;
  const response = await readBodyWithProgress(new Response(payload, { headers: { 'Content-Length': String(payload.length) } }), e => { received += e.chunk?.length || 0; }, true);
  assert.deepEqual(response.parsedBody, { length: payload.length });
  assert.equal(received, payload.length);
});
for (const total of [0, 5, payload.length, payload.length + 13]) {
  test(`non-streaming body handles declared length ${total}`, async () => {
    const response = await readBodyWithProgress(new Response(payload, { headers: total ? { 'Content-Length': String(total) } : {} }));
    assert.deepEqual(response.parsedBody, payload);
  });
}
for (const native of [undefined, null]) {
  test(`gzip and raw deflate decompression (forced fallback: ${native === null})`, async () => {
    for (const [format, data] of [['gzip', gzipSync(payload)], ['deflate-raw', deflateRawSync(payload)]]) {
      const stream = new Response(data).body.pipeThrough(decompressor(format, native));
      assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), payload);
    }
  });
}
test('gzip build response has the decompressed length and wasm MIME type', async () => {
  const manifest = { entries: {}, parts: [], builds: { 'Build/test.wasm.unityweb': { size: payload.length } } };
  for (const encodedByServer of [false, true]) {
    const fetcher = async () => new Response(encodedByServer ? payload : gzipSync(payload), { headers: encodedByServer ? { 'Content-Encoding': 'gzip' } : {} });
    const fetch = createAssetFetch({ baseURL, manifest, fetcher });
    const response = await fetch(baseURL + 'Build/test.wasm.unityweb');
    assert.equal(response.headers.get('Content-Type'), 'application/wasm');
    assert.equal(response.headers.get('Content-Length'), String(payload.length));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
  }
});
test('range reader rejects incorrect ranges and truncation', async () => {
  for (const response of [new Response('a', { status: 206, headers: { 'Content-Range': 'bytes 1-4/5' } }), new Response('a')]) {
    const read = async () => { for await (const chunk of readRange(async () => response, 'https://test/part', 0, 5)) void chunk; };
    await assert.rejects(read(), /incorrect|Truncated/);
  }
});
test('aborting a queued request does not block the next request', async () => {
  const acquire = semaphore(1);
  const release = await acquire();
  const abort = new AbortController();
  const waiting = acquire(abort.signal);
  abort.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  release(); (await acquire())();
});
test('cancelling a bundle response releases its download slot', async () => {
  const f = fixture(); const fetch = createAssetFetch({ baseURL, ...f });
  const a = await fetch(baseURL + 'StreamingAssets/aa/WebGL/test.bundle');
  const reader = a.body.getReader(); await reader.read(); await reader.cancel();
  const b = await fetch(baseURL + 'StreamingAssets/aa/WebGL/test.bundle');
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), payload);
});
