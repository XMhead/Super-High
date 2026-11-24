package com.superhigh.mobile;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Fixed-repository updater, also exposed on the paired Host's remote mobile page. */
final class MobileApkUpdater {
    static final int INSTALL_PERMISSION_REQUEST = 48200;
    private static final String RELEASE_API = "https://api.github.com/repos/XMhead/Super-High/releases/latest";
    private static final String ASSET_PREFIX = "https://github.com/XMhead/Super-High/releases/download/";
    private final MainActivity activity;
    private final WebView webView;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final JSONObject status = new JSONObject();
    private volatile boolean closed;
    private boolean busy;
    private String pageUrl;
    private String downloadUrl;
    private String digest;
    private long assetSize;
    private String latestVersion;
    private File apk;

    MobileApkUpdater(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        try {
            status.put("state", "idle");
            status.put("installedVersion", installed().versionName);
        } catch (Exception ignored) { }
    }

    private PackageInfo installed() throws PackageManager.NameNotFoundException {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), signatureFlags());
    }

    private int signatureFlags() {
        return Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    }

    @JavascriptInterface
    public synchronized String getStatus() { return status.toString(); }

    @JavascriptInterface
    public void check() {
        activity.runOnUiThread(() -> {
            if (closed || busy) return;
            busy = true;
            pageUrl = webView.getUrl();
            downloadUrl = null;
            apk = null;
            synchronized (this) {
                status.remove("latestVersion");
                status.remove("downloadUrl");
            }
            emit("checking", "正在检查手机应用更新", -1);
            worker.execute(() -> {
                try {
                    JSONObject release = new JSONObject(readMetadata());
                    if (release.optBoolean("draft") || release.optBoolean("prerelease")) throw new Exception("暂无正式版更新");
                    String version = release.getString("tag_name").replaceFirst("^v", "");
                    if (!version.matches("\\d+\\.\\d+\\.\\d+")) throw new Exception("更新版本格式不正确");
                    JSONArray assets = release.getJSONArray("assets");
                    JSONObject selected = null;
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.getJSONObject(i);
                        if (asset.optString("name").toLowerCase(java.util.Locale.ROOT).endsWith(".apk") && asset.optString("browser_download_url").startsWith(ASSET_PREFIX)) {
                            if (selected != null) throw new Exception("正式版包含多个 APK，无法确定更新包");
                            selected = asset;
                        }
                    }
                    if (selected == null) throw new Exception("正式版尚未提供手机安装包，请稍后重试");
                    downloadUrl = selected.getString("browser_download_url");
                    digest = selected.optString("digest", "");
                    assetSize = selected.getLong("size");
                    if (assetSize <= 0 || assetSize > 200L * 1024 * 1024) throw new Exception("安装包大小不正确");
                    latestVersion = version;
                    synchronized (this) {
                        status.put("latestVersion", version);
                        status.put("downloadUrl", downloadUrl);
                    }
                    boolean newer = compareVersion(version, installed().versionName) > 0;
                    emit(newer ? "available" : "current", newer ? "发现新版本，可下载并安装" : "手机应用已是最新版本", -1);
                } catch (Exception error) { fail(error, "检查更新失败，请检查网络后重试"); }
                finally { activity.runOnUiThread(() -> busy = false); }
            });
        });
    }

    @JavascriptInterface
    public void install() {
        activity.runOnUiThread(() -> {
            if (closed || busy) return;
            pageUrl = webView.getUrl();
            if (apk != null && apk.isFile()) { launchInstaller(); return; }
            if (downloadUrl == null) { emit("error", "请先检查更新", -1); return; }
            busy = true;
            emit("downloading", "正在下载安装包", 0);
            worker.execute(() -> {
                File file = new File(activity.getCacheDir(), "updates/superhigh-update.apk");
                try {
                    if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new Exception("无法创建更新目录");
                    HttpURLConnection connection = connect(downloadUrl);
                    MessageDigest sha = MessageDigest.getInstance("SHA-256");
                    long total = 0;
                    int lastProgress = -1;
                    try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(file)) {
                        byte[] buffer = new byte[32768];
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            if (closed || Thread.currentThread().isInterrupted()) throw new Exception("下载已取消");
                            total += count;
                            if (total > assetSize) throw new Exception("安装包大小校验失败");
                            output.write(buffer, 0, count);
                            sha.update(buffer, 0, count);
                            int progress = (int) (total * 100 / assetSize);
                            if (progress != lastProgress) { emit("downloading", "正在下载安装包", progress); lastProgress = progress; }
                        }
                    } finally { connection.disconnect(); }
                    if (total != assetSize) throw new Exception("安装包下载不完整，请重试");
                    if (digest != null && digest.startsWith("sha256:")) {
                        StringBuilder hex = new StringBuilder();
                        for (byte value : sha.digest()) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
                        if (!digest.substring(7).equalsIgnoreCase(hex.toString())) throw new Exception("安装包摘要校验失败");
                    }
                    verifyApk(file);
                    apk = file;
                    activity.runOnUiThread(() -> {
                        busy = false;
                        if (closed) return;
                        if (pageUrl != null && pageUrl.equals(webView.getUrl())) launchInstaller();
                        else emit("available", "下载完成，可点击安装", 100);
                    });
                } catch (Exception error) {
                    file.delete();
                    fail(error, "下载更新失败，请检查网络后重试");
                    activity.runOnUiThread(() -> busy = false);
                }
            });
        });
    }

    private void verifyApk(File file) throws Exception {
        PackageInfo candidate = activity.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), signatureFlags());
        PackageInfo current = installed();
        if (candidate == null || !activity.getPackageName().equals(candidate.packageName)) throw new Exception("安装包应用身份不匹配");
        long candidateCode = Build.VERSION.SDK_INT >= 28 ? candidate.getLongVersionCode() : candidate.versionCode;
        long currentCode = Build.VERSION.SDK_INT >= 28 ? current.getLongVersionCode() : current.versionCode;
        if (candidateCode <= currentCode || !latestVersion.equals(candidate.versionName)) throw new Exception("安装包版本不匹配或不高于当前版本");
        Signature[] candidateSignatures = Build.VERSION.SDK_INT >= 28 && candidate.signingInfo != null ? candidate.signingInfo.getApkContentsSigners() : candidate.signatures;
        Signature[] currentSignatures = Build.VERSION.SDK_INT >= 28 && current.signingInfo != null ? current.signingInfo.getApkContentsSigners() : current.signatures;
        if (candidateSignatures == null || currentSignatures == null || candidateSignatures.length == 0 ||
            !new HashSet<>(Arrays.asList(candidateSignatures)).equals(new HashSet<>(Arrays.asList(currentSignatures)))) {
            throw new Exception("安装包签名与当前应用不一致，已停止更新");
        }
    }

    private void launchInstaller() {
        try {
            verifyApk(apk);
            if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                emit("permission", "请允许 Super High 安装应用，返回后将继续安装", 100);
                activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())), INSTALL_PERMISSION_REQUEST);
                return;
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(intent);
            emit("installing", "已打开系统安装界面，请确认安装；取消后可重新检查更新", 100);
        } catch (Exception error) { fail(error, "无法打开系统安装界面，请重试"); }
    }

    void permissionResult() {
        if (closed || apk == null) return;
        if (Build.VERSION.SDK_INT < 26 || activity.getPackageManager().canRequestPackageInstalls()) launchInstaller();
        else emit("permission", "尚未允许安装应用，点击继续安装可重新授权", 100);
    }

    private HttpURLConnection connect(String address) throws Exception {
        URL url = new URL(address);
        for (int redirects = 0; redirects < 6; redirects++) {
            String host = url.getHost();
            if (!"https".equals(url.getProtocol()) || !(host.equals("api.github.com") || host.equals("github.com") || host.equals("release-assets.githubusercontent.com") || host.equals("objects.githubusercontent.com"))) throw new Exception("更新下载地址不受信任");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(30000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("User-Agent", "SuperHigh-Android-Updater");
            int code = connection.getResponseCode();
            if (code >= 300 && code < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null) throw new Exception("更新下载地址无效");
                url = new URL(url, location);
            } else if (code == 200) return connection;
            else { connection.disconnect(); throw new Exception(code == 403 || code == 429 ? "更新服务暂时限流，请稍后重试" : "更新服务器请求失败（" + code + "）"); }
        }
        throw new Exception("更新下载跳转次数过多");
    }

    private String readMetadata() throws Exception {
        HttpURLConnection connection = connect(RELEASE_API);
        try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 2 * 1024 * 1024) throw new Exception("更新信息过大");
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        } finally { connection.disconnect(); }
    }

    private static int compareVersion(String a, String b) throws Exception {
        if (b == null || !b.matches("\\d+\\.\\d+\\.\\d+")) throw new Exception("无法识别已安装应用版本");
        String[] left = a.split("\\.");
        String[] right = b.split("\\.");
        for (int i = 0; i < 3; i++) {
            int result = Long.compare(Long.parseLong(left[i]), Long.parseLong(right[i]));
            if (result != 0) return result;
        }
        return 0;
    }

    private void fail(Exception error, String fallback) {
        emit("error", error.getMessage() == null || !(error.getMessage().matches(".*[\\u4e00-\\u9fff].*")) ? fallback : error.getMessage(), -1);
    }

    private void emit(String state, String message, int progress) {
        synchronized (this) {
            try { status.put("state", state); status.put("message", message); status.put("progress", progress); }
            catch (Exception ignored) { }
        }
        String json = getStatus();
        activity.runOnUiThread(() -> {
            if (!closed && pageUrl != null && pageUrl.equals(webView.getUrl())) webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('superhigh:apk-update',{detail:" + json + "}));", null);
        });
    }

    void close() { closed = true; worker.shutdownNow(); }
}
