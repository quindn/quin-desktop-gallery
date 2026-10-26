//! The library search box, in the spirit of Windows Explorer's search:
//!
//! - words: every word must appear (any order) in the file's name or its folders;
//!   accents and case don't matter ("dang" finds "Đặng", "hoa" finds "Hoà");
//! - `"exact words"` keeps words together, `-word` excludes, `a OR b` either one;
//! - `*` / `?` wildcards match the file name (`IMG_*.jpg`, `*.mov`);
//! - filters, Explorer style: `kind:video`, `ext:mp4,mov`, `size:>100mb`, `size:large`,
//!   `date:thisweek`, `date:2024-05`, `modified:>2024-01-01`, `created:`, `taken:`,
//!   `duration:>5m`, `duration:long`, `res:4k`, `width:>1920`, `is:fav`, `is:portrait`,
//!   `rating:>=3`, `tag:holiday`, `name:`, `folder:`.
//!
//! `compile` turns the text into SQL conditions (positional `?` params) plus "chips" — how
//! each part was understood, which the search box shows.

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use rusqlite::types::Value;
use serde::Serialize;
use unicode_normalization::UnicodeNormalization;

/// Lower case, no accents (Vietnamese đ → d as well).
pub fn fold(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(|c| match c {
            'đ' | 'Đ' => 'd',
            _ => c,
        })
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Makes `qg_fold(text)` available to SQL on this connection.
pub fn register(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    use rusqlite::functions::FunctionFlags;
    conn.create_scalar_function("qg_fold", 1, FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        Ok(match ctx.get_raw(0) {
            rusqlite::types::ValueRef::Text(t) => Some(fold(&String::from_utf8_lossy(t))),
            _ => None,
        })
    })
}

/// The search key's index (only the rows still missing one) and the trigger that clears it when a
/// file is renamed or moved. Plain SQL — it works on any connection, with or without `qg_fold`.
pub fn prepare_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    // a brand-new database gets its media table from the init script, after the column repair ran
    let has: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('media') WHERE name = 'search_key')", [], |r| r.get(0))?;
    if !has {
        conn.execute_batch("ALTER TABLE media ADD COLUMN search_key TEXT;")?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_media_search_key_missing ON media(id) WHERE search_key IS NULL;
         CREATE TRIGGER IF NOT EXISTS media_search_key_reset AFTER UPDATE OF rel_path ON media
         BEGIN UPDATE media SET search_key = NULL WHERE id = NEW.id; END;",
    )
}

/// Fills in missing search keys, a batch at a time (so the scanner never waits long).
pub fn backfill(conn: &rusqlite::Connection) -> rusqlite::Result<usize> {
    let mut total = 0;
    loop {
        let n = conn.execute(
            "UPDATE media SET search_key = qg_fold(rel_path) WHERE id IN (SELECT id FROM media WHERE search_key IS NULL LIMIT 5000)",
            [],
        )?;
        total += n;
        if n == 0 {
            return Ok(total);
        }
    }
}

static BACKFILLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// `backfill` on a background thread (once at a time). Called when a library opens and whenever
/// a search runs, so files added since get their key without anyone waiting for it — until they
/// have one, searches compute it on the fly.
pub fn backfill_in_background(pool: &super::Pool) {
    use std::sync::atomic::Ordering;
    if BACKFILLING.swap(true, Ordering::SeqCst) {
        return;
    }
    let pool = pool.clone();
    std::thread::spawn(move || {
        if let Ok(conn) = pool.get() {
            let missing: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM media WHERE search_key IS NULL)", [], |r| r.get(0)).unwrap_or(false);
            if missing {
                if let Err(e) = backfill(&conn) {
                    eprintln!("[search] backfill: {e}");
                }
            }
        }
        BACKFILLING.store(false, Ordering::SeqCst);
    });
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Chip {
    /// "text" | "filter" | "exclude" | "unknown"
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Default)]
pub struct Compiled {
    /// AND-ed together by the caller
    pub clauses: Vec<String>,
    pub params: Vec<Value>,
    pub chips: Vec<Chip>,
}

struct Cond {
    sql: String,
    params: Vec<Value>,
    label: String,
    kind: &'static str,
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Splits on spaces, keeping "quoted parts" (also after `field:` or `-`) together.
fn tokenize(input: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    for c in input.chars() {
        match c {
            '"' | '“' | '”' => {
                quoted = !quoted;
                cur.push('"');
            }
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn unquote(s: &str) -> String {
    s.trim_matches('"').to_string()
}

// ------------------------------------------------------------------ values

#[derive(Clone, Copy, PartialEq, Debug)]
enum Op {
    Gt,
    Ge,
    Lt,
    Le,
    Eq,
}
impl Op {
    fn sql(self) -> &'static str {
        match self {
            Op::Gt => ">",
            Op::Ge => ">=",
            Op::Lt => "<",
            Op::Le => "<=",
            Op::Eq => "=",
        }
    }
    fn word(self) -> &'static str {
        match self {
            Op::Gt => "over",
            Op::Ge => "at least",
            Op::Lt => "under",
            Op::Le => "at most",
            Op::Eq => "",
        }
    }
}

/// "<=5" → (Le, "5"); "5" → (Eq, "5")
fn split_op(v: &str) -> (Op, &str) {
    for (p, op) in [(">=", Op::Ge), ("<=", Op::Le), (">", Op::Gt), ("<", Op::Lt), ("=", Op::Eq)] {
        if let Some(r) = v.strip_prefix(p) {
            return (op, r.trim());
        }
    }
    (Op::Eq, v)
}

fn parse_size(v: &str) -> Option<i64> {
    let v = v.trim().to_lowercase().replace(',', ".");
    let num_end = v.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(v.len());
    let n: f64 = v[..num_end].parse().ok()?;
    let mult = match v[num_end..].trim() {
        "" | "b" => 1.0,
        "k" | "kb" => 1024.0,
        "m" | "mb" => 1024.0 * 1024.0,
        "g" | "gb" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" => 1024.0f64.powi(4),
        _ => return None,
    };
    Some((n * mult) as i64)
}

fn fmt_size(b: i64) -> String {
    let (v, u) = if b >= 1 << 30 {
        (b as f64 / (1u64 << 30) as f64, "GB")
    } else if b >= 1 << 20 {
        (b as f64 / (1u64 << 20) as f64, "MB")
    } else if b >= 1 << 10 {
        (b as f64 / 1024.0, "KB")
    } else {
        (b as f64, "B")
    };
    format!("{} {u}", (v * 10.0).round() / 10.0)
}

/// "90", "90s", "5m", "1h30m", "1:30", "1:02:03" → ms
fn parse_duration(v: &str) -> Option<i64> {
    let v = v.trim().to_lowercase();
    if v.contains(':') {
        let parts: Vec<f64> = v.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
        return Some((parts.iter().fold(0.0, |a, p| a * 60.0 + p) * 1000.0) as i64);
    }
    if let Ok(n) = v.parse::<f64>() {
        return Some((n * 1000.0) as i64);
    }
    let mut total = 0.0;
    let mut num = String::new();
    let mut any = false;
    let mut chars = v.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
            continue;
        }
        let n: f64 = num.parse().ok()?;
        num.clear();
        let unit = if c == 'm' && chars.peek() == Some(&'s') {
            chars.next();
            0.001
        } else {
            match c {
                'h' => 3600.0,
                'm' => 60.0,
                's' => 1.0,
                _ => return None,
            }
        };
        // "min" / "sec" / "hr"
        while matches!(chars.peek(), Some(c) if c.is_ascii_alphabetic()) {
            chars.next();
        }
        total += n * unit;
        any = true;
    }
    if !num.is_empty() {
        return None;
    }
    any.then_some((total * 1000.0) as i64)
}

fn fmt_duration(ms: i64) -> String {
    let s = ms / 1000;
    if s >= 3600 {
        format!("{}h{:02}m", s / 3600, (s % 3600) / 60)
    } else if s >= 60 {
        if s % 60 == 0 {
            format!("{} min", s / 60)
        } else {
            format!("{}:{:02}", s / 60, s % 60)
        }
    } else {
        format!("{s} s")
    }
}

fn local_ms(d: NaiveDate) -> i64 {
    Local.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap()).earliest().map(|t| t.timestamp_millis()).unwrap_or(0)
}

/// A date value → [start, end) in ms, with a label.
fn parse_date(v: &str, now: DateTime<Local>) -> Option<(i64, i64, String)> {
    let v = v.trim().to_lowercase().replace([' ', '_'], "");
    let today = now.date_naive();
    let day = |d: NaiveDate| (local_ms(d), local_ms(d + Duration::days(1)));
    let month_start = |y: i32, m: u32| NaiveDate::from_ymd_opt(y, m, 1);
    let next_month = |y: i32, m: u32| if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) };
    let week_start = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let r = match v.as_str() {
        "today" | "homnay" => {
            let (a, b) = day(today);
            (a, b, "today".into())
        }
        "yesterday" | "homqua" => {
            let (a, b) = day(today - Duration::days(1));
            (a, b, "yesterday".into())
        }
        "thisweek" | "tuannay" => (local_ms(week_start), local_ms(today + Duration::days(1)), "this week".into()),
        "lastweek" | "tuantruoc" => (local_ms(week_start - Duration::days(7)), local_ms(week_start), "last week".into()),
        "thismonth" | "thangnay" => (local_ms(month_start(today.year(), today.month())?), local_ms(today + Duration::days(1)), "this month".into()),
        "lastmonth" | "thangtruoc" => {
            let (y, m) = if today.month() == 1 { (today.year() - 1, 12) } else { (today.year(), today.month() - 1) };
            (local_ms(month_start(y, m)?), local_ms(month_start(today.year(), today.month())?), "last month".into())
        }
        "thisyear" | "namnay" => (local_ms(NaiveDate::from_ymd_opt(today.year(), 1, 1)?), local_ms(today + Duration::days(1)), "this year".into()),
        "lastyear" | "namtruoc" => (
            local_ms(NaiveDate::from_ymd_opt(today.year() - 1, 1, 1)?),
            local_ms(NaiveDate::from_ymd_opt(today.year(), 1, 1)?),
            "last year".into(),
        ),
        s if s.starts_with("last") && s.ends_with("days") => {
            let n: i64 = s.trim_start_matches("last").trim_end_matches("days").parse().ok()?;
            (local_ms(today - Duration::days(n - 1)), local_ms(today + Duration::days(1)), format!("last {n} days"))
        }
        s => {
            // 2024 · 2024-05 · 2024-05-17 · 17/5/2024 · 5/2024
            let nums: Vec<&str> = s.split(['-', '/', '.']).collect();
            let n: Vec<i64> = nums.iter().map(|p| p.parse().ok()).collect::<Option<_>>()?;
            match n.as_slice() {
                [y] if (1970..=2100).contains(y) => (
                    local_ms(NaiveDate::from_ymd_opt(*y as i32, 1, 1)?),
                    local_ms(NaiveDate::from_ymd_opt(*y as i32 + 1, 1, 1)?),
                    format!("{y}"),
                ),
                [y, m] if *y > 31 => (local_ms(month_start(*y as i32, *m as u32)?), local_ms(next_month(*y as i32, *m as u32)?), format!("{y}-{m:02}")),
                [m, y] if *y > 31 => (local_ms(month_start(*y as i32, *m as u32)?), local_ms(next_month(*y as i32, *m as u32)?), format!("{y}-{m:02}")),
                [y, m, d] if *y > 31 => {
                    let dt = NaiveDate::from_ymd_opt(*y as i32, *m as u32, *d as u32)?;
                    let (a, b) = day(dt);
                    (a, b, dt.format("%Y-%m-%d").to_string())
                }
                [d, m, y] if *y > 31 => {
                    let dt = NaiveDate::from_ymd_opt(*y as i32, *m as u32, *d as u32)?;
                    let (a, b) = day(dt);
                    (a, b, dt.format("%Y-%m-%d").to_string())
                }
                _ => return None,
            }
        }
    };
    Some(r)
}

/// `col op value` / ranges `a..b` for numbers, sizes, durations.
fn numeric(col: &str, v: &str, parse: impl Fn(&str) -> Option<i64>, fmt: impl Fn(i64) -> String, what: &str) -> Option<Cond> {
    if let Some((a, b)) = v.split_once("..") {
        let (a, b) = (parse(a)?, parse(b)?);
        return Some(Cond {
            sql: format!("({col} >= ? AND {col} <= ?)"),
            params: vec![Value::Integer(a), Value::Integer(b)],
            label: format!("{what} {}–{}", fmt(a), fmt(b)),
            kind: "filter",
        });
    }
    let (op, rest) = split_op(v);
    let n = parse(rest)?;
    Some(Cond {
        sql: format!("{col} {} ?", op.sql()),
        params: vec![Value::Integer(n)],
        label: format!("{what} {}{}{}", op.word(), if op == Op::Eq { "" } else { " " }, fmt(n)).replace("  ", " "),
        kind: "filter",
    })
}

fn range(col: &str, a: Option<i64>, b: Option<i64>, label: String) -> Cond {
    let mut sql = vec![];
    let mut params = vec![];
    if let Some(a) = a {
        sql.push(format!("{col} >= ?"));
        params.push(Value::Integer(a));
    }
    if let Some(b) = b {
        sql.push(format!("{col} < ?"));
        params.push(Value::Integer(b));
    }
    Cond { sql: format!("({})", sql.join(" AND ")), params, label, kind: "filter" }
}

fn text_cond(col_expr: &str, value: &str, label_prefix: &str) -> Option<Cond> {
    let f = fold(&unquote(value));
    if f.is_empty() {
        return None;
    }
    let pat = format!("%{}%", like_escape(&f));
    Some(Cond {
        sql: format!("{} LIKE ? ESCAPE '\\'", folded(col_expr)),
        params: vec![Value::Text(pat)],
        label: format!("{label_prefix}{}", unquote(value)),
        kind: "text",
    })
}

/// `*` / `?` in a word: a pattern over the whole file name.
fn wildcard_cond(value: &str) -> Cond {
    let f = fold(&unquote(value));
    let pat: String = like_escape(&f).chars().map(|c| match c {
        '*' => '%',
        '?' => '_',
        c => c,
    }).collect();
    Cond { sql: "qg_fold(filename) LIKE ? ESCAPE '\\'".into(), params: vec![Value::Text(pat)], label: format!("name {}", unquote(value)), kind: "text" }
}

fn kind_value(v: &str) -> Option<(&'static str, &'static str)> {
    Some(match v {
        "video" | "videos" | "movie" | "movies" | "clip" | "clips" | "vid" => ("video", "Videos"),
        "photo" | "photos" | "image" | "images" | "picture" | "pictures" | "pic" | "pics" | "img" | "anh" => ("photo", "Photos"),
        "gif" | "gifs" | "animated" | "animation" | "anim" => ("animated", "Animated"),
        _ => return None,
    })
}

fn field_cond(field: &str, raw: &str, now: DateTime<Local>) -> Option<Cond> {
    let v = unquote(raw);
    let lv = v.to_lowercase();
    let filter = |sql: &str, label: String| Some(Cond { sql: sql.into(), params: vec![], label, kind: "filter" });
    match field {
        "kind" | "type" | "loai" => {
            let (t, l) = kind_value(&lv)?;
            Some(Cond { sql: "media_type = ?".into(), params: vec![Value::Text(t.into())], label: l.into(), kind: "filter" })
        }
        "is" => {
            if let Some((t, l)) = kind_value(&lv) {
                return Some(Cond { sql: "media_type = ?".into(), params: vec![Value::Text(t.into())], label: l.into(), kind: "filter" });
            }
            match lv.as_str() {
                "fav" | "favorite" | "favourite" | "favorites" | "starred" | "liked" => filter("favorite = 1", "Favorites".into()),
                "portrait" | "vertical" | "doc" => filter("(width IS NOT NULL AND height IS NOT NULL AND width < height)", "Portrait".into()),
                "landscape" | "horizontal" | "ngang" => filter("(width IS NOT NULL AND height IS NOT NULL AND width > height)", "Landscape".into()),
                "square" | "vuong" => filter("(width IS NOT NULL AND height IS NOT NULL AND width = height)", "Square".into()),
                "rated" => filter("rating > 0", "Rated".into()),
                "unrated" => filter("rating = 0", "Not rated".into()),
                "tagged" => filter("id IN (SELECT media_id FROM media_tags)", "Tagged".into()),
                _ => None,
            }
        }
        "fav" | "favorite" | "favourite" => match lv.as_str() {
            "yes" | "true" | "1" | "" => filter("favorite = 1", "Favorites".into()),
            "no" | "false" | "0" => filter("favorite = 0", "Not favorites".into()),
            _ => None,
        },
        "ext" | "extension" | "filetype" | "fileext" => {
            let exts: Vec<String> = lv.split([',', '|', ';']).map(|e| e.trim().trim_start_matches("*.").trim_start_matches('.').to_string()).filter(|e| !e.is_empty()).collect();
            if exts.is_empty() {
                return None;
            }
            let sql = exts.iter().map(|_| "lower(filename) LIKE ? ESCAPE '\\'").collect::<Vec<_>>().join(" OR ");
            Some(Cond {
                sql: format!("({sql})"),
                params: exts.iter().map(|e| Value::Text(format!("%.{}", like_escape(e)))).collect(),
                label: exts.iter().map(|e| format!(".{e}")).collect::<Vec<_>>().join(" / "),
                kind: "filter",
            })
        }
        "name" | "filename" | "ten" => {
            if v.contains(['*', '?']) {
                Some(wildcard_cond(&v))
            } else {
                text_cond("filename", &v, "name: ")
            }
        }
        "folder" | "in" | "path" | "dir" | "thumuc" => text_cond("folder_rel_path", &v, "in folder: ").map(|mut c| {
            c.kind = "filter";
            c
        }),
        "tag" | "tags" => {
            let f = fold(&v);
            (!f.is_empty()).then(|| Cond {
                sql: "id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE qg_fold(t.name) LIKE ? ESCAPE '\\')".into(),
                params: vec![Value::Text(format!("%{}%", like_escape(&f)))],
                label: format!("tag: {v}"),
                kind: "filter",
            })
        }
        "size" => {
            // Explorer's size words
            let words: Option<(Option<i64>, Option<i64>, &str)> = match lv.as_str() {
                "empty" => Some((None, Some(1), "Empty")),
                "tiny" => Some((Some(1), Some(16 << 10), "Tiny (< 16 KB)")),
                "small" => Some((Some(16 << 10), Some(1 << 20), "Small (16 KB – 1 MB)")),
                "medium" => Some((Some(1 << 20), Some(128 << 20), "Medium (1 – 128 MB)")),
                "large" | "big" => Some((Some(128 << 20), Some(1 << 30), "Large (128 MB – 1 GB)")),
                "huge" => Some((Some(1 << 30), Some(4 << 30), "Huge (1 – 4 GB)")),
                "gigantic" => Some((Some(4 << 30), None, "Gigantic (> 4 GB)")),
                _ => None,
            };
            if let Some((a, b, l)) = words {
                return Some(range("file_size", a, b, l.into()));
            }
            numeric("file_size", &lv, parse_size, fmt_size, "size")
        }
        "duration" | "length" | "len" | "dur" | "time" | "thoiluong" => {
            let words: Option<(Option<i64>, Option<i64>, &str)> = match lv.as_str() {
                "veryshort" | "very_short" => Some((None, Some(60_000), "Very short (< 1 min)")),
                "short" => Some((Some(60_000), Some(300_000), "Short (1 – 5 min)")),
                "medium" => Some((Some(300_000), Some(1_800_000), "Medium (5 – 30 min)")),
                "long" => Some((Some(1_800_000), Some(3_600_000), "Long (30 – 60 min)")),
                "verylong" | "very_long" => Some((Some(3_600_000), None, "Very long (> 1 h)")),
                _ => None,
            };
            if let Some((a, b, l)) = words {
                let mut c = range("duration_ms", a, b, l.into());
                c.sql = format!("(duration_ms IS NOT NULL AND {})", c.sql);
                return Some(c);
            }
            numeric("duration_ms", &lv, parse_duration, fmt_duration, "length").map(|mut c| {
                c.sql = format!("(duration_ms IS NOT NULL AND {})", c.sql);
                c
            })
        }
        "width" | "w" => numeric("width", &lv, |s| s.trim_end_matches("px").parse().ok(), |n| format!("{n}px"), "width"),
        "height" | "h" => numeric("height", &lv, |s| s.trim_end_matches("px").parse().ok(), |n| format!("{n}px"), "height"),
        "res" | "resolution" | "quality" => {
            let short = "MIN(width, height)";
            let bucket = |s: &str| -> Option<(i64, Option<i64>, &'static str)> {
                Some(match s {
                    "8k" | "4320p" => (4000, None, "8K"),
                    "4k" | "uhd" | "2160p" => (2000, Some(4000), "4K"),
                    "2k" | "qhd" | "1440p" => (1400, Some(2000), "1440p"),
                    "1080p" | "1080" | "fhd" | "fullhd" => (1000, Some(1400), "1080p"),
                    "720p" | "720" | "hd" => (700, Some(1000), "720p"),
                    "480p" | "480" | "sd" => (0, Some(700), "SD (under 720p)"),
                    _ => return None,
                })
            };
            let (op, rest) = split_op(&lv);
            let (lo, hi, l) = bucket(rest).or_else(|| rest.trim_end_matches('p').parse::<i64>().ok().map(|n| (n, None, "")))?;
            let label_n = if l.is_empty() { format!("{lo}p") } else { l.to_string() };
            let mut c = match op {
                Op::Eq if !l.is_empty() => range(short, Some(lo), hi, label_n),
                Op::Eq | Op::Ge => range(short, Some(lo), None, format!("{label_n} or more")),
                Op::Gt => range(short, Some(hi.unwrap_or(lo + 1)), None, format!("above {label_n}")),
                Op::Lt => range(short, None, Some(lo), format!("below {label_n}")),
                Op::Le => range(short, None, Some(hi.unwrap_or(lo + 1)), format!("{label_n} or less")),
            };
            c.sql = format!("(width IS NOT NULL AND height IS NOT NULL AND {})", c.sql);
            Some(c)
        }
        "rating" | "stars" | "rated" => numeric("rating", &lv, |s| s.trim_end_matches(['*', '★']).parse().ok(), |n| format!("{n}★"), "rating"),
        "date" | "modified" | "datemodified" | "mdate" | "ngay" | "created" | "datecreated" | "cdate" | "taken" | "datetaken" => {
            let (col, what) = match field {
                "created" | "datecreated" | "cdate" => ("created_time", "created"),
                "taken" | "datetaken" => ("COALESCE(date_taken, created_time, modified_time)", "taken"),
                _ => ("modified_time", "modified"),
            };
            if let Some((a, b)) = lv.split_once("..") {
                let (a, b) = (parse_date(a, now)?, parse_date(b, now)?);
                return Some(range(col, Some(a.0), Some(b.1), format!("{what} {} – {}", a.2, b.2)));
            }
            let (op, rest) = split_op(&lv);
            let (a, b, l) = parse_date(rest, now)?;
            Some(match op {
                Op::Eq => range(col, Some(a), Some(b), format!("{what} {l}")),
                Op::Gt => range(col, Some(b), None, format!("{what} after {l}")),
                Op::Ge => range(col, Some(a), None, format!("{what} since {l}")),
                Op::Lt => range(col, None, Some(a), format!("{what} before {l}")),
                Op::Le => range(col, None, Some(b), format!("{what} up to {l}")),
            })
        }
        _ => None,
    }
}

/// One token → a condition (None: nothing to search for).
fn token_cond(tok: &str, now: DateTime<Local>) -> Option<Cond> {
    if let Some((field, value)) = tok.split_once(':') {
        let f = fold(field);
        if !f.is_empty() && !f.starts_with('"') && f.chars().all(|c| c.is_ascii_alphabetic() || c == '_') {
            if let Some(c) = field_cond(&f, value, now) {
                return Some(c);
            }
            // a known field with a value we don't understand: say so instead of silently searching the text
            const KNOWN: &[&str] = &["kind", "type", "is", "ext", "size", "date", "modified", "created", "taken", "duration", "length", "res", "resolution", "width", "height", "rating", "tag", "name", "folder", "in", "fav"];
            if KNOWN.contains(&f.as_str()) {
                return Some(Cond { sql: "1".into(), params: vec![], label: format!("{tok} (not understood, ignored)"), kind: "unknown" });
            }
        }
    }
    let t = unquote(tok);
    if t.trim().is_empty() {
        return None;
    }
    if !tok.starts_with('"') && t.contains(['*', '?']) {
        return Some(wildcard_cond(&t));
    }
    text_cond("rel_path", tok, "")
}

/// The folded text of an expression; rel_path has it stored.
fn folded(col_expr: &str) -> String {
    if col_expr == "rel_path" {
        "COALESCE(search_key, qg_fold(rel_path))".into()
    } else {
        format!("qg_fold({col_expr})")
    }
}

pub fn compile(input: &str, now: DateTime<Local>) -> Compiled {
    let mut out = Compiled::default();
    // OR-groups: each inner Vec is one alternative set; groups are AND-ed
    let mut groups: Vec<Vec<Cond>> = vec![];
    let mut join_next = false;
    for tok in tokenize(input) {
        if tok == "OR" || tok == "||" || tok == "|" {
            join_next = !groups.is_empty();
            continue;
        }
        if tok == "AND" || tok == "&&" {
            continue;
        }
        let (neg, body) = if let Some(b) = tok.strip_prefix('-').filter(|b| !b.is_empty()) {
            (true, b.to_string())
        } else if tok.len() > 4 && tok.starts_with("NOT:") {
            (true, tok[4..].to_string())
        } else {
            (false, tok.clone())
        };
        let Some(mut c) = token_cond(&body, now) else {
            continue;
        };
        if neg {
            c.sql = format!("NOT ({})", c.sql);
            c.label = format!("not {}", c.label);
            c.kind = "exclude";
        }
        if join_next {
            groups.last_mut().unwrap().push(c);
            join_next = false;
        } else {
            groups.push(vec![c]);
        }
    }
    for g in groups {
        if g.len() == 1 {
            let c = g.into_iter().next().unwrap();
            out.chips.push(Chip { kind: c.kind.into(), label: c.label });
            out.clauses.push(c.sql);
            out.params.extend(c.params);
        } else {
            out.chips.push(Chip { kind: "text".into(), label: g.iter().map(|c| c.label.as_str()).collect::<Vec<_>>().join(" or ") });
            out.clauses.push(format!("({})", g.iter().map(|c| format!("({})", c.sql)).collect::<Vec<_>>().join(" OR ")));
            for c in g {
                out.params.extend(c.params);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 23, 15, 0, 0).unwrap()
    }

    /// An in-memory library with these (rel_path, size, duration, w, h, modified, favorite, type).
    fn db(rows: &[(&str, i64, Option<i64>, i64, i64, i64, i64, &str)]) -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        register(&c).unwrap();
        c.execute_batch(
            "CREATE TABLE media (id INTEGER PRIMARY KEY, rel_path TEXT, filename TEXT, folder_rel_path TEXT, file_size INTEGER, duration_ms INTEGER,
               width INTEGER, height INTEGER, modified_time INTEGER, created_time INTEGER, date_taken INTEGER, favorite INTEGER, rating INTEGER, media_type TEXT,
               search_key TEXT);
             CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE media_tags (media_id INTEGER, tag_id INTEGER);",
        )
        .unwrap();
        for (i, r) in rows.iter().enumerate() {
            let (folder, name) = r.0.rsplit_once('/').unwrap_or(("", r.0));
            c.execute(
                "INSERT INTO media VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,NULL,?10,0,?11,NULL)",
                rusqlite::params![i as i64 + 1, r.0, name, folder, r.1, r.2, r.3, r.4, r.5, r.6, r.7],
            )
            .unwrap();
        }
        c
    }

    fn find(c: &rusqlite::Connection, q: &str) -> Vec<String> {
        let comp = compile(q, now());
        let w = if comp.clauses.is_empty() { "1".to_string() } else { comp.clauses.join(" AND ") };
        let mut st = c.prepare(&format!("SELECT filename FROM media WHERE {w} ORDER BY id")).unwrap();
        st.query_map(rusqlite::params_from_iter(comp.params.iter()), |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn sample() -> rusqlite::Connection {
        let day = |d: u32| local_ms(NaiveDate::from_ymd_opt(2026, 10, d).unwrap()) + 3_600_000;
        db(&[
            ("Trips/2024 Đà Lạt/beach sunset.mp4", 300 << 20, Some(95_000), 1920, 1080, day(21), 1, "video"),
            ("Trips/2024 Đà Lạt/IMG_0001.jpg", 3 << 20, None, 4000, 3000, day(1), 0, "photo"),
            ("Family/Nguyễn Văn Đặng.png", 200 << 10, None, 1080, 1920, local_ms(NaiveDate::from_ymd_opt(2025, 5, 17).unwrap()), 0, "photo"),
            ("Clips/funny cat.mov", 2 << 30, Some(40 * 60_000), 3840, 2160, day(23), 1, "video"),
            ("Clips/cat dance.gif", 5 << 20, Some(4_000), 480, 480, day(20), 0, "animated"),
        ])
    }

    #[test]
    fn words_any_order_accents_and_folders() {
        let c = sample();
        assert_eq!(find(&c, "sunset beach"), ["beach sunset.mp4"]);
        assert_eq!(find(&c, "dang"), ["Nguyễn Văn Đặng.png"]);
        assert_eq!(find(&c, "NGUYEN van"), ["Nguyễn Văn Đặng.png"]);
        assert_eq!(find(&c, "da lat"), ["beach sunset.mp4", "IMG_0001.jpg"]);
        assert_eq!(find(&c, "\"cat dance\""), ["cat dance.gif"]);
        assert_eq!(find(&c, "cat -funny"), ["cat dance.gif"]);
        assert_eq!(find(&c, "sunset OR dance"), ["beach sunset.mp4", "cat dance.gif"]);
        assert_eq!(find(&c, "IMG_*.jpg"), ["IMG_0001.jpg"]);
        assert_eq!(find(&c, "*.mov"), ["funny cat.mov"]);
        assert_eq!(find(&c, "100%"), Vec::<String>::new());
    }

    #[test]
    fn stored_keys_match_the_same_and_reset_on_rename() {
        let c = sample();
        prepare_schema(&c).unwrap();
        assert_eq!(backfill(&c).unwrap(), 5);
        assert_eq!(find(&c, "dang"), ["Nguyễn Văn Đặng.png"]);
        c.execute("UPDATE media SET rel_path = 'Family/Trần Thị Hoà.png', filename = 'Trần Thị Hoà.png' WHERE id = 3", []).unwrap();
        let key: Option<String> = c.query_row("SELECT search_key FROM media WHERE id = 3", [], |r| r.get(0)).unwrap();
        assert_eq!(key, None);
        assert_eq!(find(&c, "tran hoa"), ["Trần Thị Hoà.png"]); // still found before the next backfill
        assert_eq!(backfill(&c).unwrap(), 1);
        assert_eq!(find(&c, "tran hoa"), ["Trần Thị Hoà.png"]);
        assert!(find(&c, "dang").is_empty());
    }

    #[test]
    fn explorer_filters() {
        let c = sample();
        assert_eq!(find(&c, "kind:video"), ["beach sunset.mp4", "funny cat.mov"]);
        assert_eq!(find(&c, "is:gif"), ["cat dance.gif"]);
        assert_eq!(find(&c, "ext:mov,gif"), ["funny cat.mov", "cat dance.gif"]);
        assert_eq!(find(&c, "size:>100mb"), ["beach sunset.mp4", "funny cat.mov"]);
        assert_eq!(find(&c, "size:huge"), ["funny cat.mov"]);
        assert_eq!(find(&c, "size:1mb..10mb"), ["IMG_0001.jpg", "cat dance.gif"]);
        assert_eq!(find(&c, "duration:>1m"), ["beach sunset.mp4", "funny cat.mov"]);
        assert_eq!(find(&c, "duration:long"), ["funny cat.mov"]);
        assert_eq!(find(&c, "duration:<0:10"), ["cat dance.gif"]);
        assert_eq!(find(&c, "res:4k"), ["IMG_0001.jpg", "funny cat.mov"]); // 4000×3000 is 4K-class too
        assert_eq!(find(&c, "res:>=1080p"), ["beach sunset.mp4", "IMG_0001.jpg", "Nguyễn Văn Đặng.png", "funny cat.mov"]);
        assert_eq!(find(&c, "is:portrait"), ["Nguyễn Văn Đặng.png"]);
        assert_eq!(find(&c, "is:fav cat"), ["funny cat.mov"]);
        assert_eq!(find(&c, "date:today"), ["funny cat.mov"]);
        assert_eq!(find(&c, "date:thisweek"), ["beach sunset.mp4", "funny cat.mov", "cat dance.gif"]); // Mon 19 – Fri 23
        assert_eq!(find(&c, "date:2025"), ["Nguyễn Văn Đặng.png"]);
        assert_eq!(find(&c, "date:17/5/2025"), ["Nguyễn Văn Đặng.png"]);
        assert_eq!(find(&c, "date:<2026-10"), ["Nguyễn Văn Đặng.png"]);
        assert_eq!(find(&c, "folder:clips -kind:video"), ["cat dance.gif"]);
        assert_eq!(find(&c, "name:cat"), ["funny cat.mov", "cat dance.gif"]);
        assert_eq!(find(&c, "trips"), ["beach sunset.mp4", "IMG_0001.jpg"]);
    }

    #[test]
    fn chips_say_how_it_was_understood() {
        let comp = compile("beach size:>100mb date:thisweek -cat size:banana", now());
        let labels: Vec<_> = comp.chips.iter().map(|c| (c.kind.as_str(), c.label.as_str())).collect();
        assert_eq!(
            labels,
            [("text", "beach"), ("filter", "size over 100 MB"), ("filter", "modified this week"), ("exclude", "not cat"), ("unknown", "size:banana (not understood, ignored)")]
        );
        // a colon in ordinary text is just text
        assert_eq!(compile("12:30 video", now()).chips[0].label, "12:30");
    }

    #[test]
    fn parsing_helpers() {
        assert_eq!(parse_size("1.5GB"), Some(1_610_612_736));
        assert_eq!(parse_duration("1h30m"), Some(5_400_000));
        assert_eq!(parse_duration("90"), Some(90_000));
        assert_eq!(parse_duration("2:05"), Some(125_000));
        assert_eq!(parse_duration("500ms"), Some(500));
        assert_eq!(fold("Đặng HOÀ Ê"), "dang hoa e");
    }

    /// 100k rows, mostly ASCII names: a search must stay quick.
    #[test]
    fn fast_on_a_big_library() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        register(&c).unwrap();
        c.execute_batch("CREATE TABLE media (id INTEGER PRIMARY KEY, rel_path TEXT, filename TEXT, folder_rel_path TEXT, search_key TEXT)").unwrap();
        {
            let tx = c.unchecked_transaction().unwrap();
            let mut st = tx.prepare("INSERT INTO media (rel_path, filename, folder_rel_path) VALUES (?1, ?2, ?3)").unwrap();
            for i in 0..100_000 {
                let folder = if i % 7 == 0 { format!("Ảnh gia đình/Năm {}", 2000 + i % 25) } else { format!("Downloads/Videos/batch {}", i % 300) };
                let name = format!("IMG_{i:06}_holiday clip.mp4");
                st.execute(rusqlite::params![format!("{folder}/{name}"), name, folder]).unwrap();
            }
            drop(st);
            tx.commit().unwrap();
        }
        prepare_schema(&c).unwrap();
        let t0 = std::time::Instant::now();
        backfill(&c).unwrap();
        println!("backfill 100k: {:?}", t0.elapsed());
        for q in ["holiday 2017", "gia dinh", "nothingmatches"] {
            let comp = compile(q, now());
            let t0 = std::time::Instant::now();
            let n: i64 = c.query_row(&format!("SELECT COUNT(*) FROM media WHERE {}", comp.clauses.join(" AND ")), rusqlite::params_from_iter(comp.params.iter()), |r| r.get(0)).unwrap();
            let el = t0.elapsed();
            println!("{q:?}: {n} rows in {el:?}");
            assert!(el.as_millis() < if cfg!(debug_assertions) { 1500 } else { 300 }, "{q}: {el:?}");
        }
    }
}
