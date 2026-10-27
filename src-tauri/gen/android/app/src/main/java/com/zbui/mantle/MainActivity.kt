package com.zbui.mantle

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge draws the webview under the system bars and the keyboard;
    // pad it clear of them instead, so the page never needs safe-area insets
    // and its bottom toolbar rides on top of the keyboard.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById<View>(android.R.id.content)) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    webView.addJavascriptInterface(Bridge(), "MantleAndroid")
  }

  /** `window.MantleAndroid` in the page; see `AndroidBridge` in `src/app/core/tauri-env.ts`. */
  inner class Bridge {
    /** Vaults are plain folders anywhere in shared storage, which needs "All files access". */
    @JavascriptInterface
    fun hasFilesAccess(): Boolean = Environment.isExternalStorageManager()

    @JavascriptInterface
    fun requestFilesAccess() = runOnUiThread {
      startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
    }

    @JavascriptInterface
    fun storageRoot(): String = Environment.getExternalStorageDirectory().absolutePath

    /** Back with nothing left to go back to: leave the app the way Android's own back would. */
    @JavascriptInterface
    fun moveToBack() = runOnUiThread { moveTaskToBack(true) }
  }
}
