package it.disabilityparking.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

/**
 * Sostituisce la MainActivity vuota generata da "npx cap add android": in più registra i plugin locali (TestLab, SostAbile)
 * e fissa le impostazioni della WebView che riguardano la dimensione del testo e lo zoom.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TestLabPlugin.class); // prima di super.onCreate, come richiesto da Capacitor per i plugin locali
        registerPlugin(SostAbilePlugin.class);
        super.onCreate(savedInstanceState);
        try {
            // Il testo segue «Dimensione carattere» del telefono: la scala la legge SostAbilePlugin.fontScale() e l'app la applica come
            // dimensione base in rem (app.js). Il textZoom della WebView resta a 100 per non scalare due volte, in qualunque versione di Android.
            WebSettings s = getBridge().getWebView().getSettings();
            s.setTextZoom(100);
            // niente zoom a pinch della pagina (la mappa gestisce da sola il pinch): lo zoom del testo è quello di sistema
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
        } catch (Throwable e) {
            // se la WebView non è ancora pronta si va avanti con le impostazioni predefinite
        }
    }
}
