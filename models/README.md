# Modelli addestrati

## stalli_mobilenetv3_ft_v1.pt (24 ottobre 2026)
Rilevatore di stalli riservati (segnaletica gialla) su TrueOrtofoto FVG 2020.
- Architettura: MobileNetV3-Large (ImageNet) addestrata per intero + testa lineare su media+massimo della finestra 4×4 (vedi `tools/finetune.py`, classe `Net`).
- Ingresso: ritagli a 0,10 m/px, finestra 64 px (6,4 m) ingrandita 2×; inferenza densa con passo 1,6 m.
- Dati: 855 stalli etichettati a mano (712 posti cliccati, 424 "non visibili") + 412 candidati scartati, tutto il FVG.
- Validazione su zone tenute fuori (holdout 25%): soglia 0,05 → trova il 56% dei posti, precisione 44%, 0,12 falsi per riquadro 40×40 m senza stalli.
- `_holdout.pt`: stessa rete addestrata solo sul 75% delle zone (quella usata per misurare).

Caricamento:
```python
import torch, sys; sys.path.insert(0, 'tools'); import finetune
net = finetune.Net(); net.load_state_dict(torch.load('models/stalli_mobilenetv3_ft_v1.pt')); net.eval()
scores, cx, cy = net.dense(img)  # img: array HxWx3 float 0..1 a 0,10 m/px
```
Scansione di un'area: `python3 tools/scan_area.py models/stalli_mobilenetv3_ft_v1.pt --bbox S,W,N,E --thr 0.05`

## Copie di sicurezza dei dati
`data/etichette.json` (le etichette fatte a mano) e `data/stalli.json`: esportazione completa dalle tabelle Supabase.
