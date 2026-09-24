#!/usr/bin/env python3
"""Does a q=0.85 JPEG manufacture a diagonal R-B weave out of a clean sky?

grating_audit measured 3.00 grey levels at 19.9 px / 47 deg on e1_peak.jpg, and 0.15 gl on the
patch of the same file that the eye actually flagged. Both cannot be true of the render, so the
capture codec is the suspect: shot() writes toDataURL('image/jpeg', 0.85), which is lossy and 4:2:0
chroma-subsampled, and R-B is exactly the axis that survives worst.

Control: take a lossless PNG sky frame, encode it through the identical pipeline, and measure the
PNG and the re-encoded JPEG with the same instrument. If the weave appears only after encoding,
every amplitude ever read off a .jpg frame is untrustworthy and the storm shader is acquitted by
the rig, not by argument.
"""
import io
import subprocess
import sys
import numpy as np
from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rsb_shots/e1_png_e8.png.png'
im = Image.open(SRC).convert('RGB')
w, h = im.size
sky = im.crop((0, 0, int(w * 0.5), int(h * 0.26)))          # verified-pure sky, above the horizon

buf = io.BytesIO()
Image.fromarray(np.asarray(sky)).save(buf, 'JPEG', quality=85, subsampling=2)
jpg = Image.open(io.BytesIO(buf.getvalue()))

# a synthetic gradient with the same statistics and no structure at all: if the codec can put a
# weave in this, the weave in a real frame proves nothing about the render.
a = np.asarray(sky).astype(np.float64)
ramp = np.zeros_like(a)
for c in range(3):
    col = a[..., c].mean(axis=1)
    ramp[..., c] = col[:, None]
flat = Image.fromarray(np.clip(ramp, 0, 255).astype(np.uint8))
buf2 = io.BytesIO()
flat.save(buf2, 'JPEG', quality=85, subsampling=2)
flat_j = Image.open(io.BytesIO(buf2.getvalue()))

import tempfile, os
d = tempfile.mkdtemp()
paths, tags = [], []
for tag, img in [('png-orig', sky), ('jpg-reread', jpg),
                 ('flat-png', flat), ('flat-jpg', flat_j)]:
    p = os.path.join(d, tag + '.png' if 'png' in tag else tag + '.jpg')
    img.save(p)
    paths.append(p); tags.append(tag)
print(f'src={SRC}  crop={sky.size}  jpg_bytes={len(buf.getvalue())}')
cmd = [sys.executable, 'tools/grating_audit.py'] + paths + \
      ['--y0=0', '--y1=1', '--x0=0', '--x1=1', '--ch=RB', '--k=6']
print(subprocess.run(cmd, capture_output=True, text=True).stdout.strip())


def blockiness(a):
    """Mean adjacent-pixel step across an 8-px DCT boundary over the mean step everywhere.

    The FFT reading above is a matched filter for a *sinusoid*, and JPEG blocking is not one: it is
    an impulse train on an 8 px lattice, whose energy is spread over many bins and which a single
    coefficient badly under-reports. So the codec gets a second, purpose-built test before the
    shader can be acquitted on the first one's say-so."""
    d = np.abs(np.diff(a, axis=1)).mean(axis=0)
    edge = d[np.arange(a.shape[1] - 1) % 8 == 7]
    return float(edge.mean() / d.mean())


# Extra paths after the source are scored with the same test, so `python3 tools/codec_control.py
# <png-source> <frames...>` doubles as the regression check for shot()'s capture codec: a frame
# written by the rig must read ~1.00, and the historical .jpg frames are the failure it replaced.
print('\nblockiness (1.00 = no 8px lattice; >1.15 = visible DCT grid):')
for p in [paths[0], paths[1], '/tmp/rsb_shots/e1_peak.jpg', '/tmp/rsb_shots/e1_calm.jpg'] + sys.argv[2:]:
    arr = np.asarray(Image.open(p).convert('RGB').crop((0, 60, 320, 180)), dtype=np.float64)
    rb = arr[..., 0] - arr[..., 2]
    print(f'  {os.path.basename(p):12s} L={blockiness(arr.mean(axis=2)):.3f}  RB={blockiness(rb):.3f}')
