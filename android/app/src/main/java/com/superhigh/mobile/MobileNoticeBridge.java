package com.superhigh.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.webkit.JavascriptInterface;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import org.json.JSONArray;
import org.json.JSONObject;

/** Mirrors desktop CLI notices as system notifications, like a chat message from Super High. */
class MobileNoticeBridge {
    static final int PERMISSION_REQUEST = 47033;
    private static final String CHANNEL = "cli-notices";
    static final String REPLY_KEY = "notice_reply";
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
        return show(activity, json);
    }

    @JavascriptInterface
    public boolean start(String json) {
        try {
            JSONObject connection = new JSONObject(json);
            String baseUrl = connection.getString("baseUrl");
            String token = connection.getString("token");
            android.net.Uri uri = android.net.Uri.parse(baseUrl);
            if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
                || uri.getHost() == null || uri.getUserInfo() != null || token.trim().isEmpty()) return false;
            MobileNoticeService.configure(baseUrl, token);
            androidx.core.content.ContextCompat.startForegroundService(activity, new Intent(activity, MobileNoticeService.class));
            return true;
        } catch (RuntimeException | org.json.JSONException error) {
            return false;
        }
    }

    @JavascriptInterface
    public void stop() {
        MobileNoticeService.clearConfiguration();
        activity.stopService(new Intent(activity, MobileNoticeService.class));
    }

    static boolean show(Context context, String json) {
        try {
            JSONObject notice = new JSONObject(json);
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false;
            String body = notice.optString("body");
            String meta = notice.optString("meta");
            Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent content = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(notice.optString("title", "Super High"))
                .setContentText(body.isEmpty() ? meta : body)
                .setSubText(meta)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body.isEmpty() ? meta : body))
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(content);
            String noticeId = notice.optString("noticeId");
            int notificationId = notice.optInt("id");
            if (!noticeId.isEmpty()) {
                builder.setAutoCancel(false);
                Intent detail = new Intent(context, MobileNoticeActivity.class).putExtra("noticeId", noticeId).putExtra("notificationId", notificationId);
                detail.setData(android.net.Uri.parse("superhigh-notice://detail/" + noticeId));
                PendingIntent details = PendingIntent.getActivity(context, notificationId, detail, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                builder.setContentIntent(details).addAction(0, "展开详情", details);
                JSONObject plan = notice.optJSONObject("planRequest");
                JSONArray questions = plan == null ? null : plan.optJSONArray("questions");
                JSONObject question = questions != null && questions.length() == 1 ? questions.optJSONObject(0) : null;
                if (question != null && !question.optBoolean("isSecret") && !question.optBoolean("multiSelect")) {
                    JSONArray options = question.optJSONArray("options");
                    CharSequence[] choices = new CharSequence[options == null ? 0 : options.length()];
                    for (int i = 0; i < choices.length; i++) choices[i] = options.optJSONObject(i).optString("label");
                    RemoteInput.Builder input = new RemoteInput.Builder(REPLY_KEY).setLabel("输入回答");
                    if (choices.length > 0) input.setChoices(choices);
                    Intent reply = new Intent(context, MobileNoticeReplyReceiver.class).putExtra("noticeId", noticeId).putExtra("notificationId", notificationId);
                    reply.setData(android.net.Uri.parse("superhigh-notice://reply/" + noticeId));
                    PendingIntent send = PendingIntent.getBroadcast(context, notificationId, reply, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0));
                    builder.addAction(new NotificationCompat.Action.Builder(0, "快捷回复", send).addRemoteInput(input.build()).build()).setAutoCancel(false);
                }
            }
            try {
                Bitmap icon = providerIcon(context, notice.optString("provider"));
                if (icon != null) builder.setLargeIcon(icon);
            } catch (RuntimeException error) {
                android.util.Log.w("SuperHighNotice", "Agent 图标加载失败", error);
            }
            NotificationManagerCompat.from(context).notify("cli-notice", notice.optInt("id"), builder.build());
            return true;
        } catch (SecurityException | org.json.JSONException error) {
            return false;
        }
    }

    private static Bitmap providerIcon(Context context, String provider) {
        int resource;
        switch (provider) {
            case "codex": resource = R.drawable.cli_codex; break;
            case "claude": resource = R.drawable.cli_claude; break;
            case "opencode": resource = R.drawable.cli_opencode; break;
            case "gemini": resource = R.drawable.cli_gemini; break;
            case "grok": resource = R.drawable.cli_grok; break;
            case "codebuddy": resource = R.drawable.cli_codebuddy; break;
            case "kimi": resource = R.drawable.cli_kimi; break;
            default: return null;
        }
        android.graphics.drawable.Drawable drawable = androidx.core.content.ContextCompat.getDrawable(context, resource);
        if (drawable == null) return null;
        Bitmap bitmap = Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        canvas.drawColor(Color.WHITE);
        drawable.setBounds(12, 12, 84, 84);
        drawable.draw(canvas);
        return bitmap;
    }
}
