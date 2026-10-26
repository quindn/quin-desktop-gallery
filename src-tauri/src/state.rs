use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::db::Pool;
use crate::fs_sandbox::GalleryRoot;
use crate::lan::LanServerHandle;
use crate::metadata::queue::MetadataQueue;
use crate::scanner::watcher::WatchHandle;
use crate::thumbnails::queue::ThumbnailQueue;

/// Each running edit job's cancel flag. `cancel_edit_job` flips it; the job's
/// worker notices, kills its FFmpeg children and cleans up.
pub type EditJobRegistry = Arc<Mutex<HashMap<String, crate::editor::runner::Cancel>>>;

/// Everything that depends on which Gallery Root is currently open. Held
/// behind `AppState.current` and swapped wholesale on Change Root (the
/// old `WatchHandle` drops, which stops the previous watcher).
pub struct RootContext {
    pub root: GalleryRoot,
    pub id: String,
    pub pool: Pool,
    pub watch: Option<WatchHandle>,
}

pub struct AppState {
    pub app_db: Pool,
    pub app_local_data_dir: PathBuf,
    pub current: Mutex<Option<RootContext>>,
    pub thumbnail_queue: ThumbnailQueue,
    pub metadata_queue: MetadataQueue,
    pub edit_jobs: EditJobRegistry,
    pub lan: Mutex<Option<LanServerHandle>>,
}

impl AppState {
    /// Namespaced per root (see MEDIA_PIPELINE.md) so cache keys can never
    /// collide across two different libraries.
    pub fn thumbcache_dir(&self, root_id: &str) -> PathBuf {
        self.app_local_data_dir.join("thumbcache").join(root_id)
    }

    /// Disposable playback-fallback output (remuxed/transcoded copies) —
    /// separate from the thumbnail cache and never mistaken for an
    /// editing export. See VIDEO_PLAYBACK.md.
    pub fn playcache_dir(&self, root_id: &str) -> PathBuf {
        self.app_local_data_dir.join("playcache").join(root_id)
    }

    /// Scratch space for in-progress edit jobs (temp output before the
    /// atomic rename to its final destination). Swept on startup by
    /// `startup::cleanup_abandoned_temp_files`.
    pub fn edit_temp_dir(&self) -> PathBuf {
        self.app_local_data_dir.join("edit_temp")
    }
}
