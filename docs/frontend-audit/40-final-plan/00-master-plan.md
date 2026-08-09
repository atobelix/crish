# 前端系统修复 · 总计划方案（Master Plan v1.0）

> 主控产出：`docs/frontend-audit/40-final-plan/00-master-plan.md`
> 输入：8 份审计（10-analysis/01~08）+ 8 份维度方案（20-proposals/01~08）+ 3 份审批意见（30-reviews/01~03）+ 阶段 6 双评审（30-reviews/01-batch-structure-review、30-reviews/02-detail-technical-review）
> 版本：v1.0（阶段 6 双评审 P0/P1 意见与主控裁决 C-1~C-10 全量吸收，可派发定稿）
> 性质：逻辑执行顺序方案；不含时间/人员/优先级（所有问题同等重要）；每轮 ≤12 Agent，按需部署；闭环迭代，每轮输出即下轮输入。

---

## 修订日志（v0.9 → v1.0，2026-08-09）

本版吸收阶段 6 双评审（批次结构评审 6 条 P0 + 5 条 P1、技术复核评审 1 条 P0 引用）与主控裁决 C-1~C-10，批次框架（0-9、8 轨道、R-01~R-11、串行纪律、闭环机制）原样保留，仅补齐缺口与落定悬置项：

| 变更点 | 来源 | 落点 |
|---|---|---|
| 01-S3-任务1（primary 定案 + --accent-inverted token）补批次 | B-P0-1 / C-9 | 批次 2 增补 2.4 |
| 02-A2 store 直引迁移（78 文件）补承办与批次 | B-P0-2 / C-8 | 02/T-C 承办（03-detail T14），排批次 7.4；03/T-E 只承办门禁脚本（R-03 不变） |
| ui/ConfirmDialog 基座补承办 | B-P0-3 / C-7 | 02-E3 由"删除"改语义为"创建基座"（03-detail T15），排批次 4.0 |
| 01-S4/S5（Tab/表面族收敛）补批次 | B-P0-4 / C-9 | 并入批次 6.4，与 T-D 并行 |
| 02-C1（props 聚合）补批次 | B-P0-5 / C-5 | 排批次 8.0（T-H 的 memo 面前置） |
| 裸 button 剩余批补承接 | B-P0-6 / C-4 | 批次 3 增补 3.4（03-detail T7-T8 后续波次） |
| tint 基底 / --tint-strong 档 / 28% 档定案 | U-1/U-2/U-3 / C-1/C-2/C-3 | 批次 2.2/2.3：text-primary 基底、12%、新增专用 --tint-highlight |
| highlight 命令去留 | U-7 / C-6 | 接线保留（markdown 加速），执行时先查消费面（无消费则退役 wrapper） |
| 05-D2 消费方清单补齐 | 30-reviews/02 P0-1 / C-10 | 批次 5.3 引用（LiveTasksSection/BgTasksSection/PlansSection） |
| 批次 3 并行表述与 03-detail 接力串行统一 | B-P1-1 | 批次 3 改注"接力式串行（T1→T8→波 2）" |
| 批次 4 并行窗口精确化 | B-P1-2 | 批次 4 注"仅与批次 3 已提交面并行" |
| T6 族批次落点 | B-P1-3 | T6-2 提前批次 6.5；T6-1/T6-3/T6-4 挂批次 9.2 |
| T5-2 消费面批次 | B-P1-4 / U-8 | 显式挂批次 9.1 串行段（01-S6 之后紧邻） |
| 预期红态跨批悬挂管理 | B-P1-5 | §4 新增预期红态登记表 |
| 批次级回退约定缺失 | 评审 ⑤ 弱项 1 | §4 补统一表述 |
| 步骤编号笔误（3.2/3.3 的 02-B1/B2） | B-P2-1 | 批次 3 修正 |
| 混色口径 423→426、08-detail 任务数 27/28 | B-P2-2 / B-P2-4 | 批次 2.3 注明 426 处；引用 27 口径 |
| R-07 双补/漏补分工 | B-P2-3 | §3 明示分工 |
| P2 遗留项无批次 | B-P2-5 | §4 声明登记入最终修复报告 |
| 批次 5 同文件串行注记 | B-P2-6 | 批次 5 注明（T11 基座先行） |
| SR 验证降级路径定案 | U-5 | §3 采纳（Playwright aria 快照 + axe + 键盘走查） |
| 幽灵键裁决定案 | U-6 | 批次 4.2 内容补全（Esc Esc → Ctrl+Shift+F 等） |
| 错误码文案归属 | U-9 | 批次 6.3 注明（码表本轨补、文案留 error-notification-governance T-2） |

---

## 0. 审批裁决采纳（阶段 3 → 本计划的前提修正）

三份审批意见（一致性/技术正确性/代码贴合度）的 P0 裁决全部采纳（R-02/R-03 行已按阶段 6 主控裁决修订语义）：

| # | 裁决 | 归属 | 处理 |
|---|---|---|---|
| R-01 | 01-S0 与 02-B1 重复修 `--tooltip-translate` | 归 **01**（样式） | 02-B1 删除该项，仅保留 Tooltip 目录退役 |
| R-02 | 02-E3 与 08-步2 重复迁移 window.confirm（8 vs 9 文件面） | **修订（C-7）**：迁移执行面归 **08**（a11y，9 文件/10 调用实测口径）；**02-E3 不再删除，改语义为"创建 ui/ConfirmDialog 基座"**（02 承办组件设计，03-detail T15 实现，排批次 4.0；契约见 04-detail §2.1.1） | 08 仅做 9 文件替换消费，基座由 02 提供，不自造 |
| R-03 | 03-步骤5 与 02-A2 重复实现 check:store-facade 门禁 | 归 **03**（状态，含脚本+CI 双接线） | **承办边界明确（C-8）**：02-A2 的 78 文件消费点迁移由 **02/T-C** 承办（03-detail T14，排批次 7.4）；门禁脚本+基线+CI 接线归 **03/T-E**（批次 5 落地脚本与基线、批次 7.4 迁移归零后同批接线） |
| R-04 | 01-S7 与 08-步7④ 重复接线 [data-reduced-motion] | 归 **01**（样式动效） | 08 仅验收断言，不动样式文件 |
| R-05 | 02-D2 与 05-步骤4 重复拆分 useExtensionMarket.tsx | 归 **02**（组件拆分） | 05 删除该项 |
| R-06 | 03-D2 与 05-步骤3 双重处理 bootstrap-services.ts:81 | 归 **03**（状态/连接） | 05 删除该项；:116 由 03 先改显式登记、05 收口时 grep 实测剔除 |
| R-07 | 02-B2 与 08-步4 的 16 个无名称按钮文件面重叠（5 文件双改） | **02 先改结构、08 后补 aria**（同文件串行，两轮内分开） | 批次安排显式串行；分工见 §3（02 补其替换面、08 重扫补剩余 + 建门禁） |
| R-08 | 01 对 00 P0-3 的定性修正（`--accent-*-light-adaptive` 为 themeStore 运行时注入、`--tooltip-translate` 由 TSX 内联注入——非"渲染无效"而是"无静态兜底"） | 采纳 | 验收判据从"渲染恢复"改为"补静态兜底 + 双源一致性" |
| R-09 | 数字修正：02-B5 SettingsSelect 消费方 5→11；03 快照测试 21→14 组 | 采纳 | 分维度计划按修正后数字 |
| R-10 | 执行前置：`messageSnapshotsBridge.ts` 脏状态（let→const 残留）需先清理 | 采纳 | 批次 1 前置步骤（若为并行域文件则只清理自己的行，不整体提交） |
| R-11 | 遗漏补充：99999 fallback 第 3 文件 ChatComposer.module.css（实读修正为 autofill hack，非 z fallback）；chat.css 为第 6 个 GBK 文件 | 采纳 | 并入 01 的 S7/卫生步骤；99999 行保留 + 注释 + style-contract 白名单 |

---

## 1. 执行轨道划分（8 维度 → 8 轨道，与维度方案一一对应）

| 轨道 | 来源方案 | 核心目标 | 关键文件面（执行时错开） |
|---|---|---|---|
| T-A 功能修复 | 03-① 快照桥 + 04-① 断链命令 | 快照桥接线；md/highlight/telemetry 断链修复 | messageSnapshotsBridge.ts、rustCore.ts、TelemetryMonitor.ts（**互不重叠**） |
| T-B 样式基线 | 01（S0-S5） | P0 兜底（R-08 口径）、token 真源、混色档位收敛（426 处）、primary 语义定案（S3-任务1）、表面族收敛（S4/S5，批次 6 增补段） | tokens.css、themeStore.ts、DiffCard/Tooltip module.css、shell-*.css |
| T-C 组件体系 | 02（A/B/D 段 + R-01/05/07 归并 + 阶段 6 增补） | barrel 补全、ui 原子件接管（Button/Tooltip/Input/Select/Switch/TabStrip）、ConfirmDialog 基座（02-E3 改语义，T15）、store 直引迁移（02-A2，T14）、巨型拆分 | ui/、components/（分批 ≤20 文件） |
| T-D UX/a11y | 08（含 R-02 承办 window.confirm 替换消费、R-04 验收面） | 对话框统一消费、快捷键真源、键盘闭环、对比度、图标按钮名称 | 对话框族、ShortcutRegistry、icon button 面 |
| T-E 状态治理 | 03（②-⑤，含 R-03 门禁） | 双源裁决、事件写入收敛、raw setState 清零、store-facade 门禁（脚本+基线归本轨） | store/、chat-bridge/handlers/ |
| T-F 通信契约 | 04（②-⑦） | 分裂标签 rename、幽灵裁决、错误码双向、漂移锁定 | main.rs（Rust）、commandMap.ts、userFacingErrors.ts |
| T-G 工程化 | 06 | build 进 CI、chunk 拆分、CSP 分层、lint 口径 | .github/workflows、vite.config.ts、tauri.conf.json |
| T-H 性能 | 07 | 流式增量渲染恢复、complete 收口、搜索态、perf 防线 | StreamRenderBuffer.ts、MessageContent.tsx、streamingStore.ts |

**轨道间文件面重叠点（执行时必须串行或明确边界）**：
- T-B ↔ T-C：tokens/样式基线先于组件样式接管（T-B 先行）；01-S3 只做样式（token/定案），按钮结构归 T-C（C-9 分工）
- T-C ↔ T-D：无名称按钮（R-07 两轮串行）；ConfirmDialog 基座（T-C 建，T-D 消费，批次 4.0/4.1 串行）
- T-C ↔ T-H：**02-C1 props 聚合排批次 8.0 前置（C-5）**，T-H 在其上做渲染优化（同文件串行：MessageContent.tsx / ChatMessageList.tsx 由 8.0 先行）
- T-E ↔ T-C：**02-A2 78 文件迁移由 T-C 承办（T14）、门禁脚本由 T-E 承办（R-03 不变，C-8）**；迁移依赖 T-E 批次 5 的 check-store-facade 基线就绪，CI 接线等迁移归零
- T-F ↔ T-E：错误码（T-F 的 kebab 码表）与提示分发（既有 ROUND-R1 已改）——T-F 只补码表不碰展示面（U-9）

---

## 2. 全局执行顺序（逻辑依赖链，非时间表）

```
批次 0（前置清理，1 Agent）：
  0.1 清理 messageSnapshotsBridge.ts 脏状态（R-10）；确认工作区基线干净可提交
  0.2 确认 T-F 涉及 Rust 命令面时与并行域（crates/conex-browser 域）的冲突规避

批次 1（功能修复，T-A，2-3 Agent 并行，文件面互不重叠）：
  1.1 快照桥接线（03-①：注入函数补齐 + bootstrapStores 装配真实 MessageSnapshots + 三道防回归防线）
  1.2 断链命令修复（04-①：rustCore.ts 改真实键 + TelemetryMonitor 接线 + missing 分支可观测日志；highlight 断链解除后去留按 C-6 于批次 6.3 执行时裁决）
  → 验证：cargo test + vitest 相关 + typecheck；提交

批次 2（样式基线，T-B，2-3 Agent）：
  2.1 P0 兜底（01-S0：悬空引用补静态兜底，R-08 口径；含 ChatComposer 99999 autofill hack 注释化，R-11）
  2.2 token 真源 + 双层同源治理（01-S1：tint 档位 token 族定义——**基底定案 text-primary（C-1）**、**--tint-strong 取 12%（C-2）**、**新增专用档 --tint-highlight: 28%（C-3，5 处 settings 高亮专用，不并入三档）**；themeStore 注入对齐 + 静态等价默认补齐 + style-contract 断言扩展）
  2.3 混色收敛（01-S2：**426 处基线（B-P2-2）**，tint 三档 + 专用档批量替换，脚本策略见 03-评审建议；28% 档 5 处归 --tint-highlight（settings-models.css:1225 的 white 基底处单独人工处理，不入脚本））
  2.4 01-S3-任务1（**B-P0-1 / C-9 增补**：primary 语义定案（深炭/蓝/反相/红四套收敛为 1 套）+ --accent-inverted token；**仅定案与 token，不做 .ui-btn 退役删段**——删段随 T7 迁移后由 01 收尾）
  → 验证：style-contract.test.ts 门禁 + 视觉抽查；提交
  （T-B 完成后 T-C/T-D/T-H 才有稳定样式基线；**T7 派单前主控确认 2.4 已合入**——03-detail 依赖前置第 3 条）

批次 3（组件体系第一阶段，T-C-A，2-3 Agent，**接力式串行**）：
  ★ 执行链：T1 → T2~T6 → T7 → T8 → T8 后续波次（B-P1-1：Agent 轮换、每步 1 人；并行仅允许 3.1 与 3.2 首个可并行窗口）
  3.1 ui barrel 补全 + 消费点改走 barrel（02-A1：03-detail T1）
  3.2 Tooltip 迁移（**02-B1（编号修正，B-P2-1）**：03-detail T2~T6 五批 + 旧件退役，87 文件口径）
  3.3 ui/Button 接管波 1（**02-B2（编号修正）**：03-detail T7，36 文件 .ui-btn 迁移）
  3.4 ui/Button 接管波 2 后续波次（**B-P0-6 / C-4 增补，明确承接不再悬空**：03-detail T8 后续波次——128 文件裸 button 的剩余约 100 文件，按域 4~5 批、每批 ≤20 文件、1-2 Agent；T8 语义判定规则表与视觉抽样纪律沿用；目标态"业务层裸 button = 0"）
  → 验证：typecheck + 组件测试 + a11y 抽查；提交
  （R-07 分工：02 侧替换时顺带补其替换面的 aria-label，08 侧 grep 重扫补剩余 + 建门禁——B-P2-3）

批次 4（UX/a11y 第一阶段，T-D-A，与批次 3 部分并行但文件面错开）：
  4.0 ui/ConfirmDialog 基座创建（**B-P0-3 / C-7 增补**：02-E3 改语义为"创建基座"，03-detail T15；契约见 04-detail §2.1.1——alertdialog/labelledby/describedby/初始焦点取消钮/FocusTrap/Esc 归还/danger 不默认聚焦；先行于 4.1，与 4.2/4.3 文件面错开）
  4.1 window.confirm 统一（08-步2：9 文件面/10 调用替换消费，**R-02 修订语义：08 只做替换消费、基座由 4.0 提供，不自造**；T1-5 BgTaskActions 内联确认收敛 + T1-6 清零门禁）
  4.2 快捷键单一真源（08-步3：双源漂移收敛；**U-6 定案**：Esc Esc → Ctrl+Shift+F（方案 A，T2-2 冲突检测生产接线为第一子步）、toggle_runtime 从注册表移除（无执行面键更误导）、close_tab 删除设置页幽灵行、open_extensions/open_schedule 补注册、label 文案统一）
  4.3 无名称图标按钮补齐（08-步4，**在 02-B2 结构迁移后执行**——R-07 串行；T3-5 扫描门禁黄绿开发）
  → 验证：键盘走查测试 + a11y 断言（**SR 环境缺失时降级：Playwright aria 快照断言 + axe 扫描 + 人工键盘走查，SR 播报留待有环境补录——U-5**）；提交
  ★ 并行窗口（B-P1-2）：批次 4 派单时点滞后于批次 3 相关子步（仅与批次 3 已提交面并行）——4.1 的 9 文件面中 5 个（ComposerField / TiptapComposerField / DiffCard / ProjectPickerMenu / SettingsUsageTab）落在批次 3 Tooltip/.ui-btn 迁移面内

批次 5（组件体系第二阶段 + 状态治理，T-C-B + T-E，3-4 Agent）：
  5.1 巨型组件拆分（02-D：03-detail T9/T10，R-05 归并）
  5.2 开关/TabStrip/Select 接管（03-detail T11/T12/T13，SettingsSelect 消费方 11 修正）
  5.3 双源裁决 D1-D10 + 事件写入收敛（03-②③；**C-10 引用**：05-detail 已修订补齐 D2 消费方 3 文件——LiveTasksSection/BgTasksSection/PlansSection，engineOnline 经 RuntimePanel props 下传）
  5.4 raw setState 清零 + store-facade 门禁（03-④⑤，R-03：**脚本 + 基线（78 文件）入库，红基线可复现**；CI 接线等 02-A2 迁移归零——C-8）
  → 验证：全量 vitest + typecheck + 门禁脚本；提交
  （5.1 与 5.2 在 ModelConfigEditor 上同文件串行：T11 Switch 基座先行——B-P2-6）

批次 6（UX/a11y 第二阶段 + 通信契约 + 表面族收敛，T-D-B + T-F + T-B 收尾段，3-4 Agent）：
  6.1 hover-only 键盘闭环 + 对比度断言（08-步5：T4 族 + T5-1 断言先行入库——**红态 = 正确初始态，登记 §4 预期红态表**）
  6.2 分裂标签 rename（04-②，Rust+前端，双端同轮）
  6.3 幽灵命令裁决 + 错误码双向覆盖（04-③④：U-6 已定案（见批次 4.2）；**highlight 按 C-6**——接线保留（随 T-A 断链修复已生效、markdown 加速），执行时先 grep 消费面：无生产消费则退役 rustCore.highlightCode wrapper（命令注册保留，changelog 登记），有消费则接线；**U-9 边界**：本轨只补码表映射，专属文案留 error-notification-governance 轮次 T-2）
  6.4 01-S4/S5 表面族收敛（**B-P0-4 / C-9 增补**：--tab-* 档位 + inset 皮肤去 !important（依赖批次 2.1-6 清死规则）+ 菜单壳/滚动条/卡片/分隔线/徽标族收敛 + 死规则卫生（含 .session-actions-btn 归口清理）；消费面依赖批次 5.2 T12 接管后，与 6.1-6.3 文件面错开并行）
  6.5 T6-2 加载态文案统一（**B-P1-3 提前项**：无依赖，可早于 T6 族其余项）
  → 验证：cargo test + a11y 断言；提交

批次 7（工程化 + 治理门禁 + store 迁移，T-G + T-E 门禁收尾 + T-C 迁移面，3-4 Agent）：
  7.1 生产 build 进 CI + chunk 拆分（06-步骤1/2，N2 先构建 shared-types）
  7.2 CSP 分层（06-步骤3，tauri.conf.json 联动）
  7.3 吞错门禁（05-①③：AST 规则 + 基线 + 分批清零）+ 行数门禁接线（05-②）
  7.4 02-A2 store 直引迁移 + 门禁接线收尾（**B-P0-2 / C-8 增补**：78 文件迁移由 02/T-C 承办（03-detail T14：按域分批 ≤20 文件/批，纯读面 selector 先行、结构面等本域重构）；03/T-E 承办门禁（check-store-facade 基线已于批次 5 入库）；**迁移违规归零后同批完成 CI 接线**（05-detail 提交 G 阶段 3）；文件面 components/** 与 7.1-7.3 错开可并行）
  → 验证：CI 三层 + lint + 门禁；提交

批次 8（性能 + props 治理前置，T-H + T-C memo 面，2-3 Agent）：
  8.0 02-C1 props 聚合（**B-P0-5 / C-5 增补前置**：ChatMessageList 30 props 聚合，T-H 的 memo 面依赖；与 T-H 同文件串行——02-C1 先行聚合 props、T-H 后优化渲染；**08-detail 的"02-C1 排后"表述以 C-5 为准**）
  8.1 流式增量渲染恢复（07-步骤1：frame.delta 直达 + ref appendText O(增量)）
  8.2 complete 收口 + 搜索态优化（07-步骤2/3）
  8.3 perf 回归防线（07-步骤5：浏览器端性能断言）
  → 验证：性能采样对比 + 流式测试；提交

批次 9（收尾闭环，1-2 Agent）：
  9.1 暗色收编 + 动效 token 化 + 卫生（01-S6/S7，含 R-04/R-11）+ **T5-2 消费面改引用（B-P1-4 / U-8：01-S6 之后紧邻串行段，T5-1 断言随之转绿）**
  9.2 幽灵命令剩余 + 契约漂移总门禁校准（04-⑥；06-detail §5.2 校准复核）+ **T6 族收尾（B-P1-3：T6-1 动态播报（依赖批次 8 之后，ChatMessageList 同文件串行）/ T6-3 键盘矩阵全量 / T6-4 reduced-motion 验收（依赖 9.1 之后））**
  9.3 全量门禁复跑（cargo + vitest + typecheck + lint + build；**排除 §4 预期红态登记表中已转绿项并核验转绿窗口——B-P1-5**）
  → 验证：全绿；提交；输出最终修复报告（对照 00-cross-analysis 清单逐项销号 + **P2 遗留项（02-E1/E2 等）登记——B-P2-5**）
```

---

## 3. 每轮 Agent 分配原则（防文件竞争）

1. **文件面错开**：派发时每 Agent 分配互不重叠的文件集（本计划批次划分已按此设计）；共享文件（tokens.css、ui/index.ts、messageSnapshotsBridge.ts）单轮内只允许一个 Agent 触碰
2. **串行纪律**：同文件跨轮次操作必须显式串行（如 R-07 无名称按钮：T-C 结构 → T-D aria，两轮分开；批次 3.4 的 T8 后续波次各批内按域串行；批次 8.0 02-C1 与 8.1+ T-H 同文件串行）
3. **规模控制**：机械替换类（混色/按钮/Tooltip/store 直引）每轮 ≤20 文件/Agent，保证可评审可回退
4. **工具策略**：大批量替换先用脚本生成 diff（正则/codemod），人工 review diff 后应用，不用脚本直接写盘（03-评审建议）
5. **提交纪律**：每轮完成后主控统一提交（精确 add 本域文件，不卷入并行域改动）；提交信息带批次号
6. **并行域规避**：实施前 `git status` 检查目标文件是否被并行域（conex-browser 域等）修改；有 M 标记先读最新再改
7. **R-07 分工**（B-P2-3）：02 侧替换时顺带补齐其替换面的 aria-label；08 侧以 grep 重扫补剩余 + 建 `check:icon-button-names` 门禁——两边不重复、不遗漏
8. **SR 降级路径**（U-5）：无 NVDA 环境时，3 个代表开关（T11）与 3 个按钮（T3-6）的 SR 播报验证降级为 Playwright aria 快照断言（role/name/expanded）+ axe 扫描 + 人工键盘走查；SR 播报留待有环境补录

---

## 4. 闭环迭代机制（方案可复用性）

- 每轮输出 = 代码改动 + 测试 + 提交；每轮验证 = 该域门禁 + 全量门禁抽查
- 下一轮输入 = 上一轮提交的基线（依赖已就绪的面）
- 批次间严格依赖链：T-B → T-C/T-D/T-H；T-E → T-C 后半；T-F 独立可并行
- 若某轮发现方案未覆盖问题（新缺陷/依赖错位）：执行 Agent 上报主控，主控裁决（追加到对应轨道或独立小批次），不阻塞主链
- **批次级回退约定（评审 ⑤ 弱项 1 补强）**：批次门禁失败 → 回退该批提交 → 主控决定重试 / 降级（缩小范围重派）/ 跳过并登记——不携带黄灯进入下一批（detail 层已有单批回退，本约定为批次层统一表述）
- **预期红态登记表（B-P1-5 补强）**：跨批红态显式登记，批次 9.3 全量门禁复跑时排除登记中预期红态并核验其转绿窗口，防收尾误判全绿口径：

| 登记项 | 载体 | 先红时点 | 转绿窗口 |
|---|---|---|---|
| a11y-contrast 断言（T5-1） | 04-detail T5-1 / a11y-contrast.test.ts | 批次 6.1 入库（红 = 正确初始态） | 批次 9.1（01-S6 调值后） |
| T5-2 消费面改引用 | 04-detail T5-2 | 批次 6 起未执行（等新 token） | 批次 9.1 串行段执行后转绿 |
| check:store-facade 红基线 | 05-detail ④ / check-store-facade.mjs | 批次 5.4 基线入库（78 文件） | 批次 7.4 迁移归零 → CI 接线 |

- **P2 遗留声明（B-P2-5）**：00 承诺 P0 全做、P1 按序推进；未排批次的 P2 项（02-E1 虚拟列表、02-E2 通知横幅等）显式登记入最终修复报告（批次 9.3 产物），不在本计划承诺范围
- 最终验收 = 批次 9.3 的全量门禁（含预期红态核验）+ 对照 00-cross-analysis 的 P0×6/P1×14 逐项销号清单（见 §5）

---

## 5. 覆盖销号表（00-cross-analysis P0×6 / P1×14 → 批次步骤，v1.0 全销）

### P0（6/6 全覆盖 ✓）

| # | 项 | 批次步骤 | 载体 | 销号 |
|---|---|---|---|---|
| P0-1 | 快照桥 _ops 恒 null | 批次 0.1（脏状态清理，R-10）+ 批次 1.1 | 01-detail 任务 A（A1-A6，三道防线） | ✓ |
| P0-2 | 3 条断链命令 | 批次 1.2 | 01-detail 任务 B（B1-B7，四层证明链） | ✓ |
| P0-3 | 悬空 token 引用 | 批次 2.1 | 02-detail 2.1-1/2.1-3/2.1-4/2.1-5（R-08 口径） | ✓ |
| P0-4 | .card-tab.active 死规则 | 批次 2.1 | 02-detail 2.1-6（S4 inset 治理前置） | ✓ |
| P0-5 | 旧 Tooltip 双轨 | 批次 3.2（T2~T6 五批 + 退役）+ 批次 4.3 验收面 | 03-detail T2~T6；04-detail T3-6 | ✓ |
| P0-6 | 流式渲染管线退化 | 批次 8.0/8.1/8.2/8.3 | 02-C1（8.0 前置）+ 08-detail commit-1/2/3（27 任务口径，B-P2-4） | ✓ |

### P1（14/14 全覆盖 ✓）

| # | 项 | 批次步骤 | 载体 | 销号 |
|---|---|---|---|---|
| P1-1 | 按钮三轨收敛 | 批次 3.3（T7，.ui-btn 36 文件）+ 批次 3.4（T8 后续波次，剩余 ~100 文件，C-4） | 03-detail T7/T8；01-S3 退役删段（批次 2.4 后收尾） | ✓ |
| P1-2 | 混色 31 档收敛 | 批次 2.3 | 02-detail ③（426 处基线，C-1/C-2/C-3 定案） | ✓ |
| P1-3 | Tab 条收敛 | 批次 5.2 | 03-detail T12 | ✓ |
| P1-4 | 开关收敛 | 批次 5.2 | 03-detail T11 | ✓ |
| P1-5 | primary 语义统一 | 批次 2.4 | 01-S3-任务1（C-9） | ✓ |
| P1-6 | ui barrel 补全 | 批次 3.1 | 03-detail T1 | ✓ |
| P1-7 | 空 catch 治理 | 批次 7.3 | 05-①③（AST 规则 + 基线 + 分批清零） | ✓ |
| P1-8 | 行数门禁接线 | 批次 7.3 | 05-② | ✓ |
| P1-9 | 生产 build 进 CI | 批次 7.1 | 07-detail T1 + T6（preview 冒烟） | ✓ |
| P1-10 | 状态色三套统一 | 批次 9.1（01-S6）+ 批次 6.1 断言（08 步6） | 04-detail T5；02-detail ⑤-8 | ✓ |
| P1-11 | 菜单/滚动条/卡片族收敛 | 批次 6.4 | 01-S4/S5（C-9，含 inset 皮肤治理与死规则卫生） | ✓ |
| P1-12 | props drilling 治理 | 批次 8.0 | 02-C1（C-5，T-H memo 面前置） | ✓ |
| P1-13 | 巨型组件拆分 | 批次 5.1 | 03-detail T9/T10（7 件 + 3 hook） | ✓ |
| P1-14 | 幽灵命令清理 | 批次 6.3（裁决）+ 批次 9.2（剩余 + 契约门禁校准） | 06-detail T2 族 + T5 | ✓ |

**销号汇总：P0 6/6 全 ✓；P1 14/14 全 ✓（v0.9 的 3 项缺口 P1-5/P1-11/P1-12 与 1 项部分销号 P1-1 已由批次 2.4/6.4/8.0/3.4 补齐）。**

---

## 6. 分维度详细计划（阶段 5 产出，派发时引用）

本总计划的每个轨道由 8 份 detail（10-details/01~08）承载文件级任务清单。v1.0 批次步骤引用的任务编号与 detail 当前编号一致；并行修订中的 detail 以修订后版本为准：

| detail | 轨道 | 状态（v1.0 视角） | 与本计划的对应关系 |
|---|---|---|---|
| 01-functional-repair | T-A | 可直接派发 | 批次 0/1；14 组快照测试口径（R-09）；B6 mock 键 11 处口径（30-reviews/02 P1-1） |
| 02-style-baseline | T-B | 附裁决后派发 | 批次 2.1~2.4；tint 基底/档位/28% 档以 C-1/C-2/C-3 定案为准（--tint-highlight 命名）；S4/S5 段按批次 6.4 执行 |
| 03-component-system | T-C | 需修订后派发（并行修订中） | 批次 3/5；增补 T14（02-A2 store 直引迁移，批次 7.4）、T15（ConfirmDialog 基座，批次 4.0）、T8 后续波次（批次 3.4） |
| 04-a11y-ux | T-D | 附裁决后派发 | 批次 4/6/9；ConfirmDialog 基座按 C-7 依赖 T15；T6 族按 B-P1-3 拆分落点 |
| 05-state-governance | T-E | 需修订后派发（并行修订中） | 批次 5.3/5.4；D2 消费方补齐 3 文件（C-10）；门禁脚本/基线/接线分工按 C-8 |
| 06-communication-contract | T-F | 附裁决后派发 | 批次 6.2/6.3/9.2；highlight 双路径按 C-6 定案（接线保留 + wrapper 消费面检查） |
| 07-engineering | T-G | 可直接派发 | 批次 7.1~7.3；26 任务口径 |
| 08-performance | T-H | 附确认后派发 | 批次 8.1~8.3；27 任务口径（B-P2-4）；"02-C1 排后"表述以 C-5 为准（批次 8.0 前置） |

详细计划以本总计划为框架，不改变批次边界与串行纪律；批次 4.0/3.4/6.4/7.4/8.0 等增补子步对应的 detail 修订（03/05 由并行 Agent 承办）完成后即具备派发条件。

---

（v1.0 完——阶段 6 双评审 6 条 P0 批次缺口 + 5 条 P1 建议 + 9 项未裁决点全部定案，主控裁决 C-1~C-10 全量吸收，P0×6/P1×14 覆盖销号全绿，可派发执行）
