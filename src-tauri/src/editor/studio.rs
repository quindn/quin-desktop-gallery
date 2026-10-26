//! Studio: a CapCut-style multi-clip project — clips from the library (videos and photos) one after
//! another with transitions, text on top, music underneath — rendered by one FFmpeg run.
//!
//! Projects are plain JSON files in `data/projects/` (portable, like everything else).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{atempo_chain, EditStep};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Transition {
    /// An FFmpeg `xfade` transition: fade, fadeblack, fadewhite, dissolve, slideleft, slideright,
    /// slideup, slidedown, wipeleft, wiperight, circleopen, circleclose, zoomin, smoothleft, ...
    pub kind: String,
    pub duration_ms: i64,
}

impl Default for Transition {
    fn default() -> Self {
        Self { kind: "fade".into(), duration_ms: 500 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Clip {
    pub id: String,
    /// Absolute path of the source file.
    pub path: String,
    pub name: String,
    /// The library item it came from (for thumbnails), if any.
    pub media_id: Option<i64>,
    /// "video" | "photo"
    pub kind: String,
    /// The used part of the source (a photo: 0 .. how long it is shown).
    pub src_in_ms: i64,
    pub src_out_ms: i64,
    pub speed: f64,
    /// 0 .. 2 (1 = as recorded).
    pub volume: f64,
    pub muted: bool,
    pub has_audio: bool,
    /// "contain" (whole picture, black bars) | "cover" (fills the frame, cropped)
    pub fit: String,
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    /// How this clip comes in from the previous one (none = a straight cut).
    pub transition: Option<Transition>,
}

impl Default for Clip {
    fn default() -> Self {
        Self {
            id: String::new(),
            path: String::new(),
            name: String::new(),
            media_id: None,
            kind: "video".into(),
            src_in_ms: 0,
            src_out_ms: 3000,
            speed: 1.0,
            volume: 1.0,
            muted: false,
            has_audio: false,
            fit: "contain".into(),
            brightness: 0.0,
            contrast: 1.0,
            saturation: 1.0,
            transition: None,
        }
    }
}

impl Clip {
    /// How long it lasts on the timeline.
    pub fn out_len_ms(&self) -> i64 {
        (((self.src_out_ms - self.src_in_ms).max(0)) as f64 / self.speed.clamp(0.1, 10.0)).round() as i64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TextItem {
    pub id: String,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    /// Centre of the text, as fractions of the frame.
    pub x: f64,
    pub y: f64,
    /// Font size in px for a 1080-px-tall frame (scaled for others).
    pub size: f64,
    pub color: String,
    /// A dark box behind the text.
    pub background: bool,
    pub bold: bool,
}

impl Default for TextItem {
    fn default() -> Self {
        Self { id: String::new(), text: "Text".into(), start_ms: 0, end_ms: 3000, x: 0.5, y: 0.85, size: 72.0, color: "#ffffff".into(), background: true, bold: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioItem {
    pub id: String,
    pub path: String,
    pub name: String,
    /// Where it starts on the timeline.
    pub start_ms: i64,
    pub src_in_ms: i64,
    pub src_out_ms: i64,
    pub volume: f64,
    pub fade_in_ms: i64,
    pub fade_out_ms: i64,
}

impl Default for AudioItem {
    fn default() -> Self {
        Self { id: String::new(), path: String::new(), name: String::new(), start_ms: 0, src_in_ms: 0, src_out_ms: 0, volume: 0.8, fade_in_ms: 0, fade_out_ms: 1000 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Project {
    pub id: String,
    pub name: String,
    /// "16:9" | "9:16" | "1:1" | "4:3" | "3:4"
    pub aspect: String,
    /// Height of the output (720 / 1080 / 1440 / 2160); the width follows the aspect.
    pub resolution: i64,
    pub fps: i64,
    pub clips: Vec<Clip>,
    pub texts: Vec<TextItem>,
    pub audio: Vec<AudioItem>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Default for Project {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Untitled project".into(),
            aspect: "16:9".into(),
            resolution: 1080,
            fps: 30,
            clips: vec![],
            texts: vec![],
            audio: vec![],
            created_at: 0,
            updated_at: 0,
        }
    }
}

impl Project {
    /// Output size, even numbers.
    pub fn size(&self) -> (i64, i64) {
        let (a, b) = match self.aspect.as_str() {
            "9:16" => (9.0, 16.0),
            "1:1" => (1.0, 1.0),
            "4:3" => (4.0, 3.0),
            "3:4" => (3.0, 4.0),
            _ => (16.0, 9.0),
        };
        let short = self.resolution.clamp(240, 2160) as f64;
        let (w, h) = if a >= b { (short * a / b, short) } else { (short, short * b / a) };
        ((w as i64) / 2 * 2, (h as i64) / 2 * 2)
    }

    /// The transition into clip `i`, made to fit (shorter than both clips it joins); 0 = a cut.
    pub fn transition_ms(&self, i: usize) -> i64 {
        if i == 0 {
            return 0;
        }
        let Some(t) = &self.clips[i].transition else { return 0 };
        let room = self.clips[i - 1].out_len_ms().min(self.clips[i].out_len_ms()) - 100;
        t.duration_ms.clamp(0, room.max(0))
    }

    /// Where each clip starts on the timeline (transitions overlap the clips they join), and the total.
    pub fn layout(&self) -> (Vec<i64>, i64) {
        let mut starts = vec![];
        let mut at = 0;
        for (i, c) in self.clips.iter().enumerate() {
            at -= self.transition_ms(i);
            starts.push(at);
            at += c.out_len_ms();
        }
        (starts, at.max(0))
    }
}

/// FFmpeg filter-graph path quoting: `C:/x` -> `C\:/x`, and quotes.
fn filter_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "\\'")
}

fn hex_color(c: &str) -> String {
    let c = c.trim().trim_start_matches('#');
    if c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("0x{c}")
    } else {
        "white".into()
    }
}

const ALLOWED_TRANSITIONS: &[&str] = &[
    "fade", "fadeblack", "fadewhite", "dissolve", "slideleft", "slideright", "slideup", "slidedown", "wipeleft", "wiperight",
    "wipeup", "wipedown", "circleopen", "circleclose", "zoomin", "smoothleft", "smoothright", "radial", "pixelize", "hblur",
];

/// What the render needs besides the project: where text files go and which font to use.
pub struct RenderEnv<'a> {
    pub tmp_dir: &'a Path,
    pub job_id: &'a str,
    pub font: Option<PathBuf>,
    pub font_bold: Option<PathBuf>,
}

/// The FFmpeg arguments that render the whole project to `output`, the files it writes first
/// (text for the titles), and the output's length.
pub fn build(project: &Project, output: &Path, env: &RenderEnv) -> Result<(Vec<String>, Vec<(PathBuf, String)>, i64), String> {
    if project.clips.is_empty() {
        return Err("add at least one clip to the timeline".into());
    }
    let (w, h) = project.size();
    let fps = project.fps.clamp(10, 120);
    let (starts, total) = project.layout();
    let mut args: Vec<String> = vec!["-y".into(), "-nostdin".into()];
    let mut graph: Vec<String> = vec![];
    let mut files = vec![];

    // ---- one input per clip, trimmed at the input (fast seek) ----
    for c in &project.clips {
        let len = (c.src_out_ms - c.src_in_ms).max(100);
        if !Path::new(&c.path).exists() {
            return Err(format!("a clip's file is missing: {}", c.name));
        }
        if c.kind == "photo" {
            args.extend(["-loop".into(), "1".into(), "-framerate".into(), fps.to_string(), "-t".into(), format!("{:.3}", len as f64 / 1000.0)]);
        } else {
            args.extend(["-ss".into(), format!("{:.3}", c.src_in_ms as f64 / 1000.0), "-t".into(), format!("{:.3}", len as f64 / 1000.0)]);
        }
        args.extend(["-i".into(), c.path.clone()]);
    }
    let music_base = project.clips.len();
    for a in &project.audio {
        if !Path::new(&a.path).exists() {
            return Err(format!("a music file is missing: {}", a.name));
        }
        args.extend(["-ss".into(), format!("{:.3}", a.src_in_ms as f64 / 1000.0), "-t".into(), format!("{:.3}", (a.src_out_ms - a.src_in_ms).max(100) as f64 / 1000.0), "-i".into(), a.path.clone()]);
    }

    // ---- each clip to the same size, frame rate and sound format ----
    for (i, c) in project.clips.iter().enumerate() {
        let speed = c.speed.clamp(0.1, 10.0);
        let out_len = c.out_len_ms() as f64 / 1000.0;
        let fit = if c.fit == "cover" {
            format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}")
        } else {
            format!("scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black")
        };
        let mut v = format!("[{i}:v]setpts=(PTS-STARTPTS)/{speed},{fit},setsar=1,fps={fps},format=yuv420p");
        if c.brightness != 0.0 || c.contrast != 1.0 || c.saturation != 1.0 {
            v.push_str(&format!(",eq=brightness={}:contrast={}:saturation={}", c.brightness, c.contrast, c.saturation));
        }
        v.push_str(&format!(",trim=duration={out_len:.3},setpts=PTS-STARTPTS,settb=AVTB[v{i}]"));
        graph.push(v);
        if c.has_audio && !c.muted && c.kind == "video" && c.volume > 0.0 {
            let tempo = if (speed - 1.0).abs() > 1e-6 { format!("{},", atempo_chain(speed)) } else { String::new() };
            graph.push(format!(
                "[{i}:a]asetpts=PTS-STARTPTS,{tempo}volume={},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration={out_len:.3}[a{i}]",
                c.volume
            ));
        } else {
            graph.push(format!("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration={out_len:.3},aformat=sample_fmts=fltp[a{i}]"));
        }
    }

    // ---- one after the other: a cut is a concat, a transition is an xfade + acrossfade ----
    let mut cur_v = "v0".to_string();
    let mut cur_a = "a0".to_string();
    let mut cur_len = project.clips[0].out_len_ms();
    for i in 1..project.clips.len() {
        let t = project.transition_ms(i);
        let (nv, na) = (format!("vj{i}"), format!("aj{i}"));
        if t > 0 {
            let kind = project.clips[i].transition.as_ref().map(|t| t.kind.as_str()).unwrap_or("fade");
            let kind = if ALLOWED_TRANSITIONS.contains(&kind) { kind } else { "fade" };
            graph.push(format!(
                "[{cur_v}][v{i}]xfade=transition={kind}:duration={:.3}:offset={:.3}[{nv}]",
                t as f64 / 1000.0,
                (cur_len - t) as f64 / 1000.0
            ));
            graph.push(format!("[{cur_a}][a{i}]acrossfade=d={:.3}[{na}]", t as f64 / 1000.0));
        } else {
            graph.push(format!("[{cur_v}][{cur_a}][v{i}][a{i}]concat=n=2:v=1:a=1[{nv}][{na}]"));
        }
        cur_len += project.clips[i].out_len_ms() - t;
        cur_v = nv;
        cur_a = na;
    }
    debug_assert_eq!(cur_len, total);
    let _ = starts;

    // ---- titles ----
    let font = env.font.as_ref().map(|f| filter_path(f));
    let font_bold = env.font_bold.as_ref().or(env.font.as_ref()).map(|f| filter_path(f));
    for (k, t) in project.texts.iter().enumerate() {
        if t.text.trim().is_empty() || t.end_ms <= t.start_ms {
            continue;
        }
        let file = env.tmp_dir.join(format!("{}.tmp.text{k}.txt", env.job_id));
        files.push((file.clone(), t.text.clone()));
        let size = (t.size * h as f64 / 1080.0).round().max(8.0);
        let mut dt = format!(
            "drawtext=textfile='{}':expansion=none:fontsize={size}:fontcolor={}:x=(w*{:.4})-text_w/2:y=(h*{:.4})-text_h/2:line_spacing={}:enable='between(t,{:.3},{:.3})'",
            filter_path(&file),
            hex_color(&t.color),
            t.x.clamp(0.0, 1.0),
            t.y.clamp(0.0, 1.0),
            (size * 0.2).round(),
            t.start_ms as f64 / 1000.0,
            t.end_ms as f64 / 1000.0
        );
        if let Some(f) = if t.bold { &font_bold } else { &font } {
            dt.push_str(&format!(":fontfile='{f}'"));
        }
        if t.background {
            dt.push_str(&format!(":box=1:boxcolor=black@0.55:boxborderw={}", (size * 0.3).round()));
        } else {
            dt.push_str(&format!(":borderw={}:bordercolor=black@0.8", (size / 18.0).round().max(1.0)));
        }
        let nv = format!("vt{k}");
        graph.push(format!("[{cur_v}]{dt}[{nv}]"));
        cur_v = nv;
    }

    // ---- music under the clips' own sound ----
    if !project.audio.is_empty() {
        let mut mix = vec![format!("[{cur_a}]")];
        for (k, a) in project.audio.iter().enumerate() {
            let len = (a.src_out_ms - a.src_in_ms).max(100) as f64 / 1000.0;
            let mut f = format!("[{}:a]asetpts=PTS-STARTPTS,volume={},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo", music_base + k, a.volume.clamp(0.0, 3.0));
            if a.fade_in_ms > 0 {
                f.push_str(&format!(",afade=t=in:st=0:d={:.3}", a.fade_in_ms as f64 / 1000.0));
            }
            if a.fade_out_ms > 0 {
                let d = (a.fade_out_ms as f64 / 1000.0).min(len);
                f.push_str(&format!(",afade=t=out:st={:.3}:d={d:.3}", (len - d).max(0.0)));
            }
            let delay = a.start_ms.max(0);
            f.push_str(&format!(",adelay={delay}|{delay}[m{k}]"));
            graph.push(f);
            mix.push(format!("[m{k}]"));
        }
        graph.push(format!("{}amix=inputs={}:duration=first:dropout_transition=0:normalize=0[amix]", mix.join(""), mix.len()));
        cur_a = "amix".into();
    }

    args.extend(["-filter_complex".into(), graph.join(";")]);
    args.extend(["-map".into(), format!("[{cur_v}]"), "-map".into(), format!("[{cur_a}]")]);
    args.extend(
        ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r"]
            .iter()
            .map(|s| s.to_string()),
    );
    args.push(fps.to_string());
    args.extend(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-t"].iter().map(|s| s.to_string()));
    args.push(format!("{:.3}", total as f64 / 1000.0));
    args.push(output.to_string_lossy().to_string());
    Ok((args, files, total))
}

/// The steps of a render (one FFmpeg run), with its title files.
pub fn plan(project: &Project, output: &Path, env: &RenderEnv) -> Result<(Vec<EditStep>, Vec<PathBuf>), String> {
    let (args, files, total) = build(project, output, env)?;
    let scratch: Vec<PathBuf> = files.iter().map(|(p, _)| p.clone()).collect();
    for (p, text) in &files {
        std::fs::write(p, text).map_err(|e| format!("could not write {}: {e}", p.display()))?;
    }
    Ok((EditStep::single(args, Some(total)), scratch))
}

/// A font that has Vietnamese and the rest of Latin: Segoe UI / Arial on Windows.
pub fn default_fonts() -> (Option<PathBuf>, Option<PathBuf>) {
    let dir = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows")).join("Fonts");
    let pick = |names: &[&str]| names.iter().map(|n| dir.join(n)).find(|p| p.exists());
    (pick(&["segoeui.ttf", "arial.ttf", "tahoma.ttf"]), pick(&["segoeuib.ttf", "arialbd.ttf", "tahomabd.ttf", "segoeui.ttf"]))
}

// ------------------------------------------------------------------ storage

pub fn projects_dir() -> PathBuf {
    let p = crate::paths::data_dir().join("projects");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err("bad project id".into())
    }
}

pub fn save(dir: &Path, p: &Project) -> Result<(), String> {
    let id = safe_id(&p.id)?;
    let json = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{id}.json.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
}

pub fn load(dir: &Path, id: &str) -> Result<Project, String> {
    let id = safe_id(id)?;
    let text = std::fs::read_to_string(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn list(dir: &Path) -> Vec<Project> {
    let mut out: Vec<Project> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<Project>(&t).ok())
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    let id = safe_id(id)?;
    std::fs::remove_file(dir.join(format!("{id}.json"))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn tools() -> Option<(PathBuf, PathBuf)> {
        let bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("bin");
        let f = bin.join("ffmpeg-x86_64-pc-windows-msvc.exe");
        let p = bin.join("ffprobe-x86_64-pc-windows-msvc.exe");
        (f.exists() && p.exists()).then_some((f, p))
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("qg-studio-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn clip(path: &Path, kind: &str, a: i64, b: i64) -> Clip {
        Clip { id: format!("c{a}"), path: path.to_string_lossy().into(), name: "x".into(), kind: kind.into(), src_in_ms: a, src_out_ms: b, has_audio: kind == "video", ..Default::default() }
    }

    fn probe(ffprobe: &Path, f: &Path) -> (i64, i64, f64, bool) {
        let out = Command::new(ffprobe).args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format"]).arg(f).output().unwrap();
        let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let s = v["streams"].as_array().unwrap();
        let vid = s.iter().find(|x| x["codec_type"] == "video").unwrap();
        (vid["width"].as_i64().unwrap(), vid["height"].as_i64().unwrap(), v["format"]["duration"].as_str().unwrap().parse().unwrap(), s.iter().any(|x| x["codec_type"] == "audio"))
    }

    #[test]
    fn sizes_and_layout_with_transitions() {
        let mut p = Project { aspect: "9:16".into(), resolution: 1080, ..Default::default() };
        assert_eq!(p.size(), (1080, 1920));
        p.aspect = "16:9".into();
        p.resolution = 720;
        assert_eq!(p.size(), (1280, 720));
        let f = Path::new("x.mp4");
        p.clips = vec![clip(f, "video", 0, 4000), clip(f, "video", 1000, 3000), clip(f, "photo", 0, 3000)];
        p.clips[1].transition = Some(Transition { kind: "fade".into(), duration_ms: 500 });
        p.clips[2].transition = Some(Transition { kind: "wipeleft".into(), duration_ms: 9000 }); // too long: made to fit
        p.clips[1].speed = 2.0; // 2 s of source -> 1 s
        let (starts, total) = p.layout();
        assert_eq!(p.clips[1].out_len_ms(), 1000);
        assert_eq!(p.transition_ms(2), 900, "a transition never covers a whole clip");
        assert_eq!(starts, vec![0, 3500, 3600]);
        assert_eq!(total, 6600);
    }

    #[test]
    fn a_project_renders_clips_photo_transitions_titles_and_music() {
        let Some((ffmpeg, ffprobe)) = tools() else { return };
        let dir = scratch("render");
        let v = dir.join("a.mp4");
        let ph = dir.join("p.jpg");
        let mu = dir.join("m.m4a");
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]).arg(&v).status().unwrap().success());
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=400x600", "-frames:v", "1"]).arg(&ph).status().unwrap().success());
        assert!(Command::new(&ffmpeg).args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=10", "-c:a", "aac"]).arg(&mu).status().unwrap().success());

        let mut p = Project { id: "t1".into(), aspect: "16:9".into(), resolution: 360, fps: 30, ..Default::default() };
        p.clips = vec![clip(&v, "video", 1000, 4000), clip(&ph, "photo", 0, 2000), clip(&v, "video", 0, 2000)];
        p.clips[1].transition = Some(Transition { kind: "fade".into(), duration_ms: 500 });
        p.clips[2].transition = Some(Transition { kind: "slideleft".into(), duration_ms: 400 });
        p.clips[2].speed = 2.0;
        p.texts = vec![TextItem { id: "t".into(), text: "Xin chào — Quin's \"Studio\" 50%".into(), start_ms: 500, end_ms: 2500, ..Default::default() }];
        p.audio = vec![AudioItem { id: "m".into(), path: mu.to_string_lossy().into(), name: "m".into(), start_ms: 1000, src_in_ms: 0, src_out_ms: 10000, volume: 0.5, fade_in_ms: 300, fade_out_ms: 800 }];
        let (fonts, bold) = default_fonts();
        let env = RenderEnv { tmp_dir: &dir, job_id: "j", font: fonts, font_bold: bold };
        let out = dir.join("out.mp4");
        let (steps, scratch_files) = plan(&p, &out, &env).unwrap();
        let cancel = crate::editor::runner::new_cancel();
        let mut last = 0.0;
        crate::editor::runner::run_steps(&ffmpeg, &steps, &mut |pc| last = pc, &cancel).unwrap();
        let (w, h, dur, audio) = probe(&ffprobe, &out);
        assert_eq!((w, h), (640, 360));
        // 3 s + 2 s + 1 s - 0.5 - 0.4
        assert!((dur - 5.1).abs() < 0.15, "got {dur}");
        assert!(audio);
        assert!(last >= 99.0);
        for f in scratch_files {
            let _ = std::fs::remove_file(f);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn projects_are_saved_listed_and_deleted() {
        let dir = scratch("store");
        let mut p = Project { id: "abc-1".into(), name: "Trip".into(), updated_at: 5, ..Default::default() };
        save(&dir, &p).unwrap();
        p.id = "abc-2".into();
        p.updated_at = 9;
        save(&dir, &p).unwrap();
        let l = list(&dir);
        assert_eq!(l.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["abc-2", "abc-1"]);
        assert_eq!(load(&dir, "abc-1").unwrap().name, "Trip");
        delete(&dir, "abc-1").unwrap();
        assert_eq!(list(&dir).len(), 1);
        assert!(load(&dir, "../evil").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
