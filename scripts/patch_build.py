"""Reproducible, narrow compiled-build patches; gameplay code/assets are untouched.
Always starts from the audited base commit. Run generate_manifest.py afterwards.
"""
import gzip
import subprocess
from archive import ROOT

BASE = 'bcbe014765f2f6ca4b1d82ac25755a0299a600ab'
def original(path):
    return subprocess.check_output(['git', 'show', f'{BASE}:{path}'], cwd=ROOT)
def uleb(data, pos):
    value = shift = 0
    while True:
        b = data[pos]; pos += 1
        value |= (b & 127) << shift
        if b < 128: return value, pos
        shift += 7
        assert shift <= 35

def encode(value):
    out = bytearray()
    while value >= 128:
        out.append((value & 127) | 128); value >>= 7
    out.append(value)
    return bytes(out)

def patch_wasm(raw):
    assert raw[:8] == b'\0asm\x01\0\0\0'
    result = bytearray(raw[:8]); pos = 8; memories = 0; data_end = 0
    while pos < len(raw):
        section = raw[pos]; pos += 1
        size, pos = uleb(raw, pos)
        end = pos + size; payload = raw[pos:end]
        if section == 5:
            count, p = uleb(payload, 0)
            flags, p = uleb(payload, p)
            minimum, p = uleb(payload, p)
            maximum, p = uleb(payload, p)
            assert count == 1 and flags == 1 and minimum == 32768 and maximum == 65280 and p == len(payload)
            payload = encode(count) + encode(flags) + encode(8192) + encode(maximum)
            memories += 1
        elif section == 11:
            count, p = uleb(payload, 0)
            for _ in range(count):
                flags, p = uleb(payload, p)
                assert flags in (0, 1, 2)
                if flags == 2:
                    index, p = uleb(payload, p); assert index == 0
                offset = None
                if flags != 1:
                    assert payload[p] == 0x41; p += 1  # nonnegative i32.const
                    offset, p = uleb(payload, p)
                    assert payload[p] == 0x0b; p += 1
                length, p = uleb(payload, p)
                if offset is not None: data_end = max(data_end, offset + length)
                p += length
            assert p == len(payload) and data_end < 512 * 1024 * 1024
        result.append(section); result.extend(encode(len(payload))); result.extend(payload)
        pos = end
    assert memories == 1
    return bytes(result), data_end

if __name__ == '__main__':
    wasm, end = patch_wasm(gzip.decompress(original('Build/w-pt.wasm.unityweb')))
    (ROOT / 'Build/w-pt.wasm.unityweb').write_bytes(gzip.compress(wasm, compresslevel=9, mtime=0))
    framework = gzip.decompress(original('Build/w-pt.framework.js.unityweb')).decode()
    assert framework.count('oldSize * (1 + .2 / cutDown)') == 1
    framework = framework.replace('oldSize * (1 + .2 / cutDown)', 'oldSize * (1 + .05 / cutDown)')
    framework = framework.replace('requestedSize + 536870912', 'requestedSize + 33554432')
    old = 'var str = UTF8ToString(url);\n\t\t\t\tvar video = document.createElement("video");'
    new = '''var str = UTF8ToString(url);
                // Our 1-second H.264 clip avoids depending on VP9 decode support on iPad.
                if (Module.lowMemoryVideoUrl && /\\/VideoClip\\/[^/]+\\.webm(?:[?#].*)?$/.test(str)) {
                    str = Module.lowMemoryVideoUrl;
                }
                var video = document.createElement("video");'''
    assert framework.count(old) == 1
    framework = framework.replace(old, new)
    (ROOT / 'Build/w-pt.framework.js.unityweb').write_bytes(gzip.compress(framework.encode(), compresslevel=9, mtime=0))
    loader = (ROOT / 'Build/w-pt.loader.js').read_text()
    loader = loader.replace('wasmFileSize: 82574276', f'wasmFileSize: {len(wasm)}')
    (ROOT / 'Build/w-pt.loader.js').write_text(loader)
    print(f'WASM initial memory: 512 MiB; highest active data end: {end:,}; WASM bytes: {len(wasm):,}')
