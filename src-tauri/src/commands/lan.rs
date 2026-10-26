use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::lan::{self, ClientInfo, LanPermission, LanServerState};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
pub struct LanStatus {
    pub running: bool,
    pub url: Option<String>,
    pub token: Option<String>,
    pub permission: Option<String>,
    pub connected_clients: Vec<ClientInfo>,
}

#[tauri::command(async)]
pub fn list_lan_interfaces() -> Vec<String> {
    lan::list_lan_addresses()
}

#[derive(Debug, Deserialize)]
pub struct StartLanArgs {
    pub bind_ip: String,
    pub port: Option<u16>,
    pub permission: String, // "view" | "download"
    pub allowlist: Option<Vec<String>>,
}

#[tauri::command]
pub async fn start_lan_server(state: State<'_, AppState>, args: StartLanArgs) -> Result<LanStatus, String> {
    {
        let existing = state.lan.lock().unwrap().take();
        if let Some(h) = existing {
            h.stop();
        }
    }

    let (pool, root, root_id) = {
        let current = state.current.lock().unwrap();
        let ctx = current.as_ref().ok_or("no root open")?;
        (ctx.pool.clone(), ctx.root.clone(), ctx.id.clone())
    };

    let bind_ip: std::net::IpAddr = args.bind_ip.parse().map_err(|_| "invalid bind address".to_string())?;
    let permission = if args.permission == "download" {
        LanPermission::Download
    } else {
        LanPermission::View
    };

    let lan_state = LanServerState {
        pool,
        root,
        thumbcache_dir: state.thumbcache_dir(&root_id),
        token: lan::generate_token(),
        permission,
        allowlist: args.allowlist.filter(|v| !v.is_empty()),
        clients: Default::default(),
    };

    let handle = lan::start(bind_ip, args.port.unwrap_or(0), lan_state)
        .await
        .map_err(|e| e.to_string())?;

    let status = status_from_handle(&handle);
    *state.lan.lock().unwrap() = Some(handle);
    Ok(status)
}

#[tauri::command(async)]
pub fn stop_lan_server(state: State<AppState>) -> Result<(), String> {
    if let Some(h) = state.lan.lock().unwrap().take() {
        h.stop();
    }
    Ok(())
}

#[tauri::command(async)]
pub fn get_lan_status(state: State<AppState>) -> Result<LanStatus, String> {
    let guard = state.lan.lock().unwrap();
    Ok(match guard.as_ref() {
        Some(h) => status_from_handle(h),
        None => LanStatus {
            running: false,
            url: None,
            token: None,
            permission: None,
            connected_clients: vec![],
        },
    })
}

fn status_from_handle(h: &crate::lan::LanServerHandle) -> LanStatus {
    let clients: Vec<ClientInfo> = h.state.clients.lock().unwrap().values().cloned().collect();
    LanStatus {
        running: true,
        url: Some(format!("http://{}:{}/?token={}", h.addr.ip(), h.addr.port(), h.token)),
        token: Some(h.token.clone()),
        permission: Some(match h.state.permission {
            LanPermission::View => "view".to_string(),
            LanPermission::Download => "download".to_string(),
        }),
        connected_clients: clients,
    }
}

#[tauri::command(async)]
pub fn get_lan_qr_code(url: String) -> Result<String, String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let image = code.render::<image::Luma<u8>>().max_dimensions(320, 320).build();
    let mut png_bytes: Vec<u8> = Vec::new();
    image::DynamicImage::ImageLuma8(image)
        .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}
