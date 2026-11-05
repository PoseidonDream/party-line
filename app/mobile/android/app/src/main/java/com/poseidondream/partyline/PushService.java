package com.poseidondream.partyline;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.json.JSONObject;

/**
 * Notifications while Party Line is closed: private messages, @mentions, calls and friend requests, sent by the
 * Party Line server through Firebase. The message carries the title, the text and where to open (url); tapping
 * the notification opens Party Line at that chat.
 */
public class PushService extends FirebaseMessagingService {
    static final String CHANNEL = "messages";

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> d = message.getData();
        String title = d.get("title"), body = d.get("body"), url = d.get("url"), tag = d.get("tag");
        if (title == null) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26 && nm != null && nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.push_channel), NotificationManager.IMPORTANCE_HIGH));
        }
        int id = tag == null ? 0 : tag.hashCode();
        Intent open = new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(MainActivity.EXTRA_OPEN, url != null && url.startsWith("/") ? url : "/app");
        PendingIntent tap = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder n = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_chat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory("call".equals(d.get("kind")) ? NotificationCompat.CATEGORY_CALL : NotificationCompat.CATEGORY_MESSAGE);
        try {
            NotificationManagerCompat.from(this).notify(id, n.build());
        } catch (SecurityException e) {
            // notifications are turned off for Party Line in Android's settings
        }
    }

    /**
     * Firebase gave this phone a new address (it does now and then, also while Party Line stays closed): tell the
     * server straight away, with the sign-in the page left when notifications were turned on, so they keep coming.
     * If that fails (offline, signed out), the page sends it the next time Party Line opens.
     */
    @Override
    public void onNewToken(String token) {
        SharedPreferences prefs = getSharedPreferences(PartyLinePlugin.PUSH_PREFS, MODE_PRIVATE);
        String base = prefs.getString("base", null), auth = prefs.getString("auth", null);
        if (base == null || auth == null) return;
        HttpURLConnection c = null;
        try {   // (this runs on Firebase's background thread, so it can wait for the network)
            byte[] body = new JSONObject().put("fcm", token).put("device", "Android app").toString().getBytes(StandardCharsets.UTF_8);
            c = (HttpURLConnection) new URL(base + "/api/push/subscribe").openConnection();
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + auth);
            try (OutputStream out = c.getOutputStream()) { out.write(body); }
            if (c.getResponseCode() == 401) prefs.edit().clear().apply();   // signed out since: nothing more to do
        } catch (Exception e) {
            // no connection right now
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
