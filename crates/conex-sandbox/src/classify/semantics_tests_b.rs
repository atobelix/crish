use crate::classify::dangerous::analyze_token_danger;
use crate::classify::redline::ClassSignal;
use crate::lex::split_command_args_normalized;
use crate::powershell::is_ps_encoded_command_flag;
use crate::CommandClass;

/// 测试观察结构。字段名与旧断言一致，数据来自唯一的 assess。
#[derive(Debug)]
struct View {
    overall_class: CommandClass,
    delete_targets: Vec<String>,
    has_indirect_delete: bool,
}

fn analyze(command_line: &str) -> View {
    let assessed = crate::assess(command_line);
    View {
        overall_class: assessed.overall,
        delete_targets: assessed.delete_targets,
        has_indirect_delete: assessed.has_indirect_delete,
    }
}

fn split_command_args(segment: &str) -> (String, Vec<String>) {
    split_command_args_normalized(segment)
}

#[test]
fn win_style_flags_not_collected_as_targets() {
    // ML3：rd /s /q、del /f /q 等 Windows 风格开关不入 targets，盘符路径保持原样
    let a = analyze("rd /s /q C:\\x");
    assert_eq!(a.delete_targets, vec!["C:\\x".to_string()]);
    // 开关仍参与递归/强制判定：rd /s /q C:\ 维持红线（:806 锚点口径不回归）
    assert_eq!(
        analyze("rd /s /q C:\\").overall_class,
        CommandClass::Redline
    );
    let c = analyze("del /f /q C:\\x\\a.txt");
    assert_eq!(c.delete_targets, vec!["C:\\x\\a.txt".to_string()]);
    // Unix 绝对路径不受影响：/tmp/x 仍入 targets
    let u = analyze("rm -f /tmp/x");
    assert!(u.delete_targets.iter().any(|t| t == "/tmp/x"));
}

#[test]
fn trailing_backslash_preserved() {
    // 行尾孤反斜杠（cd /d C:\，:866 用例形态）不再吞字符：拆参后反斜杠保留
    let (_, args) = split_command_args("cd /d C:\\");
    assert_eq!(args, vec!["/d".to_string(), "C:\\".to_string()]);
}

// ===== 12-T-PD-04：PowerShell scriptblock 删除形态（A2-M2 + ML5）=====

#[test]
fn foreach_object_scriptblock_delete_flagged() {
    // 管道 + scriptblock 主形态：ForEach-Object { Remove-Item $_ }
    // 修复前无 { 主形态识别，整链判 Normal（间接删除盲区）
    let a = analyze("Get-ChildItem | ForEach-Object { Remove-Item $_ }");
    assert!(
        a.has_indirect_delete,
        "scriptblock 内层 Remove-Item 必须置间接删除标记"
    );
    // 判定语义不变：内层 DeleteShape 不升级整体分类，保持 Indirect（对齐 :829 契约）
    assert_eq!(a.overall_class, CommandClass::Indirect);
    // 无空格紧凑形态：{Remove-Item $_} 首尾花括号一体剥除
    let b = analyze("ForEach-Object {Remove-Item $_}");
    assert!(b.has_indirect_delete);
    // 管道变量形态：$_.FullName 等按普通 token 保留
    let c = analyze("gci | ForEach-Object { Remove-Item -Path $_.FullName -Force }");
    assert!(c.has_indirect_delete);
}

#[test]
fn foreach_object_scriptblock_normal_not_flagged() {
    // 非删除 scriptblock 不误报：内层 Normal 不置标记
    let a = analyze("Get-ChildItem | ForEach-Object { Write-Output $_ }");
    assert!(!a.has_indirect_delete);
    assert_eq!(a.overall_class, CommandClass::Indirect);
    // 空 scriptblock 与纯变量形态同样不误报
    let b = analyze("ForEach-Object { }");
    assert!(!b.has_indirect_delete);
    let c = analyze("ForEach-Object { $_ }");
    assert!(!c.has_indirect_delete);
}

#[test]
fn foreach_object_dash_process_scriptblock_flagged() {
    // -Process 显式参数形态：修复前只取其后单个 token，{ Remove-Item 拆开后漏判
    let a = analyze("ForEach-Object -Process { Remove-Item $_ }");
    assert!(a.has_indirect_delete);
    assert_eq!(a.overall_class, CommandClass::Indirect);
    // -Process 后剩余全部参数 join（对齐 bash -c rest 拼接先例），多 token 不丢
    let b = analyze("ForEach-Object -Process { Remove-Item -Path $_ -Force }");
    assert!(b.has_indirect_delete);
    // -Process 后无 scriptblock 的普通表达式不误报
    let c = analyze("ForEach-Object -Process { Write-Output 'hi' }");
    assert!(!c.has_indirect_delete);
}

#[test]
fn powershell_exe_command_delete_flagged() {
    // ML5：normalize_command 去 .exe 扩展名（大小写不敏感）——
    // powershell.exe / cmd.exe / del.exe 形态一并命中既有清单
    let a = analyze("powershell.exe -Command 'Remove-Item C:\\temp\\a.txt'");
    assert!(a.has_indirect_delete);
    assert_eq!(a.overall_class, CommandClass::Indirect);
    let b = analyze("cmd.exe /c del C:\\temp\\a.txt");
    assert!(b.has_indirect_delete);
    let c = analyze("del.exe C:\\temp\\a.txt");
    assert_eq!(c.overall_class, CommandClass::DeleteShape);
    assert!(c.delete_targets.iter().any(|t| t == "C:\\temp\\a.txt"));
    // 扩展名大小写变体：PowerShell.EXE
    let d = analyze("powershell.EXE -Command 'Remove-Item x'");
    assert!(d.has_indirect_delete);
    // 带路径前缀形态：C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
    let e = analyze(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command 'Remove-Item x'",
    );
    assert!(e.has_indirect_delete);
}

#[test]
fn pipeline_direct_remove_item_detected() {
    // 管道删除整体识别：管道末段裸 Remove-Item（无位置参数，目标走管道输入）
    // 仍命中删除形态，供 S4 删除形态重定向接管
    let a = analyze("Get-ChildItem C:\\x | Remove-Item -Force");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(!a.has_indirect_delete);
}

#[test]
fn scriptblock_compound_delete_detected() {
    // scriptblock 内复合命令：join 后由 analyze 自然拆段（; 拆段）
    let a = analyze("ForEach-Object { Remove-Item x; Write-Output ok }");
    assert!(a.has_indirect_delete);
    // 复合链整体识别：scriptblock 与其它段并存时标记仍置位；
    // 整体分类按优先级判定（含间接删除形态为 Indirect）
    let b = analyze("cd x && ForEach-Object { Remove-Item $_ }");
    assert!(b.has_indirect_delete);
    assert_eq!(b.overall_class, CommandClass::Indirect);
}

// ===== Unit 5.1：词法反混淆与动态 AST 门禁专项测试 =====

#[test]
fn test_split_command_args_normalized_backticks() {
    // 反引号混淆剥离：r`i -> ri, R`em`ove-Item -> Remove-Item
    let (cmd1, args1) = split_command_args_normalized("r`i C:\\ -Recurse -Force");
    assert_eq!(cmd1, "ri");
    assert_eq!(args1, vec!["C:\\", "-Recurse", "-Force"]);

    let (cmd2, args2) = split_command_args_normalized("R`em`ove-Item C:\\ -Force -Recurse");
    assert_eq!(cmd2, "Remove-Item");
    assert_eq!(args2, vec!["C:\\", "-Force", "-Recurse"]);

    // 双引号内反引号转义：`"r`i"` -> `"ri"`
    let (cmd3, _) = split_command_args_normalized("\"r`i\" C:\\");
    assert_eq!(cmd3, "ri");

    // 单引号内反引号字面量保留
    let (cmd4, args4) = split_command_args_normalized("echo 'r`i'");
    assert_eq!(cmd4, "echo");
    assert_eq!(args4, vec!["r`i"]);
}

#[test]
fn test_is_ps_encoded_command_flag_variants() {
    assert!(is_ps_encoded_command_flag("-enco"));
    assert!(is_ps_encoded_command_flag("-EncodedCommand"));
    assert!(is_ps_encoded_command_flag("-encodedcommand"));
    assert!(is_ps_encoded_command_flag("-e"));
    assert!(is_ps_encoded_command_flag("-E"));
    assert!(is_ps_encoded_command_flag("-enc"));
    assert!(is_ps_encoded_command_flag("/e:cgBtACAALQByAGYAIAAvAA=="));
    assert!(is_ps_encoded_command_flag("-e:cgBtACAALQByAGYAIAAvAA=="));
    assert!(is_ps_encoded_command_flag(
        "-EncodedCommand=cgBtACAALQByAGYAIAAvAA=="
    ));
    assert!(is_ps_encoded_command_flag("/encodedcommand"));

    // 负例
    assert!(!is_ps_encoded_command_flag("-entity"));
    assert!(!is_ps_encoded_command_flag("-exec"));
    assert!(!is_ps_encoded_command_flag("-erroraction"));
    assert!(!is_ps_encoded_command_flag("npm"));
}

#[test]
fn test_analyze_token_danger_dotnet_and_env() {
    assert_eq!(
        analyze_token_danger("[System.Diagnostics.Process]::Start"),
        Some(ClassSignal::Reflection)
    );
    assert_eq!(
        analyze_token_danger("[scriptblock]::create"),
        Some(ClassSignal::Reflection)
    );
    assert_eq!(
        analyze_token_danger("[PowerShell]::Create()"),
        Some(ClassSignal::Reflection)
    );
    assert_eq!(
        analyze_token_danger("$env:comspec"),
        Some(ClassSignal::EnvironmentInterpolation)
    );
    assert_eq!(
        analyze_token_danger("$env:SystemRoot"),
        Some(ClassSignal::EnvironmentInterpolation)
    );
}
