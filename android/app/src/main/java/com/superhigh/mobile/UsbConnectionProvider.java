package com.superhigh.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;

/** Shell-only USB bootstrap. Credentials travel over stdin, never intent extras or argv. */
public class UsbConnectionProvider extends ContentProvider {
    static final String PREFS = "superhigh-usb";

    @Override public boolean onCreate() { return true; }

    private void requireShell() {
        int uid = Binder.getCallingUid();
        if (uid != 2000 && uid != 0) throw new SecurityException("ADB shell required");
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws java.io.FileNotFoundException {
        requireShell();
        if ("/apk".equals(uri.getPath()) && "w".equals(mode))
            return UsbApkInstaller.receive(getContext(), uri.getQueryParameter("generation"));
        if (!"/connection".equals(uri.getPath()) || !"w".equals(mode))
            throw new java.io.FileNotFoundException("USB connection write only");
        final ParcelFileDescriptor[] pipe;
        try { pipe = ParcelFileDescriptor.createPipe(); }
        catch (IOException error) { throw new java.io.FileNotFoundException("Cannot open USB pipe"); }
        new Thread(() -> {
            try (var input = new ParcelFileDescriptor.AutoCloseInputStream(pipe[0])) {
                var bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[1024];
                int size;
                while ((size = input.read(buffer)) != -1) {
                    if (bytes.size() + size > 8192) throw new IOException("Connection too large");
                    bytes.write(buffer, 0, size);
                }
                JSONObject connection = new JSONObject(bytes.toString("UTF-8"));
                String baseUrl = connection.getString("baseUrl");
                Uri base = Uri.parse(baseUrl);
                if (!"http".equals(base.getScheme()) || !"127.0.0.1".equals(base.getHost())
                        || base.getPort() < 1024 || !"".equals(base.getPath())
                        || base.getQuery() != null || base.getFragment() != null
                        || base.getUserInfo() != null || connection.getString("token").isEmpty())
                    throw new IOException("Invalid USB endpoint");
                boolean saved = getContext().getSharedPreferences(PREFS, 0).edit()
                    .putString("connection", connection.toString()).commit();
                if (saved) getContext().getContentResolver().notifyChange(uri, null);
            } catch (Exception ignored) {
                // Acknowledgement is the opaque generation in status(), never credential text.
            }
        }, "superhigh-usb-config").start();
        return pipe[1];
    }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        Bundle result = new Bundle();
        if ("connection".equals(method)) {
            if (Binder.getCallingUid() != getContext().getApplicationInfo().uid)
                throw new SecurityException("App only");
            result.putString("connection", getContext().getSharedPreferences(PREFS, 0).getString("connection", "{}"));
            return result;
        }
        requireShell();
        if ("install-status".equals(method)) return UsbApkInstaller.status(getContext());
        if ("status".equals(method)) {
            result.putInt("protocol", 1);
            result.putInt("installProtocol", 1);
            try {
                JSONObject saved = new JSONObject(getContext().getSharedPreferences(PREFS, 0)
                    .getString("connection", "{}"));
                result.putString("generation", saved.optString("generation"));
            } catch (Exception ignored) { }
        } else if ("reload".equals(method)) {
            getContext().getContentResolver().notifyChange(Uri.parse("content://com.superhigh.mobile.usb/connection"), null);
            result.putBoolean("reloaded", true);
        } else throw new IllegalArgumentException("Unknown USB operation");
        return result;
    }

    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { requireShell(); return null; }
    @Override public String getType(Uri u) { return "application/json"; }
    @Override public Uri insert(Uri u, ContentValues v) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri u, String s, String[] a) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { throw new UnsupportedOperationException(); }
}
