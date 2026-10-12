# 多子窗口（Split-Pane）天然隔离架构重构战役 — 纪律与调度总表

> **战役工作区**：`docs/multi-pane-isolation/`
> **遵循规范**：仓库根 [`AGENTS.md`](../../AGENTS.md)、[`.agents/LOGIC_PLAN_NO_RETREAT.md`](../../.agents/LOGIC_PLAN_NO_RETREAT.md)、[`docs/agent-roles/README.md`](../agent-roles/README.md)

---

## 一、 核心架构铁律（本战役最高准则）

1. **拒绝打补丁与兼容式修补，坚持「构造即隔离（By-Construction Isolation）」**：
   - 严禁仅在报错点散装添加 `if (sessionId !== activeSessionId) return` 或 `sessionIdProp ?? globalActiveSessionId` 式的防御补丁。
   - 必须从底层机制上消灭「单窗口隐式全局上下文（Implicit Global Context）」与「无寻址全局广播（Unscoped Global Broadcast）」，使业务组件天然运行在所属子窗口（LeafScope）的作用域内。
2. **四大根源性收敛支柱**：
   - **支柱一（`LeafScopeContext` 强制上下文与视图工厂全量贯通）**：每个 `TreeLeafPanel` 提供包含 `{ leafId, sessionId, isActive, rootRef, openTool, focusComposer, queryWithinLeaf }` 的上下文；`builtinViewFactories` 全量透传上下文；子窗口内所有卡片、工具栏、菜单、批注与流式 Hook 统一通过 `useLeafScope()` / `useScopedSessionId()` 获取本窗口上下文。
   - **支柱二（捕获阶段焦点自动激活 + 草稿态 SSOT）**：`TreeLeafPanel` 通过 `onPointerDownCapture` 与 `onFocusCapture` 在用户交互进入子窗口的第一时间（含点击编辑器、输入框、内部操作按钮，仅排除销毁类关闭按钮）幂等同步 `activeLeafId` 与 `activeSessionId`；草稿态判定以叶子自身 `leaf.activeTabId === '' || leaf.tabs.length === 0` 为唯一真理（SSOT），解除对全局 `activeSessionId` 的耦合。
   - **支柱三（定址化作用域事件总线 `ScopedUiEvent` & `useLeafUiEvent`）**：在 `uiEvents.ts` 建立作用域定址机制。携带目标 `sessionId` / `leafId` 的事件仅路由至匹配子窗口；全局快捷键触发的无目标事件仅路由至 `isActive === true` 的焦点子窗口。
   - **支柱四（容器级 DOM 查询、拖拽边界收敛、浮层按键守卫与 `useId()` 唯一化）**：废除子窗口内的全局 `document.querySelector`；收敛 `useChatCardDragDrop` 容器至 `.chatBody` 自身并启用 `elementFromPoint` 遮挡检测；收敛 `window.addEventListener('keydown' / 'message')` 的源窗口与焦点包含守卫；将 19 处静态 DOM `id` 全面替换为 React `useId()`。
3. **问题同权与零退避**：
   - 审计发现的所有跨窗口串台、状态覆盖、焦点劫持、重复触发、DOM ID 冲突问题全部同权根治，不砍项、不降级。
4. **多 Agent 协作与 Git 纪律**：
   - 子 Agent 仅负责分配的文件域与文档域，严禁执行 `git commit` / `git reset` / `git checkout` / `git restore`；所有提交由主控 Agent 验收门禁后通过 `git commit --only` 统一收口。

---

## 二、 工作区目录结构（严格遵循 §4 战役工作区结构规范）

```text
docs/multi-pane-isolation/
├── 00-DISCIPLINE.md                                 # [根目录-纪律] 本文件：战役纪律、目录索引与波次调度状态
├── 00-总方案.md                                      # [根目录-总方案] 多子窗口天然隔离架构重构总方案
├── 01-子窗口作用域上下文与焦点激活架构方案.md            # [根目录-分维详案 01] LeafScopeContext、TreeLeafPanel 焦点捕获与草稿态 SSOT
├── 02-定址化UI事件总线与跨组件通信隔离方案.md            # [根目录-分维详案 02] ScopedUiEvent、useLeafUiEvent 与单窗精准路由
├── 03-对话流式引擎与草稿附件项目选择隔离方案.md          # [根目录-分维详案 03] 发送/停止/重试/撤回/草稿项目/思考档位/行内编辑全链路隔离
├── 04-工具抽屉卡片与内置预览浏览器多实例隔离方案.md       # [根目录-分维详案 04] builtinViewFactories、Preview/Files/Overview/Diff/Terminal/Agent 隔离
├── 05-容器级DOM查询与拖拽按键ARIA隔离方案.md            # [根目录-分维详案 05] 废除全局 querySelector、拖拽边界、Escape 守卫与 useId() 改造
├── audits/                                          # [一级子目录] 前期 6 维度全量审计报告沉淀
│   └── 00-全仓多分屏隔离问题全景审计汇总.md
├── plan-reviews/                                    # [一级子目录] 方案审查意见、跨维契约对账与主控决断书
│   └── review-01-architecture-and-deletion-audit.md
└── execution/                                       # [一级子目录] 各实现批次执行报告与门禁验证记录
```

---

## 三、 战役推进波次状态表

| 阶段                              | 任务内容                                                                                                      | 产出物落盘路径                                                  |   状态    |
| :-------------------------------- | :------------------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------- | :-------: |
| **Phase 1: 全景审计沉淀**         | 6 维度并行代码穿透审计（UI 事件总线、DOM 全局事件、Tauri IPC、ChatCard 状态、工具抽屉、粘贴/快捷键/DOM 查询） | `audits/00-全仓多分屏隔离问题全景审计汇总.md`                   | ✅ 已完成 |
| **Phase 2: 总方案与分维详案制定** | 制定根源性隔离总方案 + 5 份分维实现详案 + 架构契约与旧债清退审查                                              | `00-总方案.md`<br>`01~05-*.md`<br>`plan-reviews/review-01-*.md` | 🔄 进行中 |
| **Phase 3: 核心基建与分维实现波** | 按互不冲突的文件域并行落地 5 大维度代码重构与单元测试                                                         | `execution/wave-1-*.md`                                         | ⏳ 待启动 |
| **Phase 4: 集成门禁与立体验证**   | 执行 `typecheck`、`check:line-counts`、全量受影响单测与跨窗口隔离回归测试                                     | `execution/final-verification-report.md`                        | ⏳ 待启动 |
