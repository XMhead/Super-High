package com.superhigh.mobile;

import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Uses the existing paired connection; credentials never leave the app process. */
final class MobileNoticeClient {
    static JSONObject detail(String id) throws Exception {
        return request("/api/mobile/notices/detail?id=" + URLEncoder.encode(id, "UTF-8"), null);
    }

    static void reply(String id, JSONObject answers) throws Exception {
        request("/api/mobile/notices/reply", new JSONObject().put("noticeId", id).put("answers", answers));
    }

    private static JSONObject request(String path, JSONObject payload) throws Exception {
        String[] config = MobileNoticeService.connection();
        if (config == null) throw new IllegalStateException("电脑未连接，请打开 Super High 后重试");
        HttpURLConnection http = (HttpURLConnection) new URL(config[0] + path).openConnection();
        try {
            http.setConnectTimeout(5000);
            http.setReadTimeout(30000);
            http.setInstanceFollowRedirects(false);
            http.setRequestProperty("Authorization", "Bearer " + config[1]);
            if (payload != null) {
                http.setRequestMethod("POST");
                http.setDoOutput(true);
                http.setRequestProperty("Content-Type", "application/json");
                try (var output = http.getOutputStream()) { output.write(payload.toString().getBytes(StandardCharsets.UTF_8)); }
            }
            int status = http.getResponseCode();
            var input = status >= 400 ? http.getErrorStream() : http.getInputStream();
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (input != null) try (input) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (bytes.size() + count > 4 * 1024 * 1024) throw new IllegalStateException("通知内容过长");
                    bytes.write(buffer, 0, count);
                }
            }
            JSONObject response = new JSONObject(bytes.toString("UTF-8"));
            if (status != 200) throw new IllegalStateException(response.optString("error", "请求失败"));
            return response;
        } finally { http.disconnect(); }
    }
    private MobileNoticeClient() {}
}
