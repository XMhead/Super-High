package com.superhigh.mobile;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import java.io.FileNotFoundException;
import java.io.IOException;

/** USB transports bytes; the app updates itself through Android's no-user-action API. */
final class UsbApkInstaller {
    private static final String PREFS = "superhigh-usb-install";

    static void state(Context context, String generation, String state, String error) {
        context.getSharedPreferences(PREFS, 0).edit().putString("generation", generation)
            .putString("state", state).putString("error", error).commit();
    }

    static Bundle status(Context context) {
        var prefs = context.getSharedPreferences(PREFS, 0);
        // Self-replacement can invalidate the committing process's PendingIntent.
        // Reconcile only after PackageManager commits a matching APK, never on silence.
        if ("committing".equals(prefs.getString("state", ""))) {
            try {
                var installed = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
                String expected = prefs.getString("expectedHash", "");
                if (!expected.isEmpty() && installed.lastUpdateTime > prefs.getLong("beforeInstallTime", Long.MAX_VALUE)) {
                    var digest = java.security.MessageDigest.getInstance("SHA-256");
                    try (var input = new java.io.FileInputStream(installed.applicationInfo.sourceDir)) {
                        byte[] buffer = new byte[64 * 1024]; int size;
                        while ((size = input.read(buffer)) != -1) digest.update(buffer, 0, size);
                    }
                    if (expected.equals(hex(digest.digest())))
                        state(context, prefs.getString("generation", ""), "installed", "");
                }
            } catch (Exception ignored) { }
        }
        Bundle result = new Bundle();
        result.putString("installGeneration", prefs.getString("generation", ""));
        result.putString("installState", prefs.getString("state", "idle"));
        result.putString("installError", prefs.getString("error", ""));
        return result;
    }

    static ParcelFileDescriptor receive(Context context, String generation) throws FileNotFoundException {
        if (Build.VERSION.SDK_INT < 31 || !context.getPackageManager().canRequestPackageInstalls())
            throw new FileNotFoundException("Background self-update needs Android 12+ and install permission");
        if (generation == null || !generation.matches("[a-f0-9-]{36}"))
            throw new FileNotFoundException("Invalid install generation");
        final ParcelFileDescriptor[] pipe;
        try { pipe = ParcelFileDescriptor.createPipe(); }
        catch (IOException error) { throw new FileNotFoundException("Cannot open APK pipe"); }
        state(context, generation, "receiving", "");
        new Thread(() -> {
            int sessionId = -1;
            PackageInstaller installer = context.getPackageManager().getPackageInstaller();
            try (var input = new ParcelFileDescriptor.AutoCloseInputStream(pipe[0])) {
                var params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(context.getPackageName());
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                sessionId = installer.createSession(params);
                try (var session = installer.openSession(sessionId)) {
                    try (var output = session.openWrite("base.apk", 0, -1)) {
                        byte[] buffer = new byte[64 * 1024];
                        long total = 0;
                        var digest = java.security.MessageDigest.getInstance("SHA-256");
                        int count;
                        while ((count = input.read(buffer)) != -1) {
                            total += count;
                            if (total > 256L * 1024 * 1024) throw new IOException("APK too large");
                            output.write(buffer, 0, count);
                            digest.update(buffer, 0, count);
                        }
                        session.fsync(output);
                        context.getSharedPreferences(PREFS, 0).edit()
                            .putString("expectedHash", hex(digest.digest()))
                            .putLong("beforeInstallTime", context.getPackageManager().getPackageInfo(context.getPackageName(), 0).lastUpdateTime).commit();
                    }
                    Intent callback = new Intent(context, UsbInstallReceiver.class)
                        .setAction("com.superhigh.mobile.USB_INSTALL_RESULT")
                        .putExtra("generation", generation).putExtra("session", sessionId);
                    PendingIntent pending = PendingIntent.getBroadcast(context, sessionId, callback,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                    state(context, generation, "committing", "");
                    session.commit(pending.getIntentSender());
                }
            } catch (Exception error) {
                if (sessionId >= 0) try { installer.abandonSession(sessionId); } catch (Exception ignored) { }
                state(context, generation, "failed", error.getClass().getSimpleName());
            }
        }, "superhigh-usb-apk").start();
        return pipe[1];
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
