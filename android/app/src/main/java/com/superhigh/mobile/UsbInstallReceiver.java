package com.superhigh.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** A request for consent is a blocked update, never an instruction to open display 0. */
public class UsbInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String generation = intent.getStringExtra("generation");
        if (generation == null || !generation.equals(UsbApkInstaller.status(context).getString("installGeneration"))) return;
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_SUCCESS) {
            UsbApkInstaller.state(context, generation, "installed", "");
        } else {
            boolean consent = status == PackageInstaller.STATUS_PENDING_USER_ACTION;
            UsbApkInstaller.state(context, generation, consent ? "requires-confirmation" : "failed",
                consent ? "System requires confirmation; no installer was opened" : "PackageInstaller status " + status);
            int session = intent.getIntExtra("session", -1);
            if (session >= 0) try { context.getPackageManager().getPackageInstaller().abandonSession(session); }
            catch (Exception ignored) { }
        }
    }
}
