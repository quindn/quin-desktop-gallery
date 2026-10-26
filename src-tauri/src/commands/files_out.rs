//! Getting library files out of the app the way a file manager does: drag them onto a web page,
//! a chat, Explorer or another app (a real OS drag of the files), or copy them (Ctrl+C) and paste
//! them anywhere files can be pasted.

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::db::queries;
use crate::state::AppState;

/// Absolute paths of these media rows (missing files are left out), and the thumbnail of the first.
fn resolve(state: &State<AppState>, ids: &[i64]) -> Result<(Vec<PathBuf>, Option<PathBuf>), String> {
    let current = state.current.lock().unwrap();
    let ctx = current.as_ref().ok_or("no root open")?;
    let mut paths = vec![];
    let mut thumb = None;
    for id in ids.iter().take(500) {
        let Ok(Some(lookup)) = queries::get_thumb_lookup(&ctx.pool, *id) else { continue };
        let Ok(abs) = ctx.root.resolve(&lookup.rel_path) else { continue };
        if thumb.is_none() {
            let key = crate::thumbnails::cache_key(&lookup.rel_path, lookup.modified_time, lookup.file_size);
            let p = crate::thumbnails::thumbnail_path(&state.thumbcache_dir(&ctx.id), &key);
            if p.exists() {
                thumb = Some(p);
            }
        }
        paths.push(abs);
    }
    if paths.is_empty() {
        return Err("none of these files exist any more".into());
    }
    Ok((paths, thumb))
}

/// The picture under the cursor while dragging: the first file's thumbnail (a fanned stack for
/// several files), as PNG.
fn drag_image(thumb: Option<&PathBuf>, count: usize) -> Vec<u8> {
    const W: u32 = 128;
    let base = thumb
        .and_then(|p| image::open(p).ok())
        .map(|i| i.thumbnail(W, W).to_rgba8())
        .unwrap_or_else(|| image::RgbaImage::from_pixel(96, 72, image::Rgba([90, 100, 200, 230])));
    let layers = count.clamp(1, 3) as u32;
    let off = 6;
    let mut canvas = image::RgbaImage::new(base.width() + off * (layers - 1), base.height() + off * (layers - 1));
    for l in (0..layers).rev() {
        let mut layer = base.clone();
        if l > 0 {
            for px in layer.pixels_mut() {
                px.0 = [px.0[0] / 2, px.0[1] / 2, px.0[2] / 2, 220];
            }
        }
        image::imageops::overlay(&mut canvas, &layer, (off * l) as i64, (off * (layers - 1 - l)) as i64);
    }
    let mut out = std::io::Cursor::new(Vec::new());
    let _ = image::DynamicImage::ImageRgba8(canvas).write_to(&mut out, image::ImageFormat::Png);
    out.into_inner()
}

/// Starts a real OS drag of these files from where the pointer is (the mouse button must still be
/// down). Returns once the drag ends: "dropped" or "cancelled".
#[tauri::command]
pub async fn start_file_drag(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> Result<String, String> {
    let (paths, thumb) = resolve(&state, &ids)?;
    let png = drag_image(thumb.as_ref(), paths.len());
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    // OLE drag and drop has to run on the window's own (UI) thread.
    app.run_on_main_thread(move || {
        let done = move |result: drag::DragResult, _pos: drag::CursorPosition| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(if matches!(result, drag::DragResult::Dropped) { "dropped".into() } else { "cancelled".into() });
            }
        };
        if let Err(e) = drag::start_drag(&window, drag::DragItem::Files(paths), drag::Image::Raw(png), done, drag::Options::default()) {
            eprintln!("[drag] could not start: {e}");
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(rx.await.unwrap_or_else(|_| "cancelled".into()))
}

/// Puts these files on the clipboard as files (what Explorer's Copy does), so they can be pasted
/// into Explorer, an upload box, a chat… Returns how many were copied.
#[tauri::command]
pub fn copy_files_to_clipboard(state: State<AppState>, ids: Vec<i64>) -> Result<usize, String> {
    let (paths, _) = resolve(&state, &ids)?;
    set_clipboard_files(&paths)?;
    Ok(paths.len())
}

#[cfg(windows)]
fn set_clipboard_files(paths: &[PathBuf]) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
    use windows::Win32::UI::Shell::DROPFILES;

    const CF_HDROP: u32 = 15;
    // DROPFILES header, then the paths as UTF-16, each NUL-terminated, the list ending in a 2nd NUL
    let mut wide: Vec<u16> = vec![];
    for p in paths {
        wide.extend(p.as_os_str().encode_wide());
        wide.push(0);
    }
    wide.push(0);
    let header = std::mem::size_of::<DROPFILES>();
    let bytes = header + wide.len() * 2;
    unsafe {
        let mem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes).map_err(|e| e.to_string())?;
        let ptr = GlobalLock(mem) as *mut u8;
        if ptr.is_null() {
            let _ = GlobalFree(Some(mem));
            return Err("could not lock clipboard memory".into());
        }
        let df = ptr as *mut DROPFILES;
        (*df).pFiles = header as u32;
        (*df).fWide = true.into();
        std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr.add(header), wide.len() * 2);
        let _ = GlobalUnlock(mem);

        // another app may hold the clipboard for a moment
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        if !opened {
            let _ = GlobalFree(Some(mem));
            return Err("the clipboard is busy".into());
        }
        let _ = EmptyClipboard();
        let r = SetClipboardData(CF_HDROP, Some(HANDLE(mem.0)));
        let _ = CloseClipboard();
        if let Err(e) = r {
            let _ = GlobalFree(Some(mem));
            return Err(e.to_string());
        }
        // the clipboard owns the memory now
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_clipboard_files(_paths: &[PathBuf]) -> Result<(), String> {
    Err("copying files is only supported on Windows".into())
}

/// The files on the clipboard as paths (to check a copy in tests and diagnostics).
#[cfg(windows)]
pub fn clipboard_files() -> Vec<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    let mut out = vec![];
    unsafe {
        if OpenClipboard(None).is_err() {
            return out;
        }
        if let Ok(h) = GetClipboardData(15) {
            let hdrop = HDROP(h.0);
            let n = DragQueryFileW(hdrop, u32::MAX, None);
            for i in 0..n {
                let len = DragQueryFileW(hdrop, i, None) as usize;
                let mut buf = vec![0u16; len + 1];
                DragQueryFileW(hdrop, i, Some(&mut buf));
                out.push(PathBuf::from(std::ffi::OsString::from_wide(&buf[..len])));
            }
        }
        let _ = CloseClipboard();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_picture_is_made_with_or_without_a_thumbnail() {
        let png = drag_image(None, 3);
        let img = image::load_from_memory(&png).unwrap();
        assert!(img.width() > 96 && img.height() > 72, "a fanned stack for several files");
    }

    #[cfg(windows)]
    #[test]
    fn files_copied_to_the_clipboard_can_be_read_back_as_files() {
        let dir = std::env::temp_dir().join(format!("qg-clip-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a b.mp4");
        let b = dir.join("ảnh.jpg");
        std::fs::write(&a, b"1").unwrap();
        std::fs::write(&b, b"2").unwrap();
        set_clipboard_files(&[a.clone(), b.clone()]).unwrap();
        assert_eq!(clipboard_files(), vec![a, b]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
