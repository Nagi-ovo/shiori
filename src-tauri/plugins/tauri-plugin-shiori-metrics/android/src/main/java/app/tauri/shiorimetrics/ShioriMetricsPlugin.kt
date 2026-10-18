// Android native backend for Shiori's resource metrics.
//
// Reads the app's OWN process (no other process is inspected):
//   * CPU  — android.os.Process.getElapsedCpuTime() is cumulative process CPU
//            time (ms, across all threads). Sampling it across a short wall-clock
//            window and dividing by the logical core count yields 0-100 machine-%
//            on the same scale as desktop (sysinfo) and iOS (Mach).
//   * Memory — ActivityManager.getProcessMemoryInfo(...).totalPss, in KB, ×1024
//            to bytes. PSS can be throttled to ~5 min on Android 8+, so this may
//            update slowly, but it is a real reading.
//
// Rust-driven only: the app's get_process_metrics command calls `getMetrics` via
// run_mobile_plugin. No JS command surface (the @Command is reachable only from
// Rust), mirroring tauri-plugin-shiori-browser.

package app.tauri.shiorimetrics

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.os.Process
import android.os.SystemClock
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class ShioriMetricsPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun getMetrics(invoke: Invoke) {
        val ret = JSObject()

        // CPU%: delta of cumulative process CPU time over a short wall window,
        // normalized to total machine CPU. Runs on a background invoke thread,
        // so the brief sleep does not block the UI.
        val cores = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)
        val cpu0 = Process.getElapsedCpuTime()
        val wall0 = SystemClock.elapsedRealtime()
        Thread.sleep(300)
        val cpu1 = Process.getElapsedCpuTime()
        val wall1 = SystemClock.elapsedRealtime()
        val dWall = (wall1 - wall0).toDouble()
        if (dWall > 0.0) {
            val pct = ((cpu1 - cpu0).toDouble() / dWall / cores) * 100.0
            ret.put("cpuPercent", pct.coerceIn(0.0, 100.0))
        }
        // else: omit cpuPercent → None on the Rust side.

        // Memory: total PSS for our pid, KB → bytes.
        try {
            val am = activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val infos = am.getProcessMemoryInfo(intArrayOf(Process.myPid()))
            if (infos.isNotEmpty()) {
                ret.put("memoryBytes", infos[0].totalPss.toLong() * 1024L)
            }
        } catch (_: Exception) {
            // Omit memoryBytes → None on the Rust side.
        }

        invoke.resolve(ret)
    }
}
