//! 子进程 cd 与安全复合链合法放行集成测试。
//!
//! 覆盖验收断言：
//! - cd x / Set-Location x / pushd x 合法判定为 Normal 放行；
//! - git -C src status 判定为 Normal；
//! - echo "cd x" 判定为 Normal；
//! - cd x && rm -rf y 中 cd 段为 Normal，rm 段为 DeleteShape，复合链整体按 DeleteShape 处理；
//! - cd sub && git status 全链判定为 Normal 放行；
//! - 既有 S2/S6 删除形态测试不回归。

use conex_sandbox::semantics::{analyze, CommandClass};
use conex_sandbox::{classify_command_segments as root_classify, CommandClass as RootClass};

fn segs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ===== 放行形态：cd 家族合法放行（Normal） =====

#[test]
fn cd_x_allowed_as_normal() {
    // 语义层整体分类
    let a = analyze("cd x");
    assert_eq!(a.overall_class, CommandClass::Normal);
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    // 公开入口（冻结签名）
    assert_eq!(root_classify(&segs(&["cd x"])), RootClass::Normal);
    assert_eq!(root_classify(&segs(&["cd .."])), RootClass::Normal);
    assert_eq!(root_classify(&segs(&["cd /d C:\\"])), RootClass::Normal);
}

#[test]
fn set_location_and_sl_allowed_as_normal() {
    let a = analyze("Set-Location D:\\code");
    assert_eq!(a.overall_class, CommandClass::Normal);
    assert_eq!(root_classify(&segs(&["sl sub"])), RootClass::Normal);
    assert_eq!(
        root_classify(&segs(&["SET-LOCATION sub"])),
        RootClass::Normal
    );
}

#[test]
fn pushd_and_popd_allowed_as_normal() {
    assert_eq!(analyze("pushd sub").overall_class, CommandClass::Normal);
    assert_eq!(analyze("popd").overall_class, CommandClass::Normal);
    assert_eq!(root_classify(&segs(&["pushd sub"])), RootClass::Normal);
    assert_eq!(root_classify(&segs(&["popd"])), RootClass::Normal);
}

// ===== 不依赖进程内目录状态的形态 =====

#[test]
fn git_dash_c_not_affected() {
    assert_eq!(
        analyze("git -C src status").overall_class,
        CommandClass::Normal
    );
    assert_eq!(
        root_classify(&segs(&["git -C src status"])),
        RootClass::Normal
    );
}

#[test]
fn npm_prefix_and_python_m_normal() {
    assert_eq!(
        analyze("npm --prefix ./sub run build").overall_class,
        CommandClass::Normal
    );
    assert_eq!(
        analyze("python -m pip install x").overall_class,
        CommandClass::Normal
    );
    assert_eq!(
        root_classify(&segs(&["npm --prefix ./sub run build"])),
        RootClass::Normal
    );
}

#[test]
fn quoted_cd_inside_echo_normal() {
    assert_eq!(analyze("echo \"cd x\"").overall_class, CommandClass::Normal);
    assert_eq!(root_classify(&segs(&["echo \"cd x\""])), RootClass::Normal);
    assert_eq!(analyze("echo 'cd x'").overall_class, CommandClass::Normal);
}

#[test]
fn cd_as_argument_normal() {
    assert_eq!(analyze("echo cd x").overall_class, CommandClass::Normal);
}

// ===== 复合链：与删除形态结合 =====

#[test]
fn cd_chain_with_delete_priority() {
    // cd 段为 Normal，rm 段为 DeleteShape，复合链整体按 DeleteShape
    let a = analyze("cd x && rm -rf y");
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    assert_eq!(a.segments[1].class, CommandClass::DeleteShape);
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert_eq!(
        root_classify(&segs(&["cd x", "rm -rf y"])),
        RootClass::DeleteShape
    );
    assert_eq!(
        root_classify(&segs(&["cd x && rm -rf y"])),
        RootClass::DeleteShape
    );
    assert_eq!(
        root_classify(&segs(&["rm -f tmp/f", "cd x"])),
        RootClass::DeleteShape
    );
}

#[test]
fn cd_chain_without_delete_overall_normal() {
    let a = analyze("cd sub && git status");
    assert_eq!(a.overall_class, CommandClass::Normal);
    assert_eq!(
        root_classify(&segs(&["cd sub", "git status"])),
        RootClass::Normal
    );
}

#[test]
fn cd_segment_never_triggers_delete_shape() {
    let a = analyze("cd x");
    assert_eq!(a.segments[0].class, CommandClass::Normal);
    assert!(a.delete_targets.is_empty());
    assert!(!a.has_indirect_delete);
}

// ===== S2/S6 既有删除形态回归 =====

#[test]
fn s2_s6_delete_shape_regression() {
    // 红线：rm -rf / 100% 拦截
    assert_eq!(analyze("rm -rf /").overall_class, CommandClass::Redline);
    // -- 变体归删除形态（S4 重定向）
    assert_eq!(
        analyze("rm -rf -- ./").overall_class,
        CommandClass::DeleteShape
    );
    // PowerShell 删除形态
    assert_eq!(
        analyze("Remove-Item -LiteralPath 'C:\\x\\y.txt' -Force").overall_class,
        CommandClass::DeleteShape
    );
    // git rm 删除形态
    let a = analyze("git rm file.txt");
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    assert!(a.delete_targets.contains(&"file.txt".to_string()));
    // 回退形态与普通命令不受影响
    assert_eq!(
        analyze("git reset --hard HEAD~5").overall_class,
        CommandClass::GitRevertShape
    );
    assert_eq!(analyze("git status").overall_class, CommandClass::Normal);
    // 间接执行删除标记（I2-S4）不受影响
    let b = analyze("bash -c 'rm -rf tmp/foo'");
    assert!(b.has_indirect_delete);
    assert_eq!(b.overall_class, CommandClass::Indirect);
    // 间接执行红线升级不受影响
    assert_eq!(
        analyze("sudo bash -c 'rm -rf /'").overall_class,
        CommandClass::Redline
    );
}
