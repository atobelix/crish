//! T-AB-05 禁 cd 语义层集成测试。
//!
//! 覆盖验收断言：
//! - cd x / Set-Location x / pushd x 命中 CdShape；
//! - git -C src status 不命中；
//! - echo "cd x" 不命中；
//! - cd x && rm -rf y 同时命中 CdShape 与复合链 DeleteShape（删除优先，两条路径独立）；
//! - 既有 S2/S6 删除形态测试不回归。
//!
//! 同族测试先例：lib.rs:229-393 的 S2/S6 段（门禁接线层），本文件聚焦语义层本身。

use conex_sandbox::semantics::{analyze, CommandClass};
use conex_sandbox::{classify_command_segments as root_classify, CommandClass as RootClass};

fn segs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

// ===== 命中形态：cd 家族 =====

#[test]
fn cd_x_hits_cd_shape() {
    // 语义层整体分类
    let a = analyze("cd x");
    assert_eq!(a.overall_class, CommandClass::CdShape);
    assert_eq!(a.segments[0].class, CommandClass::CdShape);
    // 公开入口（冻结签名）
    assert_eq!(root_classify(&segs(&["cd x"])), RootClass::CdShape);
    assert_eq!(root_classify(&segs(&["cd .."])), RootClass::CdShape);
    assert_eq!(root_classify(&segs(&["cd /d C:\\"])), RootClass::CdShape);
}

#[test]
fn set_location_and_sl_hit_cd_shape() {
    let a = analyze("Set-Location D:\\code");
    assert_eq!(a.overall_class, CommandClass::CdShape);
    assert_eq!(root_classify(&segs(&["sl sub"])), RootClass::CdShape);
    // PowerShell 别名大小写不敏感（归一化处理）
    assert_eq!(root_classify(&segs(&["SET-LOCATION sub"])), RootClass::CdShape);
}

#[test]
fn pushd_and_popd_hit_cd_shape() {
    assert_eq!(analyze("pushd sub").overall_class, CommandClass::CdShape);
    assert_eq!(analyze("popd").overall_class, CommandClass::CdShape);
    assert_eq!(root_classify(&segs(&["pushd sub"])), RootClass::CdShape);
    assert_eq!(root_classify(&segs(&["popd"])), RootClass::CdShape);
}

// ===== 不命中形态 =====

#[test]
fn git_dash_c_not_cd_shape() {
    // git -C 不依赖进程内目录状态，不命中
    assert_eq!(analyze("git -C src status").overall_class, CommandClass::Normal);
    assert_eq!(root_classify(&segs(&["git -C src status"])), RootClass::Normal);
}

#[test]
fn npm_prefix_and_python_m_not_cd_shape() {
    assert_eq!(
        analyze("npm --prefix ./sub run build").overall_class,
        CommandClass::Normal
    );
    assert_eq!(
        analyze("python -m pip install x").overall_class,
        CommandClass::Normal
    );
    assert_eq!(root_classify(&segs(&["npm --prefix ./sub run build"])), RootClass::Normal);
}

#[test]
fn quoted_cd_inside_echo_not_cd_shape() {
    // 引号感知：cd 出现在引号字符串内，是 echo 的参数，不命中
    assert_eq!(analyze("echo \"cd x\"").overall_class, CommandClass::Normal);
    assert_eq!(root_classify(&segs(&["echo \"cd x\""])), RootClass::Normal);
    assert_eq!(analyze("echo 'cd x'").overall_class, CommandClass::Normal);
}

#[test]
fn cd_as_argument_not_cd_shape() {
    // 裸参数形态：命令名不是 cd 家族
    assert_eq!(analyze("echo cd x").overall_class, CommandClass::Normal);
}

// ===== 复合链：与删除形态独立判定 =====

#[test]
fn cd_chain_with_delete_both_hit() {
    // cd 段独立标记 CdShape，rm 段标记 DeleteShape，
    // 整体分类删除优先（方案第 4 点：门禁 → 删除形态 → cd 形态 → 执行）
    let a = analyze("cd x && rm -rf y");
    assert_eq!(a.segments[0].class, CommandClass::CdShape);
    assert_eq!(a.segments[1].class, CommandClass::DeleteShape);
    assert_eq!(a.overall_class, CommandClass::DeleteShape);
    // 公开入口：已拆段与未拆段两种入参同口径
    assert_eq!(
        root_classify(&segs(&["cd x", "rm -rf y"])),
        RootClass::DeleteShape
    );
    assert_eq!(root_classify(&segs(&["cd x && rm -rf y"])), RootClass::DeleteShape);
    // 删除在前的链同样删除优先
    assert_eq!(
        root_classify(&segs(&["rm -f tmp/f", "cd x"])),
        RootClass::DeleteShape
    );
}

#[test]
fn cd_chain_without_delete_overall_cd() {
    let a = analyze("cd sub && git status");
    assert_eq!(a.overall_class, CommandClass::CdShape);
    assert_eq!(root_classify(&segs(&["cd sub", "git status"])), RootClass::CdShape);
}

#[test]
fn cd_segment_never_triggers_delete_shape() {
    // 两条路径独立：cd 段不产生删除目标，不置间接删除标记
    let a = analyze("cd x");
    assert_eq!(a.segments[0].class, CommandClass::CdShape);
    assert!(a.delete_targets.is_empty());
    assert!(!a.has_indirect_delete);
}

// ===== S2/S6 既有删除形态回归 =====

#[test]
fn s2_s6_delete_shape_regression() {
    // 红线：rm -rf / 100% 拦截
    assert_eq!(analyze("rm -rf /").overall_class, CommandClass::Redline);
    // -- 变体归删除形态（S4 重定向）
    assert_eq!(analyze("rm -rf -- ./").overall_class, CommandClass::DeleteShape);
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
    assert_eq!(analyze("git reset --hard HEAD~5").overall_class, CommandClass::GitRevertShape);
    assert_eq!(analyze("git status").overall_class, CommandClass::Normal);
    // 间接执行删除标记（I2-S4）不受影响
    let b = analyze("bash -c 'rm -rf tmp/foo'");
    assert!(b.has_indirect_delete);
    assert_eq!(b.overall_class, CommandClass::Indirect);
    // 间接执行红线升级不受影响
    assert_eq!(analyze("sudo bash -c 'rm -rf /'").overall_class, CommandClass::Redline);
    // 根目录删除不会因 cd 新增变体误判为 cd 形态
    assert_ne!(analyze("rm -rf /").overall_class, CommandClass::CdShape);
}
