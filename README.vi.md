# Quin Desktop Gallery

**Tiếng Việt** · [English](README.md) · Tải bản mới nhất: [Releases](https://github.com/quindn/quin-desktop-gallery/releases/latest)

Ứng dụng Windows **quản lý thư viện ảnh/video cục bộ**, kèm trình phát video, trình sửa video, **Studio dựng video kiểu CapCut**, **AI làm mượt / làm nét video**, trình duyệt chặn quảng cáo có bắt và tải video, mở link (YouTube, TikTok, m3u8…) và chia sẻ qua mạng LAN.

Viết bằng **Tauri 2 (Rust) + React/TypeScript + SQLite**. Bản phát hành là **một file exe duy nhất**: FFmpeg, FFprobe, yt-dlp và uBlock Origin được nén sẵn bên trong, lần chạy đầu tự giải nén. **Mọi dữ liệu nằm trong thư mục `data\` cạnh file exe**, nên copy thư mục là mang app đi được.

> Tài liệu này dành cho người (và cho các phiên làm việc AI sau) cần **sửa hoặc thêm tính năng**. Quy tắc làm việc dành cho trợ lý AI nằm trong [`AGENTS.md`](AGENTS.md) (Claude Code đọc qua [`CLAUDE.md`](CLAUDE.md)).

Tên ứng dụng khi chạy là **Quin Gallery** (`productName` trong `tauri.conf.json`). Tên repo và dự án là **Quin Desktop Gallery**.

---

## Mục lục

1. [Tính năng](#1-tính-năng)
2. [Công nghệ](#2-công-nghệ)
3. [Cài đặt và chạy thử](#3-cài-đặt-và-chạy-thử)
4. [Build bản phát hành](#4-build-bản-phát-hành)
5. [Cấu trúc thư mục](#5-cấu-trúc-thư-mục)
6. [Kiến trúc](#6-kiến-trúc)
7. [Thư mục `data\`](#7-thư-mục-data)
8. [Kiểm thử](#8-kiểm-thử)
9. [Cách thêm và sửa tính năng](#9-cách-thêm-và-sửa-tính-năng)
10. [Lưu ý và cạm bẫy đã gặp](#10-lưu-ý-và-cạm-bẫy-đã-gặp)
11. [Tài liệu thiết kế khác](#11-tài-liệu-thiết-kế-khác)
12. [Bên thứ ba và giấy phép](#12-bên-thứ-ba-và-giấy-phép)

---

## 1. Tính năng

### Thư viện

- Chọn một thư mục gốc (Gallery Root). App chỉ index những gì nằm trong thư mục đó.
- Lưới ảo hoá (Grid / Dense / List / Timeline), phân trang có nhảy trang, cây thư mục có ô tìm, tag, favorite, chấm sao, tìm file trùng.
- Sắp xếp theo tên, ngày, dung lượng, thời lượng, và *Similar Names* (các file tên giống nhau đứng cạnh nhau, đánh số tự nhiên).
- **Luôn giữ vị trí:** khi đổi folder, bộ lọc, Favorites, cách sắp xếp, số mục mỗi trang hay đóng viewer, app mở đúng trang có file đang chọn (hoặc file gần nhất nếu file đó đã bị lọc ra), thay vì quay về trang 1.
- **Theo dõi thư mục trực tiếp:** thêm, đổi tên, di chuyển hay xoá file/folder được cập nhật sau khoảng 0,3–0,5 s. App chỉ đọc đúng file thay đổi; file đang copy dở được chờ copy xong. Những gì thay đổi lúc app tắt sẽ được quét bù sau khi mở.
- **Kéo file ra ngoài** (thả vào web, chat, Explorer), Ctrl+C để copy chính file, Ctrl+A để chọn cả trang.
- **Khởi động nhanh** (thư viện 102 nghìn file: vào trang chính khoảng 0,6 s sau khi mở khoá). Tự phục hồi khi app crash: đọc lại `data\roots\` để mở lại thư viện cũ, DB hỏng thì tự dựng lại và giữ bản hỏng làm `*.corrupt-<thời gian>`.
- **Khoá màn hình** bằng mật khẩu do chủ máy tự đặt:
  - Lần chạy đầu, app yêu cầu chọn mật khẩu. Sau đó đổi được trong Settings → Lock password.
  - Chỉ lưu băm PBKDF2-SHA256 có salt trong `data\lock.json`, **không có mật khẩu nào trong code**.
  - Xoá `lock.json` thì app quay về bước "chọn mật khẩu".
  - App khoá mỗi lần mở và mỗi lần ẩn xuống khay hệ thống.

### Thanh tìm kiếm kiểu Windows 11 Explorer

Logic nằm ở `src-tauri/src/db/search.rs`, giao diện ở `src/components/SearchBox.tsx`.

- Nhiều từ không cần đúng thứ tự, khớp cả tên file lẫn tên folder, **không cần gõ dấu** (`dang` tìm ra "Đặng").
- `"cụm từ"` để tìm nguyên cụm, `-từ` để loại trừ, `a OR b`, ký tự đại diện `*` `?` (`IMG_*.jpg`, `*.mov`).
- Bộ lọc:

  | Nhóm | Cú pháp |
  |---|---|
  | Loại, đuôi file | `kind:video`, `ext:mp4,mov` |
  | Dung lượng | `size:>100mb`, `size:1gb..4gb`, `size:large` |
  | Ngày | `date:thisweek`, `date:2024-05`, `date:17/5/2025`, `created:`, `taken:` |
  | Video | `duration:>10m`, `duration:long`, `res:4k`, `res:>=1080p`, `width:` / `height:` |
  | Đánh dấu | `is:fav`, `is:portrait`, `rating:>=3`, `tag:` |
  | Phạm vi | `name:`, `folder:` |

- **Ô gợi ý thả xuống:**
  - chip cho biết câu tìm được hiểu thế nào, kèm tổng số kết quả;
  - file khớp có ảnh nhỏ và tô đậm phần khớp; bấm (hoặc ↓ + Enter) là mở luôn;
  - folder khớp;
  - Tab để hoàn thành bộ lọc;
  - danh sách tìm gần đây và bộ lọc nhanh; nút `?` mở bảng hướng dẫn.
- Khi đang mở một folder, ô tìm chỉ tìm trong folder đó (nhãn "in <folder> ✕").
- Phím tắt: Ctrl+F, Ctrl+E hoặc F3 để vào ô tìm. Esc lần đầu đóng gợi ý, lần hai xoá ô tìm.
- **Tốc độ:** cột `media.search_key` lưu sẵn đường dẫn đã bỏ dấu và viết thường. Trên 100 nghìn file mỗi lần tìm mất khoảng 20–40 ms.

### Xem video và ảnh (Viewer)

- Video phát qua máy chủ HTTP nội bộ có hỗ trợ byte-range, nên tua nhanh và mở được file lớn. Trình phát tự viết: thanh tua có vùng đã tải và thời gian khi rê chuột, tốc độ, lặp, PiP, toàn màn hình.
- Phím: ← / → **chỉ tua** (kể cả khi đang tải). ↑ / ↓ / PageUp / PageDown chuyển file, đi tiếp sang trang sau hoặc về trang trước khi hết trang.
- **Phím favorite nhanh:** mặc định Enter, đổi được trong Settings → Playback.
- Settings → "Reopening a video": tiếp tục chỗ đang xem dở hoặc luôn phát từ đầu.
- Nút **This folder**: chỉ hiện các file cùng folder với file đang xem.
- Nút **AI ✦**: mở hộp thoại AI Enhance.

### Trình sửa video (Editor, trong viewer)

- Timeline có dải khung hình, gõ thời gian ở mọi ô ("1:23.5", "83.5", "1m23s").
- Giữ nhiều đoạn (Split, Delete, Add part), cắt bỏ hoặc chỉ giữ một khoảng (`[` `]` `X`), xuất các đoạn thành nhiều file riêng.
- Fast Cut (không nén lại) hoặc Accurate Cut (chính xác từng khung).
- Crop tự do, xoay/lật, đổi kích thước, tốc độ, màu, tắt tiếng, xoá watermark, ping-pong (phát xuôi rồi ngược). Tất cả trong một bảng, xuất một lần.

### Studio — dựng video kiểu CapCut

Giao diện ở `src/components/Studio.tsx`, phần render ở `src-tauri/src/editor/studio.rs`.

- Thanh bên → "Studio (video editor)", hoặc chuột phải vào file → "Add to Studio".
- Timeline nhiều track: video/ảnh, chữ, nhạc. Kéo đổi thứ tự, kéo mép để cắt, gõ thời gian, Split (S), Delete, Duplicate (Ctrl+D), Undo/Redo (Ctrl+Z / Ctrl+Y).
- Mỗi clip có tốc độ, âm lượng, tắt tiếng, Fit/Fill, độ sáng, độ tương phản, độ bão hoà. Có 14 kiểu chuyển cảnh (xfade).
- Chữ: vị trí kéo thả trên khung xem trước, cỡ chữ, màu, nền tối. Nhạc: thời điểm bắt đầu, độ dài, âm lượng, fade in/out.
- Khung hình 16:9, 9:16, 1:1, 4:3, 3:4; độ phân giải 720p–4K; 24–60 fps.
- Project tự lưu dạng JSON trong `data\projects\`. Export ra `<thư viện>\Quin Studio\<tên>.mp4` (H.264 + AAC).

### AI Enhance

Logic nằm ở `src-tauri/src/ai.rs`.

- **Mượt hơn:** RIFE 4.26 (Best) hoặc 4.6 (Faster) tạo khung hình trung gian thật, ×2 / ×3 / ×4 fps.
- **Nét hơn:** Real-ESRGAN, model General x4 v3 cho video quay thật, animevideov3 x2 cho anime. Giữ nguyên kích thước hoặc phóng to 2× (tối đa 4K).
- Tool là bản ncnn/Vulkan chạy trên card đồ hoạ, **tải khi dùng lần đầu** vào `data\bin\ai\`. App chỉ tải đúng các file cần từ zip phát hành bằng HTTP range request.
- Video được xử lý theo từng đoạn (chunk) dưới dạng PNG trong thư mục tạm nên tốn ít ổ đĩa. Kết quả đi qua một lần encode FFmpeg, giữ âm thanh gốc, và lưu thành file mới cạnh file gốc (`<tên> (60 fps).mp4`, `<tên> (AI 2x).mp4`).

### Online

- **Open a Link:** file trực tiếp, HLS `.m3u8`, DASH `.mpd`, RTMP/RTSP, và khoảng 1800 trang qua yt-dlp. Chọn chất lượng, chỉ tải âm thanh, tải về có tiến độ, kiểm tra file sau khi tải.
- **Browser** (engine WebView2/Chromium):
  - tab, bookmark, lịch sử, profile riêng biệt (Profile Manager), tab ẩn danh;
  - uBlock Origin có sẵn, cài thêm extension từ Chrome Web Store;
  - bắt video trong trang (sniffer + agent chạy trong mọi frame), popup liệt kê và tải media, lớp phủ "Quin Player" lên trình phát của trang.
- **LAN Sharing:** máy chủ web nội bộ, có mã QR để xem thư viện từ điện thoại.

> Không có tích hợp Google Photos. Đã quyết định **không** dùng API riêng / không chính thức của Google Photos (cookie phiên). Nếu làm, chỉ dùng **Google Photos Picker API** chính thức, và cần OAuth Client ID của chủ app.

---

## 2. Công nghệ

| Phần | Công nghệ |
|---|---|
| Vỏ desktop | Tauri **2.11.5** (WebView2), Rust stable (đang dùng 1.98), toolchain MSVC |
| Giao diện | React 19, TypeScript 6, Vite 8, Tailwind CSS 4, zustand 5, @tanstack/react-virtual |
| Cơ sở dữ liệu | SQLite qua `rusqlite` (bundled, có hàm tự định nghĩa `qg_fold`), pool `r2d2`, chế độ WAL |
| Theo dõi thư mục | `notify` 7 + `notify-debouncer-full` |
| Máy chủ nội bộ | `axum` 0.7 trên 127.0.0.1 (stream file `/f/<token>`, proxy `/p`, pipe FFmpeg `/s`) |
| Media | FFmpeg / FFprobe n9.0 (bản BtbN GPL), yt-dlp, crate `image` |
| AI | rife-ncnn-vulkan (bản fork TNTwise, 2025-01-12), realesrgan-ncnn-vulkan v0.2.5.0 |
| Kéo thả / clipboard | crate `drag` (OLE DoDragDrop), Win32 CF_HDROP (`windows` 0.61) |

---

## 3. Cài đặt và chạy thử

### Cần có

- Windows 10/11 có **WebView2 Runtime** (hầu như máy nào cũng có sẵn).
- **Node.js 18+** (đang dùng 24), **Rust stable** với toolchain MSVC, và **Visual Studio Build Tools** (workload *Desktop development with C++*). Xem [hướng dẫn của Tauri](https://tauri.app/start/prerequisites/).
- Git, và tuỳ chọn GitHub Desktop.

### Các bước

```powershell
git clone https://github.com/quindn/quin-desktop-gallery.git
cd quin-desktop-gallery
npm install

# Tải FFmpeg, FFprobe, yt-dlp vào src-tauri\bin\ (khoảng 350 MB, không có trong git)
powershell -ExecutionPolicy Bypass -File scripts/fetch-tools.ps1
#   (hoặc trong Git Bash: bash scripts/fetch-ffmpeg.sh)

npm run tauri dev          # chạy bản dev, có hot-reload cho giao diện
```

- uBlock Origin (`src-tauri/resources/ublock-origin.zip`) **đã có trong git**.
- Thiếu file trong `src-tauri\bin\` thì app vẫn build được, nhưng lúc chạy sẽ tìm công cụ trên PATH.
- Lần build đầu tiên mất vài phút vì `build.rs` phải nén khoảng 350 MB công cụ. Bản nén được cache trong `src-tauri/.packed/`.
- Lần chạy đầu, app hỏi mật khẩu khoá màn hình mới. Mật khẩu này lưu dạng băm trong `data\lock.json`.

---

## 4. Build bản phát hành

```powershell
npx tauri build                # exe + bộ cài NSIS + MSI
#   src-tauri\target\release\quin-gallery.exe                                     ← bản portable (1 file)
#   src-tauri\target\release\bundle\nsis\Quin Gallery_1.0.0_x64-setup.exe          ← bộ cài
npx tauri build --no-bundle    # chỉ build exe (nhanh hơn)
powershell -File scripts/make-portable.ps1   # copy exe thành "Quin Gallery.exe"
```

Quy ước giao bản hiện tại (trên máy chủ dự án):

- `Desktop\Quin Gallery\Quin Gallery.exe`: chép đè bằng `quin-gallery.exe`. **Giữ nguyên thư mục `Desktop\Quin Gallery\data`.**
- `Desktop\Quin-Gallery-1.0.0-setup.exe`: bộ cài NSIS.

Release build mất khoảng 10–15 phút: bước tối ưu crate chính là bước lâu nhất.

**Đăng bản lên GitHub Releases** (cần `gh` đã đăng nhập):

```powershell
Copy-Item src-tauri\target\release\quin-gallery.exe "$env:TEMP\Quin-Gallery-<phiên-bản>-portable.exe"
gh release create v<phiên-bản> "$env:TEMP\Quin-Gallery-<phiên-bản>-portable.exe" "src-tauri\target\release\bundle\nsis\Quin Gallery_<phiên-bản>_x64-setup.exe" --title "Quin Desktop Gallery <phiên-bản>" --notes "…"
```

Phiên bản nằm ở 3 chỗ, phải sửa cùng lúc: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.

---

## 5. Cấu trúc thư mục

```
Quin Power/
├─ README.md (English), README.vi.md (Tiếng Việt)
├─ AGENTS.md, CLAUDE.md              ← quy tắc cho trợ lý AI (CLAUDE.md nạp AGENTS.md)
├─ ARCHITECTURE.md, DATABASE_SCHEMA.md, MEDIA_PIPELINE.md, VIDEO_PLAYBACK.md,
│  LAN_SERVER.md, UI_SPEC.md, ROADMAP.md   ← tài liệu thiết kế gốc (code có trỏ tới các mục §)
├─ index.html, vite.config.ts, tsconfig*.json, package.json
├─ public/logo.png
├─ scripts/
│  ├─ fetch-tools.ps1 / fetch-ffmpeg.sh   ← tải FFmpeg / FFprobe / yt-dlp vào src-tauri/bin
│  ├─ make-portable.ps1                   ← copy exe thành "Quin Gallery.exe"
│  └─ make-backdrops.py                   ← tạo ảnh nền cửa sổ
├─ src/                                 ← GIAO DIỆN (React)
│  ├─ App.tsx                            ← khung app: khoá màn hình, onboarding, điều hướng các view
│  ├─ components/
│  │  ├─ Sidebar.tsx, Toolbar.tsx, SearchBox.tsx, FilterPanel.tsx, SettingsPanel.tsx
│  │  ├─ GalleryGrid.tsx                 ← lưới / phân trang / giữ vị trí / mở viewer / phím tắt
│  │  ├─ MediaCard.tsx, ListRow.tsx, ListHeader.tsx, ContextMenu.tsx
│  │  ├─ Viewer.tsx, VideoPlayer.tsx     ← xem ảnh / video
│  │  ├─ EditorPanel.tsx, EditorTimeline.tsx, CropOverlay.tsx   ← trình sửa video
│  │  ├─ Studio.tsx                      ← Studio (CapCut)
│  │  ├─ EnhanceDialog.tsx               ← AI Enhance
│  │  ├─ BrowserView.tsx, BrowserPanels.tsx, ProfileManager.tsx, NewTabPage.tsx
│  │  ├─ OnlineView.tsx, DownloadsView.tsx, LanPanel.tsx, DuplicateFinderPanel.tsx
│  │  └─ Dashboard.tsx, LockScreen.tsx, Onboarding.tsx, TitleBar.tsx, RainOverlay.tsx
│  ├─ lib/
│  │  ├─ api.ts                          ← wrapper gọi lệnh Rust (invoke) + kiểu dữ liệu chung
│  │  ├─ studio.ts, ai.ts, online.ts     ← kiểu + wrapper của Studio / AI / Online
│  │  └─ timecode.ts, format.ts, seek.ts, fileDrag.ts, clipboard.ts
│  └─ stores/                            ← zustand: galleryStore (view, folder, bộ lọc, query),
│                                          settingsStore (localStorage "qpg.*"), thumbnailStore, rootStore,
│                                          lockStore, themeStore, webStores (browser / downloads)
├─ src-tauri/                           ← BACKEND (Rust)
│  ├─ Cargo.toml, tauri.conf.json, build.rs (nén + nhúng công cụ), icons/, resources/ublock-origin.zip
│  ├─ bin/        (KHÔNG có trong git)   ← ffmpeg / ffprobe / yt-dlp "<tool>-x86_64-pc-windows-msvc.exe"
│  └─ src/
│     ├─ lib.rs                          ← khởi tạo app, state, khay hệ thống, ĐĂNG KÝ MỌI LỆNH (generate_handler!)
│     ├─ paths.rs                        ← thư mục data\ (QG_DATA_DIR ghi đè được)
│     ├─ tools.rs                        ← giải nén FFmpeg / yt-dlp đã nhúng vào data\bin\<build-id>\
│     ├─ state.rs, startup.rs            ← AppState; dấu crash (.running), dọn file tạm
│     ├─ commands/                       ← các lệnh Tauri mà giao diện gọi, chia theo nhóm:
│     │   root, media, actions, files_out, editor, studio, ai, playback, settings, tags,
│     │   duplicates, lan, online, browser, lock (mật khẩu → data\lock.json)
│     ├─ db/
│     │   mod.rs (pool, migration, open_with_repair), library.rs, app.rs,
│     │   queries.rs (MediaQuery → SQL, phân trang, vị trí), search.rs (ngôn ngữ tìm kiếm),
│     │   name_key.rs (Similar Names), migrations/*.sql
│     ├─ scanner/ (mod.rs quét, watcher.rs theo dõi), metadata/ (ffprobe, hàng đợi),
│     │   thumbnails/ (hàng đợi ảnh nhỏ), duplicates/, transcode/
│     ├─ editor/  mod.rs, job.rs, pipeline.rs, runner.rs (chạy FFmpeg + tiến độ + huỷ),
│     │           studio.rs (dựng lệnh FFmpeg cho Studio), watermark.rs, inpaint.rs
│     ├─ ai.rs                           ← tải tool AI + pipeline RIFE / Real-ESRGAN
│     ├─ online/  server.rs (máy chủ HTTP nội bộ), resolve.rs (yt-dlp), download.rs
│     ├─ browser/ trình duyệt nhúng: profile, extension, sniffer, agent*.js chèn vào trang
│     ├─ lan/     máy chủ LAN + trang web
│     └─ fs_sandbox/  chặn truy cập ngoài thư mục gốc
└─ tests-e2e/                           ← kiểm thử đầu-cuối chạy app thật (xem mục 8)
```

---

## 6. Kiến trúc

```
 Thư mục ảnh/video ──► scanner (quét lần đầu / quét bù) ──┐
        │                                                ├──► SQLite library.db (data\roots\<id>\)
        └──► watcher (notify, áp từng thay đổi) ─────────┘          │
                                                                    │  queries.rs / search.rs
 metadata queue (ffprobe) ─► cập nhật cột, phát "metadata://ready"  │
 thumbnail queue ─► data\thumbcache\, phát sự kiện thumb            ▼
                                                    commands/*.rs  (#[tauri::command])
                                                                    │  invoke()
                                                                    ▼
                                         React: stores (zustand) ◄─► components
 Video: máy chủ axum 127.0.0.1 (/f/<token> có Range) ──► <video> trong Viewer / Studio
 Editor / Studio / AI: dựng lệnh FFmpeg (+ tool AI) ─► chạy nền ─► "edit://progress", "edit://done"
```

- **Một lệnh = một hàm Rust** có `#[tauri::command]`, đăng ký trong `src-tauri/src/lib.rs`, và được gọi từ `src/lib/*.ts` qua `invoke("tên_lệnh", { tham_số })`. Tauri tự đổi tên tham số camelCase ↔ snake_case. Struct trả về có `#[serde(rename_all = "camelCase")]` hoặc được map lại trong `api.ts` (`mapMediaItem`, `queryToRaw`).
- **Truy vấn thư viện:** giao diện dựng `MediaQuery` bằng `galleryStore.buildQuery()`. Rust `queries::build_where()` chuyển nó thành SQL; ô tìm kiếm đi qua `search::compile()`.
- **Tác vụ dài** (export, AI) trả về `jobId` ngay, chạy ở luồng nền, phát sự kiện `edit://progress` / `edit://done`, và huỷ bằng `cancel_edit_job` (registry `AppState.edit_jobs`).
- **Video cục bộ** không dùng `asset://` (lỗi với file lớn). Dùng `get_media_stream_url(id)`, trả về URL `http://127.0.0.1:<port>/f/<token>`.

---

## 7. Thư mục `data\`

Mọi thứ đều nằm cạnh exe (`paths.rs`). App chỉ dùng `%LOCALAPPDATA%` khi thư mục đó không ghi được. Biến môi trường `QG_DATA_DIR` đổi được vị trí; các bài test dùng cách này.

| Đường dẫn | Nội dung |
|---|---|
| `data\app.db` | danh sách thư viện gần đây, cài đặt chung |
| `data\lock.json` | băm mật khẩu khoá màn hình (PBKDF2-SHA256, salt, 100k vòng) |
| `data\roots\<id>\library.db` | index của từng thư viện. Mỗi file tự ghi đường dẫn thư mục gốc, nên app khôi phục được kể cả khi mất `app.db` |
| `data\thumbcache\`, `data\playcache\` | ảnh nhỏ, bản chuyển mã để phát |
| `data\bin\<build-id>\` | FFmpeg / FFprobe / yt-dlp / extension, giải nén từ exe. Bản cũ tự xoá khi đổi build |
| `data\bin\ai\` | RIFE / Real-ESRGAN tải khi dùng lần đầu (**không bị xoá** khi cập nhật app) |
| `data\projects\` | project Studio (`<id>.json`) |
| `data\exports\`, `data\edit_temp\` | file xuất khi không mở thư viện nào; file tạm của editor / AI |
| `data\webview\` | dữ liệu WebView của cửa sổ chính |
| `data\browser\` | profile trình duyệt, extension, bookmark, lịch sử |
| `data\crash.log` | log khi app panic |

Cài đặt giao diện (phím tua, phím favorite, resume, số mục mỗi trang, hiệu ứng mưa…) nằm trong `localStorage` của WebView, khoá `qpg.*` (`src/stores/settingsStore.ts`).

---

## 8. Kiểm thử

### Rust (unit + tích hợp)

```powershell
cd src-tauri
cargo test --lib                                   # khoảng 130 bài, khoảng 1 phút
cargo test --lib db::search                        # chỉ phần tìm kiếm (có bài đo tốc độ 100 nghìn dòng)
cargo test --release --lib db::search::tests::fast -- --nocapture
cargo test --lib ai::tests::real -- --ignored --nocapture   # tải tool AI thật + chạy mọi chế độ (cần mạng + GPU Vulkan)
```

Các bài test editor dùng FFmpeg thật trong `src-tauri/bin`, và tự bỏ qua nếu không có.

### E2E (chạy app thật qua DevTools Protocol)

Chi tiết trong [`tests-e2e/README.md`](tests-e2e/README.md). Các bài test dùng thư mục dữ liệu tạm riêng, không đụng `data\` thật.

```powershell
npx tauri build --debug --no-bundle               # hoặc dùng bản release
powershell -File tests-e2e/run_all.ps1            # bản release
powershell -File tests-e2e/run_all.ps1 src-tauri\target\debug\quin-gallery.exe
node tests-e2e/e2e_search.mjs <exe> <thư-mục-ảnh-chụp>   # chạy riêng một bộ
```

| Bộ | Nội dung |
|---|---|
| `e2e_lock` (11) | chọn mật khẩu lần đầu, chỉ lưu băm, sai thì không mở, đổi mật khẩu trong Settings |
| `e2e_features` (26) | kéo file ra, Ctrl+C/A, giữ vị trí, stream / tua / resume video, cắt khoảng |
| `e2e_timeline` (25) | timeline editor, gõ thời gian, các đoạn, preview, export |
| `e2e_watch` (17) | theo dõi thư mục, khôi phục DB hỏng, dựng lại sau crash |
| `e2e_viewer_studio` (39) | phím favorite, resume bật/tắt, Next qua trang, "This folder", Studio, AI Enhance |
| `e2e_search` (29) | toàn bộ thanh tìm kiếm |

- Bài kéo thả **dùng chuột thật** (`os_input.ps1`), nên đừng đụng máy khi đang chạy. Nếu màn hình đang khoá, bài đó báo SKIP.
- `qg_harness.mjs` cung cấp: `spawnApp` (tự tạo hoặc nhập mật khẩu test `TEST_PASSWORD = "qg-e2e-pass"` trên thư mục data tạm), `openRoot`, `waitScanned`, `clickText`, `main.key/click/drag/typeText/shot`, `invoke`, `probe`, `makeVideo`.

---

## 9. Cách thêm và sửa tính năng

### Thêm một lệnh backend mới

1. Viết hàm trong `src-tauri/src/commands/<nhóm>.rs`:
   ```rust
   #[tauri::command(async)]
   pub fn my_command(state: State<AppState>, id: i64) -> Result<MyResult, String> { ... }
   ```
   Hàm đồng bộ mà tốn thời gian thì dùng `(async)`. Hàm `async fn` nhận `State<'_, AppState>`.
2. Nhóm mới thì thêm `pub mod <nhóm>;` vào `commands/mod.rs`.
3. **Đăng ký** trong `src-tauri/src/lib.rs` → `tauri::generate_handler![ ..., commands::<nhóm>::my_command ]`.
4. Viết wrapper trong `src/lib/api.ts` (hoặc file lib riêng): `export const myCommand = (id: number) => invoke<MyResult>("my_command", { id });`
5. Kiểm tra: `npx tsc --noEmit` và `cd src-tauri && cargo build`.

### Thêm cột hoặc bảng trong DB thư viện

- Thêm cột: thêm `("tên_cột", "KIỂU")` vào danh sách `required` trong `db/library.rs::repair_legacy_media_columns`. Cách này an toàn với DB cũ và không cần migration.
- Thay đổi lớn hơn (bảng, index): tạo `db/migrations/library_000N_<tên>.sql` rồi thêm vào `LIBRARY_MIGRATIONS` trong `db/mod.rs`, **chỉ thêm vào cuối, không sửa file cũ**.
- Lưu ý: DB mới tạo bảng `media` từ `library_0001_init.sql` *sau* bước sửa cột. Thứ gì phải có ngay thì thêm cả trong init, hoặc kiểm tra bằng `pragma_table_info` như `search::prepare_schema`.
- Cập nhật `DATABASE_SCHEMA.md`.

### Thêm bộ lọc hoặc cú pháp cho thanh tìm kiếm

1. `src-tauri/src/db/search.rs` → `field_cond()`: thêm nhánh `"tên_trường" => ...`, trả về `Cond { sql, params, label, kind }`. Thêm tên vào `KNOWN` để giá trị sai được báo là "not understood".
2. Thêm test vào `explorer_filters` (CSDL trong bộ nhớ có sẵn), chạy `cargo test --lib db::search`.
3. Thêm gợi ý vào `FIELDS` (và `HELP` / `QUICK` nếu muốn) trong `src/components/SearchBox.tsx`.
4. Thêm một bước vào `tests-e2e/e2e_search.mjs`.

### Thêm cài đặt (Settings)

`src/stores/settingsStore.ts`: thêm khoá `qpg.<tên>`, giá trị bằng `loadBool/loadNumber/loadString`, và một setter có lưu `localStorage`. Giao diện thêm vào `src/components/SettingsPanel.tsx`, gắn `data-testid` để test.

### Thêm màn hình mới ở thanh bên

1. Thêm giá trị vào `MainView` trong `src/stores/galleryStore.ts`.
2. Thêm `<Row>` trong `src/components/Sidebar.tsx`.
3. Thêm nhánh hiển thị trong `src/App.tsx`.

### Thêm mục chuột phải

`src/components/ContextMenu.tsx`. Hành động liên quan đến grid được truyền qua props từ `GalleryGrid.tsx`, ví dụ `onShowFolder`, `onCopyFiles`.

### Studio

- Kiểu dữ liệu phải **giống nhau ở hai phía**: `src-tauri/src/editor/studio.rs` (serde camelCase) và `src/lib/studio.ts`.
- Quy tắc độ dài clip và transition (`clipLen`, `transitionMs`, `layout`) cũng phải khớp với hàm render `build()`.
- Hiệu ứng mới = thêm filter FFmpeg trong `build()`, kèm preview CSS tương ứng trong `Studio.tsx`.

### AI

- Đổi model hoặc nguồn tải: `files_for()` trong `ai.rs`.
- Pipeline nằm trong `run()`: giải mã thành RGB, chia chunk PNG, chạy tool, đọc PNG rồi đẩy sang encoder.
- Bài test thật: `ai::tests::real` (xem mục 8).

### Quy trình nên theo cho mỗi thay đổi

1. Viết checklist những việc cần làm.
2. Sửa hết.
3. `npx tsc --noEmit` và `cargo test --lib`.
4. Build debug, chạy e2e liên quan. Tính năng mới thì thêm bài e2e.
5. Chỉ lặp lại những phần còn lỗi.
6. Build release, chạy `run_all.ps1` trên bản release.
7. Giao bản (mục 4).

---

## 10. Lưu ý và cạm bẫy đã gặp

- **Máy chạy qua Parsec (khoảng 32 Hz).** Cảm giác "lag" cần **đo** trước khi tối ưu. Lần trước thủ phạm là hiệu ứng mưa, không phải dung lượng exe.
- `tools.rs` dọn các thư mục build cũ trong `data\bin\`, **chỉ xoá thư mục tên 12 ký tự hex** (để không xoá `data\bin\ai`).
- FFmpeg n9 **đã bỏ `-vsync`**, phải dùng `-fps_mode`. `drawtext` cần `expansion=none` (chữ có `%` sẽ lỗi) và `textfile=` cho chữ Unicode.
- RIFE: **không đổi tên thư mục model** (exe nhận kiến trúc model qua tên thư mục). Mã thoát (exit code) không đáng tin, nên **luôn đếm số khung hình đầu ra**. Real-ESRGAN: `-s` phải khớp scale gốc của model; không có chế độ CPU.
- GitHub (máy chủ file) **không nhận range dạng `bytes=-N`**. Phải hỏi kích thước bằng `bytes=0-0` trước.
- Tham số `MediaQuery` từ giao diện đi qua `queryToRaw()` (snake_case). Gọi `invoke("get_media_page")` trực tiếp trong test thì dùng snake_case.
- Grid là **danh sách ảo**: card ngoài màn hình không có trong DOM. Test phải cuộn tới.
- Khi test, bấm Play rồi đọc thời gian thì phải nhớ vị trí playhead **trước** khi bấm.
- Video viewer: `usePlaybackMemory` tự áp vị trí bắt đầu khi mở, nên test chỉ được tua *sau* khi video đã sẵn sàng thêm khoảng 1,5 s.

---

## 11. Tài liệu thiết kế khác

- [`ARCHITECTURE.md`](ARCHITECTURE.md): kiến trúc tổng thể ban đầu.
- [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md): bảng, cột, index.
- [`MEDIA_PIPELINE.md`](MEDIA_PIPELINE.md): quét, metadata, thumbnail, hàng đợi.
- [`VIDEO_PLAYBACK.md`](VIDEO_PLAYBACK.md): phát video, chuyển mã dự phòng.
- [`LAN_SERVER.md`](LAN_SERVER.md): chia sẻ LAN.
- [`UI_SPEC.md`](UI_SPEC.md): đặc tả giao diện (code trỏ tới các mục §).
- [`ROADMAP.md`](ROADMAP.md): lộ trình.
- [`tests-e2e/README.md`](tests-e2e/README.md): kiểm thử đầu-cuối.
- [`AGENTS.md`](AGENTS.md): quy tắc cho trợ lý AI.

## 12. Bên thứ ba và giấy phép

| Thành phần | Giấy phép | Ghi chú |
|---|---|---|
| FFmpeg (bản GPL có libx264) | GPL | được nhúng vào exe |
| yt-dlp | Unlicense | thỉnh thoảng cần cập nhật (Downloads → Update yt-dlp) |
| uBlock Origin | GPLv3 | được nhúng vào exe |
| rife-ncnn-vulkan | MIT | tải khi dùng lần đầu, kèm file LICENSE |
| Real-ESRGAN | BSD-3-Clause | tải khi dùng lần đầu, kèm file LICENSE |
| Ảnh nền cửa sổ | Giấy phép Pexels | Pexels 10615070 / 1477537 |

Kiểm tra giấy phép của các thành phần trên trước khi phân phối lại.
