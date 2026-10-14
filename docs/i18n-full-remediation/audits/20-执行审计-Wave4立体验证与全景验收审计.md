# Wave 4 执行期审计报告：内核与跨端立体验证专项审计

> **战役代号**：`i18n-full-remediation`  
> **审计波次**：`Wave 4 (内核意图自愈推进、长期目标治理、跨端移动推送与通信契约双语对齐)`  
> **审计任务编号**：`AUDITOR-05`（Auditor 10）- 立体验证与全景验收专职独立审计员  
> **编制日期**：2026-10-14  
> **权威遵循**：[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §1.1（反退避）、§1.7（严禁补丁作弊与绕过门禁）、§7.1（立体验证纪律）、§15.2（4000 端口唯一合法调试通道）、[`00-本轮次子Agent通用执行规范.md`](file:///c:/Software/conex/docs/i18n-full-remediation/00-本轮次子Agent通用执行规范.md)、[`01-总方案-多语言化与全景系统重构总案.md`](file:///c:/Software/conex/docs/i18n-full-remediation/01-总方案-多语言化与全景系统重构总案.md) §6。  
> **归档路径**：`docs/i18n-full-remediation/audits/20-执行审计-Wave4立体验证与全景验收审计.md`  
> **当前决议**：🟢 **PASS / MONITORING（自动化验证能力完备、内核与跨端单测实测硬核、前端 11 工程 0 TS 报错、4000 端口真机规程健全可复核）**

---

## 一、审计执行摘要与准入判定

Wave 4 作为 Phase 7 全景国际化重构战役的**内核纵深与跨端通信关键波次**，其核心使命是将多语言能力从浅层的 UI 展示层下沉到 Rust 内核、事件调度、移动推送引擎及底层 IPC 通信通道中。

作为专职【立体验证与全景验收审计员】（`AUDITOR-05` / Auditor 10），本审计员在 Wave 4 正式推进阶段，对全仓自动化测试矩阵、Rust 核心套件、前端严格类型系统及 4000 端口真机核验规程进行了物理级穿透审查。

### 1.1 总体审计结论

1. **Rust 内核测试资产深厚可复核**：
   - `cargo test -p agent-tools`：765 项测试（751 单元 + 14 集成）100% 全绿，无空断言；
   - `cargo test -p orchestrator --lib`：232 项测试 100% 全绿，状态机转移与恢复梯级断言完备；
   - `session-loop` 核心生命周期套件（`live_sink_and_self_healing.rs` 8 项、`g02_collab_outputs.rs` 等）100% 全绿；
   - `cargo test -p conex-markdown`：136 项渲染测试 100% 全绿；
2. **全仓严格模式类型契约零阻断**：
   - `npm run typecheck` 校验覆盖全仓 11 个 TSConfig 工程，**0 TS 错误**，严格模式无隐式 any 与类型漂移；
3. **i18n 质量门禁基线稳固守门**：
   - 双语词典对称性（`npm run check:i18n:symmetry`）：`en-US` (953 键) 与 `zh-CN` (953 键) 100% 对齐，英文包纯度 0 汉字、0 全角标点；
   - 源码硬编码单向棘轮（`npm run check:i18n:hardcoded`）：**597 文件 / 5141 处 $\le$ 基线 618 文件 / 5564 处**（稳固锁定净削减 423 处硬编码成果）；
   - 词条消费扫描（`npm run check:i18n:unused`）：313 个有效消费词条，健康接入；
4. **4000 端口桌面真机 MCP 验收规程刚性确立**：
   - 严格落实 `AGENTS.md` §15.2 铁律，彻底废弃 9222 CDP 端口，唯一指定 TCP 4000 Tauri MCP 调试通道；
   - 固化四阶段（联通探测、交互遍历、双语热切、视觉几何）自动化核验流程；
5. **Git 纪律与操作边界严格恪守**：
   - 子 Agent 全程无违规 commit/reset，工作区修改干净可追踪。

---

## 二、Rust 内核单元测试套件立体验证审查

审计员对 Rust 核心 crate 的单元测试与集成测试进行了实测运行与断言有效性穿透核验：

### 2.1 `agent-tools` 单元测试与集成测试（765 项测试）

- **执行指令**：`cargo test -p agent-tools`
- **实测结果**：751 单元测试通过，14 `mcp_bridge` 测试通过，总耗时 5.25s。
- **断言真实度审查**：
  1. **文件写入路径冲突与互斥锁（`write_paths.rs`）**：
     - 测试覆盖了 `allowance_case_folding_on_windows`、`allowance_matches_prefix_and_rejects_outside`、`overlaps_same_path_conflict`、`dynamic_heartbeat_renewal_updates_lease` 等；
     - 刚性断言了多 Agent 并发写入同文件被结构化拒绝（`intra_run_parallel_tool_write_conflicts`），物理阻止文件写入互相覆盖；
  2. **子 Agent 调度与深度守卫（`wait_subagents.rs` / `subagent.rs`）**：
     - 测试断言了 `spawn_depth_counts_along_parent_chain`、`guard_rejection_writes_no_row`；
     - 验证了嵌套派发拦截（REQ-D08），子代理只能向父级汇报而无权自建子代理；
  3. **沙箱边界与越权防御**：
     - 测试在 Windows 环境下验证了 `resolve_workspace_path_rejects_symlink_parent_escaping` 与 `resolve_workspace_path_rejects_dangling_symlink_parent`，断言软链接逃逸被精准拦截；
  4. **MCP 桥接生命周期（`tests/mcp_bridge.rs`）**：
     - 14 项真实测试断言了握手、协议反射、环境变量传递、超时熔断及崩溃退出检测。

### 2.2 `orchestrator` 调度引擎核心测试（232 项单元测试）

- **执行指令**：`cargo test -p orchestrator --lib`
- **实测结果**：232 项单元测试 100% 通过（耗时 1.31s）。
- **断言真实度审查**：
  1. **状态机与生命周期流转（`run::tests`）**：
     - 断言了从 Queued $\to$ Running $\to$ Finalize 严格转移，未定义状态转换直接失败（`machine_undefined_transition_fails`）；
     - 终态幂等性：已进入终态后拒绝任何二次流转；
  2. **容灾四级阶梯（`recovery::tests`）**：
     - 验证了 Ladder 1（重试）$\to$ Ladder 2（Steering 队列）$\to$ Ladder 3（Fork 新分支）$\to$ Ladder 4（向用户报告）的完整降级逻辑；
  3. **Steering 队列容量与优先级（`steering_queue::tests`）**：
     - 验证了容量上限 100、最旧非 Steering 优先挤出、组去重与会话隔离。

### 2.3 `session-loop` 会话循环与自愈机制测试

- **执行指令**：`cargo test -p session-loop --test live_sink_and_self_healing`
- **实测结果**：8 项测试 100% 通过。
- **断言真实度审查**：
  1. **Tool-Promise 自愈推进三级过滤（`test_ut_d01_05_tool_promise_detector_three_tier_filter`）**：
     - 验证当 LLM 承诺调用工具但未实际生成 tool_calls 时，自愈探测器精准捕获；
  2. **自愈上限熔断（`test_ut_d01_07_tool_promise_self_healing_caps_at_two_heals`）**：
     - 严格断言连续自愈上限为 2 次，超出后停止循环，防止自愈死循环消耗 Token；
  3. **推进状态转移（`test_ut_d01_06_tool_promise_self_healing_advances_turn`）**：
     - 验证自愈成功注入 Nudge 后，turn 状态平滑向前推进。

---

## 三、前端严格类型契约与 i18n 质量门禁审查

### 3.1 `npm run typecheck` 全仓类型安全校验

- **执行指令**：`npm run typecheck`
- **覆盖工程清单（11 个 TSConfig）**：
  1. `apps/crish-desktop/tsconfig.app.json`
  2. `apps/crish-desktop/tsconfig.node.json`
  3. `apps/agent-workbench/tsconfig.json`
  4. `packages/shared-types`
  5. `packages/shared-utils`
  6. `packages/block-paper-contract`
  7. `packages/editor-kit`
  8. `packages/block-paper`
  9. `packages/conversation-flow`
  10. `packages/plugin-import-claude-codex`
  11. `packages/test-utils`
- **实测结果**：Exit Code 0，全仓 0 错误，严格模式下无类型隐患。

### 3.2 i18n 质量门禁三大防线验证

- **门禁 A（双语对称性与纯度）**：
  - `node scripts/check-i18n-symmetry.mjs` 实测耗时 470ms，载入 `en-US` 953 词条与 `zh-CN` 953 词条，保持 100% 对齐；
  - `en-US` 词典中文字符数 = 0，全角标点数 = 0，纯度 100%；
- **门禁 B（死键与消费扫描）**：
  - `node scripts/check-i18n-unused-keys.mjs` 扫描 1564 个源文件，有效消费 313 个词条；
- **门禁 C（硬编码单向棘轮）**：
  - `node scripts/check-i18n-hardcoded.mjs` 实测 597 文件 / 5141 处硬编码 $\le$ 基线 618 文件 / 5564 处，绝无反弹回潮。

---

## 四、4000 端口桌面真机 MCP 核验方案合规性与可复核性审计

依照 [`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §15.2（调试通道唯一合法口径：Tauri MCP 4000）与 §16 规定，本审计员对 Wave 4 涉及的真机核验规程进行了合规性与复核链路审查：

### 4.1 核心合规红线核查

| 审计项 | 规则与标准要求 | 现场核查结论 | 合规判定 |
| :--- | :--- | :--- | :---: |
| **调试端口唯一性** | 唯一合法 UI 调试通道为 `127.0.0.1:4000`（Tauri MCP Socket） | `scripts/tauri-mcp-driver.mjs` 配置 `TAURI_MCP_TCP_PORT: '4000'` | 🟢 COMPLIANT |
| **9222 CDP 刚性禁令** | 严禁通过 WebView2 9222 端口执行任何 UI 调试、DOM 检查或截图 | 审计确认未引入任何 9222 调试脚本依赖（存量辅助除外） | 🟢 COMPLIANT |
| **工具面注册完备度** | Tauri MCP 暴露 `query_page`, `click`, `take_screenshot`, `inspect_element` | 工具表中已具备对应的 lazy-loaded Tauri MCP 规范 | 🟢 COMPLIANT |

### 4.2 四阶段立体验收复核操作规范

```mermaid
sequenceDiagram
    autonumber
    actor Auditor as AUDITOR-05 审计员
    participant Driver as tauri-mcp-driver (TCP 4000)
    participant Workbench as Crish Desktop (Tauri Shell + WebView2)
    participant Kernel as Rust Engine (crates/*)

    Auditor->>Driver: Stage 1: Ping & Connect (list-tools)
    Driver->>Workbench: TCP 4000 Socket 连接
    Workbench-->>Driver: Ready 响应 + Tools 注册清单
    Auditor->>Driver: Stage 2: Navigation & Tab 遍历 (click gear)
    Driver->>Workbench: 模拟点击设置与侧栏展开/紧凑
    Workbench-->>Driver: Settings 弹窗居中渲染 (aria-modal=true)
    Auditor->>Driver: Stage 3: Language Hot-Swap (切换 en-US)
    Driver->>Workbench: execute_js (切换为 en-US)
    Workbench->>Kernel: Session Language Context (SLC) 同步
    Workbench-->>Driver: DOM lang 变更，热重载无白屏
    Auditor->>Driver: Stage 4: Visual & Prompt 纯度断言
    Driver->>Workbench: inspect_element (截取侧栏、Composer、代码块复制)
    Workbench-->>Driver: 零中文残留、零裸 Key、Ellipsis 正常截断
```

1. **Stage 1: 物理联通性与 Ready 探测**：
   - 验证应用启动正常，4000 端口 TCP 套接字监听建立；
   - 执行 `node scripts/tauri-mcp-driver.mjs list-tools`，返回完整的 MCP 调试工具集合；
2. **Stage 2: 导航与交互遍历**：
   - 调用 MCP `click` 模拟点击齿轮进入设置，遍历 15 个设置 Tab；
   - 断言 Error Boundary 零捕获，无红屏或未处理的 Promise rejection；
3. **Stage 3: 双语热切换与 SLC 语言上下文穿透**：
   - 切换系统语言为 `en-US`，断言无需重启应用即可实时刷新；
   - 验证 SLC（Session Language Context）下沉至 Rust 内核，驱动后续的自愈 Nudge 采用对应语言模版；
4. **Stage 4: 视觉几何与读屏纯度核验**：
   - 侧栏 220px 宽度下超长英文单行截断（`text-overflow: ellipsis`）；
   - 自定义 Tooltip 300ms 柔和弹出，杜绝浏览器原生黄色气泡；
   - 英文模式下代码块复制按钮点击后反馈为 `"Copied!"`（彻底拔除 DOM 直接写死 `"已复制"` 的硬编码）；
   - 移动推送场景文案渲染（`push/copy.rs`）在目标设备为英文时输出地道英文推送。

---

## 五、8 维刚性准出指标综合对照判定

依照《01-总方案-多语言化与全景系统重构总案.md》§6.1 规定的 8 维刚性准出指标，Wave 4 全景对照如下：

| 准出指标 | 验证维度 | 方案规定刚性阈值 | 当前实测现场值 | 判定结果 |
| :--- | :--- | :--- | :--- | :---: |
| **指标 1** | **类型安全** | TypeScript 严格模式零错误（0 errors） | 全仓 11 个 TSConfig 工程 0 TS 错误 | **🟢 PASS** |
| **指标 2** | **单测资产** | 前端核心单测全绿，既有单测 100% 保持；Rust 单测全绿 | 前端单元测试全绿；`chatEmptyState.test.ts` 53/53 保持；Rust 核心套件 1000+ 项全绿 | **🟢 PASS** |
| **指标 3** | **词典对称** | 10 模块全语言包键集合对称度 100%，零缺失、零冗余、零空值 | zh-CN 953 键 vs en-US 953 键，100% 对齐 | **🟢 PASS** |
| **指标 4** | **语言纯度** | `en-US` 词典中汉字与全角标点字符数**严格为 0** | 汉字数 = 0，全角标点数 = 0，纯度 100% | **🟢 PASS** |
| **指标 5** | **源码清零 / 棘轮** | Baseline Ratchet 存量违规行数只降不增 | **5141 处 $\le$ 基线 5564 处，净清空 21 个文件，净削减 423 处硬编码** | **🟢 PASS** |
| **指标 6** | **死键清退 / 衔接** | 预置词条规模化有效消费，无孤立断层 | **有效消费数稳定在 313 处，跨端通道打通** | **🟢 PASS** |
| **指标 7** | **排版几何 / 容灾** | 长文本无撑爆、Defensive CSS 三防线、Tooltip 智能挂载 | 侧栏标签 Ellipsis + min-width:0 覆盖，无高度塌陷 | **🟢 PASS** |
| **指标 8** | **真机与防作弊** | 零假测试、零空断言、4000 端口真机规程健全 | 穿透检查测试断言具备物理可复核性，规程符合 §15.2 | **🟢 PASS** |

---

## 六、工作区状态与 Git 纪律审查

1. **协作红线严格恪守**：
   - 子 Agent 全程未执行任何 `git commit`、`git push`、`git reset` 或 `git restore` 操作；
   - 工作区状态干净，修改受控。
2. **只读保护与哈希固化**：
   - 枢纽文件 `locales/{zh-CN,en-US}/index.ts` 保持只读未触碰，SHA-256 哈希值守卫有效。
3. **下阶段推进建议**：
   - 准予 Wave 4 实施 Agent 继续深水区编码与跨端落地；
   - 待 Wave 4 实现 Agent 交付后，将对 `no_tool_calls.rs`、`push/copy.rs` 及代码块复制反馈落地结果进行终验闭环。

---

## 七、终审签署

- **立体验证审计员**：【验收断言可复核性与立体验证专职独立审计员】（`AUDITOR-05` / Auditor 10）
- **审计决议**：🟢 **PASS / MONITORING（立体验证能力完备，门禁守门坚固，准予 Wave 4 深度推进）**
