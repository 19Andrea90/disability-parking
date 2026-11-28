// Rende discreta la notifica del servizio in primo piano di @capacitor-community/background-geolocation:
// il plugin la crea con importanza "predefinita" e priorità alta; qui diventano "minima" (silenziosa, senza avvisi a schermo).
// Si esegue da solo dopo "npm install" / "npm ci" (script postinstall) e si può rieseguire: se è già stato fatto non cambia nulla.
// Se il plugin cambia e il testo da sostituire non si trova più, fallisce a voce alta invece di lasciare la notifica rumorosa.
import fs from 'node:fs';
const f = new URL('../node_modules/@capacitor-community/background-geolocation/android/src/main/java/com/equimaps/capacitor_background_geolocation/BackgroundGeolocation.java', import.meta.url);
if (!fs.existsSync(f)) { console.log('patch-plugin: plugin non installato, niente da fare'); process.exit(0); }
let s = fs.readFileSync(f, 'utf8');
const sost = [['NotificationManager.IMPORTANCE_DEFAULT', 'NotificationManager.IMPORTANCE_MIN'], ['Notification.PRIORITY_HIGH', 'Notification.PRIORITY_MIN']];
for (const [da, a] of sost) {
  if (s.includes(a)) continue;
  if (s.split(da).length !== 2) { console.error('patch-plugin: non trovo "' + da + '" una sola volta: il plugin è cambiato, rivedere lo script'); process.exit(1); }
  s = s.replace(da, a);
}
fs.writeFileSync(f, s); console.log('patch-plugin: notifica del servizio in primo piano resa discreta (importanza e priorità minime)');
