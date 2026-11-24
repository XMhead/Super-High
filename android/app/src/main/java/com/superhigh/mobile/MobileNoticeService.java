package com.superhigh.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Keeps the desktop feed connected when the WebView is paused. */
public class MobileNoticeService extends Service {
    private static final String CHANNEL = "desktop-connection";
    private static final int SERVICE_NOTIFICATION = 47034;
    private static String baseUrl;
    private static String token;
    private static long generation;
    private ScheduledExecutorService executor;
    private long cursorGeneration = -1;
    private Long cursor;

    static synchronized void configure(String url, String credential) {
        String normalized = url.replaceAll("/+$", "");
        if (!normalized.equals(baseUrl) || !credential.equals(token)) {
            baseUrl = normalized;
            token = credential;
            generation++;
        }
    }

    static synchronized void clearConfiguration() { baseUrl = null; token = null; generation++; }
    static synchronized String[] connection() { return baseUrl == null || token == null ? null : new String[] { baseUrl, token }; }

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "电脑连接", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("保持连接以接收电脑上的 CLI 提醒");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle("Super High")
            .setContentText("正在连接电脑以接收通知").setOngoing(true)
            .setContentIntent(content).setPriority(NotificationCompat.PRIORITY_LOW).build();
        startForeground(SERVICE_NOTIFICATION, notification);
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::poll, 0, 3, TimeUnit.SECONDS);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_NOT_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onDestroy() {
        if (executor != null) executor.shutdownNow();
        super.onDestroy();
    }

    private void poll() {
        final String url;
        final String credential;
        final long current;
        synchronized (MobileNoticeService.class) { url = baseUrl; credential = token; current = generation; }
        if (url == null || credential == null) return;
        if (cursorGeneration != current) { cursorGeneration = current; cursor = null; }
        HttpURLConnection connection = null;
        try {
            String query = cursor == null ? "" : "?after=" + cursor;
            connection = (HttpURLConnection) new URL(url + "/api/mobile/notices" + query).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Authorization", "Bearer " + credential);
            int status = connection.getResponseCode();
            if (status != 200) throw new IllegalStateException("电脑通知接口返回 " + status);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (var input = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > 1024 * 1024) return;
                    bytes.write(buffer, 0, count);
                }
            }
            JSONObject response = new JSONObject(bytes.toString("UTF-8"));
            boolean hadCursor;
            synchronized (MobileNoticeService.class) {
                if (generation != current) return;
                hadCursor = cursor != null;
                if (!hadCursor) cursor = response.getLong("latest");
            }
            if (hadCursor) {
                JSONArray notices = response.getJSONArray("notices");
                for (int i = 0; i < notices.length(); i++) {
                    synchronized (MobileNoticeService.class) { if (generation != current) return; }
                    JSONObject notice = notices.getJSONObject(i);
                    showNotice(notice);
                    cursor = notice.getLong("seq");
                }
                cursor = response.getLong("latest");
            }
        } catch (Exception error) {
            android.util.Log.w("SuperHighNotice", "通知接收失败，稍后重试", error);
            // Keep the cursor and retry after a temporary disconnection.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void showNotice(JSONObject notice) throws org.json.JSONException {
        String providerKind = notice.optString("provider");
        String provider = providerKind;
        if ("codex".equalsIgnoreCase(provider)) provider = "Codex";
        else if ("claude".equalsIgnoreCase(provider)) provider = "Claude Code";
        else if ("dsh".equalsIgnoreCase(provider)) provider = "DeepSeek Harness";
        else if ("opencode".equalsIgnoreCase(provider)) provider = "OpenCode";
        String title = notice.optString("title").trim();
        if (title.isEmpty()) title = provider;
        String meta = provider;
        if (notice.optBoolean("plan")) meta += " · 等待回答";
        JSONObject payload = new JSONObject();
        payload.put("id", notice.getLong("seq"));
        payload.put("title", title);
        payload.put("body", notice.optString("body").replaceAll("\\s+", " ").trim());
        payload.put("meta", meta);
        payload.put("provider", providerKind);
        payload.put("noticeId", notice.optString("noticeId"));
        if (notice.optBoolean("plan") && !notice.optString("noticeId").isEmpty()) {
            try { payload.put("planRequest", MobileNoticeClient.detail(notice.getString("noticeId")).optJSONObject("planRequest")); }
            catch (Exception ignored) { /* Details remain available for retry from the notification. */ }
        }
        if (!MobileNoticeBridge.show(this, payload.toString())) throw new IllegalStateException("无法显示系统通知，请检查通知权限");
    }
}
