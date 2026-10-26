use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tower_http::cors::CorsLayer;

use crate::db::queries;
use crate::thumbnails;

use super::page;
use super::{ClientInfo, LanPermission, LanServerState};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

async fn auth_middleware(
    State(state): State<LanServerState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: axum::extract::Request,
    next: Next,
) -> Response {
    if let Some(allowlist) = &state.allowlist {
        if !allowlist.iter().any(|ip| ip == &addr.ip().to_string()) {
            return (StatusCode::FORBIDDEN, "IP not allowed").into_response();
        }
    }

    let token = req
        .uri()
        .query()
        .and_then(|q| url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "token"))
        .map(|(_, v)| v.into_owned());

    if token.as_deref() != Some(state.token.as_str()) {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }

    let ip = addr.ip().to_string();
    {
        let mut clients = state.clients.lock().unwrap();
        clients
            .entry(ip.clone())
            .and_modify(|c| c.last_seen = now_ms())
            .or_insert(ClientInfo {
                ip,
                connected_at: now_ms(),
                last_seen: now_ms(),
            });
    }

    next.run(req).await
}

pub fn build_router(state: LanServerState) -> Router {
    Router::new()
        .route("/", get(page::index))
        .route("/api/media", get(list_media))
        .route("/api/media/:id/thumb", get(get_thumb))
        .route("/api/media/:id/stream", get(get_stream))
        .route("/api/media/:id/download", get(get_download))
        .layer(middleware::from_fn_with_state(state.clone(), auth_middleware))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

async fn list_media(State(state): State<LanServerState>, Query(q): Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let mut query = queries::MediaQuery {
        limit: q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(200),
        offset: q.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0),
        ..Default::default()
    };
    if let Some(t) = q.get("type") {
        query.media_type = t.clone();
    }
    if let Some(s) = q.get("search") {
        query.search = Some(s.clone());
    }
    match queries::query_media(&state.pool, &query) {
        Ok(page) => Json(page).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn get_thumb(State(state): State<LanServerState>, AxumPath(id): AxumPath<i64>) -> Response {
    let Ok(Some(lookup)) = queries::get_thumb_lookup(&state.pool, id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let key = thumbnails::cache_key(&lookup.rel_path, lookup.modified_time, lookup.file_size);
    let path = thumbnails::thumbnail_path(&state.thumbcache_dir, &key);
    match tokio::fs::read(&path).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, "image/jpeg")], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// Serves the *original* file with HTTP Range support — required for
/// scrubbing/seeking in a `<video>` element (spec §22).
async fn get_stream(
    State(state): State<LanServerState>,
    AxumPath(id): AxumPath<i64>,
    headers: HeaderMap,
) -> Response {
    let Ok(Some(rel_path)) = queries::get_rel_path(&state.pool, id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Same sandbox guard as every desktop command — no divergent LAN path logic.
    let Ok(abs_path) = state.root.resolve(&rel_path) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Ok(file) = tokio::fs::File::open(&abs_path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(meta) = file.metadata().await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let total_len = meta.len();
    let mime = mime_guess::from_path(&abs_path).first_or_octet_stream();

    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    stream_range(file, total_len, mime.as_ref(), range).await
}

async fn get_download(State(state): State<LanServerState>, AxumPath(id): AxumPath<i64>) -> Response {
    if state.permission != LanPermission::Download {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(Some(rel_path)) = queries::get_rel_path(&state.pool, id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(abs_path) = state.root.resolve(&rel_path) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Ok(bytes) = tokio::fs::read(&abs_path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let filename = abs_path.file_name().and_then(|n| n.to_str()).unwrap_or("download").to_string();
    let mime = mime_guess::from_path(&abs_path).first_or_octet_stream();
    (
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\"")),
        ],
        bytes,
    )
        .into_response()
}

async fn stream_range(
    mut file: tokio::fs::File,
    total_len: u64,
    content_type: &str,
    range_header: Option<&str>,
) -> Response {
    let (start, end) = match range_header.and_then(parse_range) {
        Some((s, e)) => (s, e.min(total_len.saturating_sub(1))),
        None => (0, total_len.saturating_sub(1)),
    };
    if start > end || start >= total_len {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    }
    let chunk_len = end - start + 1;

    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let limited = file.take(chunk_len);
    let stream = tokio_util::io::ReaderStream::new(limited);
    let body = Body::from_stream(stream);

    let status = if range_header.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, chunk_len.to_string())
        .header(header::ACCEPT_RANGES, "bytes");
    if range_header.is_some() {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total_len}"));
    }
    response.body(body).unwrap().into_response()
}

fn parse_range(header: &str) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (start_s, end_s) = spec.split_once('-')?;
    let start: u64 = start_s.parse().ok()?;
    let end: u64 = if end_s.is_empty() { u64::MAX } else { end_s.parse().ok()? };
    Some((start, end))
}
