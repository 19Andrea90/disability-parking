package it.disabilityparking.app;

import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebSettings;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Sostituisce la MainActivity vuota generata da "npx cap add android": in più registra i plugin locali (TestLab, SostAbile),
 * fissa le impostazioni della WebView che riguardano la dimensione del testo e lo zoom
 * e tiene le icone della barra di stato leggibili con il tema scuro automatico dell'app.
 *
 * Tema scuro: la pagina (CSS prefers-color-scheme) segue il tema del telefono. Il tema dell'attività (AppTheme.NoActionBar) è
 * Theme.AppCompat.DayNight: la WebView riporta quindi prefers-color-scheme in base alla modalità notte di sistema. Non si tocca
 * nulla della WebView (niente setForceDark né algorithmic darkening): con le impostazioni predefinite la pagina, che gestisce
 * già il tema scuro da sola, non viene scurita una seconda volta dal sistema.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TestLabPlugin.class); // prima di super.onCreate, come richiesto da Capacitor per i plugin locali
        registerPlugin(SostAbilePlugin.class);
        super.onCreate(savedInstanceState);
        try {
            // Il testo segue «Dimensione carattere» del telefono: la scala la legge SostAbilePlugin.fontScale() e l'app la applica
            // come dimensione base in rem (app.js). Il textZoom della WebView resta a 100 per non scalare due volte, in qualunque versione di Android.
            WebSettings s = getBridge().getWebView().getSettings();
            s.setTextZoom(100);
            // niente zoom a pinch della pagina (la mappa gestisce da sola il pinch): lo zoom del testo è quello di sistema
            s.setSupportZoom(false);
            s.setBuiltInZoomControls(false);
        } catch (Throwable e) {
            // se la WebView non è ancora pronta si va avanti con le impostazioni predefinite
        }
        barraDiStato();
    }

    @Override
    public void onConfigurationChanged(Configuration nuova) {
        super.onConfigurationChanged(nuova); // l'attività dichiara uiMode in configChanges: il cambio di tema arriva qui, senza riavvio
        barraDiStato();
    }

    /** Di giorno la mappa è chiara: icone scure nella barra di stato; di notte la mappa è scura: icone chiare. */
    private void barraDiStato() {
        boolean notte = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(!notte);
    }
}
