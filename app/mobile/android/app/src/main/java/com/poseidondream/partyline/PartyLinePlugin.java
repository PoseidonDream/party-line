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

/** Lets the Party Line page tell the app when you join or leave voice, and ask which build it is (for the update banner). */
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

    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject r = new JSObject();
            r.put("code", Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode);
            r.put("name", p.versionName);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Couldn't read the app version", e);
        }
    }
}
