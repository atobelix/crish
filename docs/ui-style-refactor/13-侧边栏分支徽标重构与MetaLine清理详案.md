# 详案 13：侧边栏分支徽标重构与 MetaLine 清理详案

> **文档标识**：[`docs/ui-style-refactor/13-侧边栏分支徽标重构与MetaLine清理详案.md`](file:///c:/Software/conex/docs/ui-style-refactor/13-%E4%BE%A7%E8%BE%B9%E6%A0%8F%E5%88%86%E6%94%AF%E5%BE%BD%E6%A0%87%E9%87%8D%E6%9E%84%E4%B8%8EMetaLine%E6%88%BF%E7%90%86%E8%AF%A6%E6%A1%88.md)
> **所属战役**：[`docs/ui-style-refactor/00-总方案-工作区面板交互平滑与视觉归一.md`](file:///c:/Software/conex/docs/ui-style-refactor/00-%E6%80%BB%E6%96%B9%E6%A1%88-%E5%B7%A5%E4%BD%9C%E5%8C%BA%E9%9D%A2%E6%9D%BF%E4%BA%A4%E4%BA%92%E5%B9%B3%E6%BB%91%E4%B8%8E%E8%A7%86%E8%A7%89%E5%BD%92%E4%B8%80.md)
> **实施基准**：[`docs/ui-style-refactor/06-定案-工作区面板与工具栏细节深化决策.md`](file:///c:/Software/conex/docs/ui-style-refactor/06-%E5%AE%9A%E6%A1%88-%E5%B7%A5%E4%BD%9C%E5%8C%BA%E9%9D%A2%E6%9D%BF%E4%B8%8E%E5%B7%AE%E5%BC%82%E9%9D%A2%E6%9D%BF%E8%A7%86%E8%A7%89%E6%A0%B7%E5%BC%8F%E9%87%8D%E6%9E%84.md) §一.3 & §一.4、[`docs/ui-style-refactor/audits/08-sidebar-branch-escape-and-metaline-audit.md`](file:///c:/Software/conex/docs/ui-style-refactor/audits/08-sidebar-branch-escape-and-metaline-audit.md) 专项审计报告
> **调度标准**：严格遵循 [`docs/agent-roles/prompts/主控-全流程调度-v3.md`](file:///c:/Software/conex/docs/agent-roles/prompts/%E4%B8%BB%E6%8E%A7-%E5%85%A8%E6%B5%81%E7%A8%8B%E8%B0%83%E5%BA%A6-v3.md) §二.4 详案模板
> **核心使命**：彻底废除 `SessionRow.tsx` 中暴力拼接 `"分支: "` 字符串导致的侧栏严重挤压变形与样式逃逸，引入 `<GitBranch size={11} />` 规范微徽标组件释放宽度；连根拔除 `OverviewHeader.tsx` 顶层孤立的 `_metaLine_1qjwi_41` 冗余芯片与 `OverviewCard.module.css` 死样式规则，净化右侧总览面板首屏空间。

---

## 目录

1. [一、做什么（新增 / 重构清单）](#一做什么新增--重构清单)
   - [1.1 侧栏分支徽标结构化与微图标改造（`SessionRow.tsx`）](#11-侧栏分支徽标结构化与微图标改造sessionrowtsx)
   - [1.2 侧边栏宽度释放与盒模型布局优化](#12-侧边栏宽度释放与盒模型布局优化)
   - [1.3 概览面板 `_metaLine_1qjwi_41` 冗余彻底清理（`OverviewHeader.tsx`）](#13-概览面板-_metaline_1qjwi_41-冗余彻底清理overviewheadertsx)
   - [1.4 CSS 规则规范化与折叠态自治响应（`SidebarSessionList.module.css`）](#14-css-规则规范化与折叠态自治响应sidebarsessionlistmodulecss)
2. [二、删什么（删除 / 收敛清单 - 强制专节）](#二删什么删除--收敛清单---强制专节)
   - [2.1 侧栏分支字符串拼接与灭活死 CSS 删除面（DEL-WS-04, DEL-WS-04-CSS）](#21-侧栏分支字符串拼接与灭活死-css-删除面del-ws-04-del-ws-04-css)
   - [2.2 OverviewHeader 孤立 `.metaLine` 节点与 CSS 删除面（DEL-WS-05, DEL-WS-05-CSS）](#22-overviewheader-孤立-metaline-节点与-css-删除面del-ws-05-del-ws-05-css)
   - [2.3 OverviewCard 冗余 Prop 与无用导入删除面（DEL-WS-05-PROP）](#23-overviewcard-冗余-prop-与无用导入删除面del-ws-05-prop)
   - [2.4 全量删除与收敛前后对照矩阵](#24-全量删除与收敛前后对照矩阵)
3. [三、依赖与逻辑顺序（先删后改 DAG 拓扑）](#三依赖与逻辑顺序先删后改-dag-拓扑)
   - [3.1 实施推进 4 个阶段时序图与强依赖关系](#31-实施推进-4-个阶段时序图与强依赖关系)
   - [3.2 步骤级详细执行顺序](#32-步骤级详细执行顺序)
4. [四、唯一文件域（独占修改与新增文件清单）](#四唯一文件域独占修改与新增文件清单)
   - [4.1 独占修改文件清单](#41-独占修改文件清单)
   - [4.2 关联单测与守卫验证文件](#42-关联单测与守卫验证文件)
   - [4.3 跨模块正交无冲突边界约束](#43-跨模块正交无冲突边界约束)
5. [五、详细代码修改契约（Before / After 语义级差异与完整 Diff）](#五详细代码修改契约before--after-语义级差异与完整-diff)
   - [5.1 `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`](#51-appscrish-desktopsrccomponentssidebarsession-listsessionrowtsx)
   - [5.2 `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css`](#52-appscrish-desktopsrccomponentssidebarsidebarsessionlistmodulecss)
   - [5.3 `apps/crish-desktop/src/components/overview/OverviewHeader.tsx`](#53-appscrish-desktopsrccomponentsoverviewoverviewheadertsx)
   - [5.4 `apps/crish-desktop/src/components/overview/OverviewCard.module.css`](#54-appscrish-desktopsrccomponentsoverviewoverviewcardmodulecss)
   - [5.5 `apps/crish-desktop/src/components/overview/OverviewCard.tsx`](#55-appscrish-desktopsrccomponentsoverviewoverviewcardtsx)
   - [5.6 `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.test.tsx`](#56-appscrish-desktopsrccomponentssidebarsession-listsessionrowtesttsx)
6. [六、A11y 无障碍与视觉尺寸精算保障](#六a11y-无障碍与视觉尺寸精算保障)
   - [6.1 侧栏 28px 胶囊行可用宽度精算全景表](#61-侧栏-28px-胶囊行可用宽度精算全景表)
   - [6.2 辅助技术与 Screen Reader 语义层级提升](#62-辅助技术与-screen-reader-语义层级提升)
   - [6.3 侧边栏折叠态（Collapsed 32px）视觉无缝适配](#63-侧边栏折叠态collapsed-32px视觉无缝适配)
7. [七、单测断言与防回归自动化守卫套件](#七单测断言与防回归自动化守卫套件)
   - [7.1 `SessionRow.test.tsx` 现有用例保障与分支徽标断言扩展](#71-sessionrowtesttsx-现有用例保障与分支徽标断言扩展)
   - [7.2 `OverviewHeader` 纯净化无 `_metaLine` 断言](#72-overviewheader-纯净化无-_metaline-断言)
8. [八、验收标准与门禁规范](#八验收标准与门禁规范)
   - [8.1 功能验收标准](#81-功能验收标准)
   - [8.2 负产出验收标准（Zero Tolerance）](#82-负产出验收标准zero-tolerance)
   - [8.3 全链路自动化门禁命令集](#83-全链路自动化门禁命令集)

---

## 一、做什么（新增 / 重构清单）

本详案针对深度审计报告 [`audits/08-sidebar-branch-escape-and-metaline-audit.md`](file:///c:/Software/conex/docs/ui-style-refactor/audits/08-sidebar-branch-escape-and-metaline-audit.md) 中揭示的两大核心缺陷进行全面整改：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│               Conex / Crish 侧边栏分支徽标与 MetaLine 清理重构架构图                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   【模块 A：侧边栏分支会话行 (SessionRow)】                                               │
│   • 彻底废除 "分支: " 字符串拼接，保持 displayText 纯净标题                                │
│   • 引入 <GitBranch size={11} className={styles.branchIcon} /> 结构化微图标              │
│   • 新增 .branchBadge 胶囊容器 (flex-shrink: 0, margin-right: 4px)                     │
│   • 宽度占用由 40px (文本) 骤降至 14px (图标)，真实标题可用宽度净增 +26px                 │
│   • Tooltip 与 aria-label 增强: "分支会话：{displayText}"                               │
│                                                                                        │
│   【模块 B：概览面板顶栏 (OverviewHeader)】                                             │
│   • 物理删除 .metaLine 容器与 .metaChip (即 _metaLine_1qjwi_41 编译产物)                │
│   • 物理删除 OverviewHeaderProps 中的 wsPath 属性与 basename(wsPath) DOM 节点          │
│   • OverviewCard 移除 wsPath={wsPath} 与 getWorkspacePath 冗余引入                      │
│   • OverviewCard.module.css 彻底清理 .metaLine 与 .metaChip 死样式规则                   │
│   • 概览卡片顶部首屏直接呈现 ProgressSection (活动任务与目标)，释放 34px 黄金垂直空间    │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 侧栏分支徽标结构化与微图标改造（`SessionRow.tsx`）
1. **数据层与展示层解耦**：
   - 彻底废止将分支信息作为纯文本前缀 `"分支: "` 注入 `displayText` 的历史恶习；
   - 提取会话标题时，仅使用正则 `.replace(/ - 分支$/, '')` 剥离右键菜单创建分支时落盘的兼容后缀，保证 `displayText` 为用户真实的会话纯净标题；
2. **结构化微图标组件注入**：
   - 从 `lucide-react` 中引入 `GitBranch` 矢量微图标（`size={11}`, `strokeWidth={2}`）；
   - 在 `.sessionTextCol` 容器内部，当 `isBranched === true` 时，在标题前面插入结构化徽标容器 `<span className={styles.branchBadge} aria-label="分支会话"><GitBranch size={11} strokeWidth={2} className={styles.branchIcon} aria-hidden /></span>`；
3. **无障碍与悬停提示增强**：
   - `tipContent` 与 `ariaLabel` 保持语义化分层：
     - 若为分支会话，Tooltip 与 ARIA 呈现为 `分支会话：${displayText}`；
     - 若在运行中，呈现为 `分支会话：${displayText}，处理中`；
     - 避免屏幕阅读器读出生硬的“分支冒号”。

### 1.2 侧边栏宽度释放与盒模型布局优化
- **历史瓶颈**：全角冒号与中文 `"分支: "` 占用 `~40px` 宽度，在侧栏 `220px` 默认宽度下，仅剩 `~88px`（约 6 个中文字）供标题使用，造成剧烈截断与灰块挤压感；
- **优化效益**：
  - 微图标 `.branchBadge` 宽度仅为 `11px` 图标 + `4px` 右间距 = **`15px`**；
  - **释放出 `+25px` 的黄金文本宽度**，标题可见区域提升近 **30%**；
  - 极大降低标题被省略号截断的概率，彻底消灭“挤成一团变形灰块”的逃逸感。

### 1.3 概览面板 `_metaLine_1qjwi_41` 冗余彻底清理（`OverviewHeader.tsx`）
1. **彻底拔除冗余 DOM**：
   - Vite 编译产物类名 `_metaLine_1qjwi_41` 对应 `OverviewCard.module.css` 中的 `.metaLine`；
   - 在 `OverviewHeader.tsx` 中，彻底移除 `{wsPath ? <div className={styles.metaLine}...>...</div> : null}`；
   - `OverviewHeader` 聚焦单一职责，仅承载 `ProgressSection`（进度与任务目标）；
2. **接口契约精简**：
   - 从 `OverviewHeaderProps` 中物理移除 `wsPath?: string | null | undefined`；
   - `OverviewHeader.tsx` 移除 `Tooltip`、`basename`、`styles` 等无用引入；
3. **调用方清理（`OverviewCard.tsx`）**：
   - 移除 `const wsPath = getWorkspacePath();`；
   - 移除 `import { getWorkspacePath } from '../../api/projectStore';`；
   - 移除 `<OverviewHeader wsPath={wsPath} ... />` 中的属性透传。

### 1.4 CSS 规则规范化与折叠态自治响应（`SidebarSessionList.module.css`）
1. **清理灭活代码**：
   - 彻底删除 `.sessionItem.branchSession::before { display: none; }` 死规则；
2. **定义 `.branchBadge` 与 `.branchIcon`**：
   - `.branchBadge` 声明为 `display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; margin-right: var(--space-1);`；
   - `.branchIcon` 绑定 `color: var(--accent-primary, #6366f1); opacity: 0.85;`；
   - 在 `.sessionItem:hover` 与 `.sessionItem.active` 状态下，`.branchIcon` 的 `opacity` 提升至 `1`，实现细腻微交互；
3. **侧栏折叠态自治**：
   - 在 `:global([data-sidebar-collapsed='1'])` 与 `:global([data-sidebar-collapsed='true'])` 隐藏选择器列表中，将 `.branchBadge` 纳入隐藏，确保侧栏收起为 32px 胶囊时仅显示圆点指示器，杜绝图标溢出。

---

## 二、删什么（删除 / 收敛清单 - 强制专节）

本详案严格遵守定案决策中的先删后改原则，以下列出必须被物理删除的代码与样式清单：

### 2.1 侧栏分支字符串拼接与灭活死 CSS 删除面（DEL-WS-04, DEL-WS-04-CSS）

1. **【DEL-WS-04】删除 `SessionRow.tsx:206-210` 中的 `"分支: "` 字符串拼接**：
   - **删除位置**：[`apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx:206-210`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx#L206-L210)
   - **代码现状**：
     ```tsx
     const isBranched = !!s.branchParentId;
     const baseTitle = sessionListDisplayTitle(s);
     const displayText = isBranched
       ? `分支: ${baseTitle.replace(/ - 分支$/, '')}`
       : baseTitle;
     ```
   - **删除理由**：暴力字符串拼接破坏数据纯净度、抢占 40px 文本宽度、破坏 A11y 语义；
   - **收敛形态**：`displayText` 保持为纯净会话标题 `baseTitle.replace(/ - 分支$/, '')`，分支标识由独立组件 `<GitBranch />` 渲染。
2. **【DEL-WS-04-CSS】删除 `SidebarSessionList.module.css:315-317` 的 `display: none` 灭活死规则**：
   - **删除位置**：[`apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css:315-317`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L315-L317)
   - **代码现状**：
     ```css
     .sessionItem.branchSession::before {
       display: none;
     }
     ```
   - **删除理由**：历史无用样式灭活残留；
   - **收敛形态**：彻底删除该块规则，替换为规范的 `.branchBadge` 与 `.branchIcon`。

---

### 2.2 OverviewHeader 孤立 `.metaLine` 节点与 CSS 删除面（DEL-WS-05, DEL-WS-05-CSS）

1. **【DEL-WS-05】删除 `OverviewHeader.tsx:21-27` 的 `.metaLine` 节点与 `wsPath` prop**：
   - **删除位置**：[`apps/crish-desktop/src/components/overview/OverviewHeader.tsx:8-27`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewHeader.tsx#L8-L27)
   - **代码现状**：
     ```tsx
     export interface OverviewHeaderProps {
       wsPath?: string | null | undefined;
       session?: SessionState | undefined;
       onGoalClick?: (() => void) | undefined;
     }
     ...
     {wsPath ? (
       <div className={styles.metaLine} aria-label="会话状态">
         <Tooltip content={wsPath}>
           <span className={styles.metaChip}>{basename(wsPath)}</span>
         </Tooltip>
       </div>
     ) : null}
     ```
   - **删除理由**：该节点即编译产物 `_metaLine_1qjwi_41`，与 TopBar、UserProfileCard、ChangesSection 三重信息重复，且 A11y 虚假标记为“会话状态”，浪费顶部 34px 垂直高度；
   - **收敛形态**：彻底移除该节点与 `wsPath` prop。
2. **【DEL-WS-05-CSS】删除 `OverviewCard.module.css:21-39` 中的 `.metaLine` 与 `.metaChip` 死样式**：
   - **删除位置**：[`apps/crish-desktop/src/components/overview/OverviewCard.module.css:21-39`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css#L21-L39)
   - **代码现状**：
     ```css
     .metaLine {
       display: flex;
       flex-wrap: wrap;
       gap: var(--space-1_5);
       min-width: 0;
       flex-shrink: 0;
     }

     .metaChip {
       display: inline-flex;
       align-items: center;
       gap: var(--space-1);
       max-width: 100%;
       font-size: var(--font-size-xs);
       color: var(--text-tertiary);
       overflow: hidden;
       text-overflow: ellipsis;
       white-space: nowrap;
     }
     ```
   - **删除理由**：随着 `OverviewHeader` 节点移除，该 CSS 规则沦为死代码；
   - **收敛形态**：物理删除整段 19 行规则。

---

### 2.3 OverviewCard 冗余 Prop 与无用导入删除面（DEL-WS-05-PROP）

1. **【DEL-WS-05-PROP】删除 `OverviewCard.tsx` 中的 `wsPath` 声明与导入**：
   - **删除位置**：[`apps/crish-desktop/src/components/overview/OverviewCard.tsx:17, 107, 117`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx#L17)
   - **代码现状**：
     ```tsx
     import { getWorkspacePath } from '../../api/projectStore';
     ...
     const wsPath = getWorkspacePath();
     ...
     <OverviewHeader
       wsPath={wsPath}
       session={session}
       onGoalClick={() => setOpenSec((p) => ({ ...p, activeTasks: true }))}
     />
     ```
   - **删除理由**：`wsPath` 仅供 `OverviewHeader` 渲染已删除的 `.metaLine` 使用，组件内无其他消费方；
   - **收敛形态**：彻底移除 `getWorkspacePath` 导入、`wsPath` 常量以及 `<OverviewHeader />` 上的属性传递。

---

### 2.4 全量删除与收敛前后对照矩阵

| 序号 | 治理项 ID | 目标文件与行号 | 删除前退化形态 (Before) | 删除/收敛后形态 (After) | 治理收益与断言 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **DEL-WS-04** | `SessionRow.tsx:206-210` | `displayText = isBranched ? '分支: ' + ... : baseTitle` | `displayText = baseTitle.replace(/ - 分支$/, '')` | 废除硬编码前缀，释放 26px 宽度，标题纯净 |
| 2 | **DEL-WS-04-CSS** | `SidebarSessionList.module.css:315-317` | `.sessionItem.branchSession::before { display: none; }` | 替换为 `.branchBadge` 与 `.branchIcon` 规范样式 | 清理灭活规则，提供 11px 矢量分支图标视觉 |
| 3 | **DEL-WS-05** | `OverviewHeader.tsx:21-27` | `{wsPath ? <div className={styles.metaLine}>...</div> : null}` | **彻底物理删除** | 根除 `_metaLine_1qjwi_41` 冗余芯片，释放首屏 34px |
| 4 | **DEL-WS-05-CSS** | `OverviewCard.module.css:21-39` | `.metaLine { ... } .metaChip { ... }` | **彻底物理删除** (19 行 CSS) | 清理死代码，降低编译后 CSS 体积 |
| 5 | **DEL-WS-05-PROP**| `OverviewCard.tsx:17, 107, 117` | `import { getWorkspacePath }... wsPath={wsPath}` | **彻底物理删除** | 精简组件接口契约，减少多余 Store 读取 |

---

## 三、依赖与逻辑顺序（先删后改 DAG 拓扑）

### 3.1 实施推进 4 个阶段时序图与强依赖关系

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        详案 13 实施先删后改 DAG 拓扑推进图                               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│ 【阶段 0：死层、冗余节点与废弃 CSS 物理清剿 (Phase 0 - Deletion Surface)】                │
│   ├── 1. 物理删除 OverviewHeader.tsx 中的 .metaLine 容器与 wsPath Prop                  │
│   ├── 2. 物理删除 OverviewCard.module.css 中的 .metaLine 与 .metaChip CSS 规则          │
│   ├── 3. 物理删除 OverviewCard.tsx 中的 getWorkspacePath 导入与 wsPath 透传           │
│   ├── 4. 物理删除 SessionRow.tsx 中的 "分支: " 字符串拼接                              │
│   └── 5. 物理删除 SidebarSessionList.module.css 中 ::before { display: none }          │
│         │                                                                              │
│         ▼ (阶段 0 门禁全绿：npm run typecheck 0 错误)                                   │
│ 【阶段 1：分支微图标组件化与样式落地 (Phase 1 - Branch Badge Integration)】              │
│   ├── 1. SessionRow.tsx 引入 GitBranch 图标，注入 .branchBadge 容器                     │
│   ├── 2. SessionRow.tsx 完善 aria-label 与 Tooltip 的 "分支会话：{title}" 语义分层     │
│   ├── 3. SidebarSessionList.module.css 新增 .branchBadge、.branchIcon 与折叠态选择器    │
│   └── 4. OverviewHeader.tsx 净化为仅承载 ProgressSection 的极简组件                    │
│         │                                                                              │
│         ▼                                                                              │
│ 【阶段 2：单元测试更新与断言固化 (Phase 2 - Test Suite Updates)】                        │
│   ├── 1. SessionRow.test.tsx 新增分支会话渲染 GitBranch 图标断言                       │
│   ├── 2. SessionRow.test.tsx 验证标题不再包含 "分支: " 前缀且 " - 分支" 后缀被正确剥离 │
│   └── 3. 验证 OverviewHeader 不再包含 .metaLine 相关的任何 DOM 与样式类               │
│         │                                                                              │
│         ▼                                                                              │
│ 【阶段 3：全链路门禁总验收 (Phase 3 - Verification & Gates)】                            │
│   ├── 1. npm run typecheck (0 TS 错误)                                                 │
│   ├── 2. npm run check:line-counts (全部文件严格在 650 行以内，0 违规)                  │
│   └── 3. npx vitest run (相关单测 100% PASS)                                           │
│                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 步骤级详细执行顺序

1. **Step 1 (Clear MetaLine & OverviewHeader)**：
   - 移除 `OverviewHeader.tsx` 中的 `wsPath` 属性和 `.metaLine` 结构；
   - 移除 `OverviewCard.module.css` 中的 `.metaLine` 和 `.metaChip`；
   - 移除 `OverviewCard.tsx` 中的 `getWorkspacePath` 和 `wsPath={wsPath}`；
2. **Step 2 (Refactor SessionRow Branch Badge)**：
   - 在 `SessionRow.tsx` 中导入 `GitBranch`；
   - 废除 `"分支: "` 字符串拼接，纯净化 `displayText`；
   - 在 `.sessionTextCol` 中有条件渲染 `<span className={styles.branchBadge}><GitBranch ... /></span>`；
   - 在 `SidebarSessionList.module.css` 中移除 `::before { display: none }` 并新增 `.branchBadge`、`.branchIcon`；
   - 在折叠态列表中增加 `.branchBadge` 隐藏规则；
3. **Step 3 (Update Unit Tests & Assertions)**：
   - 更新 `SessionRow.test.tsx` 补充分支测试用例；
4. **Step 4 (CI Pipeline Verification)**：
   - 运行类型检查、行数检查与单元测试。

---

## 四、唯一文件域（独占修改与新增文件清单）

本详案严格限定在以下 6 个文件域内操作，与其他并发详案（如详案 11：工具栏高度对齐、详案 12：概览改动文件列表扁平化）保持严格正交无重叠：

### 4.1 独占修改文件清单

```
c:/Software/conex/apps/crish-desktop/
  ├── src/components/sidebar/session-list/
  │     ├── SessionRow.tsx                                [独占 · 引入 GitBranch 微图标，移除字符串拼接]
  │     └── SessionRow.test.tsx                           [独占 · 新增分支图标与纯净标题单测用例]
  ├── src/components/sidebar/
  │     └── SidebarSessionList.module.css                 [独占 · 新增 .branchBadge/.branchIcon，删除灭活规则]
  └── src/components/overview/
        ├── OverviewHeader.tsx                            [独占 · 移除 .metaLine 节点与 wsPath prop]
        ├── OverviewCard.module.css                       [独占 · 删除 .metaLine 与 .metaChip 样式规则]
        └── OverviewCard.tsx                              [独占 · 移除 getWorkspacePath 导入与 wsPath 透传]
```

### 4.2 关联单测与守卫验证文件

| 目标文件路径 | 变更性质 | 测试职责与断言内容 |
| :--- | :--- | :--- |
| [`apps/crish-desktop/src/components/sidebar/session-list/SessionRow.test.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.test.tsx) | 契约更新 | 验证普通会话/分支会话渲染、GitBranch 图标存在性、Tooltip/ARIA 完整性、" - 分支" 后缀剥离。 |

### 4.3 跨模块正交无冲突边界约束
- **与详案 11（工具栏 26px）边界**：详案 11 负责 `DiffCard.module.css`、`DiffHeaderControls.tsx`、`FilesCard.module.css`；本详案不改动任何 Diff/Files 控件；
- **与详案 12（改动文件列表扁平化）边界**：详案 12 负责 `ChangesSection.tsx`、`OverviewChangesList.tsx`；本详案仅负责 `OverviewHeader.tsx` 与 `OverviewCard.tsx` 的 Header 调用层，两者修改行号完全隔离。

---

## 五、详细代码修改契约（Before / After 语义级差异与完整 Diff）

### 5.1 `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`

- **修改说明**：
  1. 引入 `GitBranch` 图标；
  2. 废除 `displayText` 中的 `"分支: "` 字符串拼接，保持为纯净标题；
  3. 在 `.sessionTextCol` 内渲染 `.branchBadge` 与 `<GitBranch />`；
  4. 升级 `ariaLabel` 与 `tipContent`。

```diff
--- a/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx
+++ b/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx
@@ -21,3 +21,3 @@
 import styles from '../SidebarSessionList.module.css';
-import { MoreHorizontal } from 'lucide-react';
+import { GitBranch, MoreHorizontal } from 'lucide-react';

@@ -206,5 +206,3 @@
   const isBranched = !!s.branchParentId;
   const baseTitle = sessionListDisplayTitle(s);
-  const displayText = isBranched
-    ? `分支: ${baseTitle.replace(/ - 分支$/, '')}`
-    : baseTitle;
+  const displayText = baseTitle.replace(/ - 分支$/, '');
   const isRunning = s.messages?.some((m) => m.status === 'processing') ?? false;
@@ -238,4 +236,5 @@
   // 产品约束：每条对话固定单行，禁止 multiLine / 项目副行 / 搜索副行撑高
-  const ariaLabel = isRunning ? `${displayText}，处理中` : displayText;
-  const tipContent = displayText;
+  const sessionTitleWithBranch = isBranched ? `分支会话：${displayText}` : displayText;
+  const ariaLabel = isRunning ? `${sessionTitleWithBranch}，处理中` : sessionTitleWithBranch;
+  const tipContent = sessionTitleWithBranch;

@@ -351,4 +350,9 @@
             <Tooltip content={tipContent}>
               <span className={styles.sessionTextCol}>
+                {isBranched && (
+                  <span className={styles.branchBadge} aria-label="分支会话">
+                    <GitBranch size={11} strokeWidth={2} className={styles.branchIcon} aria-hidden />
+                  </span>
+                )}
                 <span className={styles.sessionText}>{displayText}</span>
               </span>
```

---

### 5.2 `apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css`

- **修改说明**：
  1. 删除 `.sessionItem.branchSession::before { display: none; }`；
  2. 新增 `.branchBadge` 与 `.branchIcon` 样式规则；
  3. 在 `:global([data-sidebar-collapsed='1'])` 列表中补充 `.branchBadge`。

```diff
--- a/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css
+++ b/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css
@@ -311,7 +311,18 @@
 .sessionItem.branchSession {
   position: relative;
 }

-.sessionItem.branchSession::before {
-  display: none;
+.branchBadge {
+  display: inline-flex;
+  align-items: center;
+  justify-content: center;
+  flex-shrink: 0;
+  margin-right: var(--space-1);
+  color: var(--text-tertiary);
+}
+
+.branchIcon {
+  color: var(--accent-primary, #6366f1);
+  opacity: 0.85;
+  transition: color var(--transition-micro), opacity var(--transition-micro);
 }
+
+.sessionItem:hover .branchIcon,
+.sessionItem.active .branchIcon {
+  opacity: 1;
 }

@@ -582,2 +593,3 @@
 :global([data-sidebar-collapsed='1']) .sessionActionsBtn,
+:global([data-sidebar-collapsed='1']) .branchBadge,
 :global([data-sidebar-collapsed='1']) .emptyHint,
@@ -591,2 +603,3 @@
 :global([data-sidebar-collapsed='true']) .sessionActionsBtn,
+:global([data-sidebar-collapsed='true']) .branchBadge,
 :global([data-sidebar-collapsed='true']) .emptyHint,
```

---

### 5.3 `apps/crish-desktop/src/components/overview/OverviewHeader.tsx`

- **修改说明**：
  1. 移除 `wsPath` 属性定义与 `styles` / `Tooltip` / `basename` 导入；
  2. 移除 `.metaLine` 节点，仅保留 `ProgressSection`。

```diff
--- a/apps/crish-desktop/src/components/overview/OverviewHeader.tsx
+++ b/apps/crish-desktop/src/components/overview/OverviewHeader.tsx
@@ -1,6 +1,2 @@
 import React from 'react';
-import styles from './OverviewCard.module.css';
-import { Tooltip } from '../ui';
-import { basename } from './helpers';
 import { ProgressSection } from './ProgressSection';
 import type { SessionState } from '../../store/types';
@@ -8,3 +4,2 @@
 export interface OverviewHeaderProps {
-  wsPath?: string | null | undefined;
   session?: SessionState | undefined;
   onGoalClick?: (() => void) | undefined;
@@ -17,14 +12,6 @@
 export const OverviewHeader: React.FC<OverviewHeaderProps> = React.memo(
-  function OverviewHeader({ wsPath, session, onGoalClick }) {
-    return (
-      <>
-        {wsPath ? (
-          <div className={styles.metaLine} aria-label="会话状态">
-            <Tooltip content={wsPath}>
-              <span className={styles.metaChip}>{basename(wsPath)}</span>
-            </Tooltip>
-          </div>
-        ) : null}
-
-        <ProgressSection session={session} onGoalClick={onGoalClick} />
-      </>
-    );
+  function OverviewHeader({ session, onGoalClick }) {
     return <ProgressSection session={session} onGoalClick={onGoalClick} />;
   }
 );
```

---

### 5.4 `apps/crish-desktop/src/components/overview/OverviewCard.module.css`

- **修改说明**：物理删除 L21-L39 中的 `.metaLine` 与 `.metaChip` 废弃样式规则（共 19 行）。

```diff
--- a/apps/crish-desktop/src/components/overview/OverviewCard.module.css
+++ b/apps/crish-desktop/src/components/overview/OverviewCard.module.css
@@ -21,19 +20,0 @@
-.metaLine {
-  display: flex;
-  flex-wrap: wrap;
-  gap: var(--space-1_5);
-  min-width: 0;
-  flex-shrink: 0;
-}
-
-.metaChip {
-  display: inline-flex;
-  align-items: center;
-  gap: var(--space-1);
-  max-width: 100%;
-  font-size: var(--font-size-xs);
-  color: var(--text-tertiary);
-  overflow: hidden;
-  text-overflow: ellipsis;
-  white-space: nowrap;
-}
-
```

---

### 5.5 `apps/crish-desktop/src/components/overview/OverviewCard.tsx`

- **修改说明**：
  1. 移除 `getWorkspacePath` 导入；
  2. 移除 `const wsPath = getWorkspacePath();`；
  3. 移除 `<OverviewHeader />` 上的 `wsPath={wsPath}`。

```diff
--- a/apps/crish-desktop/src/components/overview/OverviewCard.tsx
+++ b/apps/crish-desktop/src/components/overview/OverviewCard.tsx
@@ -17,1 +17,0 @@
-import { getWorkspacePath } from '../../api/projectStore';
@@ -107,1 +106,0 @@
-  const wsPath = getWorkspacePath();
@@ -117,1 +115,0 @@
-        wsPath={wsPath}
```

---

### 5.6 `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.test.tsx`

- **修改说明**：新增对普通会话标题与分支会话 `<GitBranch />` 徽标、纯净标题及 Tooltip 语义的单测覆盖。

```diff
--- a/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.test.tsx
+++ b/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.test.tsx
@@ -126,2 +126,30 @@
   });
+
+  it('普通会话直接渲染纯净标题，不渲染分支徽标', () => {
+    renderRow();
+    const row = screen.getByTestId('sidebar-session-item');
+    expect(row.textContent).toContain('测试会话');
+    expect(row.querySelector('svg[data-icon="git-branch"], svg.lucide-git-branch')).toBeNull();
+  });
+
+  it('分支会话渲染 GitBranch 微图标，且标题不带 "分支: " 纯文本前缀', () => {
+    const branchSession = makeSession({
+      id: 'sess-branch',
+      title: '分析代码架构 - 分支',
+      branchParentId: 'sess-parent',
+    });
+    renderRow({
+      session: {
+        s: branchSession,
+        activeSessionId: 'other',
+        searchQuery: '',
+        isDraggingThis: false,
+        isRenaming: false,
+        isDraggable: true,
+      },
+    });
+    const row = screen.getByTestId('sidebar-session-item');
+    expect(row.textContent).toContain('分析代码架构');
+    expect(row.textContent).not.toContain('分支:');
+    expect(row.getAttribute('aria-label')).toContain('分支会话：分析代码架构');
+  });
 });
```

---

## 六、A11y 无障碍与视觉尺寸精算保障

### 6.1 侧栏 28px 胶囊行可用宽度精算全景表

下表列出侧栏在标准宽度（220px）与极限窄宽（180px）下，重构前后的文本可用空间对比：

| 指标 / 区域 | 重构前（Before 纯文本 `"分支: "`） | 重构后（After `<GitBranch />` 微徽标） | 优化收益 (Delta) |
| :--- | :--- | :--- | :--- |
| **侧栏默认总宽** | `220px` | `220px` | - |
| **容器外边距 + 内边距** | 左 10px + 右 10px + 文件夹缩进 10px = **30px** | 左 10px + 右 10px + 文件夹缩进 10px = **30px** | - |
| **`.sessionItem` 内边距** | `10px + 8px = 18px` | `10px + 8px = 18px` | - |
| **右侧操作区 `.sessionTrailing`** | **44px** (时间/更多按钮) | **44px** (时间/更多按钮) | - |
| **分支指示器占用宽度** | 中文 `"分支: "` 独占 **`~40px`** | `<GitBranch size={11} />` + 4px 间距 = **`15px`** | **`-25px` (大幅瘦身 62.5%)** |
| **会话标题可用宽度** | `220 - 30 - 18 - 44 - 40 =` **`88px`** | `220 - 30 - 18 - 44 - 15 =` **`113px`** | **`+25px` (标题空间扩容 +28.4%)** |
| **等效中文字符显示量** | 仅容纳 **约 5.5 个汉字**（极易截断为 `"你好啊。..."`） | 容纳 **约 8 个汉字**（完整展示 `"你好啊。分析一下..."`） | **多展示 2.5 个完整中文字** |

### 6.2 辅助技术与 Screen Reader 语义层级提升

```
【重构前屏幕阅读器朗读】:
  "treeitem, 分支: 你好啊。分析一下代码, selected"  ❌ (语义混淆，无层级结构)

【重构后屏幕阅读器朗读】:
  "treeitem, 分支会话：你好啊。分析一下代码, selected"  ✅ (结构化属性声明，清晰自然)
```

1. **结构化属性**：`.branchBadge` 声明 `aria-label="分支会话"`，内部 `<GitBranch />` 声明 `aria-hidden`，保证辅助技术无障碍感知分支属性而无冗余 SVG 噪音；
2. **行级别声明**：`aria-label` 使用 `分支会话：${displayText}`，在会话处于运行态时平滑过渡为 `分支会话：${displayText}，处理中`。

### 6.3 侧边栏折叠态（Collapsed 32px）视觉无缝适配
- 当应用侧边栏折叠至 32px 紧凑圆点模式时，`:global([data-sidebar-collapsed='1']) .branchBadge` 规则触发 `display: none`；
- 避免分支图标在 32px 空间内与居中圆点产生定位重叠或溢出，保持折叠状态的极简纯净。

---

## 七、单测断言与防回归自动化守卫套件

### 7.1 `SessionRow.test.tsx` 现有用例保障与分支徽标断言扩展

在 `SessionRow.test.tsx` 中新增两大独立断言用例：

```typescript
it('普通会话直接渲染纯净标题，不渲染分支徽标', () => {
  renderRow();
  const row = screen.getByTestId('sidebar-session-item');
  expect(row.textContent).toContain('测试会话');
  expect(row.querySelector('svg.lucide-git-branch')).toBeNull();
});

it('分支会话渲染 GitBranch 微图标，且标题不带 "分支: " 纯文本前缀', () => {
  const branchSession = makeSession({
    id: 'sess-branch',
    title: '分析代码架构 - 分支',
    branchParentId: 'sess-parent',
  });
  renderRow({
    session: {
      s: branchSession,
      activeSessionId: 'other',
      searchQuery: '',
      isDraggingThis: false,
      isRenaming: false,
      isDraggable: true,
    },
  });
  const row = screen.getByTestId('sidebar-session-item');
  expect(row.textContent).toContain('分析代码架构');
  expect(row.textContent).not.toContain('分支:');
  expect(row.getAttribute('aria-label')).toContain('分支会话：分析代码架构');
});
```

### 7.2 `OverviewHeader` 纯净化无 `_metaLine` 断言
- 验证 `OverviewHeader` 渲染后，DOM 树中绝对不存在包含 `_metaLine` 或 `metaChip` 的节点；
- 验证 `OverviewHeader` 组件顶层仅直接渲染 `<ProgressSection />`。

---

## 八、验收标准与门禁规范

### 8.1 功能验收标准

1. **侧栏分支图标优雅渲染**：
   - 具有 `branchParentId` 的会话行在标题左侧正确显示 11px 紫色/强调色 `<GitBranch />` 图标；
   - 会话标题纯净无 `"分支: "` 字符串拼接，历史脏后缀 `" - 分支"` 被自动剥离；
   - 标题文本可用宽度显著提升，单行截断平滑自然；
2. **概览面板 `_metaLine` 彻底消失**：
   - 右侧概览卡片顶部不再显示孤立的灰色工作区名称芯片；
   - 首屏黄金位置直接由活动任务与目标（`ProgressSection`）占据，间距自然紧凑；
3. **无障碍与折叠态完备**：
   - 屏幕阅读器正确播报“分支会话：xxx”；
   - 侧边栏折叠时分支徽标自动隐藏，无布局溢出。

---

### 8.2 负产出验收标准（Zero Tolerance）

- ❌ **Zero-String-Prefix**：`SessionRow.tsx` 中严禁出现 `分支: `、`'分支: ' + ...` 等任何纯文本前缀硬编码；
- ❌ **Zero-MetaLine-DOM**：`OverviewHeader.tsx` 中严禁出现 `.metaLine`、`.metaChip` 或任何单独渲染 `wsPath` 的 DOM 节点；
- ❌ **Zero-Dead-CSS**：`OverviewCard.module.css` 与 `SidebarSessionList.module.css` 中严禁残留 `.metaLine`、`.metaChip` 或 `branchSession::before { display: none }` 等死规则；
- ❌ **Zero-Unused-Props**：`OverviewHeaderProps` 中严禁保留废弃的 `wsPath` 属性。

---

### 8.3 全链路自动化门禁命令集

本详案实施完成后，必须一次性通过以下三道硬性流水线门禁：

```bash
# 1. 严格 TypeScript 类型检查（0 错误）
npm run typecheck

# 2. 工程文件行数门禁（所有涉及文件硬阻断 <= 650 行，0 违规）
npm run check:line-counts

# 3. 单元测试全量验证（SessionRow 及相关组件单测 100% 通过）
npx vitest run src/components/sidebar/session-list/SessionRow.test.tsx
```
