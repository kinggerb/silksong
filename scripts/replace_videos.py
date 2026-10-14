"""Recreate the 1-second video replacements. Requires imageio-ffmpeg==0.6.0."""
import subprocess
import tempfile
from pathlib import Path
import imageio_ffmpeg
from archive import ROOT

ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
folder = ROOT / 'StreamingAssets/VideoClip'
common = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=1']
subprocess.run(common + ['-an', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', '1', str(folder / 'placeholder.mp4')], check=True)
with tempfile.TemporaryDirectory() as temp:
    output = Path(temp) / 'placeholder.webm'
    subprocess.run(common + ['-an', '-c:v', 'libvpx-vp9', '-b:v', '20k', '-t', '1', str(output)], check=True)
    for path in folder.glob('*.webm'):
        path.write_bytes(output.read_bytes())
print('Replaced all existing WebM paths; created H.264 fallback. No zero-byte videos.')
