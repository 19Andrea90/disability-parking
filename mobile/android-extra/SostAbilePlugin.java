package it.disabilityparking.app;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Plugin Capacitor locale "SostAbile". Tre cose che il solo JavaScript non può fare:
 *  - fontScale(): la scala del carattere scelta dall'utente in Impostazioni > Dimensione carattere (1,0 = normale) -> { scala: 1.3 }
 *  - leggiIntent(): cosa ha aperto l'app, una volta sola -> { azione?: "vicino"|"casa"|"lavoro"|"auto", testo?: "..." }
 *      azione = scorciatoie dell'icona (it.disabilityparking.app://azione/vicino, vedi res/xml/shortcuts.xml);
 *      testo = testo condiviso da un'altra app (ACTION_SEND text/plain, per esempio «Condividi» di Google Maps).
 *    Se l'app è già aperta, lo stesso contenuto arriva come evento "intent" (addListener).
 *  - risolviLink({ url }): segue i reindirizzamenti dei link corti di Google Maps (maps.app.goo.gl) per ricavare le coordinate -> { url: "<indirizzo finale>" }
 * Questo file è copiato nel progetto Android generato dai workflow (android.yml, play.yml): vedi mobile/android-extra/.
 */
@CapacitorPlugin(name = "SostAbile")
public class SostAbilePlugin extends Plugin {
    private String azione = null;
    private String testo = null;

    @Override
    public void load() {
        try {
            leggi(getActivity().getIntent(), true);
        } catch (Throwable e) {
            // nessun intent leggibile: l'app si apre normalmente
        }
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (leggi(intent, false)) {
            notifyListeners("intent", pacchetto(true));
        }
    }

    /** Legge azione o testo da un intent. Con svuota=true toglie i dati dall'intent: se l'activity viene ricreata (per esempio cambiando la dimensione del carattere) non si ripete. */
    private boolean leggi(Intent in, boolean svuota) {
        if (in == null) return false;
        boolean trovato = false;
        String a = in.getAction();
        if (Intent.ACTION_SEND.equals(a)) {
            String t = in.getStringExtra(Intent.EXTRA_TEXT);
            if (t != null && !t.trim().isEmpty()) {
                testo = t;
                trovato = true;
                if (svuota) {
                    in.removeExtra(Intent.EXTRA_TEXT);
                    in.setAction(Intent.ACTION_MAIN);
                }
            }
        } else if (Intent.ACTION_VIEW.equals(a) && in.getData() != null) {
            Uri u = in.getData();
            if ("it.disabilityparking.app".equals(u.getScheme()) && "azione".equals(u.getHost()) && u.getPath() != null) {
                String nome = u.getPath().replace("/", "");
                if (nome.equals("vicino") || nome.equals("casa") || nome.equals("lavoro") || nome.equals("auto")) {
                    azione = nome;
                    trovato = true;
                    if (svuota) {
                        in.setData(null);
                        in.setAction(Intent.ACTION_MAIN);
                    }
                }
            }
        }
        return trovato;
    }

    private JSObject pacchetto(boolean svuota) {
        JSObject r = new JSObject();
        if (azione != null) r.put("azione", azione);
        if (testo != null) r.put("testo", testo);
        if (svuota) {
            azione = null;
            testo = null;
        }
        return r;
    }

    @PluginMethod
    public void leggiIntent(PluginCall call) {
        call.resolve(pacchetto(true));
    }

    @PluginMethod
    public void fontScale(PluginCall call) {
        double scala = 1.0;
        try {
            scala = getContext().getResources().getConfiguration().fontScale;
        } catch (Throwable e) {
            // si resta a scala normale
        }
        JSObject r = new JSObject();
        r.put("scala", scala);
        call.resolve(r);
    }

    private static boolean ammesso(URL u) {
        String h = u.getHost() == null ? "" : u.getHost().toLowerCase();
        return "https".equals(u.getProtocol()) && (h.equals("goo.gl") || h.endsWith(".goo.gl") || h.equals("g.co") || h.endsWith(".google.com") || h.endsWith(".google.it") || h.equals("google.com") || h.equals("google.it"));
    }

    @PluginMethod
    public void risolviLink(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) {
            call.reject("url mancante");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                String cur = url;
                try {
                    for (int i = 0; i < 6; i++) {
                        URL u = new URL(cur);
                        if (!ammesso(u)) break;
                        HttpURLConnection c = (HttpURLConnection) u.openConnection();
                        c.setInstanceFollowRedirects(false);
                        c.setConnectTimeout(4000);
                        c.setReadTimeout(4000);
                        c.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"); // con un browser da telefono maps.app.goo.gl risponde con una pagina (200) invece del reindirizzamento
                        c.setRequestProperty("Accept-Language", "it-IT,it;q=0.9");
                        int code = c.getResponseCode();
                        String loc = c.getHeaderField("Location");
                        if (code >= 300 && code < 400 && loc != null) {
                            c.disconnect();
                            cur = new URL(u, loc).toString();
                            if (cur.contains("/maps/place/") || cur.contains("@") || cur.contains("!3d")) break; // nome o coordinate già nel link: basta così
                        } else {
                            // pagina invece del reindirizzamento: cerca dentro il link lungo di Google Maps
                            String trovato = null;
                            try {
                                InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
                                if (in != null) {
                                    ByteArrayOutputStream buf = new ByteArrayOutputStream(); byte[] b = new byte[8192]; int n, tot = 0;
                                    while ((n = in.read(b)) > 0 && tot < 400000) { buf.write(b, 0, n); tot += n; }
                                    in.close();
                                    String html = buf.toString("UTF-8").replace("\\u003d", "=").replace("\\u0026", "&").replace("\\/", "/").replace("&amp;", "&");
                                    Matcher m = Pattern.compile("https://(?:www\\.)?google\\.[a-z.]+/maps/(?:place|search|dir)/[^\"'\\s<>]+").matcher(html);
                                    if (m.find()) trovato = m.group();
                                    else { m = Pattern.compile("https://maps\\.google\\.[a-z.]+/[^\"'\\s<>]*[?&](?:q|ll|cid)=[^\"'\\s<>]+").matcher(html); if (m.find()) trovato = m.group(); }
                                }
                            } catch (Throwable e2) { /* pagina illeggibile */ }
                            c.disconnect();
                            if (trovato != null) cur = trovato;
                            break;
                        }
                    }
                } catch (Throwable e) {
                    // senza rete o link non valido: resta l'ultimo indirizzo raggiunto
                }
                JSObject r = new JSObject();
                r.put("url", cur);
                call.resolve(r);
            }
        }).start();
    }
}
