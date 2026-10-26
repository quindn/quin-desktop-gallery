//! Background thumbnail scheduling: bounded concurrency, two priority
//! lanes, and dedup so the same media item is never generated twice
//! concurrently. This is what actually fixes "thumbnail scanning is slow"
//! — previously every visible grid card triggered its own synchronous
//! decode on the calling command, one at a time, with no prefetch. Now:
//!
//! - `request()` (on-demand, a card just scrolled into view) always jumps
//!   the line ahead of `sweep()` (background warm-the-whole-folder work),
//!   via a biased `select!` between a high/low priority channel pair.
//! - Up to `concurrency` jobs run at once (photo decodes via
//!   `spawn_blocking`, video frame grabs via the async FFmpeg sidecar),
//!   instead of one IPC round trip fully serializing the next.
//! - Results are pushed to the frontend via a `thumbnail://ready` /
//!   `thumbnail://failed` event rather than making the caller wait, so a
//!   command that misses the cache returns immediately.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Semaphore};

use crate::db::{queries, Pool};

#[derive(Debug, Clone)]
pub struct ThumbJob {
    pub media_id: i64,
    pub abs_path: PathBuf,
    pub media_type: String, // "photo" | "video"
    pub cache_dir: PathBuf,
    pub key: String,
    pub duration_ms: Option<i64>,
    pub pool: Pool,
}

#[derive(Clone)]
pub struct ThumbnailQueue {
    high_tx: mpsc::Sender<ThumbJob>,
    low_tx: mpsc::Sender<ThumbJob>,
    in_flight: Arc<Mutex<HashSet<i64>>>,
}

impl ThumbnailQueue {
    pub fn start(app: AppHandle, concurrency: usize) -> Self {
        let (high_tx, mut high_rx) = mpsc::channel::<ThumbJob>(2048);
        let (low_tx, mut low_rx) = mpsc::channel::<ThumbJob>(16384);
        let in_flight = Arc::new(Mutex::new(HashSet::new()));
        let semaphore = Arc::new(Semaphore::new(concurrency.max(1)));

        {
            let in_flight = Arc::clone(&in_flight);
            tauri::async_runtime::spawn(async move {
                loop {
                    let job = tokio::select! {
                        biased;
                        Some(j) = high_rx.recv() => j,
                        Some(j) = low_rx.recv() => j,
                        else => break,
                    };
                    let Ok(permit) = Arc::clone(&semaphore).acquire_owned().await else {
                        break;
                    };
                    let app = app.clone();
                    let in_flight = Arc::clone(&in_flight);
                    tauri::async_runtime::spawn(async move {
                        process_job(&app, &job).await;
                        in_flight.lock().unwrap().remove(&job.media_id);
                        drop(permit);
                    });
                }
            });
        }

        Self {
            high_tx,
            low_tx,
            in_flight,
        }
    }

    /// On-demand: a card just became visible. High priority.
    pub fn request(&self, job: ThumbJob) {
        self.enqueue(&self.high_tx, job);
    }

    /// Background sweeps use backpressure instead of dropping jobs when
    /// the bounded channel is full. On-demand requests stay on the
    /// non-blocking high-priority path above.
    pub async fn sweep_wait(&self, job: ThumbJob) {
        {
            let mut set = self.in_flight.lock().unwrap();
            if !set.insert(job.media_id) {
                return;
            }
        }
        if self.low_tx.send(job.clone()).await.is_err() {
            self.in_flight.lock().unwrap().remove(&job.media_id);
        }
    }

    fn enqueue(&self, tx: &mpsc::Sender<ThumbJob>, job: ThumbJob) {
        {
            let mut set = self.in_flight.lock().unwrap();
            if !set.insert(job.media_id) {
                return; // already queued or being generated
            }
        }
        if tx.try_send(job.clone()).is_err() {
            // Queue momentarily full (huge sweep + heavy on-demand burst) —
            // drop it; the next scroll/sweep pass will re-request it.
            self.in_flight.lock().unwrap().remove(&job.media_id);
        }
    }
}

async fn process_job(app: &AppHandle, job: &ThumbJob) {
    let result = if job.media_type == "video" {
        super::ensure_video_thumbnail(app, &job.abs_path, &job.cache_dir, &job.key, job.duration_ms)
            .await
    } else {
        let abs_path = job.abs_path.clone();
        let cache_dir = job.cache_dir.clone();
        let key = job.key.clone();
        tokio::task::spawn_blocking(move || super::ensure_photo_thumbnail(&abs_path, &cache_dir, &key))
            .await
            .unwrap_or_else(|e| Err(anyhow::anyhow!(e)))
    };

    match result {
        Ok(path) => {
            let _ = queries::mark_thumbnail_ready(&job.pool, job.media_id, &job.key);
            let _ = app.emit(
                "thumbnail://ready",
                serde_json::json!({ "id": job.media_id, "path": path.to_string_lossy() }),
            );
        }
        Err(_) => {
            let _ = queries::mark_thumbnail_failed(&job.pool, job.media_id);
            let _ = app.emit("thumbnail://failed", serde_json::json!({ "id": job.media_id }));
        }
    }
}
