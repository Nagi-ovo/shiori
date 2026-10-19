//! Desktop page rendering on shiori-core (PDFium), stage 3 of
//! docs/PLAN-RUST-PDF-CORE-2026-09.md.
//!
//! One render thread owns every open document: PDFium is not thread-safe,
//! and a shiori-core `Document` may only be called from the thread that owns
//! it. Commands hand it messages and wait for the reply off the async runtime.
//! Tiles on screen outrank the page backdrop, which outranks thumbnails, so a
//! batch of thumbnails never holds up what the reader is looking at; a tile
//! the reader scrolled past is cancelled by its ticket before it is drawn.
//!
//! PDFium is bound on the first open, not at startup: an app whose PDFium is
//! missing still starts, and every open fails with the reason.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};

use shiori_core::{AnnotationKey, Core, Document, RenderRequest};

type Reply<T> = mpsc::Sender<Result<T, String>>;

enum Message {
    Open {
        bytes: Vec<u8>,
        password: Option<String>,
        reply: Reply<u32>,
    },
    Close {
        doc: u32,
    },
    Hide {
        doc: u32,
        page: u32,
        keys: Vec<AnnotationKey>,
        reply: Reply<u32>,
    },
    Render(RenderJob),
    /// Any other read of one document, run on the render thread.
    Read {
        doc: u32,
        job: Box<dyn FnOnce(Option<&Document>) + Send>,
    },
}

pub struct RenderJob {
    pub doc: u32,
    pub page: u32,
    pub request: RenderRequest,
    /// 0 = a tile on screen, 1 = the page backdrop, 2 = a thumbnail.
    pub priority: u8,
    pub ticket: u64,
    reply: Reply<Vec<u8>>,
    /// Arrival order, so equal priorities draw first come, first served.
    seq: u64,
}

impl PartialEq for RenderJob {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for RenderJob {}
impl PartialOrd for RenderJob {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for RenderJob {
    // BinaryHeap pops the greatest: lower priority numbers and earlier
    // arrivals compare greater.
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .priority
            .cmp(&self.priority)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}

pub struct PdfCoreService {
    tx: Mutex<mpsc::Sender<Message>>,
    cancelled: Arc<Mutex<HashSet<u64>>>,
}

impl PdfCoreService {
    /// Starts the render thread. `library_dirs` are tried in order for the
    /// PDFium library on the first open.
    pub fn start(library_dirs: Vec<PathBuf>) -> Self {
        let (tx, rx) = mpsc::channel();
        let cancelled = Arc::new(Mutex::new(HashSet::new()));
        let thread_cancelled = Arc::clone(&cancelled);
        std::thread::Builder::new()
            .name("shiori-pdf-core".into())
            .spawn(move || run(rx, thread_cancelled, library_dirs))
            .expect("spawn the PDF render thread");
        PdfCoreService {
            tx: Mutex::new(tx),
            cancelled,
        }
    }

    fn send(&self, message: Message) -> Result<(), String> {
        self.tx
            .lock()
            .map_err(|_| "pdf-core-unavailable".to_string())?
            .send(message)
            .map_err(|_| "pdf-core-unavailable".to_string())
    }

    pub async fn open(&self, bytes: Vec<u8>, password: Option<String>) -> Result<u32, String> {
        let (reply, rx) = mpsc::channel();
        self.send(Message::Open {
            bytes,
            password,
            reply,
        })?;
        wait(rx).await
    }

    pub fn close(&self, doc: u32) -> Result<(), String> {
        self.send(Message::Close { doc })
    }

    pub async fn hide_annotations(
        &self,
        doc: u32,
        page: u32,
        keys: Vec<AnnotationKey>,
    ) -> Result<u32, String> {
        let (reply, rx) = mpsc::channel();
        self.send(Message::Hide {
            doc,
            page,
            keys,
            reply,
        })?;
        wait(rx).await
    }

    pub async fn render(
        &self,
        doc: u32,
        page: u32,
        request: RenderRequest,
        priority: u8,
        ticket: u64,
    ) -> Result<Vec<u8>, String> {
        let (reply, rx) = mpsc::channel();
        self.send(Message::Render(RenderJob {
            doc,
            page,
            request,
            priority,
            ticket,
            reply,
            seq: 0,
        }))?;
        wait(rx).await
    }

    /// Runs `read` against a document on the render thread.
    pub async fn read<T: Send + 'static>(
        &self,
        doc: u32,
        read: impl FnOnce(&Document) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (reply, rx) = mpsc::channel();
        self.send(Message::Read {
            doc,
            job: Box::new(move |document| {
                let result = match document {
                    Some(document) => read(document),
                    None => Err("pdf-core-closed".into()),
                };
                let _ = reply.send(result);
            }),
        })?;
        wait(rx).await
    }

    /// Drops these tickets' renders if they have not started.
    pub fn cancel(&self, tickets: &[u64]) {
        if let Ok(mut cancelled) = self.cancelled.lock() {
            cancelled.extend(tickets.iter().copied());
        }
    }
}

async fn wait<T: Send + 'static>(rx: mpsc::Receiver<Result<T, String>>) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .unwrap_or_else(|_| Err("pdf-core-unavailable".into()))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The render thread: owns PDFium and every document.
fn run(rx: mpsc::Receiver<Message>, cancelled: Arc<Mutex<HashSet<u64>>>, dirs: Vec<PathBuf>) {
    let mut core: Option<Core> = None;
    let mut docs: HashMap<u32, Document> = HashMap::new();
    let mut next_doc: u32 = 1;
    let mut queue: BinaryHeap<RenderJob> = BinaryHeap::new();
    let mut seq: u64 = 0;

    loop {
        // Wait when idle; otherwise take whatever has arrived, so a tile sent
        // after a batch of thumbnails still goes first.
        let first = if queue.is_empty() {
            match rx.recv() {
                Ok(message) => Some(message),
                Err(_) => return,
            }
        } else {
            None
        };
        for message in first
            .into_iter()
            .chain(std::iter::from_fn(|| rx.try_recv().ok()))
        {
            match message {
                Message::Open {
                    bytes,
                    password,
                    reply,
                } => {
                    let result = bind(&mut core, &dirs).and_then(|core| {
                        core.open(bytes, password.as_deref())
                            .map_err(|error| error.to_string())
                    });
                    let _ = reply.send(result.map(|doc| {
                        let id = next_doc;
                        next_doc = next_doc.wrapping_add(1).max(1);
                        docs.insert(id, doc);
                        id
                    }));
                }
                Message::Close { doc } => {
                    docs.remove(&doc);
                }
                Message::Hide {
                    doc,
                    page,
                    keys,
                    reply,
                } => {
                    let result = docs
                        .get(&doc)
                        .ok_or_else(|| "pdf-core-closed".to_string())
                        .and_then(|d| d.hide_annotations(page, &keys).map_err(|e| e.to_string()));
                    let _ = reply.send(result);
                }
                Message::Read { doc, job } => job(docs.get(&doc)),
                Message::Render(mut job) => {
                    job.seq = seq;
                    seq += 1;
                    queue.push(job);
                }
            }
        }
        let Some(job) = queue.pop() else { continue };
        let skip = cancelled
            .lock()
            .map(|mut set| set.remove(&job.ticket))
            .unwrap_or(false);
        let result = if skip {
            Err("cancelled".to_string())
        } else {
            docs.get(&job.doc)
                .ok_or_else(|| "pdf-core-closed".to_string())
                .and_then(|d| d.render(job.page, job.request).map_err(|e| e.to_string()))
        };
        let _ = job.reply.send(result);
        if queue.is_empty() {
            // Nothing is waiting: any ticket still marked was cancelled after
            // its render finished.
            if let Ok(mut set) = cancelled.lock() {
                set.clear();
            }
        }
    }
}

fn bind<'a>(core: &'a mut Option<Core>, dirs: &[PathBuf]) -> Result<&'a Core, String> {
    if core.is_none() {
        let name = pdfium_library_name();
        let dir = dirs
            .iter()
            .find(|dir| dir.join(name).is_file())
            .ok_or_else(|| format!("pdfium-missing: {name} not in {dirs:?}"))?;
        *core = Some(Core::bind(dir).map_err(|error| error.to_string())?);
    }
    Ok(core.as_ref().expect("bound above"))
}

pub fn pdfium_library_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "pdfium.dll"
    } else if cfg!(target_os = "macos") {
        "libpdfium.dylib"
    } else {
        "libpdfium.so"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(priority: u8, seq: u64) -> RenderJob {
        let (reply, _rx) = mpsc::channel();
        RenderJob {
            doc: 1,
            page: 0,
            request: RenderRequest {
                rotation: 0,
                pixels_per_point: 1.0,
                x: 0,
                y: 0,
                width: 1,
                height: 1,
                annotations: true,
            },
            priority,
            ticket: seq,
            reply,
            seq,
        }
    }

    #[test]
    fn tiles_on_screen_draw_before_backdrops_and_thumbnails_then_in_arrival_order() {
        let mut queue = BinaryHeap::new();
        // Thumbnails queued first, a backdrop, then two on-screen tiles.
        for (priority, seq) in [(2, 0), (2, 1), (1, 2), (0, 3), (0, 4)] {
            queue.push(job(priority, seq));
        }
        let order: Vec<u64> = std::iter::from_fn(|| queue.pop().map(|j| j.seq)).collect();
        assert_eq!(order, [3, 4, 2, 0, 1]);
    }
}
