"""Misura dove va il tempo della scansione su alcuni riquadri di Udine con stalli noti."""
import os, sys, time, json, math, random
import numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import finetune as Fm, train_torch as T
from scan_area import wms
key = os.environ['SUPABASE_SERVICE_KEY']
st = T.sb_all('stalli?select=lat,lon,comune&stato=in.(verificato,ufficiale)', key)
st = [s for s in st if 46.0 < s['lat'] < 46.12 and 13.18 < s['lon'] < 13.30]
random.seed(1); smp = random.sample(st, 12)
nets = []
for p in ['models/stalli_mobilenetv3_ft_v3.pt', 'models/stalli_mobilenetv3_ft_v2.pt']:
    n = Fm.Net(); n.load_state_dict(torch.load(p)); n.eval(); nets.append(n)
dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians(46.06))); px = 1200; px += (16 - (px - 64) % 16) % 16
tw = td = tn = 0; os.makedirs('/home/claude/prof', exist_ok=True); tiles = []
for s in smp:
    la, lo = s['lat'] - 60 * dlat, s['lon'] - 60 * dlon
    fn = f'/home/claude/prof/{la:.6f}_{lo:.6f}.npy'
    t0 = time.time()
    if os.path.exists(fn): img = np.load(fn)
    else: img = wms(la, lo, la + 120 * dlat, lo + 120 * dlon, px); np.save(fn, img)
    t1 = time.time(); sc, cx, cy = nets[0].dense(img); t2 = time.time(); k = T.nms(sc, cx, cy, 0.1); t3 = time.time()
    tw += t1 - t0; td += t2 - t1; tn += t3 - t2; tiles.append((la, lo))
n = len(smp)
print(f'per riquadro: scarico {tw / n:.2f}s · rete {td / n:.2f}s · nms {tn / n:.2f}s · px {px}')
json.dump(tiles, open('/home/claude/prof/tiles.json', 'w'))
