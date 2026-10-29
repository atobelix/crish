//! 用旧实现为命令语料生成裁决金样。
//!
//! 本示例只在重构前运行一次。输出是冻结的历史事实，后续实现不得比它更宽松。
//! 命令行拆参与 `agent-tools` 的 shell 准备路径一致：整行作为 `cmd`，参数切片为空。

use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use conex_sandbox::gatekeeper::{GatekeeperResult, SHARED_GATEKEEPER};
use conex_sandbox::semantics::{analyze, CommandClass};
use conex_sandbox::smart_classifier::{ApprovalReason, SmartClassifier, SmartVerdict};

const CWD_IN: &str = "C:/work/project";
const ROOT: &str = "C:/work/project";
const CWD_OUT: &str = "C:/Windows/System32";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            match writeln!(io::stderr(), "gen_verdict_golden: {err}") {
                Ok(()) => ExitCode::from(1),
                Err(write_err) => {
                    eprintln!("gen_verdict_golden: {err}");
                    eprintln!("gen_verdict_golden: {write_err}");
                    ExitCode::from(1)
                }
            }
        }
    }
}

fn run() -> Result<(), String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let commands_path = manifest.join("tests/fixtures/commands.txt");
    let golden_path = manifest.join("tests/fixtures/verdict_golden.tsv");
    let text = fs::read_to_string(&commands_path).map_err(|err| {
        format!("读取 {} 失败: {err}", commands_path.display())
    })?;
    let commands = load_commands(&text);
    if commands.len() < 300 {
        return Err(format!("命令不足 300 条，实际 {}", commands.len()));
    }

    let mut out = String::new();
    out.push_str("# conex-sandbox verdict golden (old implementation)\n");
    out.push_str(
        "# columns: command gk gk_in gk_out smart_kind smart_detail pure_ro sem_class delete_targets indirect git_forms decoded note\n",
    );
    out.push_str("# escapes: \\\\ \\n \\r \\t ; delete_targets and git_forms joined by U+001F\n");
    out.push_str(
        "# check_command(full_line, &[]) matches agent-tools shell.rs prepare (cmd = full line, args empty)\n",
    );
    out.push_str("# gk_in: cwd=C:/work/project workspace=C:/work/project\n");
    out.push_str("# gk_out: cwd=C:/Windows/System32 workspace=C:/work/project\n");

    for command in &commands {
        let gk = gate_name(SHARED_GATEKEEPER.check_command(command, &[]));
        let gk_in = gate_name(SHARED_GATEKEEPER.check_command_with_context(
            command, &[], CWD_IN, ROOT,
        ));
        let gk_out = gate_name(SHARED_GATEKEEPER.check_command_with_context(
            command, &[], CWD_OUT, ROOT,
        ));
        let (smart_kind, smart_detail, pure_ro) = smart_parts(command);
        let semantic = analyze(command);
        let class = class_name(semantic.overall_class);
        let targets = semantic.delete_targets.join("\u{1f}");
        let forms = semantic.git_revert_forms.join("\u{1f}");
        let decoded = semantic.decoded_payload.unwrap_or_default();
        let indirect = if semantic.has_indirect_delete { "1" } else { "0" };
        let pure = if pure_ro { "1" } else { "0" };
        let fields = [
            esc(command),
            gk.to_string(),
            gk_in.to_string(),
            gk_out.to_string(),
            smart_kind,
            esc(&smart_detail),
            pure.to_string(),
            class.to_string(),
            esc(&targets),
            indirect.to_string(),
            esc(&forms),
            esc(&decoded),
            String::new(),
        ];
        out.push_str(&fields.join("\t"));
        out.push('\n');
    }

    let mut file = fs::File::create(&golden_path)
        .map_err(|err| format!("创建 {} 失败: {err}", golden_path.display()))?;
    file.write_all(out.as_bytes())
        .map_err(|err| format!("写入 {} 失败: {err}", golden_path.display()))?;
    writeln!(
        io::stderr(),
        "wrote {} commands to {}",
        commands.len(),
        golden_path.display()
    )
    .map_err(|err| format!("写入进度失败: {err}"))?;
    Ok(())
}

fn load_commands(text: &str) -> Vec<String> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
        .into_iter()
        .filter_map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.starts_with('#') {
                None
            } else {
                Some(unescape(line))
            }
        })
        .collect()
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

fn esc(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out
}

fn gate_name(result: GatekeeperResult) -> &'static str {
    match result {
        GatekeeperResult::Allowed => "Allowed",
        GatekeeperResult::Blocked => "Blocked",
        GatekeeperResult::RequiresApproval => "RequiresApproval",
    }
}

fn class_name(class: CommandClass) -> &'static str {
    match class {
        CommandClass::Normal => "Normal",
        CommandClass::Redline => "Redline",
        CommandClass::Dangerous => "Dangerous",
        CommandClass::DeleteShape => "DeleteShape",
        CommandClass::GitRevertShape => "GitRevertShape",
        CommandClass::Indirect => "Indirect",
    }
}

fn smart_parts(command: &str) -> (String, String, bool) {
    let analysis = SmartClassifier::analyze(command);
    match analysis.verdict {
        SmartVerdict::Allow => ("Allow".to_string(), String::new(), analysis.pure_read_only),
        SmartVerdict::RequireApproval { reason } => {
            let kind = format!("RequireApproval:{}", approval_category(&reason));
            (kind, reason.summary(), analysis.pure_read_only)
        }
        SmartVerdict::Deny { reason } => ("Deny".to_string(), reason.to_string(), analysis.pure_read_only),
    }
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
