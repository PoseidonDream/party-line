package com.poseidondream.partyline;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PartyLinePlugin.class);
        super.onCreate(savedInstanceState);
        // Let voice and Listen together (YouTube) start playing without an extra tap.
        getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        // Android 13+: ask once, so the "In voice" notification can show while voice runs in the background.
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
    }
}
