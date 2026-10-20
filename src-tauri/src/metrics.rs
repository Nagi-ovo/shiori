// Process metrics for the resource panel: CPU % (0-100 across all
// cores) and resident memory of the app's own process tree. Desktop samples
// with sysinfo, iOS reads its own task through Mach, Android asks the
// shiori-metrics plugin; other targets report nothing.

use serde::Serialize;
#[cfg(all(
    not(mobile),
    any(target_os = "macos", target_os = "linux", target_os = "windows")
))]
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Runtime, Webview};

use crate::enforce_main_webview;

#[cfg(all(
    not(mobile),
    any(target_os = "macos", target_os = "linux", target_os = "windows")
))]
static PROCESS_METRICS_SYSTEM: OnceLock<Mutex<ProcessMetricsSampler>> = OnceLock::new();

#[cfg(all(
    not(mobile),
    any(target_os = "macos", target_os = "linux", target_os = "windows")
))]
#[derive(Default)]
struct ProcessMetricsSampler {
    system: sysinfo::System,
    previous: Option<(std::time::Instant, ProcessMetrics)>,
}

#[derive(Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessMetrics {
    cpu_percent: Option<f64>,
    memory_bytes: Option<u64>,
    platform: String,
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn get_process_metrics<R: Runtime>(
    caller: Webview<R>,
    _app: AppHandle<R>,
) -> Result<ProcessMetrics, String> {
    enforce_main_webview(&caller)?;
    // Process enumeration and the mobile sampling windows are blocking work.
    // Neither the native event loop nor a Tokio async worker may run them.
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_shiori_metrics::ShioriMetricsExt;
            let payload = _app
                .shiori_metrics()
                .process_metrics()
                .map_err(|err| err.to_string())?;
            Ok(ProcessMetrics {
                cpu_percent: payload.cpu_percent,
                memory_bytes: payload.memory_bytes,
                platform: std::env::consts::OS.to_string(),
            })
        }
        #[cfg(not(target_os = "android"))]
        {
            collect_process_metrics()
        }
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(all(
    not(mobile),
    any(target_os = "macos", target_os = "linux", target_os = "windows")
))]
fn collect_process_metrics() -> Result<ProcessMetrics, String> {
    let root_pid = sysinfo::Pid::from_u32(std::process::id());
    let system_lock =
        PROCESS_METRICS_SYSTEM.get_or_init(|| Mutex::new(ProcessMetricsSampler::default()));
    let mut sampler = system_lock.lock().map_err(|_| "metrics-unavailable")?;
    if let Some((sampled_at, metrics)) = &sampler.previous {
        if sampled_at.elapsed() < sysinfo::MINIMUM_CPU_UPDATE_INTERVAL {
            // Coalesce StrictMode/remount/concurrent requests. Refreshing too
            // soon would also corrupt the CPU delta's sampling interval.
            return Ok(metrics.clone());
        }
    }
    let has_cpu_baseline = sampler.previous.is_some();
    let system = &mut sampler.system;
    // Discover child processes on every refresh, but do not query executable
    // paths or disk I/O counters that the resource panel never displays.
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory(),
    );

    #[cfg(target_os = "macos")]
    let extra_roots = macos_webkit_services_of(root_pid, system);
    #[cfg(not(target_os = "macos"))]
    let extra_roots = Vec::new();
    let process_tree = app_process_tree(
        root_pid,
        extra_roots,
        system
            .processes()
            .iter()
            .map(|(pid, process)| (*pid, process.parent())),
    );

    let mut cpu_usage = 0.0_f64;
    let mut memory_bytes = 0_u64;
    for pid in process_tree {
        if let Some(process) = system.process(pid) {
            cpu_usage += f64::from(process.cpu_usage());
            memory_bytes = memory_bytes.saturating_add(process.memory());
        }
    }

    if memory_bytes == 0 && cpu_usage == 0.0 && system.process(root_pid).is_none() {
        return Err("metrics-unavailable".into());
    }

    let cpu_count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1) as f64;
    let cpu_percent = if has_cpu_baseline && cpu_count > 0.0 {
        Some((cpu_usage / cpu_count).clamp(0.0, 100.0))
    } else {
        None
    };

    let metrics = ProcessMetrics {
        cpu_percent,
        memory_bytes: Some(memory_bytes),
        platform: std::env::consts::OS.to_string(),
    };
    // First call supplies memory immediately. CPU is unknown until the next
    // spaced sample; the panel's existing 3 s refresh supplies that interval.
    sampler.previous = Some((std::time::Instant::now(), metrics.clone()));
    Ok(metrics)
}

// The app's process tree: the host, any extra roots, and everything reachable
// from them through parent links. Extra roots exist because the parent walk
// alone misses macOS WebKit: WKWebView's WebContent, GPU and Networking
// processes are XPC services whose parent is launchd, so the page's memory and
// CPU (most of the app's) went uncounted, while WebView2 and WebKitGTK helpers
// are ordinary children and were counted on Windows and Linux.
#[cfg(all(
    not(mobile),
    any(target_os = "macos", target_os = "linux", target_os = "windows")
))]
fn app_process_tree<P: Copy + Eq + std::hash::Hash>(
    root: P,
    extra_roots: impl IntoIterator<Item = P>,
    processes: impl Iterator<Item = (P, Option<P>)>,
) -> std::collections::HashSet<P> {
    let processes: Vec<(P, Option<P>)> = processes.collect();
    let mut tree = std::collections::HashSet::from([root]);
    tree.extend(extra_roots);
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, parent) in &processes {
            if parent.is_some_and(|parent| tree.contains(&parent)) && tree.insert(*pid) {
                changed = true;
            }
        }
    }
    tree
}

// WebKit XPC services this app is responsible for. launchd records the
// "responsible" process of every XPC service it spawns (what Activity Monitor
// and the TCC prompts attribute it to); for WKWebView's services that is the
// host app, also when it was started from a terminal. The lookup is libsystem
// SPI, so resolve it at run time and count nothing extra if it is missing.
#[cfg(all(not(mobile), target_os = "macos"))]
fn macos_webkit_services_of(root: sysinfo::Pid, system: &sysinfo::System) -> Vec<sysinfo::Pid> {
    type ResponsibleFor = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    static LOOKUP: OnceLock<Option<ResponsibleFor>> = OnceLock::new();
    let lookup = LOOKUP.get_or_init(|| {
        // SAFETY: dlsym with RTLD_DEFAULT and a NUL-terminated name only reads.
        let symbol = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"responsibility_get_pid_responsible_for_pid".as_ptr(),
            )
        };
        // SAFETY: the libsystem symbol has this signature (pid in, pid out).
        (!symbol.is_null())
            .then(|| unsafe { std::mem::transmute::<*mut libc::c_void, ResponsibleFor>(symbol) })
    });
    let Some(responsible_for) = *lookup else {
        return Vec::new();
    };
    let root = root.as_u32() as libc::pid_t;
    system
        .processes()
        .iter()
        .filter(|(_, process)| {
            process
                .name()
                .to_string_lossy()
                .starts_with("com.apple.WebKit.")
        })
        // SAFETY: a plain pid query; an unknown pid yields -1.
        .filter(|(pid, _)| unsafe { responsible_for(pid.as_u32() as libc::pid_t) } == root)
        .map(|(pid, _)| *pid)
        .collect()
}

// iOS: read the app's own task via Mach. One MACH_TASK_BASIC_INFO sample yields
// both resident_size (memory bytes) and the task's cumulative CPU time
// (user + system, all threads). Sampling twice across a short interval turns the
// CPU time into an instantaneous rate, normalized to 0-100 machine-% (contract
// §3) by dividing by the logical core count — same scale as the desktop arm.
// mach2 0.4.3 exposes task_info() + the flavor constant but NOT the result
// struct, so we declare the small, stable mach_task_basic_info layout ourselves.
#[cfg(target_os = "ios")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct MachTimeValue {
    seconds: i32,
    microseconds: i32,
}

#[cfg(target_os = "ios")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
#[allow(dead_code)] // fields exist to match the kernel's struct layout; only some are read.
struct MachTaskBasicInfo {
    virtual_size: u64,
    resident_size: u64,
    resident_size_max: u64,
    user_time: MachTimeValue,
    system_time: MachTimeValue,
    policy: i32,
    suspend_count: i32,
}

// Live-thread CPU times. MACH_TASK_BASIC_INFO's user/system_time only count
// THREADS THAT HAVE TERMINATED, so a long-lived UI thread reads as ~0 there.
// TASK_THREAD_TIMES_INFO (flavor 3, not in mach2's constants) carries the
// currently-running threads' time; total task CPU = basic + thread_times.
#[cfg(target_os = "ios")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct MachTaskThreadTimesInfo {
    user_time: MachTimeValue,
    system_time: MachTimeValue,
}

// Memory via TASK_VM_INFO.phys_footprint (matches Xcode's "Memory"), which
// mach2 0.4.3 doesn't define — declare the layout up to phys_footprint. The
// kernel fills only as many words as `count` covers, so trailing rev2+ fields
// are intentionally omitted. Offset of phys_footprint verified against a host
// harness (allocating +50MB moved it by exactly 50MB).
#[cfg(target_os = "ios")]
#[repr(C)]
#[derive(Clone, Copy, Default)]
#[allow(dead_code)] // only phys_footprint is read; the rest pad to the kernel layout.
struct MachTaskVmInfo {
    virtual_size: u64,
    region_count: i32,
    page_size: i32,
    resident_size: u64,
    resident_size_peak: u64,
    device: u64,
    device_peak: u64,
    internal: u64,
    internal_peak: u64,
    external: u64,
    external_peak: u64,
    reusable: u64,
    reusable_peak: u64,
    purgeable_volatile_pmap: u64,
    purgeable_volatile_resident: u64,
    purgeable_volatile_virtual: u64,
    compressed: u64,
    compressed_peak: u64,
    compressed_lifetime: u64,
    phys_footprint: u64,
}

#[cfg(target_os = "ios")]
#[derive(Clone, Copy)]
struct IosSample {
    memory_bytes: u64,
    cpu_secs: f64,
    ok: bool,
}

#[cfg(target_os = "ios")]
fn ios_sample() -> IosSample {
    use mach2::kern_return::KERN_SUCCESS;
    use mach2::message::mach_msg_type_number_t;
    use mach2::task::task_info;
    use mach2::task_info::{task_info_t, MACH_TASK_BASIC_INFO};
    use mach2::traps::mach_task_self;

    const TASK_THREAD_TIMES_INFO: u32 = 3;
    const TASK_VM_INFO: u32 = 22;
    fn tv(t: MachTimeValue) -> f64 {
        t.seconds as f64 + t.microseconds as f64 / 1_000_000.0
    }

    let mut basic = MachTaskBasicInfo::default();
    let mut c1 = (std::mem::size_of::<MachTaskBasicInfo>() / std::mem::size_of::<u32>())
        as mach_msg_type_number_t;
    // SAFETY: task_info writes c1 32-bit words into our correctly sized,
    // repr(C) buffer for our own task; nothing escapes the call.
    let kr1 = unsafe {
        task_info(
            mach_task_self(),
            MACH_TASK_BASIC_INFO,
            &mut basic as *mut _ as task_info_t,
            &mut c1,
        )
    };

    let mut times = MachTaskThreadTimesInfo::default();
    let mut c2 = (std::mem::size_of::<MachTaskThreadTimesInfo>() / std::mem::size_of::<u32>())
        as mach_msg_type_number_t;
    // SAFETY: same contract; fills the live-thread CPU times.
    let kr2 = unsafe {
        task_info(
            mach_task_self(),
            TASK_THREAD_TIMES_INFO,
            &mut times as *mut _ as task_info_t,
            &mut c2,
        )
    };

    // Memory: phys_footprint (Xcode-equivalent), falling back to the basic
    // resident_size only if the larger vm_info read fails.
    let mut vm = MachTaskVmInfo::default();
    let mut c3 = (std::mem::size_of::<MachTaskVmInfo>() / std::mem::size_of::<u32>())
        as mach_msg_type_number_t;
    // SAFETY: same contract; the kernel fills phys_footprint within c3 words.
    let kr3 = unsafe {
        task_info(
            mach_task_self(),
            TASK_VM_INFO,
            &mut vm as *mut _ as task_info_t,
            &mut c3,
        )
    };

    let live_cpu = if kr2 == KERN_SUCCESS {
        tv(times.user_time) + tv(times.system_time)
    } else {
        0.0
    };
    let memory_bytes = if kr3 == KERN_SUCCESS {
        vm.phys_footprint
    } else {
        basic.resident_size
    };
    IosSample {
        memory_bytes,
        cpu_secs: tv(basic.user_time) + tv(basic.system_time) + live_cpu,
        ok: kr1 == KERN_SUCCESS,
    }
}

#[cfg(target_os = "ios")]
fn collect_process_metrics() -> Result<ProcessMetrics, String> {
    let first = ios_sample();
    let started = std::time::Instant::now();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let second = ios_sample();

    let memory_bytes = if second.ok {
        Some(second.memory_bytes)
    } else if first.ok {
        Some(first.memory_bytes)
    } else {
        None
    };

    let cpu_percent = if first.ok && second.ok {
        let wall = started.elapsed().as_secs_f64();
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1) as f64;
        if wall > 0.0 && cores > 0.0 {
            let delta = (second.cpu_secs - first.cpu_secs).max(0.0);
            Some((delta / wall / cores) * 100.0)
        } else {
            None
        }
    } else {
        None
    };

    Ok(ProcessMetrics {
        cpu_percent,
        memory_bytes,
        platform: std::env::consts::OS.to_string(),
    })
}

#[cfg(all(
    not(all(
        not(mobile),
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    )),
    not(target_os = "ios")
))]
fn collect_process_metrics() -> Result<ProcessMetrics, String> {
    Ok(ProcessMetrics {
        cpu_percent: None,
        memory_bytes: None,
        platform: std::env::consts::OS.to_string(),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    #[cfg(all(
        not(mobile),
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    ))]
    fn process_metrics_primes_cpu_without_waiting_and_reuses_early_samples() {
        let first = super::collect_process_metrics().unwrap();
        assert_eq!(
            first.cpu_percent, None,
            "CPU needs two spaced samples, not a sleep on the caller"
        );
        assert!(first.memory_bytes.unwrap() > 0);
        let second = super::collect_process_metrics().unwrap();
        assert_eq!(second.cpu_percent, first.cpu_percent);
        assert_eq!(second.memory_bytes, first.memory_bytes);
    }

    // macOS WebKit services are launchd's children (ppid 1), not the host's,
    // so they reach the tree only as extra roots; their own children follow.
    #[test]
    #[cfg(all(
        not(mobile),
        any(target_os = "macos", target_os = "linux", target_os = "windows")
    ))]
    fn process_tree_counts_services_the_app_is_responsible_for() {
        let processes = [
            (1, None),
            (100, Some(1)),   // Shiori
            (101, Some(100)), // a shell it spawned
            (200, Some(1)),   // its WebContent service
            (201, Some(200)), // a helper of that service
            (300, Some(1)),   // another app's WebContent service
        ];
        let tree = super::app_process_tree(100, [200], processes.into_iter());
        let mut tree: Vec<_> = tree.into_iter().collect();
        tree.sort();
        assert_eq!(tree, vec![100, 101, 200, 201]);
    }
}
