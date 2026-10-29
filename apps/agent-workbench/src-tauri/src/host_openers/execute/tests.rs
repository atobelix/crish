//! 宿主默认应用打开：红线拦截 / 注入面 / 可执行后缀 SSOT / 快捷方式解析。

use super::*;

#[test]
fn test_host_opener_blocks_eleven_red_line_targets() {
    let red_lines = vec![
        "rm -rf /",
        "rm -rf /*",
        "rm --no-preserve-root -rf /",
        "dd if=/dev/zero of=/dev/sda",
        "dd if=/dev/random of=/dev/sdb",
        "mkfs.ext4 /dev/sda",
        "Remove-Item -Recurse -Path C:\\",
        "Remove-Item -Recurse D:\\",
        "format C:",
        "del /f C:\\",
        "rd /s C:\\",
    ];

    for target in red_lines {
        let res = open_path_with_default_app(target.to_string());
        assert!(
            res.is_err(),
            "Expected open_path_with_default_app to block red line target `{}`",
            target
        );
        let err = res.unwrap_err();
        match err {
            CoreError::InvalidInput(detail) => {
                assert!(
                    detail.contains("InvalidCommand"),
                    "detail should contain InvalidCommand: {detail}"
                );
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }
}

#[test]
fn to_core_error_maps_permission_denied_to_invalid_input() {
    let e = host_opener_error(
        "PermissionDenied",
        "Command blocked by safety red-line gatekeeper (InvalidCommand)",
        None,
        None,
    );
    match to_core_error(e) {
        CoreError::InvalidInput(msg) => assert!(msg.contains("InvalidCommand")),
        other => panic!("expected InvalidInput, got {other:?}"),
    }
}

#[test]
fn to_core_error_keeps_code_for_other_errors() {
    let e = host_opener_error(
        "host-opener-spawn-failed",
        "Failed to launch host opener",
        None,
        None,
    );
    match to_core_error(e) {
        CoreError::Internal(msg) => assert!(msg.contains("host-opener-spawn-failed")),
        other => panic!("expected Internal, got {other:?}"),
    }
}

/// P1-S5 红测试：含 cmd 元字符（`&`/`|`）的已存在路径不得放行——
/// `cmd /C start "" <target>` 会被 cmd 二次解释（`a&whoami` 拆为
/// `start a` + `whoami` 两条命令）。修复语义：拒绝该类路径。
// 测试临时目录清理豁免（clippy.toml「测试代码临时目录清理」豁免面）
#[allow(clippy::disallowed_methods)]
#[test]
fn open_path_with_default_app_rejects_metachar_targets() {
    let dir = std::env::temp_dir().join(format!("conex-opener-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    for name in [
        "a&whoami",
        "a&whoami.txt",
        "a&&whoami",
        "b|whoami",
        "c^whoami",
        "(evil)",
    ] {
        let file = dir.join(name);
        let _ = std::fs::write(&file, b"x");
        let target = file.to_string_lossy().to_string();
        let res = open_path_with_default_app(target.clone());
        assert!(
            res.is_err(),
            "含 cmd 元字符的路径必须拒绝（F6-02 注入面）：`{target}`"
        );
        let err = res.unwrap_err();
        match err {
            CoreError::InvalidInput(detail) => {
                assert!(
                    detail.contains("InvalidCommand"),
                    "detail should contain InvalidCommand: {detail}"
                );
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }
    // 测试临时目录清理（走 test 豁免面，产物为测试自建）
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn open_path_blocks_executable_extensions_ssot() {
    // 后缀拦截先于存在性检查：即便文件不存在也应因可执行策略失败
    for name in [
        "run.exe",
        "setup.bat",
        "tool.CMD",
        "install.msi",
        "x.ps1",
        "a.vbs",
        "b.com",
        "c.sh",
        "d.bin",
        "scripts/run.ps1:12",
        // Windows 可执行变体（E1）
        "e.scr",
        "f.pif",
        "g.hta",
        "h.jse",
        "i.vbe",
        "j.wsf",
        "k.wsh",
        "l.msc",
        "m.jar",
    ] {
        let res = open_path_with_default_app(name.to_string());
        assert!(res.is_err(), "executable suffix must be blocked: {name}");
        let msg = format!("{:?}", res.unwrap_err());
        assert!(
            msg.contains("blocked executable extension"),
            "expected executable SSOT error for {name}, got {msg}"
        );
    }
    // 非可执行后缀不应被本策略拦截（可能因路径不存在失败，但错误码不同）
    let res = open_path_with_default_app("readme.md".to_string());
    assert!(res.is_err());
    let err = res.unwrap_err();
    let msg = format!("{err:?}");
    assert!(
        !msg.contains("blocked executable extension"),
        "readme.md must not hit executable SSOT: {msg}"
    );
}

#[cfg(windows)]
#[test]
fn shortcut_target_must_be_an_application_not_a_script_host() {
    assert!(is_safe_shortcut_executable(Path::new("Editor.EXE")));
    for blocked in [
        "powershell.exe",
        "pwsh.exe",
        "cmd.exe",
        "wscript.exe",
        "cscript.exe",
        "python.exe",
        "node.exe",
        "rundll32.exe",
    ] {
        assert!(
            !is_safe_shortcut_executable(Path::new(blocked)),
            "shortcut must not launch command or script host {blocked}"
        );
    }
    assert!(!is_safe_shortcut_executable(Path::new("editor.cmd")));
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn create_test_shortcut(link_path: &Path, target: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::{Interface, PCWSTR},
        Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        Win32::UI::Shell::{IShellLinkW, ShellLink},
    };

    let link_path_wide = link_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    std::thread::spawn(move || {
        let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        assert!(init.is_ok(), "COM initialization: {init:?}");
        struct ComApartment;
        impl Drop for ComApartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let _apartment = ComApartment;
        let link: IShellLinkW = unsafe {
            CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).expect("create Shell Link")
        };
        unsafe { link.SetPath(PCWSTR(target.as_ptr())) }.expect("set shortcut target");
        let persist: IPersistFile = link.cast().expect("query IPersistFile");
        unsafe { persist.Save(PCWSTR(link_path_wide.as_ptr()), true) }.expect("save shortcut");
    })
    .join()
    .expect("shortcut creation thread");
}

#[cfg(windows)]
#[test]
fn resolves_shortcut_target_with_windows_shell_link_api() {
    let temp = tempfile::tempdir().expect("temporary directory");
    let shortcut = temp.path().join("editor.lnk");
    let target = std::env::current_exe().expect("current executable");
    let expected = target.canonicalize().expect("canonical executable");
    create_test_shortcut(&shortcut, &target);

    let resolved = resolve_windows_shortcut_target(&shortcut)
        .expect("shortcut target resolution")
        .canonicalize()
        .expect("canonical shortcut target");
    assert_eq!(resolved, expected);
}
