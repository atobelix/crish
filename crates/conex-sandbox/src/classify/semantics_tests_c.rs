use crate::powershell::{
    extract_and_decode_ps_payload, is_ps_encoded_command_flag, is_ps_working_directory_flag,
};
use crate::CommandClass;

/// 测试观察结构。字段名与旧断言一致，数据来自唯一的 assess。
#[derive(Debug)]
struct View {
    overall_class: CommandClass,
    has_indirect_delete: bool,
    decoded_payload: Option<String>,
}

fn analyze(command_line: &str) -> View {
    let assessed = crate::assess(command_line);
    View {
        overall_class: assessed.overall,
        has_indirect_delete: assessed.has_indirect_delete,
        decoded_payload: assessed.decoded_payload,
    }
}

#[test]
fn test_ps_dynamic_reflection_and_call_operator() {
    // [System.Diagnostics.Process]::Start -> Redline
    let a = analyze("[System.Diagnostics.Process]::Start('cmd.exe', '/c del /f /q C:\\*')");
    assert_eq!(a.overall_class, CommandClass::Redline);

    // & $var 动态变量调用 -> Dangerous
    let b = analyze("$x = 'Remove-Item'; & $x C:\\ -Force");
    assert_eq!(b.overall_class, CommandClass::Dangerous);

    // $(whoami) 与 &($code) 作为命令调用 -> Dangerous
    let d = analyze("$(whoami) args");
    assert_eq!(d.overall_class, CommandClass::Dangerous);

    let e = analyze("&($code) args");
    assert_eq!(e.overall_class, CommandClass::Dangerous);

    // % (ForEach-Object) 管道与内层 Remove-Item
    let c = analyze("Get-ChildItem C:\\ | % { Remove-Item $_.FullName -Force }");
    assert!(c.has_indirect_delete);
    assert_eq!(c.overall_class, CommandClass::Indirect);
}

#[test]
fn test_adversarial_obfuscation_and_reflection_semantics() {
    // Section 8.1 对抗用例
    let cases = [
        "r`i C:\\ -Recurse -Force",
        "R`em`ove-Item C:\\ -Force -Recurse",
        "powershell -enco cgBtACAALQByAGYAIAAvAA==",
        "pwsh -e:cgBtACAALQByAGYAIAAvAA==",
        "[System.Diagnostics.Process]::Start('cmd.exe', '/c del /f /q C:\\*')",
        "$x = 'Remove-Item'; & $x C:\\ -Force",
        "Get-ChildItem C:\\ | % { Remove-Item $_.FullName -Force }",
    ];

    for cmd in cases {
        let res = analyze(cmd);
        assert_ne!(
            res.overall_class,
            CommandClass::Normal,
            "混淆/反射命令不能被误判为 Normal: {cmd}"
        );
    }
}

#[test]
fn test_powershell_call_operator_and_indirect_semantics() {
    let indirect_delete_cases = [
        "& cmd /c rmdir /s /q D:\\old",
        "& 'cmd' /c rmdir /s /q D:\\old",
        "& \"cmd.exe\" /c rmdir /s /q D:\\old",
        "& bash -c 'rm -rf /tmp/test'",
        "& bash -c 'rm /tmp/x'",
        "& pwsh -Command \"Remove-Item -Recurse -Force D:\\data\"",
        "& cmd /c Remove-Item D:\\file.txt",
        "Invoke-Command -ScriptBlock { Remove-Item -Recurse D:\\old }",
        "icm -ScriptBlock { rm /tmp/x }",
    ];

    for cmd in indirect_delete_cases {
        let sem = analyze(cmd);
        assert!(
            sem.has_indirect_delete
                || sem.overall_class == CommandClass::DeleteShape
                || sem.overall_class == CommandClass::Redline,
            "命令 {cmd} 必须识别为间接删除或删除形态或红线, 实际: {sem:?}"
        );
    }

    // 6 层嵌套间接调用触发 MAX_RECURSION_DEPTH = 5 深度熔断
    let deep_nested = "Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { Invoke-Command { echo deep } } } } } }";
    let sem_deep = analyze(deep_nested);
    assert_eq!(
        sem_deep.overall_class,
        CommandClass::Dangerous,
        "6层嵌套间接调用必须触发深度熔断 Dangerous"
    );
}

fn b64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        out.push(TABLE[(b0 >> 2) as usize] as char);
        out.push(TABLE[(((b0 & 3) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(((b1 & 0xf) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn to_ps_b64(cmd: &str) -> String {
    let utf16: Vec<u8> = cmd.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    b64_encode(&utf16)
}

#[test]
fn test_is_ps_encoded_command_flag_all_variants() {
    // 正向缩写与变体
    let positive = [
        "-e",
        "-E",
        "-ec",
        "-EC",
        "-eco",
        "-ecom",
        "-en",
        "-enc",
        "-enco",
        "-encode",
        "-encoded",
        "-encodedcommand",
        "-EncodedCommand",
        "/e",
        "/ec",
        "/enc",
        "/enco",
        "/encodedcommand",
        "--ec",
        "--encodedcommand",
        "-ec:",
        "/ec:",
        "-EncodedCommand=",
        "-ec:cgBtACAALQByAGYAIAAvAA==",
        "/encodedcommand:cgBtACAALQByAGYAIAAvAA==",
        "--encodedcommand=cgBtACAALQByAGYAIAAvAA==",
    ];
    for flag in positive {
        assert!(
            is_ps_encoded_command_flag(flag),
            "应识别为 PowerShell 编码命令参数: {flag}"
        );
    }

    // 负向参数（绝不能误判）
    let negative = [
        "-ex",
        "-exec",
        "-executionpolicy",
        "-ExecutionPolicy",
        "-ExecutionPolicy:Bypass",
        "/executionpolicy",
        "-erroraction",
        "-entity",
        "-ea",
        "-w",
        "-windowstyle",
        "-whatif",
        "npm",
        "powershell",
        "pwsh",
        "-help",
    ];
    for flag in negative {
        assert!(
            !is_ps_encoded_command_flag(flag),
            "不应误识别为 PowerShell 编码命令参数: {flag}"
        );
    }
}

#[test]
fn test_is_ps_working_directory_flag_variants() {
    // 正向缩写与变体
    let positive = [
        "-wd",
        "-WD",
        "/wd",
        "/WD",
        "--wd",
        "--WD",
        "-work",
        "-working",
        "-workingdirectory",
        "-WorkingDirectory",
        "/workingdirectory",
        "/WorkingDirectory",
        "--workingdirectory",
        "--WorkingDirectory",
        "-wd:D:\\test",
        "/wd:D:\\test",
        "--workingdirectory=D:\\test",
    ];
    for flag in positive {
        assert!(
            is_ps_working_directory_flag(flag),
            "应识别为 PowerShell WorkingDirectory 参数: {flag}"
        );
    }

    // 负向参数
    let negative = [
        "-w",
        "-windowstyle",
        "-WindowStyle",
        "-whatif",
        "-wait",
        "-where",
        "npm",
        "pwsh",
        "cd",
    ];
    for flag in negative {
        assert!(
            !is_ps_working_directory_flag(flag),
            "不应误识别为 PowerShell WorkingDirectory 参数: {flag}"
        );
    }
}

#[test]
fn test_extract_and_decode_ps_payload() {
    // 1. UTF-16LE 提取与解码
    let b64_utf16 = to_ps_b64("Write-Host hello");
    let args = vec!["powershell".to_string(), "-ec".to_string(), b64_utf16];
    assert_eq!(
        extract_and_decode_ps_payload(&args),
        Some("Write-Host hello".to_string())
    );

    // 2. UTF-8 回退
    let b64_utf8 = b64_encode(b"rm -rf /");
    let args2 = vec!["powershell".to_string(), "-enc".to_string(), b64_utf8];
    assert_eq!(
        extract_and_decode_ps_payload(&args2),
        Some("rm -rf /".to_string())
    );

    // 3. 冒号与等号内联参数
    let inline_colon = format!("-ec:{}", to_ps_b64("Get-Process"));
    assert_eq!(
        extract_and_decode_ps_payload(&["pwsh".to_string(), inline_colon]),
        Some("Get-Process".to_string())
    );

    let inline_eq = format!("--EncodedCommand={}", to_ps_b64("dir"));
    assert_eq!(
        extract_and_decode_ps_payload(&["powershell".to_string(), inline_eq]),
        Some("dir".to_string())
    );

    // 4. 非法 base64 / 缺失 payload
    assert_eq!(
        extract_and_decode_ps_payload(&["powershell".to_string(), "-ec".to_string()]),
        None
    );
    assert_eq!(
        extract_and_decode_ps_payload(&[
            "powershell".to_string(),
            "-ec".to_string(),
            "!!not_base64!!".to_string()
        ]),
        None
    );
}

#[test]
fn test_encoded_command_decoding_semantics() {
    // 1. 内层为 Normal 命令：间接执行判定为 Indirect（非红线/非删除/非CD），并保留 decoded_payload
    let cmd_normal = format!("powershell -ec {}", to_ps_b64("Write-Host 'hello world'"));
    let sem_normal = analyze(&cmd_normal);
    assert_eq!(sem_normal.overall_class, CommandClass::Indirect);
    assert!(!sem_normal.has_indirect_delete);
    assert_eq!(
        sem_normal.decoded_payload.as_deref(),
        Some("Write-Host 'hello world'")
    );

    // 2. 内层为 Redline 命令：识别为 Redline
    let cmd_redline = format!("powershell -enc {}", to_ps_b64("rm -rf /"));
    let sem_redline = analyze(&cmd_redline);
    assert_eq!(sem_redline.overall_class, CommandClass::Redline);
    assert_eq!(sem_redline.decoded_payload.as_deref(), Some("rm -rf /"));

    // 3. 内层为 cd 命令：识别为 Normal
    let cmd_cd = format!("pwsh -EncodedCommand {}", to_ps_b64("cd D:\\data"));
    let sem_cd = analyze(&cmd_cd);
    assert!(
        sem_cd.overall_class == CommandClass::Normal
            || sem_cd.overall_class == CommandClass::Indirect
    );
    assert_eq!(sem_cd.decoded_payload.as_deref(), Some("cd D:\\data"));

    // 4. 内层为 DeleteShape 命令：识别为删除形态/间接删除
    let cmd_del = format!(
        "powershell -ec {}",
        to_ps_b64("Remove-Item C:\\test -Force")
    );
    let sem_del = analyze(&cmd_del);
    assert!(
        sem_del.has_indirect_delete || sem_del.overall_class == CommandClass::DeleteShape,
        "Base64 内层删除形态必须识别: {sem_del:?}"
    );
    assert_eq!(
        sem_del.decoded_payload.as_deref(),
        Some("Remove-Item C:\\test -Force")
    );
}

#[test]
fn test_cd_commands_expansion() {
    // cd 家族命令合法放行（Normal）
    let cd_cases = [
        "Push-Location D:\\project",
        "push-location D:\\project",
        "Pop-Location",
        "pop-location",
        "chdir D:\\project",
        "CHDIR /d D:\\project",
        "pushd D:\\project",
        "popd",
        "Set-Location D:\\project",
        "sl D:\\project",
        "cd D:\\project",
    ];
    for cmd in cd_cases {
        let res = analyze(cmd);
        assert_eq!(
            res.overall_class,
            CommandClass::Normal,
            "CD 命令必须放行为 Normal: {cmd}"
        );
    }
}

#[test]
fn test_indirect_cd_shape_propagation() {
    // 间接执行包裹内含 cd 合法放行
    let indirect_cd_cases = [
        "cmd /c \"cd /d D:\\ && whoami\"",
        "cmd.exe /c \"cd D:\\\"",
        "powershell -Command \"cd D:\\; dir\"",
        "pwsh -Command \"Push-Location D:\\; Get-ChildItem\"",
        "cmd /c \"chdir /d D:\\code\"",
    ];
    for cmd in indirect_cd_cases {
        let res = analyze(cmd);
        assert!(
            res.overall_class == CommandClass::Normal
                || res.overall_class == CommandClass::Indirect,
            "间接执行包裹内的 cd 应该放行: {cmd}, 实际: {res:?}"
        );
    }
}

#[test]
fn test_powershell_working_directory_escape() {
    // -WorkingDirectory / -wd 启动参数目录合法放行
    let wd_cases = [
        "pwsh -wd D:\\",
        "powershell -WorkingDirectory C:\\test -Command \"Get-Process\"",
        "pwsh -wd:D:\\code -Command \"cargo build\"",
        "powershell /wd D:\\",
        "pwsh --workingdirectory=D:\\repo -c \"dir\"",
    ];
    for cmd in wd_cases {
        let res = analyze(cmd);
        assert!(
            res.overall_class == CommandClass::Normal
                || res.overall_class == CommandClass::Indirect,
            "PowerShell -wd 目录切换应该放行: {cmd}, 实际: {res:?}"
        );
    }
}
