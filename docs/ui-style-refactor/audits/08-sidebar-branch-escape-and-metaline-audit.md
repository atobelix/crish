# 08 · 侧边栏分支徽标样式逃逸变形与 MetaLine 冗余深度审计报告

- **战役任务**：侧边栏分支会话行样式逃逸变形与概览页 `_metaLine_1qjwi_41` 冗余深度审计
- **审计范围**：
  - `apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx` & `SidebarSessionList.module.css`
  - `apps/crish-desktop/src/components/sidebar/Sidebar.module.css` & `SidebarSessionList.tsx`
  - `apps/crish-desktop/src/components/sidebar/session-list/useSessionGrouping.ts`
  - `apps/crish-desktop/src/components/overview/OverviewHeader.tsx` & `OverviewCard.module.css` (`_metaLine_1qjwi_41`)
  - `apps/crish-desktop/src/components/overview/OverviewCard.tsx`
  - `apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx` & `AgentCard.module.css`
- **审计原则**：严苛挑刺、穿透表象深挖根因、列出详实代码坐标证据，严禁执行 git 操作，拒绝伪修复与表面妥协。
- **产出文件**：[`docs/ui-style-refactor/audits/08-sidebar-branch-escape-and-metaline-audit.md`](file:///c:/Software/conex/docs/ui-style-refactor/audits/08-sidebar-branch-escape-and-metaline-audit.md)（UTF-8 无 BOM）

---

## 一、审计背景与问题全景

用户反馈及真机界面存在两大显著的样式与结构缺陷：

```
                    ┌────────────────────────────────────────┐
                    │               用户核心反馈              │
                    └────────────────────────────────────────┘
                                        │
           ┌────────────────────────────┴────────────────────────────┐
           ▼                                                         ▼
【缺陷 1：侧边栏分支样式逃逸变形】                           【缺陷 2：_metaLine_1qjwi_41 冗余】
“分支选择的按钮，这个又是个逃逸的元素，                      “class='_metaLine_1qjwi_41'这个不用
 这都变成啥样了，你也没检查出来？”                            显示，有点多余了。”
 (表现为：`分支: 你好啊。分析一... 7/23`                       (表现为：总览卡片顶部悬浮孤立
  挤压在 28px 灰块行中，文本严重截断变形)                       的工作区文本片，占位冗余)
```

| 缺陷编号 | 现象与截面表现 | 涉及核心文件与定位 | 严重级别 |
| :--- | :--- | :--- | :--- |
| **BUG-08-01** | **侧栏分支会话行语义退化与样式挤压逃逸**：分叉会话直接被暴力硬编码字符串前缀 `"分支: "`，样式类 `.branchSession::before` 规则被 `display: none` 抹除，缺少独立 Badge 容器与图标，在 28px 高度限制与右侧 44px 操作区挤压下呈现为丑陋截断变形的灰色块条。 | [`SessionRow.tsx:206-210`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx#L206-L210)<br>[`SidebarSessionList.module.css:311-317`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L311-L317) | **P0 (高危视觉破损)** |
| **BUG-08-02** | **`_metaLine_1qjwi_41` 孤立工作区文本片冗余**：Vite 编译产物类名 `_metaLine_1qjwi_41` 对应 `OverviewCard.module.css:21` 中的 `.metaLine`。在 `OverviewHeader.tsx` 中孤立渲染 `basename(wsPath)`，不仅与全局顶栏/底部名片三重重复，且 A11y 标签虚标为 `"会话状态"`，产生多余垂直间距与视觉断层。 | [`OverviewHeader.tsx:21-27`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewHeader.tsx#L21-L27)<br>[`OverviewCard.module.css:21-39`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css#L21-L39) | **P1 (冗余视觉噪音)** |

---

## 二、专项审计 1：侧边栏分支会话样式逃逸与挤压变形深度剖析

### 2.1 根因一：语义降级——将结构化分支属性退化为纯文本字符串拼接

在 [`SessionRow.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx#L206-L210) 中，存在极其粗暴的字符串处理逻辑：

```tsx
// apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx:206-210
const isBranched = !!s.branchParentId;
const baseTitle = sessionListDisplayTitle(s);
const displayText = isBranched
  ? `分支: ${baseTitle.replace(/ - 分支$/, '')}`
  : baseTitle;
```

#### 毒点与危害：
1. **数据层与展示层双重污染**：
   - 在右键菜单创建分支时（[`useSidebarContextMenu.ts:217`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/useSidebarContextMenu.ts#L217)），会话标题被写入了后缀 `${title} - 分支`；
   - 在 UI 渲染层（`SessionRow.tsx`），又通过正则将 ` - 分支` 剥离，再在前端拼接 `"分支: "` 字符串；
   - 这种“存入时加后缀、读出时去后缀再加前缀”的脆弱逻辑，使分支标识无法作为结构化 UI 组件（如 `<Badge>`、`<GitBranch />` 徽标）独立渲染，而是与用户的真实会话标题混作一团。
2. **破坏无障碍可访问性 (A11y)**：
   - 屏幕阅读器读出的不是“会话标题：xxx，属性：分叉会话”，而是被生硬读成“分支冒号 xxx”，破坏了辅助技术的解析层级。

---

### 2.2 根因二：样式被粗暴阉割——`.branchSession::before` 被设置为 `display: none`

在 [`SidebarSessionList.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L311-L317) 中：

```css
/* apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css:311-317 */
.sessionItem.branchSession {
  position: relative;
}

.sessionItem.branchSession::before {
  display: none;
}
```

#### 毒点与危害：
1. **历史样式被灭活**：
   - 早期设计中本计划通过伪元素 `::before` 渲染树形分支连接线或分支圆点，但后续维护中开发者为了“解决某些对齐问题”，直接简单粗暴地写上了 `display: none;`；
   - 导致 `.branchSession` 变成了一个**完全没有任何实际视觉样式支持的空类名**；
   - 没有分支图标、没有微型徽章、没有左侧树枝连接线（`└─`），仅仅依靠前述的纯文本 `"分支: "`。

---

### 2.3 根因三：固定 28px 胶囊行高与极窄侧栏下的 Flex 宽度挤压灾难

查看 [`SessionRow.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx#L350-L410) 与 [`SidebarSessionList.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L260-L410) 的盒模型尺寸链条：

```
┌─────────────────────────────────── .sessionItem (总宽 ~200px ~ 240px, 高度固定 28px) ───────────────────────────────────┐
│ padding-left: 10px                                                                                     padding-right: 8px │
│ ┌──────────────────────── .sessionTextCol (flex: 1, min-width: 0) ────────────────────────┐ ┌── .sessionTrailing (44px) ──┐ │
│ │ ┌─────────────────── .sessionText (white-space: nowrap; ellipsis) ────────────────────┐ │ │ [ 7/23 ] / [ ··· 按钮 ]     │ │
│ │ │ "分支: 你好啊。分析一..."  (中文 "分支: " 独占 ~38px, 剩余仅剩 ~80px 供会话标题显示) │ │ │ (绝对定位/hover 切换)      │ │
│ │ └─────────────────────────────────────────────────────────────────────────────────────┘ │ │                           │ │
│ └─────────────────────────────────────────────────────────────────────────────────────────┘ └─────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 关键尺寸挤压计算：
- 侧边栏默认宽度：`220px` ~ `240px`；
- 容器外边距与折叠内边距：左 `10px` + 右 `10px` + `.folderSessions` 内边距 `10px` = **30px**；
- `.sessionItem` 内部内边距：`10px + 8px` = **18px**；
- 右侧 `.sessionTrailing` 锁死固定宽度：**44px**（用于放置 `7/23` 时间标签和 hover 触发的 `18px` 更多操作按钮）；
- **总可用标题宽度**：`220px - 30px - 18px - 44px = 128px`；
- **"分支: "** 文本（含全角冒号与空格）独占宽度：**~40px**；
- **最终留给用户真实会话标题的宽度**：`128px - 40px = 88px`（仅相当于 **6 个中文字符**！）；
- **结果**：原本正常的会话标题 `"你好啊。分析一下代码..."` 被极度压缩为 `"你好啊。分析一..."`，用户视觉感知上就是一个丑陋、突兀、字都没显示全的灰块按钮，误以为是“样式逃逸变形的按钮”。

---

### 2.4 根因四：平铺渲染导致树形父子层级结构断裂

在 [`useSessionGrouping.ts`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/useSessionGrouping.ts#L48-L79) 中：
- 分叉会话（`s.branchParentId` 存在）被当作与普通会话平级的扁平数组元素处理；
- 既没有被组织在父会话下级形成可折叠的树形子节点，也没有给予任何缩进或分支关联线；
- 当分叉会话穿插在常规会话之间时，由于缺乏视觉锚点与层级对齐，用户完全无法理解其与原会话的关系。

---

## 三、专项审计 2：`_metaLine_1qjwi_41` 冗余显示深度根因与证据链

### 3.1 编译类名与源码精确定位

用户反馈中提及的 `class='_metaLine_1qjwi_41'`，其哈希命名规则为 Vite / CSS Modules 对 `.metaLine` 类的编译产物。经静态扫描，该选择器位于 [`OverviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css#L21-L39)：

```css
/* apps/crish-desktop/src/components/overview/OverviewCard.module.css:21-39 */
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

其直接消费方为 [`OverviewHeader.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewHeader.tsx#L17-L33)：

```tsx
// apps/crish-desktop/src/components/overview/OverviewHeader.tsx:17-33
export const OverviewHeader: React.FC<OverviewHeaderProps> = React.memo(
  function OverviewHeader({ wsPath, session, onGoalClick }) {
    return (
      <>
        {wsPath ? (
          <div className={styles.metaLine} aria-label="会话状态">
            <Tooltip content={wsPath}>
              <span className={styles.metaChip}>{basename(wsPath)}</span>
            </Tooltip>
          </div>
        ) : null}

        <ProgressSection session={session} onGoalClick={onGoalClick} />
      </>
    );
  }
);
```

而在 [`OverviewCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx#L107-L121) 中：

```tsx
// apps/crish-desktop/src/components/overview/OverviewCard.tsx:107-121
const wsPath = getWorkspacePath();
...
<OverviewHeader
  wsPath={wsPath}
  session={session}
  onGoalClick={() => setOpenSec((p) => ({ ...p, activeTasks: true }))}
/>
```

---

### 3.2 为什么 `_metaLine_1qjwi_41` 严重多余？四大冗余证据

```
                                  【三重视觉位置重复】
   1. 顶栏 (TopBar)          ──▶ 常驻显示当前工作区切换器与工作区名称
   2. 侧栏底栏 (UserProfileCard) ──▶ 常驻显示当前工作区名 (.userWorkspace)
   3. 概览卡片底栏 (ChangesSection)──▶ 已显示 Git 分支与工作区状态
                                         │
                                         ▼
   【OverviewHeader 顶部】    ──▶ 孤立展示单个灰色字块 basename(wsPath) ❌ 完全多余！
```

1. **三重视觉位置完全重复**：
   - **全局顶栏 (`TopBar`)**：核心工作区切换下拉菜单已永久占据顶部第一视觉焦点，明确展示当前工作区；
   - **侧栏底栏 (`UserProfileCard.tsx:151-158`)**：用户个人名片中的 `.userWorkspace` 已常驻展示当前工作区目录名；
   - **概览面板底栏 (`ChangesSection.tsx:116-118`)**：已包含 Git 分支和工作区变更状态。
   - 在总览面板最顶层再孤零零放一个灰色的 `basename(wsPath)` 文本芯片，属于典型的无价值信息重复。
2. **语义虚标与 A11y 错误**：
   - `<div className={styles.metaLine} aria-label="会话状态">` 的 `aria-label` 声明为“会话状态”，但其子元素却仅仅是一个工作区文件夹名称（如 `conex`），内容与可访问性标签完全张冠李戴。
3. **交互价值为零**：
   - 该 chip 仅附带一个原样显示完整路径的 hover `<Tooltip>`，点击无任何跳转、无切换能力、无菜单弹出，纯粹占位。
4. **破坏概览卡片顶部视觉节奏**：
   - `.card` 设置了 `padding: 10px 12px 14px` 和 `gap: var(--space-2_5)`（10px）；
   - `.metaLine` 强行占用了顶部首行 ~24px 高度与 10px 下外间距，导致下方关键的 `ProgressSection`（活动任务目标、实时工具调用）被无谓下推，降低了侧边栏首屏的信息密度。

---

## 四、历史遗留毒点与代码坏味道归纳

| 模块 | 坏味道类型 | 具体代码片段 / 行为 | 重构整改原则 |
| :--- | :--- | :--- | :--- |
| **`SessionRow.tsx`** | 字符串污染与语义破坏 | `displayText = isBranched ? '分支: ' + ... : baseTitle` | 严禁将分支当做文本前缀拼接；应将分支作为结构化微图标/徽标 `<GitBranch size={12} />` 独立渲染，或采用缩进树结构。 |
| **`SidebarSessionList.module.css`** | 样式灭活与空类残留 | `.sessionItem.branchSession::before { display: none; }` | 移除无意义的 `display: none`；如需分支视觉提示，建立规范的微徽标样式 `.branchBadge` 或在标题前注入 `.branchIcon`。 |
| **`SidebarSessionList.module.css`** | 盒模型紧绷无容错 | 固定 `height: 28px` + 强行塞入右侧 `44px` 绝对定位层 | 规范 flex 列宽分配，确保标题区域拥有合乎规范的最小可读宽度，或优化 hover 操作按钮的占位策略。 |
| **`OverviewHeader.tsx`** | 冗余孤立 DOM 节点 | `{wsPath ? <div className={styles.metaLine}>...</div> : null}` | 彻底删除 `.metaLine` 容器与 `wsPath` 渲染，将 `ProgressSection` 作为概览顶部第一顺位。 |
| **`OverviewCard.module.css`** | 死 CSS 样式残留 | `.metaLine { ... }` / `.metaChip { ... }` | 伴随 `OverviewHeader` 瘦身，全量清理 `.metaLine` 与 `.metaChip` 废弃样式规则。 |
| **`OverviewCard.tsx`** | 无效 Prop 穿透 | `<OverviewHeader wsPath={wsPath} ... />` | 移除 `wsPath` 属性传递，简化组件契约。 |

---

## 五、彻底重构与修复设计规范（Blueprint）

### 5.1 侧栏分支会话规范化方案设计

#### 方案 A：精巧微徽标 / Git 分支图标（推荐，兼容现有单行 28px 极速列表）

1. **结构分离**：
   在 `SessionRow.tsx` 中，不再篡改 `displayText`，保持 `baseTitle` 原貌：
   ```tsx
   // 修复后伪代码
   const baseTitle = sessionListDisplayTitle(s);
   const displayText = baseTitle.replace(/ - 分支$/, ''); // 剥离历史落盘脏后缀
   ```
2. **渲染微图标 / 徽章**：
   在 `.sessionTextCol` 内部，若 `isBranched` 为 true，渲染紧凑图标或微胶囊：
   ```tsx
   <Tooltip content={isBranched ? `分支会话：${displayText}` : displayText}>
     <span className={styles.sessionTextCol}>
       {isBranched && (
         <span className={styles.branchBadge} aria-label="分支会话">
           <GitBranch size={11} strokeWidth={2} className={styles.branchIcon} aria-hidden />
         </span>
       )}
       <span className={styles.sessionText}>{displayText}</span>
     </span>
   </Tooltip>
   ```
3. **CSS 样式保障**：
   ```css
   .branchBadge {
     display: inline-flex;
     align-items: center;
     justify-content: center;
     flex-shrink: 0;
     margin-right: var(--space-1);
     color: var(--text-tertiary);
   }

   .branchBadge .branchIcon {
     color: var(--accent-primary, #6366f1);
     opacity: 0.85;
   }
   ```
4. **效益**：
   - 宽度占用从原本文字 `"分支: "` 的 `~40px` 大幅缩减至图标的 `14px`；
   - 标题留白大幅提升 `+26px`，会话名清晰可辨，彻底杜绝文字重叠挤压变形感；
   - 视觉形态专业现代化，符合 IDE / Git 分支的标准心智模型。

---

### 5.2 `_metaLine` 彻底隐藏与移除规范

#### 1. 净化 `OverviewHeader.tsx`
直接将孤立的 `wsPath` 判断与 `.metaLine` 移除，保持 `OverviewHeader` 仅负责进度与目标分发：

```tsx
// 改造后 OverviewHeader.tsx
export interface OverviewHeaderProps {
  session?: SessionState | undefined;
  onGoalClick?: (() => void) | undefined;
}

export const OverviewHeader: React.FC<OverviewHeaderProps> = React.memo(
  function OverviewHeader({ session, onGoalClick }) {
    return <ProgressSection session={session} onGoalClick={onGoalClick} />;
  }
);
```

#### 2. 清理 `OverviewCard.module.css`
彻底删除 L21-L39 中的 `.metaLine` 与 `.metaChip` 规则，消除死代码。

#### 3. 简化 `OverviewCard.tsx` 调用
```tsx
// 改造后 OverviewCard.tsx
<OverviewHeader
  session={session}
  onGoalClick={() => setOpenSec((p) => ({ ...p, activeTasks: true }))}
/>
```

---

## 六、受影响文件与测试回归检查矩阵

| 序号 | 目标文件 | 变更性质 | 关联测试与验证点 |
| :--- | :--- | :--- | :--- |
| 1 | [`apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/SessionRow.tsx) | 结构重构 | `SessionRow.test.tsx`<br>- 验证分支会话是否正确渲染分支图标/徽章而非生硬字符串<br>- 验证标题截断与 tooltip 内容完整性 |
| 2 | [`apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css) | 样式修复 | `SidebarContextMenus.test.ts`<br>- 验证 `.branchBadge` / `.branchIcon` 尺寸与 flex 伸缩<br>- 验证暗色/亮色模式下图标色彩与 hover 态 |
| 3 | [`apps/crish-desktop/src/components/overview/OverviewHeader.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewHeader.tsx) | 节点移除 | `OverviewGitTree.test.tsx` / `OverviewCard.tsx`<br>- 验证 `_metaLine` DOM 节点彻底消失<br>- 验证 `ProgressSection` 作为顶部首项时间距自然 |
| 4 | [`apps/crish-desktop/src/components/overview/OverviewCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.module.css) | 死代码清理 | - 确认 `.metaLine`、`.metaChip` 类名无残留，CSS 产物体积瘦身 |
| 5 | [`apps/crish-desktop/src/components/overview/OverviewCard.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewCard.tsx) | Prop 瘦身 | 验证编译通过与 props 契约精简 |

---

## 七、审计结论与执行建议

1. **侧边栏分支问题根因**：并非用户误触或动态逻辑崩溃，而是**以文本字符串拼接冒充 UI 分支指示器**、**`.branchSession::before` 样式被粗暴抹除**以及**极窄容器内 Flex 宽度被 `"分支: "` 严重挤压**三者叠加引发的严重视觉劣化。
2. **`_metaLine` 冗余根因**：属于早期原型期残存的孤立组件遗留，未随全局设计规范演进及时清理，导致与全局 TopBar / 侧栏名片三重信息重复并虚假占用首屏黄金位置。
3. **执行原则**：严禁在现有字符串拼接上继续打补丁，必须按照本报告 §5 Blueprint 方案彻底将分支标识组件化、将冗余 `_metaLine` 连根拔起。
