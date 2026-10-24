#!/usr/bin/env python3
"""Addestra il classificatore "stallo riservato / no" sui ritagli esportati dall'admin.

Uso: python3 train_classifier.py <cartella dataset con pos/ neg/ meta.json> <output model.json>

Le caratteristiche sono le stesse calcolate in admin.js (features()): devono restare allineate.
"""
import json, os, sys
import numpy as np
from PIL import Image

RINGS = [3.0, 6.0, 12.0]  # metri dal centro


def features(rgb, res):
    """rgb: array HxWx3 float 0..1, res: metri per pixel. Ritorna lista di float."""
    h, w, _ = rgb.shape
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(axis=2); mn = rgb.min(axis=2)
    sat = np.where(mx > 0.01, (mx - mn) / np.maximum(mx, 0.01), 0)
    yel = (r + g) / 2 - b
    rg_ok = (r >= 0.97 * g) & (r <= 1.10 * g)
    paint_lo = (yel >= 0.035) & rg_ok & (mx >= 0.55)
    paint_hi = (yel >= 0.07) & rg_ok & (mx >= 0.55)
    green = (g > r * 1.06) & (g > b * 1.06)
    grey = (sat < 0.22) & (mx >= 0.22) & (mx <= 0.82)
    white = (sat < 0.15) & (mx > 0.82)
    roof = (r > g * 1.18) & (r > b * 1.25)
    dark = mx < 0.22
    # bordi (gradiente di luminosità)
    gy, gx = np.gradient(mx)
    edge = np.hypot(gx, gy) > 0.08
    yy, xx = np.mgrid[0:h, 0:w]
    dist = np.hypot((xx - w / 2 + 0.5) * res, (yy - h / 2 + 0.5) * res)
    f = []
    for R in RINGS:
        m = dist <= R
        n = max(1, m.sum())
        for arr in (paint_lo, paint_hi, green, grey, white, roof, dark, edge):
            f.append(float((arr & m).sum() / n))
        f.append(float(mx[m].mean()))
        f.append(float(mx[m].std()))
        f.append(float(yel[m].mean()))
    # rapporto vernice centro/esterno (gli stalli hanno vernice concentrata)
    f.append(f[0] / (f[22] + 1e-3))
    return f


NAMES = [f"{k}_{R}m" for R in RINGS for k in ("paint_lo", "paint_hi", "green", "grey", "white", "roof", "dark", "edge", "v_mean", "v_std", "yel_mean")] + ["paint_ratio"]


def load(folder, meta):
    X, y, ids = [], [], []
    res = meta["crop_m"] / meta["px"]
    for it in meta["items"]:
        lab = it["label"]
        fn = os.path.join(folder, lab, ("cand-" if lab == "pos" and it.get("fonte") in ("mapillary", "satellite") and os.path.exists(os.path.join(folder, lab, f"cand-{it['id']}.jpg")) else "") + f"{it['id']}.jpg")
        if not os.path.exists(fn):
            continue
        rgb = np.asarray(Image.open(fn).convert("RGB"), dtype=np.float32) / 255
        for k in range(4):  # rotazioni di 90°: l'ortofoto non ha un "su"
            X.append(features(np.rot90(rgb, k), res)); y.append(1 if lab == "pos" else 0); ids.append(it["id"])
    return np.array(X), np.array(y), np.array(ids)


def main():
    folder, out = sys.argv[1], sys.argv[2]
    meta = json.load(open(os.path.join(folder, "meta.json")))
    X, y, ids = load(folder, meta)
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold
    from sklearn.metrics import roc_auc_score
    # solo caratteristiche di contesto: il giallo lo valuta già il rilevatore, e nel dataset è distorto (i negativi sono stati scelti proprio perché gialli)
    keep = [i for i, n in enumerate(NAMES) if not (n.startswith("paint") or n.startswith("yel"))]
    X = X[:, keep]; names = [NAMES[i] for i in keep]
    mu, sd = X.mean(0), X.std(0) + 1e-6
    Z = (X - mu) / sd
    # validazione incrociata raggruppata per esempio (le 4 rotazioni dello stesso ritaglio restano insieme)
    oof = np.zeros(len(y))
    for C in (0.03, 0.1, 0.3, 1.0):
        for tr, te in GroupKFold(5).split(Z, y, ids):
            m = LogisticRegression(C=C, class_weight="balanced", max_iter=3000).fit(Z[tr], y[tr])
            oof[te] = m.predict_proba(Z[te])[:, 1]
        # punteggio per esempio = media delle 4 rotazioni
        uid = np.unique(ids); ps = np.array([oof[ids == u].mean() for u in uid]); ys = np.array([y[ids == u][0] for u in uid])
        print(f"C={C}: AUC {roc_auc_score(ys, ps):.3f}")
        for rec in (0.9, 0.8):
            thr = np.quantile(ps[ys == 1], 1 - rec)
            print(f"   soglia per recall {rec:.0%}: {thr:.3f} → negativi scartati {np.mean(ps[ys == 0] < thr):.0%}")
    C = float(sys.argv[3]) if len(sys.argv) > 3 else 0.3
    m = LogisticRegression(C=C, class_weight="balanced", max_iter=3000).fit(Z, y)
    for tr, te in GroupKFold(5).split(Z, y, ids):
        oof[te] = LogisticRegression(C=C, class_weight="balanced", max_iter=3000).fit(Z[tr], y[tr]).predict_proba(Z[te])[:, 1]
    uid = np.unique(ids); ps = np.array([oof[ids == u].mean() for u in uid]); ys = np.array([y[ids == u][0] for u in uid])
    thr = float(np.quantile(ps[ys == 1], 0.10))
    order = np.argsort(-np.abs(m.coef_[0]))
    print("Caratteristiche più importanti:", [(names[i], round(float(m.coef_[0][i]), 2)) for i in order[:8]])
    json.dump({"version": 1, "trained": meta["exported"], "n_pos": int((ys == 1).sum()), "n_neg": int((ys == 0).sum()),
               "rings": RINGS, "names": names, "mu": mu.tolist(), "sd": sd.tolist(), "w": m.coef_[0].tolist(), "b": float(m.intercept_[0]),
               "threshold": thr, "cv_auc": float(roc_auc_score(ys, ps)), "cv_neg_rejected": float(np.mean(ps[ys == 0] < thr))}, open(out, "w"), indent=1)
    print(f"Salvato {out}: soglia {thr:.3f} (recall 90%), negativi scartati {np.mean(ps[ys == 0] < thr):.0%}")


if __name__ == "__main__":
    main()
