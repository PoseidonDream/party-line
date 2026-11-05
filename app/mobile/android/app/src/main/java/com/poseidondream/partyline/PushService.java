package com.poseidondream.partyline;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

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

    @Override
    public void onNewToken(String token) {
        // The page asks for the address each time Party Line opens and sends the new one to the server then.
    }
}
