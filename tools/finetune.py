#!/usr/bin/env python3
"""Addestramento completo (fine-tuning) di MobileNetV3 sugli stalli etichettati.

Stessa architettura usata in train_torch.py per l'inferenza densa: features → media+massimo sulla finestra 4x4 → lineare.
Per contenere i tempi su CPU valuta su un solo gruppo di zone tenuto fuori (25%), poi riaddestra su tutto.

Uso: SUPABASE_SERVICE_KEY=... python3 finetune.py CROPS_DIR OUT_DIR [--steps 2500] [--holdout-only]
"""
import argparse, json, math, os, sys, time
import numpy as np
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


def to_batch(ps, rng):
    b = np.stack([dihedral(p, int(rng.integers(8))) for p in ps]).astype(np.float32)
    m = b.mean(axis=(1, 2, 3), keepdims=True); b = np.clip((b - m) * rng.uniform(.85, 1.15, (len(b), 1, 1, 1)) + m + rng.uniform(-.06, .06, (len(b), 1, 1, 1)), 0, 1)
    x = torch.from_numpy(b).permute(0, 3, 1, 2)
    return torch.nn.functional.interpolate(x, scale_factor=T.UP, mode='bilinear', align_corners=False)


def train(items, steps, seed, log):
    rng = np.random.default_rng(seed); torch.manual_seed(seed)
    net = Net(); pos, neg = sampler(items, rng)
    opt = torch.optim.AdamW([{'params': net.f.parameters(), 'lr': 2e-4}, {'params': net.head.parameters(), 'lr': 2e-3}], weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[2e-4, 2e-3], total_steps=steps, pct_start=0.1)
    lossf = torch.nn.BCEWithLogitsLoss(); t0 = time.time(); run = 0.7
    net.train()
    for i in range(steps):
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
    ap = argparse.ArgumentParser(); ap.add_argument('crops'); ap.add_argument('out'); ap.add_argument('--steps', type=int, default=2500); ap.add_argument('--holdout-only', action='store_true')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True); log = lambda m: print(m, flush=True)
    items = T.load_items(a.crops, os.environ['SUPABASE_SERVICE_KEY'], 0)
    rng = np.random.default_rng(0); zones = sorted({T.zone(i) for i in items}); rng.shuffle(zones); hold = set(zones[0::4])
    tr = [i for i in items if T.zone(i) not in hold]; te = [i for i in items if T.zone(i) in hold and not i['id'].startswith('neg-')]
    log(f"Zone tenute fuori: {len(hold)} · valutazione su {sum(i['kind'] == 'label' for i in te)} ritagli con stalli e {sum(i['kind'] == 'empty' for i in te)} senza")
    net = train(tr, a.steps, 0, log)
    agg = evaluate(net, te); best = None
    log('\nValidazione (zone mai viste):')
    for t, A in agg.items():
        p = A['tp'] / max(1, A['tp'] + A['fp']); r = A['tp'] / max(1, A['tp'] + A['fn'])
        log(f"  soglia {t:.2f}: trovati {A['tp']}/{A['tp'] + A['fn']} posti (recall {r:.0%}) · precisione {p:.0%} · falsi per ritaglio senza stalli {A['fp_empty'] / max(1, A['n_empty']):.2f}")
        if r >= 0.6 and (best is None or p > best[1]): best = (t, p, r)
    torch.save(net.state_dict(), os.path.join(a.out, 'holdout.pt'))
    if not a.holdout_only:
        log('\nRiaddestro su tutti i dati…'); net = train(items, a.steps, 1, log); torch.save(net.state_dict(), os.path.join(a.out, 'final.pt'))
    json.dump(dict(threshold=best[0] if best else 0.9, cv={str(k): v for k, v in agg.items()}, res=T.RES, patch=T.P, up=T.UP, steps=a.steps), open(os.path.join(a.out, 'model.json'), 'w'), indent=1)
    log('Fatto.')


if __name__ == '__main__':
    main()
