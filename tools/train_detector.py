#!/usr/bin/env python3
"""Rilevatore di stalli riservati (segnaletica gialla) su ortofoto: piccola rete convoluzionale in JAX/Flax.

Dataset v2 (esportato dall'admin): meta.json + img/*.jpg
  item kind="label": ritaglio attorno a uno stallo noto, `points` = centri cliccati (pixel) dei posti riservati visibili.
                     Tutto il resto del ritaglio è un esempio negativo (l'etichettatore clicca TUTTI i posti visibili).
  item kind="neg":   ritaglio di un candidato scartato, nessun posto riservato.

Uso:
  python3 train_detector.py DATASET_DIR OUT_DIR [--eval-only] [--steps N]
Produce OUT_DIR/detector.json (pesi + parametri) e stampa le metriche sulla validazione per zone geografiche.
"""
import argparse, json, os, time
import numpy as np
from PIL import Image
import jax, jax.numpy as jnp
import flax.linen as nn
import optax

RES = 0.15        # metri per pixel su cui lavora il modello
P = 48            # lato della finestra (7.2 m)
POS_JITTER = 0.6  # m di spostamento casuale dei positivi
NEG_MIN_DIST = 4.5  # m: i negativi presi nei ritagli etichettati stanno ad almeno questa distanza da ogni posto
MATCH_DIST = 2.0  # m: una rilevazione è corretta se entro questa distanza da un posto cliccato
NMS_DIST = 3.0    # m


# ----------------------------------------------------------------------------- dati
def load_dataset(folder):
    meta = json.load(open(os.path.join(folder, 'meta.json')))
    items = []
    for it in meta['items']:
        fn = os.path.join(folder, 'img', it['id'] + '.jpg')
        if not os.path.exists(fn):
            continue
        im = Image.open(fn).convert('RGB')
        side_px = int(round(it['crop_m'] / RES))
        sc = side_px / im.width
        im = im.resize((side_px, side_px), Image.BILINEAR)
        arr = np.asarray(im, dtype=np.float32) / 255.0
        pts = np.array([[x * sc, y * sc] for x, y in it.get('points', [])], dtype=np.float32).reshape(-1, 2)
        items.append({'id': it['id'], 'kind': it['kind'], 'img': arr, 'pts': pts, 'lat': it['lat'], 'lon': it['lon']})
    return items


def group_of(it, cell=0.04):
    # zone di ~3-4 km: la validazione tiene fuori zone intere, non singoli ritagli vicini a quelli di addestramento
    return f"{int(it['lat'] / cell)}_{int(it['lon'] / cell)}"


def sample_patch(img, cx, cy):
    h, w, _ = img.shape
    x0, y0 = int(round(cx - P / 2)), int(round(cy - P / 2))
    if x0 < 0 or y0 < 0 or x0 + P > w or y0 + P > h:
        pad = P
        img = np.pad(img, ((pad, pad), (pad, pad), (0, 0)), mode='reflect')
        x0 += pad; y0 += pad
    return img[y0:y0 + P, x0:x0 + P]


def build_pools(items, rng):
    pos, neg, hard = [], [], []
    for it in items:
        img, pts = it['img'], it['pts']; h, w, _ = img.shape
        if it['kind'] == 'label':
            for (x, y) in pts:
                for _ in range(12):
                    j = rng.uniform(-POS_JITTER, POS_JITTER, 2) / RES
                    pos.append(sample_patch(img, x + j[0], y + j[1]))
            n = 0; tries = 0
            while n < 40 and tries < 400:
                tries += 1
                cx, cy = rng.uniform(P / 2, w - P / 2), rng.uniform(P / 2, h - P / 2)
                if len(pts) and np.min(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)) * RES < NEG_MIN_DIST:
                    continue
                (hard if len(pts) and np.min(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)) * RES < 10 else neg).append(sample_patch(img, cx, cy)); n += 1
        else:
            for _ in range(10):
                cx, cy = rng.uniform(P / 2, w - P / 2), rng.uniform(P / 2, h - P / 2)
                neg.append(sample_patch(img, cx, cy))
            neg.append(sample_patch(img, w / 2, h / 2))  # il punto proposto dal vecchio scanner: negativo "difficile"
    to = lambda L: np.stack(L).astype(np.float32) if L else np.zeros((0, P, P, 3), np.float32)
    return to(pos), to(neg), to(hard)


def augment(x, rng):
    k = rng.integers(0, 4); x = np.rot90(x, k, axes=(1, 2))
    if rng.random() < 0.5: x = x[:, :, ::-1]
    b = rng.uniform(-0.08, 0.08, (x.shape[0], 1, 1, 1)); c = rng.uniform(0.85, 1.15, (x.shape[0], 1, 1, 1))
    m = x.mean(axis=(1, 2, 3), keepdims=True)
    return np.clip((x - m) * c + m + b, 0, 1).astype(np.float32)


# ----------------------------------------------------------------------------- modello
class Net(nn.Module):
    @nn.compact
    def __call__(self, x):
        x = x - 0.5
        for ch in (24, 32, 48, 64):
            x = nn.relu(nn.Conv(ch, (3, 3))(x))
            x = nn.relu(nn.Conv(ch, (3, 3))(x))
            x = nn.max_pool(x, (2, 2), (2, 2))
        x = jnp.concatenate([x.mean(axis=(1, 2)), x.max(axis=(1, 2))], axis=-1)
        x = nn.relu(nn.Dense(64)(x))
        return nn.Dense(1)(x)[:, 0]


def train(pos, neg, hard, steps, seed=0, log=True):
    rng = np.random.default_rng(seed)
    model = Net(); params = model.init(jax.random.PRNGKey(seed), jnp.zeros((1, P, P, 3)))
    sched = optax.cosine_decay_schedule(2e-3, steps)
    opt = optax.adamw(sched, weight_decay=1e-4); st = opt.init(params)

    @jax.jit
    def step(params, st, x, y):
        def loss_fn(p):
            logits = model.apply(p, x)
            return optax.sigmoid_binary_cross_entropy(logits, y).mean()
        l, g = jax.value_and_grad(loss_fn)(params)
        upd, st = opt.update(g, st, params)
        return optax.apply_updates(params, upd), st, l

    bp, bn, bh = 16, 32, 16 if len(hard) else 0
    if not len(hard): bn = 48
    t0 = time.time(); run = 0
    for i in range(steps):
        xs = [pos[rng.integers(0, len(pos), bp)], neg[rng.integers(0, len(neg), bn)]]
        ys = [np.ones(bp), np.zeros(bn)]
        if bh: xs.append(hard[rng.integers(0, len(hard), bh)]); ys.append(np.zeros(bh))
        x = augment(np.concatenate(xs), rng); y = np.concatenate(ys).astype(np.float32)
        params, st, l = step(params, st, jnp.asarray(x), jnp.asarray(y))
        run = 0.98 * run + 0.02 * float(l)
        if log and (i + 1) % 500 == 0:
            print(f'    passo {i + 1}/{steps} · loss {run:.3f} · {time.time() - t0:.0f} s', flush=True)
    return model, params


# ----------------------------------------------------------------------------- rilevazione densa
def score_map(model, params, img, stride=4):
    h, w, _ = img.shape
    ys = list(range(0, h - P + 1, stride)); xs = list(range(0, w - P + 1, stride))
    patches = np.stack([img[y:y + P, x:x + P] for y in ys for x in xs]).astype(np.float32)
    out = []
    f = jax.jit(lambda p, x: jax.nn.sigmoid(model.apply(p, x)))
    for i in range(0, len(patches), 1024):
        out.append(np.asarray(f(params, jnp.asarray(patches[i:i + 1024]))))
    s = np.concatenate(out).reshape(len(ys), len(xs))
    cy = np.array(ys) + P / 2; cx = np.array(xs) + P / 2
    return s, cx, cy


def detect(s, cx, cy, thr):
    cand = [(s[i, j], cx[j], cy[i]) for i in range(s.shape[0]) for j in range(s.shape[1]) if s[i, j] >= thr]
    cand.sort(reverse=True); keep = []
    for sc, x, y in cand:
        if all(np.hypot(x - kx, y - ky) * RES > NMS_DIST for _, kx, ky in keep):
            keep.append((sc, x, y))
    return keep


def evaluate(model, params, items, thrs=(0.5, 0.7, 0.85, 0.95)):
    maps = [(it, *score_map(model, params, it['img'])) for it in items]
    res = {}
    for thr in thrs:
        tp = fp = fn = 0; fp_neg = 0; n_neg = 0
        for it, s, cx, cy in maps:
            det = detect(s, cx, cy, thr)
            h, w, _ = it['img'].shape
            # contano solo le rilevazioni lontane dal bordo (dove il ritaglio è completo)
            det = [d for d in det if P / 2 <= d[1] <= w - P / 2 and P / 2 <= d[2] <= h - P / 2]
            if it['kind'] == 'label':
                used = set()
                for _, x, y in det:
                    if len(it['pts']):
                        dd = np.hypot(it['pts'][:, 0] - x, it['pts'][:, 1] - y) * RES; k = int(np.argmin(dd))
                        if dd[k] <= MATCH_DIST and k not in used:
                            used.add(k); tp += 1; continue
                    fp += 1
                fn += len(it['pts']) - len(used)
            else:
                n_neg += 1; fp_neg += len(det)
        prec = tp / max(1, tp + fp); rec = tp / max(1, tp + fn)
        res[thr] = dict(tp=tp, fp=fp, fn=fn, precision=prec, recall=rec, fp_per_neg_crop=fp_neg / max(1, n_neg))
    return res


def export(model, params, path, extra):
    flat = {}
    for mod, d in params['params'].items():
        for k, v in d.items():
            flat[f'{mod}/{k}'] = np.asarray(v).round(6).tolist()
    json.dump(dict(arch='conv2x[24,32,48,64]-pool-meanmax-dense64-dense1', res=RES, patch=P, params=flat, **extra), open(path, 'w'))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('dataset'); ap.add_argument('out'); ap.add_argument('--steps', type=int, default=3000); ap.add_argument('--folds', type=int, default=4)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    items = load_dataset(a.dataset)
    lab = [i for i in items if i['kind'] == 'label']; negc = [i for i in items if i['kind'] == 'neg']
    print(f'Ritagli etichettati: {len(lab)} (posti: {sum(len(i["pts"]) for i in lab)}) · ritagli negativi: {len(negc)}')
    groups = sorted({group_of(i) for i in items}); rng = np.random.default_rng(1); rng.shuffle(groups)
    folds = [set(groups[k::a.folds]) for k in range(a.folds)]
    agg = {}
    for k, gset in enumerate(folds):
        tr = [i for i in items if group_of(i) not in gset]; te = [i for i in items if group_of(i) in gset]
        if not any(i['kind'] == 'label' and len(i['pts']) for i in te): continue
        pos, neg, hard = build_pools(tr, np.random.default_rng(k))
        print(f'  fold {k + 1}/{a.folds}: addestro su {len(pos)} pos / {len(neg)} neg / {len(hard)} vicini, valuto su {sum(i["kind"] == "label" for i in te)} ritagli in zone mai viste')
        model, params = train(pos, neg, hard, a.steps, seed=k, log=False)
        r = evaluate(model, params, te)
        for thr, v in r.items():
            A = agg.setdefault(thr, dict(tp=0, fp=0, fn=0, fpn=0.0, n=0))
            A['tp'] += v['tp']; A['fp'] += v['fp']; A['fn'] += v['fn']; A['fpn'] += v['fp_per_neg_crop']; A['n'] += 1
    print('\nValidazione su zone geografiche tenute fuori:')
    best = None
    for thr, A in sorted(agg.items()):
        p = A['tp'] / max(1, A['tp'] + A['fp']); r = A['tp'] / max(1, A['tp'] + A['fn'])
        print(f'  soglia {thr:.2f}: trovati {A["tp"]}/{A["tp"] + A["fn"]} posti (recall {r:.0%}) · precisione {p:.0%} · falsi per ritaglio negativo {A["fpn"] / max(1, A["n"]):.2f}')
        if best is None or (r >= 0.6 and p > best[1]): best = (thr, p, r)
    pos, neg, hard = build_pools(items, np.random.default_rng(99))
    print(f'\nModello finale su tutti i dati: {len(pos)} pos / {len(neg)} neg / {len(hard)} vicini')
    model, params = train(pos, neg, hard, a.steps, seed=99)
    export(model, params, os.path.join(a.out, 'detector.json'), dict(threshold=float(best[0]) if best else 0.85, cv=({str(k): v for k, v in agg.items()}), nms_m=NMS_DIST))
    print('Salvato', os.path.join(a.out, 'detector.json'))


if __name__ == '__main__':
    main()
