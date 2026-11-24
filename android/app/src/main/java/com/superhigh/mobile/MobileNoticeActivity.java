package com.superhigh.mobile;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import androidx.core.app.NotificationManagerCompat;
import androidx.webkit.WebViewAssetLoader;
import org.json.JSONObject;

/** The notification opens a dialog containing the shared mobile renderer. */
public class MobileNoticeActivity extends Activity {
    private WebView web;
    private String noticeId;
    private int notificationId;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        noticeId = getIntent().getStringExtra("noticeId");
        notificationId = getIntent().getIntExtra("notificationId", 0);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder().addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse response = assets.shouldInterceptRequest(request.getUrl());
                return response != null ? response : new WebResourceResponse("text/plain", "UTF-8", null);
            }
        });
        web.addJavascriptInterface(new Bridge(), "SuperHighNoticeDetail");
        setContentView(web);
        getWindow().setLayout(-1, Math.round(getResources().getDisplayMetrics().heightPixels * 0.8f));
        web.loadUrl("https://appassets.androidplatform.net/assets/public/notice-detail.html");
    }

    private void deliver(JSONObject event) {
        runOnUiThread(() -> {
            if (!isFinishing() && !isDestroyed()) web.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('superhigh:notice-detail',{detail:" + event + "}))", null);
        });
    }

    private class Bridge {
        @JavascriptInterface public void load() {
            new Thread(() -> {
                try {
                    JSONObject detail = MobileNoticeClient.detail(noticeId);
                    JSONObject event = new JSONObject().put("type", "detail").put("detail", detail);
                    String draft = getIntent().getStringExtra("draft");
                    if (draft != null) event.put("draft", draft);
                    deliver(event);
                } catch (Exception error) { deliverError("load-error", error); }
            }, "superhigh-notice-detail").start();
        }

        @JavascriptInterface public void reply(String json) {
            new Thread(() -> {
                try {
                    MobileNoticeClient.reply(noticeId, new JSONObject(json));
                    NotificationManagerCompat.from(MobileNoticeActivity.this).cancel("cli-notice", notificationId);
                    runOnUiThread(MobileNoticeActivity.this::finish);
                } catch (Exception error) { deliverError("reply-error", error); }
            }, "superhigh-notice-submit").start();
        }

        @JavascriptInterface public void close() { runOnUiThread(MobileNoticeActivity.this::finish); }
    }

    private void deliverError(String type, Exception error) {
        try { deliver(new JSONObject().put("type", type).put("error", error.getMessage() == null ? "请重试" : error.getMessage())); }
        catch (org.json.JSONException ignored) { }
    }

    @Override protected void onDestroy() {
        if (web != null) { web.removeJavascriptInterface("SuperHighNoticeDetail"); web.destroy(); }
        super.onDestroy();
    }
}
