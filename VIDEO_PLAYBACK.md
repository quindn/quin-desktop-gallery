# Video Playback

## Strategy

1. **Try native playback first.** The WebView2 `<video>` element (Chromium
   media stack) plays H.264/AAC-in-MP4, VP8/VP9/Opus-in-WEBM, and similar
   natively-supported combinations directly from a local file via a Tauri
   `asset://` / custom protocol URL — no transcoding, no extra process.
2. **Never mark a file "unsupported."** If the container/codec can't be
   played natively (MKV with certain codecs, AVI, WMV, TS, exotic pixel
   formats, etc.), fall back automatically and transparently:
   - **Remux first**: if the video/audio codecs are already
     browser-compatible but the container isn't (e.g. H.264/AAC inside an
     MKV or AVI), `ffmpeg -c copy` into an MP4/fragmented-MP4 container —
     no re-encode, near-instant, lossless.
   - **Transcode on demand** only when the codec itself is unsupported
     (e.g. MPEG-2, VC-1, HEVC where hardware/browser support is absent):
     `ffmpeg` decodes and re-encodes to H.264/AAC MP4, using Windows
     hardware acceleration (`h264_qsv`/`h264_nvenc`/`h264_amf`, probed at
     startup and falling back to `libx264` if none available).
3. The player component never knows which path was used — it just
   receives a playable URL (native file URL, or a local HTTP stream from
   the embedded server) and standard `<video>` events.

## Delivery mechanism

- The Rust side runs a small **loopback-only Axum server** (same crate as
  the LAN server, bound to `127.0.0.1` on a random port when LAN sharing is
  off) that serves:
  - Direct file bytes for natively-playable files, with HTTP Range support
    (required for the browser's own seeking on large files even when no
    transcode is needed).
  - Remuxed/transcoded output for everything else, written to a temp cache
    file and served the same way once enough of it exists, or served as a
    growing file with Range support as FFmpeg produces it (progressive
    availability, so playback can start before the whole remux finishes).
- Range support is essential for scrubbing; the fallback endpoint tracks
  how much of the temp output is written and returns `206 Partial Content`
  responses accordingly, or `503`/retry-after semantics for not-yet-ready
  ranges during active transcode.
- Original files are **never** modified for playback purposes — all
  remux/transcode output goes to `%LOCALAPPDATA%/QuinPowerGallery/playcache/`,
  cleaned automatically (LRU + on app start, abandoned temp files from a
  previous crash are swept, §30).

## Player features (spec §12)

Implemented in the React video player component, driving the underlying
`<video>` element plus custom UI chrome:

- Play/pause, seek bar bound to real duration (from the DB's `duration_ms`,
  not the possibly-wrong browser-reported duration for VFR/streamed files),
  scrubbing thumbnail preview (pulled from the filmstrip cache, §13),
  volume/mute, speed (`playbackRate`), fullscreen, loop, A-B loop (client-
  side, re-seeks at the B marker), next/previous (keyboard + UI), resume
  last position (`media.playback_position_ms`, saved on an interval + on
  close), frame step (pause + seek by `1/fps` when fps is known, otherwise
  a small fixed delta), audio track selection and subtitle track selection
  (native `<video>` `audioTracks`/`textTracks` where the browser exposes
  them; for tracks the WebView2 stack can't expose directly, FFmpeg can
  extract subtitle streams to WebVTT on demand and they're added as
  `<track>` elements).
- Hardware decoding: relies on WebView2/Chromium's own hardware video
  decode for the native path; for the FFmpeg fallback path, the *encode*
  side uses Windows hardware encoders where available (see above) — the
  *decode* side already benefits from WebView2 hardware decode once the
  output is a browser-native format.

## Editing vs. playback

Playback fallback output is disposable cache, distinct from the editing
pipeline's outputs (§14), which are explicit user-triggered exports.
Nothing produced for playback purposes is ever written back over, or
confused with, an edited export.
