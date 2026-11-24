package com.superhigh.mobile;

import android.app.Application;
import android.content.Context;
import android.os.Build;
import android.webkit.WebView;

/** Give the isolated debug process its own WebView profile before any view is created. */
public class SuperHighApplication extends Application {
    @Override protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                && (base.getPackageName() + ":debug").equals(Application.getProcessName())) {
            WebView.setDataDirectorySuffix("debug");
        }
    }
}
