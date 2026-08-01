# AU-02 执行任务书问题覆盖完整性审计

> 审计日期：2026-08-01 · 审计性质：只读（不改任何代码，产出本审计文档）
> 审计范围：8 份审查文档（AA-01 ~ AA-08，编号问题约 164 项 + AA-04 主题约 40 项 + AA-06 24 项，合计约 217 项）→ 10 份任务书（PE-01 ~ PE-10）
> 覆盖口径：
> - **已覆盖**：任务书有明确任务编号、具体文件与验收断言；
> - **部分覆盖**：有任务但缺关键点、表述笼统、或声明承接但无任务体；
> - **未覆盖**：任何任务书只字未提，或仅列「移交 XX 域」但该域不存在对应任务书；
> - **明确不做**：有边界声明与理由（可接受，但若全仓无后续承接则标注「有决议、无后续」）。

---

## 一、覆盖矩阵总表（按 AA 编号分组）

### 1.1 AA-01 Rust 核心代码审查（41 项：阻塞 1 / 重要 4 / 建议 27+正面记录）

| 编号 | 严重度 | 承接任务书 | 状态 |
|---|---|---|---|
| Q01 cancel-siblings 漏标 | 阻塞 | PE-06 T06.1（4 用例 + 事件契约锚定） | 已覆盖 |
| Q02 abort_reason 只写不读 | 建议 | PE-06 T06.3（删除 + aborted_with_diagnostic 透出） | 已覆盖 |
| Q03 steering_enabled 死配置 | 重要 | PE-06 T06.2.1（两处短路接线） | 已覆盖 |
| Q04 compression_hook 死配置 | 建议 | PE-06 T06.2.3（删除，记录「未来任务」） | 已覆盖（删除决策） |
| Q05 payload_recovery 假恢复 | 重要 | PE-06 T06.2.2（直接 fatal，删阶梯） | 已覆盖 |
| Q06 safe_point 三函数 | 建议 | PE-06 T06.3（#[cfg(test)]） | 已覆盖 |
| Q07 withdraw 仅测试 | 建议 | PE-06 T06.3 | 已覆盖 |
| Q08 EmitDiagnostic 死分支 | 建议 | PE-06 T06.3（与 Q32 合并接线） | 已覆盖 |
| Q09 SelfTerminationDiagnostic | 建议 | PE-06 T06.3（#[doc(hidden)]） | 已覆盖 |
| Q10 to_tool_output 无调用 | 建议 | PE-06 T06.3（删除） | 已覆盖 |
| Q11 AgentSessionContext.abort_reason | 建议 | PE-06 T06.3（删除） | 已覆盖 |
| Q12 SteeringPhase 占位变体 | 建议 | PE-06 T06.3（保留 + 文档标注） | 已覆盖 |
| Q13 soft 兼容别名 | 建议 | PE-06 T06.3（删除） | 已覆盖 |
| Q14 idempotency 死配置 | 建议 | PE-06 T06.4.1（接线，默认 false） | 已覆盖 |
| Q15 SteeringInputEntry.session_id 恒空 | 建议 | PE-06 T06.3（删除） | 已覆盖 |
| Q16 锁中毒 idempotency 10 处 | 重要 | PE-06 T06.6 + PE-07 T07.6 | 已覆盖（双书重叠见 §五.4） |
| Q17 锁中毒 bridge 26 处 | 重要 | PE-06 T06.6 + PE-07 T07.6 | 已覆盖 |
| Q18 RecordingMiddleware 锁 | 建议 | PE-06 T06.3/T06.6 + PE-07 T07.6 | 已覆盖 |
| Q19 合理 expect | 建议 | PE-06 T06.3（保留，标注预期保留） | 已覆盖（明确保留） |
| Q20 with_scripts 延迟 panic | 建议 | PE-06 T06.3（构造期校验） | 已覆盖 |
| Q21 取消长工具需等 timeout | 重要 | 无 | **未覆盖**（PE-06 §7 移交「PE-05 运行行为域」，但 PE-05 为前端组件化，不含此项） |
| Q22 pending 表竞态窗口 | 建议 | 无 | **未覆盖**（移交「agent-tools 生命周期域」，无任务书） |
| Q23 会话级 sequence 分配 | 重要 | 无 | **未覆盖**（orchestrator 域；PE-08 仅承接 Q24，Q23 同会话并发 run 场景无人处理） |
| Q24 恢复后 sequence 冲突 | 重要 | PE-08 T08.8（seed_sequences + 门禁 + 集成验收） | 已覆盖 |
| Q25 失败路径序列空洞 | 建议 | PE-08 T08.8 可选子项（L3，「未接则记录决策」） | 部分覆盖（非强制） |
| Q26 终态映射语义冲突 | 重要 | PE-08 T08.9（D1 裁决 MaxTurns→Failed + 互引测试） | 已覆盖 |
| Q27 同步 SQLite 阻塞 | 建议 | PE-01 T06.4 + PE-08 T08.5（spawn_blocking） | 已覆盖（双书重叠见 §五.4） |
| Q28 spawn 无句柄 | 建议 | 无 | **未覆盖**（移交「agent-tools 生命周期域」，无任务书） |
| Q29 错误体系与 CrishError 脱节 | 重要 | PE-04 T04.3-3（LoopError/EndDecision/RunOutcome 升级）+ PE-06 T06.5 | 已覆盖（双书分工见 §五.4） |
| Q30 From<CoreError> 语义存疑 | 建议 | PE-04 T04.3-6 + PE-06 T06.5.4 + PE-03 T03.3（三书一致：显式工厂） | 已覆盖 |
| Q31 兜底文案信息不足 | 建议 | PE-04 T04.3-5 + PE-06 T06.5.5 | 已覆盖 |
| Q32 预算耗尽静默跳过 | 建议 | PE-06 T06.3（EmitDiagnostic 接线） | 已覆盖 |
| Q33 aborted 标注不一致 | 建议 | 无 | **未覆盖**（PE-06 §7 移交「PE-05 运行行为域」，同上落空） |
| Q34 防御路径信息量低 | 建议 | PE-06 T06.5.6 | 已覆盖 |
| Q35 审批并行退化 | 建议 | PE-09 T09.6（Arc<ApprovalGate> 恢复并行） | 已覆盖（PE-06 §7 曾判「记录不改」，PE-09 升级为修复） |
| Q36 SeqCst 微调 | 建议 | PE-06 §7（顺手做） | 部分覆盖（无独立任务体） |
| Q37 batch id 前缀 | 建议 | PE-06 §7（顺手做） | 部分覆盖（无独立任务体） |
| Q38 apply_leaf_move 扩展性 | 建议 | 无（AA-01 判「保留现状即可，记录」） | 明确不做（可接受） |
| Q39 工具错误循环判定偏差 | 建议 | 无 | **未覆盖** |
| Q40 重试间隙不查 abort | 建议 | 无 | **未覆盖**（PE-06 §7 移交「PE-05 运行行为域」，落空） |
| Q41 注入时钟 | 建议 | 无 | **未覆盖**（移交「测试基础设施域」，无任务书） |

### 1.2 AA-02 Tauri 壳审查（27 项：重要 6 / 建议 21）

| 编号 | 严重度 | 承接任务书 | 状态 |
|---|---|---|---|
| W-1 core_check_command 恒失败 | 重要 | PE-03 T03.6（SharedGatekeeper 注入 + 单例化 + 前端去静默兜底） | 已覆盖 |
| W-2 tracing 全静默 | 重要 | PE-04 T04.1（双通道 + panic hook + 崩溃文件，启动失败路径补日志） | 已覆盖 |
| W-3 app_dir 打包路径 | 重要 | PE-01 T05.1（RuntimePaths 真源） | 已覆盖 |
| W-4 config_dir 路径分裂 | 重要 | PE-01 T05.2（同根 + 首启迁移） | 已覆盖 |
| W-5 commandMap 幽灵条目 | 重要 | PE-03 T03.1（manifest 清单驱动 + 9 条删除） | 已覆盖 |
| W-6 状态不诚实 | 重要 | PE-01 T01.2 + PE-04 T04.5-1（双书同源改造） | 已覆盖 |
| S-1 20 个死面命令 | 建议 | PE-03 T03.5（裁决表逐项） | 已覆盖 |
| S-2 core_*/perf_* 双注册 | 建议 | PE-03 T03.5（perf 注册删除） | 已覆盖 |
| S-3 active_run 死代码 | 建议 | PE-03 T03.5（删除，H2 改 activeRuns） | 已覆盖 |
| S-4 WorkbenchRunTaskRequest / apply_update stub | 建议 | PE-03 T03.5（删除 + 显式不可用错误） | 已覆盖 |
| S-5 error_bridge 死模块 | 建议 | PE-03 T03.3（删除） vs PE-04 T04.1-4/T04.3-4（接线保留） | **部分覆盖/冲突**（见 §五.3） |
| S-6 daemon 命名残留 | 建议 | PE-01 T03.1 + PE-03 T03.4 | 已覆盖 |
| S-7 reqwest 不跨 run 复用 | 建议 | 无 | **未覆盖**（PE-01 §2.2 划为「引擎/安全域」边界外；PE-09 无连接池任务；PE-10 仅版本收敛） |
| S-8 丢帧无观测 | 建议 | PE-04 T04.2-3（EmitReport → tracing::warn） | 已覆盖 |
| S-9 同步命令阻塞 IPC | 建议 | PE-03 T03.3（perf 迁移 spawn_blocking） | 部分覆盖（仅 perf 面；fs 的 list_directory 上限/read_file_content 的 spawn_blocking 未列动作） |
| S-10 run_control no-op | 建议 | PE-03 T03.3（未接线 level 返回明确错误） | 已覆盖 |
| S-11 审批半成品 | 建议 | 无 | **未覆盖** |
| S-12 cwd 行为不一致 | 建议 | PE-03 GUI 面（pty_create cwd 语义对齐） | 已覆盖 |
| S-13 host_openers PS 拼接 | 建议 | PE-07 T07.1 动作 2（3 处调用点改 evaluate_line） | 部分覆盖（门禁调用点已含；「Command::new + 结构化参数 / lnk-rs」注入面本体无任务） |
| S-14 http_request 无限制 | 建议 | PE-03 GUI 面（长度限制） | 已覆盖（SSRF 面 I-03 见 AA-05，范围外） |
| S-15 参数校验不统一 | 建议 | PE-03 T03.3 动作 4（trim+上限+InvalidInput helper） | 已覆盖 |
| S-16 空 id 未校验 | 建议 | PE-03 T03.3 动作 4 + 契约表（空 runId→InvalidInput） | 已覆盖 |
| S-17 mcp:default capability | 建议 | 无 | **未覆盖** |
| S-18 事件库/会话库共用连接 | 建议 | 无 | **未覆盖** |
| S-19 perf_encoding_encode 未注册 | 建议 | PE-03 T03.5（删除定义） | 已覆盖 |
| S-20 旧 core_get_status 残留 | 建议 | PE-03 T03.4 动作 7 | 已覆盖 |
| S-21 会话双数据源 | 建议 | PE-08 T08.10（写者所有权定稿） | 部分覆盖（所有权定了；「SQLite 消息 = 事件流投影」的关系界定与前端 hydration 单真源无明确任务） |

### 1.3 AA-03 前端状态/hooks 审查（25 项：重要 9 / 建议 16）

| 编号 | 严重度 | 承接任务书 | 状态 |
|---|---|---|---|
| Q01 引擎就绪四份复制 | 重要 | PE-01 T04.1 + PE-06 T06.11 | 已覆盖（双书重叠见 §五.4） |
| Q02 sessions 三写竞态 | 重要 | PE-01 T04.4 + PE-06 T06.11 | 已覆盖 |
| Q03 hydration 门闩 | 重要 | PE-01 T04.4 + PE-06 T06.11 | 已覆盖 |
| Q04 遥测三份死代码 | 重要 | PE-06 T06.7.1（删 6 文件） | 已覆盖 |
| Q05 providerStore 直连 fetch | 重要 | PE-06 T06.9.2（accountStatusApi） | 已覆盖 |
| Q06 shell 直取 store | 重要 | PE-06 T06.9.1（compositionRoot.tree 门面 + 订阅生命周期化） | 已覆盖 |
| Q07 WindowResizeBridge 未接线 | 重要 | PE-06 T06.10（connect + 删 E13） | 已覆盖 |
| Q08 AppBootstrap immer 直写 | 重要 | PE-06 §2.2 声明「收敛（T06.11）」但 T06.11 任务体仅 Q01/Q02/Q03 | **部分覆盖**（声明无任务体） |
| Q09 门禁违例显式 any | 重要 | PE-06 T06.7（门禁扩展 layout-helpers/workspace-shell） | 已覆盖 |
| Q10 bootstrapStores/storeTransaction 死代码 | 建议 | PE-06 T06.7.2（删除） | 已覆盖 |
| Q11 window 全局 + 计数订阅 | 建议 | PE-06 T06.9.1（移 DEV 分支） | 已覆盖 |
| Q12 SessionSyncService 双同步 | 建议 | PE-03 T03.7（删 sync-pull/push 协议） | 部分覆盖（协议删除已定；`destroy()` 生命周期修复无任务） |
| Q13 连接状态三处投影 | 建议 | PE-01 T04.3（ConnectionManager 单投影） | 已覆盖 |
| Q14 restore 策略双份实现 | 建议 | 无 | **未覆盖**（PE-06 §7「记录待后续前端域」） |
| Q15 useSlashSend 激活绕过 | 建议 | PE-06 T06.8 组 1（经 shell.openOrFocusSession） | 已覆盖 |
| Q16 回灌后直激活 | 建议 | PE-06 T06.8 组 1（store-persistence 回灌改经 session 命名 action） | 已覆盖 |
| Q17 hooks 直改 store（useAgentStream） | 建议 | PE-06 §2.2 声明「归入对应任务」 | **部分覆盖**（无任务体；流式热路径优化 streamingStore 缓冲无明确任务） |
| Q18 类型逃逸三处 | 建议 | PE-06 T06.7（门禁扩展至 hooks/workspace-shell） | 部分覆盖（门禁扩展已定；`setActiveDiffSource as any`/`approvalMeta`/`node: any` 三处消除点无任务体） |
| Q19 useSidebarSessions 范式 | 建议 | 无 | **未覆盖**（§2.2 声明「归入对应任务」，无任务体） |
| Q20 useWindowControls 死 hook | 建议 | PE-06 T06.7.2（删除） | 已覆盖 |
| Q21 useStreamRenderThrottle 死 hook | 建议 | PE-06 T06.7.2（待 E2 裁决）+ PE-02 T02.3（接线保留） | 已覆盖（PE-02 实际接线，裁决自然闭合） |
| Q22 三套拖拽控制器 | 建议 | PE-06 T06.8 组 3（pointer-drag 基座） | 已覆盖 |
| Q23 虚拟滚动重复 | 建议 | PE-06 T06.8 组 5 | 已覆盖 |
| Q24 回灌双实现 | 建议 | PE-01 T04.4（sessionIndexLoader 并入 E3）+ PE-06 T06.11 | 已覆盖 |
| Q25 API 无类型契约 | 建议 | PE-06 T06.9.2（类型守卫，与 Q05 同任务） | 已覆盖 |

### 1.4 AA-04 前端组件/样式审查（无编号，按主题）

| 主题 | 承接任务书 | 状态 |
|---|---|---|
| 32 个 >400 行大组件 | PE-05 T05.4（拆 10 个 600+）+ T05.6 | 部分覆盖（600+ 全覆盖；400-600 的 17 个与其余小件无计划——方案未承诺，可接受） |
| 弹窗 7 套 + 可选 4 处 | PE-05 T05.2 | 已覆盖 |
| 菜单 12 套 + 坐标 3 套 | PE-05 T05.3（ui/Menu 收敛） | 已覆盖 |
| 按钮/输入/选择器三轨 | PE-05 T05.1.2/1.6 | 已覆盖 |
| 样式双轨（29 全局 css + module） | PE-05 T05.5.2/5.5.4/5.5.5 | 已覆盖 |
| tokens 硬编码 hex / 语义别名 / 缺 token | PE-05 T05.5.1 | 已覆盖 |
| z-index 双源 | PE-05 T05.5.3（check:zindex 脚本） | 已覆盖 |
| shim 目录（settings-tabs 等） | PE-05 T05.6.2 | 已覆盖 |
| @deprecated / is-danger 死类 | PE-05 T05.8 | 已覆盖 |
| 目录化收尾（顶层扁平） | PE-05 T05.6 | 已覆盖 |
| 命名债务（daemon/WS） | PE-05 T05.7 | 已覆盖 |

### 1.5 AA-05 安全审查（24 项：严重 2 / 高 3 / 中 9 / 低 10）

| 编号 | 严重度 | 承接任务书 | 状态 |
|---|---|---|---|
| C-01 红线门禁绕过 | 严重 | PE-07 T07.1（token 化三层管线 + 37 用例） | 已覆盖 |
| C-02 git shell 拼接注入 | 高 | PE-07 T07.3（workbench_git_run 参数数组） | 已覆盖 |
| C-03 reverseFileDiff 注入 | 中 | PE-07 T07.3（workbench_fs_delete_file） | 已覆盖 |
| C-04 免审批通道 + git 无审批 | 中 | PE-07 T07.3（git 参数 schema 限制）+ T07.1 §2.1.5（终端免审批文档化） | 已覆盖 |
| P-01 workspace_root 调用方入参 | 严重 | PE-07 T07.2（WorkspaceRegistry 唯一真源 + 命令签名删参） | 已覆盖 |
| P-02 工具层残余 + guard 退化 | 低 | PE-07 T07.2（from_optional_root 删除） | 部分覆盖（删参已含；drive-relative/UNC 变体单测未列） |
| P-03 终端/PTY cwd 越界 | 中 | PE-07 T07.2 延伸（cwd 收敛注册表 + 上下文门禁） | 已覆盖 |
| K-01 localStorage 明文 key | 高 | PE-07 T07.4 A/B（下线 + 一次性迁移）；另见 PE-01 T03.2/T03.3 | 已覆盖（双书重叠冲突见 §五.4） |
| K-02 secret_get 回传明文 | 中 | PE-07 T07.4 C（默认 last4 + reveal 确认） | 已覆盖 |
| K-03 DPAPI ACL | 低 | PE-07 §2.4.2 D 注「可选低优先子项，不阻塞」 | 明确不做（有决议、无任务） |
| K-04 SecretString zeroize | 低 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| K-05 cmd 明文 key + 无脱敏 | 低 | PE-07 T07.4 D（删组装 + redact_secret） | 已覆盖 |
| M-01 MCP server 配置白名单 | 中 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| M-02 远端工具名净化 | 中 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| M-03 call_tool 透传/结果进库 | 低 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| I-01 debug MCP socket | 高 | PE-07 T07.5（默认关 + token + 命令集收缩，决策树三路径） | 已覆盖 |
| I-02 审批 tool_call_id 校验 | 中 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| I-03 HTTP SSRF | 中 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| I-04 session 命令存在性 | 低 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| I-05 PTY 归属校验 | 中 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| D-01 WAL/busy_timeout + 空删 | 低 | PE-08 T08.7（PRAGMA 前置）+ T08.2（空 keepIds 拒绝） | 已覆盖 |
| D-02 事件 payload 无上限 | 低 | PE-07 T07.4 D（写库前脱敏） | 部分覆盖（脱敏有任务；**payload 大小上限/截断无任何任务**） |
| X-02 ammonia class/style | 中 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| X-03 window store 生产暴露 | 低 | PE-07 §0.3 范围外 | 明确不做（有决议、无任务） |
| X-04 innerHTML 使用点登记 | 低 | PE-07 T07.7 B9（基线要求「必须标注来源」） | 部分覆盖（基线文档要求，无代码改动任务） |

### 1.6 AA-06 性能审查（P1-P11 / F1-F7 / M1-M2）

| 编号 | 严重度 | 承接任务书 | 状态 |
|---|---|---|---|
| P1/F1 首 token 延迟 | 高 | PE-09 T09.1 + PE-02 T02.1（契约）+ T02.6（测量） | 已覆盖（跨书契约分工清晰） |
| P2 事件克隆风暴 | 高 | PE-09 T09.2（type_name + by value + 0 clone） | 已覆盖 |
| P3 对话全量克隆 | 高 | PE-09 T09.3（借用链 + Arc 化 + mem::take） | 已覆盖 |
| P4 record_message 双克隆 | 中 | PE-09 0.4 非目标（Arc 化等价收益，不改 wire） | 已覆盖（等价替代，合理） |
| P5 SSE 帧解析 | 中 | PE-09 0.4 非目标（T09.1 步骤 2 逐帧 push_frame 顺带受益） | 部分覆盖（serde 派生结构体替代 Value 未做，属顺带） |
| P6/F7 DB 写放大 | 中 | PE-09 T09.4（append 命令 + upsert + 前端增量） | 已覆盖 |
| P7 事件分页全量加载 | 中 | PE-09 T09.5（SQL LIMIT 下推） | 已覆盖 |
| P8 审批并行退化 | 中 | PE-09 T09.6（Arc<ApprovalGate>） | 已覆盖 |
| P9 事件桥序列化链 | 低 | PE-09 0.4 后续低优先域 | 明确不做（有决议、无任务） |
| P10 丢帧线性扫描 | 低 | PE-09 0.4 后续低优先域 | 明确不做（有决议、无任务） |
| P11 对话无上限 | 中 | PE-09 0.4 后续域；PE-06 T06.2.3 删除 CompressionHook | **决策冲突**（AA-06 建议实现压缩，PE-06 删除压缩钩子；PE-06 有裁决记录，但 P11 的滚动窗口建议无人承接） |
| F2 StreamRenderBuffer 拼接 | 低 | PE-02 T02.5 可选子项 | 已覆盖（可选） |
| F3 streamingStore spread | 低 | AA-06 判「无需改动」 | 不适用（审查自判无害） |
| F4 markdown 单条 IPC | 低 | PE-02 附录 B（可选接线，不强制） | 部分覆盖（可选） |
| F5 store 工具输出截断 | 低 | PE-09 0.4 前端域非目标 | **未覆盖** |
| F6 启动串行链 | 低 | PE-09 0.4 低优先 | 明确不做（有决议、无任务） |
| M1 前端消息全量驻留 | 中 | PE-09 0.4 前端域非目标 | **未覆盖** |
| M2 事件表只增不删 | 低 | PE-08 T08.3（保留策略/归档/上限） | 已覆盖（跨域自然承接） |
| 基准基建（Rust 侧 benches 缺失） | — | PE-09 T09.7（Criterion 5 场景 + TTFB 测量） | 已覆盖 |

### 1.7 AA-07 数据持久化审查（18 项：阻塞 2 / 重要 9 / 建议 7）

| 编号 | 严重度 | 承接任务书 | 状态 |
|---|---|---|---|
| P01 新会话不落库 | 阻塞 | PE-01 T06.1 + PE-08 T08.1 | 已覆盖（双书方案不一致，见 §五.4） |
| P02 空 keepIds 全删 | 阻塞 | PE-01 T06.2 + PE-08 T08.2 | 已覆盖（双书处置语义不一致，见 §五.4） |
| P03 events 无 FK/无清理 | 重要 | PE-08 T08.3/T08.7（v4 FK + 保留策略） | 已覆盖 |
| P04 runs.cursor 死列 | 重要 | PE-08 T08.4（接线保留列 + 三处终态写点） | 已覆盖 |
| P05 同步 DB 阻塞 | 重要 | PE-01 T06.4 + PE-08 T08.5（8 方法 spawn_blocking） | 已覆盖（双书重叠见 §五.4） |
| P06 恢复/快照生产未接线 | 重要 | PE-08 T08.6（main.rs 接线 + 三触发点 + 会话树注册表） | 已覆盖 |
| P07 迁移非版本化 | 重要 | PE-08 T08.7（user_version 循环迁移 + 备份 + v4） | 已覆盖 |
| P08 全量替换写模型 | 重要 | PE-08 T08.10（写者所有权 + 串行化 + CAS 预留） | 已覆盖 |
| P09 30 天清理矛盾 | 重要 | PE-01 T06.3 + PE-08 T08.2/T08.10（SQLite 核对 + 真相源切换） | 已覆盖 |
| P10 懒壳清理冲突 | 重要 | PE-01 T06.3 + PE-08 T08.2/T08.10（宽限期 + 剪枝列表改 keepIds） | 已覆盖 |
| P11 时间戳三套 | 建议 | PE-08 §五 L1（范围外，v5 候选） | 明确不做（有决议、无任务） |
| P12 metadata 死表 | 建议 | PE-08 T08.7（v4 DROP） | 已覆盖 |
| P13 冗余索引 | 建议 | PE-08 T08.7（v4 组合主键） | 已覆盖 |
| P14 AUTOINCREMENT 冗余 | 建议 | PE-08 T08.7（v4） | 已覆盖 |
| P15 WAL/busy_timeout | 建议 | PE-08 T08.7（open 前置 PRAGMA） | 已覆盖 |
| P16 快照失败无标记 | 建议 | PE-08 T08.6 动作 5（snapshot_last_error + status 字段） | 已覆盖 |
| P17 beforeunload 双写 | 建议 | PE-08 T08.10 动作 4（清理后移除 LS 镜像写） | 已覆盖 |
| P18 agent 40 条截断 | 建议 | PE-08 T08.10 动作 5（记录截断事实）+ 范围外 L2 | 部分覆盖（只记录不改造，符合审查建议下限） |

### 1.8 AA-08 依赖与构建审查（29 项：高 2 / 中 9 / 低 18）

| AA-08 # | 承接任务书 | 状态 |
|---|---|---|
| 1-29 全量 | PE-10 附录 5.1 逐条映射（T10.1~T10.11） | **全部已覆盖** |

---

## 二、未覆盖问题清单（重点）

> 判定原则：阻塞/严重级问题必须全覆盖（已满足，见 §六.1）；以下为**没有任何任务书承接**的问题，多数带「移交 XX 域」注释但目标域无对应任务书。

| # | 问题 | 严重度 | 现状（任务书中的痕迹） | 风险 |
|---|---|---|---|---|
| 1 | AA-01 Q21：取消对运行中长工具最长等 60s 才生效，MCP 远端继续执行 | 重要 | PE-06 §7「移交 PE-05（运行行为域）或本域后续轮」——**PE-05 是前端组件化任务书，无此内容** | 用户取消体验差；超时 drop 后远端继续执行（费用/副作用） |
| 2 | AA-01 Q33：流中途 abort 已 commit 消息不带 stopReason=aborted 标注 | 建议 | PE-06 §7 同上移交，落空 | partial salvage 标注不一致，前端语义失真 |
| 3 | AA-01 Q40：瞬态重试期间不检查 abort_signal | 建议 | PE-06 §7 同上移交，落空 | 取消后仍多 2-3 次无效请求 |
| 4 | AA-01 Q23：同会话并发 run 的 sequence 冲突（主 run + 子 agent 共享 store） | 重要 | PE-08 仅承接 Q24（恢复场景）；Q23 无任何提及 | 子 agent/协作场景 append_event UNIQUE 失败 → 整 run 标记 event-store-write-failed |
| 5 | AA-01 Q22：bridge pending 表 mark_exited 竞态 | 建议 | PE-06 §7「agent-tools 生命周期域」，无任务书 | 有限泄漏（30s 超时兜底），可接受但无治理 |
| 6 | AA-01 Q28：spawn_reader 等无 join/abort 句柄 | 建议 | 同上移交，落空 | 任务泄漏不可观测 |
| 7 | AA-01 Q39：detect_recent_tool_error_loop 判定偏差（纯文本无 Exit code 不判失败） | 建议 | 零提及 | steering 误判工具失败循环 |
| 8 | AA-01 Q41：时间脆弱测试（真实时钟） | 建议 | 移交「测试基础设施域」，无任务书 | 测试偶发失败 |
| 9 | AA-02 S-7：reqwest Client 不跨 run 复用 | 建议 | PE-01 §2.2 边界外「引擎/安全域」；PE-09/PE-07 均无对应任务 | 多 run 每轮重建连接池 |
| 10 | AA-02 S-11：审批半成品（deny 不恢复状态机、session-loop 审批门未接线） | 建议 | 零提及（PE-03 只处理 run_control no-op） | 审批 UI 与引擎状态脱节，命令已对前端开放 |
| 11 | AA-02 S-17：capabilities mcp:default release 构建权限校验 | 建议 | 零提及 | release 下权限空转或校验失败 |
| 12 | AA-02 S-18：事件库与会话库共用 SQLite 连接互斥 | 建议 | 零提及（PE-08 T08.5 只做 spawn_blocking，不分连接） | 高频场景写锁互斥 |
| 13 | AA-03 Q14：layoutTreeStore 与 hydrateWorkspaceShell restore 策略双份实现 | 建议 | PE-06 §7「记录待后续前端域」 | RESTORE_LAST_WORKSPACE_LS_KEY 三处判定漂移 |
| 14 | AA-03 Q19：useSidebarSessions 手写订阅范式 | 建议 | PE-06 §2.2 声明「归入对应任务」但无任务体 | 范式不统一 |
| 15 | AA-05 范围外 10 项：I-02 / I-03 / I-05 / M-01 / M-02 / M-03 / K-03 / K-04 / X-02 / X-03 | 中/低 | PE-07 §0.3 明确范围外，「归后续批次（AA-05 P1/P2）」——**没有任何任务书承接这批** | 均为中低危，可暂缓；但「后续批次」无落点，需登记到 30-verification-checklist 或后续计划 |
| 16 | AA-06 F5：store 层工具输出无截断（M1 同源） | 低 | PE-09 0.4「前端域非目标」 | 长会话内存增长 |
| 17 | AA-06 M1：前端消息全量驻留 | 中 | PE-09 0.4 非目标 | 长会话内存持续增长 |
| 18 | AA-06 P9/P10/F6 | 低 | PE-09 0.4 后续低优先域，无任务书 | 低危，可接受 |

## 三、部分覆盖问题清单（缺什么）

| # | 问题 | 承接 | 缺失点 |
|---|---|---|---|
| 1 | AA-01 Q25：失败路径序列空洞 | PE-08 T08.8 可选子项 | 标注「可选/未接则记录决策」——建议改为必做（与 Q24 同文件、改动极小），否则序列连续性承诺仍被破坏 |
| 2 | AA-01 Q36/Q37：SeqCst / batch id 前缀 | PE-06 §7「顺手做」 | 无任务体、无验收；建议并入 T06.4.2 或单列 |
| 3 | AA-02 S-9：同步命令阻塞 | PE-03 T03.3 仅 perf 面 | fs_commands 的 list_directory 分页上限、read_file_content/write_file_content 的 spawn_blocking 无动作；PE-03 GUI 面清单 workbench_list_directory 也未列上限 |
| 4 | AA-02 S-13：host_openers 注入面 | PE-07 T07.1 仅门禁调用点 | 「Command::new + 结构化参数 / lnk-rs」替换 PS 拼接无任务；建议并入 PE-07 或另列 |
| 5 | AA-02 S-21：会话双数据源 | PE-08 T08.10 所有权定稿 | 「SQLite 消息 = 事件流投影」的关系界定、前端 hydration 层统一真源无任务；PE-08 结论（前端唯一拥有 session_messages）与「投影」表述仍需一致性确认 |
| 6 | AA-03 Q08：folder rebind immer 直写 | PE-06 §2.2 声明 T06.11 承接 | T06.11 任务体只有 Q01/Q02/Q03 三行——Q08 无具体动作/验收；需补任务体或移入 PE-01（其 T04.x 已覆盖 AppBootstrap） |
| 7 | AA-03 Q12：SessionSyncService | PE-03 T03.7 删协议 | 服务销毁（destroy/cleanup）与 IndexedDB 队列去留无任务；若按 T03.7 删除服务则闭环，需写明 |
| 8 | AA-03 Q17/Q18：hooks 直改 store / 类型逃逸 | PE-06 仅门禁扩展 | 消除点（buildPatchAsst/finalizeInFlight 改 streamingStore 缓冲；`as any` 三处）无任务体；建议在 T06.8 补组或单列 |
| 9 | AA-04：>400 行组件 32 个 | PE-05 T05.4 仅 10 个 600+ | 400-600 区间 17 个（MessageVirtualizer/ModelConfigEditor/ExternalSessionImport 等 props 爆炸重灾区）无计划——方案未承诺全部，但建议注明「按需轮次」 |
| 10 | AA-05 P-02：工具层残余 | PE-07 T07.2 | drive-relative（`C:foo`）与 UNC 变体单测未列；from_optional_root 删除后 WorkspaceFsGuard 的「根不可达退化」路径建议补测 |
| 11 | AA-05 D-02：事件 payload 上限 | 仅脱敏部分覆盖 | **payload 大小上限（如 256KB）+ 截断标记无任何任务**；建议并入 PE-08 T08.3（同为 events 表治理） |
| 12 | AA-06 P5：帧解析 | PE-09 0.4 顺带 | 「顺带受益」不可验收；若 T09.1 改造后仍用 Value 全树解析，建议补 serde 派生结构体子任务（收益大、独立、有测试锚定） |
| 13 | AA-06 F4：md_render_batch 接线 | PE-02 附录 B 可选 | 首屏 1000+ 消息每消息 1 次 IPC；建议纳入 PE-02 M3 或显式延后 |
| 14 | AA-07 P18：agent 40 条截断 | PE-08 T08.10 动作 5 | 只记录截断事实；「软提示 / 分页存储」未做——符合审查建议下限，可接受 |
| 15 | AA-05 X-04：innerHTML 使用点 | PE-07 T07.7 B9 | 仅基线文档要求，无代码层 DOMPurify 纵深防御动作（审查建议为「可选」，可接受） |

## 四、验收标准抽查结果（每任务书 3 项）

> 抽查原则：是否可检查 = 有具体断言/命令/量化阈值，而非「跑测试」「手工验证」空话。

| 任务书 | 抽查任务 | 判定 | 说明 |
|---|---|---|---|
| PE-01 | T05.1 | **合格** | 4 条断言：mock 目录断言、sessions.db 路径 == app_data_dir 集成断言、`env!("CARGO_MANIFEST_DIR")` grep 断言、dev 回归命令 |
| PE-01 | T06.2 | **合格** | Rust 测试「空数组行数不变」+「非空仍删孤儿」+ 前端守卫单测 + 回归 |
| PE-01 | T03.3 | **合格** | 3 条单测（迁移成功/失败重试/幂等跳过）+ grep 明文赋值断言 |
| PE-02 | T02.2 | **合格** | V1-V5：DOM 断言（data-block-id 数、md-code-block）、组件测试 5 用例、tsc |
| PE-02 | T02.6 | **合格** | 量化基线表 5 项（首 token <500ms、p95<8.3ms、无长任务>50ms、LINE_CACHE ≤10000） |
| PE-02 | T02.1 | **合格** | 契约正文冻结 + A1-A4（类型对齐、`cargo check -p session-loop` 通过） |
| PE-03 | T03.1 | **合格** | core_list_commands 返回 64 条、grep 幽灵条目零命中、commandMap.test 改 mock 清单 |
| PE-03 | T03.3 | **合格** | grep `Result<_, String>` 命令面零命中、error_bridge.rs 删除、每命令 1 成功+1 错误 golden |
| PE-03 | T03.8 | **合格** | golden 快照比对（ok.json/err.json 文件级）、清单一致性断言、直连冒烟 |
| PE-04 | T04.1-2 | **合格** | 日志文件存在且含 target 记录、panic 触发 crash-*.log 含三字段、cargo check |
| PE-04 | T04.3-3 | **合格** | 全链路 77 码贯通断言、18 个端到端场景全绿、新增 Display/WithCrish 测试 |
| PE-04 | T04.5-1 | **合格** | build_status 单测新字段断言、last_error 写入/读取测试 |
| PE-05 | T05.1.2 | **合格** | 31 消费方全换 Button、`ui-btn-*` 从 pane css 删除、is-danger 归零 |
| PE-05 | T05.3.3 | **合格** | ≥11/12 套基于 ui/Menu、`rg 'sort-filter-menu'` 归零、每套保留单测 |
| PE-05 | T05.4.1 | **部分合格** | 拆分 6 个子件明确，但验收仅「拆后跑其既有测试 + typecheck」——无新增断言（拆分行为等价难验证，建议补「子件 props/职责契约」审查项） |
| PE-06 | T06.1 | **合格** | 4 个新用例（混排/中段致命/审批退化/事件契约）+ run_loop 端到端断言具体到 id/事件对 |
| PE-06 | T06.6 | **合格** | `rg "\.expect\("` 归零（除测试/Q19）+ 中毒单测（A/B/C 三级） |
| PE-06 | T06.11 | **不合格** | 验收仅一句「store-initializers 集成测试」——无具体断言（订阅数、merge 串行、门闩时序）；且 Q08 无任务体（见 §三-6） |
| PE-07 | T07.1 | **合格** | 37 个用例逐条三态断言表 + 交叉验证脚本 |
| PE-07 | T07.2 | **合格** | 10 个场景断言（含原审计攻击复现 + recent 复授权 + 前端 payload 无 root 键） |
| PE-07 | T07.5 | **合格** | 6 个验证步骤脚本化（端口监听、token 握手、命令集、release 冒烟） |
| PE-08 | T08.1 | **合格** | 全新内存库链路、前端集成（新建空会话→persist→重启回灌）、FK 自愈、回归锚点 |
| PE-08 | T08.8 | **合格** | 关键验收明确：R1 seq=5 → 恢复审计 seq=6 → R2 base=7 连续无冲突、重复恢复幂等 |
| PE-08 | T08.6 | **合格** | 集成测试（drop 重建连接模拟崩溃）+ 生产冒烟断言（restore 状态、快照轮转） |
| PE-09 | T09.1 | **合格** | 首 token 集成测试 <600ms（改前 ≈5s）、双轨顺序断言、序列连续性三测试 |
| PE-09 | T09.2 | **合格** | 「drive_outcome/push 内无 .clone()」审查断言 + 25 type 名 roundtrip + 8 测试 |
| PE-09 | T09.5 | **合格** | limit=100 只取 101 行（内存 store 断言行数）、翻页归属一致性、restore 传 None |
| PE-10 | T10.1 | **合格** | 3 条 rg 核查（lock 含 workbench/reqwest 唯一/rev 锁定）+ `--locked` CI |
| PE-10 | T10.7a | **合格** | vendor-lucide 降至 100-200KB 量级 + `rg "import \* as Lucide"` 归零 |
| PE-10 | T10.11 | **合格** | DoD 10 项清单逐条可勾验（git ls-files/rg/cargo tree/体积复核） |

**抽查汇总**：30 项抽查中 **28 合格 / 1 部分合格（PE-05 T05.4）/ 1 不合格（PE-06 T06.11）**。
合格率 93%。不合格点集中在**启动链路收敛类任务**（PE-06 T06.11）——恰是风险最高、最需断言的任务，建议立即补验收（对齐 PE-01 T04.x 的断言风格）。

## 五、空白区清单（「大家都以为别人做了」的领域）

| # | 领域 | 现状 | 判定 |
|---|---|---|---|
| 1 | **abort 时序三问题（Q21/Q33/Q40）** | PE-06 §7 移交「PE-05（运行行为域）」；PE-05 实为前端组件化任务书 | **移交目标不存在**，三方落空——最高优先级空白区 |
| 2 | **agent-tools 生命周期（Q22/Q28）** | 移交「agent-tools 生命周期域」，无任务书 | 空白（低危） |
| 3 | **orchestrator 会话级 sequence（Q23）** | PE-08 只承接 Q24（恢复）；Q23 同会话并发 run 无人认领 | 空白（重要级）——子 agent 功能依赖 |
| 4 | **前端测试策略** | 10 份任务书均无「前端 e2e/visual/回归测试的持续策略」；PE-05 引用 `test:visual` 仅为迁移用；AA-04 正面提到的 playwright 快照无任务维护 | **空白**——组件大规模重构（PE-05/PE-06）没有配套的视觉回归门禁计划 |
| 5 | **持久化事件 schema 版本化** | PE-03 对 IPC 命令契约做了版本化（manifest + changelog，T03.9）；但**事件载荷/SQLite payload 的版本化**（旧事件 JSON 解析兼容、AgentEvent 字段演进）无任何任务（PE-04 R4 只提「旧事件兼容解析」为风险缓解，非版本化机制） | 部分空白——IPC 有、事件无 |
| 6 | **升级/迁移文档（用户数据侧）** | 密钥迁移（PE-01 T03.3/PE-07 T07.4）、schema 迁移（PE-08 T08.7）、workspace 重新授权（PE-07 风险 3）均有实现任务，但**统一的「版本升级指南/迁移清单」文档无任务**；各方案只有零散产品文案注记 | 部分空白 |
| 7 | **「AA-05 P1/P2 后续批次」承接** | PE-07 §0.3 将 10 项中低危列为范围外「归后续批次」，但无任何任务书（或 30-verification-checklist）登记 | 有决议、无落点 |
| 8 | **PE-06 声称「归入对应任务」但无任务体的 4 项** | Q08（T06.11）、Q17/Q18/Q19（门禁/去重任务内） | 声明-任务体断裂（见 §三） |
| 9 | **基准与验收数据的交接** | PE-02 要求 PE-09 落地后复测首 token；PE-09 T09.7 要求基线存档——两书互为依赖，但没有「谁验收 G3 总指标」的 owner（PE-02 写「与 PE-09 联调时执行」，PE-09 写「与 PE-02 联调时执行」） | 双方互等，需指定单一 owner（建议 PE-09 T09.8） |

## 六、审计结论与补全建议

### 6.1 总体结论

1. **阻塞/严重/高危全覆盖（达标）**：5 个阻塞（AA-01 Q01 → PE-06 T06.1；AA-07 P01/P02 → PE-01+PE-08；AA-05 C-01/P-01 → PE-07 T07.1/T07.2）、重要级（AA-01 Q24/Q26、AA-02 W-1~W-6、AA-03 Q01~Q07、AA-06 P1-P3、AA-08 两项高危）**全部有任务承接**，且均为文件级+断言级细化，验收标准普遍可执行。
2. **覆盖率**：编号问题 164 项中——已覆盖约 122 项（74%）、部分覆盖约 15 项（9%）、未覆盖约 17 项（10%）、明确不做约 10 项（6%）。若将「明确不做且有决议」视为受控，则**实际脱管面约 12%（未覆盖+声明断裂）**，其中重要级脱管 2 项（Q21、Q23）。
3. **任务书质量整体高**：验收标准抽查合格率 93%；跨书契约（PE-02↔PE-09、PE-06↔PE-04 错误类型分工、PE-03↔PE-07 配置命令面）分工基本清晰。
4. **主要风险不在遗漏而在协同**：见 6.2 的三处任务书间冲突/重叠，以及 §五 的移交落空。

### 6.2 任务书间冲突与重叠（需协调裁决）

| # | 冲突 | 双方 | 建议 |
|---|---|---|---|
| 1 | **P01/P02/P05/P09/P10 双书重复实施**：PE-01 T06.1 用「`upsert_session_entry(session_id, title)` 薄包装」+「空数组返回 Ok(0)」；PE-08 T08.1/T08.2 用「`upsert_session_entry(entry: SessionIndexEntry)` + save 前自愈 INSERT OR IGNORE」+「空数组返回错误 + confirm_empty 参数」——同一问题两种接口与错误语义 | PE-01 vs PE-08 | 指定 PE-08 为持久化域唯一权威（其覆盖完整度更高），PE-01 T06 组改为引用 PE-08 或标记「已移交」；`confirm_empty` 的 Ok(0)/Err 语义二选一 |
| 2 | **密钥迁移双书重复**：PE-01 T03.2/T03.3 新建 rustProfileStore + migrateLegacyProfiles（走 config_secret_set + config_update）；PE-07 T07.4 新建 workbench_profile_apply（进程内读 DPAPI 直写 ApiConfigStore）——两套 API 面与迁移编排 | PE-01 vs PE-07 | 明确 PE-07 的 `workbench_profile_apply` 为唯一密钥路径（安全域权威），PE-01 的 T03.2/T03.3 删除或收敛为引用；避免前端两个迁移函数并存 |
| 3 | **error_bridge 处置矛盾**：PE-03 T03.3「整个模块删除」；PE-04 T04.1-4「只做接线不移除」、T04.3-4「map_* 系列保留」——PE-04 R7 声称「本方案裁决删除」但自身任务体不删除 | PE-03 vs PE-04 | 以 PE-03（IPC 契约域）为终局：删除 error_bridge；PE-04 的任务改为「在删除前把 catch_unwind 语义迁入 core_error.rs」——两书需同步修订 |
| 4 | **compression_hook 处置冲突**：AA-06 P11 建议「实现并启用 CompressionHook」；PE-06 T06.2.3 删除 CompressionHook；PE-09 0.4 又把 P11 列为「后续低优先域」——压缩能力三处不一致 | AA-06 vs PE-06 vs PE-09 | PE-06 的删除决策本身合理（死代码治理优先），但需在 PE-09 中把 P11 从「后续域」改为「新开任务（真实压缩实现 + 滚动窗口）」或明确登记为不做，避免 AA-06 建议悬空 |

### 6.3 补全建议（按优先级）

**P0（立即补，重要级脱管）**
1. 为 Q21/Q33/Q40 新建任务书（或并入 PE-09——abort 语义与流式改造 T09.1 同文件区，成本最低）；PE-06 §7 的「PE-05 运行行为域」表述作废，改指向新承接。
2. 为 Q23（会话级 sequence 分配器）新建任务：与 PE-08 T08.8 同域（seed_sequences 之上加 AtomicU64 或 store 端自增），建议在 PE-08 补 T08.8 子项。
3. 裁决 §6.2 四处冲突，修订 PE-01/PE-04/PE-08 相应章节。

**P1（补任务体与验收）**
4. PE-06 T06.11 补具体验收断言（对齐 PE-01 T04.x 风格）；补 Q08 任务体。
5. PE-06 为 Q17/Q18/Q19 补任务体（或移入 T06.8/T06.9 并写明动作）。
6. PE-08 T08.8 的 Q25 子项改为必做。
7. PE-05 T05.4 补拆分行为等价性审查项；AA-04 400-600 行组件注明轮次安排。

**P2（登记与收口）**
8. 建立「AA-05 范围外 10 项 + AA-06 P9/P10/F5/F6/M1 + AA-01 Q22/Q28/Q39/Q41 + AA-02 S-7/S-11/S-17/S-18 + AA-03 Q14」的**待办登记表**（建议并入 30-verification-checklist），每项注明决议与负责轮次，防止「后续批次」永久悬空。
9. 指定 G3 首 token 总验收 owner（建议 PE-09 T09.8），消除 PE-02/PE-09 互等。
10. 前端测试策略（e2e/visual 回归门禁）单独立项或在 PE-05 增加「迁移期视觉回归门禁」任务；事件 schema 版本化机制（changelog + 旧事件兼容测试）并入 PE-03 T03.9 或 PE-08。

**P3（低危可选）**
11. D-02 payload 上限并入 PE-08 T08.3；S-9 fs 命令分页上限并入 PE-03 T03.3；P-02 drive-relative/UNC 单测并入 PE-07 T07.2；F4 批量渲染并入 PE-02。

---

*本审计基于 2026-08-01 快照的 8 份审查文档与 10 份任务书文本；行号/任务号引用以各文档原文为准。*
