package it.disabilityparking.app;

import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Plugin Capacitor locale "TestLab": dice se l'app gira su un dispositivo di prova di Google (Firebase Test Lab,
 * rapporto di pre-lancio di Google Play). In quel caso Android imposta Settings.System "firebase.test.lab" = "true".
 * L'app (app.js) in quel caso non manda nessuna statistica d'uso, così i robot di Google non gonfiano i conteggi.
 * Chiamata da JavaScript: Capacitor.Plugins.TestLab.isTestLab() -> { value: true | false }.
 * Questo file è copiato nel progetto Android generato dai workflow (android.yml, play.yml): vedi mobile/android-extra/.
 */
@CapacitorPlugin(name = "TestLab")
public class TestLabPlugin extends Plugin {
    @PluginMethod
    public void isTestLab(PluginCall call) {
        boolean test = false;
        try {
            String v = Settings.System.getString(getContext().getContentResolver(), "firebase.test.lab");
            test = "true".equals(v);
        } catch (Throwable e) {
            // se la lettura non è possibile, si considera un dispositivo normale
        }
        JSObject r = new JSObject();
        r.put("value", test);
        call.resolve(r);
    }
}
