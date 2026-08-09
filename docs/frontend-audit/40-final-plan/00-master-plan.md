# 前端系统修复 · 总计划方案（Master Plan v0.9）

> 主控产出：`docs/frontend-audit/40-final-plan/00-master-plan.md`
> 输入：8 份审计（10-analysis/01~08）+ 8 份维度方案（20-proposals/01~08）+ 3 份审批意见（30-reviews/01~03）
> 版本：v0.9（待阶段 5 分维度细化 + 阶段 6 双评审后定稿）
> 性质：逻辑执行顺序方案；不含时间/人员/优先级（所有问题同等重要）；每轮 ≤12 Agent，按需部署；闭环迭代，每轮输出即下轮输入。

---

## 0. 审批裁决采纳（阶段 3 → 本计划的前提修正）

三份审批意见（一致性/技术正确性/代码贴合度）的 P0 裁决全部采纳：

| # | 裁决 | 归属 | 处理 |
|---|---|---|---|
| R-01 | 01-S0 与 02-B1 重复修 `--tooltip-translate` | 归 **01**（样式） | 02-B1 删除该项，仅保留 Tooltip 目录退役 |
| R-02 | 02-E3 与 08-步2 重复迁移 window.confirm（8 vs 9 文件面） | 归 **08**（a11y，实测 9 文件） | 02-E3 删除，08 承办（以 9 文件为口径） |
| R-03 | 03-步骤5 与 02-A2 重复实现 check:store-facade 门禁 | 归 **03**（状态，含脚本+CI 双接线） | 02-A2 仅做消费点迁移，门禁脚本归 03 |
| R-04 | 01-S7 与 08-步7④ 重复接线 [data-reduced-motion] | 归 **01**（样式动效） | 08 仅验收断言，不动样式文件 |
| R-05 | 02-D2 与 05-步骤4 重复拆分 useExtensionMarket.tsx | 归 **02**（组件拆分） | 05 删除该项 |
| R-06 | 03-D2 与 05-步骤3 双重处理 bootstrap-services.ts:81 | 归 **03**（状态/连接） | 05 删除该项 |
| R-07 | 02-B2 与 08-步4 的 16 个无名称按钮文件面重叠（5 文件双改） | **02 先改结构、08 后补 aria**（同文件串行，两轮内分开） | 批次安排显式串行 |
| R-08 | 01 对 00 P0-3 的定性修正（`--accent-*-light-adaptive` 为 themeStore 运行时注入、`--tooltip-translate` 由 TSX 内联注入——非"渲染无效"而是"无静态兜底"） | 采纳 | 验收判据从"渲染恢复"改为"补静态兜底 + 双源一致性" |
| R-09 | 数字修正：02-B5 SettingsSelect 消费方 5→11；03 快照测试 21→14 组 | 采纳 | 分维度计划按修正后数字 |
| R-10 | 执行前置：`messageSnapshotsBridge.ts` 脏状态（let→const 残留）需先清理 | 采纳 | 批次 1 前置步骤（若为并行域文件则只清理自己的行，不整体提交） |
| R-11 | 遗漏补充：99999 fallback 第 3 文件 ChatComposer.module.css；chat.css 为第 6 个 GBK 文件 | 采纳 | 并入 01 的 S7/卫生步骤 |

---

## 1. 执行轨道划分（8 维度 → 8 轨道，与维度方案一一对应）

| 轨道 | 来源方案 | 核心目标 | 关键文件面（执行时错开） |
|---|---|---|---|
| T-A 功能修复 | 03-① 快照桥 + 04-① 断链命令 | 快照桥接线；md/highlight/telemetry 断链修复 | messageSnapshotsBridge.ts、rustCore.ts、TelemetryMonitor.ts（**互不重叠**） |
| T-B 样式基线 | 01（S0-S2） | P0 兜底（R-08 口径）、token 真源、混色 31 档收敛 | tokens.css、themeStore.ts、DiffCard/Tooltip module.css |
| T-C 组件体系 | 02（A/B 段 + R-01/05/07 归并） | barrel 补全、ui 原子件接管（Button/Tooltip/Input/Select/Switch/TabStrip）、巨型拆分 | ui/、components/（分批 ≤20 文件） |
| T-D UX/a11y | 08（含 R-02 承办 window.confirm、R-04 验收面） | 对话框统一、快捷键真源、键盘闭环、对比度、图标按钮名称 | 对话框族、ShortcutRegistry、icon button 面 |
| T-E 状态治理 | 03（②-⑤，含 R-03 门禁） | 双源裁决、事件写入收敛、raw setState 清零、store-facade 门禁 | store/、chat-bridge/handlers/ |
| T-F 通信契约 | 04（②-⑦） | 分裂标签 rename、幽灵裁决、错误码双向、漂移锁定 | main.rs（Rust）、commandMap.ts、userFacingErrors.ts |
| T-G 工程化 | 06 | build 进 CI、chunk 拆分、CSP 分层、lint 口径 | .github/workflows、vite.config.ts、tauri.conf.json |
| T-H 性能 | 07 | 流式增量渲染恢复、complete 收口、搜索态、perf 防线 | StreamRenderBuffer.ts、MessageContent.tsx、streamingStore.ts |

**轨道间文件面重叠点（执行时必须串行或明确边界）**：
- T-B ↔ T-C：tokens/样式基线先于组件样式接管（T-B 先行）
- T-C ↔ T-D：无名称按钮（R-07 两轮串行）
- T-C ↔ T-H：memo/props 治理先于渲染优化（T-H 依赖 T-C 的 memo 面）
- T-E ↔ T-C：store 直引迁移（T-C 的组件重构依赖 T-E 的 facade 就绪）
- T-F ↔ T-E：错误码（T-F 的 kebab 码表）与提示分发（既有 ROUND-R1 已改）——T-F 只补码表不碰展示面

---

## 2. 全局执行顺序（逻辑依赖链，非时间表）

```
批次 0（前置清理，1 Agent）：
  0.1 清理 messageSnapshotsBridge.ts 脏状态（R-10）；确认工作区基线干净可提交
  0.2 确认 T-F 涉及 Rust 命令面时与并行域（crates/conex-browser 域）的冲突规避

批次 1（功能修复，T-A，2-3 Agent 并行，文件面互不重叠）：
  1.1 快照桥接线（03-①：注入函数补齐 + bootstrapStores 装配真实 MessageSnapshots + 三道防回归防线）
  1.2 断链命令修复（04-①：rustCore.ts 改真实键 + TelemetryMonitor 接线 + missing 分支可观测日志）
  → 验证：cargo test + vitest 相关 + typecheck；提交

批次 2（样式基线，T-B，2-3 Agent）：
  2.1 P0 兜底（01-S0：悬空引用补静态兜底，R-08 口径）
  2.2 token 真源 + 双层同源治理（01-S1：themeStore 运行时覆盖与静态值一致性）
  2.3 混色 31 档收敛（01-S2：3 档 tint token，423 处基线批量替换，工具策略见 03-评审建议）
  → 验证：style-contract.test.ts 门禁 + 视觉抽查；提交
  （T-B 完成后 T-C/T-D/T-H 才有稳定样式基线）

批次 3（组件体系第一阶段，T-C-A，2-3 Agent，文件面错开）：
  3.1 ui barrel 补全 + 消费点改走 barrel（02-A2 部分）
  3.2 Tooltip 迁移（02-B2 前半：85 文件机械替换 → ui/Tooltip；旧版退役删除）
  3.3 ui/Button 接管第一批（02-B1：36 文件 .ui-btn 迁移 + 首批裸 button）
  → 验证：typecheck + 组件测试 + a11y 抽查；提交

批次 4（UX/a11y 第一阶段，T-D-A，与批次 3 部分并行但文件面错开）：
  4.1 window.confirm 统一（08-步2，9 文件面，R-02）
  4.2 快捷键单一真源（08-步3：双源漂移收敛 + Esc Esc 冲突裁决）
  4.3 无名称图标按钮补齐（08-步4，**在 02-B2 结构迁移后执行**——R-07 串行）
  → 验证：键盘走查测试 + a11y 断言；提交

批次 5（组件体系第二阶段 + 状态治理，T-C-B + T-E，3-4 Agent）：
  5.1 巨型组件拆分（02-D：ModelConfigEditor 等，R-05 归并）
  5.2 开关/TabStrip/Select 接管（02-B3/B4/B5，消费方 11 修正）
  5.3 双源裁决 D1-D10 + 事件写入收敛（03-②③）
  5.4 raw setState 清零 + store-facade 门禁（03-④⑤，R-03）
  → 验证：全量 vitest + typecheck + 门禁脚本；提交

批次 6（UX/a11y 第二阶段 + 通信契约，T-D-B + T-F，3 Agent）：
  6.1 hover-only 键盘闭环 + 对比度修复（08-步5/6）
  6.2 分裂标签 rename（04-②，Rust+前端）
  6.3 幽灵命令裁决 + 错误码双向覆盖（04-③④）
  → 验证：cargo test + a11y 断言；提交

批次 7（工程化 + 治理门禁，T-G + T-E 门禁收尾，2-3 Agent）：
  7.1 生产 build 进 CI + chunk 拆分（06-步骤1/2，N2 先构建 shared-types）
  7.2 CSP 分层（06-步骤3，tauri.conf.json 联动）
  7.3 吞错门禁（05-①③：AST 规则 + 基线 + 分批清零）+ 行数门禁接线（05-②）
  → 验证：CI 三层 + lint + 门禁；提交

批次 8（性能，T-H，2 Agent）：
  8.1 流式增量渲染恢复（07-步骤1：frame.delta 直达 + ref appendText O(增量)）
  8.2 complete 收口 + 搜索态优化（07-步骤2/3）
  8.3 perf 回归防线（07-步骤5：浏览器端性能断言）
  → 验证：性能采样对比 + 流式测试；提交

批次 9（收尾闭环，1-2 Agent）：
  9.1 暗色收编 + 动效 token 化 + 卫生（01-S6/S7，含 R-04/R-11）
  9.2 幽灵命令剩余 + 契约漂移总门禁（04-⑥）
  9.3 全量门禁复跑（cargo + vitest + typecheck + lint + build）
  → 验证：全绿；提交；输出最终修复报告（对照 00-cross-analysis 清单逐项销号）
```

---

## 3. 每轮 Agent 分配原则（防文件竞争）

1. **文件面错开**：派发时每 Agent 分配互不重叠的文件集（本计划批次划分已按此设计）；共享文件（tokens.css、ui/index.ts、messageSnapshotsBridge.ts）单轮内只允许一个 Agent 触碰
2. **串行纪律**：同文件跨轮次操作必须显式串行（如 R-07 无名称按钮：T-C 结构 → T-D aria，两轮分开）
3. **规模控制**：机械替换类（混色/按钮/Tooltip）每轮 ≤20 文件/Agent，保证可评审可回退
4. **工具策略**：大批量替换先用脚本生成 diff（正则/codemod），人工 review diff 后应用，不用脚本直接写盘（03-评审建议）
5. **提交纪律**：每轮完成后主控统一提交（精确 add 本域文件，不卷入并行域改动）；提交信息带批次号
6. **并行域规避**：实施前 `git status` 检查目标文件是否被并行域（conex-browser 域等）修改；有 M 标记先读最新再改

---

## 4. 闭环迭代机制（方案可复用性）

- 每轮输出 = 代码改动 + 测试 + 提交；每轮验证 = 该域门禁 + 全量门禁抽查
- 下一轮输入 = 上一轮提交的基线（依赖已就绪的面）
- 批次间严格依赖链：T-B → T-C/T-D/T-H；T-E → T-C 后半；T-F 独立可并行
- 若某轮发现方案未覆盖问题（新缺陷/依赖错位）：执行 Agent 上报主控，主控裁决（追加到对应轨道或独立小批次），不阻塞主链
- 最终验收 = 批次 9 的全量门禁 + 对照 00-cross-analysis 的 P0×6/P1×14 逐项销号清单

---

## 5. 分维度详细计划（阶段 5 输入）

本总计划的每个轨道需进一步细化（阶段 5 派 Agent 产出）：按批次 → 每步的具体任务清单（文件级）、机械替换的正则/工具草案、测试用例清单、验收断言。详细计划以本总计划为框架，不改变批次边界与串行纪律。

---

（v0.9 完——待阶段 5 分维度细化 + 阶段 6 双评审）
