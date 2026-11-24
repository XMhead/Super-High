package com.superhigh.mobile;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import org.json.JSONArray;
import org.json.JSONObject;

public class MobileNoticeReplyReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        android.os.Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence text = results == null ? null : results.getCharSequence(MobileNoticeBridge.REPLY_KEY);
        String noticeId = intent.getStringExtra("noticeId");
        int notificationId = intent.getIntExtra("notificationId", 0);
        if (text == null || text.toString().trim().isEmpty() || noticeId == null) return;
        PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                JSONObject detail = MobileNoticeClient.detail(noticeId);
                JSONObject plan = detail.optJSONObject("planRequest");
                JSONArray questions = plan == null ? null : plan.optJSONArray("questions");
                if (questions == null || questions.length() != 1) throw new IllegalStateException("问题已更新，请打开详情检查");
                JSONObject question = questions.getJSONObject(0);
                if (question.optBoolean("isSecret") || question.optBoolean("multiSelect")) throw new IllegalStateException("请在详情中回答该问题");
                JSONObject answers = new JSONObject().put(question.getString("id"), new JSONArray().put(text.toString().trim()));
                MobileNoticeClient.reply(noticeId, answers);
                NotificationManagerCompat.from(context).cancel("cli-notice", notificationId);
            } catch (Exception error) {
                Intent detail = new Intent(context, MobileNoticeActivity.class)
                    .putExtra("noticeId", noticeId).putExtra("notificationId", notificationId)
                    .putExtra("draft", text.toString());
                detail.setData(Uri.parse("superhigh-notice://detail/" + noticeId));
                PendingIntent open = PendingIntent.getActivity(context, notificationId, detail, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
                String message = "发送失败：" + (error.getMessage() == null ? "请重试" : error.getMessage());
                NotificationCompat.Builder builder = new NotificationCompat.Builder(context, "cli-notices")
                    .setSmallIcon(R.mipmap.ic_launcher).setContentTitle(message).setContentText(text)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(message + "\n已保留回答：" + text))
                    .setContentIntent(open).addAction(0, "展开详情", open).setOnlyAlertOnce(true).setAutoCancel(false);
                try { NotificationManagerCompat.from(context).notify("cli-notice", notificationId, builder.build()); }
                catch (SecurityException ignored) { }
            } finally { pending.finish(); }
        }, "superhigh-notice-reply").start();
    }
}
