//! 路径可执行后缀拦截（与前端 `blockedExecutableExtensions.ts` 对齐）。

/// §4.3 可执行后缀拦截 SSOT（与前端 `blockedExecutableExtensions.ts` 对齐；
/// 门禁 `scripts/check-blocked-executable-ssot.mjs` 静态校验两边一致）。
pub(crate) const BLOCKED_EXECUTABLE_EXTENSIONS: &[&str] = &[
    "exe",
    "bat",
    "cmd",
    "msi",
    "ps1",
    "vbs",
    "com",
    "sh",
    "bin",
    "scr",
    "pif",
    "hta",
    "jse",
    "vbe",
    "wsf",
    "wsh",
    "msc",
    "jar",
    "lnk",
    "reg",
    "url",
    "cpl",
    "msix",
    "appx",
    "docm",
    "xlsm",
    "pptm",
    "xll",
    "xlam",
    "inf",
    "scf",
    "settingcontent-ms",
    "appref-ms",
];

pub(crate) fn extension_of_path(path: &str) -> Option<&str> {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    // 剥离代码行号锚点：name.ext:12 或 name.ext:12:3
    let mut cleaned = base;
    while let Some(i) = cleaned.rfind(':') {
        let rest = &cleaned[i + 1..];
        if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
            cleaned = &cleaned[..i];
            continue;
        }
        break;
    }
    let dot = cleaned.rfind('.')?;
    if dot == 0 || dot + 1 >= cleaned.len() {
        return None;
    }
    Some(&cleaned[dot + 1..])
}

pub(crate) fn is_blocked_executable_path(path: &str) -> bool {
    let Some(ext) = extension_of_path(path) else {
        return false;
    };
    let lower = ext.to_ascii_lowercase();
    BLOCKED_EXECUTABLE_EXTENSIONS.iter().any(|e| *e == lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_of_path_strips_line_anchors() {
        assert_eq!(extension_of_path("a/b/run.EXE"), Some("EXE"));
        assert_eq!(extension_of_path("run.ps1:12"), Some("ps1"));
        assert_eq!(extension_of_path("run.ps1:12:3"), Some("ps1"));
        assert_eq!(extension_of_path("README"), None);
        assert!(is_blocked_executable_path(r"C:\tmp\x.exe"));
        assert!(!is_blocked_executable_path("notes.md"));
    }
}
