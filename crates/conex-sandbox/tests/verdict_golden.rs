//! R1 旧实现金样逐条对拍。
//!
//! 与旧值不同的行必须在 [`EXPECTED`] 中逐字段列出并写明理由；未列出的行必须与
//! 金样逐字段完全一致。放宽方向硬失败（门禁/权限降级、pure_read_only 0→1、
//! delete_targets 丢目标、has_indirect_delete 1→0、Redline→非 Redline、
//! 非 Normal→Normal）。

use conex_sandbox::gatekeeper::GatekeeperResult;
use conex_sandbox::verdict::{PermissionVerdict, WorkspaceCtx};
use conex_sandbox::{assess, ApprovalReason, CommandClass};

const CWD_IN: &str = "C:/work/project";
const ROOT: &str = "C:/work/project";
const CWD_OUT: &str = "C:/Windows/System32";

/// 新裁决的精确形态。
enum ExpectedPermission {
    Allow,
    Deny(&'static str),
    RequireApproval {
        category: &'static str,
        summary: &'static str,
    },
}

impl ExpectedPermission {
    fn text(&self) -> String {
        match self {
            Self::Allow => "Allow".to_string(),
            Self::Deny(reason) => format!("Deny:{reason}"),
            Self::RequireApproval { category, summary } => {
                format!("RequireApproval:{category}:{summary}")
            }
        }
    }
}

/// 一条与旧金样不同的行。所有承载字段显式写出，禁止只写差值。
struct Expected {
    command: &'static str,
    gk: GatekeeperResult,
    gk_in: GatekeeperResult,
    gk_out: GatekeeperResult,
    permission: ExpectedPermission,
    pure_ro: bool,
    class: CommandClass,
    delete_targets: &'static [&'static str],
    indirect_delete: bool,
    git_forms: &'static [&'static str],
    decoded: &'static str,
    /// 为什么与旧值不同（变严或同级变化）。
    reason: &'static str,
}

/// 与旧金样不同的行。未列出的行必须逐字段等于旧值。
const EXPECTED: &[Expected] = &[];

#[test]
fn golden_rows_match_expected_or_old() {
    let text = include_str!("fixtures/verdict_golden.tsv");
    let rows = parse_rows(text);
    assert!(rows.len() >= 300, "金样行数不足：{}", rows.len());
    assert_eq!(
        rows.iter()
            .filter(|row| EXPECTED
                .iter()
                .any(|exp| exp.command == row.command.as_str()))
            .count(),
        EXPECTED.len(),
        "EXPECTED 含金样里不存在的命令"
    );
    let mut unexpected = Vec::new();
    let mut loose = Vec::new();
    for row in &rows {
        let measured = measure(&row.command);
        if let Some(exp) = EXPECTED
            .iter()
            .find(|exp| exp.command == row.command.as_str())
        {
            assert_explicit(exp, &measured);
            if !differs(row, &measured) {
                unexpected.push(format!("EXPECTED 条目与旧值完全相同：{}", row.command));
            }
        } else if differs(row, &measured) {
            unexpected.push(describe(row, &measured));
        }
        check_not_looser(row, &measured, &mut loose);
    }
    assert!(
        unexpected.is_empty(),
        "未列入 EXPECTED 的变更：\n{}",
        unexpected.join("\n")
    );
    assert!(loose.is_empty(), "放宽裁决：\n{}", loose.join("\n"));
}

/// R3 ①：金样每一行只要语义红线成立，地板必须是 Blocked。
#[test]
fn r3_redline_implies_blocked_floor() {
    let text = include_str!("fixtures/verdict_golden.tsv");
    for row in parse_rows(text) {
        let analysis = assess(&row.command);
        if analysis.redline.is_some() {
            assert_eq!(
                analysis.floor_verdict(None),
                GatekeeperResult::Blocked,
                "红线必须地板 Blocked：{}",
                display(&row.command)
            );
        }
    }
}

/// R3 ③：静态命中不等于语义红线。文本里出现 `rm -rf /` 只封锁地板，
/// 权限裁决保持 Allow。
#[test]
fn r3_static_hit_is_floor_only() {
    let analysis = assess("echo rm -rf /");
    assert!(analysis.redline.is_none(), "echo 文本不得判为语义红线");
    assert_eq!(
        analysis.permission_verdict(),
        PermissionVerdict::Allow,
        "静态命中不得把 Allow 变 Deny"
    );
    assert_eq!(
        analysis.floor_verdict(None),
        GatekeeperResult::Blocked,
        "静态命中必须由地板兜底"
    );
}

struct Row {
    command: String,
    gk: GatekeeperResult,
    gk_in: GatekeeperResult,
    gk_out: GatekeeperResult,
    smart_kind: String,
    smart_detail: String,
    pure_ro: bool,
    sem_class: CommandClass,
    delete_targets: String,
    indirect: bool,
    git_forms: String,
    decoded: String,
}

struct Measured {
    gk: GatekeeperResult,
    gk_in: GatekeeperResult,
    gk_out: GatekeeperResult,
    permission: String,
    pure_ro: bool,
    class: CommandClass,
    delete_targets: Vec<String>,
    indirect: bool,
    git_forms: Vec<String>,
    decoded: String,
}

fn measure(command: &str) -> Measured {
    let analysis = assess(command);
    let permission = permission_text(&analysis.permission_verdict());
    let in_ctx = WorkspaceCtx {
        cwd: CWD_IN,
        workspace_root: ROOT,
    };
    let out_ctx = WorkspaceCtx {
        cwd: CWD_OUT,
        workspace_root: ROOT,
    };
    Measured {
        gk: analysis.floor_verdict(None),
        gk_in: analysis.floor_verdict(Some(&in_ctx)),
        gk_out: analysis.floor_verdict(Some(&out_ctx)),
        permission,
        pure_ro: analysis.pure_read_only,
        class: analysis.overall,
        delete_targets: analysis.delete_targets.clone(),
        indirect: analysis.has_indirect_delete,
        git_forms: analysis.git_revert_forms.clone(),
        decoded: analysis.decoded_payload.clone().unwrap_or_default(),
    }
}

fn assert_explicit(exp: &Expected, measured: &Measured) {
    assert_eq!(measured.gk, exp.gk, "{} gk", exp.command);
    assert_eq!(measured.gk_in, exp.gk_in, "{} gk_in", exp.command);
    assert_eq!(measured.gk_out, exp.gk_out, "{} gk_out", exp.command);
    assert_eq!(
        measured.permission,
        exp.permission.text(),
        "{} permission",
        exp.command
    );
    assert_eq!(measured.pure_ro, exp.pure_ro, "{} pure_ro", exp.command);
    assert_eq!(measured.class, exp.class, "{} class", exp.command);
    assert_eq!(
        measured.delete_targets,
        exp.delete_targets
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>(),
        "{} delete_targets",
        exp.command
    );
    assert_eq!(
        measured.indirect, exp.indirect_delete,
        "{} indirect",
        exp.command
    );
    assert_eq!(
        measured.git_forms,
        exp.git_forms
            .iter()
            .map(|item| item.to_string())
            .collect::<Vec<_>>(),
        "{} git_forms",
        exp.command
    );
    assert_eq!(measured.decoded, exp.decoded, "{} decoded", exp.command);
    assert!(!exp.reason.is_empty(), "{} 缺少理由", exp.command);
}

fn differs(row: &Row, measured: &Measured) -> bool {
    measured.gk != row.gk
        || measured.gk_in != row.gk_in
        || measured.gk_out != row.gk_out
        || measured.permission != old_permission_text(row)
        || measured.pure_ro != row.pure_ro
        || measured.class != row.sem_class
        || join_unit(&measured.delete_targets) != row.delete_targets
        || measured.indirect != row.indirect
        || join_unit(&measured.git_forms) != row.git_forms
        || measured.decoded != row.decoded
}

fn check_not_looser(row: &Row, measured: &Measured, loose: &mut Vec<String>) {
    for (label, old, new) in [
        ("gk", row.gk, measured.gk),
        ("gk_in", row.gk_in, measured.gk_in),
        ("gk_out", row.gk_out, measured.gk_out),
    ] {
        if gate_rank(new) < gate_rank(old) {
            loose.push(format!("{} {label} {:?}→{:?}", row.command, old, new));
        }
    }
    if permission_rank(&measured.permission) < old_permission_rank(row) {
        loose.push(format!(
            "{} permission {}→{}",
            row.command,
            old_permission_text(row),
            measured.permission
        ));
    }
    if !row.pure_ro && measured.pure_ro {
        loose.push(format!("{} pure_read_only 0→1", row.command));
    }
    if row.sem_class == CommandClass::Redline && measured.class != CommandClass::Redline {
        loose.push(format!(
            "{} class Redline→{:?}",
            row.command, measured.class
        ));
    }
    if row.sem_class != CommandClass::Normal && measured.class == CommandClass::Normal {
        loose.push(format!(
            "{} class {:?}→Normal",
            row.command, row.sem_class
        ));
    }
    let old_targets: Vec<&str> = if row.delete_targets.is_empty() {
        Vec::new()
    } else {
        row.delete_targets.split('\u{1f}').collect()
    };
    for target in old_targets {
        if !measured.delete_targets.iter().any(|item| item == target) {
            loose.push(format!("{} delete_targets 丢失 {target}", row.command));
        }
    }
    if row.indirect && !measured.indirect {
        loose.push(format!("{} has_indirect_delete 1→0", row.command));
    }
}

fn describe(row: &Row, measured: &Measured) -> String {
    format!(
        "{} | 旧 gk {}/{:?}/{:?} perm {} pure {} class {:?} del [{}] ind {} git [{}] dec {:?} || 新 gk {:?}/{:?}/{:?} perm {} pure {} class {:?} del [{}] ind {} git [{}] dec {:?}",
        escape(&row.command),
        format!("{:?}", row.gk),
        row.gk_in,
        row.gk_out,
        old_permission_text(row),
        row.pure_ro,
        row.sem_class,
        row.delete_targets.replace('\u{1f}', "|"),
        row.indirect,
        row.git_forms.replace('\u{1f}', "|"),
        row.decoded,
        format!("{:?}", measured.gk),
        measured.gk_in,
        measured.gk_out,
        measured.permission,
        measured.pure_ro,
        measured.class,
        measured.delete_targets.join("|"),
        measured.indirect,
        measured.git_forms.join("|"),
        measured.decoded,
    )
}

fn permission_text(verdict: &PermissionVerdict) -> String {
    match verdict {
        PermissionVerdict::Allow => "Allow".to_string(),
        PermissionVerdict::Deny(reason) => format!("Deny:{}", reason.as_str()),
        PermissionVerdict::RequireApproval(reason) => {
            format!(
                "RequireApproval:{}:{}",
                approval_category(reason),
                reason.summary()
            )
        }
    }
}

fn old_permission_text(row: &Row) -> String {
    if row.smart_kind == "Allow" {
        "Allow".to_string()
    } else if row.smart_kind == "Deny" {
        format!("Deny:{}", row.smart_detail)
    } else {
        format!("{}:{}", row.smart_kind, row.smart_detail)
    }
}

fn old_permission_rank(row: &Row) -> i32 {
    if row.smart_kind == "Allow" {
        0
    } else if row.smart_kind == "Deny" {
        2
    } else {
        1
    }
}

fn permission_rank(text: &str) -> i32 {
    if text == "Allow" {
        0
    } else if text.starts_with("Deny:") {
        2
    } else {
        1
    }
}

fn gate_rank(value: GatekeeperResult) -> i32 {
    match value {
        GatekeeperResult::Allowed => 0,
        GatekeeperResult::RequiresApproval => 1,
        GatekeeperResult::Blocked => 2,
    }
}

fn join_unit(items: &[String]) -> String {
    items.join("\u{1f}")
}

fn approval_category(reason: &ApprovalReason) -> &'static str {
    match reason {
        ApprovalReason::DestructiveDelete { .. } => "DestructiveDelete",
        ApprovalReason::GitHistoryRewrite { .. } => "GitHistoryRewrite",
        ApprovalReason::PrivilegeEscalation { .. } => "PrivilegeEscalation",
        ApprovalReason::RemotePipeExecution { .. } => "RemotePipeExecution",
        ApprovalReason::PackagePublish { .. } => "PackagePublish",
        ApprovalReason::UnsafeSideEffect { .. } => "UnsafeSideEffect",
    }
}

fn parse_rows(text: &str) -> Vec<Row> {
    text.lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            assert_eq!(cols.len(), 13, "列数不对：{line}");
            Row {
                command: unescape(cols[0]),
                gk: gate(cols[1]),
                gk_in: gate(cols[2]),
                gk_out: gate(cols[3]),
                smart_kind: unescape(cols[4]),
                smart_detail: unescape(cols[5]),
                pure_ro: cols[6] == "1",
                sem_class: class(cols[7]),
                delete_targets: unescape(cols[8]),
                indirect: cols[9] == "1",
                git_forms: unescape(cols[10]),
                decoded: unescape(cols[11]),
            }
        })
        .collect()
}

fn gate(name: &str) -> GatekeeperResult {
    match name {
        "Allowed" => GatekeeperResult::Allowed,
        "Blocked" => GatekeeperResult::Blocked,
        "RequiresApproval" => GatekeeperResult::RequiresApproval,
        other => panic!("未知门禁：{other}"),
    }
}

fn class(name: &str) -> CommandClass {
    match name {
        "Normal" => CommandClass::Normal,
        "Redline" => CommandClass::Redline,
        "Dangerous" => CommandClass::Dangerous,
        "DeleteShape" => CommandClass::DeleteShape,
        "GitRevertShape" => CommandClass::GitRevertShape,
        "Indirect" => CommandClass::Indirect,
        other => panic!("未知分类：{other}"),
    }
}

fn unescape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('\\') => out.push('\\'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn escape(command: &str) -> String {
    command.replace('\n', "\\n").replace('\r', "\\r")
}

fn display(command: &str) -> String {
    escape(command)
}
