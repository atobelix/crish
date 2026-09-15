# 子 Agent 深度代码审计记录说明

本目录存放各子 Agent 对 Conex 与 DeepSeek Harness 展开的源码级深度审计报告。

## 审计文件索引清单

1. `01-audit-kernel-and-plugins.md`：微内核插件体系与 Rust Workspace 静态模块审计
2. `02-audit-agent-loop-control-flow.md`：ReactLoopAgent vs session-loop 状态机与抢占中断机制审计
3. `03-audit-persistence-and-event-log.md`：JSONL vN 事件溯源 vs SQLite 事务与快照恢复审计
4. `04-audit-tools-sandboxing-security.md`：PTC 编程调用与 OS 沙箱 vs AST 语法树门禁审计
5. `05-audit-subagent-coordination-acp.md`：多代理协同、死锁防护与 ACP/LSP 协议审计
6. `06-audit-desktop-host-and-performance.md`：Electron+Node 管道模型 vs Tauri 2 进程内原生性能审计
