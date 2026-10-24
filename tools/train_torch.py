#!/usr/bin/env python3
"""Rilevatore di stalli riservati su ortofoto FVG con rete pre-addestrata (MobileNetV3, ImageNet) + testa lineare.

Legge le etichette direttamente da Supabase (tabella `etichette`), usa i ritagli scaricati da fetch_crops.py,
valuta il rilevamento su zone geografiche tenute fuori e salva il modello.

Uso: SUPABASE_SERVICE_KEY=... python3 train_torch.py CROPS_DIR OUT_DIR [--fake N]
  --fake N  collaudo senza etichette: usa i punti OSM di N stalli come se fossero clic (solo per verificare il codice)
"""
import argparse, json, math, os, time, urllib.request, urllib.parse
import numpy as np
from PIL import Image
import torch, torchvision
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

SB = 'https://wwereqrojlwktgwlrsib.supabase.co'
WMS = 'https://irdat-ortofoto.regione.fvg.it/geoserver/ortofoto/ows'
RES = 0.1          # m/px dei ritagli
P = 64             # finestra 6.4 m
UP = 2             # ingrandimento prima della rete (128 px)
JIT = 0.5          # m
NEG_MIN = 4.5      # m
MATCH = 2.0        # m
NMS = 3.0          # m
STRIDE = 10        # px (1 m) per la valutazione densa
torch.set_num_threads(max(1, os.cpu_count() or 1))
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1); STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)


def sb_get(path, key):
    req = urllib.request.Request(f'{SB}/rest/v1/{path}', headers={'apikey': key, 'Authorization': f'Bearer {key}'})
    return json.load(urllib.request.urlopen(req, timeout=60))


def bbox(lat, lon, side):
    dlat = 1 / 111320; dlon = 1 / (111320 * math.cos(math.radians(lat))); h = side / 2
    return lat - h * dlat, lon - h * dlon, lat + h * dlat, lon + h * dlon


def wms(lat, lon, side, px, path):
    if os.path.exists(path) and os.path.getsize(path) > 2000: return True
    s, w, n, e = bbox(lat, lon, side)
    q = urllib.parse.urlencode({'SERVICE': 'WMS', 'VERSION': '1.1.1', 'REQUEST': 'GetMap', 'LAYERS': 'trueorto_FVG_1720', 'STYLES': '', 'SRS': 'EPSG:4326',
                                'BBOX': f'{w},{s},{e},{n}', 'WIDTH': px, 'HEIGHT': px, 'FORMAT': 'image/jpeg'})
    try:
        d = urllib.request.urlopen(f'{WMS}?{q}', timeout=60).read()
        if d[:2] == b'\xff\xd8': open(path, 'wb').write(d); return True
    except Exception: pass
    return False


def load_items(crops, key, fake):
    stalli = {r['id']: r for r in json.load(open(os.path.join(crops, 'stalli.json')))}
    items = []
    if fake:
        labs = [{'ref_id': r['id'], 'centro_lat': r['lat'], 'centro_lon': r['lon'], 'crop_m': 60 if 'Parcheggio con posti' in (r.get('nome') or '') else 40,
                 'esito': 'stalli', 'punti': [[r['lat'], r['lon']]]} for r in list(stalli.values())[:fake] if 'Parcheggio con posti' not in (r.get('nome') or '')]
    else:
        labs = sb_get('etichette?select=*&limit=10000', key)
    for l in labs:
        fn = os.path.join(crops, f"{l['ref_id']}.jpg")
        if not os.path.exists(fn) and not wms(l['centro_lat'], l['centro_lon'], l['crop_m'], 400, fn): continue
        side = float(l['crop_m']); S = int(round(side / RES))
        img = np.asarray(Image.open(fn).convert('RGB').resize((S, S), Image.BILINEAR), dtype=np.float32) / 255
        s, w, n, e = bbox(l['centro_lat'], l['centro_lon'], side)
        pts = np.array([[(lo - w) / (e - w) * S, (n - la) / (n - s) * S] for la, lo in (l['punti'] or [])], np.float32).reshape(-1, 2)
        items.append(dict(id=l['ref_id'], kind='label' if l['esito'] == 'stalli' else 'empty', img=img, pts=pts, lat=l['centro_lat'], lon=l['centro_lon']))
    # candidati scartati: ritagli 24 m senza stalli
    negdir = os.path.join(crops, 'neg'); os.makedirs(negdir, exist_ok=True)
    for c in sb_get('candidati?select=id,lat,lon&stato=eq.scartato&limit=10000', key):
        fn = os.path.join(negdir, f"{c['id']}.jpg")
        if not wms(c['lat'], c['lon'], 24, 240, fn): continue
        img = np.asarray(Image.open(fn).convert('RGB'), dtype=np.float32) / 255
        items.append(dict(id='neg-' + c['id'], kind='empty', img=img, pts=np.zeros((0, 2), np.float32), lat=c['lat'], lon=c['lon']))
    return items


def zone(it, cell=0.04): return f"{int(it['lat'] / cell)}_{int(it['lon'] / cell)}"


def patch(img, cx, cy):
    x0, y0 = int(round(cx - P / 2)), int(round(cy - P / 2)); h, w, _ = img.shape
    if x0 < 0 or y0 < 0 or x0 + P > w or y0 + P > h:
        img = np.pad(img, ((P, P), (P, P), (0, 0)), mode='reflect'); x0 += P; y0 += P
    return img[y0:y0 + P, x0:x0 + P]


CACHE = None            # cartella per le caratteristiche già calcolate
CELL = 32 // UP * RES    # 1.6 m: passo della mappa di caratteristiche sul terreno
WIN = 4                  # finestra 4x4 celle = 6.4 m


class Backbone:
    def __init__(self):
        m = torchvision.models.mobilenet_v3_large(weights='IMAGENET1K_V2').eval(); self.f = m.features
    @torch.no_grad()
    def windows(self, img):
        """Una sola passata sull'intero ritaglio. Ritorna (F[Ny,Nx,1920] float16, cx[Nx], cy[Ny]) con i centri delle finestre in px del ritaglio."""
        x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1)[None]
        x = torch.nn.functional.interpolate(x, scale_factor=UP, mode='bilinear', align_corners=False)
        y = self.f((x - MEAN) / STD)
        mean = torch.nn.functional.avg_pool2d(y, WIN, 1); mx = torch.nn.functional.max_pool2d(y, WIN, 1)
        F = torch.cat([mean, mx], 1)[0].permute(1, 2, 0).numpy().astype(np.float16)
        step = 32 / UP; c0 = WIN * step / 2
        return F, c0 + step * np.arange(F.shape[1]), c0 + step * np.arange(F.shape[0])


def rot_pts(pts, k, S):
    """Coordinate dei punti dopo np.rot90(img, k) su un'immagine SxS (rotazione antioraria)."""
    p = pts.copy()
    for _ in range(k % 4): p = np.stack([p[:, 1], S - p[:, 0]], 1) if len(p) else p
    return p


def featurize(items, bb, rng):
    """Per ogni ritaglio: mappa a rotazione 0 (per la valutazione) + campioni di addestramento da 4 rotazioni."""
    t0 = time.time()
    for n, it in enumerate(items):
        img = it['img']; S = img.shape[0]; it['train'] = []
        for k in range(4):
            cf = os.path.join(CACHE, f"{it['id']}_{S}_{k}.npz") if CACHE else None
            if cf and os.path.exists(cf):
                z = np.load(cf); F, cx, cy = z['F'], z['cx'], z['cy']
            else:
                F, cx, cy = bb.windows(np.rot90(img, k))
                if cf: np.savez(cf, F=F, cx=cx, cy=cy)
            if k == 0 and not it['id'].startswith('neg-'): it['map'] = cf  # riletta dal disco in valutazione
            pts = rot_pts(it['pts'], k, S)
            gx, gy = np.meshgrid(cx, cy)
            border = (gx >= 2 * P / 3) & (gx <= S - 2 * P / 3) & (gy >= 2 * P / 3) & (gy <= S - 2 * P / 3)
            if len(pts):
                d = np.min(np.hypot(gx[..., None] - pts[:, 0], gy[..., None] - pts[:, 1]), -1) * RES
            else:
                d = np.full(gx.shape, 1e9)
            pos = np.argwhere((d <= 1.0)); neg = np.argwhere((d >= NEG_MIN) & border)
            want = 25 if it['kind'] == 'label' else (25 if not it['id'].startswith('neg-') else 6)
            if len(neg) > want: neg = neg[rng.choice(len(neg), want, replace=False)]
            idx = np.concatenate([pos, neg]) if len(pos) else neg
            if len(idx):
                it['train'].append((np.array(F[idx[:, 0], idx[:, 1]], dtype=np.float16), np.r_[np.ones(len(pos)), np.zeros(len(neg))]))  # copia: non tiene viva la mappa intera
            del F
        it['S'] = S; it['img'] = None  # libero subito la memoria
        if (n + 1) % 50 == 0: print(f'    caratteristiche {n + 1}/{len(items)} · {time.time() - t0:.0f} s', flush=True)


def stack(items):
    X = np.concatenate([f for it in items for f, _ in it['train']]).astype(np.float32); y = np.concatenate([l for it in items for _, l in it['train']]).astype(int); return X, y


def nms(s, cx, cy, thr):
    c = sorted(((s[i, j], cx[j], cy[i]) for i in range(s.shape[0]) for j in range(s.shape[1]) if s[i, j] >= thr), reverse=True); k = []
    for v, x, y in c:
        if all(math.hypot(x - a, y - b) * RES > NMS for _, a, b in k): k.append((v, x, y))
    return k


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('crops'); ap.add_argument('out'); ap.add_argument('--fake', type=int, default=0); ap.add_argument('--folds', type=int, default=4)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); key = os.environ['SUPABASE_SERVICE_KEY']; t0 = time.time()
    items = load_items(a.crops, key, a.fake)
    L = [i for i in items if i['kind'] == 'label']
    print(f"Ritagli: {len(L)} con stalli ({sum(len(i['pts']) for i in L)} posti) · {sum(i['kind'] == 'empty' and not i['id'].startswith('neg-') for i in items)} senza stalli visibili · {sum(i['id'].startswith('neg-') for i in items)} candidati scartati", flush=True)
    global CACHE; CACHE = os.path.join(a.crops, 'feat'); os.makedirs(CACHE, exist_ok=True)
    bb = Backbone(); rng = np.random.default_rng(0)
    print('Calcolo le caratteristiche (una passata per ritaglio e rotazione)…', flush=True)
    featurize(items, bb, rng)
    zones = sorted({zone(i) for i in items}); rng.shuffle(zones); folds = [set(zones[k::a.folds]) for k in range(a.folds)]
    thrs = [0.5, 0.7, 0.8, 0.9, 0.95]; agg = {t: dict(tp=0, fp=0, fn=0, fp_empty=0, n_empty=0) for t in thrs}
    for k, zs in enumerate(folds):
        tr = [i for i in items if zone(i) not in zs]; te = [i for i in items if zone(i) in zs and not i['id'].startswith('neg-')]
        if not any(i['kind'] == 'label' for i in te): continue
        X, y = stack(tr); sc = StandardScaler().fit(X)
        head = LogisticRegression(C=0.05, class_weight='balanced', max_iter=4000).fit(sc.transform(X), y)
        for it in te:
            z = np.load(it['map']); F, cx, cy = z['F'], z['cx'], z['cy']; S = it['S']
            s_ = head.predict_proba(sc.transform(F.reshape(-1, F.shape[-1]).astype(np.float32)))[:, 1].reshape(F.shape[:2])
            for t in thrs:
                det = [d for d in nms(s_, cx, cy, t) if 2 * P / 3 <= d[1] <= S - 2 * P / 3 and 2 * P / 3 <= d[2] <= S - 2 * P / 3]
                A = agg[t]
                if it['kind'] == 'label':
                    used = set()
                    for _, x, yy in det:
                        dd = np.hypot(it['pts'][:, 0] - x, it['pts'][:, 1] - yy) * RES; j = int(np.argmin(dd))
                        if dd[j] <= MATCH and j not in used: used.add(j); A['tp'] += 1
                        else: A['fp'] += 1
                    # i posti vicino al bordo non sono valutabili (la finestra non ci arriva)
                    inner = [(px_, py_) for px_, py_ in it['pts'] if 2 * P / 3 <= px_ <= S - 2 * P / 3 and 2 * P / 3 <= py_ <= S - 2 * P / 3]
                    A['fn'] += max(0, len(inner) - len(used))
                else:
                    A['fp_empty'] += len(det); A['n_empty'] += 1
        print(f'  zona {k + 1}/{a.folds}: addestrato su {len(y)} esempi ({int(y.sum())} positivi) · {time.time() - t0:.0f} s', flush=True)
    print('\nValidazione su zone mai viste in addestramento (ritagli 40×40 m attorno a stalli noti):')
    best = None
    for t in thrs:
        A = agg[t]; p = A['tp'] / max(1, A['tp'] + A['fp']); r = A['tp'] / max(1, A['tp'] + A['fn'])
        print(f"  soglia {t:.2f}: trovati {A['tp']}/{A['tp'] + A['fn']} posti (recall {r:.0%}) · precisione {p:.0%} · falsi per ritaglio senza stalli {A['fp_empty'] / max(1, A['n_empty']):.2f}")
        if r >= 0.6 and (best is None or p > best[1]): best = (t, p, r)
    X, y = stack(items); sc = StandardScaler().fit(X)
    head = LogisticRegression(C=0.05, class_weight='balanced', max_iter=4000).fit(sc.transform(X), y)
    np.savez(os.path.join(a.out, 'head.npz'), coef=head.coef_[0], intercept=head.intercept_, mean=sc.mean_, scale=sc.scale_)
    json.dump(dict(backbone='mobilenet_v3_large IMAGENET1K_V2 features, mean+max', res=RES, patch=P, up=UP, threshold=best[0] if best else 0.9, nms_m=NMS,
                   cv={str(t): agg[t] for t in thrs}, trained=time.strftime('%Y-%m-%d %H:%M')), open(os.path.join(a.out, 'model.json'), 'w'), indent=1)
    print(f'Modello salvato in {a.out} · soglia scelta {best[0] if best else 0.9} · tempo totale {time.time() - t0:.0f} s')


if __name__ == '__main__':
    main()
