"""Intero vs celle 400/48 misurati contro gli stalli reali di Udine (città già scansionata e verificata a mano)."""
import os, sys, time, math, glob
import numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import finetune as Fm, train_torch as T
from profile_cells import cells, net, imgs, files, dlat, dlon
key = os.environ['SUPABASE_SERVICE_KEY']
st = np.array([[s['lat'], s['lon']] for s in T.sb_all('stalli?select=lat,lon&stato=in.(proposto,verificato,ufficiale)', key)])
def truth(f):
    la, lo = map(float, os.path.basename(f)[:-4].split('_')); n = la + 120 * dlat
    kn = st[(st[:, 0] > la - 5 * dlat) & (st[:, 0] < n + 5 * dlat) & (st[:, 1] > lo - 5 * dlon) & (st[:, 1] < lo + 125 * dlon)]
    return [((k[1] - lo) / dlon / 0.1, (n - k[0]) / dlat / 0.1) for k in kn]
TR = [truth(f) for f in files]
for name, fn in [('intero', lambda im: T.nms(*net.dense(im), 0.1)), ('celle 400/48', lambda im: cells(im, 400, 48)), ('celle 400/96', lambda im: cells(im, 400, 96))]:
    tp = fp = 0; t0 = time.time()
    for im, tr in zip(imgs, TR):
        for v, x, y in fn(im):
            if v < 0.55 or not (60 <= x <= 1140 and 60 <= y <= 1140): continue
            if any(math.hypot(x - a, y - b) * 0.1 <= 4 for a, b in tr): tp += 1
            else: fp += 1
    print(f'{name}: forti {tp + fp} · su uno stallo reale {tp} · altrove {fp} · precisione {tp / max(1, tp + fp):.0%} · {(time.time() - t0) / len(imgs):.2f}s', flush=True)
