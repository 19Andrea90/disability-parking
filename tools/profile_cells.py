"""Celle con margini diversi contro il riquadro intero: velocità, stalli noti ritrovati, rilevamenti forti in più/in meno."""
import os, sys, time, math, glob
import numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import finetune as Fm, train_torch as T
key = os.environ['SUPABASE_SERVICE_KEY']
net = Fm.Net(); net.load_state_dict(torch.load('models/stalli_mobilenetv3_ft_v3.pt')); net.eval(); px = 1200
st = np.array([[s['lat'], s['lon']] for s in T.sb_all('stalli?select=lat,lon&stato=in.(verificato,ufficiale)', key)])
dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians(46.06)))
def cells(img, CELL, MARG):
    got = []
    for y0 in range(0, px, CELL):
        for x0 in range(0, px, CELL):
            ya, xa = max(0, y0 - MARG), max(0, x0 - MARG); yb, xb = min(px, y0 + CELL + MARG), min(px, x0 + CELL + MARG)
            s, cx, cy = net.dense(np.ascontiguousarray(img[ya:yb, xa:xb]))
            for v, x, y in T.nms(s, cx, cy, 0.1):
                X, Y = x + xa, y + ya
                if x0 <= X < x0 + CELL and y0 <= Y < y0 + CELL: got.append((v, X, Y))
    got.sort(reverse=True); k = []
    for v, x, y in got:
        if all(math.hypot(x - a, y - b) * T.RES > T.NMS for _, a, b in k): k.append((v, x, y))
    return k
files = sorted(glob.glob('/home/claude/prof/*.npy')); imgs = [np.load(f) for f in files]
if __name__ == '__main__':
    t0 = time.time(); FULL = [T.nms(*net.dense(im), 0.1) for im in imgs]; tfull = time.time() - t0
    def known(f):
        la, lo = map(float, os.path.basename(f)[:-4].split('_')); n = la + 120 * dlat
        kn = st[(st[:, 0] > la + 6 * dlat) & (st[:, 0] < n - 6 * dlat) & (st[:, 1] > lo + 6 * dlon) & (st[:, 1] < lo + 114 * dlon)]
        return [((k[1] - lo) / dlon / 0.1, (n - k[0]) / dlat / 0.1) for k in kn]
    KP = [known(f) for f in files]
    def score(dets):
        hit = sum(sum(any(v >= 0.2 and math.hypot(x - a, y - b) * 0.1 <= 3 for v, x, y in d) for a, b in kp) for d, kp in zip(dets, KP))
        plus = sum(sum(1 for v, x, y in c if v >= 0.55 and not any(w >= 0.55 and math.hypot(x - a, y - b) * 0.1 <= 2 for w, a, b in f)) for c, f in zip(dets, FULL))
        minus = sum(sum(1 for v, x, y in f if v >= 0.55 and not any(w >= 0.55 and math.hypot(x - a, y - b) * 0.1 <= 2 for w, a, b in c)) for c, f in zip(dets, FULL))
        return hit, plus, minus
    print(f'intero: {tfull / len(imgs):.2f}s/riquadro · stalli noti {score(FULL)[0]}/{sum(map(len, KP))}', flush=True)
    for CELL, MARG in [(400, 96), (600, 96), (600, 160), (400, 160)]:
        t0 = time.time(); D = [cells(im, CELL, MARG) for im in imgs]; t = time.time() - t0
        h, p, m = score(D)
        print(f'celle {CELL} margine {MARG}: {t / len(imgs):.2f}s ({tfull / t:.2f}×) · stalli noti {h} · forti in più {p} · forti persi {m}', flush=True)
