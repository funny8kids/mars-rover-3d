#!/usr/bin/env python3
"""【E】1 — 沙暴里近景砂的纹理还在不在？（对 PNG 局部对比度量，不看像素之外的承诺）

台账 E1c 行末留了一句只在图上看得见的弱点："埋身暴把近景砂的纹理压成一张平色……地面细节没了"。
那句话是目视的，没有尺子。这把尺子要能区分两件很容易混起来的事：

  * 画面被**染色 / 压暗**（分级、雾、尘墙挡住光）—— 那不影响"纹理在不在"；
  * 画面被**抹平**（局部亮度差被吃掉）—— 那才是可读性问题。

所以两个指标都相对**电平**归一：`grad_rel = mean|∇L| / mean L`、`hp_rel = std(L - blur(L)) / mean L`。
一个整幅同色的乘性分级会把分子分母同时缩放，比值不动；只有细节被吃掉才会让它掉。

三条对照都在同一批图上跑（都不靠人眼）：
  ① `flat`      纯均匀色 → 两指标必须 ≈0（证明这把尺不是恒正的装饰品）；
  ② `tint`      把晴空帧按暴的实测通道增益染色（不碰几何/模糊）→ 比值必须基本不动
                （证明"暴内读数低"不会被归因成一次颜色分级）；
  ③ `smear`     把晴空帧高斯糊 σ=2（真的吃掉细节）→ 比值必须显著掉
                （证明这把尺认得被抹平这件事）。

用法：python3 tools/storm-ground-detail.py a.png b.png ...
"""
import sys
import numpy as np
from PIL import Image, ImageFilter


def lum(path):
    im = Image.open(path).convert('RGB')
    a = np.asarray(im, dtype=np.float64) / 255.0
    return a, 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def blur(L, sig):
    return np.asarray(Image.fromarray((np.clip(L, 0, 1) * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(sig)), dtype=np.float64) / 255.0


def metrics(L):
    gy, gx = np.gradient(L)
    g = np.sqrt(gx * gx + gy * gy)
    m = float(L.mean())
    smoothed = np.asarray(Image.fromarray((L * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(4)), dtype=np.float64) / 255.0
    hp = L - smoothed
    # `band` is the scale-restricted one: energy between σ=1 and σ=6, i.e. the wavelength of the sand's
    # own ripples. `grad_rel`/`hp_rel` are dominated by 1-3 px dust streaks flying in front of the
    # ground, which is why the first version of this ruler "cleared" the storm by reporting 4.5× the
    # calm gradient — that reading measured the particles, not the surface, and it is kept printed
    # only so the confound stays visible next to the number that does not have it.
    band = blur(L, 3.0) - blur(L, 10.0)
    return {'grad_rel': float(g.mean()) / max(m, 1e-6),
            'hp_rel': float(hp.std()) / max(m, 1e-6),
            'band_rel': float(band.std()) / max(m, 1e-6),
            'mean': m}


def bands(L):
    h = L.shape[0]
    # 画面下 1/3 是脚下的砂：相机 CAM=[-26,3,34] 望 LOOK=[0,1.6,-46]，地平线在中线偏上
    return {'near': L[int(h * 0.67):, :], 'mid': L[int(h * 0.40):int(h * 0.67), :],
            'far': L[:int(h * 0.40), :]}


def channel_gain(calm_path, storm_path):
    c = np.asarray(Image.open(calm_path).convert('RGB'), dtype=np.float64)
    s = np.asarray(Image.open(storm_path).convert('RGB'), dtype=np.float64)
    return [float(s[..., k].mean() / max(c[..., k].mean(), 1e-6)) for k in range(3)]


def main(argv):
    if len(argv) < 3:
        print('REFUSED 至少两帧（一晴一暴）才能出差分')
        return 2
    calm, storm = argv[1], argv[2]
    rows = {}
    for p in [calm, storm]:
        a, L = lum(p)
        rows[p.split('/')[-1]] = {b: metrics(v) for b, v in bands(L).items()}
        rows[p.split('/')[-1]]['size'] = L.shape
    # ② 染色对照：只乘通道增益，不糊、不改几何
    a, L = lum(calm)
    gain = channel_gain(calm, storm)
    tinted = np.clip(a * np.array(gain), 0, 1)
    Lt = 0.2126 * tinted[..., 0] + 0.7152 * tinted[..., 1] + 0.0722 * tinted[..., 2]
    rows['CONTROL tint(calm×storm增益)'] = {b: metrics(v) for b, v in bands(Lt).items()}
    # ③ 抹平对照：真的吃掉细节
    smeared = np.asarray(Image.fromarray((L * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(2)), dtype=np.float64) / 255.0
    rows['CONTROL smear(calm σ=2)'] = {b: metrics(v) for b, v in bands(smeared).items()}

    print('GROUND_DETAIL 指标 = 相对电平的局部对比度（grad_rel 一阶 / hp_rel 高通）')
    for name, r in rows.items():
        if name == 'size':
            continue
        cells = ' '.join(f"{b}:{r[b]['grad_rel']:.4f}/{r[b]['hp_rel']:.4f}" for b in ('near', 'mid', 'far'))
        cells_b = ' '.join(f"{b}:{rows[name][b]['band_rel']:.4f}" for b in ('near', 'mid', 'far'))
    print(f"  {name:34} {cells}   band {cells_b}")
    c = [k for k in rows if k.startswith(calm.split('/')[-1])][0]
    s = [k for k in rows if k.startswith(storm.split('/')[-1])][0]
    ctrl_t = 'CONTROL tint(calm×storm增益)'
    ctrl_s = 'CONTROL smear(calm σ=2)'
    near = lambda k: rows[k]['near']['band_rel']
    ratio_storm = near(s) / near(c)
    ratio_tint = rows[ctrl_t]['near']['grad_rel'] / near(c)
    ratio_smear = rows[ctrl_s]['near']['grad_rel'] / near(c)
    print(f"  near-band grad_rel 比值（对晴空）：storm {ratio_storm:.3f} · tint 对照 {ratio_tint:.3f} · smear 对照 {ratio_smear:.3f}")
    print(f"  CONTROL flat（均匀色） band_rel = {metrics(np.full(L.shape, 0.4))['band_rel']:.6f}（必须为 0）")
    # 粒子混淆对照：给晴空帧叠一层 1 px 噪声（尘丝的高频），band 不该跟着涨
    rng = np.random.default_rng(7)
    noisy = np.clip(L + rng.normal(0, 0.035, L.shape), 0, 1)
    rows['CONTROL noise(calm+1px尘丝)'] = {b: metrics(v) for b, v in bands(noisy).items()}
    nb = rows['CONTROL noise(calm+1px尘丝)']['near']['band_rel'] / rows[c]['near']['band_rel']
    print(f"  CONTROL noise（粒子混淆对照）near band 比值 {nb:.3f}（必须≈1，否则这把尺还是在量粒子）")
    ok_tint = ratio_tint > 0.9
    ok_smear = ratio_smear < 0.8
    ok_noise = 0.8 < nb < 1.25
    if not (ok_tint and ok_smear and ok_noise):
        print(f"GROUND_DETAIL_RC=3 尺子本身不可信（tint {ratio_tint:.3f} 需>0.9 · smear {ratio_smear:.3f} 需<0.8 · noise {nb:.3f} 需≈1）")
        return 3
    verdict = 'FLATTENED' if ratio_storm < 0.8 else 'SURVIVES'
    print(f"GROUND_VERDICT {verdict} 暴内近景**沙纹尺度**能级只剩 {ratio_storm:.3f}×晴空（对照：染色不掉、抹平会掉、叠粒子不涨）")
    print('GROUND_DETAIL_RC=0')
    return 0


sys.exit(main(sys.argv))
