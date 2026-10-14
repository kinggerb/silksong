"""Replace embedded movie payloads, preserving object IDs, scripts and audio.
Requires UnityPy==1.25.4. Reads the original bundle from the split archive.
The output is small enough to serve as a loose bundle; archive bytes stay intact.
"""
import hashlib
import struct
import subprocess
import zlib
from collections import Counter
import UnityPy
from UnityPy.streams import EndianBinaryReader
from archive import ROOT, open_archive

_, archive = open_archive()
name = next(n for n in archive.namelist() if n.startswith('packed-cinematics_'))
original = archive.read(name)
env = UnityPy.load(original)
bundle = env.file
movie = (ROOT / 'StreamingAssets/VideoClip/placeholder.mp4').read_bytes()
resource_name = next(k for k in bundle.files if k.endswith('.resource'))
old_resource = bundle.files[resource_name].bytes
original_crc = 0
for file in bundle.files.values():
    original_crc = zlib.crc32(file.reader.bytes if hasattr(file, 'reader') else file.bytes, original_crc)
old_counts = Counter(o.type.name for o in env.objects)
old_ids = {o.path_id for o in env.objects}
audio_payloads = {}
new_resource = bytearray(movie)
for obj in env.objects:
    if obj.type.name == 'VideoClip':
        data = obj.read()
        data.Width = data.m_ProxyWidth = 160
        data.Height = data.m_ProxyHeight = 90
        data.m_FrameCount = 30
        data.m_FrameRate = 30.0
        data.m_PixelAspecRatioNum = data.m_PixelAspecRatioDen = 1
        data.m_AudioChannelCount = []
        data.m_AudioLanguage = []
        data.m_AudioSampleRate = []
        data.m_ExternalResources.m_Offset = 0
        data.m_ExternalResources.m_Size = len(movie)
        data.save()
    elif obj.type.name == 'AudioClip':
        data = obj.read()
        resource = data.m_Resource
        payload = old_resource[resource.m_Offset:resource.m_Offset + resource.m_Size]
        assert len(payload) == resource.m_Size
        audio_payloads[obj.path_id] = payload
        new_resource.extend(b'\0' * (-len(new_resource) % 16))
        resource.m_Offset = len(new_resource)
        new_resource.extend(payload)
        data.save()
resource_flags = bundle.files[resource_name].flags
bundle.files[resource_name] = EndianBinaryReader(bytes(new_resource))
bundle.files[resource_name].flags = resource_flags
packed = bundle.save(packer='lz4')
check = UnityPy.load(packed)
assert Counter(o.type.name for o in check.objects) == old_counts
assert {o.path_id for o in check.objects} == old_ids
new_crc = 0
for file in check.file.files.values():
    new_crc = zlib.crc32(file.reader.bytes if hasattr(file, 'reader') else file.bytes, new_crc)
for obj in check.objects:
    if obj.type.name == 'AudioClip':
        r = obj.read().m_Resource
        assert new_resource[r.m_Offset:r.m_Offset + r.m_Size] == audio_payloads[obj.path_id]
    if obj.type.name == 'VideoClip':
        d = obj.read()
        assert d.m_FrameCount / d.m_FrameRate == 1 and d.Width == 160

# Verified Addressables binary SerializedData layout:
# uint hashId, bundleNameId, crc, bundleSize, commonId.
# Fail closed rather than searching/replacing arbitrary catalog integers.
base = 'bcbe014765f2f6ca4b1d82ac25755a0299a600ab'
catalog = bytearray(subprocess.check_output(['git', 'show', f'{base}:StreamingAssets/aa/catalog.bin'], cwd=ROOT))
needle = struct.pack('<II', original_crc, len(original))
assert catalog.count(needle) == 1
pos = catalog.index(needle)
hash_offset = struct.unpack_from('<I', catalog, pos - 8)[0]
assert catalog[hash_offset:hash_offset + 16].hex() == name.split('_')[-1].removesuffix('.bundle')
catalog[hash_offset:hash_offset + 16] = hashlib.md5(packed).digest()
struct.pack_into('<II', catalog, pos, new_crc, len(packed))
(ROOT / 'StreamingAssets/aa/WebGL' / name).write_bytes(packed)
(ROOT / 'StreamingAssets/aa/catalog.bin').write_bytes(catalog)
# This file is an opaque catalog cache version, not a cryptographic signature.
(ROOT / 'StreamingAssets/aa/catalog.hash').write_text(hashlib.md5(catalog).hexdigest())
print(f'Cinematics: {len(original):,} -> {len(packed):,} bytes; CRC {new_crc:08x}')
print('Preserved object IDs, 26 MonoBehaviours and all 17 original audio payloads.')
