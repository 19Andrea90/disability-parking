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

## stalli_mobilenetv3_ft_v2.pt (25 ottobre 2026)
Stessa architettura della v1, addestrata anche con le verifiche sul campo del centro di Udine (57 stalli confermati, 113 falsi scartati) e 120 riquadri casuali di città (tetti, giardini, cortili) come negativi.
Da sola non batte la v1, ma **la media delle due** sì: sui candidati di Udine mai visti AUC 0,86 (v1 0,83), 15 veri tra i primi 20 (v1 13); con soglia 0,2 toglie il 94% dei falsi perdendo 6 veri su 21 (v1 ne perde 8).
Uso in produzione: `python3 tools/scan_area.py models/stalli_mobilenetv3_ft_v1.pt,models/stalli_mobilenetv3_ft_v2.pt --bbox S,W,N,E --thr 0.2 --context udine --label Udine`

## stalli_mobilenetv3_ft_v3.pt (25 ottobre 2026)
Stessa architettura, addestrata con tutte le verifiche dell'admin sulla scansione completa di Udine: 431 stalli confermati a mano (compresi i 143 confermati in automatico e poi controllati), 204 falsi scartati, 120 riquadri casuali di città. Esclusi gli stalli automatici non controllati e i ritagli su zone nere dell'ortofoto.
Prova sul campo (metà dei candidati verificati, mai vista in addestramento; 298 candidati, 211 veri):
- v3 da sola AUC 0,95 (v1 0,79); coppia v3+v2 AUC 0,97 contro 0,92 della coppia v1+v2 usata finora.
- Sopra 0,55: v3+v2 167 candidati con precisione 99% (v1+v2: 129 con 98%).
- Con soglia 0,2 la coppia v3+v2 perde 5 veri (v1+v2 ne perdeva 29).
- `_holdout.pt`: rete addestrata su metà dei dati (quella misurata); `_field.json`: i punteggi della prova.
Uso in produzione (v3 per prima: è quella che scorre l'immagine; v2 riconferma):
`python3 tools/scan_area.py models/stalli_mobilenetv3_ft_v3.pt,models/stalli_mobilenetv3_ft_v2.pt --bbox S,W,N,E --thr 0.2 --context <comune> --label <Comune> --auto 55`
Copie di sicurezza: Supabase storage `modelli/v3/`.

**Attenzione (25 ottobre, sera):** usata come rilevatore principale la v3 dà punteggi altissimi anche su strada vuota, giardini e alberi (la prova sul campo misurava solo punti già proposti da v1/v2, non zone qualsiasi). Uso corretto: v1 scorre l'immagine, la media v1+v2+v3 decide il punteggio:
`python3 tools/scan_area.py models/stalli_mobilenetv3_ft_v1.pt,models/stalli_mobilenetv3_ft_v2.pt,models/stalli_mobilenetv3_ft_v3.pt --bbox S,W,N,E --thr 0.2 --context <comune> --label <Comune> --auto 55`
Prova a secco su 64 riquadri di Udine già scansionati: v3 come rilevatore 52 candidati nuovi (in gran parte falsi, 17 sopra 0,55); v1 come rilevatore con media di 3: 2 candidati nuovi, nessuno sopra 0,55.
Lo scanner ora lavora a celle di 40 m (+4,8 m di margine): 1,7× più veloce del riquadro intero, stessa precisione sugli stalli reali di Udine.
