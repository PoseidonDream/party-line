package com.poseidondream.partyline;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PartyLinePlugin.class);
        super.onCreate(savedInstanceState);
        WebView web = getBridge().getWebView();
        // Let voice and Listen together (YouTube) start playing without an extra tap.
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        // Android 13+: ask once, so the "In voice" notification can show while voice runs in the background.
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 1);
        }
        fitBetweenSystemBars(web);
        // Back: the page closes what's open first (a window, a menu, the channel list); otherwise Party Line goes to
        // the background, staying in voice, instead of closing.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                web.evaluateJavascript("window.plBack ? window.plBack() : false", (handled) -> {
                    if (!"true".equals(handled)) moveTaskToBack(true);
                });
            }
        });
    }

    /* Android 15 and newer draw apps from edge to edge, under the status bar, the navigation bar and the keyboard.
       Keep the page between them instead, so nothing hides under the clock or the keyboard. */
    private void fitBetweenSystemBars(WebView web) {
        if (Build.VERSION.SDK_INT < 35) return;   // older Android already does this by itself
        getWindow().getDecorView().setBackgroundColor(Color.BLACK);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightNavigationBars(false);
        ViewCompat.setOnApplyWindowInsetsListener(web, (View v, WindowInsetsCompat all) -> {
            Insets bars = all.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = all.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            lp.leftMargin = bars.left;
            lp.topMargin = bars.top;
            lp.rightMargin = bars.right;
            lp.bottomMargin = Math.max(bars.bottom, keyboard.bottom);
            v.setLayoutParams(lp);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
