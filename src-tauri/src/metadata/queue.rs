//! Background video metadata probing (duration, codecs, dimensions — see
//! MEDIA_PIPELINE.md's layered strategy). Two separate concurrency pools,
//! not one shared one: the fast ffprobe header pass is cheap and runs with
//! real parallelism, while the slow deep-scan pass (full frame-count
//! decode, only needed for files whose header lies about duration) runs
//! in a small pool of its own. Sharing one pool between them meant a
//! handful of slow files could occupy every worker slot for seconds at a
//! time, stalling the fast pass for every other file behind them in
//! line — this was the main reason a scan "felt slow" even when almost
//! everything in it was cheap to probe.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Semaphore};

use super::probe::{self, VideoProbe};
use crate::db::{queries, Pool};

#[derive(Debug, Clone)]
pub struct MetadataJob {
    pub media_id: i64,
    pub abs_path: PathBuf,
    pub pool: Pool,
    pub deep_only: bool,
}

#[derive(Clone)]
pub struct MetadataQueue {
    fast_tx: mpsc::Sender<MetadataJob>,
    deep_tx: mpsc::Sender<MetadataJob>,
    in_flight: Arc<Mutex<HashSet<i64>>>,
}

impl MetadataQueue {
    /// `fast_concurrency` sizes the header-probe pool; the deep-scan pool
    /// is intentionally small and fixed regardless (it's CPU/IO-heavy per
    /// job in a way that doesn't benefit from scaling with core count the
    /// same way — a handful of them running at once is already enough to
    /// keep the slow tail moving without competing hard with everything
    /// else on the machine).
    pub fn start(app: AppHandle, fast_concurrency: usize) -> Self {
        let (fast_tx, mut fast_rx) = mpsc::channel::<MetadataJob>(16384);
        let (deep_tx, mut deep_rx) = mpsc::channel::<MetadataJob>(4096);
        let in_flight = Arc::new(Mutex::new(HashSet::new()));
        let fast_semaphore = Arc::new(Semaphore::new(fast_concurrency.max(1)));
        let deep_semaphore = Arc::new(Semaphore::new(2));

        {
            let in_flight = Arc::clone(&in_flight);
            let deep_semaphore = Arc::clone(&deep_semaphore);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(job) = fast_rx.recv().await {
                    let Ok(fast_permit) = Arc::clone(&fast_semaphore).acquire_owned().await else {
                        break;
                    };
                    let app = app.clone();
                    let in_flight = Arc::clone(&in_flight);
                    let deep_semaphore = Arc::clone(&deep_semaphore);
                    tauri::async_runtime::spawn(async move {
                        let needs_deep = process_fast(&app, &job).await;
                        // Release the fast slot immediately rather than
                        // holding it through a deep scan — that's the
                        // whole point of the split.
                        drop(fast_permit);
                        if needs_deep {
                            if let Ok(deep_permit) = deep_semaphore.acquire_owned().await {
                                process_deep_duration(&app, &job).await;
                                drop(deep_permit);
                            }
                        }
                        in_flight.lock().unwrap().remove(&job.media_id);
                    });
                }
            });
        }

        {
            let in_flight = Arc::clone(&in_flight);
            tauri::async_runtime::spawn(async move {
                while let Some(job) = deep_rx.recv().await {
                    let Ok(deep_permit) = Arc::clone(&deep_semaphore).acquire_owned().await else {
                        break;
                    };
                    let app = app.clone();
                    let in_flight = Arc::clone(&in_flight);
                    tauri::async_runtime::spawn(async move {
                        process_deep_duration(&app, &job).await;
                        in_flight.lock().unwrap().remove(&job.media_id);
                        drop(deep_permit);
                    });
                }
            });
        }

        Self {
            fast_tx,
            deep_tx,
            in_flight,
        }
    }

    pub fn enqueue(&self, job: MetadataJob) {
        {
            let mut set = self.in_flight.lock().unwrap();
            if !set.insert(job.media_id) {
                return;
            }
        }
        let tx = if job.deep_only { &self.deep_tx } else { &self.fast_tx };
        if tx.try_send(job.clone()).is_err() {
            self.in_flight.lock().unwrap().remove(&job.media_id);
        }
    }

    pub async fn enqueue_wait(&self, job: MetadataJob) {
        {
            let mut set = self.in_flight.lock().unwrap();
            if !set.insert(job.media_id) {
                return;
            }
        }
        let tx = if job.deep_only {
            self.deep_tx.clone()
        } else {
            self.fast_tx.clone()
        };
        if tx.send(job.clone()).await.is_err() {
            self.in_flight.lock().unwrap().remove(&job.media_id);
        }
    }
}

/// Stages 1-2 (fast header probe). Returns whether a deep scan is still
/// needed — the caller decides whether/when to actually run one.
async fn process_fast(app: &AppHandle, job: &MetadataJob) -> bool {
    let probed = probe::probe_video(app, &job.abs_path).await;
    let Ok(p) = probed else {
        let _ = queries::mark_metadata_needs_deep_scan(&job.pool, job.media_id);
        let _ = app.emit(
            "metadata://ready",
            serde_json::json!({
                "id": job.media_id,
                "duration_ms": null,
                "metadata_state": "needs_deep_scan",
            }),
        );
        return true;
    };
    let needs_deep = p.needs_deep_scan;
    apply_and_emit(app, job, &p);
    needs_deep
}

async fn process_deep_duration(app: &AppHandle, job: &MetadataJob) {
    let duration = match probe::deep_probe_duration(app, &job.abs_path).await {
        Ok(Some(ms)) if ms > 0 => Some(ms),
        _ => match probe::decode_probe_duration(app, &job.abs_path).await {
            Ok(Some(ms)) if ms > 0 => Some(ms),
            _ => None,
        },
    };

    if let Some(ms) = duration {
        let _ = queries::apply_video_duration(&job.pool, job.media_id, ms);
        let _ = app.emit(
            "metadata://ready",
            serde_json::json!({
                "id": job.media_id,
                "duration_ms": ms,
                "metadata_state": "ok",
            }),
        );
    } else {
        let _ = queries::mark_metadata_failed(&job.pool, job.media_id);
        let _ = app.emit("metadata://failed", serde_json::json!({ "id": job.media_id }));
    }
}

fn apply_and_emit(app: &AppHandle, job: &MetadataJob, p: &VideoProbe) {
    let update = queries::VideoMetadataUpdate {
        duration_ms: p.duration_ms,
        width: p.width,
        height: p.height,
        fps: p.fps,
        video_codec: p.video_codec.clone(),
        audio_codec: p.audio_codec.clone(),
        bitrate: p.bitrate,
        sample_rate: p.sample_rate,
        channels: p.channels,
        container: p.container.clone(),
        pixel_format: p.pixel_format.clone(),
        has_audio: p.has_audio,
        rotation: p.rotation,
        needs_deep_scan: p.needs_deep_scan,
    };
    let _ = queries::apply_video_metadata(&job.pool, job.media_id, &update);
    let _ = app.emit(
        "metadata://ready",
        serde_json::json!({
            "id": job.media_id,
            "duration_ms": p.duration_ms,
            "width": p.width,
            "height": p.height,
            "metadata_state": if p.needs_deep_scan { "needs_deep_scan" } else { "ok" },
        }),
    );
}
