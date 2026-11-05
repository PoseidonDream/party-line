package com.poseidondream.partyline;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.os.Build;
import com.getcapacitor.JSObject;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Lets the Party Line page tell the app when you join or leave voice, and ask which build it is and where it came from (for the update banner). */
@CapacitorPlugin(name = "PartyLine")
public class PartyLinePlugin extends Plugin {
    @PluginMethod
    public void setInCall(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, VoiceService.class);
        if (Boolean.TRUE.equals(call.getBoolean("inCall", false))) {
            intent.putExtra(VoiceService.EXTRA_TITLE, call.getString("title", "In voice"));
            try {
                ContextCompat.startForegroundService(ctx, intent);
            } catch (Exception e) {
                call.reject("Couldn't keep voice running in the background", e);
                return;
            }
        } else {
            ctx.stopService(intent);
        }
        call.resolve();
    }

    /** Which app store installed Party Line ("com.android.vending" is Google Play), or null for a downloaded .apk. */
    private String installer() {
        try {
            String pkg = getContext().getPackageName();
            if (Build.VERSION.SDK_INT >= 30) return getContext().getPackageManager().getInstallSourceInfo(pkg).getInstallingPackageName();
            return getContext().getPackageManager().getInstallerPackageName(pkg);
        } catch (Exception e) {
            return null;
        }
    }

    /** Where PushService finds the server and the sign-in, to send a new notification address while the app is closed. */
    static final String PUSH_PREFS = "push";

    /**
     * This phone's notification address from Firebase, for the Party Line server to send to while the app is closed.
     * Rejects when this build has no Firebase setup (google-services.json), so the page simply leaves it off.
     * With "auth" (the page's sign-in, when notifications are on) it's kept for PushService; an empty one forgets it.
     */
    @PluginMethod
    public void getPushToken(PluginCall call) {
        if (call.getData().has("auth")) {
            String auth = call.getString("auth", ""), base = getBridge().getConfig().getServerUrl();
            android.content.SharedPreferences.Editor e = getContext().getSharedPreferences(PUSH_PREFS, Context.MODE_PRIVATE).edit();
            if (auth.isEmpty() || base == null || !base.startsWith("https://")) e.clear();
            else e.putString("auth", auth).putString("base", base.replaceAll("/+$", ""));
            e.apply();
        }
        try {
            if (com.google.firebase.FirebaseApp.getApps(getContext()).isEmpty()) { call.reject("Notifications aren't set up in this build"); return; }
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful() || task.getResult() == null) { call.reject("Couldn't get a notification address", task.getException()); return; }
                JSObject r = new JSObject();
                r.put("token", task.getResult());
                call.resolve(r);
            });
        } catch (Exception e) {
            call.reject("Notifications aren't set up in this build", e);
        }
    }

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject r = new JSObject();
            r.put("code", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            r.put("name", p.versionName);
            r.put("fromPlay", "com.android.vending".equals(installer()));   // Play updates it; the page then doesn't offer updates
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Couldn't read the app version", e);
        }
    }
}
