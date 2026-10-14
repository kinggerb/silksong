"""Seek the existing split ZIP without joining it or allocating it in RAM."""
import bisect
import io
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]

class PartsReader(io.RawIOBase):
    def __init__(self, paths):
        self.paths = paths
        self.starts = [0]
        for path in paths:
            self.starts.append(self.starts[-1] + path.stat().st_size)
        self.pos = 0

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, offset, whence=0):
        pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.starts[-1] + offset
        if pos < 0: raise ValueError('Negative seek')
        self.pos = pos
        return pos

    def read(self, size=-1):
        if size < 0: size = self.starts[-1] - self.pos
        chunks = []
        while size > 0 and self.pos < self.starts[-1]:
            i = bisect.bisect_right(self.starts, self.pos) - 1
            n = min(size, self.starts[i + 1] - self.pos)
            with self.paths[i].open('rb') as stream:
                stream.seek(self.pos - self.starts[i])
                data = stream.read(n)
            if not data: raise EOFError('Truncated part')
            chunks.append(data)
            self.pos += len(data)
            size -= len(data)
        return b''.join(chunks)

def open_archive():
    paths = sorted((ROOT / 'StreamingAssets/aa').glob('WebGL.zip.part*'), key=lambda p: int(p.suffix[5:]))
    assert [int(p.suffix[5:]) for p in paths] == list(range(1, 101))
    reader = PartsReader(paths)
    return reader, zipfile.ZipFile(reader)
