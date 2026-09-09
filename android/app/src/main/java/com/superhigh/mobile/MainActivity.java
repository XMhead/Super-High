package com.superhigh.mobile;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import android.net.Uri;
import android.webkit.ValueCallback;
import android.content.Intent;
import android.speech.RecognizerIntent;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Locale;

public class MainActivity extends BridgeActivity {
    private static final int VOICE_REQUEST = 47031;
    private int voiceActivityCode = VOICE_REQUEST;
    private String voiceRequestId;
    private String voicePageUrl;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void load() {
        // BridgeActivity has inflated the WebView; register before Bridge loads its first page.
        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        webView.getSettings().setJavaScriptEnabled(true);
        // The mobile workspace is loaded from the paired computer, beyond Capacitor's initial origin.
        webView.addJavascriptInterface(new MobileVoiceBridge(), "SuperHighVoice");
        super.load();
        bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = callback;
                String pageUrl = view.getUrl();
                return super.onShowFileChooser(view, result -> {
                    if (pendingFileCallback != callback) return;
                    pendingFileCallback = null;
                    callback.onReceiveValue(!isDestroyed() && pageUrl != null && pageUrl.equals(view.getUrl()) ? result : null);
                }, params);
            }
        });
    }

    private Intent voiceIntent() {
        return new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Super High 语音输入");
    }

    private class MobileVoiceBridge {
        @JavascriptInterface
        public boolean isAvailable() {
            return voiceIntent().resolveActivity(getPackageManager()) != null;
        }

        @JavascriptInterface
        public void start(String requestId) {
            runOnUiThread(() -> {
                if (voiceRequestId != null || requestId == null || requestId.length() > 100) return;
                voiceRequestId = requestId;
                voicePageUrl = bridge.getWebView().getUrl();
                voiceActivityCode = voiceActivityCode < VOICE_REQUEST + 1000 ? voiceActivityCode + 1 : VOICE_REQUEST;
                try {
                    startActivityForResult(voiceIntent(), voiceActivityCode);
                } catch (Exception error) {
                    finishVoice("error", "", "无法启动系统语音识别，请检查手机是否已启用语音识别服务");
                }
            });
        }

        @JavascriptInterface
        public void cancel(String requestId) {
            runOnUiThread(() -> {
                if (requestId == null || !requestId.equals(voiceRequestId)) return;
                finishActivity(voiceActivityCode);
                finishVoice("cancelled", "", "");
            });
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode < VOICE_REQUEST || requestCode > VOICE_REQUEST + 1000) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (requestCode != voiceActivityCode) return;
        if (resultCode != RESULT_OK) {
            finishVoice("cancelled", "", "");
            return;
        }
        ArrayList<String> results = data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        if (results == null || results.isEmpty() || results.get(0).trim().isEmpty()) {
            finishVoice("error", "", "没有识别到语音，请重试");
        } else {
            finishVoice("result", results.get(0), "");
        }
    }

    private void finishVoice(String state, String text, String error) {
        if (voiceRequestId == null) return;
        String requestId = voiceRequestId;
        String pageUrl = voicePageUrl;
        voiceRequestId = null;
        voicePageUrl = null;
        if (bridge == null || pageUrl == null || !pageUrl.equals(bridge.getWebView().getUrl())) return;
        try {
            JSONObject detail = new JSONObject();
            detail.put("requestId", requestId);
            detail.put("state", state);
            detail.put("text", text);
            detail.put("error", error);
            bridge.getWebView().evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('superhigh:voice-result',{detail:" + detail + "}));", null);
        } catch (org.json.JSONException ignored) {
            // All values are plain strings.
        }
    }

    @Override
    public void onDestroy() {
        voiceRequestId = null;
        voicePageUrl = null;
        if (pendingFileCallback != null) { pendingFileCallback.onReceiveValue(null); pendingFileCallback = null; }
        if (bridge != null) bridge.getWebView().removeJavascriptInterface("SuperHighVoice");
        super.onDestroy();
    }
}
