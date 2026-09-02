//! 只读子代理工具集裁剪（I4-M3 内容 3：Reasonix ReadOnlySubagentToolRegistry 落地）
//!
//! capabilityMode = read-only 的子代理（researcher 类）只允许只读工具：
//! 其工具集剔除全部写类（write_file / multi_replace_file_content /
//! delete_file / delete_dir / shell_command），仅保留 read_file /
//! list_dir / file_stat / grep_search / fuzzy_find / diff_text。比提示词
//! 纪律可靠——执行层根本拿不到写工具。
//!
//! 裁剪语义为**白名单**（fail-closed）：不在 [READONLY_TOOL_NAMES] 内的
//! 工具一律剔除（含未来新增的未分类工具），防止新写工具漏网。
//!
//! T-D-08 起推广为 task_type 默认集裁剪（REQ-D04 命令/工具开关下沉）：
//! - [filter_registry]：通用注册表过滤（按名字谓词，fail-closed）；
//! - [filter_registry_for_task_type]：按任务类型派生默认工具集
//!   （analysis/organization → 只读白名单；design/review → 只读 + write_file；
//!   commit → 仅 shell_command；implementation → 全工具集剔除 browser_*
//!   （27 接线方案 §3，子代理永不获得浏览器操作权）；未知 → 只读回退）；
//! - [command_allowed_for_task_type]：命令级白名单判定（shell 执行门禁兜底
//!   ——commit 仅 git 前缀、implementation 复用语义层 CommandClass 分类，
//!   其余类型无命令）；供引擎侧 T-D-13 在 spawn 装配时消费。
//!
//! 挂接点：M2 run_subagent spawn 时按 capabilityMode / task_type 选择工具注册表
//! （[filter_readonly_registry] / [filter_registry_for_task_type]），
//! shell_command 不进入只读集——bash 副作用无法静态预知，删除形态重定向
//! 不能覆盖全部写形态，故整体剔除。

use crate::definition::ToolError;
use crate::registry::ToolRegistry;

/// 写类工具名单（只读子代理整体剔除）
pub const WRITE_TOOL_NAMES: [&str; 5] = [
    "write_file",
    "multi_replace_file_content",
    "delete_file",
    "delete_dir",
    "shell_command",
];

/// 只读工具白名单（仅保留这些工具）
///
/// T-38/T-40/T-41（记忆韧性轮次 5）：project_tree / search_context /
/// decompress_context 三只读工具入列（dangerous=false，00-plan §7.3）——
/// search/decompress 只读视图经 ToolContext.compression_store trait 注入
/// （引擎侧实现，不携带会话外数据）；decompress 落文件面仅主 agent
/// 生效，子代理上下文（write_claim_holder 注入）恒回退 inline。
///
/// W4-A：query_blocks / document_outline 笔记读工具入列（dangerous=false；
/// 未接 note_backend 时 stub 返回 note_backend_unwired，不写盘）。
/// Round7：document_get_md 即时 S(树) 读全文，只读入列。
/// W4-B/F/R 写工具 document_apply_md / send_to_note / block_batch /
/// block_insert / block_update / block_delete / block_move / block_set_attr
/// **不**入只读集（dangerous=true）。
pub const READONLY_TOOL_NAMES: [&str; 12] = [
    "read_file",
    "list_dir",
    "file_stat",
    "grep_search",
    "fuzzy_find",
    "diff_text",
    "project_tree",
    "search_context",
    "decompress_context",
    "query_blocks",
    "document_outline",
    "document_get_md",
];

/// commit 类型默认工具集（仅 shell_command；命令前缀过滤 git 见命令策略）
pub const COMMIT_TOOL_NAMES: [&str; 1] = ["shell_command"];

/// 通用注册表裁剪（fail-closed：谓词返回 false 的工具一律剔除）
///
/// 返回新注册表，原注册表不受影响。注册失败在源注册表名称唯一的前提下
/// 不可能发生（保留集 ⊆ 源工具集，名称不重复），`?` 透传保持诚实。
/// 谓词按工具名判定（`Fn(&str) -> bool`），名字规则集中一处。
pub fn filter_registry(
    registry: &ToolRegistry,
    keep: impl Fn(&str) -> bool,
) -> Result<ToolRegistry, ToolError> {
    let mut filtered = ToolRegistry::new();
    for tool in registry.list() {
        if keep(tool.name()) {
            filtered.register(tool)?;
        }
    }
    Ok(filtered)
}

/// 按名称白名单裁剪注册表（通用过滤函数，fail-closed：名单外的工具全部剔除）
///
/// 返回新注册表，原注册表不受影响。注册失败在源注册表名称唯一的前提下
/// 不可能发生（白名单 ⊆ 源工具集，名称不重复），`?` 透传保持诚实。
///
/// T-D-02 复用：子代理 run 装配工具注册表时，除只读裁剪外还按发起者
/// 身份剔除 run_subagent（工具面防护，防浪费非安全边界；守卫层兜底）。
pub fn filter_registry_by_names(
    registry: &ToolRegistry,
    allowed: &[&str],
) -> Result<ToolRegistry, ToolError> {
    filter_registry(registry, |name| allowed.contains(&name))
}

/// 按只读白名单裁剪注册表（fail-closed：白名单外的工具全部剔除）
///
/// 返回新注册表，原注册表不受影响。行为由通用过滤函数
/// [filter_registry_by_names] 提供（提取复用，T-D-02）。
pub fn filter_readonly_registry(registry: &ToolRegistry) -> Result<ToolRegistry, ToolError> {
    filter_registry_by_names(registry, &READONLY_TOOL_NAMES)
}

/// 按任务类型派生默认工具集裁剪（T-D-08；供引擎侧 T-D-13 spawn 装配）
///
/// 默认集映射（对齐《调研-权限传递层》§2.2，工具面）：
/// - `analysis` / `organization` → 只读白名单（fail-closed，无写工具无命令）；
/// - `design` / `review` → 只读白名单 + `write_file`（文档产出）；
/// - `commit` → 仅 `shell_command`（命令前缀过滤 git，无写文件工具）；
/// - `implementation` → 全工具集剔除 `browser_*` 前缀（27 接线方案 §3：
///   子代理永不获得浏览器共享会话操作权，fail-closed；写路径沙箱与
///   命令策略另行装配）；
/// - 未知 / 空 → 回退 `analysis` 语义（只读白名单，最安全）。
///
/// 说明：run_subagent 的发起者身份剔除（工具面防护，T-D-02）不在本函数内，
/// 由装配方叠加；MCP 工具无独立开关，默认继承父代理面。
///
/// browser_* 剔除依据（27 接线方案 §3 冲突矩阵 / §5 风险表 S5；30 评审
/// H-2 / 31 评审 F1）：子代理注册面经本函数派生（主 run 不经此路径，引擎侧
/// 直用共享注册表），`browser_*` 前缀工具对子代理一律 fail-closed 剔除——
/// 子代理若获得浏览器工具即拿到共享浏览器会话操作权（读取主 run 登录态
/// 页面内容 / 改写主 run 正在操作的页面），且面板无可见性提示。白名单分支
/// 结构上不含 browser_ 工具，仅 implementation 全量分支需显式剔除。
pub fn filter_registry_for_task_type(
    registry: &ToolRegistry,
    task_type: &str,
) -> Result<ToolRegistry, ToolError> {
    match task_type {
        "analysis" | "organization" => filter_registry_by_names(registry, &READONLY_TOOL_NAMES),
        "design" | "review" => filter_registry(registry, |name| {
            READONLY_TOOL_NAMES.contains(&name) || name == "write_file"
        }),
        "commit" => filter_registry_by_names(registry, &COMMIT_TOOL_NAMES),
        // implementation → 全工具集剔除 browser_* 前缀（27 §3 / 31 评审 F1，
        // fail-closed：子代理永不获得浏览器共享会话操作权；注释见函数头）
        "implementation" => filter_registry(registry, |name| !name.starts_with("browser_")),
        // 未知/缺省：最安全回退（对齐缺省 task_type = analysis 的口径）
        _ => filter_registry_by_names(registry, &READONLY_TOOL_NAMES),
    }
}

/// 命令级白名单判定（按任务类型派生命令策略；T-D-08，shell 命令执行门禁
/// 兜底过滤——工具面已剔除 shell_command 的类型此处一并拒绝）
///
/// **边界登记（P1 权限归一 D8）**：本函数是「spawn 时工具裁剪」独立层
/// （子代理按任务类型装配工具集时的命令策略），**不参与每命令放行判定**——
/// 每命令「是否放行/拒绝/需审批」的唯一判定链为
/// `crate::permission::decide_command_with_revert`（执行器 `call_verdict`
/// 与 shell 工具共用）；本层与单链互不调用、互不并链，语义不删不改。
///
/// - `commit` → 仅 `git` 命令（前缀过滤口径：命令首词必须为 git）；
/// - `implementation` → 构建/测试类命令白名单：复用语义层
///   `semantics::analyze` 的 CommandClass 分类（不维护命令前缀表），
///   整体分类必须为 Normal，且不被既有门禁判定为需审批/拦截
///   （网络发布 npm/cargo publish、提权 sudo 等形态经
///   `CommandGatekeeper` 兜底拒绝）；
/// - 其余 / 未知 → 一律拒绝（无命令）。
pub fn command_allowed_for_task_type(task_type: &str, command_line: &str) -> bool {
    let cmd = command_line.trim();
    if cmd.is_empty() {
        return false;
    }
    match task_type {
        "commit" => first_token(cmd) == "git",
        "implementation" => {
            use conex_sandbox::gatekeeper::{CommandGatekeeper, GatekeeperResult};
            use conex_sandbox::semantics::{analyze, CommandClass};
            // 语义层分类：非普通命令（红线/危险/删除/回退/间接/cd 形态）一律拒绝
            if analyze(cmd).overall_class != CommandClass::Normal {
                return false;
            }
            // 既有门禁兜底：网络发布 / 提权 / 强推等需审批形态不进默认集
            // （子代理需要时走权限申请通道，T-D-14）
            matches!(
                CommandGatekeeper::new().check_command(cmd, &[]),
                GatekeeperResult::Allowed
            )
        }
        _ => false,
    }
}

/// 命令首词提取（按空白切分的第一段；空串返回空）
fn first_token(command_line: &str) -> &str {
    command_line.split_whitespace().next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::EchoTool;
    use crate::tools::register_builtin_tools;
    use std::sync::Arc;

    #[test]
    fn filter_readonly_keeps_only_readonly_tools() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();

        let ro = filter_readonly_registry(&reg).unwrap();
        assert_eq!(
            ro.len(),
            READONLY_TOOL_NAMES.len(),
            "只读子代理工具集应为全部只读工具"
        );
        let names: Vec<String> = ro
            .list_definitions()
            .iter()
            .map(|d| d.name.clone())
            .collect();
        let mut expected: Vec<String> = READONLY_TOOL_NAMES.iter().map(|n| n.to_string()).collect();
        expected.sort();
        assert_eq!(names, expected);
    }

    #[test]
    fn filter_readonly_drops_all_write_tools() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        let ro = filter_readonly_registry(&reg).unwrap();
        for name in WRITE_TOOL_NAMES {
            assert!(!ro.has(name), "{name} 必须从只读工具集剔除");
        }
        for name in READONLY_TOOL_NAMES {
            assert!(ro.has(name), "{name} 必须保留在只读工具集");
        }
    }

    #[test]
    fn filter_readonly_drops_unknown_tools_fail_closed() {
        // 未知工具（非白名单）一律剔除：白名单语义防未来新写工具漏网
        let mut reg = ToolRegistry::new();
        reg.register(Arc::new(EchoTool::new("mystery_write_tool")))
            .unwrap();
        register_builtin_tools(&mut reg).unwrap();
        let ro = filter_readonly_registry(&reg).unwrap();
        assert!(!ro.has("mystery_write_tool"));
        assert_eq!(ro.len(), READONLY_TOOL_NAMES.len());
    }

    #[test]
    fn filter_does_not_mutate_source_registry() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        let before = reg.len();
        let _ = filter_readonly_registry(&reg).unwrap();
        assert_eq!(reg.len(), before, "裁剪必须返回新注册表，不改动原表");
        assert!(reg.has("write_file"));
    }

    #[test]
    fn filter_readonly_tool_names_are_valid_builtin_names() {
        // 名单一致性护栏：白名单/黑名单均命中既有内置工具名
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        for name in WRITE_TOOL_NAMES.iter().chain(READONLY_TOOL_NAMES.iter()) {
            assert!(reg.has(name), "{name} 必须存在于内置工具集");
        }
    }

    #[test]
    fn filter_registry_by_names_uses_custom_whitelist() {
        // 通用过滤函数（T-D-02 提取）：按任意名单裁剪，fail-closed
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        let keep = ["read_file", "grep_search", "wait_subagents"];
        let out = filter_registry_by_names(&reg, &keep).unwrap();
        assert_eq!(out.len(), keep.len());
        for name in keep {
            assert!(out.has(name), "{name} 必须保留");
        }
        assert!(!out.has("run_subagent"), "名单外的 run_subagent 必须剔除");
        // 原注册表不受影响（非破坏性裁剪）
        // 注册面 →34（W4-R block_set_attr + 维度五 create_workflow）
        assert_eq!(reg.len(), 34);
        assert!(reg.has("run_subagent"));
    }

    // ===== T-D-08：通用 filter_registry + task_type 默认集裁剪 =====

    /// 通用过滤函数（谓词按工具名判定，fail-closed）：真谓词全保留、假谓词全剔除
    #[test]
    fn filter_registry_with_predicate() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        // 内置工具名均含下划线：真谓词 → 全量保留（新注册表，原表不动）
        let out = filter_registry(&reg, |name| name.contains('_')).unwrap();
        assert_eq!(out.len(), reg.len());
        for name in ["read_file", "write_file", "shell_command", "run_subagent"] {
            assert!(out.has(name), "{name} 必须命中谓词");
        }
        // 假谓词 → 空注册表（fail-closed 底线）
        let empty = filter_registry(&reg, |_| false).unwrap();
        assert!(empty.is_empty());
        // 原注册表不受影响（注册面 33 = W4-F + W4-R block_set_attr + D4
        // kill_subagent/send_message 后）
        assert_eq!(reg.len(), 34);
    }

    /// 六类型各自工具面：analysis/organization 只读、design/review 只读 +
    /// write_file、commit 仅 shell_command、implementation 全工具集
    #[test]
    fn filter_registry_for_task_type_six_faces() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        // analysis / organization → 只读白名单（无写工具、无命令工具）
        for tt in ["analysis", "organization"] {
            let out = filter_registry_for_task_type(&reg, tt).unwrap();
            assert_eq!(out.len(), READONLY_TOOL_NAMES.len(), "{tt} 应为只读白名单");
            for name in READONLY_TOOL_NAMES {
                assert!(out.has(name), "{tt} 必须保留只读工具 {name}");
            }
            for name in WRITE_TOOL_NAMES {
                assert!(!out.has(name), "{tt} 不得含写工具 {name}");
            }
            assert!(!out.has("run_subagent"), "{tt} 不得含 run_subagent");
        }
        // design / review → 只读白名单 + write_file
        for tt in ["design", "review"] {
            let out = filter_registry_for_task_type(&reg, tt).unwrap();
            assert_eq!(
                out.len(),
                READONLY_TOOL_NAMES.len() + 1,
                "{tt} 应为只读白名单 + write_file"
            );
            for name in READONLY_TOOL_NAMES {
                assert!(out.has(name));
            }
            assert!(out.has("write_file"), "{tt} 必须附加 write_file");
            assert!(!out.has("delete_file"), "{tt} 不得含删除工具");
            assert!(!out.has("shell_command"), "{tt} 不得含命令工具");
        }
        // commit → 仅 shell_command（无写文件工具）
        let out = filter_registry_for_task_type(&reg, "commit").unwrap();
        assert_eq!(out.len(), 1, "commit 工具面应仅 shell_command");
        assert!(out.has("shell_command"));
        assert!(!out.has("write_file"));
        assert!(!out.has("read_file"));
        // implementation → 全工具集
        let out = filter_registry_for_task_type(&reg, "implementation").unwrap();
        assert_eq!(out.len(), reg.len(), "implementation 应全工具集");
        assert!(out.has("write_file"));
        assert!(out.has("shell_command"));
        assert!(out.has("run_subagent"));
        // 未知 / 空 → 最安全回退（analysis 语义：只读白名单）
        for tt in ["", "bogus", "unknown-type"] {
            let out = filter_registry_for_task_type(&reg, tt).unwrap();
            assert_eq!(
                out.len(),
                READONLY_TOOL_NAMES.len(),
                "未知 task_type {tt:?} 应回退只读白名单"
            );
            assert!(!out.has("write_file"));
        }
        // 原注册表不受影响（非破坏性裁剪；注册面 34 = W4-R block_set_attr + 维度五 create_workflow 后）
        assert_eq!(reg.len(), 34);
        assert!(reg.has("write_file"));
        // W4-B/F/R 写工具不得进只读 / design 面（design 仅 + diff_file）
        for tt in ["analysis", "design"] {
            let out = filter_registry_for_task_type(&reg, tt).unwrap();
            assert!(
                !out.has("document_apply_md"),
                "{tt} 不得含 document_apply_md"
            );
            assert!(!out.has("send_to_note"), "{tt} 不得含 send_to_note");
            assert!(!out.has("block_batch"), "{tt} 不得含 block_batch");
            assert!(!out.has("block_insert"), "{tt} 不得含 block_insert");
            assert!(!out.has("block_update"), "{tt} 不得含 block_update");
            assert!(!out.has("block_delete"), "{tt} 不得含 block_delete");
            assert!(!out.has("block_move"), "{tt} 不得含 block_move");
            assert!(!out.has("block_set_attr"), "{tt} 不得含 block_set_attr");
            assert!(out.has("document_get_md"), "{tt} 必须保留 document_get_md");
        }
    }

    /// 27 接线方案 §3（fail-closed）/ 30 评审 H-2 / 31 评审 F1：子代理
    /// implementation 型 run 的注册面剔除 browser_* 前缀工具——子代理
    /// 永不获得浏览器共享会话操作权（读取主 run 登录态页面 / 改写主 run
    /// 正在操作的页面）；主 run 不经 [filter_registry_for_task_type]
    /// （引擎侧直用共享注册表），不受影响。
    #[test]
    fn filter_registry_for_task_type_drops_browser_tools() {
        let mut reg = ToolRegistry::new();
        register_builtin_tools(&mut reg).unwrap();
        // 模拟引擎后置注册的 browser_* 工具（conex-browser-tools 侧 23 工具
        // 全 browser_ 前缀；agent-tools 不依赖该 crate，以同名假工具代表）
        for name in [
            "browser_navigate",
            "browser_snapshot",
            "browser_type_text",
            "browser_console_list",
        ] {
            reg.register(Arc::new(EchoTool::new(name))).unwrap();
        }
        // 全部 task_type（含 implementation 全量分支与未知回退）：browser_*
        // 一律剔除（fail-closed）
        for tt in [
            "implementation",
            "analysis",
            "design",
            "review",
            "commit",
            "",
            "bogus",
        ] {
            let out = filter_registry_for_task_type(&reg, tt).unwrap();
            for name in [
                "browser_navigate",
                "browser_snapshot",
                "browser_type_text",
                "browser_console_list",
            ] {
                assert!(!out.has(name), "{tt:?} 注册面不得含 {name}");
            }
            // 27 §5 验收口径：list_definitions 面同样无 browser_*
            let names: Vec<String> = out
                .list_definitions()
                .iter()
                .map(|d| d.name.clone())
                .collect();
            assert!(
                names.iter().all(|n| !n.starts_with("browser_")),
                "{tt:?} list_definitions 不得含 browser_*：{names:?}"
            );
        }
        // implementation 仅剔除 browser_*（其余全量保留）
        let impl_reg = filter_registry_for_task_type(&reg, "implementation").unwrap();
        assert_eq!(
            impl_reg.len(),
            reg.len() - 4,
            "implementation 应仅剔除 4 个 browser_*（其余全量保留）"
        );
        assert!(impl_reg.has("write_file"));
        assert!(impl_reg.has("shell_command"));
        assert!(impl_reg.has("run_subagent"));
        // 原注册表不受影响（非破坏性裁剪）
        // 34 内置（含 W4-R block_set_attr + D4 kill_subagent/
        // send_message + 维度五 create_workflow）+ 4 browser_* 假工具
        assert_eq!(reg.len(), 38);
        assert!(reg.has("browser_navigate"));
    }

    // ===== T-D-08：命令级白名单（command_allowed_for_task_type）=====

    /// commit：仅 git 前缀（命令首词 = git）；非 git 一律拒绝
    #[test]
    fn command_policy_commit_only_git() {
        for cmd in [
            "git status",
            "git add -A",
            "git commit -m \"msg\"",
            "git -C src status",
            "git push origin main",
        ] {
            assert!(
                command_allowed_for_task_type("commit", cmd),
                "commit 命令 {cmd:?} 必须放行"
            );
        }
        for cmd in [
            "npm install",
            "cargo test",
            "ls -la",
            "gitty status",
            "gitx commit",
            "bash git status",
            "",
            "   ",
        ] {
            assert!(
                !command_allowed_for_task_type("commit", cmd),
                "非 git 前缀命令 {cmd:?} 必须拒绝"
            );
        }
    }

    /// implementation：构建/测试类普通命令放行（CommandClass Normal +
    /// 门禁放行）；发布/提权/毁灭/回退/间接/删除形态拒绝
    #[test]
    fn command_policy_implementation_build_test_whitelist() {
        for cmd in [
            "cargo build",
            "cargo test --workspace",
            "npm test",
            "npm run build",
            "tsc --noEmit",
            "python -m pytest tests",
        ] {
            assert!(
                command_allowed_for_task_type("implementation", cmd),
                "构建/测试命令 {cmd:?} 必须放行"
            );
        }
        for cmd in [
            "npm publish",
            "cargo publish",
            "sudo apt-get install x",
            "rm -rf src",
            "git reset --hard HEAD~1",
            "cd src",
            "bash -c 'cargo build'",
            "mkfs.ext4 /dev/sdb",
            "",
        ] {
            assert!(
                !command_allowed_for_task_type("implementation", cmd),
                "非构建/测试命令 {cmd:?} 必须拒绝"
            );
        }
    }

    /// 其余类型（含未知）：无命令——工具面已剔除 shell_command，命令级为兜底
    #[test]
    fn command_policy_other_task_types_no_commands() {
        for tt in ["analysis", "design", "review", "organization", "", "bogus"] {
            for cmd in ["git status", "cargo build", "npm publish", "ls -la"] {
                assert!(
                    !command_allowed_for_task_type(tt, cmd),
                    "{tt:?} 类型命令 {cmd:?} 必须拒绝"
                );
            }
        }
    }
}
