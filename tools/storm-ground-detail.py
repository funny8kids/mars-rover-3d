#!/usr/bin/env python3
"""【E】1 — 沙暴里近景砂的纹理还在不在？（第二版：先躲开两个混淆，再谈结论）

台账 E1c 行末留了一句只在图上看得见的弱点："埋身暴把近景砂的纹理压成一张平色"。第一版尺子（一阶梯度
除以电平）差点把这句话判成"已解决"：暴内近景读到晴空的 4.5× —— 那是在量**飞到地面之前的尘丝**。第二版
把两个混淆各自钉成一个可判的读数：

  ① **染色不是抹平**：每帧先按通道除掉自己的均值（`c / mean(c)`），于是任何乘性的分级（R/G/B 增益不同
     也算）在度量里被除掉；`tint` 对照因此必须 ≈1.000（第一版做不到，读数是 1.32）。
  ② **粒子不是地面**：同一帧量两个带。`fine`（σ=1 减 σ=3）留得住 1~3 px 的尘丝，`ripple`（σ=3 减 σ=10）
     是砂纹自己的波长尺度。`noise` 对照（给晴空叠 1 px 高斯）必须在 ripple 上基本不动（白噪声进不了砂纹带）
     而"抹平"的对照必须打得中这一带：σ=6 模糊要让 ripple 掉，σ=2 模糊只许掉 fine、不许动 ripple
     （这两条一起成立，才允许拿 ripple 的比值去说"地面细节"）。
  ③ `flat`（均匀色）两带必须为 0；`smear`（σ=2，真的吃掉细节）ripple 必须显著掉。

取景带按**几何**给：CAM=[-26,3,34] → LOOK=[0,1.6,-46] 的近景那一横条在晴空帧里本来就只有中带 28 % 的
带通能量（第一版顺手量出来的），所以三带都打印、判据只在 `mid+near` 合并的地面带上下，不靠肉眼看图选带。

用法：python3 tools/storm-ground-detail.py 晴空.png 沙暴.png
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

SIGMA = {'fine': (1.0, 3.0), 'ripple': (3.0, 10.0)}


def blur(L, sig):
    im = Image.fromarray((np.clip(L, 0, 1) * 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(sig)), dtype=np.float64) / 255.0


def rgb_of(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float64) / 255.0


def lum_rel(a):
    """通道除掉自身均值后的亮度：乘性分级在这里被除掉，剩下的差异才是画面结构。"""
    n = a / np.maximum(a.mean(axis=(0, 1), keepdims=True), 1e-6)
    return 0.2126 * n[..., 0] + 0.7152 * n[..., 1] + 0.0722 * n[..., 2]


def band_energy(L, key):
    lo, hi = SIGMA[key]
    b = blur(L, lo) - blur(L, hi)
    m = float(np.abs(L).mean())
    return float(b.std()) / max(m, 1e-6)


def bands(L):
    h = L.shape[0]
    return {'near': L[int(h * 0.67):, :], 'mid': L[int(h * 0.40):int(h * 0.67), :],
            'far': L[:int(h * 0.40), :]}


def report(L, name, out):
    bs = bands(L)
    ground = np.vstack([bs['near'], bs['mid']])          # 地面带 = 近景 + 中带，按几何给
    out[name] = {'fine_ground': band_energy(ground, 'fine'), 'ripple_ground': band_energy(ground, 'ripple'),
                 'near_ripple': band_energy(bs['near'], 'ripple'), 'far_ripple': band_energy(bs['far'], 'ripple')}
    print(f"  {name:34} ground fine {out[name]['fine_ground']:.4f} · ripple {out[name]['ripple_ground']:.4f}"
          f"   |  near {out[name]['near_ripple']:.4f} · far {out[name]['far_ripple']:.4f}")


def main(argv):
    if len(argv) < 3:
        print('REFUSED 至少两帧（一晴一暴）')
        return 2
    calm, storm = argv[1], argv[2]
    Lc = lum_rel(rgb_of(calm))
    Ls = lum_rel(rgb_of(storm))
    out = {}
    print('GROUND_DETAIL 带通能量（通道归一后；ground=近景+中带；fine=σ1−3 吃尘丝，ripple=σ3−10 是砂纹）')
    report(Lc, calm.split('/')[-1], out)
    report(Ls, storm.split('/')[-1], out)
    rng = np.random.default_rng(7)
    report(np.clip(Lc + rng.normal(0, 0.035, Lc.shape), 0, 1), 'CONTROL noise(叠1px尘丝)', out)
    report(blur(Lc, 2.0), 'CONTROL smear2(σ=2 只吃细带)', out)
    report(blur(Lc, 6.0), 'CONTROL smear6(σ=6 吃砂纹带)', out)
    report(np.full(Lc.shape, 0.5), 'CONTROL flat(均匀色)', out)
    a = rgb_of(calm)
    gain = rgb_of(storm).mean(axis=(0, 1)) / np.maximum(a.mean(axis=(0, 1)), 1e-6)
    report(lum_rel(np.clip(a * gain, 0, 1)), f'CONTROL tint(×通道增益{np.round(gain,3).tolist()})', out)

    k_c, k_s = calm.split('/')[-1], storm.split('/')[-1]
    r_f = out['CONTROL noise(叠1px尘丝)']['fine_ground'] / out[k_c]['fine_ground']
    r_n = out['CONTROL noise(叠1px尘丝)']['ripple_ground'] / out[k_c]['ripple_ground']
    r_t = out[[k for k in out if k.startswith('CONTROL tint')][0]]['ripple_ground'] / out[k_c]['ripple_ground']
    r_m = out['CONTROL smear6(σ=6 吃砂纹带)']['ripple_ground'] / out[k_c]['ripple_ground']
    r_m2f = out['CONTROL smear2(σ=2 只吃细带)']['fine_ground'] / out[k_c]['fine_ground']
    r_m2r = out['CONTROL smear2(σ=2 只吃细带)']['ripple_ground'] / out[k_c]['ripple_ground']
    flat = out['CONTROL flat(均匀色)']['ripple_ground']
    print(f"  对照 ripple：tint {r_t:.3f}（必须≈1）· noise {r_n:.3f}（必须≈1）· smear σ=6 {r_m:.3f}（必须<0.8）· flat {flat:.6f}（必须=0）")
    print(f"  带选择性 σ=2：fine {r_m2f:.3f}（必须<0.8，细带被吃掉）· ripple {r_m2r:.3f}（必须>0.9，砂纹带不该动）")
    bad = []
    if abs(r_t - 1) > 0.05: bad.append(f'tint {r_t:.3f}')
    if not 0.8 <= r_n <= 1.25: bad.append(f'noise-ripple {r_n:.3f}')
    if r_m >= 0.8: bad.append(f'smear6 {r_m:.3f}')
    if flat > 1e-4: bad.append(f'flat {flat:.6f}')
    if r_m2f >= 0.8: bad.append(f'smear2-fine {r_m2f:.3f}')
    if r_m2r <= 0.9: bad.append(f'smear2-ripple {r_m2r:.3f}')
    if bad:
        print('GROUND_DETAIL_RC=3 尺子不可信：' + ' · '.join(bad))
        return 3
    ratio = out[k_s]['ripple_ground'] / out[k_c]['ripple_ground']
    near = out[k_s]['near_ripple'] / out[k_c]['near_ripple']
    far = out[k_s]['far_ripple'] / out[k_c]['far_ripple']
    print(f"  分带比值 暴/晴：地面(近+中) {ratio:.3f} · 仅近景 {near:.3f} · 远景(地平线一带) {far:.3f}")
    verdict = 'FLATTENED' if ratio < 0.8 else ('SURVIVES' if ratio > 0.9 else 'EDGE')
    print(f"GROUND_VERDICT {verdict} 暴内地面**砂纹带**能量 {ratio:.3f}×晴空（对照：染色除得掉、白噪声进不了这一带、σ=6 抹平会掉、σ=2 只掉细带）")
    print('GROUND_DETAIL_RC=0')
    return 0


sys.exit(main(sys.argv))
