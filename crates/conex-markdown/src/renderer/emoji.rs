//! GFM Emoji 短代码翻译（默认关闭）。
//!
//! AGENTS §21 禁止 UI Emoji；内容层的短代码翻译也默认关闭，避免与界面
//! 「零 Emoji」纪律冲突。若产品未来明确开启，必须前后端共读同一默认值。

use std::borrow::Cow;

/// 默认关闭；开启时必须同步产品决策与前端默认，禁止单端开启。
pub const GFM_EMOJI_SHORTCODES_DEFAULT: bool = false;

/// GFM Emoji 短代码核心字典映射（编译期常量跳转表）。
#[inline(always)]
pub fn lookup_gfm_emoji(name: &str) -> Option<&'static str> {
    match name {
        "white_check_mark" => Some("✅"),
        "heavy_check_mark" => Some("✔️"),
        "check" => Some("✓"),
        "x" => Some("❌"),
        "negative_squared_cross_mark" => Some("❎"),
        "ballot_box_with_check" => Some("☑️"),
        "warning" => Some("⚠️"),
        "rotating_light" => Some("🚨"),
        "stop_sign" => Some("🛑"),
        "exclamation" => Some("❗"),
        "question" => Some("❓"),
        "bulb" => Some("💡"),
        "bug" => Some("🐛"),
        "wrench" => Some("🔧"),
        "gear" => Some("⚙️"),
        "package" => Some("📦"),
        "rocket" => Some("🚀"),
        "tada" => Some("🎉"),
        "sparkles" => Some("✨"),
        "fire" => Some("🔥"),
        "zap" => Some("⚡"),
        "memo" | "pencil" => Some("📝"),
        "pencil2" => Some("✏️"),
        "bookmark" => Some("🔖"),
        "link" => Some("🔗"),
        "lock" => Some("🔒"),
        "unlock" => Some("🔓"),
        "info" => Some("ℹ️"),
        "+1" | "thumbsup" => Some("👍"),
        "-1" | "thumbsdown" => Some("👎"),
        "heart" => Some("❤️"),
        "star" => Some("⭐"),
        "star2" => Some("🌟"),
        "100" => Some("💯"),
        "eyes" => Some("👀"),
        "speech_balloon" => Some("💬"),
        "white_circle" => Some("⚪"),
        "black_circle" => Some("⚫"),
        "red_circle" => Some("🔴"),
        "blue_circle" | "large_blue_circle" => Some("🔵"),
        "green_circle" => Some("🟢"),
        "yellow_circle" => Some("🟡"),
        "arrow_right" => Some("➡️"),
        "arrow_left" => Some("⬅️"),
        "arrow_up" => Some("⬆️"),
        "arrow_down" => Some("⬇️"),
        "soon" => Some("🔜"),
        "top" => Some("🔝"),
        "computer" => Some("💻"),
        "hourglass" => Some("⌛"),
        "hourglass_flowing_sand" => Some("⏳"),
        "apple" => Some("🍎"),
        "penguin" => Some("🐧"),
        _ => None,
    }
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符（受默认开关约束）。
pub fn translate_gfm_emoji(text: &str) -> String {
    translate_gfm_emoji_with(text, GFM_EMOJI_SHORTCODES_DEFAULT)
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符 — 零拷贝 Cow 版。
pub fn translate_gfm_emoji_cow<'a>(text: &'a str) -> Cow<'a, str> {
    translate_gfm_emoji_with_cow(text, GFM_EMOJI_SHORTCODES_DEFAULT)
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符。
pub fn translate_gfm_emoji_with(text: &str, enabled: bool) -> String {
    translate_gfm_emoji_with_cow(text, enabled).into_owned()
}

/// 将文本中的 GFM Emoji 短代码转义为 Unicode 字符 — 零拷贝 Cow 版。
pub fn translate_gfm_emoji_with_cow<'a>(text: &'a str, enabled: bool) -> Cow<'a, str> {
    if !enabled || !text.contains(':') {
        return Cow::Borrowed(text);
    }

    let mut out = String::with_capacity(text.len());
    let mut last_idx = 0;
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == b':' {
            let start = i;
            let mut j = i + 1;
            let mut valid = false;
            while j < len && (j - start) <= 33 {
                let b = bytes[j];
                if b == b':' {
                    if j > start + 1 {
                        valid = true;
                    }
                    break;
                }
                if !(b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'_'
                    || b == b'+'
                    || b == b'-')
                {
                    break;
                }
                j += 1;
            }

            if valid && j < len && bytes[j] == b':' {
                let key = &text[start + 1..j];
                if let Some(emoji) = lookup_gfm_emoji(key) {
                    out.push_str(&text[last_idx..start]);
                    out.push_str(emoji);
                    i = j + 1;
                    last_idx = i;
                    continue;
                }
            }
        }
        i += 1;
    }

    if last_idx == 0 {
        return Cow::Borrowed(text);
    }
    if last_idx < len {
        out.push_str(&text[last_idx..]);
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_off() {
        const {
            assert!(!GFM_EMOJI_SHORTCODES_DEFAULT);
        }
        assert_eq!(
            translate_gfm_emoji("hello :white_check_mark: world"),
            "hello :white_check_mark: world"
        );
        assert_eq!(translate_gfm_emoji(":rocket::tada:"), ":rocket::tada:");
    }

    #[test]
    fn translation_when_enabled() {
        assert_eq!(
            translate_gfm_emoji_with("hello :white_check_mark: world", true),
            "hello ✅ world"
        );
        assert_eq!(translate_gfm_emoji_with(":x:", true), "❌");
        assert_eq!(
            translate_gfm_emoji_with("http://foo.bar", true),
            "http://foo.bar"
        );
        assert_eq!(translate_gfm_emoji_with(":::", true), ":::");
        assert_eq!(
            translate_gfm_emoji_with(":unknown_code:", true),
            ":unknown_code:"
        );
        assert_eq!(translate_gfm_emoji_with(":rocket::tada:", true), "🚀🎉");
        assert_eq!(
            translate_gfm_emoji_with("中文:rocket:测试", true),
            "中文🚀测试"
        );
        assert_eq!(translate_gfm_emoji_with(":rocket:", false), ":rocket:");
        assert_eq!(lookup_gfm_emoji("fire"), Some("🔥"));
        assert_eq!(lookup_gfm_emoji("nonexistent"), None);
    }
}
