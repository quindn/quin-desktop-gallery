//! What a streaming manifest says about the stream it describes: live or
//! on-demand, how long, which sizes, and — importantly — whether it is
//! protected. Only *reads* the public manifest text; nothing here touches keys,
//! licences or media samples.

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestInfo {
    /// "HLS" | "DASH" | "Smooth"
    pub format: String,
    pub live: bool,
    /// Live with a seekable window behind the live edge.
    pub dvr: bool,
    pub low_latency: bool,
    /// A multivariant playlist (lists renditions rather than segments).
    pub master: bool,
    pub duration: Option<f64>,
    /// Available picture heights, tallest first.
    pub heights: Vec<u32>,
    pub fmp4: bool,
    /// DRM system(s) protecting the stream ("Widevine", "PlayReady", "FairPlay", "ClearKey", "CENC"...).
    pub drm: Option<String>,
    /// Plain AES-128 segment encryption: FFmpeg / yt-dlp fetch the key themselves.
    pub aes128: bool,
    /// Absolute URLs of the renditions / sub-playlists a master points at.
    pub children: Vec<String>,
}

/// Recognises the manifest kind from the body and analyses it. `base` is the
/// manifest's own URL, used to resolve relative rendition links.
pub fn analyze(text: &str, base: &str) -> Option<ManifestInfo> {
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with("#EXTM3U") {
        Some(analyze_hls(head, base))
    } else if head.contains("<MPD") {
        Some(analyze_dash(head))
    } else if head.contains("<SmoothStreamingMedia") {
        Some(analyze_smooth(head))
    } else {
        None
    }
}

/// `KEY=value,KEY2="quoted, value"` attribute lists (HLS).
fn attrs(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let (mut key, mut val) = (String::new(), String::new());
    let (mut in_key, mut quoted) = (true, false);
    let flush = |k: &mut String, v: &mut String, out: &mut Vec<(String, String)>| {
        if !k.trim().is_empty() {
            out.push((k.trim().to_ascii_uppercase(), v.trim().to_string()));
        }
        k.clear();
        v.clear();
    };
    for c in s.chars() {
        match c {
            '"' if !in_key => quoted = !quoted,
            '=' if in_key => in_key = false,
            ',' if !quoted => {
                flush(&mut key, &mut val, &mut out);
                in_key = true;
            }
            _ if in_key => key.push(c),
            _ => val.push(c),
        }
    }
    flush(&mut key, &mut val, &mut out);
    out
}

fn attr(list: &[(String, String)], name: &str) -> Option<String> {
    list.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

fn resolve(base: &str, link: &str) -> Option<String> {
    url::Url::parse(base).ok()?.join(link.trim()).ok().map(|u| u.to_string())
}

fn push_height(heights: &mut Vec<u32>, h: u32) {
    if h >= 64 && !heights.contains(&h) {
        heights.push(h);
    }
}

fn hls_key_system(a: &[(String, String)]) -> Option<String> {
    let method = attr(a, "METHOD").unwrap_or_default().to_ascii_uppercase();
    let format = attr(a, "KEYFORMAT").unwrap_or_default().to_ascii_lowercase();
    match method.as_str() {
        "" | "NONE" => None,
        "AES-128" if format.is_empty() || format == "identity" => None,
        _ => Some(if format.contains("streamingkeydelivery") {
            "FairPlay".to_string()
        } else if format.contains("edef8ba9") || format.contains("widevine") {
            "Widevine".to_string()
        } else if format.contains("playready") || format.contains("9a04f079") {
            "PlayReady".to_string()
        } else {
            "Protected".to_string()
        }),
    }
}

fn analyze_hls(text: &str, base: &str) -> ManifestInfo {
    let mut i = ManifestInfo { format: "HLS".into(), ..Default::default() };
    let (mut total, mut has_inf, mut endlist, mut ptype) = (0.0f64, false, false, String::new());
    let mut drm: Vec<String> = Vec::new();
    let mut next_is_variant = false;
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if !l.starts_with('#') {
            if next_is_variant {
                if let Some(u) = resolve(base, l) {
                    i.children.push(u);
                }
                next_is_variant = false;
            }
            continue;
        }
        if let Some(rest) = l.strip_prefix("#EXT-X-STREAM-INF:") {
            i.master = true;
            next_is_variant = true;
            let a = attrs(rest);
            if let Some(h) = attr(&a, "RESOLUTION").and_then(|r| r.split(['x', 'X']).nth(1).and_then(|h| h.parse().ok())) {
                push_height(&mut i.heights, h);
            }
        } else if let Some(rest) = l.strip_prefix("#EXT-X-MEDIA:").or_else(|| l.strip_prefix("#EXT-X-I-FRAME-STREAM-INF:")) {
            i.master = true;
            if let Some(u) = attr(&attrs(rest), "URI").and_then(|u| resolve(base, &u)) {
                i.children.push(u);
            }
        } else if let Some(rest) = l.strip_prefix("#EXTINF:") {
            has_inf = true;
            total += rest.split(',').next().and_then(|d| d.trim().parse::<f64>().ok()).unwrap_or(0.0);
        } else if l == "#EXT-X-ENDLIST" {
            endlist = true;
        } else if let Some(v) = l.strip_prefix("#EXT-X-PLAYLIST-TYPE:") {
            ptype = v.trim().to_ascii_uppercase();
        } else if l.starts_with("#EXT-X-MAP:") {
            i.fmp4 = true;
        } else if l.starts_with("#EXT-X-PART:") || l.starts_with("#EXT-X-PART-INF:") || l.starts_with("#EXT-X-PRELOAD-HINT:") {
            i.low_latency = true;
        } else if let Some(rest) = l.strip_prefix("#EXT-X-KEY:").or_else(|| l.strip_prefix("#EXT-X-SESSION-KEY:")) {
            let a = attrs(rest);
            match hls_key_system(&a) {
                Some(name) => {
                    if !drm.contains(&name) {
                        drm.push(name);
                    }
                }
                None => {
                    if attr(&a, "METHOD").map(|m| m.eq_ignore_ascii_case("AES-128")).unwrap_or(false) {
                        i.aes128 = true;
                    }
                }
            }
        }
    }
    i.children.dedup();
    i.heights.sort_unstable_by(|a, b| b.cmp(a));
    if !drm.is_empty() {
        i.drm = Some(drm.join("/"));
    }
    if !i.master && has_inf {
        if endlist || ptype == "VOD" {
            i.duration = Some(total);
        } else {
            i.live = true;
            i.dvr = ptype == "EVENT" || total >= 30.0;
        }
    }
    i
}

/// `PT1H2M3.5S`, `P0DT10M34S`, `PT634S` -> seconds.
pub fn iso_duration(s: &str) -> Option<f64> {
    let s = s.trim().strip_prefix('P')?;
    let (date, time) = s.split_once('T').unwrap_or((s, ""));
    let mut total = 0.0;
    let mut num = String::new();
    for c in date.chars() {
        match c {
            'D' => {
                total += num.parse::<f64>().ok()? * 86400.0;
                num.clear();
            }
            'W' => {
                total += num.parse::<f64>().ok()? * 604800.0;
                num.clear();
            }
            'Y' | 'M' => num.clear(), // years / months are not meaningful for a video
            d if d.is_ascii_digit() || d == '.' => num.push(d),
            _ => return None,
        }
    }
    num.clear();
    for c in time.chars() {
        match c {
            'H' => {
                total += num.parse::<f64>().ok()? * 3600.0;
                num.clear();
            }
            'M' => {
                total += num.parse::<f64>().ok()? * 60.0;
                num.clear();
            }
            'S' => {
                total += num.parse::<f64>().ok()?;
                num.clear();
            }
            d if d.is_ascii_digit() || d == '.' => num.push(d),
            _ => return None,
        }
    }
    Some(total)
}

/// Every `<name ...>` opening tag (attributes included).
fn tags<'a>(text: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}");
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(p) = text[from..].find(&open) {
        let start = from + p;
        let after = text[start + open.len()..].chars().next();
        let end = text[start..].find('>').map(|e| start + e + 1).unwrap_or(text.len());
        if after.map(|c| c.is_whitespace() || c == '>' || c == '/').unwrap_or(false) {
            out.push(&text[start..end]);
        }
        from = end.max(start + open.len());
    }
    out
}

fn tag_attr(tag: &str, name: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let needle = format!("{name}={quote}");
        let mut from = 0;
        while let Some(p) = tag[from..].find(&needle) {
            let at = from + p;
            // must start a token: `height=` is not `maxHeight=`
            let boundary = at == 0 || !tag[..at].chars().last().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false);
            if boundary {
                let rest = &tag[at + needle.len()..];
                return rest.find(quote).map(|e| rest[..e].to_string());
            }
            from = at + needle.len();
        }
    }
    None
}

fn analyze_dash(text: &str) -> ManifestInfo {
    let mut i = ManifestInfo { format: "DASH".into(), fmp4: text.contains("video/mp4") || text.contains("audio/mp4"), ..Default::default() };
    if let Some(mpd) = tags(text, "MPD").first() {
        i.live = tag_attr(mpd, "type").map(|t| t.eq_ignore_ascii_case("dynamic")).unwrap_or(false);
        i.dvr = i.live && tag_attr(mpd, "timeShiftBufferDepth").and_then(|d| iso_duration(&d)).map(|d| d >= 30.0).unwrap_or(false);
        i.low_latency = i.live && tag_attr(mpd, "availabilityTimeOffset").is_some();
        if !i.live {
            i.duration = tag_attr(mpd, "mediaPresentationDuration").and_then(|d| iso_duration(&d)).filter(|d| *d > 0.0);
        }
    }
    for tag in tags(text, "Representation").into_iter().chain(tags(text, "AdaptationSet")) {
        if let Some(h) = tag_attr(tag, "height").and_then(|h| h.parse().ok()) {
            push_height(&mut i.heights, h);
        }
    }
    i.heights.sort_unstable_by(|a, b| b.cmp(a));

    let mut systems: Vec<&str> = Vec::new();
    let mut only_cenc = false;
    for tag in tags(text, "ContentProtection") {
        let scheme = tag_attr(tag, "schemeIdUri").unwrap_or_default().to_ascii_lowercase();
        let name = if scheme.contains("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed") {
            "Widevine"
        } else if scheme.contains("9a04f079-9840-4286-ab92-e65be0885f95") {
            "PlayReady"
        } else if scheme.contains("94ce86fb-07ff-4f43-adb8-93d2fa968ca2") {
            "FairPlay"
        } else if scheme.contains("1077efec-c0b2-4d02-ace3-3c1e52e2fb4b") || scheme.contains("e2719d58-a985-b3c9-781a-b030af78d30e") {
            "ClearKey"
        } else {
            only_cenc = true;
            continue;
        };
        if !systems.contains(&name) {
            systems.push(name);
        }
    }
    if !systems.is_empty() {
        i.drm = Some(systems.join("/"));
    } else if only_cenc {
        i.drm = Some("CENC".into());
    }
    i
}

fn analyze_smooth(text: &str) -> ManifestInfo {
    let mut i = ManifestInfo { format: "Smooth".into(), fmp4: true, ..Default::default() };
    if let Some(root) = tags(text, "SmoothStreamingMedia").first() {
        i.live = tag_attr(root, "IsLive").map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
        let scale = tag_attr(root, "TimeScale").and_then(|s| s.parse::<f64>().ok()).unwrap_or(10_000_000.0);
        if !i.live {
            i.duration = tag_attr(root, "Duration").and_then(|d| d.parse::<f64>().ok()).map(|d| d / scale).filter(|d| *d > 0.0);
        }
        i.dvr = i.live && tag_attr(root, "DVRWindowLength").and_then(|d| d.parse::<f64>().ok()).map(|d| d / scale >= 30.0).unwrap_or(false);
    }
    for q in tags(text, "QualityLevel") {
        if let Some(h) = tag_attr(q, "MaxHeight").and_then(|h| h.parse().ok()) {
            push_height(&mut i.heights, h);
        }
    }
    i.heights.sort_unstable_by(|a, b| b.cmp(a));
    if text.contains("<Protection") || text.contains("<ProtectionHeader") {
        i.drm = Some("PlayReady".into());
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://cdn.example/v/master.m3u8";

    #[test]
    fn hls_master_lists_renditions_and_sizes() {
        let m = analyze(
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\"\n360/index.m3u8\n\
             #EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhttps://other.example/1080.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/en.m3u8\"\n",
            BASE,
        )
        .unwrap();
        assert!(m.master && !m.live && m.duration.is_none());
        assert_eq!(m.heights, vec![1080, 360]);
        assert_eq!(m.children, vec!["https://cdn.example/v/360/index.m3u8", "https://other.example/1080.m3u8", "https://cdn.example/v/audio/en.m3u8"]);
        assert!(m.drm.is_none() && !m.aes128);
    }

    #[test]
    fn hls_media_playlist_vod_versus_live_versus_event() {
        let vod = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n#EXTINF:4.5,\nb.ts\n#EXT-X-ENDLIST\n";
        let m = analyze(vod, BASE).unwrap();
        assert!(!m.live && !m.master);
        assert_eq!(m.duration, Some(10.5));

        let live = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:6.0,\na.ts\n#EXTINF:6.0,\nb.ts\n";
        let m = analyze(live, BASE).unwrap();
        assert!(m.live && !m.dvr && m.duration.is_none());

        let event = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:6.0,\na.ts\n";
        assert!(analyze(event, BASE).unwrap().dvr);

        let long_live: String = format!("#EXTM3U\n{}", "#EXTINF:6.0,\nx.ts\n".repeat(8));
        assert!(analyze(&long_live, BASE).unwrap().dvr, "a 48 s window is a DVR window");
    }

    #[test]
    fn hls_low_latency_and_fmp4_are_recognised() {
        let t = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-PART-INF:PART-TARGET=0.5\n#EXTINF:2.0,\ns1.m4s\n#EXT-X-PART:DURATION=0.5,URI=\"p.m4s\"\n";
        let m = analyze(t, BASE).unwrap();
        assert!(m.low_latency && m.fmp4 && m.live);
    }

    #[test]
    fn hls_aes128_is_fine_but_drm_key_formats_are_flagged() {
        let aes = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\",IV=0x01\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n";
        let m = analyze(aes, BASE).unwrap();
        assert!(m.aes128 && m.drm.is_none());

        let fp = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://abc\",KEYFORMAT=\"com.apple.streamingkeydelivery\",KEYFORMATVERSIONS=\"1\"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n";
        assert_eq!(analyze(fp, BASE).unwrap().drm.as_deref(), Some("FairPlay"));

        let wv = "#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,URI=\"data:text/plain;base64,AAAA\",KEYFORMAT=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n";
        assert_eq!(analyze(wv, BASE).unwrap().drm.as_deref(), Some("Widevine"));

        let generic = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"k\"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n";
        assert_eq!(analyze(generic, BASE).unwrap().drm.as_deref(), Some("Protected"));

        let none = "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n";
        assert!(analyze(none, BASE).unwrap().drm.is_none());
    }

    #[test]
    fn dash_vod_duration_sizes_and_live() {
        let vod = r#"<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H10M34.000S">
          <Period><AdaptationSet mimeType="video/mp4"><Representation id="1" height="1080" width="1920"/><Representation id="2" height="360"/></AdaptationSet></Period></MPD>"#;
        let m = analyze(vod, "https://a/m.mpd").unwrap();
        assert_eq!(m.format, "DASH");
        assert_eq!(m.duration, Some(634.0));
        assert!(!m.live && m.fmp4);
        assert_eq!(m.heights, vec![1080, 360]);

        let live = r#"<MPD type="dynamic" timeShiftBufferDepth="PT2M" availabilityTimeOffset="4.5"><Period/></MPD>"#;
        let m = analyze(live, "https://a/m.mpd").unwrap();
        assert!(m.live && m.dvr && m.low_latency && m.duration.is_none());
    }

    #[test]
    fn dash_content_protection_names_the_drm_systems() {
        let mpd = r#"<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet>
            <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
            <ContentProtection schemeIdUri="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"/>
            <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>
          </AdaptationSet></Period></MPD>"#;
        assert_eq!(analyze(mpd, "https://a/m.mpd").unwrap().drm.as_deref(), Some("Widevine/PlayReady"));

        let cenc_only = r#"<MPD type="static"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/></MPD>"#;
        assert_eq!(analyze(cenc_only, "https://a/m.mpd").unwrap().drm.as_deref(), Some("CENC"));

        let clear = r#"<MPD type="static"><Period><AdaptationSet><Representation height="720"/></AdaptationSet></Period></MPD>"#;
        assert!(analyze(clear, "https://a/m.mpd").unwrap().drm.is_none());
    }

    #[test]
    fn smooth_streaming_is_read() {
        let vod = r#"<SmoothStreamingMedia MajorVersion="2" MinorVersion="0" TimeScale="10000000" Duration="1200000000">
          <StreamIndex Type="video"><QualityLevel Index="0" Bitrate="2000000" MaxHeight="720"/></StreamIndex></SmoothStreamingMedia>"#;
        let m = analyze(vod, "https://a/x.ism/Manifest").unwrap();
        assert_eq!((m.format.as_str(), m.duration, m.heights.as_slice()), ("Smooth", Some(120.0), &[720][..]));

        let live = r#"<SmoothStreamingMedia IsLive="TRUE" DVRWindowLength="6000000000"><Protection><ProtectionHeader/></Protection></SmoothStreamingMedia>"#;
        let m = analyze(live, "https://a/x.ism/Manifest").unwrap();
        assert!(m.live && m.dvr);
        assert_eq!(m.drm.as_deref(), Some("PlayReady"));
    }

    #[test]
    fn iso_durations_parse() {
        assert_eq!(iso_duration("PT1H2M3.5S"), Some(3723.5));
        assert_eq!(iso_duration("P1DT1S"), Some(86401.0));
        assert_eq!(iso_duration("PT634S"), Some(634.0));
        assert_eq!(iso_duration("garbage"), None);
    }

    #[test]
    fn non_manifests_are_ignored() {
        assert!(analyze("<html><body>404</body></html>", BASE).is_none());
        assert!(analyze("", BASE).is_none());
        // a BOM in front is fine
        assert!(analyze("\u{feff}#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST", BASE).is_some());
    }
}
