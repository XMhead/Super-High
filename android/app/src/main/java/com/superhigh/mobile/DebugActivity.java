package com.superhigh.mobile;

/** Separate process/task: launching a debug display must never move the user's main task. */
public class DebugActivity extends MainActivity {
    @Override protected boolean isDebugSession() { return true; }
    @Override public void onCreate(android.os.Bundle state) {
        super.onCreate(state);
        if (getDisplay() == null || getDisplay().getDisplayId() == 0) finishAndRemoveTask();
    }
}
