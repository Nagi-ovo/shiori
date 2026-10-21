//! Desktop-only loopback API bridge for trusted local Shiori integrations.
//!
//! The bearer token and descriptor never leave the user's cache directory.
//! The listener is deliberately a small, bounded HTTP/1.x implementation: it
//! accepts exactly one request per connection, never enables CORS, and closes
//! every socket after a JSON response.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    borrow::Cow,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

mod wire;
use wire::{context_matches_target, validate_context, AnnotationRequestBody};
pub(crate) use wire::{LiveApiContext, LiveApiTarget};

pub(crate) const LIVE_API_SCHEMA: &str = "shiori.live/v1";
pub(crate) const LIVE_API_EVENT: &str = "shiori://live-api/annotation-request";
const LIVE_API_DESCRIPTOR_NAME: &str = "live-api.json";
// Every instance also writes a descriptor named after its own pid, and the
// shared descriptor above is just a pointer at whoever started last. Without
// the per-instance copy, a second instance overwrote the only record of the
// first: if that second instance then died without running its cleanup, the
// shared descriptor named a dead pid forever and the still-running first
// instance was unreachable until the user restarted it. The CLI reads these
// to find a live instance again, and prunes the ones whose pid is gone.
const LIVE_API_INSTANCE_PREFIX: &str = "live-api.";
const LIVE_API_INSTANCE_SUFFIX: &str = ".json";
const LIVE_API_LOCK_NAME: &str = ".live-api.lock";
const MAX_DESCRIPTOR_BYTES: u64 = 16 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 6 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 1024 * 1024;
const MAX_COMPLETION_ERROR_MESSAGE_BYTES: usize = 2048;
const MAX_CONNECTIONS: usize = 8;
const HEADER_TIMEOUT: Duration = Duration::from_secs(2);
const BODY_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
// Wall-clock bound for writing one whole response. set_write_timeout only
// bounds each write syscall, so without this a client draining its receive
// window one byte at a time could hold a connection thread for hours.
const RESPONSE_WRITE_DEADLINE: Duration = Duration::from_secs(10);
const FRONTEND_TIMEOUT: Duration = Duration::from_secs(30);
const FRONTEND_MUTATION_SAFETY: Duration = Duration::from_millis(500);
// A pending slot is normally removed by its owning connection thread (on
// completion or at FRONTEND_TIMEOUT). If that thread dies without cleanup,
// reclaim the slot after a comfortable multiple of the frontend timeout so a
// single leak cannot answer APP_BUSY forever until app restart.
const PENDING_RECLAIM_AFTER: Duration = Duration::from_secs(60);
const ACCEPT_ERROR_RETRY_DELAY: Duration = Duration::from_millis(250);
use crate::MAIN_WEBVIEW_LABEL;
const INTERNAL_RESPONSE_FALLBACK: &[u8] = br#"{"schema":"shiori.live/v1","ok":false,"error":{"code":"INTERNAL","message":"Live API response exceeded the size limit"}}"#;

#[derive(Clone, Debug, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveApiResultError {
    pub(crate) code: String,
    pub(crate) message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) details: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveApiCompletionResult {
    pub(crate) ok: bool,
    #[serde(default)]
    pub(crate) data: Option<Value>,
    #[serde(default)]
    pub(crate) error: Option<LiveApiResultError>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveApiDescriptor {
    schema: String,
    port: u16,
    token: String,
    pid: u32,
    app_version: String,
}

#[derive(Debug)]
struct PendingResponse {
    status: u16,
    body: Value,
}

#[derive(Debug)]
struct PendingRequest {
    request_id: String,
    sender: SyncSender<PendingResponse>,
    registered_at: Instant,
    expires_at_ms: u64,
    mutation_authorized: bool,
}

#[derive(Default)]
struct LiveApiSession {
    context: Option<LiveApiContext>,
    pending: Option<PendingRequest>,
}

#[derive(Default)]
struct LiveApiInner {
    session: Mutex<LiveApiSession>,
    stopping: AtomicBool,
    active_connections: AtomicUsize,
}

struct LiveApiRuntime {
    port: u16,
    token: String,
    descriptor_path: PathBuf,
    server_thread: JoinHandle<()>,
}

pub(crate) struct LiveApiState {
    inner: Arc<LiveApiInner>,
    runtime: Mutex<Option<LiveApiRuntime>>,
}

impl Default for LiveApiState {
    fn default() -> Self {
        Self {
            inner: Arc::new(LiveApiInner::default()),
            runtime: Mutex::new(None),
        }
    }
}

impl LiveApiState {
    pub(crate) fn start<R: Runtime>(&self, app: AppHandle<R>) -> Result<(), String> {
        let mut runtime = lock(&self.runtime);
        if runtime.is_some() {
            return Ok(());
        }

        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|_| "live-api-cache-unavailable".to_string())?;
        let descriptor_path = cache_dir.join(LIVE_API_DESCRIPTOR_NAME);
        // The listener stays blocking: shutdown() interrupts accept with its
        // wake-connect, so no poll interval (and its idle wakeups) is needed.
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "live-api-bind-failed".to_string())?;
        let port = listener
            .local_addr()
            .map_err(|_| "live-api-bind-failed".to_string())?
            .port();
        let token = random_hex(32).map_err(|_| "live-api-random-unavailable".to_string())?;
        let descriptor = LiveApiDescriptor {
            schema: LIVE_API_SCHEMA.to_string(),
            port,
            token: token.clone(),
            pid: std::process::id(),
            app_version: app.package_info().version.to_string(),
        };

        // Per-instance first: the shared descriptor is only a pointer, and it
        // must never exist without the record a reader can fall back to.
        if write_instance_descriptor_atomic(&cache_dir, &descriptor).is_err() {
            let _ = cleanup_instance_descriptor(&cache_dir, descriptor.pid, &token);
            return Err("live-api-descriptor-write-failed".into());
        }
        if write_descriptor_atomic(&cache_dir, &descriptor).is_err() {
            // The atomic writer can fail after rename (for example while
            // syncing the directory). Remove only the descriptor carrying
            // this launch's token; never delete a newer instance's file.
            let _ = cleanup_descriptor_if_owned(&descriptor_path, &token);
            let _ = cleanup_instance_descriptor(&cache_dir, descriptor.pid, &token);
            return Err("live-api-descriptor-write-failed".into());
        }

        self.inner.stopping.store(false, Ordering::SeqCst);
        let inner = Arc::clone(&self.inner);
        let server_token = token.clone();
        let server_descriptor_path = descriptor_path.clone();
        let thread_result =
            thread::Builder::new()
                .name("shiori-live-api".into())
                .spawn(move || {
                    server_loop(
                        listener,
                        port,
                        server_token,
                        server_descriptor_path,
                        inner,
                        app,
                    )
                });
        let server_thread = match thread_result {
            Ok(handle) => handle,
            Err(_) => {
                let _ = cleanup_descriptor_if_owned(&descriptor_path, &token);
                let _ = cleanup_instance_descriptor(&cache_dir, descriptor.pid, &token);
                return Err("live-api-thread-failed".into());
            }
        };

        *runtime = Some(LiveApiRuntime {
            port,
            token,
            descriptor_path,
            server_thread,
        });
        Ok(())
    }

    pub(crate) fn update_context(&self, context: Option<LiveApiContext>) -> Result<(), String> {
        if let Some(context) = context.as_ref() {
            validate_context(context)?;
        }
        // Once an event is emitted, the frontend rechecks the captured target
        // and native authorization gates its final mutation. Do not cancel a
        // pending request merely because the user switches tabs after that
        // commit, or a successful write could be misreported as 409.
        lock(&self.inner.session).context = context;
        Ok(())
    }

    pub(crate) fn complete(
        &self,
        request_id: &str,
        result: LiveApiCompletionResult,
    ) -> Result<(), String> {
        let requires_mutation_authorization = result.ok;
        let response = completion_response(result);
        let pending = {
            let mut session = lock(&self.inner.session);
            let Some(current) = session.pending.as_ref() else {
                return Err("live-api-request-not-found".into());
            };
            if current.request_id != request_id {
                return Err("live-api-request-not-found".into());
            }
            // The frontend also enforces expiresAtMs before mutating, but the
            // native boundary must not trust a delayed or compromised webview
            // to honor that contract. Check both clocks: wall time keeps the
            // absolute event deadline consistent, while Instant remains safe
            // if the system clock moves backwards.
            if unix_time_ms(SystemTime::now()) >= current.expires_at_ms
                || current.registered_at.elapsed() >= FRONTEND_TIMEOUT
            {
                return Err("live-api-request-expired".into());
            }
            if requires_mutation_authorization && !current.mutation_authorized {
                return Err("live-api-mutation-not-authorized".into());
            }
            session.pending.take().expect("pending request exists")
        };
        pending
            .sender
            .send(response)
            .map_err(|_| "live-api-request-closed".to_string())
    }

    /// Authorize the webview's final synchronous mutation while the native
    /// request slot still has a safety margin. `Instant` is authoritative, so
    /// a system-clock rollback before the event reaches JavaScript cannot
    /// extend the mutation window.
    pub(crate) fn authorize_mutation(&self, request_id: &str) -> Result<(), String> {
        let mut session = lock(&self.inner.session);
        let Some(current) = session.pending.as_mut() else {
            return Err("live-api-request-not-found".into());
        };
        if current.request_id != request_id {
            return Err("live-api-request-not-found".into());
        }
        if mutation_authorization_expired(
            current.expires_at_ms,
            unix_time_ms(SystemTime::now()),
            current.registered_at.elapsed(),
        ) {
            return Err("live-api-request-expired".into());
        }
        current.mutation_authorized = true;
        Ok(())
    }

    /// The main webview died (window closed on macOS, webview crash). Its
    /// context describes a document nobody can service any more, and a
    /// pending request's event has no listener — without this, GET /v1/context
    /// keeps reporting the dead document as open and every POST hangs for the
    /// full frontend timeout before returning 504.
    pub(crate) fn on_main_webview_destroyed(&self) {
        let pending = {
            let mut session = lock(&self.inner.session);
            session.context = None;
            session.pending.take()
        };
        if let Some(pending) = pending {
            let _ = pending.sender.send(problem_response(
                500,
                "INTERNAL",
                "The Shiori window closed before the request completed",
            ));
        }
    }

    pub(crate) fn shutdown(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
        let pending = lock(&self.inner.session).pending.take();
        if let Some(pending) = pending {
            let _ =
                pending
                    .sender
                    .send(problem_response(500, "INTERNAL", "Shiori is shutting down"));
        }

        let runtime = lock(&self.runtime).take();
        if let Some(runtime) = runtime {
            let _ = TcpStream::connect(("127.0.0.1", runtime.port));
            let _ = runtime.server_thread.join();
            cleanup_owned_descriptors(&runtime.descriptor_path, &runtime.token);
        }
    }
}

impl Drop for LiveApiState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RegisterError {
    NoPdf,
    TargetChanged,
    Busy,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn completion_response(result: LiveApiCompletionResult) -> PendingResponse {
    let response = match (result.ok, result.data, result.error) {
        (true, Some(data), None) => PendingResponse {
            status: 200,
            body: success_envelope(data),
        },
        (false, None, Some(error))
            if known_completion_error(&error.code)
                && !error.message.is_empty()
                && error.message.len() <= MAX_COMPLETION_ERROR_MESSAGE_BYTES =>
        {
            let status = completion_error_status(&error.code);
            PendingResponse {
                status,
                body: json!({
                    "schema": LIVE_API_SCHEMA,
                    "ok": false,
                    "error": error,
                }),
            }
        }
        _ => problem_response(
            500,
            "INTERNAL",
            "The app returned an invalid Live API result",
        ),
    };
    if response_body_fits(&response.body) {
        response
    } else {
        problem_response(
            500,
            "INTERNAL",
            "The app returned an oversized Live API result",
        )
    }
}

fn known_completion_error(code: &str) -> bool {
    matches!(
        code,
        "TARGET_CHANGED"
            | "NO_PDF"
            | "OPERATION_CONFLICT"
            | "SPEC_INVALID"
            | "APP_BUSY"
            | "REQUEST_TIMEOUT"
            | "INTERNAL"
    )
}

fn completion_error_status(code: &str) -> u16 {
    match code {
        "TARGET_CHANGED" | "NO_PDF" | "OPERATION_CONFLICT" => 409,
        "SPEC_INVALID" => 422,
        "APP_BUSY" => 503,
        "REQUEST_TIMEOUT" => 504,
        _ => 500,
    }
}

fn success_envelope(data: Value) -> Value {
    json!({
        "schema": LIVE_API_SCHEMA,
        "ok": true,
        "data": data,
    })
}

fn problem_response(status: u16, code: &str, message: &str) -> PendingResponse {
    PendingResponse {
        status,
        body: json!({
            "schema": LIVE_API_SCHEMA,
            "ok": false,
            "error": {
                "code": code,
                "message": message,
            },
        }),
    }
}

fn random_hex(byte_count: usize) -> io::Result<String> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom::fill(&mut bytes)
        .map_err(|error| io::Error::other(format!("operating system RNG failed: {error}")))?;
    let mut output = String::with_capacity(byte_count * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(output)
}

fn prepare_private_cache_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "live API cache path is not a directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o700 {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

struct DescriptorLock {
    file: File,
}

impl Drop for DescriptorLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.file);
    }
}

fn acquire_descriptor_lock(cache_dir: &Path) -> io::Result<DescriptorLock> {
    prepare_private_cache_dir(cache_dir)?;
    let lock_path = cache_dir.join(LIVE_API_LOCK_NAME);
    if let Ok(metadata) = fs::symlink_metadata(&lock_path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Live API lock is not a regular file",
            ));
        }
    }

    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&lock_path)?;
    verify_descriptor_lock_file(&file, &lock_path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    fs2::FileExt::lock_exclusive(&file)?;
    // The fixed lock file is never removed by Shiori, but verify again after
    // a contended wait so an unexpected replacement cannot split processes
    // across two independently locked inodes.
    verify_descriptor_lock_file(&file, &lock_path)?;
    Ok(DescriptorLock { file })
}

fn verify_descriptor_lock_file(file: &File, lock_path: &Path) -> io::Result<()> {
    let file_metadata = file.metadata()?;
    let path_metadata = fs::symlink_metadata(&lock_path)?;
    if !file_metadata.is_file()
        || !path_metadata.is_file()
        || path_metadata.file_type().is_symlink()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Live API lock is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file_metadata.dev() != path_metadata.dev() || file_metadata.ino() != path_metadata.ino()
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Live API lock changed while opening",
            ));
        }
    }
    Ok(())
}

fn with_descriptor_lock<T>(
    cache_dir: &Path,
    operation: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    let _lock = acquire_descriptor_lock(cache_dir)?;
    operation()
}

/// Name of the per-instance descriptor for `pid`. Kept in one place because
/// the CLI parses the same shape when it has to rediscover a live instance.
fn instance_descriptor_name(pid: u32) -> String {
    format!("{LIVE_API_INSTANCE_PREFIX}{pid}{LIVE_API_INSTANCE_SUFFIX}")
}

fn write_descriptor_atomic(
    cache_dir: &Path,
    descriptor: &LiveApiDescriptor,
) -> io::Result<PathBuf> {
    with_descriptor_lock(cache_dir, || {
        write_descriptor_atomic_unlocked(cache_dir, descriptor, LIVE_API_DESCRIPTOR_NAME)
    })
}

/// The instance's own descriptor. Written before the shared one so the shared
/// pointer never exists without the record it can fall back to.
fn write_instance_descriptor_atomic(
    cache_dir: &Path,
    descriptor: &LiveApiDescriptor,
) -> io::Result<PathBuf> {
    let name = instance_descriptor_name(descriptor.pid);
    with_descriptor_lock(cache_dir, || {
        write_descriptor_atomic_unlocked(cache_dir, descriptor, &name)
    })
}

/// Retire both descriptors this process published: the shared pointer (only
/// if it still carries our token — a newer instance may own it by now) and
/// our own per-instance file.
fn cleanup_owned_descriptors(descriptor_path: &Path, token: &str) {
    let _ = cleanup_descriptor_if_owned(descriptor_path, token);
    if let Some(cache_dir) = descriptor_path.parent() {
        let _ = cleanup_instance_descriptor(cache_dir, std::process::id(), token);
    }
}

/// Remove this instance's own descriptor. Unlike the shared one there is no
/// ownership question — the filename is the pid — but the token is still
/// checked so a recycled pid cannot delete a newer instance's file.
fn cleanup_instance_descriptor(cache_dir: &Path, pid: u32, token: &str) -> io::Result<bool> {
    let path = cache_dir.join(instance_descriptor_name(pid));
    with_descriptor_lock(cache_dir, || {
        cleanup_descriptor_if_owned_unlocked(&path, token)
    })
}

fn write_descriptor_atomic_unlocked(
    cache_dir: &Path,
    descriptor: &LiveApiDescriptor,
    file_name: &str,
) -> io::Result<PathBuf> {
    let destination = cache_dir.join(file_name);
    // Keyed on the destination so the shared and per-instance writes of one
    // launch can never collide on the same temporary path.
    let temporary = cache_dir.join(format!(
        ".{file_name}.{}.{}.tmp",
        descriptor.pid,
        random_hex(8)?
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let write_result = (|| -> io::Result<()> {
        let mut file = options.open(&temporary)?;
        let mut bytes = serde_json::to_vec(descriptor).map_err(io::Error::other)?;
        bytes.push(b'\n');
        file.write_all(&bytes)?;
        file.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(windows)]
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "existing Live API descriptor is not a regular file",
                ));
            }
            // Windows rename cannot replace a stale destination. The cache
            // directory is private and the entry type is verified first.
            fs::remove_file(&destination)?;
        }
        fs::rename(&temporary, &destination)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))?;
            File::open(cache_dir)?.sync_all()?;
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result?;
    Ok(destination)
}

fn cleanup_descriptor_if_owned(path: &Path, token: &str) -> io::Result<bool> {
    let cache_dir = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "Live API descriptor has no parent directory",
        )
    })?;
    with_descriptor_lock(cache_dir, || {
        cleanup_descriptor_if_owned_unlocked(path, token)
    })
}

fn cleanup_descriptor_if_owned_unlocked(path: &Path, token: &str) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_DESCRIPTOR_BYTES
    {
        return Ok(false);
    }
    let descriptor: LiveApiDescriptor = match serde_json::from_slice(&fs::read(path)?) {
        Ok(descriptor) => descriptor,
        Err(_) => return Ok(false),
    };
    if descriptor.schema != LIVE_API_SCHEMA || !constant_time_eq(&descriptor.token, token) {
        return Ok(false);
    }
    fs::remove_file(path)?;
    Ok(true)
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    let max_len = left.len().max(right.len());
    for index in 0..max_len {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

fn server_loop<R: Runtime>(
    listener: TcpListener,
    port: u16,
    token: String,
    descriptor_path: PathBuf,
    inner: Arc<LiveApiInner>,
    app: AppHandle<R>,
) {
    let mut consecutive_accept_errors: u32 = 0;
    while !inner.stopping.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((mut stream, peer)) => {
                consecutive_accept_errors = 0;
                if inner.stopping.load(Ordering::SeqCst) {
                    // Most likely shutdown()'s wake-connect; exit without
                    // spawning a handler for it.
                    let _ = stream.shutdown(Shutdown::Both);
                    break;
                }
                if !peer.ip().is_loopback() {
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                let previous = inner.active_connections.fetch_add(1, Ordering::SeqCst);
                if previous >= MAX_CONNECTIONS {
                    inner.active_connections.fetch_sub(1, Ordering::SeqCst);
                    // Answer instead of a raw close so shed clients see a
                    // diagnosable 503 rather than ECONNRESET / fetch failed.
                    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
                    write_problem(
                        &mut stream,
                        HttpProblem::new(
                            503,
                            "APP_BUSY",
                            "Shiori is handling too many Live API connections",
                        ),
                    );
                    continue;
                }
                let response_stream = stream.try_clone();
                let connection_inner = Arc::clone(&inner);
                let connection_token = token.clone();
                let connection_app = app.clone();
                let spawn_result = thread::Builder::new()
                    .name("shiori-live-api-request".into())
                    .spawn(move || {
                        let _guard = ConnectionGuard(Arc::clone(&connection_inner));
                        handle_connection(
                            stream,
                            port,
                            &connection_token,
                            connection_inner,
                            connection_app,
                        );
                    });
                if spawn_result.is_err() {
                    inner.active_connections.fetch_sub(1, Ordering::SeqCst);
                    if let Ok(mut stream) = response_stream {
                        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
                        write_problem(
                            &mut stream,
                            HttpProblem::new(
                                500,
                                "INTERNAL",
                                "Shiori could not service the Live API connection",
                            ),
                        );
                    }
                }
            }
            Err(error) => {
                // Accept errors are almost always transient — ECONNABORTED
                // from a client that reset before accept, EINTR, or EMFILE
                // under fd pressure. Exiting here would kill the Live API
                // for the rest of the app's life (start() early-returns while
                // the runtime is registered), so retry with a delay and let
                // the stopping flag / shutdown wake-connect end the loop.
                if inner.stopping.load(Ordering::SeqCst) {
                    break;
                }
                consecutive_accept_errors = consecutive_accept_errors.saturating_add(1);
                if consecutive_accept_errors == 1 || consecutive_accept_errors % 240 == 0 {
                    log::warn!(
                        "[shiori] Live API accept failed (attempt {consecutive_accept_errors}, retrying): {error}"
                    );
                }
                thread::sleep(ACCEPT_ERROR_RETRY_DELAY);
            }
        }
    }
    cleanup_owned_descriptors(&descriptor_path, &token);
}

struct ConnectionGuard(Arc<LiveApiInner>);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.active_connections.fetch_sub(1, Ordering::SeqCst);
    }
}

fn handle_connection<R: Runtime>(
    mut stream: TcpStream,
    port: u16,
    token: &str,
    inner: Arc<LiveApiInner>,
    app: AppHandle<R>,
) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));

    let mut request = match read_request_head(&mut stream) {
        Ok(request) => request,
        Err(problem) => {
            write_problem(&mut stream, problem);
            return;
        }
    };

    if request.has_header("origin") {
        write_problem(
            &mut stream,
            HttpProblem::new(
                403,
                "ORIGIN_FORBIDDEN",
                "Browser-originated requests are not allowed",
            ),
        );
        return;
    }
    if !request.valid_host(port) {
        write_problem(
            &mut stream,
            HttpProblem::new(400, "INVALID_REQUEST", "Invalid Host header"),
        );
        return;
    }
    if !request.authorized(token) {
        write_problem(
            &mut stream,
            HttpProblem::new(401, "AUTH_FAILED", "Bearer authentication failed"),
        );
        return;
    }
    if request.has_header("transfer-encoding") {
        write_problem(
            &mut stream,
            HttpProblem::new(400, "INVALID_REQUEST", "Transfer-Encoding is not supported"),
        );
        return;
    }
    if request.content_length().is_err() {
        write_problem(
            &mut stream,
            HttpProblem::new(
                400,
                "INVALID_REQUEST",
                "Content-Length must appear at most once and contain only digits",
            ),
        );
        return;
    }

    let route = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/context") => Route::Context,
        ("POST", "/v1/annotations") => Route::Annotations,
        (_, "/v1/context" | "/v1/annotations") => {
            write_problem(
                &mut stream,
                HttpProblem::new(
                    405,
                    "METHOD_NOT_ALLOWED",
                    "The method is not allowed for this endpoint",
                ),
            );
            return;
        }
        _ => {
            write_problem(
                &mut stream,
                HttpProblem::new(404, "NOT_FOUND", "Live API endpoint not found"),
            );
            return;
        }
    };

    match route {
        Route::Context => {
            match request.content_length() {
                Ok(None | Some(0)) => {}
                _ => {
                    write_problem(
                        &mut stream,
                        HttpProblem::new(
                            400,
                            "INVALID_REQUEST",
                            "GET /v1/context must not include a body",
                        ),
                    );
                    return;
                }
            }
            if !request.buffered_body.is_empty() {
                write_problem(
                    &mut stream,
                    HttpProblem::new(
                        400,
                        "INVALID_REQUEST",
                        "GET /v1/context must not include a body",
                    ),
                );
                return;
            }
            let context = lock(&inner.session).context.clone();
            write_json_response(
                &mut stream,
                200,
                &success_envelope(json!({ "context": context })),
            );
        }
        Route::Annotations => {
            let content_type = match request.single_header("content-type") {
                Ok(Some(content_type)) => content_type,
                _ => {
                    write_problem(
                        &mut stream,
                        HttpProblem::new(
                            400,
                            "INVALID_REQUEST",
                            "Content-Type must be application/json",
                        ),
                    );
                    return;
                }
            };
            if !is_json_content_type(content_type) {
                write_problem(
                    &mut stream,
                    HttpProblem::new(
                        400,
                        "INVALID_REQUEST",
                        "Content-Type must be application/json",
                    ),
                );
                return;
            }
            let content_length = match request.content_length() {
                Ok(Some(content_length)) => content_length,
                Ok(None) | Err(()) => {
                    write_problem(
                        &mut stream,
                        HttpProblem::new(
                            400,
                            "INVALID_REQUEST",
                            "A single Content-Length header is required",
                        ),
                    );
                    return;
                }
            };
            if content_length > MAX_BODY_BYTES {
                write_problem(
                    &mut stream,
                    HttpProblem::new(
                        413,
                        "REQUEST_TOO_LARGE",
                        "The annotation request exceeds the body limit",
                    ),
                );
                return;
            }
            match request.single_header("expect") {
                Ok(None) => {}
                Ok(Some(expectation)) if expectation.eq_ignore_ascii_case("100-continue") => {
                    // The body is always wanted once validation reaches this
                    // point. Answering the interim response unblocks curl-style
                    // clients that otherwise stall ~1s before sending the body.
                    let _ = stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
                }
                _ => {
                    write_problem(
                        &mut stream,
                        HttpProblem::new(
                            417,
                            "EXPECTATION_FAILED",
                            "Only the 100-continue expectation is supported",
                        ),
                    );
                    return;
                }
            }
            let body = match request.read_body(&mut stream, content_length) {
                Ok(body) => body,
                Err(problem) => {
                    write_problem(&mut stream, problem);
                    return;
                }
            };
            let body: AnnotationRequestBody = match serde_json::from_slice(&body) {
                Ok(body) => body,
                Err(_) => {
                    write_problem(
                        &mut stream,
                        HttpProblem::new(
                            400,
                            "INVALID_REQUEST",
                            "The annotation request body is invalid JSON",
                        ),
                    );
                    return;
                }
            };
            if !body.is_valid() {
                write_problem(
                    &mut stream,
                    HttpProblem::new(
                        400,
                        "INVALID_REQUEST",
                        "The annotation target or spec is invalid",
                    ),
                );
                return;
            }

            let state = LiveApiStateView { inner };
            let request_id = match random_hex(16) {
                Ok(request_id) => request_id,
                Err(_) => {
                    write_problem(
                        &mut stream,
                        HttpProblem::new(
                            500,
                            "INTERNAL",
                            "Secure request identifiers are unavailable",
                        ),
                    );
                    return;
                }
            };
            let (sender, receiver) = mpsc::sync_channel(1);
            let expires_at_ms =
                match state.register_request(request_id.clone(), body.target.clone(), sender) {
                    Ok(expires_at_ms) => expires_at_ms,
                    Err(RegisterError::NoPdf) => {
                        write_problem(
                            &mut stream,
                            HttpProblem::new(409, "NO_PDF", "No PDF is active in Shiori"),
                        );
                        return;
                    }
                    Err(RegisterError::TargetChanged) => {
                        write_problem(
                            &mut stream,
                            HttpProblem::new(
                                409,
                                "TARGET_CHANGED",
                                "The requested PDF is not active in Shiori",
                            ),
                        );
                        return;
                    }
                    Err(RegisterError::Busy) => {
                        write_problem(
                            &mut stream,
                            HttpProblem::new(
                                503,
                                "APP_BUSY",
                                "Shiori is already handling a Live API request",
                            ),
                        );
                        return;
                    }
                };

            let event = body.into_event(request_id.clone(), expires_at_ms);
            if app
                .emit_to(
                    EventTarget::webview(MAIN_WEBVIEW_LABEL),
                    LIVE_API_EVENT,
                    event,
                )
                .is_err()
            {
                state.remove_pending(&request_id);
                write_problem(
                    &mut stream,
                    HttpProblem::new(500, "INTERNAL", "The Shiori webview is unavailable"),
                );
                return;
            }

            let response = wait_for_frontend(&state, &request_id, receiver);
            write_json_response(&mut stream, response.status, &response.body);
        }
    }
}

#[derive(Clone, Copy)]
enum Route {
    Context,
    Annotations,
}

// Request handlers only need a non-owning view of the managed state's shared
// inner data. Keeping the runtime mutex out of worker threads prevents a slow
// frontend completion from ever blocking shutdown's listener teardown.
struct LiveApiStateView {
    inner: Arc<LiveApiInner>,
}

impl LiveApiStateView {
    fn register_request(
        &self,
        request_id: String,
        target: LiveApiTarget,
        sender: SyncSender<PendingResponse>,
    ) -> Result<u64, RegisterError> {
        let mut session = lock(&self.inner.session);
        let Some(context) = session.context.as_ref() else {
            return Err(RegisterError::NoPdf);
        };
        if !context_matches_target(Some(context), &target) {
            return Err(RegisterError::TargetChanged);
        }
        if let Some(existing) = session.pending.as_ref() {
            if existing.registered_at.elapsed() < PENDING_RECLAIM_AFTER {
                return Err(RegisterError::Busy);
            }
            // The owning thread would have removed this long ago; it is gone.
            session.pending.take();
        }
        let registered_at = Instant::now();
        let expires_at_ms = frontend_expires_at_ms(SystemTime::now());
        session.pending = Some(PendingRequest {
            request_id,
            sender,
            registered_at,
            expires_at_ms,
            mutation_authorized: false,
        });
        Ok(expires_at_ms)
    }

    fn remove_pending(&self, request_id: &str) {
        let mut session = lock(&self.inner.session);
        if session
            .pending
            .as_ref()
            .is_some_and(|pending| pending.request_id == request_id)
        {
            session.pending.take();
        }
    }
}

fn frontend_expires_at_ms(now: SystemTime) -> u64 {
    unix_time_ms(now).saturating_add(FRONTEND_TIMEOUT.as_millis() as u64)
}

fn unix_time_ms(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn mutation_authorization_expired(
    expires_at_ms: u64,
    wall_now_ms: u64,
    monotonic_elapsed: Duration,
) -> bool {
    wall_now_ms.saturating_add(FRONTEND_MUTATION_SAFETY.as_millis() as u64) >= expires_at_ms
        || monotonic_elapsed >= FRONTEND_TIMEOUT.saturating_sub(FRONTEND_MUTATION_SAFETY)
}

fn wait_for_frontend(
    state: &LiveApiStateView,
    request_id: &str,
    receiver: Receiver<PendingResponse>,
) -> PendingResponse {
    match receiver.recv_timeout(FRONTEND_TIMEOUT) {
        Ok(response) => response,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            state.remove_pending(request_id);
            problem_response(
                504,
                "REQUEST_TIMEOUT",
                "Shiori did not complete the request in time",
            )
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => problem_response(
            500,
            "INTERNAL",
            "The Shiori request channel closed unexpectedly",
        ),
    }
}

#[derive(Debug)]
struct HttpProblem {
    status: u16,
    code: &'static str,
    message: &'static str,
}

impl HttpProblem {
    const fn new(status: u16, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }

    const fn invalid_request(message: &'static str) -> Self {
        Self::new(400, "INVALID_REQUEST", message)
    }

    const fn too_large(message: &'static str) -> Self {
        Self::new(413, "REQUEST_TOO_LARGE", message)
    }
}

#[derive(Debug)]
struct RequestHead {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    buffered_body: Vec<u8>,
}

impl RequestHead {
    fn has_header(&self, name: &str) -> bool {
        self.headers.iter().any(|(candidate, _)| candidate == name)
    }

    fn single_header(&self, name: &str) -> Result<Option<&str>, ()> {
        let mut matches = self
            .headers
            .iter()
            .filter(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.as_str());
        let value = matches.next();
        if matches.next().is_some() {
            Err(())
        } else {
            Ok(value)
        }
    }

    fn authorized(&self, token: &str) -> bool {
        let Ok(Some(value)) = self.single_header("authorization") else {
            return false;
        };
        let Some(candidate) = value.strip_prefix("Bearer ") else {
            return false;
        };
        constant_time_eq(candidate, token)
    }

    fn valid_host(&self, port: u16) -> bool {
        let Ok(Some(value)) = self.single_header("host") else {
            return false;
        };
        value == format!("127.0.0.1:{port}")
    }

    fn content_length(&self) -> Result<Option<usize>, ()> {
        let Some(value) = self.single_header("content-length")? else {
            return Ok(None);
        };
        if value.is_empty() || !value.as_bytes().iter().all(u8::is_ascii_digit) {
            return Err(());
        }
        value.parse::<usize>().map(Some).map_err(|_| ())
    }

    fn read_body(
        &mut self,
        stream: &mut TcpStream,
        content_length: usize,
    ) -> Result<Vec<u8>, HttpProblem> {
        if self.buffered_body.len() > content_length {
            return Err(HttpProblem::invalid_request(
                "The request contains bytes beyond Content-Length",
            ));
        }
        let mut body = std::mem::take(&mut self.buffered_body);
        body.reserve(content_length.saturating_sub(body.len()));
        let deadline = Instant::now() + BODY_TIMEOUT;
        while body.len() < content_length {
            set_remaining_read_timeout(stream, deadline)?;
            let mut chunk = [0_u8; 8192];
            let remaining = content_length - body.len();
            let chunk_len = remaining.min(chunk.len());
            let read = match stream.read(&mut chunk[..chunk_len]) {
                Ok(0) => {
                    return Err(HttpProblem::invalid_request(
                        "The request body ended before Content-Length",
                    ))
                }
                Ok(read) => read,
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                    ) =>
                {
                    return Err(HttpProblem::invalid_request("The request body timed out"))
                }
                Err(_) => {
                    return Err(HttpProblem::invalid_request(
                        "The request body could not be read",
                    ))
                }
            };
            body.extend_from_slice(&chunk[..read]);
        }
        Ok(body)
    }
}

fn read_request_head(stream: &mut TcpStream) -> Result<RequestHead, HttpProblem> {
    let deadline = Instant::now() + HEADER_TIMEOUT;
    let mut bytes = Vec::with_capacity(1024);
    let mut scan_from = 0;
    loop {
        if let Some(end) = find_header_end(&bytes, scan_from) {
            let buffered_body = bytes.split_off(end);
            bytes.truncate(end - 4);
            let mut request = parse_request_head(&bytes)?;
            request.buffered_body = buffered_body;
            return Ok(request);
        }
        // The terminator can only straddle the last 3 bytes of what was
        // already scanned; avoid rescanning the whole buffer per read.
        scan_from = bytes.len().saturating_sub(3);
        if bytes.len() >= MAX_HEADER_BYTES {
            return Err(HttpProblem::too_large(
                "The request headers exceed the size limit",
            ));
        }
        set_remaining_read_timeout(stream, deadline)?;
        let mut chunk = [0_u8; 1024];
        let remaining = MAX_HEADER_BYTES - bytes.len();
        let chunk_len = remaining.min(chunk.len());
        let read = match stream.read(&mut chunk[..chunk_len]) {
            Ok(0) => {
                return Err(HttpProblem::invalid_request(
                    "The request headers ended unexpectedly",
                ))
            }
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                return Err(HttpProblem::invalid_request(
                    "The request headers timed out",
                ))
            }
            Err(_) => {
                return Err(HttpProblem::invalid_request(
                    "The request headers could not be read",
                ))
            }
        };
        bytes.extend_from_slice(&chunk[..read]);
    }
}

fn set_remaining_read_timeout(stream: &TcpStream, deadline: Instant) -> Result<(), HttpProblem> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(HttpProblem::invalid_request("The request timed out"));
    }
    stream
        .set_read_timeout(Some(remaining))
        .map_err(|_| HttpProblem::invalid_request("The request timeout could not be set"))
}

fn find_header_end(bytes: &[u8], scan_from: usize) -> Option<usize> {
    let scan_from = scan_from.min(bytes.len());
    bytes[scan_from..]
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| scan_from + position + 4)
}

fn parse_request_head(bytes: &[u8]) -> Result<RequestHead, HttpProblem> {
    if bytes.len() > MAX_HEADER_BYTES {
        return Err(HttpProblem::too_large(
            "The request headers exceed the size limit",
        ));
    }
    if bytes.iter().any(|byte| !byte.is_ascii()) {
        return Err(HttpProblem::invalid_request(
            "The request headers are not valid ASCII",
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| HttpProblem::invalid_request("The request headers are not valid ASCII"))?;
    if text.bytes().any(|byte| byte == 0) {
        return Err(HttpProblem::invalid_request(
            "The request headers contain invalid control bytes",
        ));
    }
    let mut lines = text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| HttpProblem::invalid_request("The request line is missing"))?;
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let version = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || method.is_empty()
        || !method.bytes().all(is_header_name_byte)
        || !path.starts_with('/')
        || path.contains('#')
        || !matches!(version, "HTTP/1.0" | "HTTP/1.1")
    {
        return Err(HttpProblem::invalid_request("The request line is invalid"));
    }

    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            return Err(HttpProblem::invalid_request(
                "The request headers contain an unexpected blank line",
            ));
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            return Err(HttpProblem::invalid_request(
                "Folded request headers are not supported",
            ));
        }
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| HttpProblem::invalid_request("A request header is malformed"))?;
        if name.is_empty() || !name.bytes().all(is_header_name_byte) {
            return Err(HttpProblem::invalid_request(
                "A request header name is invalid",
            ));
        }
        let value = value.trim_matches([' ', '\t']);
        if value
            .bytes()
            .any(|byte| byte < 0x20 && byte != b'\t' || byte == 0x7f)
        {
            return Err(HttpProblem::invalid_request(
                "A request header value is invalid",
            ));
        }
        headers.push((name.to_ascii_lowercase(), value.to_string()));
    }

    Ok(RequestHead {
        method: method.to_string(),
        path: path.to_string(),
        headers,
        buffered_body: Vec::new(),
    })
}

fn is_header_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn is_json_content_type(value: &str) -> bool {
    let mut parts = value.split(';');
    if !parts
        .next()
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
    {
        return false;
    }
    parts.all(|parameter| {
        let parameter = parameter.trim();
        parameter.eq_ignore_ascii_case("charset=utf-8")
            || parameter.eq_ignore_ascii_case("charset=\"utf-8\"")
    })
}

fn write_problem(stream: &mut TcpStream, problem: HttpProblem) {
    let response = problem_response(problem.status, problem.code, problem.message);
    write_json_response(stream, response.status, &response.body);
}

struct BoundedJsonCounter {
    written: usize,
}

impl Write for BoundedJsonCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_RESPONSE_BODY_BYTES.saturating_sub(self.written) {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "Live API response exceeds the size limit",
            ));
        }
        self.written += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct BoundedJsonBuffer {
    bytes: Vec<u8>,
}

impl BoundedJsonBuffer {
    fn new() -> Self {
        Self {
            bytes: Vec::with_capacity(8 * 1024),
        }
    }
}

impl Write for BoundedJsonBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_RESPONSE_BODY_BYTES.saturating_sub(self.bytes.len()) {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "Live API response exceeds the size limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn response_body_fits(body: &Value) -> bool {
    let mut counter = BoundedJsonCounter { written: 0 };
    serde_json::to_writer(&mut counter, body).is_ok()
}

fn serialize_response_body(body: &Value) -> Result<Vec<u8>, serde_json::Error> {
    let mut buffer = BoundedJsonBuffer::new();
    serde_json::to_writer(&mut buffer, body)?;
    Ok(buffer.bytes)
}

fn write_json_response(stream: &mut TcpStream, status: u16, body: &Value) {
    let (status, bytes): (u16, Cow<'_, [u8]>) = match serialize_response_body(body) {
        Ok(bytes) => (status, Cow::Owned(bytes)),
        Err(_) => (500, Cow::Borrowed(INTERNAL_RESPONSE_FALLBACK)),
    };
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n\r\n",
        status_reason(status),
        bytes.len(),
    );
    let deadline = Instant::now() + RESPONSE_WRITE_DEADLINE;
    if write_all_with_deadline(stream, head.as_bytes(), deadline).is_ok() {
        let _ = write_all_with_deadline(stream, &bytes, deadline);
    }
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

fn write_all_with_deadline(
    stream: &mut TcpStream,
    bytes: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Live API response write deadline exceeded",
            ));
        }
        stream.set_write_timeout(Some(remaining))?;
        match stream.write(&bytes[written..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "Live API client closed the socket mid-response",
                ))
            }
            Ok(count) => written += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        417 => "Expectation Failed",
        422 => "Unprocessable Content",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Internal Server Error",
    }
}

#[cfg(test)]
mod tests {
    use super::wire::LiveApiActivePage;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static TEST_DIR_COUNTER: AtomicUsize = AtomicUsize::new(1);

    fn sha(byte: char) -> String {
        std::iter::repeat_n(byte, 64).collect()
    }

    fn context(document_id: &str, hash: &str, topology_hash: &str) -> LiveApiContext {
        LiveApiContext {
            document_id: document_id.into(),
            name: "paper.pdf".into(),
            path: Some("/tmp/paper.pdf".into()),
            sha256: hash.into(),
            page_topology_hash: topology_hash.into(),
            page_count: 3,
            active_page: Some(LiveApiActivePage {
                page: 1,
                width_pt: 612.0,
                height_pt: 792.0,
                rotation: 0,
            }),
            annotation_count: 2,
            dirty: false,
            annotations: None,
            annotations_truncated: None,
        }
    }

    fn request_head(extra: &str) -> RequestHead {
        let input = format!(
            "GET /v1/context HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nAuthorization: Bearer secret{extra}"
        );
        parse_request_head(input.as_bytes()).expect("valid request head")
    }

    fn test_dir(label: &str) -> PathBuf {
        let counter = TEST_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "shiori-live-api-{label}-{}-{counter}",
            std::process::id()
        ))
    }

    fn capture_response(status: u16, body: &Value) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let reader = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).unwrap();
            String::from_utf8(bytes).unwrap()
        });
        let mut stream = TcpStream::connect(address).unwrap();
        write_json_response(&mut stream, status, body);
        reader.join().unwrap()
    }

    #[test]
    fn parses_standard_crlf_request_and_authenticates_exact_bearer() {
        let request = request_head("");
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/v1/context");
        assert!(request.valid_host(49152));
        assert!(!request.valid_host(49153));
        assert!(request.authorized("secret"));
        assert!(!request.authorized("Secret"));
        assert_eq!(request.content_length(), Ok(None));
    }

    #[test]
    fn rejects_duplicate_authorization_and_content_length() {
        let duplicate_auth = request_head("\r\nAuthorization: Bearer secret");
        assert!(!duplicate_auth.authorized("secret"));

        let duplicate_length = request_head("\r\nContent-Length: 1\r\nContent-Length: 1");
        assert_eq!(duplicate_length.content_length(), Err(()));

        let invalid_length = request_head("\r\nContent-Length: +1");
        assert_eq!(invalid_length.content_length(), Err(()));
    }

    #[test]
    fn exposes_origin_transfer_encoding_host_and_oversize_policy_to_router() {
        let request = request_head("\r\nOrigin: https://example.com\r\nTransfer-Encoding: chunked");
        assert!(request.has_header("origin"));
        assert!(request.has_header("transfer-encoding"));
        assert!(request.valid_host(49152));

        let oversized = vec![b'a'; MAX_HEADER_BYTES + 1];
        let problem = parse_request_head(&oversized).unwrap_err();
        assert_eq!(problem.status, 413);
        assert_eq!(problem.code, "REQUEST_TOO_LARGE");
    }

    #[test]
    fn accepts_other_valid_methods_so_known_routes_can_return_405() {
        let request =
            parse_request_head(b"OPTIONS /v1/context HTTP/1.1\r\nHost: 127.0.0.1:49152").unwrap();
        assert_eq!(request.method, "OPTIONS");
    }

    #[test]
    fn json_content_type_is_narrow() {
        assert!(is_json_content_type("application/json"));
        assert!(is_json_content_type("Application/JSON; charset=\"utf-8\""));
        assert!(!is_json_content_type("text/json"));
        assert!(!is_json_content_type(
            "application/json; charset=iso-8859-1"
        ));
    }

    #[test]
    fn frontend_deadline_is_absolute_and_uses_the_native_timeout() {
        let now = UNIX_EPOCH + Duration::from_millis(1_234);
        assert_eq!(
            frontend_expires_at_ms(now),
            1_234 + FRONTEND_TIMEOUT.as_millis() as u64
        );
    }

    #[test]
    fn mutation_authorization_cutoff_is_exact_and_monotonic() {
        let cutoff = FRONTEND_TIMEOUT.saturating_sub(FRONTEND_MUTATION_SAFETY);
        assert!(!mutation_authorization_expired(
            u64::MAX,
            0,
            cutoff - Duration::from_nanos(1),
        ));
        assert!(mutation_authorization_expired(u64::MAX, 0, cutoff));
        // A rolled-back wall clock cannot extend an elapsed native slot.
        assert!(mutation_authorization_expired(
            u64::MAX,
            0,
            FRONTEND_TIMEOUT,
        ));
        assert!(!mutation_authorization_expired(
            1_501,
            1_000,
            Duration::ZERO
        ));
        assert!(mutation_authorization_expired(1_500, 1_000, Duration::ZERO));
    }

    #[test]
    fn error_completion_does_not_require_mutation_authorization() {
        let state = LiveApiState::default();
        let document_hash = sha('a');
        let topology_hash = sha('b');
        state
            .update_context(Some(context("document-1", &document_hash, &topology_hash)))
            .unwrap();
        let view = LiveApiStateView {
            inner: Arc::clone(&state.inner),
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        view.register_request(
            "request-1".into(),
            LiveApiTarget {
                document_id: "document-1".into(),
                sha256: document_hash,
                page_topology_hash: topology_hash,
            },
            sender,
        )
        .unwrap();

        state
            .complete(
                "request-1",
                LiveApiCompletionResult {
                    ok: false,
                    data: None,
                    error: Some(LiveApiResultError {
                        code: "SPEC_INVALID".into(),
                        message: "invalid spec".into(),
                        details: None,
                    }),
                },
            )
            .unwrap();
        let response = receiver.recv_timeout(Duration::from_millis(100)).unwrap();
        assert_eq!(response.status, 422);
        assert_eq!(
            state.authorize_mutation("request-1").unwrap_err(),
            "live-api-request-not-found"
        );
    }

    #[test]
    fn native_completion_rejects_results_after_either_deadline() {
        let state = LiveApiState::default();
        let document_hash = sha('a');
        let topology_hash = sha('b');
        state
            .update_context(Some(context("document-1", &document_hash, &topology_hash)))
            .unwrap();
        let view = LiveApiStateView {
            inner: Arc::clone(&state.inner),
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        view.register_request(
            "request-1".into(),
            LiveApiTarget {
                document_id: "document-1".into(),
                sha256: document_hash,
                page_topology_hash: topology_hash,
            },
            sender,
        )
        .unwrap();
        state.authorize_mutation("request-1").unwrap();

        {
            let mut session = lock(&state.inner.session);
            session.pending.as_mut().unwrap().expires_at_ms = 0;
        }
        assert_eq!(
            state.authorize_mutation("request-1").unwrap_err(),
            "live-api-request-expired"
        );
        let result = LiveApiCompletionResult {
            ok: true,
            data: Some(json!({ "added": 1 })),
            error: None,
        };
        assert_eq!(
            state.complete("request-1", result.clone()).unwrap_err(),
            "live-api-request-expired"
        );
        assert!(receiver.try_recv().is_err());

        {
            let mut session = lock(&state.inner.session);
            let pending = session.pending.as_mut().unwrap();
            pending.expires_at_ms = u64::MAX;
            pending.registered_at = Instant::now()
                .checked_sub(FRONTEND_TIMEOUT + Duration::from_secs(1))
                .unwrap();
        }
        assert_eq!(
            state.authorize_mutation("request-1").unwrap_err(),
            "live-api-request-expired"
        );
        assert_eq!(
            state.complete("request-1", result).unwrap_err(),
            "live-api-request-expired"
        );
        assert!(lock(&state.inner.session).pending.is_some());
        view.remove_pending("request-1");
    }

    #[test]
    fn maps_frontend_results_to_stable_envelopes_and_statuses() {
        let success = completion_response(LiveApiCompletionResult {
            ok: true,
            data: Some(json!({ "added": 2 })),
            error: None,
        });
        assert_eq!(success.status, 200);
        assert_eq!(success.body["schema"], LIVE_API_SCHEMA);
        assert_eq!(success.body["ok"], true);

        for (code, status) in [
            ("TARGET_CHANGED", 409),
            ("NO_PDF", 409),
            ("OPERATION_CONFLICT", 409),
            ("SPEC_INVALID", 422),
            ("APP_BUSY", 503),
            ("REQUEST_TIMEOUT", 504),
            ("INTERNAL", 500),
        ] {
            let response = completion_response(LiveApiCompletionResult {
                ok: false,
                data: None,
                error: Some(LiveApiResultError {
                    code: code.into(),
                    message: "failed".into(),
                    details: None,
                }),
            });
            assert_eq!(response.status, status, "status for {code}");
            assert_eq!(response.body["error"]["code"], code);
        }

        let invalid = completion_response(LiveApiCompletionResult {
            ok: true,
            data: None,
            error: None,
        });
        assert_eq!(invalid.status, 500);
        assert_eq!(invalid.body["error"]["code"], "INTERNAL");

        let unknown = completion_response(LiveApiCompletionResult {
            ok: false,
            data: None,
            error: Some(LiveApiResultError {
                code: "SOMETHING_NEW".into(),
                message: "failed".into(),
                details: None,
            }),
        });
        assert_eq!(unknown.status, 500);
        assert_eq!(unknown.body["error"]["code"], "INTERNAL");
    }

    #[test]
    fn completion_result_limits_error_message_and_details() {
        let boundary = completion_response(LiveApiCompletionResult {
            ok: false,
            data: None,
            error: Some(LiveApiResultError {
                code: "SPEC_INVALID".into(),
                message: "m".repeat(MAX_COMPLETION_ERROR_MESSAGE_BYTES),
                details: None,
            }),
        });
        assert_eq!(boundary.status, 422);
        assert_eq!(
            boundary.body["error"]["message"].as_str().unwrap().len(),
            MAX_COMPLETION_ERROR_MESSAGE_BYTES
        );

        let oversized_message = completion_response(LiveApiCompletionResult {
            ok: false,
            data: None,
            error: Some(LiveApiResultError {
                code: "SPEC_INVALID".into(),
                message: "m".repeat(MAX_COMPLETION_ERROR_MESSAGE_BYTES + 1),
                details: None,
            }),
        });
        assert_eq!(oversized_message.status, 500);
        assert_eq!(oversized_message.body["error"]["code"], "INTERNAL");

        let oversized_details = completion_response(LiveApiCompletionResult {
            ok: false,
            data: None,
            error: Some(LiveApiResultError {
                code: "SPEC_INVALID".into(),
                message: "failed".into(),
                details: Some(json!({ "blob": "x".repeat(MAX_RESPONSE_BODY_BYTES) })),
            }),
        });
        assert_eq!(oversized_details.status, 500);
        assert_eq!(oversized_details.body["error"]["code"], "INTERNAL");
        assert!(response_body_fits(&oversized_details.body));

        let oversized_success = completion_response(LiveApiCompletionResult {
            ok: true,
            data: Some(json!({ "blob": "x".repeat(MAX_RESPONSE_BODY_BYTES) })),
            error: None,
        });
        assert_eq!(oversized_success.status, 500);
        assert_eq!(oversized_success.body["error"]["code"], "INTERNAL");
    }

    #[test]
    fn context_change_after_emit_does_not_override_frontend_success() {
        let state = LiveApiState::default();
        let first_hash = sha('a');
        let second_hash = sha('b');
        let topology_hash = sha('c');
        state
            .update_context(Some(context("document-1", &first_hash, &topology_hash)))
            .unwrap();
        let view = LiveApiStateView {
            inner: Arc::clone(&state.inner),
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        let expires_at_ms = view
            .register_request(
                "request-1".into(),
                LiveApiTarget {
                    document_id: "document-1".into(),
                    sha256: first_hash,
                    page_topology_hash: topology_hash.clone(),
                },
                sender,
            )
            .unwrap();
        assert_eq!(
            lock(&state.inner.session)
                .pending
                .as_ref()
                .unwrap()
                .expires_at_ms,
            expires_at_ms
        );

        let success = LiveApiCompletionResult {
            ok: true,
            data: Some(json!({ "added": 1 })),
            error: None,
        };
        assert_eq!(
            state.complete("request-1", success.clone()).unwrap_err(),
            "live-api-mutation-not-authorized"
        );
        state.authorize_mutation("request-1").unwrap();

        state
            .update_context(Some(context("document-2", &second_hash, &topology_hash)))
            .unwrap();
        state.complete("request-1", success).unwrap();
        let response = receiver.recv_timeout(Duration::from_millis(100)).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body["data"]["added"], 1);
        assert!(lock(&state.inner.session).pending.is_none());
        assert_eq!(
            state.authorize_mutation("request-1").unwrap_err(),
            "live-api-request-not-found"
        );
    }

    #[test]
    fn stale_pending_slot_is_reclaimed_after_owner_death() {
        let state = LiveApiState::default();
        let hash = sha('a');
        let topology_hash = sha('c');
        state
            .update_context(Some(context("document-1", &hash, &topology_hash)))
            .unwrap();
        let view = LiveApiStateView {
            inner: Arc::clone(&state.inner),
        };
        let target = LiveApiTarget {
            document_id: "document-1".into(),
            sha256: hash,
            page_topology_hash: topology_hash,
        };
        let (sender, _receiver) = mpsc::sync_channel(1);
        view.register_request("request-1".into(), target.clone(), sender)
            .unwrap();

        // Fresh slot: still owned, second request must be rejected.
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert_eq!(
            view.register_request("request-2".into(), target.clone(), sender),
            Err(RegisterError::Busy)
        );

        // Simulate a dead owner by aging the slot past the reclaim horizon.
        {
            let mut session = lock(&state.inner.session);
            let pending = session.pending.as_mut().unwrap();
            pending.registered_at = Instant::now()
                .checked_sub(PENDING_RECLAIM_AFTER + Duration::from_secs(1))
                .expect("clock supports rewinding for the test");
        }
        let (sender, _receiver) = mpsc::sync_channel(1);
        view.register_request("request-3".into(), target, sender)
            .unwrap();
        assert_eq!(
            lock(&state.inner.session)
                .pending
                .as_ref()
                .unwrap()
                .request_id,
            "request-3"
        );
    }

    #[test]
    fn webview_destruction_clears_context_and_fails_pending() {
        let state = LiveApiState::default();
        let hash = sha('a');
        let topology_hash = sha('c');
        state
            .update_context(Some(context("document-1", &hash, &topology_hash)))
            .unwrap();
        let view = LiveApiStateView {
            inner: Arc::clone(&state.inner),
        };
        let target = LiveApiTarget {
            document_id: "document-1".into(),
            sha256: hash,
            page_topology_hash: topology_hash,
        };
        let (sender, receiver) = mpsc::sync_channel(1);
        view.register_request("request-1".into(), target.clone(), sender)
            .unwrap();

        state.on_main_webview_destroyed();

        let response = receiver.recv_timeout(Duration::from_millis(100)).unwrap();
        assert_eq!(response.status, 500);
        assert_eq!(response.body["error"]["code"], "INTERNAL");
        assert!(lock(&state.inner.session).context.is_none());
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert_eq!(
            view.register_request("request-2".into(), target, sender),
            Err(RegisterError::NoPdf)
        );
    }

    #[test]
    fn request_registration_rejects_no_pdf_wrong_target_and_parallel_request() {
        let state = LiveApiState::default();
        let view = LiveApiStateView {
            inner: Arc::clone(&state.inner),
        };
        let target = LiveApiTarget {
            document_id: "document-1".into(),
            sha256: sha('a'),
            page_topology_hash: sha('c'),
        };
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert_eq!(
            view.register_request("one".into(), target.clone(), sender),
            Err(RegisterError::NoPdf)
        );

        state
            .update_context(Some(context(
                "document-1",
                &target.sha256,
                &target.page_topology_hash,
            )))
            .unwrap();
        let wrong = LiveApiTarget {
            document_id: "document-2".into(),
            sha256: sha('b'),
            page_topology_hash: sha('d'),
        };
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert_eq!(
            view.register_request("wrong".into(), wrong, sender),
            Err(RegisterError::TargetChanged)
        );

        let wrong_topology = LiveApiTarget {
            document_id: target.document_id.clone(),
            sha256: target.sha256.clone(),
            page_topology_hash: sha('e'),
        };
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert_eq!(
            view.register_request("wrong-topology".into(), wrong_topology, sender),
            Err(RegisterError::TargetChanged)
        );

        let (sender, _receiver) = mpsc::sync_channel(1);
        view.register_request("one".into(), target.clone(), sender)
            .unwrap();
        let (sender, _receiver) = mpsc::sync_channel(1);
        assert_eq!(
            view.register_request("two".into(), target, sender),
            Err(RegisterError::Busy)
        );
    }

    #[test]
    fn descriptor_cleanup_only_removes_the_owning_token() {
        let dir = test_dir("descriptor");
        let descriptor = LiveApiDescriptor {
            schema: LIVE_API_SCHEMA.into(),
            port: 49152,
            token: "a".repeat(64),
            pid: std::process::id(),
            app_version: "0.1.26".into(),
        };
        let path = write_descriptor_atomic(&dir, &descriptor).unwrap();
        let decoded: LiveApiDescriptor = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(decoded.token, descriptor.token);
        assert_eq!(decoded.app_version, "0.1.26");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(dir.join(LIVE_API_LOCK_NAME))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }

        assert!(!cleanup_descriptor_if_owned(&path, &"b".repeat(64)).unwrap());
        assert!(path.exists());
        assert!(cleanup_descriptor_if_owned(&path, &descriptor.token).unwrap());
        assert!(!path.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn descriptor_atomic_write_replaces_stale_regular_file() {
        let dir = test_dir("replace");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(LIVE_API_DESCRIPTOR_NAME);
        fs::write(&path, b"stale").unwrap();
        let descriptor = LiveApiDescriptor {
            schema: LIVE_API_SCHEMA.into(),
            port: 49152,
            token: "c".repeat(64),
            pid: std::process::id(),
            app_version: "0.1.26".into(),
        };
        write_descriptor_atomic(&dir, &descriptor).unwrap();
        let decoded: LiveApiDescriptor = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(decoded.token, descriptor.token);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn descriptor_lock_prevents_old_cleanup_from_deleting_new_descriptor() {
        let dir = test_dir("cleanup-race");
        let descriptor_a = LiveApiDescriptor {
            schema: LIVE_API_SCHEMA.into(),
            port: 49152,
            token: "a".repeat(64),
            pid: std::process::id(),
            app_version: "0.1.26".into(),
        };
        let descriptor_b = LiveApiDescriptor {
            schema: LIVE_API_SCHEMA.into(),
            port: 49153,
            token: "b".repeat(64),
            pid: std::process::id(),
            app_version: "0.1.26".into(),
        };
        let path = write_descriptor_atomic(&dir, &descriptor_a).unwrap();

        let (verified_sender, verified_receiver) = mpsc::sync_channel(0);
        let (release_sender, release_receiver) = mpsc::sync_channel(0);
        let cleanup_dir = dir.clone();
        let cleanup_path = path.clone();
        let cleanup_token = descriptor_a.token.clone();
        let cleaner = thread::spawn(move || {
            with_descriptor_lock(&cleanup_dir, || {
                let current: LiveApiDescriptor =
                    serde_json::from_slice(&fs::read(&cleanup_path)?).map_err(io::Error::other)?;
                assert_eq!(current.token, cleanup_token);
                verified_sender.send(()).unwrap();
                release_receiver.recv().unwrap();
                cleanup_descriptor_if_owned_unlocked(&cleanup_path, &cleanup_token)
            })
        });
        verified_receiver.recv().unwrap();

        let (started_sender, started_receiver) = mpsc::sync_channel(0);
        let (written_sender, written_receiver) = mpsc::sync_channel(1);
        let writer_dir = dir.clone();
        let writer_descriptor = descriptor_b.clone();
        let writer = thread::spawn(move || {
            started_sender.send(()).unwrap();
            written_sender
                .send(write_descriptor_atomic(&writer_dir, &writer_descriptor))
                .unwrap();
        });
        started_receiver.recv().unwrap();
        assert!(matches!(
            written_receiver.recv_timeout(Duration::from_millis(75)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));

        release_sender.send(()).unwrap();
        assert!(cleaner.join().unwrap().unwrap());
        let written_path = written_receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        writer.join().unwrap();
        let current: LiveApiDescriptor =
            serde_json::from_slice(&fs::read(&written_path).unwrap()).unwrap();
        assert_eq!(current.token, descriptor_b.token);
        assert!(cleanup_descriptor_if_owned(&written_path, &descriptor_b.token).unwrap());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn descriptor_lock_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = test_dir("lock-symlink");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("target");
        fs::write(&target, b"").unwrap();
        symlink(&target, dir.join(LIVE_API_LOCK_NAME)).unwrap();
        assert!(acquire_descriptor_lock(&dir).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn random_token_is_32_bytes_of_lowercase_hex() {
        let token = random_hex(32).unwrap();
        assert_eq!(token.len(), 64);
        assert!(token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn responses_are_json_no_store_and_never_cors_or_keep_alive() {
        let response = capture_response(200, &success_envelope(json!({})));
        assert!(response.contains("Content-Type: application/json; charset=utf-8\r\n"));
        assert!(response.contains("Cache-Control: no-store\r\n"));
        assert!(response.contains("Connection: close\r\n"));
        assert!(!response.to_ascii_lowercase().contains("access-control-"));
        assert!(!response.to_ascii_lowercase().contains("keep-alive"));
    }

    #[test]
    fn response_writer_replaces_oversized_json_with_small_internal_envelope() {
        let oversized = success_envelope(json!({
            "blob": "x".repeat(MAX_RESPONSE_BODY_BYTES),
        }));
        assert!(!response_body_fits(&oversized));
        assert!(serialize_response_body(&oversized).is_err());

        let response = capture_response(200, &oversized);
        assert!(response.starts_with("HTTP/1.1 500 Internal Server Error\r\n"));
        let (_, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(body.len() < MAX_RESPONSE_BODY_BYTES);
        let body: Value = serde_json::from_str(body).unwrap();
        assert_eq!(body["schema"], LIVE_API_SCHEMA);
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"]["code"], "INTERNAL");
    }
}
