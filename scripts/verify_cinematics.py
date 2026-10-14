"""Read-only verification of the compact cinematic bundle/catalog pair."""
import struct
import zlib
from collections import Counter
from pathlib import Path
import UnityPy
from archive import ROOT, open_archive

_, archive = open_archive()
name = next(n for n in archive.namelist() if n.startswith('packed-cinematics_'))
original = UnityPy.load(archive.read(name))
path = ROOT / 'StreamingAssets/aa/WebGL' / name
compact = UnityPy.load(str(path))
assert Counter(o.type.name for o in original.objects) == Counter(o.type.name for o in compact.objects)
old_objects = {o.path_id: o for o in original.objects}
new_objects = {o.path_id: o for o in compact.objects}
assert old_objects.keys() == new_objects.keys()
old_resource = next(f.bytes for name, f in original.file.files.items() if name.endswith('.resource'))
new_resource = next(f.bytes for name, f in compact.file.files.items() if name.endswith('.resource'))
movie = (ROOT / 'StreamingAssets/VideoClip/placeholder.mp4').read_bytes()
for path_id, obj in new_objects.items():
    old = old_objects[path_id]
    if obj.type.name == 'VideoClip':
        d = obj.read(); r = d.m_ExternalResources
        assert d.m_FrameCount == 30 and d.m_FrameRate == 30
        assert d.Width == 160 and d.Height == 90
        assert new_resource[r.m_Offset:r.m_Offset+r.m_Size] == movie
    elif obj.type.name == 'AudioClip':
        a, b = old.read().m_Resource, obj.read().m_Resource
        assert old_resource[a.m_Offset:a.m_Offset+a.m_Size] == new_resource[b.m_Offset:b.m_Offset+b.m_Size]
    else:
        # Includes MonoBehaviour data and the AssetBundle's object reference map.
        assert old.get_raw_data() == obj.get_raw_data(), (path_id, obj.type.name)
crc = 0
for f in compact.file.files.values():
    crc = zlib.crc32(f.reader.bytes if hasattr(f, 'reader') else f.bytes, crc)
catalog = (ROOT / 'StreamingAssets/aa/catalog.bin').read_bytes()
assert catalog.count(struct.pack('<II', crc, path.stat().st_size)) == 1
print('PASS: object IDs, script/reference bytes, audio payloads, movie duration/dimensions, catalog CRC and size.')
