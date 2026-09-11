# 目录树同步展开、单轨收敛、消息附件卡片统一与面包屑重塑战役

> **战役工作区**：`docs/file-tree-and-attachments-architecture/`
> **建立时间**：2026-09-08
> **纪律规范**：严格遵循仓库根目录 `AGENTS.md`（§1 反退避、§2 子 Agent 调度、§3 Git 提交纪律、§4 战役工作区规范、§7 严禁补丁与作弊、§7.1 立体验证纪律）以及 `ANTI_OVERENGINEERING_GUARDRAILS.md`。

---

## 一、战役核心目标与用户诉求

1. **目录树层级同步展开与滚动定位**：
   - 当用户在消息流（气泡附件、富文本链接）中点击当前项目文件时，右侧打开文件预览，同时左侧目录树必须自动级联展开至对应祖先层级，高亮选中目标文件，并将该节点平滑滚动至可视区域中央（`scrollIntoView`）。
2. **目录树行为纯粹化（单轨收敛）**：
   - 目录树严格遵循现代标准 IDE 规范，只保留“展开与折叠（Expand/Collapse）”。
   - 彻底切除旧版“双击进入子文件夹刷新成新根目录（drill-down / cd）”与顶栏“上级目录 ↰”按钮等多轨陈旧逻辑。工作区根节点恒定不变。
3. **消息气泡旧附件样式物理删除与 58×58 方形卡片统一**：
   - 彻底物理删除对话流消息气泡（`ChatUserMessageRow.tsx`）中残留的灰色药丸胶囊（`.userAttachmentChip`）与裸图堆叠（`.userImages`），不留任何冗余代码与 CSS。
   - 统一接入输入框同源的 58×58 现代高质感实体卡片（图片 cover 缩略图、160+ 格式彩色图标、类型徽标、截断文件名、微边框、柔和无黑色混入的悬浮效果）。
4. **面包屑展开面板样式重塑与穿透分割线根除**：
   - **搜索框重塑**：全面对齐模型选择器（`ModelBadgePickerMenu`）的高级现代搜索样式（顶部发丝下边框一体化搜索栏、无边框极简 input、左侧放大镜、右侧精致动作按钮）。
   - **穿透分割线根除**：穿透层叠上下文（Stacking Context）根因，彻底消灭底层垂直拖拽分割线（`.filesSplitResizer`）穿透面包屑展开面板的视觉 Bug。
   - **树展开基准收敛**：面包屑面板内的树严格基于当前点击的面包屑节点向下展开，不从项目根目录重复列出；双击/选择仅在面板内生效或定位主树，绝不篡改主树根路径。

---

## 二、目录结构与产出白名单

严格遵守 `AGENTS.md` §4（根目录仅允许三类文档，子文件夹仅允许一级）：

```text
docs/file-tree-and-attachments-architecture/
├── README.md                                    # 战役索引与调度纪律（本文件）
├── 00-master-plan.md                            # 系统性自上而下重构总方案（待收敛生成）
└── independent-plans/                           # 一级子目录：各维度独立方案
    ├── 01-tree-and-navigation-plan.md           # 目录树与导航架构独立方案
    ├── 02-message-attachment-system-plan.md     # 消息附件统一系统独立方案
    ├── 03-breadcrumb-and-flyout-ui-plan.md      # 面包屑与浮层 UI 架构独立方案
    ├── 04-quality-gate-plan.md                  # 质量守门与立体化验证独立方案
    └── 05-challenger-plan.md                    # 全局端到端挑战者与反思方案
```

---

## 三、调度与执行纪律

1. **纯源码审视**：子 Agent 严禁查阅 `docs/archive/` 或历史废弃方案，基于当前 `apps/crish-desktop/src/` 真实代码进行独立推演与方案构思。
2. **纯逻辑规划**：方案只谈逻辑依赖、任务单元、文件域与验收断言，不谈人天、工期与人员安排，问题在逻辑上同权。
3. **单一真理源（SSOT）**：旧逻辑与旧样式一律物理删除，杜绝用 feature flag 或临时兼容包装器敷衍维护多轨。
4. **Git 提交权集中**：所有子 Agent 严禁提交 git，改动全部留存工作区，由主 Agent 履行立体化验证全绿后统一收口。

---

## 四、方案修订记录（2026-09-08 · 对齐真实源码）

> 主控 Agent 依据真实源码逐行核验，对 `00-master-plan.md` 与 `detailed-plans/01-05` 就地修订，消除总方案与详案之间的冲突，使其成为可直执行施工图。要点（详见 `00-master-plan.md` 附录）：

1. **零幽灵契约全域闭环**：`workspaceRoot` 幽灵字段共 3 处（`listDirectory` / `readTextFile` / `writeTextFile`），全部切除并新增 NEG-07 守门；
2. **§6.1 明确为「补丁语义」**：非整文件替换，冻结既有公共导出与沙箱加固实现；
3. **§6.10/§6.11/§7.3 按 SPEC-05 重写**：修正 `messageRowAriaLabel` 签名、恢复 `data-msg-id`/`data-role`/pinBadge/`invalidateActual`、测试改用真实枚举 `'completed'` 并补 mock；
4. **新增 §7.4**：`filePanelOpener.test.ts` 存量测试改写施工图（原 L91-105 断言旧截断行为，CRIT-01 落地后必红）；
5. **NEG-04/05 纠偏**：面包屑搜索容器与 `type="search"` 输入框按用户裁决保留，不再断言为 null；
6. **计数与事实纠偏**：裸 Hex 实为 8 处（非 6）、`.filesBar` 实为 `var(--z-card-footer, 10)`、CRIT-07 改为预防性推导、波次编号与详案映射说明；
7. **SPEC-01/02/04/05 同步修订**：白名单扩至 4 文件、read/write 切除施工图、防环测试断言修正、`normalizeMessageAttachments` 导出补全。
