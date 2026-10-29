//! 子进程 cd 与安全复合链合法放行集成测试。
//!
//! 覆盖验收断言：
//! - cd x / Set-Location x / pushd x 合法判定为 Normal 放行；
//! - git -C src status 判定为 Normal；
//! - echo "cd x" 判定为 Normal；
//! - cd x && rm -rf y 中 cd 段为 Normal，rm 段为 DeleteShape，复合链整体按 DeleteShape 处理；
//! - cd sub && git status 全链判定为 Normal 放行；
//! - 既有 S2/S6 删除形态测试不回归。

use conex_sandbox::{assess, CommandClass};

fn segs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// 段列表的整体分类：按 `&&` 拼成一条命令行，交给唯一分析入口。
fn classify_chain(segments: &[String]) -> CommandClass {
    assess(&segments.join(" && ")).overall
}

// ===== 放行形态：cd 家族合法放行（Normal） =====

#[test]
fn cd_x_allowed_as_normal() {
    // 语义层整体分类
    let a = assess("cd x");
    assert_eq!(a.overall, CommandClass::Normal);
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    // 公开入口（冻结签名）
    assert_eq!(classify_chain(&segs(&["cd x"])), CommandClass::Normal);
    assert_eq!(classify_chain(&segs(&["cd .."])), CommandClass::Normal);
    assert_eq!(classify_chain(&segs(&["cd /d C:\\"])), CommandClass::Normal);
}

#[test]
fn set_location_and_sl_allowed_as_normal() {
    let a = assess("Set-Location D:\\code");
    assert_eq!(a.overall, CommandClass::Normal);
    assert_eq!(classify_chain(&segs(&["sl sub"])), CommandClass::Normal);
    assert_eq!(
        classify_chain(&segs(&["SET-LOCATION sub"])),
        CommandClass::Normal
    );
}

#[test]
fn pushd_and_popd_allowed_as_normal() {
    assert_eq!(assess("pushd sub").overall, CommandClass::Normal);
    assert_eq!(assess("popd").overall, CommandClass::Normal);
    assert_eq!(classify_chain(&segs(&["pushd sub"])), CommandClass::Normal);
    assert_eq!(classify_chain(&segs(&["popd"])), CommandClass::Normal);
}

// ===== 不依赖进程内目录状态的形态 =====

#[test]
fn git_dash_c_not_affected() {
    assert_eq!(assess("git -C src status").overall, CommandClass::Normal);
    assert_eq!(
        classify_chain(&segs(&["git -C src status"])),
        CommandClass::Normal
    );
}

#[test]
fn npm_prefix_and_python_m_normal() {
    assert_eq!(
        assess("npm --prefix ./sub run build").overall,
        CommandClass::Normal
    );
    assert_eq!(
        assess("python -m pip install x").overall,
        CommandClass::Normal
    );
    assert_eq!(
        classify_chain(&segs(&["npm --prefix ./sub run build"])),
        CommandClass::Normal
    );
}

#[test]
fn quoted_cd_inside_echo_normal() {
    assert_eq!(assess("echo \"cd x\"").overall, CommandClass::Normal);
    assert_eq!(
        classify_chain(&segs(&["echo \"cd x\""])),
        CommandClass::Normal
    );
    assert_eq!(assess("echo 'cd x'").overall, CommandClass::Normal);
}

#[test]
fn cd_as_argument_normal() {
    assert_eq!(assess("echo cd x").overall, CommandClass::Normal);
}

// ===== 复合链：与删除形态结合 =====

#[test]
fn cd_chain_with_delete_priority() {
    // cd 段为 Normal，rm 段为 DeleteShape，复合链整体按 DeleteShape
    let a = assess("cd x && rm -rf y");
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    assert_eq!(a.segments[1].class, CommandClass::DeleteShape);
    assert_eq!(a.overall, CommandClass::DeleteShape);
    assert_eq!(
        classify_chain(&segs(&["cd x", "rm -rf y"])),
        CommandClass::DeleteShape
    );
    assert_eq!(
        classify_chain(&segs(&["cd x && rm -rf y"])),
        CommandClass::DeleteShape
    );
    assert_eq!(
        classify_chain(&segs(&["rm -f tmp/f", "cd x"])),
        CommandClass::DeleteShape
    );
}

#[test]
fn cd_chain_without_delete_overall_normal() {
    let a = assess("cd sub && git status");
    assert_eq!(a.overall, CommandClass::Normal);
    assert_eq!(
        classify_chain(&segs(&["cd sub", "git status"])),
        CommandClass::Normal
    );
}

#[test]
fn cd_segment_never_triggers_delete_shape() {
    let a = assess("cd x");
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    assert!(a.delete_targets.is_empty());
    assert!(!a.has_indirect_delete);
}

// ===== S2/S6 既有删除形态回归 =====

#[test]
fn s2_s6_delete_shape_regression() {
    // 红线：rm -rf / 100% 拦截
    assert_eq!(assess("rm -rf /").overall, CommandClass::Redline);
    // -- 变体归删除形态（S4 重定向）
    assert_eq!(assess("rm -rf -- ./").overall, CommandClass::DeleteShape);
    // PowerShell 删除形态
    assert_eq!(
        assess("Remove-Item -LiteralPath 'C:\\x\\y.txt' -Force").overall,
        CommandClass::DeleteShape
    );
    // git rm 删除形态
    let a = assess("git rm file.txt");
    assert_eq!(a.overall, CommandClass::DeleteShape);
    assert!(a.delete_targets.contains(&"file.txt".to_string()));
    // 回退形态与普通命令不受影响
    assert_eq!(
        assess("git reset --hard HEAD~5").overall,
        CommandClass::GitRevertShape
    );
    assert_eq!(assess("git status").overall, CommandClass::Normal);
    // 间接执行删除标记（I2-S4）不受影响
    let b = assess("bash -c 'rm -rf tmp/foo'");
    assert!(b.has_indirect_delete);
    assert_eq!(b.overall, CommandClass::Indirect);
    // 间接执行红线升级不受影响
    assert_eq!(
        assess("sudo bash -c 'rm -rf /'").overall,
        CommandClass::Redline
    );
}
