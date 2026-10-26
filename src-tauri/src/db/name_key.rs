//! "Similar names" ordering. Every media row stores a normalized grouping key
//! (`name_key`) and the trailing number found in its name (`name_num`);
//! sorting by `(name_key, name_num, filename)` puts files that are named
//! alike next to each other — `IMG_0012.jpg`, `img (3).png`, `IMG-7-edited.mp4`
//! all land in one run — and orders each run the way a person counts.

/// Trailing words that only mark a derived copy of the same thing.
const NOISE_WORDS: &[&str] = &["copy", "edited", "edit", "final"];

/// Key used when a name has no letters at all (e.g. `20240101_123456.mp4`);
/// `~` sorts after every letter, so number-only names collect at the end.
const NO_LETTERS_KEY: &str = "~";

/// Returns `(name_key, name_num)` for a file name.
///
/// * `name_key`: the name without extension, lower-cased, with every digit
///   and separator removed and words joined by single spaces; trailing
///   "copy"/"edited"/"final" words and stray single letters (the `v` of
///   `clip_v2`) are dropped.
/// * `name_num`: the last run of digits in the name (0 if none), so
///   `beach_2` sorts before `beach_10`.
pub fn similar_name_key(filename: &str) -> (String, i64) {
    let stem = match filename.rsplit_once('.') {
        Some((s, ext)) if !s.is_empty() && !ext.is_empty() && ext.len() <= 5 => s,
        _ => filename,
    };
    let lower = stem.to_lowercase();

    let mut words: Vec<String> = vec![];
    let mut word = String::new();
    let mut digits = String::new();
    let mut num: i64 = 0;

    let flush_digits = |digits: &mut String, num: &mut i64| {
        if !digits.is_empty() {
            *num = digits.chars().take(15).collect::<String>().parse().unwrap_or(0);
            digits.clear();
        }
    };

    for ch in lower.chars() {
        if ch.is_ascii_digit() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            digits.push(ch);
            continue;
        }
        flush_digits(&mut digits, &mut num);
        if ch.is_alphabetic() {
            word.push(ch);
        } else if !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
    }
    flush_digits(&mut digits, &mut num);
    if !word.is_empty() {
        words.push(word);
    }

    while words.len() > 1 {
        let last = words.last().unwrap();
        if NOISE_WORDS.contains(&last.as_str()) || last.chars().count() == 1 {
            words.pop();
        } else {
            break;
        }
    }

    let key = words.join(" ");
    (if key.is_empty() { NO_LETTERS_KEY.to_string() } else { key }, num)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_and_separators_do_not_change_the_group() {
        assert_eq!(similar_name_key("IMG_0012.jpg"), ("img".to_string(), 12));
        assert_eq!(similar_name_key("img (3).png"), ("img".to_string(), 3));
        assert_eq!(similar_name_key("Beach-001.mp4"), ("beach".to_string(), 1));
        assert_eq!(similar_name_key("beach_10.mp4").0, similar_name_key("beach_2.jpg").0);
    }

    #[test]
    fn derived_copies_group_with_the_original() {
        assert_eq!(similar_name_key("clip.mp4").0, "clip");
        assert_eq!(similar_name_key("clip - Copy.mp4").0, "clip");
        assert_eq!(similar_name_key("clip-edited-2.mp4"), ("clip".to_string(), 2));
        assert_eq!(similar_name_key("holiday_v2.mp4"), ("holiday".to_string(), 2));
    }

    #[test]
    fn number_only_names_collect_together_at_the_end() {
        let (key, num) = similar_name_key("20240101_123456.mp4");
        assert_eq!(key, "~");
        assert_eq!(num, 123456);
    }

    #[test]
    fn different_names_stay_apart_but_share_prefix_neighbours() {
        assert_ne!(similar_name_key("paris_1.jpg").0, similar_name_key("rome_1.jpg").0);
        assert!(similar_name_key("paris trip 1.jpg").0.starts_with("paris"));
    }

    #[test]
    fn non_ascii_letters_are_kept() {
        assert_eq!(similar_name_key("Ảnh đẹp 5.jpg"), ("ảnh đẹp".to_string(), 5));
    }
}
