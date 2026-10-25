"""Confronta la scansione densa intera con quella solo nelle celle vicine a strade/parcheggi (stessi riquadri)."""
import os, sys, time, json, math, urllib.request
import numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import finetune as Fm, train_torch as T
from shapely.geometry import Polygon, LineString, box
from shapely.strtree import STRtree
net = Fm.Net(); net.load_state_dict(torch.load('models/stalli_mobilenetv3_ft_v3.pt')); net.eval()
SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
data = json.loads(urllib.request.urlopen(f'{SB}/storage/v1/object/public/foto/contesto/udine-202610251007.json', timeout=120).read())
P = lambda pts: [(lo, la) for la, lo in pts]
lines = [LineString(P(p)) for p in data['strade'] if len(p) >= 2] + [Polygon(P(p)) for p in data['parcheggi'] if len(p) >= 4]
tree = STRtree(lines)
dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians(46.06))); px = 1200
CELL = int(sys.argv[1]) if len(sys.argv) > 1 else 400; MARG = int(sys.argv[2]) if len(sys.argv) > 2 else 48; BUF = float(sys.argv[3]) if len(sys.argv) > 3 else 12
tiles = json.load(open('/home/claude/prof/tiles.json'))
# più alcuni riquadri periferici a caso con strade
rng = np.random.default_rng(0); extra = []
while len(extra) < 12:
    la, lo = rng.uniform(46.005, 46.11), rng.uniform(13.19, 13.29)
    if len(tree.query(box(lo, la, lo + 120 * dlon, la + 120 * dlat))): extra.append((la, lo))
from scan_area import wms
tf = tm = 0; agree = miss = new = 0; frac = []
for la, lo in tiles + extra:
    fn = f'/home/claude/prof/{la:.6f}_{lo:.6f}.npy'
    img = np.load(fn) if os.path.exists(fn) else wms(la, lo, la + 120 * dlat, lo + 120 * dlon, px)
    if img is None: continue
    np.save(fn, img)
    t0 = time.time(); s, cx, cy = net.dense(img); full = [k for k in T.nms(s, cx, cy, 0.1)]; t1 = time.time()
    n = la + 120 * dlat; got = []; need = 0; tot = 0
    for y0 in range(0, px, CELL):
        for x0 in range(0, px, CELL):
            tot += 1
            cs, cw = n - (y0 + CELL) * 0.1 * dlat, lo + x0 * 0.1 * dlon; cn, ce = n - y0 * 0.1 * dlat, lo + (x0 + CELL) * 0.1 * dlon
            g = box(cw - BUF * dlon, cs - BUF * dlat, ce + BUF * dlon, cn + BUF * dlat)
            if not any(lines[i].intersects(g) for i in tree.query(g)): continue
            need += 1
            ya, xa = max(0, y0 - MARG), max(0, x0 - MARG); yb, xb = min(px, y0 + CELL + MARG), min(px, x0 + CELL + MARG)
            sub = np.ascontiguousarray(img[ya:yb, xa:xb]); s2, cx2, cy2 = net.dense(sub)
            for v, x, y in T.nms(s2, cx2, cy2, 0.1):
                X, Y = x + xa, y + ya
                if x0 <= X < x0 + CELL and y0 <= Y < y0 + CELL: got.append((v, X, Y))
    got.sort(reverse=True); k2 = []
    for v, x, y in got:
        if all(math.hypot(x - a, y - b) * T.RES > T.NMS for _, a, b in k2): k2.append((v, x, y))
    t2 = time.time(); tf += t1 - t0; tm += t2 - t1; frac.append(need / tot)
    F = [k for k in full if k[0] >= 0.2]; M = [k for k in k2 if k[0] >= 0.2]
    for v, x, y in F:
        mm = [w for w, a, b in M if math.hypot(x - a, y - b) * T.RES <= 2]
        if mm: agree += 1
        else: miss += 1
    new += sum(1 for w, a, b in M if not any(math.hypot(x - a, y - b) * T.RES <= 2 for _, x, y in F))
print(f'cella {CELL} px, margine {MARG} px, fascia {BUF} m · celle calcolate {np.mean(frac):.0%} · tempo intero {tf:.0f}s → a celle {tm:.0f}s ({tf / tm:.2f}×) · rilevamenti ≥0.2: uguali {agree}, persi {miss}, nuovi {new}')
