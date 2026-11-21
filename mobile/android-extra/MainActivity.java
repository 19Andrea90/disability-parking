package it.disabilityparking.app;

import android.content.res.Configuration;
import android.os.Bundle;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Sostituisce la MainActivity vuota generata da "npx cap add android": in più registra il plugin locale TestLab
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
        super.onCreate(savedInstanceState);
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
