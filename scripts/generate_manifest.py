"""Regenerate the small range/decompression index after changing build assets."""
import gzip
import json
import struct
from archive import ROOT, open_archive

reader, archive = open_archive()
entries = {}
overrides = []
for entry in archive.infolist():
    # A loose replacement (e.g. compact cinematics) takes precedence over the ZIP.
    if (ROOT / 'StreamingAssets/aa/WebGL' / entry.filename).exists():
        overrides.append(entry.filename)
        continue
    assert entry.compress_type == 8 and not entry.flag_bits & 1
    reader.seek(entry.header_offset)
    header = reader.read(30)
    assert header[:4] == b'PK\x03\x04'
    name_size, extra_size = struct.unpack_from('<HH', header, 26)
    entries[entry.filename] = {
        'offset': entry.header_offset + 30 + name_size + extra_size,
        'compressedSize': entry.compress_size,
        'size': entry.file_size,
        'crc32': entry.CRC,
    }
builds = {}
for path in sorted((ROOT / 'Build').glob('*.unityweb')):
    raw = gzip.decompress(path.read_bytes())
    builds['Build/' + path.name] = {'size': len(raw)}
manifest = {
    'version': 'ipad-v1',
    'parts': [{'path': str(p.relative_to(ROOT)), 'offset': offset, 'size': p.stat().st_size}
              for p, offset in zip(reader.paths, reader.starts)],
    'entries': entries,
    'overrides': overrides,
    'builds': builds,
}
(ROOT / 'web/asset-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Indexed {len(entries)} ZIP-only bundles. No game data extracted.')
