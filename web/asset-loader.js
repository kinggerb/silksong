import { Inflate, Gunzip } from './vendor/fflate.js';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
export function updateCRC(crc, bytes) {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}

export function decompressor(format, native = globalThis.DecompressionStream) {
  if (native) {
    try { return new native(format); } catch { /* Older Safari: local streaming fallback. */ }
  }
  let decoder;
  return new TransformStream({
    start(controller) {
      decoder = new (format === 'gzip' ? Gunzip : Inflate)((data) => {
        if (data.length) controller.enqueue(data);
      });
    },
    transform(chunk) {
      for (let i = 0; i < chunk.length; i += 65536) decoder.push(chunk.subarray(i, i + 65536), false);
    },
    flush() { decoder.push(new Uint8Array(), true); },
  });
}

function abortError() { return new DOMException('Asset request cancelled', 'AbortError'); }
export function semaphore(limit = 1) {
  let active = 0;
  const waiting = [];
  function drain() {
    while (active < limit && waiting.length) {
      const task = waiting.shift();
      task.signal?.removeEventListener('abort', task.abort);
      active++;
      let released = false;
      task.resolve(() => {
        if (released) return;
        released = true; active--; drain();
      });
    }
  }
  return signal => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const task = { resolve, signal, abort() {
      const i = waiting.indexOf(task);
      if (i >= 0) waiting.splice(i, 1);
      reject(abortError());
    } };
    signal?.addEventListener('abort', task.abort, { once: true });
    waiting.push(task); drain();
  });
}

// Reads only one part at a time. If a static host ignores Range, discard the
// prefix incrementally and cancel the body at the end of the requested slice.
export async function* readRange(fetcher, url, start, length, signal) {
  const end = start + length - 1;
  const response = await fetcher(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (![200, 206].includes(response.status) || !response.body) {
    throw new Error(`Cannot read archive part (${response.status}): ${url}`);
  }
  let skip = start;
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('Content-Range') || '');
    if (!range || Number(range[1]) !== start || Number(range[2]) !== end) {
      await response.body.cancel();
      throw new Error('Archive server returned an incorrect byte range');
    }
    skip = 0;
  }
  const reader = response.body.getReader();
  let remaining = length;
  try {
    while (remaining) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) throw new Error('Truncated archive part');
      const offset = Math.min(skip, value.length); skip -= offset;
      const take = Math.min(remaining, value.length - offset);
      for (let i = offset; i < offset + take; i += 65536) {
        yield value.subarray(i, Math.min(i + 65536, offset + take));
      }
      remaining -= take;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function generatorStream(iterator, controller) {
  return new ReadableStream({
    async pull(stream) {
      try {
        const item = await iterator.next();
        if (item.done) stream.close(); else stream.enqueue(item.value);
      } catch (error) { stream.error(error); }
    },
    async cancel(reason) {
      controller.abort(reason);
      await iterator.return?.().catch(() => {});
    },
  }, { highWaterMark: 0 });
}

function withURL(response, url) {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

export function createAssetFetch({ baseURL, manifest, fetcher = globalThis.fetch.bind(globalThis), onProgress = () => {}, onError = () => {} }) {
  const base = new URL('./', baseURL);
  const assets = new URL('StreamingAssets/aa/WebGL/', base);
  const acquire = semaphore(1);
  const notify = info => { try { onProgress(info); } catch { /* UI must not break asset delivery. */ } };

  async function bundleResponse(url, entry, signal) {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    // Lock through decompression and verification, not just the network read.
    let release;
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', forwardAbort);
      release?.();
    }
    async function* compressed() {
      try {
        release = await acquire(controller.signal);
        let offset = entry.offset, remaining = entry.compressedSize;
        for (const part of manifest.parts) {
          if (offset >= part.offset + part.size || offset < part.offset) continue;
          const local = offset - part.offset;
          const count = Math.min(remaining, part.size - local);
          yield* readRange(fetcher, new URL(part.path, base).href, local, count, controller.signal);
          offset += count; remaining -= count;
          if (!remaining) return;
        }
        throw new Error('Asset lies outside the archive index');
      } catch (error) { finish(); throw error; }
    }
    let loaded = 0, crc = 0xffffffff;
    const decoded = generatorStream(compressed(), controller).pipeThrough(decompressor('deflate-raw'));
    const reader = decoded.getReader();
    const body = new ReadableStream({
      async pull(stream) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            if (loaded !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) {
              throw new Error('Asset integrity check failed; reload to retry');
            }
            notify({ name: url.pathname.split('/').pop(), loaded, total: entry.size, complete: true });
            finish(); stream.close(); return;
          }
          loaded += value.length;
          if (loaded > entry.size) throw new Error('Asset exceeds its declared size');
          crc = updateCRC(crc, value);
          notify({ name: url.pathname.split('/').pop(), loaded, total: entry.size, complete: false });
          stream.enqueue(value);
        } catch (error) {
          controller.abort();
          await reader.cancel().catch(() => {});
          finish();
          if (error.name !== 'AbortError') onError(error);
          stream.error(error);
        }
      },
      async cancel(reason) {
        controller.abort(reason);
        await reader.cancel(reason).catch(() => {});
        finish();
      },
    }, { highWaterMark: 0 });
    return withURL(new Response(body, { headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(entry.size),
      'Cache-Control': 'no-store',
    } }), url.href);
  }

  return async function assetFetch(resource, options) {
    const url = new URL(typeof resource === 'string' || resource instanceof URL ? resource : resource.url, base);
    const method = (options?.method || resource?.method || 'GET').toUpperCase();
    // Do not interfere with saves, uploads, unrelated origins or arbitrary URLs.
    if (method !== 'GET' || url.origin !== base.origin) return fetcher(resource, options);
    const signal = options?.signal || resource?.signal;
    if (url.pathname.startsWith(assets.pathname)) {
      const name = url.pathname.slice(assets.pathname.length);
      const entry = Object.hasOwn(manifest.entries, name) ? manifest.entries[name] : null;
      if (entry) return bundleResponse(url, entry, signal);
      if (manifest.overrides?.includes(name)) return fetcher(resource, { ...options, cache: 'no-cache' });
    }
    const path = url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : '';
    const build = Object.hasOwn(manifest.builds, path) ? manifest.builds[path] : null;
    if (!build) {
      if (['StreamingAssets/aa/catalog.bin', 'StreamingAssets/aa/catalog.hash', 'StreamingAssets/aa/settings.json'].includes(path)) {
        return fetcher(resource, { ...options, cache: 'no-cache' });
      }
      return fetcher(resource, options);
    }
    const response = await fetcher(resource, { ...options, cache: 'no-cache' });
    if (!response.ok || !response.body) throw new Error(`Build download failed: ${response.status} ${path}`);
    // With Content-Encoding the browser has already decompressed the stream.
    const body = response.headers.get('Content-Encoding')?.includes('gzip')
      ? response.body : response.body.pipeThrough(decompressor('gzip'));
    return withURL(new Response(body, { headers: {
      'Content-Type': path.includes('.wasm.') ? 'application/wasm' : path.includes('.framework.') ? 'application/javascript' : 'application/octet-stream',
      'Content-Length': String(build.size), 'Cache-Control': 'no-store',
    } }), url.href);
  };
}

// Unity used to allocate a second, full-size JS buffer even when it was already
// forwarding each chunk into its native streaming downloader. Keep only a byte
// count on that path. Non-streaming build downloads still receive real bytes.
export async function readBodyWithProgress(response, progress = () => {}, streaming = false) {
  const total = Number(response.headers.get('Content-Length')) || 0;
  let loaded = 0, storage = streaming ? null : new Uint8Array(total), overflow = [];
  const reader = response.body?.getReader();
  function consume(value) {
    if (!streaming) {
      if (loaded + value.length <= storage.length) storage.set(value, loaded);
      else overflow.push({ offset: loaded, value });
    }
    loaded += value.length;
    progress({ type: 'progress', response, total: Math.max(total, loaded), loaded,
      lengthComputable: total > 0, chunk: streaming ? value : null });
  }
  try {
    if (!reader) consume(new Uint8Array(await response.arrayBuffer()));
    else while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      consume(value);
    }
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw error;
  } finally { reader?.releaseLock(); }
  let result;
  if (streaming) result = { length: loaded };
  else if (loaded === storage.length && !overflow.length) result = storage;
  else {
    result = new Uint8Array(loaded);
    result.set(storage.subarray(0, Math.min(storage.length, loaded)));
    for (const piece of overflow) result.set(piece.value, piece.offset);
  }
  progress({ type: 'load', response, total: loaded, loaded, lengthComputable: total > 0, chunk: null });
  response.parsedBody = result;
  return response;
}
