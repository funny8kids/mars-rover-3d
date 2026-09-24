#!/usr/bin/env python3
"""Measure screen-space hatching (weave / corduroy) in a frame region, in grey levels.

Why this exists: "looks like programmed art" is not a reviewable claim, so the regular striping
seen in the storm sky and on near sand is measured instead of argued about.

What is measured, and why not a plain FFT peak: a thin dark line every N px is glaring to the eye
yet carries a tiny sinusoid amplitude, because a single Fourier coefficient of an impulse train is
the mean of one line over the whole crop. The matched filter for hatching is therefore the column
mean (any vertical line, however thin, survives averaging over rows). Both readings are printed:
col/row profile amplitude in 0-255 grey levels with its period, and the strongest 2-D sinusoid.

Two reference numbers make each reading interpretable: noise-floor (same crop with every Fourier
phase randomized, which keeps the spectrum and destroys the structure) and gain-ref (a synthetic
10-grey-level grating at the measured period pushed through the identical pipeline). A "no hatching"
reading only means something when the gain row says the instrument could have seen it.

usage: python3 tools/grating_audit.py img [img ...] [--y0 0 --y1 0.5 --x0 0 --x1 1 --k 15]
"""
import sys
import numpy as np
from PIL import Image

# The docstring's usage is `--y0 0.42`, so both that and `--y0=0.42` have to parse: an option that
# swallows the next token is fine here because every value is a number and every path is not.
args, opt = [], {}
tail = sys.argv[1:]
i = 0
while i < len(tail):
    a = tail[i]
    if a.startswith('--'):
        key, _, inline = a[2:].partition('=')
        if inline:
            raw = inline
        else:
            raw = tail[i + 1]
            i += 1
        opt[key] = float(raw) if raw.replace('.', '', 1).lstrip('-').isdigit() else raw
    else:
        args.append(a)
    i += 1
Y0, Y1 = opt.get('y0', 0.0), opt.get('y1', 0.5)
X0, X1 = opt.get('x0', 0.0), opt.get('x1', 1.0)
K = int(opt.get('k', 15))


def load(path):
    """Channel choice matters more than it looks: a Mars sky is an orange ramp, so a ripple in it
    can be nearly pure chroma and cancel in 0.299R+0.587G+0.114B. The eye sees the R-B swing; a
    luminance-only instrument does not, and calling that "no hatching" is a false acquittal."""
    im = Image.open(path)
    mode = opt.get('ch', 'L')
    if mode == 'L':
        a = np.asarray(im.convert('L'), dtype=np.float64)
    else:
        rgb = np.asarray(im.convert('RGB'), dtype=np.float64)
        r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
        a = {'R': r, 'G': g, 'B': b, 'RB': r - b, 'max': rgb.max(axis=-1)}[mode]
    h, w = a.shape
    return a[int(Y0 * h):int(Y1 * h), int(X0 * w):int(X1 * w)]


def detrend(c, k=K):
    pad = np.pad(c, k, mode='reflect')
    I = np.zeros((pad.shape[0] + 1, pad.shape[1] + 1))
    I[1:, 1:] = np.cumsum(np.cumsum(pad, axis=0), axis=1)
    n = 2 * k + 1
    rh = np.arange(n, pad.shape[0] + 1); rl = rh - n
    ch = np.arange(n, pad.shape[1] + 1); cl = ch - n
    return c - (I[np.ix_(rh, ch)] - I[np.ix_(rl, ch)] - I[np.ix_(rh, cl)] + I[np.ix_(rl, cl)]) / (n * n)


def dom(r, axis):
    """period (px) and amplitude (grey levels) of the dominant line pattern.
    axis=0 averages over rows -> responds to vertical stripes; axis=1 -> horizontal bands.
    A cosine of amplitude A seen through a Hann window reads 2*F[i]/sum(w) per sideband."""
    p = r.mean(axis=axis)
    x = np.arange(p.size)
    p = p - np.polyval(np.polyfit(x, p, 3), x)
    n = p.size
    w = np.hanning(n)
    F = np.abs(np.fft.rfft((p - p.mean()) * w))
    F[:3] = 0                                     # bins 1-2 are the crop's own slow drift
    i = int(np.argmax(F))
    return n / i, 2.0 * F[i] / w.sum()


def fit2d(r, fx, fy):
    h, w = r.shape
    yy, xx = np.mgrid[0:h, 0:w]
    t = 2 * np.pi * (fx * xx + fy * yy) / w
    return float(np.hypot(2 * (r * np.cos(t)).mean(), 2 * (r * np.sin(t)).mean()))


def peak2d(r):
    h, w = r.shape
    F = np.abs(np.fft.fftshift(np.fft.fft2(r * np.outer(np.hanning(h), np.hanning(w)))))
    F[int(h / 2) - 2:int(h / 2) + 3, int(w / 2) - 2:int(w / 2) + 3] = 0
    i, j = np.unravel_index(np.argmax(F), F.shape)
    fx, fy = j - w // 2, i - h // 2
    return (fit2d(r, fx, fy), w / max(np.hypot(fx, fy), 1), np.degrees(np.arctan2(fy, fx)) % 180, int(fx), int(fy))


def read(tag, r):
    h, w = r.shape
    pv, av = dom(r, 0)
    ph, ah = dom(r, 1)
    a2, p2, d2, fx, fy = peak2d(r)
    # positive control on the stronger of the two orientations: exactly 10 grey levels at the
    # measured period, through the identical pipeline. Not detrended — detrending a 31 px box off a
    # 31 px-wide band is detrending the signal itself (that is what made an earlier run read 0.00
    # for a grating that is plainly there, which is the whole reason this row exists).
    vert = av >= ah
    yy, xx = np.mgrid[0:h, 0:w]
    per = pv if vert else ph
    ctl = 10.0 * np.cos(2 * np.pi * (xx if vert else yy) / per)
    cv, cav = dom(ctl, 0 if vert else 1)
    # noise floor: phases randomized, so whatever the pipeline reports here is its own bias
    S = np.fft.fft2(r * np.outer(np.hanning(h), np.hanning(w)))
    rng = np.random.default_rng(7)
    scr = np.real(np.fft.ifft2(np.abs(S) * np.exp(1j * rng.uniform(-np.pi, np.pi, S.shape))))
    floor = max(dom(scr, 0)[1], dom(scr, 1)[1])
    print(f'{tag:26s} std={r.std():5.2f}  vertical={av:5.2f}gl@{pv:5.1f}px  '
          f'horizontal={ah:5.2f}gl@{ph:5.1f}px  2d={a2:5.2f}gl@{p2:4.1f}px/{d2:.0f}deg  '
          f'| 10gl-ctl={cav:5.2f}@{cv:.1f}px noise={floor:4.2f}')


for path in args:
    read(path.split('/')[-1], detrend(load(path)))
