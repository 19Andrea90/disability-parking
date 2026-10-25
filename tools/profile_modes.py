"""Confronta modalità di inferenza sugli stessi riquadri: tempo e stalli noti ritrovati."""
import os, sys, time, json, math, glob
import numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import finetune as Fm, train_torch as T
key = os.environ['SUPABASE_SERVICE_KEY']
net = Fm.Net(); net.load_state_dict(torch.load('models/stalli_mobilenetv3_ft_v3.pt')); net.eval()
st = np.array([[s['lat'], s['lon']] for s in T.sb_all('stalli?select=lat,lon&stato=in.(verificato,ufficiale)', key)])
dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians(46.06))); px = 1200

def dense_bf16(img):
    with torch.autocast('cpu', dtype=torch.bfloat16):
        s, cx, cy = net.dense(img)
    return s.astype(np.float32) if hasattr(s, 'astype') else s, cx, cy

def cells(img, fn, CELL=400, MARG=48):
    got = []
    for y0 in range(0, px, CELL):
        for x0 in range(0, px, CELL):
            ya, xa = max(0, y0 - MARG), max(0, x0 - MARG); yb, xb = min(px, y0 + CELL + MARG), min(px, x0 + CELL + MARG)
            s, cx, cy = fn(np.ascontiguousarray(img[ya:yb, xa:xb]))
            for v, x, y in T.nms(s, cx, cy, 0.1):
                X, Y = x + xa, y + ya
                if x0 <= X < x0 + CELL and y0 <= Y < y0 + CELL: got.append((v, X, Y))
    got.sort(reverse=True); k = []
    for v, x, y in got:
        if all(math.hypot(x - a, y - b) * T.RES > T.NMS for _, a, b in k): k.append((v, x, y))
    return k

modes = {'intero fp32': lambda im: T.nms(*net.dense(im), 0.1), 'celle fp32': lambda im: cells(im, net.dense),
         'intero bf16': lambda im: T.nms(*dense_bf16(im), 0.1), 'celle bf16': lambda im: cells(im, dense_bf16)}
files = sorted(glob.glob('/home/claude/prof/*.npy'))
R = {m: dict(t=0, hit=0, n02=0, n55=0) for m in modes}; nknown = 0
for f in files:
    la, lo = map(float, os.path.basename(f)[:-4].split('_')); img = np.load(f); n = la + 120 * dlat
    kn = st[(st[:, 0] > la + 6 * dlat) & (st[:, 0] < n - 6 * dlat) & (st[:, 1] > lo + 6 * dlon) & (st[:, 1] < lo + 114 * dlon)]
    kp = [((k[1] - lo) / dlon / 0.1, (n - k[0]) / dlat / 0.1) for k in kn]; nknown += len(kp)
    for m, fn in modes.items():
        t0 = time.time(); det = fn(img); R[m]['t'] += time.time() - t0
        R[m]['hit'] += sum(any(v >= 0.2 and math.hypot(x - a, y - b) * 0.1 <= 3 for v, x, y in det) for a, b in kp)
        R[m]['n02'] += sum(v >= 0.2 for v, _, _ in det); R[m]['n55'] += sum(v >= 0.55 for v, _, _ in det)
base = R['intero fp32']['t']
for m, r in R.items():
    print(f"{m:12s} · {r['t'] / len(files):.2f}s/riquadro ({base / r['t']:.2f}×) · stalli noti ritrovati {r['hit']}/{nknown} · rilevamenti ≥0.2 {r['n02']} · ≥0.55 {r['n55']}")
