#!/usr/bin/env python3
"""Addestramento completo (fine-tuning) di MobileNetV3 sugli stalli etichettati.

Stessa architettura usata in train_torch.py per l'inferenza densa: features → media+massimo sulla finestra 4x4 → lineare.
Per contenere i tempi su CPU valuta su un solo gruppo di zone tenuto fuori (25%), poi riaddestra su tutto.

Uso: SUPABASE_SERVICE_KEY=... python3 finetune.py CROPS_DIR OUT_DIR [--steps 2500] [--holdout-only]
"""
import argparse, json, math, os, sys, time
import numpy as np
from PIL import Image
import torch, torchvision
sys.path.insert(0, os.path.dirname(__file__))
import train_torch as T

torch.set_num_threads(max(1, os.cpu_count() or 1))


def dihedral(p, k):
    p = np.rot90(p, k % 4); return p[:, ::-1] if k >= 4 else p


class Net(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.f = torchvision.models.mobilenet_v3_large(weights='IMAGENET1K_V2').features
        self.head = torch.nn.Linear(1920, 1)
    def pooled(self, x):
        y = self.f((x - T.MEAN) / T.STD)
        return torch.cat([y.mean((2, 3)), y.amax((2, 3))], 1)
    def forward(self, x):  # x: B,3,128,128 (patch 64 px ingranditi 2x)
        return self.head(self.pooled(x))[:, 0]
    @torch.no_grad()
    def dense(self, img):
        x = torch.from_numpy(np.ascontiguousarray(img)).permute(2, 0, 1)[None]
        x = torch.nn.functional.interpolate(x, scale_factor=T.UP, mode='bilinear', align_corners=False)
        y = self.f((x - T.MEAN) / T.STD)
        F = torch.cat([torch.nn.functional.avg_pool2d(y, T.WIN, 1), torch.nn.functional.max_pool2d(y, T.WIN, 1)], 1)
        s = torch.sigmoid(self.head(F[0].permute(1, 2, 0))[..., 0]).numpy()
        step = 32 / T.UP; c0 = T.WIN * step / 2
        return s, c0 + step * np.arange(s.shape[1]), c0 + step * np.arange(s.shape[0])


CITIES = {  # riquadri casuali di città: tetti, giardini, cortili → negativi quasi certi
    'Udine': (46.045, 13.205, 46.085, 13.265), 'Trieste': (45.630, 13.760, 45.665, 13.800), 'Pordenone': (45.945, 12.640, 45.975, 12.680),
    'Gorizia': (45.930, 13.605, 45.955, 13.640), 'Monfalcone': (45.800, 13.520, 45.820, 13.545)}


def load_extra(crops, key, cand_filter=None, n_city=120, seed=0):
    """Candidati verificati (accettati → positivi nel punto dello stallo creato; scartati → negativi nel punto proposto)
    + riquadri casuali di città (uint8) con i punti noti da evitare."""
    rng = np.random.default_rng(seed); d = os.path.join(crops, 'extra'); os.makedirs(d, exist_ok=True)
    cands = T.sb_get('candidati?select=id,lat,lon,stato,stallo_id,classe&stato=in.(accettato,scartato)&limit=10000', key)
    stalli = {r['id']: r for r in T.sb_get('stalli?select=id,lat,lon&limit=20000', key)}
    if cand_filter: cands = [c for c in cands if cand_filter(c)]
    acc, rej = [], []
    for c in cands:
        if c['stato'] == 'accettato' and c.get('stallo_id') in stalli:
            st = stalli[c['stallo_id']]; fn = os.path.join(d, f"acc-{c['id']}.jpg")
            if T.wms(st['lat'], st['lon'], 40, 400, fn): acc.append((np.asarray(Image.open(fn).convert('RGB')), 200.0, 200.0))
        elif c['stato'] == 'scartato' and (c.get('classe') or '').startswith('rete'):
            fn = os.path.join(d, f"rej-{c['id']}.jpg")
            if T.wms(c['lat'], c['lon'], 40, 400, fn): rej.append((np.asarray(Image.open(fn).convert('RGB')), 200.0, 200.0))
    known = np.array([[r['lat'], r['lon']] for r in stalli.values()] + [[c['lat'], c['lon']] for c in cands])
    city = []
    names = list(CITIES); k = 0
    while len(city) < n_city and k < n_city * 3:
        k += 1; nm = names[k % len(names)]; s0, w0, n0, e0 = CITIES[nm]
        la, lo = rng.uniform(s0, n0), rng.uniform(w0, e0); fn = os.path.join(d, f"city-{nm}-{la:.5f}-{lo:.5f}.jpg")
        if not T.wms(la, lo, 120, 1200, fn): continue
        img = np.asarray(Image.open(fn).convert('RGB')); bs, bw, bn, be = T.bbox(la, lo, 120)
        near = known[(known[:, 0] > bs - 3e-4) & (known[:, 0] < bn + 3e-4) & (known[:, 1] > bw - 4e-4) & (known[:, 1] < be + 4e-4)]
        pts = np.array([[(lo_ - bw) / (be - bw) * 1200, (bn - la_) / (bn - bs) * 1200] for la_, lo_ in near]).reshape(-1, 2)
        city.append((img, pts))
    print(f'Extra: {len(acc)} stalli confermati, {len(rej)} falsi scartati, {len(city)} riquadri casuali di città', flush=True)
    return dict(acc=acc, rej=rej, city=city)


def sampler(items, rng):
    """Generatori di patch positive / negative / negative difficili (vicine a stalli, 4.5–12 m)."""
    lab = [i for i in items if i['kind'] == 'label' and len(i['pts'])]; allc = [i for i in items if i['img'] is not None]
    def pos():
        it = lab[rng.integers(len(lab))]; x, y = it['pts'][rng.integers(len(it['pts']))]; j = rng.uniform(-T.JIT, T.JIT, 2) / T.RES
        return T.patch(it['img'], x + j[0], y + j[1])
    def neg(hard=False):
        for _ in range(50):
            it = (lab if hard else allc)[rng.integers(len(lab) if hard else len(allc))]; h, w, _ = it['img'].shape
            cx, cy = rng.uniform(T.P / 2, w - T.P / 2), rng.uniform(T.P / 2, h - T.P / 2)
            d = np.min(np.hypot(it['pts'][:, 0] - cx, it['pts'][:, 1] - cy)) * T.RES if len(it['pts']) else 1e9
            if d >= T.NEG_MIN and (not hard or d <= 12): return T.patch(it['img'], cx, cy)
        return T.patch(it['img'], w / 2, h / 2) if not len(it['pts']) else neg(False)
    return pos, neg


def extra_sampler(ex, rng):
    f = lambda a: a.astype(np.float32) / 255
    def acc():
        img, x, y = ex['acc'][rng.integers(len(ex['acc']))]; j = rng.uniform(-T.JIT, T.JIT, 2) / T.RES; return f(T.patch(img, x + j[0], y + j[1]))
    def rej():
        img, x, y = ex['rej'][rng.integers(len(ex['rej']))]; j = rng.uniform(-1.0, 1.0, 2) / T.RES; return f(T.patch(img, x + j[0], y + j[1]))
    def city():
        for _ in range(30):
            img, pts = ex['city'][rng.integers(len(ex['city']))]; cx, cy = rng.uniform(T.P / 2, 1200 - T.P / 2, 2)
            if not len(pts) or np.min(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)) * T.RES > 15: return f(T.patch(img, cx, cy))
        return f(T.patch(img, 600, 600))
    return acc, rej, city


def to_batch(ps, rng):
    b = np.stack([dihedral(p, int(rng.integers(8))) for p in ps]).astype(np.float32)
    m = b.mean(axis=(1, 2, 3), keepdims=True); b = np.clip((b - m) * rng.uniform(.85, 1.15, (len(b), 1, 1, 1)) + m + rng.uniform(-.06, .06, (len(b), 1, 1, 1)), 0, 1).astype(np.float32)
    x = torch.from_numpy(b).permute(0, 3, 1, 2)
    return torch.nn.functional.interpolate(x, scale_factor=T.UP, mode='bilinear', align_corners=False)


def train(items, steps, seed, log, extra=None):
    rng = np.random.default_rng(seed); torch.manual_seed(seed)
    net = Net(); pos, neg = sampler(items, rng)
    if extra: e_acc, e_rej, e_city = extra_sampler(extra, rng)
    opt = torch.optim.AdamW([{'params': net.f.parameters(), 'lr': 2e-4}, {'params': net.head.parameters(), 'lr': 2e-3}], weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[2e-4, 2e-3], total_steps=steps, pct_start=0.1)
    lossf = torch.nn.BCEWithLogitsLoss(); t0 = time.time(); run = 0.7
    net.train()
    for i in range(steps):
        if extra:
            ps = [pos() for _ in range(9)] + ([e_acc() for _ in range(3)] if extra['acc'] else [pos() for _ in range(3)]) + [neg() for _ in range(8)] + [neg(True) for _ in range(6)] + ([e_rej() for _ in range(4)] if extra['rej'] else [neg(True) for _ in range(4)]) + [e_city() for _ in range(6)]
        else:
            ps = [pos() for _ in range(12)] + [neg() for _ in range(14)] + [neg(True) for _ in range(10)]
        y = torch.tensor([1.] * 12 + [0.] * 24)
        x = to_batch(ps, rng); loss = lossf(net(x), y)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        run = .98 * run + .02 * loss.item()
        if (i + 1) % 100 == 0: log(f'    passo {i + 1}/{steps} · loss {run:.3f} · {time.time() - t0:.0f} s')
    return net.eval()


def evaluate(net, te, thrs=(0.5, 0.7, 0.8, 0.9, 0.95)):
    agg = {t: dict(tp=0, fp=0, fn=0, fp_empty=0, n_empty=0) for t in thrs}
    for it in te:
        s, cx, cy = net.dense(it['img']); S = it['img'].shape[0]
        for t in thrs:
            det = [d for d in T.nms(s, cx, cy, t) if 2 * T.P / 3 <= d[1] <= S - 2 * T.P / 3 and 2 * T.P / 3 <= d[2] <= S - 2 * T.P / 3]; A = agg[t]
            if it['kind'] == 'label':
                used = set()
                for _, x, y in det:
                    dd = np.hypot(it['pts'][:, 0] - x, it['pts'][:, 1] - y) * T.RES; j = int(np.argmin(dd))
                    if dd[j] <= T.MATCH and j not in used: used.add(j); A['tp'] += 1
                    else: A['fp'] += 1
                inner = [p for p in it['pts'] if 2 * T.P / 3 <= p[0] <= S - 2 * T.P / 3 and 2 * T.P / 3 <= p[1] <= S - 2 * T.P / 3]
                A['fn'] += max(0, len(inner) - len(used))
            else: A['fp_empty'] += len(det); A['n_empty'] += 1
    return agg


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('crops'); ap.add_argument('out'); ap.add_argument('--steps', type=int, default=2500); ap.add_argument('--holdout-only', action='store_true'); ap.add_argument('--final-only', action='store_true'); ap.add_argument('--extra', action='store_true'); ap.add_argument('--compare', default='')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); log = lambda m: print(m, flush=True)
    items = T.load_items(a.crops, os.environ['SUPABASE_SERVICE_KEY'], 0)
    rng = np.random.default_rng(0); zones = sorted({T.zone(i) for i in items}); rng.shuffle(zones); hold = set(zones[0::4])
    tr = [i for i in items if T.zone(i) not in hold]; te = [i for i in items if T.zone(i) in hold and not i['id'].startswith('neg-')]
    key = os.environ['SUPABASE_SERVICE_KEY']
    half = lambda c: int(c['id'].replace('-', '')[:8], 16) % 2  # metà fissa dei candidati verificati
    if a.final_only:
        ex = load_extra(a.crops, key) if a.extra else None
        log('Addestro su tutti i dati…'); net = train(items, a.steps, 1, log, ex); torch.save(net.state_dict(), os.path.join(a.out, 'final.pt')); log('Fatto.'); return
    ex = load_extra(a.crops, key, cand_filter=lambda c: half(c) == 0) if a.extra else None
    log(f"Zone tenute fuori: {len(hold)} · valutazione su {sum(i['kind'] == 'label' for i in te)} ritagli con stalli e {sum(i['kind'] == 'empty' for i in te)} senza")
    net = train(tr, a.steps, 0, log, ex)
    agg = evaluate(net, te); best = None
    log('\nValidazione (zone mai viste):')
    for t, A in agg.items():
        p = A['tp'] / max(1, A['tp'] + A['fp']); r = A['tp'] / max(1, A['tp'] + A['fn'])
        log(f"  soglia {t:.2f}: trovati {A['tp']}/{A['tp'] + A['fn']} posti (recall {r:.0%}) · precisione {p:.0%} · falsi per ritaglio senza stalli {A['fp_empty'] / max(1, A['n_empty']):.2f}")
        if r >= 0.6 and (best is None or p > best[1]): best = (t, p, r)
    torch.save(net.state_dict(), os.path.join(a.out, 'holdout.pt'))
    if a.extra:  # prova "sul campo": l'altra metà dei candidati verificati, mai vista in addestramento
        cands = [c for c in T.sb_get('candidati?select=id,lat,lon,stato,classe&stato=in.(accettato,scartato)&classe=like.rete*&limit=10000', key) if half(c) == 1]
        from sklearn.metrics import roc_auc_score
        nets = [('nuova', net)]
        if a.compare:
            old = Net(); old.load_state_dict(torch.load(a.compare)); old.eval(); nets.append(('attuale', old))
        ys = np.array([c['stato'] == 'accettato' for c in cands]); res = {}
        for name, m in nets:
            sc = []
            for c in cands:
                fn = os.path.join(a.crops, 'extra', f"eval-{c['id']}.jpg"); T.wms(c['lat'], c['lon'], 40, 400, fn)
                img = np.asarray(Image.open(fn).convert('RGB'), dtype=np.float32) / 255; s_, cx, cy = m.dense(img); gx, gy = np.meshgrid(cx, cy)
                sc.append(float(s_[np.hypot(gx - 200, gy - 200) * T.RES <= 2.5].max()))
            sc = np.array(sc); res[name] = sc
            order = np.argsort(-sc); top = ys[order]
            log(f"Candidati di Udine mai visti ({len(cands)}: {ys.sum()} veri): rete {name} · AUC {roc_auc_score(ys, sc):.2f} · tra i primi 20 veri {top[:20].sum()} · tra i primi 40 veri {top[:40].sum()} · scartati sotto 0.2 {(sc[~ys] < 0.2).mean():.0%} perdendo {(sc[ys] < 0.2).sum()} veri")
    if not a.holdout_only:
        log('\nRiaddestro su tutti i dati…'); net = train(items, a.steps, 1, log); torch.save(net.state_dict(), os.path.join(a.out, 'final.pt'))
    json.dump(dict(threshold=best[0] if best else 0.9, cv={str(k): v for k, v in agg.items()}, res=T.RES, patch=T.P, up=T.UP, steps=a.steps), open(os.path.join(a.out, 'model.json'), 'w'), indent=1)
    log('Fatto.')


if __name__ == '__main__':
    main()
