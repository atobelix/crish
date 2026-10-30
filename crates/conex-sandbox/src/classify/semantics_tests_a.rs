use crate::CommandClass;

/// 复合段列表的整体分类：按 `&&` 拼成一条命令行交给唯一分析入口。
fn classify_chain(segments: &[String]) -> CommandClass {
    crate::classify::classify_semantics(&segments.join(" && ")).overall
}

/// 测试观察结构。字段名与旧断言一致，数据来自唯一的 assess。
#[derive(Debug)]
struct Seg {
    command: String,
    class: CommandClass,
}

#[derive(Debug)]
struct View {
    segments: Vec<Seg>,
    overall_class: CommandClass,
    delete_targets: Vec<String>,
    git_revert_forms: Vec<String>,
    has_indirect_delete: bool,
}

fn analyze(command_line: &str) -> View {
    let assessed = crate::assess(command_line);
    View {
        segments: assessed
            .segments
            .into_iter()
            .map(|segment| Seg {
                command: segment.program,
                class: segment.class,
            })
            .collect(),
        overall_class: assessed.overall,
        delete_targets: assessed.delete_targets,
        git_revert_forms: assessed.git_revert_forms,
        has_indirect_delete: assessed.has_indirect_delete,
    }
}

#[test]
fn splits_compound_with_and() {
    let a = analyze("echo hi && rm -rf /");
    assert_eq!(a.segments.len(), 2);
    assert_eq!(a.segments[0].command, "echo");
    assert_eq!(a.segments[1].command, "rm");
    assert_eq!(a.segments[1].class, CommandClass::Redline);
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn splits_semicolon_and_pipe() {
    let a = analyze("git status; ls -la | grep foo");
    assert_eq!(a.segments.len(), 3);
    assert_eq!(a.segments[0].command, "git");
    assert_eq!(a.segments[1].command, "ls");
    assert_eq!(a.segments[2].command, "grep");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn indirect_sudo_bash_c_recursive() {
    let a = analyze("sudo bash -c 'rm -rf /'");
    assert_eq!(a.overall_class, CommandClass::Redline);
    assert!(
        a.segments[0].class == CommandClass::Redline
            || a.segments[0].class == CommandClass::Indirect
    );
}

#[test]
fn indirect_eval_recursive() {
    let a = analyze("eval rm -rf /");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn indirect_bash_c_recursive_redline() {
    let a = analyze("bash -c 'rm -rf /'");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn rm_double_dash_dot_is_delete_not_redline() {
    let a = analyze("rm -rf -- ./");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(!a.delete_targets.is_empty());
}

#[test]
fn rm_plain_file_is_delete() {
    let a = analyze("rm -r -f /tmp/x");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(a.delete_targets.contains(&"/tmp/x".to_string()));
}

#[test]
fn remove_item_literal_path() {
    let a = analyze("Remove-Item -LiteralPath 'C:\\x\\y.txt' -Force");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(a.delete_targets.iter().any(|t| t.contains("y.txt")));
}

#[test]
fn git_reset_hard_is_revert() {
    let a = analyze("git reset --hard HEAD~5");
    assert_eq!(a.overall_class, CommandClass::GitRevertShape);
    assert!(!a.git_revert_forms.is_empty());
}

#[test]
fn git_clean_f_is_revert() {
    let a = analyze("git clean -f");
    assert_eq!(a.overall_class, CommandClass::GitRevertShape);
}

#[test]
fn git_stash_drop_is_revert() {
    let a = analyze("git stash drop");
    assert_eq!(a.overall_class, CommandClass::GitRevertShape);
}

#[test]
fn git_restore_source_is_revert() {
    let a = analyze("git restore --source=HEAD~3 src/main.rs");
    assert_eq!(a.overall_class, CommandClass::GitRevertShape);
}

#[test]
fn git_checkout_branch_is_normal() {
    let a = analyze("git checkout main");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn git_checkout_old_ref_is_revert() {
    let a = analyze("git checkout abc1234");
    assert_eq!(a.overall_class, CommandClass::GitRevertShape);
}

#[test]
fn git_status_is_normal() {
    let a = analyze("git status");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn normal_commands_are_normal() {
    assert_eq!(analyze("npm test").overall_class, CommandClass::Normal);
    assert_eq!(analyze("ls -la").overall_class, CommandClass::Normal);
}

#[test]
fn quoted_semicolon_not_split() {
    let a = analyze("echo \"a;b\"");
    assert_eq!(a.segments.len(), 1);
    assert_eq!(a.overall_class, CommandClass::Normal);
}

// ===== PS-01 T1.1：换行拆段（R1 ① 盲区）=====

#[test]
fn splits_real_newline_into_segments() {
    // 换行分隔两命令：printf x\n/bin/rm -rf -- /（真实 \n）拆为 2 段，
    // 第二段 rm 归一后走既有红线判定
    let a = analyze("printf x\n/bin/rm -rf -- /");
    assert_eq!(a.segments.len(), 2);
    assert_eq!(a.segments[1].command, "rm");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn splits_crlf_once_no_empty_segment() {
    // \r\n 双字符只拆一次、不产生空段
    let a = analyze("echo a\r\nrm -rf -- /");
    assert_eq!(a.segments.len(), 2, "\\r\\n 必须只产生一次拆分（无空段）");
    assert_eq!(a.segments[1].class, CommandClass::Redline);
}

#[test]
fn newline_inside_quotes_not_split() {
    // 负例：引号内真实换行不拆段（quote 状态机）
    let a = analyze("echo \"a\nb\"");
    assert_eq!(a.segments.len(), 1);
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn escaped_newline_continuation_not_split() {
    // 负例：`\` + 换行是续行（escaped 状态吞掉），不拆段
    let a = analyze("echo a\\\nb");
    assert_eq!(a.segments.len(), 1);
    assert_eq!(a.overall_class, CommandClass::Normal);
}

// ===== PS-01 T1.2：命令替换/scriptblock 包裹递归（R1 ② 盲区）=====

#[test]
fn cmd_subst_dollar_paren_inner_redline() {
    // $() 命令替换：双引号内也提取（bash 语义）——R1 形态 1
    let a = analyze("echo \"$(rm -rf -- /)\"");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn cmd_subst_nested_recursion() {
    // 嵌套递归：$() 内层再走间接执行（bash -c）红线升级
    let a = analyze("echo \"$(bash -c 'rm -rf -- /')\"");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn backtick_inner_redline() {
    // 反引号命令替换——R1 形态 2
    let a = analyze("echo `rm -rf -- /`");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn scriptblock_inner_delete_upgrades() {
    // {…} scriptblock 内层删除形态 → 段 DeleteShape（删除接管语义保持）
    let a = analyze("echo { Remove-Item C:\\x -Recurse -Force }");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
}

#[test]
fn cmd_subst_inner_delete_upgrades() {
    // $() 内层删除形态（非盘符根）→ 段 DeleteShape
    let a = analyze("echo \"$(rm -rf /tmp/x)\"");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
}

#[test]
fn env_var_ref_not_command_subst() {
    // 负例：变量引用不是命令替换——$HOME / ${PATH} 不提取不误拦
    assert_eq!(analyze("echo $HOME").overall_class, CommandClass::Normal);
    assert_eq!(analyze("echo ${PATH}").overall_class, CommandClass::Normal);
}

#[test]
fn single_quoted_dollar_paren_is_literal() {
    // 负例：单引号内 $() 是字面量，不提取
    let a = analyze("echo '$(rm -rf -- /)'");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn cmd_subst_deep_nesting_no_panic() {
    // 32 层 $() 嵌套（最内层 rm -rf -- /）→ 不 panic 且 Redline
    // （R2 修订：深度上限 16，>16 → Redline）
    let mut cmd = String::from("echo ");
    for _ in 0..32 {
        cmd.push_str("$(");
    }
    cmd.push_str("rm -rf -- /");
    for _ in 0..32 {
        cmd.push(')');
    }
    let a = analyze(&cmd);
    assert_eq!(a.overall_class, CommandClass::Redline);
}

// ===== PS-01 T1.3：iex / Invoke-Expression / Start-Process /
// -EncodedCommand 拦截（R1 ④ 盲区 + R3 修订）=====

#[test]
fn iex_wrapped_rm_redline() {
    // iex 包裹（Invoke-Expression 别名）——R1 形态 5
    let a = analyze("iex 'rm -rf -- /'");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn invoke_expression_wrapped_rm_redline() {
    // Invoke-Expression 包裹——R1 形态 6
    let a = analyze("Invoke-Expression 'rm -rf -- /'");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn iex_case_and_exe_variant() {
    // 大小写变体（IEX）与 .exe 形态（normalize 去 .exe 先例）
    let a = analyze("IEX 'rm -rf -- /'");
    assert_eq!(a.overall_class, CommandClass::Redline);
    let b = analyze("iex.exe 'rm -rf -- /'");
    assert_eq!(b.overall_class, CommandClass::Redline);
}

#[test]
fn start_process_wrapped_rm_redline() {
    // Start-Process 包裹：-ArgumentList 后藏内层命令——R1 形态 7
    let a = analyze("Start-Process cmd -ArgumentList '/c rm -rf -- /'");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn encoded_command_flag_redline() {
    // -EncodedCommand / -e / -enc 三变体（R2 修订样本：
    // cgBtACAALQByAGYAIAAtAC0AIAAvAA== = UTF-16LE base64("rm -rf -- /")）
    let b64 = "cgBtACAALQByAGYAIAAtAC0AIAAvAA==";
    let a = analyze(&format!("powershell -EncodedCommand {b64}"));
    assert_eq!(a.overall_class, CommandClass::Redline);
    let b = analyze(&format!("powershell -e {b64}"));
    assert_eq!(b.overall_class, CommandClass::Redline);
    let c = analyze(&format!("powershell -enc {b64}"));
    assert_eq!(c.overall_class, CommandClass::Redline);
}

#[test]
fn start_process_plain_not_redline() {
    // 负例：Start-Process 无参数列表（普通启动）不误拦
    let a = analyze("Start-Process notepad.exe");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

// ===== PS-01 T1.4：PS 别名归一 + token 级扫描（F3-01 #1）=====

#[test]
fn ps_alias_ri_normalized_delete() {
    // ri（Remove-Item 别名）归一到 remove-item → 删除形态 + 目标提取
    let a = analyze("ri C:\\temp\\f.txt");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(a.delete_targets.contains(&"C:\\temp\\f.txt".to_string()));
}

#[test]
fn ps_alias_ri_drive_root_redline() {
    // ri 盘符根 + 递归/强制 → 红线（先例 semantics.rs:400-421、591）
    let a = analyze("ri C:\\ -Recurse -Force");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn ps_alias_ri_after_newline_redline() {
    // T1.1 + T1.4 合击：换行分隔 + PS 删除别名——R1 形态 4
    let a = analyze("Write-Output x\nri C:\\ -Recurse -Force");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn ps_assignment_token_scan_redline() {
    // 赋值形态 token 级扫描：$x = <删除命令> 盘符根 → 红线
    let a = analyze("$x = Remove-Item C:\\ -Recurse -Force");
    assert_eq!(a.overall_class, CommandClass::Redline);
    let b = analyze("$x = ri C:\\ -Recurse -Force");
    assert_eq!(b.overall_class, CommandClass::Redline);
}

#[test]
fn token_scan_echo_no_false_positive() {
    // 负例：打印白名单段首命令不触发 token 扫描（防 echo rm -rf / 误拦）
    let a = analyze("echo rm -rf /");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn token_scan_plain_args_no_false_positive() {
    // 负例：已知清单段首命令（git）不触发 token 扫描
    let a = analyze("git status -- rm.txt");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn mkfs_is_redline() {
    let a = analyze("mkfs.ext4 /dev/sdb");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn rm_dash_rf_root_redline() {
    let a = analyze("rm -r -f /");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn normalize_path_prefix() {
    let a = analyze("/bin/rm -rf /");
    assert_eq!(a.segments[0].command, "rm");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn windows_drive_root_redline() {
    let a = analyze("rd /s /q C:\\");
    assert_eq!(a.overall_class, CommandClass::Redline);
}

#[test]
fn git_rm_is_delete_shape() {
    let a = analyze("git rm file.txt");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(a.delete_targets.contains(&"file.txt".to_string()));
    assert!(
        a.git_revert_forms.is_empty(),
        "git rm 属删除形态，不计入回退清单"
    );
    assert!(!a.has_indirect_delete);
}

#[test]
fn git_rm_cached_is_delete_shape() {
    // --cached 只解除跟踪不物理删除，仍按删除形态识别（目标为空由命令面兜底）
    let a = analyze("git rm --cached file.txt");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(!a.delete_targets.is_empty());
}

#[test]
fn indirect_delete_wrapper_flagged() {
    let a = analyze("bash -c 'rm -rf tmp/foo'");
    assert!(a.has_indirect_delete, "间接执行内层删除形态必须置标记");
    // 不升级整体分类（保持 Indirect），由命令面（I2-S4）消费该标记拦截
    assert_eq!(a.overall_class, CommandClass::Indirect);
}

#[test]
fn indirect_xargs_rm_flagged() {
    let a = analyze("xargs rm -rf tmp/foo");
    assert!(a.has_indirect_delete);
}

#[test]
fn indirect_normal_inner_not_flagged() {
    let a = analyze("bash -c 'echo hi'");
    assert!(!a.has_indirect_delete);
    assert_eq!(a.overall_class, CommandClass::Indirect);
}

#[test]
fn plain_delete_has_no_indirect_flag() {
    let a = analyze("rm -rf tmp/foo");
    assert!(!a.has_indirect_delete);
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
}

// ===== T-AB-05：禁 cd 语义层 =====

#[test]
fn cd_allowed_as_normal() {
    let a = analyze("cd sub");
    assert_eq!(a.overall_class, CommandClass::Normal);
    assert_eq!(a.segments[0].class, CommandClass::Normal);
}

#[test]
fn cd_dotdot_and_drive_flag_allowed() {
    assert_eq!(analyze("cd ..").overall_class, CommandClass::Normal);
    assert_eq!(analyze("cd /d C:\\").overall_class, CommandClass::Normal);
}

#[test]
fn powershell_cd_family_allowed() {
    assert_eq!(
        analyze("Set-Location D:\\code").overall_class,
        CommandClass::Normal
    );
    assert_eq!(analyze("sl sub").overall_class, CommandClass::Normal);
    assert_eq!(analyze("pushd sub").overall_class, CommandClass::Normal);
    assert_eq!(analyze("popd").overall_class, CommandClass::Normal);
}

#[test]
fn quoted_cd_inside_string_not_detected() {
    // 引号内 "cd x" 是 echo 的参数，命令名不是 cd 家族，不命中
    assert_eq!(analyze("echo \"cd x\"").overall_class, CommandClass::Normal);
    assert_eq!(analyze("echo cd x").overall_class, CommandClass::Normal);
}

#[test]
fn non_stateful_forms_not_detected() {
    // 不依赖进程内目录状态的形态：git -C / npm --prefix / python -m
    assert_eq!(
        analyze("git -C src status").overall_class,
        CommandClass::Normal
    );
    assert_eq!(
        analyze("npm --prefix ./sub run build").overall_class,
        CommandClass::Normal
    );
    assert_eq!(
        analyze("python -m pip install x").overall_class,
        CommandClass::Normal
    );
}

#[test]
fn cd_chain_with_delete_priority_delete_wins() {
    // 复合链：cd 段为 Normal，rm 段标记 DeleteShape，整体按删除优先
    let a = analyze("cd x && rm -rf y");
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    assert_eq!(a.segments[1].class, CommandClass::DeleteShape);
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
}

#[test]
fn cd_chain_without_delete_overall_normal() {
    let a = analyze("cd sub && git status");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn cd_does_not_trigger_delete_shape() {
    // 两条路径独立判定：cd 段不触发删除形态，也不产生删除目标
    let a = analyze("cd x");
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    assert!(a.delete_targets.is_empty());
    assert!(!a.has_indirect_delete);
}

#[test]
fn path_prefixed_cd_normalized() {
    // 与 /bin/rm 归一逻辑同构：/usr/bin/cd 归一后仍是 cd (Normal)
    let a = analyze("/usr/bin/cd /tmp");
    assert_eq!(a.overall_class, CommandClass::Normal);
}

#[test]
fn classify_command_segments_entry_works() {
    // 公开入口（冻结签名）：单段放行
    assert_eq!(classify_chain(&["cd x".to_string()]), CommandClass::Normal);
    assert_eq!(
        classify_chain(&["Set-Location x".to_string()]),
        CommandClass::Normal
    );
    // 复合链：包含删除形态时整体为 DeleteShape
    assert_eq!(
        classify_chain(&["cd x".to_string(), "rm -rf y".to_string()]),
        CommandClass::DeleteShape
    );
    // 未拆段兜底：段内仍含 && 时再次拆开判定
    assert_eq!(
        classify_chain(&["cd x && rm -rf y".to_string()]),
        CommandClass::DeleteShape
    );
    // 不命中形态：整体 Normal
    assert_eq!(
        classify_chain(&["git -C src status".to_string()]),
        CommandClass::Normal
    );
    assert_eq!(
        classify_chain(&["echo hi".to_string(), "git status".to_string()]),
        CommandClass::Normal
    );
}

// ===== 12-T-PD-03：Windows 路径语义（A2-M1 + ML3）=====

#[test]
fn rm_bare_windows_path_preserved() {
    // 裸 Windows 路径：`\` 后跟普通路径字符不剥离，拆参后精确保留原串
    // （修复前被无条件剥离损坏成 C:tempa.txt）
    let a = analyze("rm C:\\temp\\a.txt");
    assert_eq!(a.segments[0].command, "rm");
    assert_eq!(a.delete_targets, vec!["C:\\temp\\a.txt".to_string()]);
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
}

#[test]
fn rm_backslash_path_with_spaces_in_dirname() {
    // Windows 路径目录含空格：裸形态空格天然拆 token，关键契约是反斜杠不被剥离
    // （修复前 `C:\my` 被损坏成 `C:my`）
    let a = analyze("rm C:\\my dir\\a.txt");
    let targets = a.delete_targets.clone();
    assert!(
        targets.iter().any(|t| t == "C:\\my"),
        "拆出的盘符前缀保留反斜杠：{:?}",
        targets
    );
    assert!(
        !targets.iter().any(|t| t == "C:my"),
        "不允许出现剥离反斜杠的损坏串：{:?}",
        targets
    );
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    // 引号 / 转义空格形态：整条含空格路径完整保留为一个目标
    let b = analyze("rm \"C:\\my dir\\a.txt\"");
    assert!(b.delete_targets.iter().any(|t| t == "C:\\my dir\\a.txt"));
    let c = analyze("rm C:\\my\\ dir\\a.txt");
    assert!(c.delete_targets.iter().any(|t| t == "C:\\my dir\\a.txt"));
}
