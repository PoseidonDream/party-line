package com.poseidondream.partyline;

import android.Manifest;
import android.app.DownloadManager;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;
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
        // Files, photos and backups people save: WebView ignores download links unless the app takes them, so hand
        // them to Android's downloads (they land in Downloads, with a notification when done).
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> download(url, userAgent, contentDisposition, mimeType));
        // Back: the page closes what's open first (a window, a menu, the channel list); otherwise Party Line goes to
        // the background, staying in voice, instead of closing.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                web.evaluateJavascript("window.plBack ? window.plBack() : false", (handled) -> {
                    if ("true".equals(handled)) return;
                    if (web.canGoBack()) web.goBack();   // a page opened from the app (privacy policy, rules): back to the app
                    else moveTaskToBack(true);
                });
            }
        });
    }

    private void download(String url, String userAgent, String contentDisposition, String mimeType) {
        if (url == null || !url.startsWith("http")) return;
        try {
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(mimeType);
            req.addRequestHeader("User-Agent", userAgent);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) req.addRequestHeader("Cookie", cookies);
            req.setTitle(name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Android 10+: straight into Downloads. Older: Android's own download folder (Downloads would need a storage permission).
            if (Build.VERSION.SDK_INT >= 29) req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
            Toast.makeText(this, getString(R.string.downloading, name), Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
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
