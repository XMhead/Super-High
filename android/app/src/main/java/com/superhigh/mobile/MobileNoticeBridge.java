package com.superhigh.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.JavascriptInterface;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONObject;

/** Mirrors desktop CLI notices as system notifications, like a chat message from Super High. */
class MobileNoticeBridge {
    static final int PERMISSION_REQUEST = 47033;
    private static final String CHANNEL = "cli-notices";
    private final Activity activity;

    MobileNoticeBridge(Activity activity) {
        this.activity = activity;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "CLI 对话提醒", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("电脑上的 CLI 完成回答或等待 Plan 回答时提醒");
            activity.getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    void requestPermission() {
        if (Build.VERSION.SDK_INT >= 33
            && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, PERMISSION_REQUEST);
        }
    }

    @JavascriptInterface
    public boolean show(String json) {
        try {
            JSONObject notice = new JSONObject(json);
            if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) return false;
            String body = notice.optString("body");
            String meta = notice.optString("meta");
            Intent open = new Intent(activity, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent content = PendingIntent.getActivity(activity, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(activity, CHANNEL)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(notice.optString("title", "Super High"))
                .setContentText(body.isEmpty() ? meta : body)
                .setSubText(meta)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body.isEmpty() ? meta : body))
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(content);
            NotificationManagerCompat.from(activity).notify(notice.optInt("id"), builder.build());
            return true;
        } catch (SecurityException | org.json.JSONException error) {
            return false;
        }
    }
}
