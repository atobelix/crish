# DIM-04 专项分析报告：色彩角色、排版节奏与焦点无障碍

> **战役代号**：`UI-UNIFICATION-REDESIGN`  
> **归属维度**：`DIM-04`（色彩角色、排版节奏与焦点无障碍）  
> **核心规范依据**：
> - `C:\Software\conex\skill\design\jakub-skills\skills\better-colors`（“Fill exactly one action per view”、色相保持、语义角色分层）
> - `C:\Software\conex\skill\design\jakub-skills\skills\better-typography`（“Tabular numbers on changing values”、Properties over raw tags）
> - `C:\Software\conex\skill\design\jakub-skills\skills\better-accessibility`（Accessible names everywhere、Focus Ring、WCAG 2.5.8 与 ARIA APG）
> - 仓库总规 `AGENTS.md` §13（焦点混入 3%~10% 克制浅灰环，杜绝生硬黑框与重阴影）
> - `docs/ui-unification-redesign/00-战役调度总纲与工作区规范.md`

---

## 一、概述与核心设计原则内化

DIM-04 维度的核心使命是消除界面的**视觉喧嚣、跳动不稳定与键盘操作断层**，通过对齐工程级现代 UI 设计规范，实现产品界面的“宁静、精准与包容”：

1. **色彩角色与单一真源（Color Roles & Single Action Fill）**：
   - 遵循 `better-colors` 铁律：“Fill exactly one action per view（一屏仅一个主操作实心填充）”。实心翡翠绿（Primary Solid）用于最高权重的推进性动作，平级操作必须降级为微边框实体纸片（Secondary）或纯透明（Ghost）。
   - 杜绝“一色多意”与“一意多值”：消除翡翠绿（160°）与生绿（142°）的杂糅漂移，根除局部使用纯黑（#111111）冒充 Primary 的分裂实现。
2. **排版节奏与防抖动等宽数字（Tabular Numbers on Changing Values）**：
   - 遵循 `better-typography` 铁律：所有随时间、状态、交互实时变动的数值（耗时显示、Token 用量、价格费用、未读计数、排队索引、行数统计等），必须强制注入 `font-variant-numeric: tabular-nums`，消除非等宽数字变动导致的文本抖动与容器几何拉扯。
   - 优先使用 CSS 属性而非底层 OpenType 标签（`font-variant-numeric: tabular-nums` 优于 `font-feature-settings: "tnum" 1`）。
3. **克制柔和焦点环（Restrained Focus Ring）**：
   - 严格执行 `AGENTS.md` §13：焦点态 relative to baseline 混入文本色仅 **3%~10%**（常规元素优先 3%~6%，空态至多 5%），构建柔和浅灰环；
   - 彻底消灭 `outline: none` 无视觉替代的“焦点隐形”漏洞；根除粗黑实线、厚重发光框及违规彩色光晕。
4. **无障碍语义与键盘漫游（ARIA APG & Accessible Names）**：
   - 遵循 `better-accessibility` 规范：所有纯图标按钮（Icon-only Button）必须具有明确的 `aria-label`；所有纯视觉装饰性图标（Lucide 图标/内联 SVG）必须声明 `aria-hidden="true"`；
   - 核心复合组件（Tabs、下拉菜单、列表）必须提供 ARIA APG 标准的键盘导航支持（Escape 关闭、Arrow 键漫游、Roving Tabindex）。

---

## 二、工程现状核心缺陷排查与代码证据

经对 `apps/crish-desktop/src/` 的系统性静态 AST 与代码深度排查，梳理出以下四大核心缺陷及确凿代码证据：

### 缺陷 1：多主色冲突与主操作未降级（违背 “Fill exactly one action per view”）

在当前前端工程中，存在多处“一屏多主色”、同一视图内列表项并排滥用 Primary 实体填充，以及组件样式被外部私有 CSS 破坏的违规现象：

#### 证据 1.1：Diff 变更文件列表每个文件条目滥用 `variant="primary"`，且被外部 CSS 暴力覆盖
- **文件与行号**：[`DiffCardFileList.tsx:293-306`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardFileList.tsx#L293-L306) 与 [`DiffCard.module.css:430-456`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L430-L456)
- **代码现状**：
  ```tsx
  // DiffCardFileList.tsx:293-306
  <Tooltip content={acceptLabel}>
    <Button
      type="button"
      variant="primary"
      size="sm"
      className={`${styles.inlineActionBtn} ${styles.inlineActionAccept}`}
      aria-label={acceptLabel}
      disabled={applyBusy || !classifyFileDiff(f).ok}
      onClick={(e) => { e.stopPropagation(); void onAcceptFile(f); }}
      icon={<Lucide.Check size={14} aria-hidden />}
    />
  </Tooltip>
  ```
  ```css
  /* DiffCard.module.css:430-456 */
  .inlineActionBtn {
    background: transparent; /* 暴力覆盖原子 Button 的实心主强调色 */
    color: var(--text-secondary);
  }
  .inlineActionAccept:hover:not(:disabled) {
    background: var(--accent-green-light-adaptive);
    color: var(--accent-green);
    border-color: var(--accent-green);
  }
  ```
- **核心问题**：
  1. 若该 CSS 覆盖失效，当 Diff 列表中有 20 个变更文件时，界面将呈现 20 个耀眼的实心翠绿 `primary` 按钮，严重产生多主色轰炸；
  2. 传入 `variant="primary"` 却在外部 CSS 中强制改成透明并在 hover 时染绿，彻底击穿了原子 `<Button>` 的组件契约，将强调色当成了链接/文本颜色。

#### 证据 1.2：待处理审批列表内循环渲染多个实心 Primary 按钮
- **文件与行号**：[`ActiveTasksSection.tsx:82-90`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/ActiveTasksSection.tsx#L82-L90)
- **代码现状**：
  ```tsx
  // ActiveTasksSection.tsx:82-90
  {pendingApprovals.map((a, i) => (
    <li key={a.toolCallId || i} className={styles.actionRow}>
      ...
      <div className={styles.rowActions}>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={Boolean(approvalBusyId)}
          onClick={(e) => onApprovalAllow(a, e)}
        >
          {busy ? '…' : '允许'}
        </Button>
        <Button type="button" variant="ghost" size="sm" ...>拒绝</Button>
      </div>
    </li>
  ))}
  ```
- **核心问题**：当多个工具等待授权时，单卡片纵向排布多排实心绿色“允许”按钮，视觉权重分散。条目级操作应为 Secondary 纯白卡片或 Ghost，顶部提供唯一的“全部允许”实心主操作。

#### 证据 1.3：`ModernApprovalCard` 裸写纯黑实体按钮，破坏系统品牌色
- **文件与行号**：[`ModernApprovalCard.tsx:40-54`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernApprovalCard.tsx#L40-L54) 与 [`ModernToolCall.module.css:507-516`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L507-L516)
- **代码现状**：
  ```css
  /* ModernToolCall.module.css:507-513 */
  .approvalBtnPrimary {
    border: none;
    font-weight: 600;
    background: var(--text-primary, #111111); /* 纯黑实体填充！ */
    color: var(--bg-card, #ffffff);
  }
  ```
- **核心问题**：在其他所有卡片中 Primary 均为翠绿（`--brand`），此处竟私自裸写 `<button className={styles.approvalBtnPrimary}>` 并填充 `#111111` 纯黑底！不仅造成色彩语义断裂，而且裸写标签完全缺失原子 Button 的焦点无障碍机制。

#### 证据 1.4：批量审批条把 Primary 按钮外层覆盖成描边弱化样式
- **文件与行号**：[`ChatToolCallBlock.tsx:89-98`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.tsx#L89-L98) 与 [`ChatToolCallBlock.module.css:294-323`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L294-L323)
- **代码现状**：
  ```css
  /* ChatToolCallBlock.module.css:294-322 */
  .batchBarBtn {
    border: 1px solid var(--border-subtle);
    background: var(--bg-primary); /* 覆盖了原子 primary 绿底 */
  }
  .batchBarApprove {
    color: var(--accent-green);
    border-color: color-mix(in srgb, var(--accent-green) 40%, transparent);
  }
  ```
- **核心问题**：批量操作栏是该区域的真正主操作（Primary Action），本应以唯一的 Solid Fill 呈现，却被私有 CSS 覆盖成描边绿字，导致主操作反被弱化，与次操作“拒绝”混在一起。

#### 证据 1.5：首次运行向导（FirstRunWizard）私有类覆盖并破坏几何规范
- **文件与行号**：[`FirstRunWizard.tsx:265-277`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.tsx#L265-L277) 与 [`FirstRunWizard.module.css:204-227`](file:///c:/Software/conex/apps/crish-desktop/src/components/overlay/FirstRunWizard.module.css#L204-L227)
- **代码现状**：
  ```css
  .firstRunBtn {
    border-radius: var(--radius-xl); /* 破坏 7px 几何标尺 */
    font-size: var(--font-size-base);
  }
  .firstRunBtn.primary {
    background: var(--brand-deep, hsl(160 84% 30%)); /* 私自覆盖加深 */
    border-color: var(--brand-primary, hsl(160 84% 39%));
  }
  ```

---

### 缺陷 2：动态数字抖动（缺失 `font-variant-numeric: tabular-nums`）

随系统运行跳动的高频变化数字，如果使用默认比例字体（Proportional Numbers），由于数字 `1`、`0`、`8` 的字符宽度不一致，会造成父容器宽度持续拉扯、表格列无法对齐、右侧文字像“心跳”一样左右横移。

经排查，以下 16 处核心动态数值展示点**严重缺失** `font-variant-numeric: tabular-nums`：

| 序号 | 组件 / 模块 | 文件与行号 | 动态跳动内容描述 | 缺失类名 / 节点 | 现状风险 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **模型价格配置表** | [`PriceConfigModal.module.css:34, 72`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/PriceConfigModal.module.css#L34) | 输入/展示模型的单价（如 `$0.150`, `$0.600`） | `.tableRow`, `.colCell` | 小数点与多行价格列参差不齐，上下抖动 |
| 2 | **侧边栏会话时间** | [`SidebarSessionList.module.css:450`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L450) | 会话时间戳（如 `14:32`, `昨天`, `09-04`） | `.sessionTime` | 时间数字变化导致右侧边缘与悬浮操作错位 |
| 3 | **子代理面包屑状态** | [`SubagentHeaderPanel.module.css:60`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css#L60) | 实时子代理数（如 `1 个运行中`、`12 个子代理`） | `.triggerText, .bcAgentText` | 随任务派发数量变动，顶栏胶囊宽度频繁抽动 |
| 4 | **Diff 增删行数统计** | [`DiffCard.module.css:286`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L286) | 文件变更行数（如 `+128 -42`） | `.fileStat` | 仅有 mono 字体但无 tabular-nums，在不同字体族回退下数字抖动 |
| 5 | **工具执行差异统计** | [`ChatToolCallBlock.module.css:245`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L245) | 工具调用增删行统计（如 `+14 -5`） | `.diffStats` | 仅设 font-mono，数字位宽不锁死 |
| 6 | **模型扫描结果统计** | [`ScanResultsModal.module.css:135`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ScanResultsModal.module.css#L135) | 勾选统计（如 `共 45 个模型 · 已选 12 项`） | `.footerCount` | 勾选时数值频繁变动，底栏文字跳动 |
| 7 | **Yaml 配置编辑器底栏** | [`YamlConfigEditorModal.module.css:144`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css#L144) | 代码行数信息（如 `共 128 行`） | `.toolbarInfo` | 输入代码时行数变动引发抖动 |
| 8 | **Yaml 编辑器行号栏** | [`YamlConfigEditorModal.module.css:172`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/YamlConfigEditorModal.module.css#L172) | 行号数字（`1, 2, ... 999`） | `.gutterLine` | 行号未锁等宽，代码行对齐存在微像素偏差 |
| 9 | **模型网络延迟徽标** | [`ModelsSettingsTab.module.css:460`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css#L460) | Ping 延迟数据（如 `42ms`, `380ms`） | `.mrdLatencyBadge` | 测速刷新时徽标忽宽忽窄 |
| 10 | **消息排队队列序号** | [`ChatQueuePanel.module.css:25`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatQueuePanel.module.css#L25) | 队列索引序号（如 `1, 2, 3`） | `.index` | 两位数与一位数序号圆心视觉偏离 |
| 11 | **终端镜像行数统计** | [`TerminalCard.module.css:109`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TerminalCard.module.css#L109) | 终端输出行数统计 | `.mirrorCount` | 流式输出行数暴涨时界面抖动 |
| 12 | **终端搜索匹配统计** | [`TerminalCard.module.css:365`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TerminalCard.module.css#L365) | 终端搜索计数（如 `3 / 15`） | `.searchCount` | 搜索高亮跳转时数字跳脱 |
| 13 | **技能面板统计计数** | [`SkillsSettingsTab.module.css:21, 197`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L21) | 技能统计（如 `已启用 14 个 / 共 28 个`） | `.skillsHeadStats, .skillsStats` | 开关切换时统计文字跳动 |
| 14 | **定时任务执行计数** | [`ScheduledTasksPanel.module.css:50`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/ScheduledTasksPanel.module.css#L50) | 定时任务在聊触发计数 | `.schedInChatCount` | 触发时计数变动抖动 |
| 15 | **原子 Badge 基础类** | [`Badge.module.css:6`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.module.css#L6) | 通用原子角标中的数字内容 | `.badge` | 作为原子基础组件未注入等宽特性 |
| 16 | **标签页角标计数** | [`Tabs.module.css:257`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tabs/Tabs.module.css#L257) | Tab 上的未读/待办数字角标 | `.triggerBadge` | 数量变化导致 Tab 宽度跳变 |

---

### 缺陷 3：焦点环规范偏离与生硬黑框（对标 AGENTS.md §13）

仓库根目录 `AGENTS.md` §13 严格裁决：
> “克制的激活边框：输入或按钮处于 active / focused / recording 时，**禁止**粗、深、实心黑边（例如直接用 var(--text-primary) 或厚重 0 0 0 1px 黑环）。边框应只比组件背景略深/略灰，足以勾勒激活区，焦点变化须可见但柔软（相对基线灰色加深混入文本色不超过约 10%，常规元素优先 3%~6% 混入以保持柔软）。”

排查发现，当前工程在焦点呈现上存在以下显著问题：

#### 证据 3.1：直接使用 `outline: none` 抹除焦点环且零视觉替代（极高危无障碍故障）
- **文件与行号**：[`FileEditor.module.css:17-19`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileEditor.module.css#L17-L19)
  ```css
  .editor:focus-visible {
    outline: none; /* 没有任何替代样式，键盘用户完全丢失焦点！ */
  }
  ```
- **文件与行号**：[`SubagentHeaderPanel.module.css:16`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css#L16)
  ```css
  .agentTrigger, .breadcrumbAgentBtn {
    outline: none; /* 无 :focus-visible 声明，Tab 键导航时隐形 */
  }
  ```
- **文件与行号**：[`ModernToolCall.module.css:483`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ModernToolCall.module.css#L483)
  ```css
  .approvalBtn {
    outline: none; /* 同样无 :focus-visible 声明 */
  }
  ```

#### 证据 3.2：输入框聚焦使用高饱和翡翠绿光晕，违背克制浅灰原则
- **文件与行号**：[`DiffCard.module.css:763-768`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L763-L768)
  ```css
  .commitInput:focus-visible,
  .commitInput:focus {
    outline: none;
    border-color: var(--brand, hsl(160 84% 39%));
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--brand, hsl(160 84% 39%)) 25%, transparent);
  }
  ```
  - **违规根因**：常规输入框不应在聚焦时变成彩色探照灯，强光晕在深色模式和浅色模式下均会造成视疲劳，应回归 6%~10% 的中性浅灰微边框。

#### 证据 3.3：行内重命名输入框使用高对比绿色硬实线
- **文件与行号**：[`SidebarSessionList.module.css:545`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css#L545)
  ```css
  .sessionItem.isRenaming {
    outline: 1.5px solid var(--accent-primary); /* 刺眼绿框硬实线 */
  }
  ```

#### 证据 3.4：多处硬编码私有焦点阴影与粗框
- **文件与行号**：[`ChatHeaderMore.module.css:48-50`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatHeaderMore.module.css#L48-L50)
  ```css
  .moreBtn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--sep-border-focus, #b2ada2); /* 2px 硬编码，未与全局 Token 对齐 */
  }
  ```

---

### 缺陷 4：无障碍名称缺失与键盘漫游缺陷（ARIA APG 违规）

#### 证据 4.1：纯图标按钮严重缺失 `aria-label`（屏幕阅读器无法识别操作意图）
经静态扫描，全工程共发现 **21 处** 纯图标按钮裸写或未声明 `aria-label`：
1. [`PermissionModeMenu.tsx:139`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx#L139) - 权限模式切换触发按钮只有图标，无 `aria-label`；
2. [`InjectionHeader.tsx:76`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/InjectionHeader.tsx#L76) - 注入信息折叠/展开按钮无 `aria-label`；
3. [`FileBreadcrumb.tsx:303`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx#L303) - 面包屑下拉菜单展开按钮无 `aria-label`；
4. [`FileBreadcrumb.tsx:442`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FileBreadcrumb.tsx#L442) - 面包屑后退按钮无 `aria-label`；
5. [`SendToNoteButton.tsx:163`](file:///c:/Software/conex/apps/crish-desktop/src/components/note-paper/SendToNoteButton.tsx#L163) - 发送至便签图标按钮无 `aria-label`；
6. [`OverviewChangesList.tsx:87`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/OverviewChangesList.tsx#L87) - 变更文件条目展开按钮无 `aria-label`；
7. [`ModelBadgePickerMenu.tsx:208`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx#L208) - 模型选择下拉按钮无 `aria-label`；
8. [`FontSelectField.tsx:266, 317, 354`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.tsx#L266) - 字体配置项增减/重置按钮无 `aria-label`；
9. [`SettingsDevicesNetworkEnv.tsx:95`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsDevicesNetworkEnv.tsx#L95) - 网络环境检测刷新按钮无 `aria-label`；
10. [`SelectTrigger.tsx:130`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Select/SelectTrigger.tsx#L130) - 自定义 Select 清除按钮无 `aria-label`。

#### 证据 4.2：装饰性图标严重缺失 `aria-hidden="true"`（超过 200 处）
在诸如 [`LeafToolTabStrip.tsx:312`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.tsx#L312)、[`PaneHeader.tsx:326`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.tsx#L326)、[`SubagentHeaderPanel.tsx:92-109`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.tsx#L92-L109)、[`ProjectPickerMenu.tsx:149`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.tsx#L149) 中，大量 Lucide 矢量图标 `<Plus size={13} />`、`<Bot size={14} />`、`<Trash2 size={12} />` 裸写，未标记 `aria-hidden="true"`。屏幕阅读器遇到这些 SVG 标签会读出未翻译的标签名或字符噪音。

#### 证据 4.3：侧边栏与核心列表缺少 ARIA APG 键盘漫游
侧边栏会话列表 [`SidebarSessionList.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarSessionList.module.css) 中的 `.sessionItem` 未实现 Roving Tabindex（仅聚焦项为 `tabIndex=0`，其余为 `-1`），且缺少上下方向键切换焦点的键盘监听，键盘用户必须按几十次 Tab 键才能穿透整个会话列表。

---

## 三、系统性改进方案与实施细则

### 1. 统一色彩语义角色表（Semantic Color Roles Matrix）

依据 `better-colors`（Primitives by hue, semantics by role）理念，收敛混乱的 `accent-*` 变量，建立正交的色彩语义角色真源：

```css
/* ==========================================================================
   DIM-04 统一色彩语义角色真源 (Semantic Color Roles SSOT)
   ========================================================================== */
:root {
  /* 1. 品牌活态与最高强调色 (Brand & Interactive Primary)
     色相锁定 160°，纯正翡翠绿，杜绝与 142° 鲜绿并存漂移 */
  --brand: hsl(160 84% 39%);
  --brand-hover: hsl(160 84% 34%);
  --brand-active: hsl(160 84% 30%);
  --brand-subtle: hsl(160 84% 39% / 0.12); /* 悬浮浅底/胶囊浅底 */
  --text-on-brand: #ffffff;

  /* 2. 交互控件语义分层 (Action Hierarchy)
     严格遵循：一屏仅 1 个 primary solid，同行次要操作保持纸片/透明 */
  --action-primary-bg: var(--brand);
  --action-primary-fg: var(--text-on-brand);
  --action-secondary-bg: var(--bg-card); /* 纯白卡片纸片感 */
  --action-secondary-border: var(--border-color);
  --action-ghost-hover: var(--tint-hover);

  /* 3. 状态语义色阶 (Status Ramps) - 仅限表示系统状态，绝不用于操作按钮主色 */
  --status-success: hsl(152 68% 40%);
  --status-warning: hsl(38 92% 50%);
  --status-error: hsl(0 68% 54%);
  --status-info: hsl(205 78% 46%);
}
```

#### 主操作降级与治理规则（“Fill exactly one action per view” 规则树）：
1. **列表 / 表格行级操作**：
   - 规则：**禁止在列表的每一行使用 Primary Solid 填充**。
   - 改动：`DiffCardFileList` 的行级“接受”按钮、`ActiveTasksSection` 的单项“允许”按钮，统一降级为 `variant="ghost"`（透明底 + 图标，悬停时微弱底色）；
   - 强调点移至容器级：在列表顶部或底部提供唯一的 `variant="primary"` 按钮（如“暂存并提交全部”、“全部批准”）。
2. **弹窗与模态对话框（Modal / Dialog）**：
   - 规则：每个 Dialog 的 `footer` **有且仅有 1 个 Primary 实体填充按钮**；
   - 结构：`[次操作 / 取消 (variant="secondary" 或 "ghost")]` + `[主操作 / 确认 (variant="primary")]`；
   - 危险操作弹窗（如删除会话、清空全部）：主操作为 `variant="danger"`，但背景仍保持克制或描边，取消按钮保持 `secondary`。
3. **消除私有覆盖**：
   - 全面清理 `DiffCard.module.css:430`、`ChatToolCallBlock.module.css:294`、`FilesCard.module.css:443`、`FirstRunWizard.module.css:204` 等中对 `<Button>` 的私有 `background: transparent` 或强制覆盖，恢复原子 Button 的单一真理。

---

### 2. 动态数值 Tabular-nums 加固清单

为根除跳动数字抖动，在 `src/styles/tokens.css` 或通用样式层建立全局等宽数字工具类，并对排查出的 16 处缺陷点全量加固：

#### 2.1 全局原子类与 CSS 混合宏
```css
/* tokens.css 或 design-system.css */
.tabular-nums,
[data-tabular-nums='true'] {
  font-variant-numeric: tabular-nums;
  -webkit-font-feature-settings: 'tnum' 1;
  font-feature-settings: 'tnum' 1;
}
```

#### 2.2 16 处核心缺失点加固修正清单
1. **PriceConfigModal.module.css**：
   ```css
   .tableRow, .colCell {
     font-variant-numeric: tabular-nums;
   }
   ```
2. **SidebarSessionList.module.css**：
   ```css
   .sessionTime, .branchBadge {
     font-variant-numeric: tabular-nums;
   }
   ```
3. **SubagentHeaderPanel.module.css**：
   ```css
   .triggerText, .bcAgentText {
     font-variant-numeric: tabular-nums;
   }
   ```
4. **DiffCard.module.css**：
   ```css
   .fileStat {
     font-variant-numeric: tabular-nums;
   }
   ```
5. **ChatToolCallBlock.module.css**：
   ```css
   .diffStats {
     font-variant-numeric: tabular-nums;
   }
   ```
6. **ScanResultsModal.module.css**：
   ```css
   .footerCount {
     font-variant-numeric: tabular-nums;
   }
   ```
7. **YamlConfigEditorModal.module.css**：
   ```css
   .toolbarInfo, .gutterLine {
     font-variant-numeric: tabular-nums;
   }
   ```
8. **ModelsSettingsTab.module.css**：
   ```css
   .mrdLatencyBadge {
     font-variant-numeric: tabular-nums;
   }
   ```
9. **ChatQueuePanel.module.css**：
   ```css
   .index {
     font-variant-numeric: tabular-nums;
   }
   ```
10. **TerminalCard.module.css**：
    ```css
    .mirrorCount, .searchCount {
      font-variant-numeric: tabular-nums;
    }
    ```
11. **SkillsSettingsTab.module.css**：
    ```css
    .skillsHeadStats, .skillsStats {
      font-variant-numeric: tabular-nums;
    }
    ```
12. **ScheduledTasksPanel.module.css**：
    ```css
    .schedInChatCount {
      font-variant-numeric: tabular-nums;
    }
    ```
13. **Badge.module.css**：
    ```css
    .badge {
      font-variant-numeric: tabular-nums;
    }
    ```
14. **Tabs.module.css**：
    ```css
    .triggerBadge {
      font-variant-numeric: tabular-nums;
    }
    ```
15. **UsageTrendChart.module.css**：
    ```css
    .axisTick {
      font-variant-numeric: tabular-nums;
    }
    ```
16. **FlowScrubber.module.css**：
    ```css
    .tick, .tickSlot {
      font-variant-numeric: tabular-nums;
    }
    ```

---

### 3. 焦点环设计系统重塑方案（严格对齐 AGENTS.md §13）

为终结“黑框、粗边、彩色光晕与焦点隐形”，构建全工程统一的柔和 Focus Ring 规范：

#### 3.1 核心 Token 规范公式（3%~10% 混入）
```css
/* tokens.css */
:root {
  /* 基础微灰焦点环：文本色混入 6%（常规控件 SSOT） */
  --focus-ring-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
  /* 焦点激活边框：文本色混入 10%（上限死锁） */
  --focus-border-color: color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%);
  /* 标准焦点阴影环 (1.5px 柔和微外圈) */
  --focus-ring-shadow: 0 0 0 1.5px var(--focus-ring-color);
}
```

#### 3.2 全局与控件级样式纠偏方案
1. **全局 focus-visible.css 修正**：
   ```css
   /* focus-visible.css */
   :focus:not(:focus-visible) {
     outline: none;
     box-shadow: none;
   }

   :focus-visible {
     outline: 1.5px solid var(--focus-border-color);
     outline-offset: 1px;
   }

   /* 按钮与交互条目：采用外阴影微环，消除 outline 对圆角的几何裁切 */
   button:focus-visible,
   [role='button']:focus-visible,
   [tabindex]:not([tabindex='-1']):focus-visible {
     outline: none;
     border-color: var(--focus-border-color);
     box-shadow: var(--focus-ring-shadow);
   }

   /* 输入框与文本域：outline-offset 内缩 1px，保持边框贴合 */
   input:focus-visible,
   textarea:focus-visible {
     outline: none;
     border-color: var(--focus-border-color);
     box-shadow: var(--focus-ring-shadow);
   }
   ```
2. **根除违规点**：
   - 移除 `FileEditor.module.css:18` 中的 `.editor:focus-visible { outline: none; }`，恢复编辑区柔和内阴影焦点指示；
   - 将 `DiffCard.module.css:766` 的 `.commitInput:focus` 中的翡翠绿光晕（`border-color: var(--brand)`）替换为中性柔和焦点边框 `var(--focus-border-color)`；
   - 将 `SidebarSessionList.module.css:545` 的 `.sessionItem.isRenaming` 中的硬实线翠绿边框换装为同心柔和框；
   - 为 `.sessionItem` 会话卡片补充 `:focus-visible` 样式。

---

### 4. 无障碍 APG 与 Accessible Name 改造标准

#### 4.1 纯图标按钮强制 aria-label
- 所有调用 `<button>` 或 `<Button>` 且仅包含图标的场景，必须具备直观、本地化的 `aria-label`；
- 首选方案：将业务组件内的裸写图标 `<button>` 统一重构为原子 `<IconButton>`（已在 TypeScript 类型层面强制要求 `aria-label: string`）。
- **待修正代码示例**：
  ```tsx
  // 修正前：PermissionModeMenu.tsx:139
  <button type="button" className={styles.permPill} onClick={...}>
    <Lucide.Shield size={14} />
  </button>

  // 修正后：使用 IconButton 或补充 aria-label
  <button
    type="button"
    className={styles.permPill}
    aria-label="切换执行权限模式"
    onClick={...}
  >
    <Lucide.Shield size={14} aria-hidden="true" />
  </button>
  ```

#### 4.2 装饰性图标统一注入 `aria-hidden="true"`
- 凡是伴随文字标签的图标、或已在父级提供 `aria-label` 的按钮内部图标，一律显式声明 `aria-hidden="true"`（或 `aria-hidden`）；
- 杜绝屏幕阅读器在朗读按钮时产生重复、非预期朗读。

#### 4.3 侧边栏与列表 ARIA APG 键盘漫游
- 会话列表容器声明 `role="listbox"` 或 `role="tablist"`，列表项声明 `role="option"` 或 `role="tab"`；
- 实施 Roving Tabindex：仅当前激活或聚焦的会话具有 `tabIndex={0}`，其余会话为 `tabIndex={-1}`；
- 绑定 `onKeyDown` 键盘监听：
  - `ArrowDown`：焦点平滑下移至下一个会话；
  - `ArrowUp`：焦点平滑上移至上一个会话；
  - `Home` / `End`：快速直达列表首尾；
  - `Delete`：快速唤起会话删除确认。

---

## 四、实施清单、删除面与纠正清单（强制负产出）

依据战役纪律与反退避要求，本维度通过**彻底删除私有死层、拔除裸写与冗余覆盖**，实现代码资产净收敛：

### 1. 强制删除面清单（代码净消减目标）

| 删除目标文件 | 删除代码位置 / 规则 | 删除原因与代际退役说明 |
| :--- | :--- | :--- |
| `DiffCard.module.css` | 删去 `.inlineActionBtn` 与 `.inlineActionAccept` 中对 Button 的 `background: transparent` 覆盖代码（约 20 行） | 消除对原子 Button 的私有暴力覆盖，行内改走 `variant="ghost"` |
| `ChatToolCallBlock.module.css` | 删去 `.batchBarBtn` 与 `.batchBarApprove` 中弱化 Button 的描边覆盖代码（约 25 行） | 恢复批量主操作的单一 Solid Fill 权威表现 |
| `FilesCard.module.css` | 删去 `.filesSoftBtn`、`.filesSoftBtnEmphasis` 私有按钮样式（约 35 行） | 彻底使用原子 `<Button variant="primary">` 与 `<Button variant="secondary">` 代替 |
| `FirstRunWizard.module.css` | 删去 `.firstRunBtn`、`.firstRunBtn.primary`、`.firstRunBtn.ghost`、`.firstRunBtn.secondary`（约 38 行） | 拔除向导内裸写的私有按钮类名与失控的 `radius-xl` |
| `ModernToolCall.module.css` | 删去 `.approvalBtnPrimary`（纯黑按钮）、`.approvalBtnGhost`、`.approvalBtnSecondary`（约 45 行） | 根除私有分裂的 `#111111` 纯黑按钮实现 |
| `FileEditor.module.css` | 删去 `.editor:focus-visible { outline: none; }` 声明 | 根除焦点完全隐形的严重无障碍隐患 |
| `SidebarSessionList.module.css` | 删去 `.sessionItem.isRenaming` 中的 `outline: 1.5px solid var(--accent-primary);` | 消除重命名时刺眼的绿色硬线框 |

### 2. 纠正与加固清单（Refactor & Solidify）

1. **多主色降级纠偏**：
   - `DiffCardFileList.tsx:295`：行级“接受”按钮由 `variant="primary"` 纠正为 `variant="ghost"`；
   - `ActiveTasksSection.tsx:84`：列表行级“允许”按钮由 `variant="primary"` 纠正为 `variant="secondary"`；
   - `ModernApprovalCard.tsx:40-54`：裸写 `<button>` 彻底重构替换为原子 `<Button variant="primary">` 与 `<Button variant="danger">`。
2. **Tabular-nums 注入**：
   - 按照第三节第 2 节的 16 处加固清单，依次为 `PriceConfigModal`、`SidebarSessionList`、`SubagentHeaderPanel`、`DiffCard`、`ChatToolCallBlock` 等补齐 `font-variant-numeric: tabular-nums`。
3. **焦点环对齐**：
   - 按照 AGENTS.md §13，将 `DiffCard.module.css` 输入框聚焦的高饱和绿光晕替换为 6%~10% 的克制柔和灰环；为 `SidebarSessionList` 会话项注入标准 `:focus-visible` 样式。
4. **无障碍增强**：
   - 补齐 21 处纯图标按钮的 `aria-label`；
   - 为 200+ 处装饰性 Lucide 图标批量注入 `aria-hidden="true"`。

---

## 五、总结与后续方案输入建议

DIM-04 专项排查揭示了当前工程在“色彩角色”、“跳动数字防抖”、“焦点控制”及“无障碍语义”四个维度的核心断层。通过：
1. **Fill exactly one action per view**：降级列表项主按钮、确立单屏唯一强调色实体填充；
2. **Tabular numbers on changing values**：对 16 处跳动数值加固 `font-variant-numeric: tabular-nums`；
3. **Restrained Focus Ring**：落实 AGENTS.md §13 规定的 3%~10% 柔和焦点浅灰环；
4. **ARIA APG 标准化**：补齐 Icon `aria-label` 与 `aria-hidden`，打通键盘漫游。

本报告已为后续多 Agent 独立方案设计与最终落地提供了精确到 `文件:行号` 的实证支撑和代码消减蓝图。
