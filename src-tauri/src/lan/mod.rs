//! Optional LAN gallery server (spec §22). Off by default. Shares the
//! same SQLite-backed query layer and filesystem sandbox as the desktop
//! app — never a separate, divergent implementation of path safety.
//!
//! Scoped down from the full spec: a bespoke lightweight web UI (not the
//! full Tauri/React app — that relies on Tauri IPC a plain browser
//! doesn't have) serving View and Download permission levels. "Edit"
//! over LAN is not implemented (routing the whole editor surface through
//! HTTP too is a materially larger undertaking than this pass covers).
//! Session expiry is server-lifetime (stop the server to revoke every
//! token) rather than per-session idle timeout.

pub mod page;
pub mod routes;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::net::TcpListener;

use crate::db::Pool;
use crate::fs_sandbox::GalleryRoot;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LanPermission {
    View,
    Download,
}

#[derive(Clone, Debug, Serialize)]
pub struct ClientInfo {
    pub ip: String,
    pub connected_at: i64,
    pub last_seen: i64,
}

#[derive(Clone)]
pub struct LanServerState {
    pub pool: Pool,
    pub root: GalleryRoot,
    pub thumbcache_dir: std::path::PathBuf,
    pub token: String,
    pub permission: LanPermission,
    pub allowlist: Option<Vec<String>>,
    pub clients: Arc<Mutex<HashMap<String, ClientInfo>>>,
}

pub struct LanServerHandle {
    pub addr: SocketAddr,
    pub token: String,
    pub state: LanServerState,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl LanServerHandle {
    pub fn stop(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

pub fn generate_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Lists non-loopback IPv4 interfaces a phone/laptop on the same LAN
/// could actually reach.
pub fn list_lan_addresses() -> Vec<String> {
    let mut out = vec![];
    if let Ok(ip) = local_ip_address::local_ip() {
        out.push(ip.to_string());
    }
    if let Ok(ifas) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in ifas {
            if ip.is_ipv4() && !ip.is_loopback() {
                let s = ip.to_string();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
    out
}

pub async fn start(
    bind_ip: std::net::IpAddr,
    port: u16,
    state: LanServerState,
) -> anyhow::Result<LanServerHandle> {
    let app = routes::build_router(state.clone());
    let listener = TcpListener::bind(SocketAddr::new(bind_ip, port)).await?;
    let addr = listener.local_addr()?;

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>());

    tauri::async_runtime::spawn(async move {
        let graceful = server.with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        let _ = graceful.await;
    });

    Ok(LanServerHandle {
        addr,
        token: state.token.clone(),
        state,
        shutdown_tx: Some(shutdown_tx),
    })
}
