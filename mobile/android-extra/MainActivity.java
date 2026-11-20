package it.disabilityparking.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/** Sostituisce la MainActivity vuota generata da "npx cap add android": in più registra il plugin locale TestLab. */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TestLabPlugin.class); // prima di super.onCreate, come richiesto da Capacitor per i plugin locali
        super.onCreate(savedInstanceState);
    }
}
