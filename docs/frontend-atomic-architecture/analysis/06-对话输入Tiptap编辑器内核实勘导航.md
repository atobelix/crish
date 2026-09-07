# 对话流输入中枢 Layer 4 编辑器内核实勘导航

> **战役任务**：前端原子化组件库战役 · 任务书 06  
> **实勘范围**：`apps/crish-desktop/src/components/chat-composer/` 下 TiptapComposerField, TiptapEditorField, TiptapEditorExtensions, TiptapSlashMenu, TiptapKeymap, ComposerField 等核心编辑器相关文件与 CSS Module  
> **交付路径**：`docs/frontend-atomic-architecture/analysis/06-对话输入Tiptap编辑器内核实勘导航.md`  
> **文档定位**：Layer 4 对话输入中枢底层技术导航、架构运行机制深度剖析与原子化架构提炼全景指南  
> **规范契约**：中文，UTF-8 无 BOM，客观真实，全量实勘，总行数 >= 1200 行  

---

## 目录

- [一、战役背景与实勘概述](#一战役背景与实勘概述)
  - [1.1 前端原子化组件库战役架构定位](#11-前端原子化组件库战役架构定位)
  - [1.2 四层空间垂直堆叠架构（Layer 1 - Layer 4）](#12-四层空间垂直堆叠架构layer-1---layer-4)
  - [1.3 Layer 4 对话输入中枢职责与双轨降级机制（Tiptap ↔ Textarea）](#13-layer-4-对话输入中枢职责与双轨降级机制tiptap--textarea)
  - [1.4 实勘文件全景资产清单与行数统计表](#14-实勘文件全景资产清单与行数统计表)
- [二、Layer 4 编辑器核心文件逐行全景实勘](#二layer-4-编辑器核心文件逐行全景实勘)
  - [2.1 TiptapComposerField.tsx（适配层外壳，326 行）](#21-tiptapcomposerfieldtsx适配层外壳326-行)
  - [2.2 TiptapEditorField.tsx（核心装配壳，416 行）](#22-tiptapeditorfieldtsx核心装配壳416-行)
  - [2.3 TiptapEditorExtensions.ts（扩展装配与事件网关，310 行）](#23-tiptapeditorextensionsts扩展装配与事件网关310-行)
  - [2.4 TiptapKeymap.ts（按键决策纯函数，83 行）](#24-tiptapkeymapts按键决策纯函数83-行)
  - [2.5 ComposerField.tsx（降级兜底纯文本核，211 行）](#25-composerfieldtsx降级兜底纯文本核211-行)
  - [2.6 SlashExtension.ts（斜杠与提及建议扩展，461 行）](#26-slashextensionts斜杠与提及建议扩展461-行)
  - [2.7 AiCommandSlashExtension.ts（纯净化 AI 系统指令集，175 行）](#27-aicommandslashextensionts纯净化-ai-系统指令集175-行)
  - [2.8 DirTreeExtension.ts（目录树建议扩展，182 行）](#28-dirtreeextensionts目录树建议扩展182-行)
  - [2.9 ComposerInlineTag.tsx（Mention 实体行内节点视图，68 行）](#29-composerinlinetagtsxmention-实体行内节点视图68-行)
  - [2.10 safeCursorAnchor.ts（四级几何安全光标探测器，338 行）](#210-safecursoranchorts四级几何安全光标探测器338-行)
  - [2.11 tiptapInjectionUtils.ts（事务 Meta 与占位符选区扫描，92 行）](#211-tiptapinjectionutilsts事务-meta-与占位符选区扫描92-行)
  - [2.12 useComposerMultiline.ts（单行胶囊/多行网格自适应 Hook，166 行）](#212-usecomposermultilinets单行胶囊多行网格自适应-hook166-行)
  - [2.13 DraftUndoToast.tsx / DraftUndoToast.module.css（草稿撤销悬浮条，77 行 / 97 行）](#213-draftundotoasttsx--draftundotoastmodulecss草稿撤销悬浮条77-行--97-行)
  - [2.14 序列化与反序列化引擎（markdownSerializer.ts 231 行 / markdownDeserializer.ts 445 行）](#214-序列化与反序列化引擎markdownserializerts-231-行--markdowndeserializerts-445-行)
  - [2.15 样式体系实勘（TiptapEditorField.module.css / TiptapSlashMenu.module.css / ChatComposer.module.css）](#215-样式体系实勘tiptapeditorfieldmodulecss--tiptapslashmenumodulecss--chatcomposermodulecss)
- [三、关键运行机制与核心时序深度剖析](#三关键运行机制与核心时序深度剖析)
  - [3.1 状态真相源与发送回流机制（Host SSOT & Flush-on-Send）](#31-状态真相源与发送回流机制host-ssot--flush-on-send)
  - [3.2 选区同步与 IME 输入法合成保护（CRM-03 三条件防线）](#32-选区同步与-ime-输入法合成保护crm-03-三条件防线)
  - [3.3 Slash 菜单与提及建议的浮层生命周期（Radix Popover & WAI-ARIA）](#33-slash-菜单与提及建议的浮层生命周期radix-popover--wai-aria)
  - [3.4 Markdown 双向序列化保真与 Schema 收敛（CRM-04）](#34-markdown-双向序列化保真与-schema-收敛crm-04)
  - [3.5 草稿原子暂存、防爆截断与撤销快照（CRM-02 Session Draft）](#35-草稿原子暂存防爆截断与撤销快照crm-02-session-draft)
  - [3.6 单行胶囊 ↔ 多行网格动态切换机制（Canvas 2D 离屏度量与迟滞死区）](#36-单行胶囊--多行网格动态切换机制canvas-2d-离屏度量与迟滞死区)
- [四、设计规范、视觉红线与无障碍门禁](#四设计规范视觉红线与无障碍门禁)
  - [4.1 零重阴影（Zero Box-Shadow）设计铁律](#41-零重阴影zero-box-shadow设计铁律)
  - [4.2 纯 Token 驱动（Zero Hardcoded Colors & Z-Index）](#42-纯-token-驱动zero-hardcoded-colors--z-index)
  - [4.3 极度克制的激活边框（≤10% 混入与 session-empty 5% 特例）](#43-极度克制的激活边框10-混入与-session-empty-5-特例)
  - [4.4 墨绿色正圆发送按钮（32x32px Spring 展开动效）](#44-墨绿色正圆发送按钮32x32px-spring-展开动效)
  - [4.5 W3C WAI-ARIA Combobox 全链路规范符合性审查](#45-w3c-wai-aria-combobox-全链路规范符合性审查)
- [五、测试矩阵与质量断言分析](#五测试矩阵与质量断言分析)
  - [5.1 单元测试与集成测试资产分布](#51-单元测试与集成测试资产分布)
  - [5.2 JSDOM 环境下的 ProseMirror 交互模拟策略](#52-jsdom-环境下的-prosemirror-交互模拟策略)
  - [5.3 视觉红线源码级自动断言（TiptapVisualRedline.test.ts）](#53-视觉红线源码级自动断言tiptapvisualredlinetestts)
  - [5.4 几何防漂移与无遮挡断言（safeCursorAnchor.test.ts / WO-13 / WO-14）](#54-几何防漂移与无遮挡断言safecursoranchortestts--wo-13--wo-14)
  - [5.5 序列化 Roundtrip 保真测试集（markdownSerializer.test.ts）](#55-序列化-roundtrip-保真测试集markdownserializertestts)
- [六、现有架构边界缺陷与深度洞察](#六现有架构边界缺陷与深度洞察)
  - [6.1 类型系统残余（any 类型断言与弱类型契约）](#61-类型系统残余any-类型断言与弱类型契约)
  - [6.2 ProseMirror DOMObserver 异步同步时差与微小竞态](#62-prosemirror-domobserver-异步同步时差与微小竞态)
  - [6.3 大文档全量序列化的性能边界与主线程预算](#63-大文档全量序列化的性能边界与主线程预算)
  - [6.4 建议插件在连续特殊符号键入时的边界竞争](#64-建议插件在连续特殊符号键入时的边界竞争)
  - [6.5 JSDOM 与真实 WebKit/Blink 运行时物理渲染差异](#65-jsdom-与真实-webkitblink-运行时物理渲染差异)
- [七、输入内核原子化标准化提炼与演化方案](#七输入内核原子化标准化提炼与演化方案)
  - [7.1 分层架构演化（Core / Headless / React / UI-Kit）](#71-分层架构演化core--headless--react--ui-kit)
  - [7.2 @crish/composer-core：跨框架 Headless 编辑器内核规划](#72-crishcomposer-core跨框架-headless-编辑器内核规划)
  - [7.3 @crish/composer-react：Hooks、Context 与状态管理适配层](#73-crishcomposer-reacthookscontext-与状态管理适配层)
  - [7.4 @crish/composer-ui：原子化组件与主题样式注入](#74-crishcomposer-ui原子化组件与主题样式注入)
  - [7.5 标准化契约与配置扩展规范](#75-标准化契约与配置扩展规范)
  - [7.6 演化迁移路径与防退避落地步骤](#76-演化迁移路径与防退避落地步骤)

---

## 一、战役背景与实勘概述

### 1.1 前端原子化组件库战役架构定位

在 Conex / Crish 向现代桌面原生智能化工作台演进的工程战役中，前端架构正在经历深刻的分层原子化治理。历史上，桌面端前端界面（`apps/crish-desktop`）曾积累了大量的全能型复合组件（God Components），这些组件往往杂糅了业务流程、网络请求、IPC 通信、富文本编辑与繁重的样式逻辑，不仅导致单文件行数剧烈膨胀，也造成了组件难以跨端复用、测试成本高昂以及多 Agent 并发开发时的代码冲突。

为了彻底解除上述技术债务，前端战役启动了**原子化组件库重构规划（Atomic Component Architecture）**。其核心理念是依据经典原子设计论（Atomic Design），将界面体系严格划分为五个由底至顶的层次：
1. **Token Layer（原子设计令牌）**：CSS 变量、Design Tokens、色彩空间、间距、圆角与过渡；
2. **Atom Layer（原子组件层）**：按钮、图标盒、单选框、基础输入框、标签、无状态 Chip；
3. **Molecule Layer（分子组件层）**：带撤销 Toast、权限指示胶囊、提及标签、弹出建议项、正圆弹性发送控制组；
4. **Organism Layer（组织生物层）**：浮动权限审批条、目标进度轮播条、上下文附件栏、对话输入卡片网格；
5. **Template / Page Layer（模板与页面容器层）**：主对话窗口、工作台侧边栏、分屏视图、独立会话视口。

在上述五层结构中，**对话输入中枢（Chat Composer）** 是承载人机意图交换最关键的复合中枢。它在物理布局上横跨 Molecule 与 Organism 层，而在功能内核上则深度依赖一个具备高保真 Markdown 互转、输入法合成保护、动态斜杠建议与无边框微交互的富文本引擎。本实勘任务专门针对输入中枢最核心的 **Layer 4 编辑器内核（Tiptap Editor Core）** 展开全量深度代码审计与技术导航。

### 1.2 四层空间垂直堆叠架构（Layer 1 - Layer 4）

根据 `apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css` 的系统架构定义，输入中枢采用了**四层空间垂直堆叠架构（Four-Layer Vertical Spatial Stacking Architecture）**。这一架构通过精确的 CSS 堆叠上下文与 DOM 节点组织，将不同关注点的交互逻辑垂直切分：

```
===================================================================================
 Layer 1: 浮动权限审批条 (ComposerPermissionBar / .flowPermissionBar)
 ---------------------------------------------------------------------------------
 [Shield 🛡️] 降级执行模式审批 · 倒计时 (tabular-nums) · 允许/拒绝 · 警告脉冲动画
 物理属性: position: relative, z-index: var(--z-base), background: var(--sem-warn-soft)
===================================================================================
 Layer 2: 目标/计划模式进度条 (ComposerPlanProgressBar / .planProgressBar)
 ---------------------------------------------------------------------------------
 [Target 🎯] 长程任务推进中 (ModeBadge) · 步骤步数轮播 (PlanRoller) · 耗时 · 停止按钮
 物理属性: height: 44px (collapsed), border-radius: 12px, border: var(--border-color)
===================================================================================
 Layer 3: 上下文与文件引用卡片区 (ComposerAttachmentBar / .fileZone / .attachStrip)
 ---------------------------------------------------------------------------------
 [File 📄] 文件引用芯片 · 图片缩略图 · 悬停缩放移除交叉钮 (.attachRemove) · 横向滚动
 物理属性: overflow-x: auto, scrollbar-width: none, gap: 6px, max-width: 100%
===================================================================================
 Layer 4: 主输入区 (ComposerCard / .inputMainLayout / Editor Core)
 ---------------------------------------------------------------------------------
 [＋ 快捷动作]  |  Tiptap 富文本输入内核 / Textarea 降级核  |  [🛡️ 权限] [↑ 墨绿发送]
 物理属性: border-radius: 22px, padding: 6px 10px, background: var(--composer-bg)
===================================================================================
```

- **垂直层叠与浮动空间（Float Zone）**：Layer 1 与 Layer 2 共同寄宿于 `.composerFloatZone` 宿主中，当且仅当存在未完成审批任务或长程进度时动态展开，未激活时 `:empty { display: none; }` 零占位；
- **引用缓冲层（Layer 3）**：位于输入卡片内部或上方，作为用户拖入文件、粘贴截图的暂存带，与主编辑区形成上下文绑定；
- **基石输入层（Layer 4）**：所有交互的汇聚点，承载文本键入、排版预览、按键拦截、斜杠命令呼出与消息提交。

### 1.3 Layer 4 对话输入中枢职责与双轨降级机制（Tiptap ↔ Textarea）

在 Layer 4 内部，系统确立了**渐进降级双轨制（Graceful Fallback Dual-Track Engine）** 的高可靠运行模型：

```
                              ┌──────────────────────────────────┐
                              │     宿主 ChatComposer.tsx        │
                              └────────────────┬─────────────────┘
                                               │
                                 [renderInputField 装配决策]
                                               │
                       ┌───────────────────────┴───────────────────────┐
                       │                                               │
            [richTextFailed === false]                       [richTextFailed === true]
                       │                                               │
                       ▼                                               ▼
         ┌───────────────────────────┐                   ┌───────────────────────────┐
         │ InputFieldErrorBoundary   │                   │ ComposerField (Textarea)  │
         └─────────────┬─────────────┘                   │ - 降级纯文本兜底          │
                       │                                 │ - useAutoGrowTextarea     │
                       ▼                                 │ - 保证 100% 可键入与发送   │
         ┌───────────────────────────┐                   └───────────────────────────┘
         │  React.Suspense (lazy)    │                                 ▲
         └─────────────┬─────────────┘                                 │
                       │                                               │
           [异步软接成功] │ [加载失败 / 渲染抛错]                           │
                       │ ──────────────────> [onFail 触发] ────────────┘
                       ▼
         ┌───────────────────────────┐
         │ TiptapComposerField (主路)│
         │ - Tiptap 富文本编辑器     │
         │ - GFM 行内 Mark 渲染      │
         │ - Mention 芯片 / Slash    │
         │ - safeCursorAnchor 几何防抖│
         └───────────────────────────┘
```

1. **统一契约基准（F1-γ 规范）**：无论是富文本分支 `TiptapComposerField` 还是纯文本分支 `ComposerField`，均 100% 实现 `composerTypes.ts` 中定义的 `ComposerFieldProps` 契约，做到属性、回调、受控值与无障碍接口的完全同构；
2. **错误隔离网**：通过 `InputFieldErrorBoundary` 守卫，一旦底层的 Tiptap v3、ProseMirror 或 DOMPurify 发生任何未捕获运行时异常，组件立即调用 `setRichTextFailed(true)`，永久回退至纯文本实现，绝对不会导致整个对话页面白屏崩溃；
3. **主辅分工**：主路 `TiptapComposerField` 负责极致的排版与交互体验，辅路 `ComposerField` 负责极致的健壮性与可用性底线。

### 1.4 实勘文件全景资产清单与行数统计表

本实勘覆盖 `apps/crish-desktop/src/components/chat-composer/` 目录下与 Layer 4 编辑器相关的全部核心源码、样式与测试资产：

| 资产文件路径 | 类型 | 行数 (Lines) | 大小 (Bytes) | 核心职责与架构定位 |
| :--- | :---: | :---: | :---: | :--- |
| `TiptapComposerField.tsx` | TSX | 326 | 11,804 | 编辑器适配层外壳：双向同步、防抖发送回流、草稿占位符聚焦 |
| `TiptapEditorField.tsx` | TSX | 416 | 15,180 | 编辑器组装核心：DOM 节点挂载、ARIA 全链同步、IME 监听与防爆水合 |
| `TiptapEditorExtensions.ts` | TS | 310 | 11,717 | 编辑器扩展工厂：StarterKit 裁剪、DOMPurify 清洗、50KB 告警 |
| `TiptapKeymap.ts` | TS | 83 | 2,629 | 按键决策纯函数：Enter 发送分发、代码块缩进、IME 合成判定 |
| `ComposerField.tsx` | TSX | 211 | 6,799 | 纯文本兜底核：useAutoGrowTextarea 响应式高度、Tab 缩进 |
| `SlashExtension.ts` | TS | 461 | 14,392 | 建议扩展总线：`/` 与 `@` 触发器、ReactRenderer 生命周期、Mention 节点 |
| `AiCommandSlashExtension.ts` | TS | 175 | 5,797 | AI 指令集定义：拔除博客命令，13 项系统控制命令与 CustomEvent 广播 |
| `DirTreeExtension.ts` | TS | 182 | 6,273 | 目录树扩展：`@@` 触发器，工作区目录树快速唤起与插入 |
| `ComposerInlineTag.tsx` | TSX | 68 | 2,266 | Mention 芯片视图：NodeView 组件，Lucide 图标盒与文件预览桥接 |
| `safeCursorAnchor.ts` | TS | 338 | 10,042 | 几何探测底座：四级备援、物理行高恢复、24px 迟滞回差、防 (0,0) 熔断 |
| `tiptapInjectionUtils.ts` | TS | 92 | 3,418 | 事务 Meta 工具：模板注入抑制弹层、AST 剪枝扫描占位符并全选 |
| `useComposerMultiline.ts` | TS | 166 | 5,313 | 布局自适应 Hook：Canvas 2D 离屏测宽、24px 死区、120ms 振荡自愈 |
| `DraftUndoToast.tsx` | TSX | 77 | 2,272 | 草稿撤销组件：外部模板覆盖后 6 秒自动淡出的原位无损恢复浮条 |
| `DraftUndoToast.module.css` | CSS | 97 | 2,508 | 草稿撤销样式：无重阴影、边框混入 ≤10%、HSLA 规范 |
| `serialization/markdownSerializer.ts` | TS | 231 | 7,082 | 序列化引擎：ProseMirror JSON 转换为标准 GFM Markdown 文本 |
| `serialization/markdownDeserializer.ts` | TS | 445 | 15,200 | 反序列化引擎：Markdown 降维转为纯净行内 AST，防止水合崩溃 |
| `TiptapEditorField.module.css` | CSS | 223 | 5,538 | 编辑器字段样式：极简无边框、选区混入、Mention Chip 渲染 |
| `TiptapSlashMenu.module.css` | CSS | 112 | 2,453 | 建议弹层样式：Radix Popover 承载、零阴影、var(--z-popover) |
| `composerTypes.ts` | TS | 198 | 7,950 | 类型定义归置中心：统一导出全量 Props、句柄与数据接口 |
| `ChatComposer.module.css` (相关段落) | CSS | ~300 | ~7,000 | 空间四层架构总样式：输入卡片、网格切换、墨绿色 32px 按钮 |

---

## 二、Layer 4 编辑器核心文件逐行全景实勘

### 2.1 TiptapComposerField.tsx（适配层外壳，326 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/TiptapComposerField.tsx`
- **代码规模**：326 行有效代码，符合 UI Component 单文件 <= 500 行的架构门禁。
- **架构职责**：作为承上启下的**适配器（Adapter Pattern）**。向上承接宿主 `ChatComposer` 与 `useChatComposerProps` 的全部状态协议；向下驱动 `TiptapEditorField` 核心。它彻底消除了富文本引擎向外层业务扩散状态复杂度的风险，负责协调发送回流、防抖同步、清空回流抑制以及外部模板草稿注入响应。

#### 核心代码结构与逐行实勘剖析

1. **系统预置命令与图标字典（Lines 41-75）**：
   - 文件头部声明了 `HOST_SYSTEM_SLASH` 常量数组，收拢了 13 项标准宿主系统级斜杠命令及其功能说明，严格对齐宿主底层支持的全部 AI 系统控制意图；
   - 定义了 `HOST_SLASH_ICONS: Record<string, string>`，将指令映射为语义化的图标代号（如 `/clear -> 'Eraser'`, `/stop -> 'Square'`, `/mode -> 'Sliders'`, `/goal -> 'Target'`, `/compact -> 'Shrink'`, `/schedule -> 'Calendar'`, `/browser -> 'Globe'`, `/learn -> 'BookOpen'`, `/settings -> 'Sparkles'`）。这保证了命令菜单在渲染时无需动态加载庞大的图标库映射表。

2. **超集契约接口设计（Lines 77-88）**：
   ```typescript
   export type TiptapComposerFieldProps = ComposerFieldProps & {
     /** 宿主 skill 斜杠命令（动态加载后由宿主传入） */
     skillSlashCommands?: ReadonlyArray<{ cmd: string; desc: string }>;
     /** 宿主系统斜杠命令（缺省用内置 BASE_SLASH 对齐集） */
     baseSlashCommands?: ReadonlyArray<{ cmd: string; desc: string }>;
     /** 宿主文件选择链（编辑器拖放直达） */
     onFilesSelected?: (files: File[]) => void | Promise<void>;
     /** 提及候选人（@ 触发；未接入宿主候选人源时留空兜底） */
     mentionCandidates?: ReadonlyArray<MentionCandidate>;
     /** 落地面态（session-empty 走 5% 焦点混色特例） */
     emptyKind?: string;
   };
   ```
   - 继承自标准 `ComposerFieldProps`，保证了降级兼容性；
   - 允许宿主以响应式数组注入动态插件或技能的斜杠命令（`skillSlashCommands`），当插件加载完毕后即时并入浮层菜单；
   - 预留提及候选人管道（`mentionCandidates`），打通智能体、技能与文件实体的统一拾取。

3. **发送快捷键偏好持久化监听（Lines 139-153）**：
   - 状态初始化：`const [sendShortcut, setSendShortcut] = useState<'enter' | 'ctrlEnter'>(readSendShortcut);`；
   - 挂载 `storage` 事件与 `SEND_SHORTCUT_CHANGED_EVENT` 自定义事件。当用户在全局设置面板中切换“Enter 发送”或“Ctrl+Enter 发送”时，组件在 0 延迟内完成内存状态同步，无需重新装配富文本内核。

4. **发送回流机制与闭包保护（Lines 155-189）**：
   - **痛点分析**：富文本编辑器由内部 ProseMirror 事务驱动，文字变更后经由 150ms 防抖才派发 `onChange(markdown)`。若用户在键入完毕后瞬间敲击 Enter 键，此时宿主 React 闭包中的 `value` 尚处于 150ms 之前的旧状态，若直接触发 `onSend` 将导致丢字。
   - **双阶段回流闭环**：
     - 第一阶段（立刻回流）：在 `handleSendMarkdown` 中，捕获当前编辑器的全量最新 Markdown 字符串，立即调用 `onChange(md)` 强刷宿主状态，并将待发文本存入 `sendRequestRef.current = md`，同时自增 `sendTick`（`setSendTick((t) => t + 1)`）；
     - 第二阶段（最新 Props 守卫）：在 `useEffect([sendTick, disabled, canSend])` 中，等待 React 依据最新 `md` 完成重渲染并重新计算出最新的 `canSend` 与 `disabled` 属性后，才正式调用 `onSendRef.current?.()`。若校验不通过（例如内容经 trim 后为空），则立即终止发送，此时已写入宿主的文本由编辑器的草稿水合机制自然保全。

5. **清空回流抑制机制（Lines 191-198）**：
   - 在 Enter 发送触发后，编辑器内部调用 `editor.commands.clearContent()`，该操作会触发编辑器的 `onUpdate` 进而发出清空通知；
   - 如果该清空通知在宿主 `onSend()` 执行前到达，宿主 `chatInput` 会被清空为 `""`，导致最终发出的消息为空；
   - 解决方案（关键防御）：
     ```typescript
     const handleMarkdownChange = useCallback(
       (md: string) => {
         if (sendRequestRef.current !== null) return; // 处于发送挂起期，强行吞掉清空回流
         onChange(md);
       },
       [onChange]
     );
     ```
     在 `sendRequestRef.current !== null` 的整个发送事务窗口内，清空回流被严格吞没，宿主状态恒定锁定在待发文本上。

6. **外置发送按钮命令式句柄（Lines 201-217）**：
   - 主对话输入界面的墨绿色正圆发送按钮位于外层网格布局中，当用户点击按钮时调用 `sendApiRef.current?.flushAndSend()`；
   - `trySend` 实现：首先通过 `fieldRef.current?.getMarkdown()` 同步探测编辑器内核当前的物理文本；若检测到内核文本与宿主 `value` 存在差异（处于 150ms 防抖空窗期），自动调用 `handleSendMarkdown` 执行上述安全回流流程，杜绝按钮点击与按键发送的行为分叉。

7. **草稿占位符定向聚焦（Lines 237-241）**：
   - 监听 `draftInjectionTick`。当用户在外部触发“插入系统提示词”或“恢复历史草稿”时，宿主递增此 tick；
   - 适配层触发 `fieldRef.current?.focusPlaceholder()`，实现光标自动聚焦并选中文本中的首个占位符（如 `{{user_name}}`），用户敲击任意字符即可无缝覆盖。

8. **CSS 变量与网格属性透传（Lines 266-281）**：
   - 外层包裹器注入 `data-composer-field="1"`, `data-composer-dense={dense ? '1' : '0'}`, `data-empty-kind={emptyKind}`；
   - 通过内联样式同步 CSS 自定义属性：`--composer-max-lines`（默认 10 行）与 `--composer-line-height`（普通 1.45，紧凑 1.4），保证侧边栏与主列编辑器的行高与伸缩行为完全一致。

---

### 2.2 TiptapEditorField.tsx（核心装配壳，416 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/TiptapEditorField.tsx`
- **代码规模**：416 行有效代码，符合 UI Component 单文件 <= 500 行的架构门禁。
- **架构职责**：Tiptap / ProseMirror 在 React 上下文中的物理承载壳。负责管理编辑器实例的生命周期、forwardRef 命令式接口暴露、底层 DOM 原生事件挂载（IME、Escape 捕获）、WAI-ARIA Combobox 全链路无障碍状态机动态同步以及会话草稿内存防爆水合。

#### 核心代码结构与逐行实勘剖析

1. **`safeViewDom` 穿透防御函数（Lines 52-62）**：
   ```typescript
   function safeViewDom(
     editor: { view?: unknown; isDestroyed?: boolean } | null | undefined
   ): HTMLElement | null {
     try {
       if (!editor || editor.isDestroyed) return null;
       const dom = (editor.view as { dom?: HTMLElement } | undefined)?.dom;
       return dom ?? null;
     } catch {
       return null;
     }
   }
   ```
   - **深度设计原理**：Tiptap v3 的 `editor.view` getter 在底层 `EditorView` 尚未物理挂载到 DOM 树之前，返回的是一个空的 JS Proxy 对象。此设计导致常规的 `if (!editor.view)` 防御失效。若直接尝试读取 `editor.view.dom`，Tiptap 内部会抛出致命错误：`"The editor view is not available. Cannot access view['dom']"`；
   - 本函数通过安全的属性探测与全局 `try-catch` 包裹，并在 `isDestroyed` 状态下立即剪枝返回 `null`，彻底免疫 React 18 StrictMode 模式下的组件“双挂载/快速卸载”引发的白屏崩溃。

2. **Ref 桥接架构：`TiptapEditorBridge`（Lines 107-186）**：
   - **痛点解析**：Tiptap 的 `useEditor(options)` 钩子若在依赖数组中包含外部频繁变化的 props（如 placeholder 切换、候选人列表刷新、回调函数更新等），每次父组件重渲染都会导致 Tiptap 重新执行 `setOptions`。这不仅会强制销毁并重建底层的 `ExtensionManager` 与 ProseMirror 插件链，还会造成输入光标失焦、选区重置与打字掉帧；
   - **架构方案**：将所有易变的外部属性收拢为静态的 React Ref 结构（`placeholderRef`, `sendShortcutRef`, `slashExtraItemsRef`, `mentionCandidatesRef`, `callbacksRef` 等），并将它们整合成 `TiptapEditorBridge` 接口对象；
   - `buildTiptapEditorOptions(editorBridge)` 在 `useMemo` 中以空依赖 `[]` 初始化，**装配实例在整个组件生命周期内恒定不变**。运行期的按键、粘贴、建议等逻辑统一通过 bridge 读取最新值，达成“零重建、零失焦”的工业级稳定性。

3. **WAI-ARIA Combobox 全链路动态同步（Lines 220-262）**：
   - 在挂载就绪的编辑器 DOM 上，常驻写入核心可访问性契约：
     - `role="combobox"`
     - `aria-haspopup="listbox"`
     - `aria-autocomplete="list"`
   - 运行期状态同步：当外部 props 或 Suggestion 状态机变化时，通过原生 `dom.setAttribute` 与 `dom.removeAttribute` 实时操纵 `aria-expanded`、`aria-controls` 与 `aria-activedescendant`，绕过了 React 虚拟 DOM 的 Diff 周期，响应极其迅捷。

4. **CRM-02 会话草稿水合与 100k 防爆截断（Lines 275-306）**：
   - **内存防爆阈值**：设定 `COMPOSER_MAX_LENGTH = 100000`（10 万字符）。若传入的草稿或外部粘贴文本超出该上限，执行强制硬截断：
     ```typescript
     safeContent = safeContent.slice(0, COMPOSER_MAX_LENGTH) +
       '

>[!WARNING]
>内容过长已被防爆截断，请清理后继续。';
     ```
     彻底杜绝长篇日志造成 ProseMirror AST 递归遍历导致的浏览器内存溢出（OOM）；
   - **脏检查与 RAF 调度**：若 `safeContent === lastContentRef.current` 则直接终止水合；若内容确实变更，则在 `requestAnimationFrame` 批处理中调用 `parseFromMarkdown(safeContent)` 并注入编辑器（`editor.commands.setContent(doc)`），保证主线程在 120Hz/60Hz 高刷屏下丝滑流畅。

5. **原生 CJK IME 事件监听（Lines 307-329）**：
   - 直接在底层 contenteditable DOM 元素上挂载原生的 `compositionstart` 与 `compositionend` 事件；
   - 实时同步修改本地闭包中的 `isComposingRef.current` 变量，并通过 `callbacksRef.current.onCompositionChange?.(true/false)` 通知宿主。

6. **Escape 按键捕获阶段防御（Lines 331-363）**：
   - **关键排查**：在工作台中，Radix UI 浮层组件在 `document` 的捕获阶段（Capture Phase）默认对 Escape 键执行 `preventDefault()`。这导致 ProseMirror 自身的 `handleKeyDown` 链由于 `event.defaultPrevented` 被整体跳过，Suggestion 插件无法接收到 Escape 事件，引起斜杠菜单或提及菜单滞留屏幕无法关闭；
   - **解决方案**：在编辑器 DOM 上注册捕获阶段的 `keydown` 监听器（`dom.addEventListener('keydown', onEscapeCapture, true)`）；
   - **输入法安全避让**：在捕获阶段检测到 `isImeComposition` 时绝对不予干预；若在非 IME 状态下检测到 Escape 键，直接通过 `exitSuggestion(view, slashSuggestionKey)` 原语主动关闭菜单并清理全套 ARIA 状态。

7. **forwardRef 命令式句柄（Lines 381-399）**：
   - 暴露 `getMarkdown()`：优先调用 `serializeToMarkdown(editor.getJSON()).trim()`，若因异常未产生有效内容，则降级读取 `editor.getText().trim()`，为外层发送提供绝对兜底；
   - 暴露 `focusPlaceholder()`：调用 `focusAndSelectFirstPlaceholder(editor)`，执行 AST 占位符扫描并全选。

---

### 2.3 TiptapEditorExtensions.ts（扩展装配与事件网关，310 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/TiptapEditorExtensions.ts`
- **代码规模**：310 行
- **架构职责**：将 Tiptap 编辑器的所有扩展配置、事件拦截与内容过滤器彻底抽离解耦。负责装配 StarterKit 纯净行内修饰流、挂载 50KB 大文档告警监视器、统筹调度 `handleKeyDown` 按键分发网关、执行 DOMPurify XSS 安全清洗，并管理外部文件拖拽与实体点击跳转。

#### 核心代码结构与逐行实勘剖析

1. **R-08 大文档序列化告警监视器（Lines 29-34, 70-82）**：
   - 阈值锁定：`SERIALIZE_WARN_CHARS = 50000`（5 万字符 / 约 50KB）；
   - `createOversizeWatcher` 闭包：在防抖窗口末帧全量序列化或 Enter 敲击瞬间，测量生成的 Markdown 字符总长度；
   - 当长度首次突破 50,000 字符且未告警时，置位 `oversizeWarnedRef.current = true` 并触发 `onOversizeWarning` 回调，由宿主弹出轻量级 Toast 提示长文本序列化开销；当文本清理至阈值以下后，告警状态自动复位，允许下次超限时再次提醒。

2. **纯净行内修饰流扩展装配（Lines 92-133）**：
   - **`StarterKit` 全面裁剪矩阵**：
     - `heading: false`（禁用 H1-H6，对话气泡禁止巨幅标题排版）
     - `bulletList: false`, `orderedList: false`, `listItem: false`（禁用块级列表，防止破坏输入框上下边界）
     - `blockquote: false`（禁用块级引用，对话流使用行内降维格式）
     - `horizontalRule: false`, `dropcursor: false`, `gapcursor: false`, `link: false`（全部禁用）
     - `codeBlock: {}`（**唯一保留的块级节点**：为用户编写或粘贴多行代码提供语法围栏，并支持内部 Enter 安全换行保护）；
   - **动态占位符扩展（Placeholder）**：采用函数响应式形式 `placeholder: () => bridge.placeholderRef.current ?? ''`，在宿主发生状态变更（如普通输入 ↔ 排队处理中）时，只需派发一次空事务重绘装饰层即可刷新占位符文案；
   - **链接 Mark 注册（Link）**：开启行内 `Link` mark，但禁用 `openOnClick`, `autolink`, `linkOnPaste`，确保用户自由粘贴含有 URL 的普通文字时不会被强制打上不可控的超链接样式；
   - **建议扩展链**：装配 `MentionExtension`, `SlashExtension`, `MentionSuggestionExtension`, `DirTreeExtension`。

3. **150ms 防抖更新机制（Lines 137-149）**：
   - 在 `onUpdate` 钩子中重置 `debounceTimerRef`；
   - 延时 150ms 触发 `serializeToMarkdown(editor.getJSON())`；
   - 将序列化结果缓存至 `lastContentRef.current`，执行大文档检测并向宿主派发 `onMarkdownChange`。

4. **`handleKeyDown` 事件网关调度（Lines 155-219）**：
   - **守卫 1：IME 合成态绝对放行**：调用 `isImeComposition`，若为合成中则立即返回 `false`，放行给浏览器内核原生候选词逻辑；
   - **守卫 2：代码块上下文检测**：
     ```typescript
     const inCodeBlock = view.state.selection.$from.parent.type.name === 'codeBlock';
     ```
   - **守卫 3：建议菜单活跃态检测**：综合 `slashSuggestionKey`, `mentionSuggestionKey`, `dirTreeSuggestionKey` 三个插件的活跃状态；
   - **决策执行**：将事件送入纯函数 `resolveTiptapKeydown` 进行决策：
     - 若返回 `insertIndent`：阻止默认行为，读取 `readCodeBlockIndent()`（默认 2 空格或用户偏好的 4 空格），执行 `view.dispatch(view.state.tr.insertText(indent))`；
     - 若在代码块内检测到 Shift+Tab 或纯 Tab 且建议弹层未打开，一律拦截默认的焦点跳出行为；
     - 若返回 `send`：阻止默认换行，**立即执行同步序列化**（`serializeToMarkdown(editor.getJSON())`），触发 `onSendMarkdown`，清空编辑器内容，并将 `lastContentRef.current` 重置为 `""`。

5. **实体点击联动 `handleClickOn`（Lines 220-235）**：
   - 当用户在编辑器内部单击实体标签时，检测 `node?.type?.name === 'mention'`；
   - 若 `kind === 'file'` 且具备有效的实体 ID，阻止默认光标选区行为，直接调用 `openFileInPanel(id)` 在侧边面板唤起文件叶预览。

6. **拖拽与安全粘贴清洗（Lines 236-306）**：
   - **文件拖放（`handleDrop`）**：检测 `event.dataTransfer.files`，拦截原生事件，转交 `onDropFiles` 进入附件链；
   - **图片粘贴拦截**：遍历 `clipboardData.items`，检测到 `image/*` 时提取为 `File` 对象，调用 `onPasteImage`（由宿主生成附件缩略图卡片），阻断 Base64 脏数据注入编辑器；
   - **HTML 粘贴清洗（DOMPurify）**：从剪贴板提取 `text/html`，使用 `DOMPurify.sanitize` 严格过滤高危标签（`script`, `style`, `iframe`, `object`, `embed`, `form`, `link`, `meta`, `img`, `video`, `audio`, `input`, `button` 等）与内联执行属性（`onerror`, `onload`, `onclick`），清洗后调用 `view.pasteHTML(cleaned)` 注入安全结构。

---

### 2.4 TiptapKeymap.ts（按键决策纯函数，83 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/TiptapKeymap.ts`
- **代码规模**：83 行
- **架构职责**：将按键拦截决策逻辑彻底解耦为无副作用纯函数。无任何 React 或 DOM 依赖，支持在 Node.js / Vitest 环境下以纯数据结构执行 100% 覆盖率的决策断言。

#### 决策状态转移矩阵与判定逻辑

```typescript
export function resolveTiptapKeydown(
  event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey?: boolean;
  },
  ctx: TiptapKeydownContext
): TiptapKeydownAction
```

| 序号 | 按键组合 (Key Combo) | 上下文环境 (Context) | 判定动作 (Action) | 架构设计意图与执行行为 |
| :---: | :--- | :--- | :---: | :--- |
| 1 | `Enter + Shift` | 任意环境 | `pass` | 硬换行保护：交给 ProseMirror 原生插入换行符 |
| 2 | `Enter` (无修饰键) | `inCodeBlock === true` | `pass` | **SRS 3.7.1 代码块保护**：代码块内 Enter 绝不发消息 |
| 3 | `Enter` (无修饰键) | `inCodeBlock === false` 且快捷键为 `enter` | `send` | 触发即时同步发送流程 |
| 4 | `Enter + Ctrl/Cmd` | 快捷键为 `ctrlEnter` | `send` | 满足用户快捷键偏好，触发即时同步发送 |
| 5 | `Tab` (无修饰键) | `inCodeBlock === true` 且建议弹层未开启 | `insertIndent` | 代码块内智能缩进，插入预设空格 |
| 6 | 其它所有按键组合 | 任意环境 | `pass` | 放行给底层 ProseMirror 处理 |

- **CRM-03 输入法保护门（`isImeComposition`）**：
  ```typescript
  export function isImeComposition(
    view: { composing?: boolean },
    event: { isComposing?: boolean },
    composingRef: { current: boolean }
  ): boolean {
    return Boolean(view.composing || event.isComposing || composingRef.current);
  }
  ```
  结合三项数据源执行逻辑“或（OR）”运算，任何一项为真立即视为正在输入拼音，彻底根除拼音上屏回车引发的误发送。

---

### 2.5 ComposerField.tsx（降级兜底纯文本核，211 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/ComposerField.tsx`
- **代码规模**：211 行有效代码，符合 UI Component 单文件 <= 500 行的架构门禁。
- **架构职责**：基于原生 HTML `<textarea>` 构建的轻量级降级实现。在富文本内核发生未知异常时接管渲染，提供自适应高度伸缩、空发送守卫、Tab 缩进与 WAI-ARIA 属性透传。

#### 核心代码结构与逐行实勘剖析

1. **`useAutoGrowTextarea` 高度驱动（Lines 58-76）**：
   - 读取 `maxLines`（默认 10 行），传入 `useAutoGrowTextarea(value, lines)`；
   - 挂载 `autoFocus` 后的 RAF 调度测量：`requestAnimationFrame(resize)`，解决弹窗或侧边栏入场动画完成前由于容器宽高为 0 导致的高度测量塌陷。

2. **空发送与状态守卫（Lines 82-86）**：
   - `trySend` 守卫：`if (disabled || !canSend) return;`，阻断空文本发送或任务处理中的误操作。

3. **原生 Textarea 无障碍与行为定制（Lines 120-147）**：
   - 支持根据 `ariaHasPopup` 或 `ariaExpanded` 动态挂载 `role="combobox"`；
   - 严格禁用浏览器的不可控增强：`spellCheck={false}`, `autoComplete="off"`, `autoCorrect="off"`；
   - 样式设置 `background: transparent` 与 `field-sizing: content`，保证视觉呈现与外层网格卡片无缝融合。

4. **纯文本模式下的 Tab 缩进实现（Lines 165-178）**：
   - 拦截 Tab 键，通过 `el.selectionStart` 与 `el.selectionEnd` 在光标位置切入代码缩进文本，并在下一微任务中将光标推进 `indent.length`，为降级环境下的用户提供基本的代码编写支持。

---

### 2.6 SlashExtension.ts（斜杠与提及建议扩展，461 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/SlashExtension.ts`
- **代码规模**：461 行
- **架构职责**：作为输入中枢“建议体系（Suggestion System）”的核心大脑。基于 `@tiptap/suggestion` 插件构建，负责在用户输入斜杠 `/` 或提及 `@` 时执行字符匹配过滤、动态挂载与销毁 `ReactRenderer`、同步 WAI-ARIA Combobox 无障碍属性树，并定义 `mention` 行内 Atom 节点的完整数据契约与 NodeView。

#### 核心代码结构与逐行实勘剖析

1. **建议项过滤与匹配引擎（Lines 31-92）**：
   - **斜杠命令过滤（`getSuggestionItems`）**：合并静态系统指令与外部传入的动态 Skill 命令，去重后依据用户输入的 `query` 执行大小写不敏感匹配。匹配维度覆盖标题（`title`）、ID、描述（`description`）以及自定义关键词数组（`keywords`），确保即使用户输入中英文混杂的别名（如输入“清空”匹配 `/clear`）也能精准命中；
   - **提及实体过滤（`getMentionItems`）**：将宿主传入的 `MentionCandidate[]` 列表过滤并转换为标准建议项。当用户在菜单中选中某候选人时，执行事务链：
     ```typescript
     command: ({ editor, range }) => {
       const chain = editor.chain().focus();
       if (range) chain.deleteRange(range);
       chain.insertContent([
         {
           type: 'mention',
           attrs: { id: c.id, label: c.label, kind: c.kind ?? 'file' },
         },
         { type: 'text', text: ' ' }, // 插入尾随空格，方便用户继续键入
       ]).run();
     }
     ```

2. **通用建议渲染器工厂：`createSuggestionRenderer`（Lines 127-276）**：
   - **闭包状态隔离**：每个建议插件实例通过工厂闭包维护私有的 `component: ReactRenderer | null`、`propsRef` 以及 `lastCachedBox` 坐标缓存；
   - **`clientRect` 几何防漂移计算（Lines 153-195）**：
     - **IME 合成态光标冻结**：若检测到 `view.composing || view.input?.composing`，直接返回 `lastCachedBox` 稳定缓存，绝不在拼音候选词切换期间重新计算坐标，防止浮层颠簸闪烁；
     - **物理包围盒与四级备援**：调用 `measureCursorLineBox` 获取包含真实行高（>= 16px）的光标包围盒，送入 `calculateSafeCursorAnchor` 计算安全锚点；
     - **DEC-06 关键修复**：使用 `Object.assign(new DOMRect(...), { suggestedSide, nearEdge, isFallback, isValid })` 严格保全几何翻折扩展属性；
   - **`onStart` 生命周期（Lines 215-221）**：
     - 若设置了 `skipEmpty: true`（提及插件配置）且当前无候选人，直接剪枝返回，不挂载弹层；
     - 否则创建 `ReactRenderer(TiptapSlashMenu)` 实例，并在编辑器底层 DOM 节点上写入 `aria-expanded="true"` 与 `aria-controls="{listboxId}"`；
   - **`onUpdate` 生命周期（Lines 222-236）**：
     - 响应键盘打字导致的筛选结果变动，调用 `component.updateProps(buildProps(props))`；若过滤后列表变空且开启了 `skipEmpty`，即刻销毁组件释放内存；
   - **`onKeyDown` 生命周期（Lines 237-260）**：
     - **Escape 防御**：非 IME 合成态下检测到 Escape 键时，立即销毁组件并调用 `exitSuggestion(props.view, ctx.pluginKey)`，强行关闭 ProseMirror 内部的建议状态；
     - 其余上下键与回车事件透传给 `TiptapSlashMenu` 的 ImperativeHandle（`component.ref.onKeyDown`）；
   - **`onExit` 生命周期（Lines 261-274）**：
     - 清理编辑器 DOM 上的 `aria-expanded`, `aria-controls`, `aria-activedescendant` 属性；彻底销毁 `ReactRenderer` 实例并重置坐标缓存。

3. **`MentionExtension` 行内节点规范（Lines 377-460）**：
   - 节点契约：`group: 'inline'`, `inline: true`, `selectable: false`, `atom: true`；
   - 属性声明：`id`（实体唯一路径或标识）、`label`（展示名称）、`kind`（实体分类，默认为 `'file'`）；
   - `renderHTML`：生成符合规范的 `<span data-type="mention" data-kind="file" contenteditable="false" class="mention-chip">`；
   - `addNodeView`：绑定 React 组件 `ComposerInlineTag`；
   - `renderText`：为纯文本剪切板和只读回退提供标准的 `@[label](id)` 纯文本表示。

---

### 2.7 AiCommandSlashExtension.ts（纯净化 AI 系统指令集，175 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/AiCommandSlashExtension.ts`
- **代码规模**：175 行
- **架构职责**：专门针对智能化协作工作台定义的纯净化 AI 系统控制指令清单。彻底清除了传统富文本编辑器残留的博客排版命令，收拢为 13 项系统调度入口，并通过 CustomEvent 实现与外层架构的松耦合通信。

#### 13 项核心指令规格全景表

| 指令 ID | 唤起指令 | 图标 (Icon) | 匹配关键词 (Keywords) | 交互行为与调度机制 |
| :--- | :--- | :--- | :--- | :--- |
| `goal` | `/goal` | `Target` | goal, 目标, 长程, 推进, autonomous | 删除触发词，在光标处注入 `"/goal "`，等待用户输入目标 |
| `clear` | `/clear` | `Eraser` | clear, 清空, 重置, reset, cls | 删除触发词，向 window 广播 `CustomEvent('crish:chat-clear')` |
| `stop` | `/stop` | `Square` | stop, 停止, 终止, cancel, abort | 删除触发词，向 window 广播 `CustomEvent('crish:chat-stop')` |
| `mode` | `/mode` | `Shield` | mode, 权限, 模式, permission, safe | 删除触发词，在光标处注入 `"/mode "`，引导切换只读/读写权限 |
| `prompt` | `/prompt` | `FileCode` | prompt, 提示词, 模板, template | 删除触发词，在光标处注入 `"/prompt "`，呼出模板选择器 |
| `compact` | `/compact` | `Sliders` | compact, 压缩, 摘要, summarize, budget | 删除触发词，向 window 广播 `CustomEvent('crish:chat-compact')` |
| `schedule` | `/schedule` | `Clock` | schedule, 定时, 计划, cron, timer | 删除触发词，在光标处注入 `"/schedule "`，安排定时任务 |
| `grill-me` | `/grill-me` | `Flame` | grill, 拷问, 推演, interview, review | 删除触发词，在光标处注入 `"/grill-me "`，开启推演对齐模式 |
| `teamwork-preview` | `/teamwork-preview` | `Users` | teamwork, 协同, 多Agent, pipeline | 删除触发词，在光标处注入 `"/teamwork-preview "`，展示流水线 |
| `browser` | `/browser` | `Compass` | browser, 浏览器, web, 网页, navigate | 删除触发词，在光标处注入 `"/browser "`，唤起受管浏览器 |
| `learn` | `/learn` | `BookOpen` | learn, 记忆, 学习, persist, memory | 删除触发词，在光标处注入 `"/learn "`，提取长期规则 |
| `settings` | `/settings` | `Settings` | settings, 设置, 偏好, config, preferences | 删除触发词，向 window 广播 `CustomEvent('crish:open-settings')` |
| `help` | `/help` | `HelpCircle` | help, 帮助, 说明, shortcuts | 删除触发词，在光标处注入 `"/help"`，查看系统帮助 |

- **架构亮点**：将“纯文本输入操作”（如 `/goal`, `/schedule`）与“系统级控制指令”（如 `/clear`, `/stop`, `/settings`）清晰切分。对于系统指令，采用无侵入的 `window.dispatchEvent` 进行广播，解除了编辑器对上层 Store 或弹窗控制器的直接逆向依赖。

---

### 2.8 DirTreeExtension.ts（目录树建议扩展，182 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/DirTreeExtension.ts`
- **代码规模**：182 行
- **架构职责**：定义以双字符 `@@` 为触发前缀的工作区目录树拾取建议扩展。允许用户在编辑代码或编写提示词时，无需通过鼠标点选文件树，直接在光标处呼出浮动的工作区目录树进行快速文件定位。

#### 核心代码结构与逐行实勘剖析
1. **独立插件键隔离（Line 16）**：
   - 声明 `export const dirTreeSuggestionKey = new PluginKey('crishDirTreeSuggestion');`，与斜杠建议（`crishSlashSuggestion`）及提及建议（`crishMentionSuggestion`）在 ProseMirror Plugin 层面严格物理隔离，按键事件与状态机互不踩踏；
2. **触发器与空项兜底（Lines 47-51）**：
   - 配置 `char: '@@'`, `allowedPrefixes: null`；
   - 提供 `DUMMY_ITEM` 占位对象，驱动 Suggestion 状态机进入活跃态并挂载渲染器；
3. **几何计算复用（Lines 85-115）**：
   - 深度复用 `safeCursorAnchor` 探测引擎，同样具有 CJK 输入法合成态光标静止保护、物理行高恢复以及 24px 施密特迟滞回差；
4. **组件挂载（Lines 131-135）**：
   - 通过 `ReactRenderer(ComposerDirTree)` 挂载目录树视图，用户通过上下键漫游目录节点，按 Enter 键完成路径的快速插入。

---

### 2.9 ComposerInlineTag.tsx（Mention 实体行内节点视图，68 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/ComposerInlineTag.tsx`
- **代码规模**：68 行
- **架构职责**：Tiptap 的 NodeView 组件。负责在编辑器内部将 `mention` Atom 节点渲染为优雅、小巧的行内胶囊标签（Mention Chip），并承载实体的快速文件预览与中键删除交互。

#### 核心代码结构与逐行实勘剖析
1. **实体类型与图标自适应（Lines 11-15）**：
   ```typescript
   function iconForKind(kind: string) {
     if (kind === 'skill') return Lucide.Sparkles;
     if (kind === 'agent') return Lucide.Bot;
     return Lucide.FileText;
   }
   ```
   - 针对智能体（`agent`）、技能（`skill`）与文件（`file`）自适应装配 Lucide 矢量图标，杜绝了硬编码 SVG 或外部图片资源加载延迟；
2. **实体展示文本（Line 25）**：
   - 若 `kind === 'skill'`，直接展示标签名（如 `代码重构`）；其余实体展示带 `@` 前缀的形式（如 `@Agent 史密斯`，`@src/index.ts`）；
3. **不可编辑与原子删除保护（Line 38）**：
   - 显式声明 `contentEditable={false}`，禁止用户将光标置入标签内部对其部分文字进行改写；
   - 用户在键盘上按 Backspace 键时，ProseMirror 将其视作单一原子字符一次性整体删除；
4. **文件点击预览与快捷操作（Lines 42-60）**：
   - 若实体为文件（`kind === 'file'`），添加 `role="button"` 与 `tabIndex={0}`；
   - 单击或按下 Enter/Space 键，立即触发 `openFileInPanel(id)`，在工作台侧边栏打开文件预览叶；
   - 监听鼠标辅助按键（`onAuxClick`）：当用户使用鼠标滚轮中键点击标签时（`e.button === 1`），直接调用 `deleteNode?.()` 快速从文档中剔除该实体。

---

### 2.10 safeCursorAnchor.ts（四级几何安全光标探测器，338 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/safeCursorAnchor.ts`
- **代码规模**：338 行有效代码，符合 Business Logic 单文件 <= 400 行的架构门禁。
- **架构职责**：整个对话输入中枢所有浮层（Slash 菜单、提及建议、目录树）定位安全的基石。它彻底根除了富文本引擎在弹层定位时常见的 (0,0) 坍塌、Windows DPI 亚像素噪点、视口滚动越界遮挡及边缘临界点高频上下闪烁等历史顽疾。

#### 四级备援回退策略与熔断架构深度剖析

```
                         [原始光标参数 rawCursorRect]
                                      │
                         [isPhysicallyVisibleNonZeroRect]
                                      │
              YES ┌───────────────────┴───────────────────┐ NO
                  ▼                                       ▼
       [Level 1: 真实 LineBox]                [Level 2: DOM Range 选区]
                  │                                       │
                  ├─> [isAnchorInsideVisibleField 视口检查]
                  │                                       │
                  ▼ 校验失败                              ▼ 探测失败
       ┌──────────────────────────────────────────────────────────┐
       │               Level 3: Editor View DOM Box               │
       └────────────────────────────┬─────────────────────────────┘
                                    │ 宿主未物理挂载
                                    ▼
       ┌──────────────────────────────────────────────────────────┐
       │             Level 4: Composer Container Box              │
       └────────────────────────────┬─────────────────────────────┘
                                    │ 容器亦不可见
                                    ▼
       ┌──────────────────────────────────────────────────────────┐
       │   终极熔断守卫: 返回 null (绝对不向 (0,0) 渲染 Portal)    │
       └──────────────────────────────────────────────────────────┘
```

1. **`measureCursorLineBox` 真实物理行盒度量（Lines 42-79）**：
   - ProseMirror 原生的 `view.coordsAtPos(pos)` 常返回高度退化为 0 的点状矩形；
   - 本函数通过 `coords.bottom - coords.top` 计算物理行高，并强制施加安全保底：
     ```typescript
     const height = Math.max(16, Number.isFinite(measuredHeight) ? measuredHeight : 20);
     const width = Math.max(2, Number.isFinite(measuredWidth) ? measuredWidth : 2);
     ```
     恢复了包含真实行高与光标宽度的物理 DOMRect。

2. **`isPhysicallyVisibleNonZeroRect` 亚像素噪点过滤（Lines 105-120）**：
   - 过滤 Windows DPI 缩放环境下常见的 `0.000031px` 浮点数噪点；
   - 判定标准：尺寸必须 `>= 0.5px`（`epsilon`），且坚决剔除坐标极度接近 0 且高度低于 12px 的未就绪噪点。

3. **`isAnchorInsideVisibleField` 视口越界拦截（Lines 124-142）**：
   - 计算输入框外层容器的 `getBoundingClientRect()`；
   - 检查锚点是否向上（`anchorRect.top + height < fieldRect.top - 4`）或向下（`anchorRect.top > fieldRect.bottom + 4`）滚出可视区；一旦越界立即判定不可见，阻断浮层在输入框外部悬空遮挡。

4. **`computeViewportEdgeAlignment` 24px 施密特迟滞回差算法（Lines 148-186）**：
   - **痛点**：当光标位于屏幕顶部/底部边缘附近（如阈值 120px）时，用户键入单个字符或行高微调 1px，会导致浮层在 `top` 与 `bottom` 之间发生每秒数十次的高频上下剧烈震颤；
   - **施密特迟滞回差方程**：
     ```
     sideHysteresis = (previousSide === 'top') ? -24px : (previousSide === 'bottom') ? +24px : 0px;
     effectiveTopThreshold = max(0, edgeThreshold + sideHysteresis);
     ```
     当上一帧停靠在 `top` 时，顶部阈值自动收缩至 `120 - 24 = 96px`，使得浮层倾向于维持当前位置；若要翻折为 `bottom`，光标必须突破更为苛刻的死区，彻底消除了临界点颠簸。

5. **终极熔断防线（Lines 334-337）**：
   - 若经过 4 级备援后仍未获取到有效的物理包围盒，函数直接返回 `null`。上层渲染器识别到 `null` 时直接拒绝挂载 Portal，杜绝了浮层飞到屏幕左上角 `(0, 0)` 的不良现象。

---

### 2.11 tiptapInjectionUtils.ts（事务 Meta 与占位符选区扫描，92 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/tiptapInjectionUtils.ts`
- **代码规模**：92 行
- **架构职责**：负责管理外部指令、Prompt 模板程序性注入编辑器时的事务元数据（Meta）以及 AST 占位符的剪枝扫描与高亮全选。

#### 核心机制与算法剖析
1. **`INJECTION_TRANSACTION_META` 事务标记（Line 22）**：
   - 声明常量字符串 `CRISH_PROMPT_INJECTION_META`；
   - 当外部程序性注入模板时，在 ProseMirror 事务上打上此标记：`tr.setMeta(INJECTION_TRANSACTION_META, true)`；
   - `SlashExtension` 与 `MentionSuggestionExtension` 在处理输入流时识别此 Meta，主动跳过当前事务的文本扫描，防止模板文本中包含的 `/` 或 `@` 误触发浮层弹窗。

2. **`locateFirstPlaceholder` 占位符剪枝扫描算法（Lines 37-58）**：
   - 正则表达式：`/\{\{([^}]+)\}\}|<([^>]+)>|\[([^[\]]{2,30})\]/`，兼容双大括号（`{{...}}`）、尖括号（`<...>`）以及中文字符描述占位（`[描述...]`）；
   - 利用 `doc.descendants((node, pos) => ...)` 遍历 ProseMirror AST；
   - **高效剪枝**：一旦在文本节点中匹配到第一个占位符，立即记录其全局偏移区间 `{ from, to, text }` 并返回 `false` 终止后续整棵子树的遍历，时间复杂度最优。

3. **`focusAndSelectFirstPlaceholder` 定向全选（Lines 65-91）**：
   - 获取匹配区间后，创建 `TextSelection.create(doc, match.from, match.to)`；
   - 将选区派发至编辑器视图（`editor.view.dispatch(tr)`），使输入框自动聚焦并将该占位符整体反白选中；
   - 显式调用 `exitSuggestion` 关闭可能残留的建议菜单。用户此时敲击键盘输入的第一个字符将瞬间覆盖预设占位符，带来极其流畅的人机交互。

---

### 2.12 useComposerMultiline.ts（单行胶囊/多行网格自适应 Hook，166 行）

- **文件定位**：`apps/crish-desktop/src/components/chat-composer/useComposerMultiline.ts`
- **代码规模**：166 行
- **架构职责**：驱动 Layer 4 主输入卡片在“单行胶囊（Single-line Capsule）”与“多行网格（Multiline Grid）”之间平滑自适应切换的度量引擎。彻底废弃了在真实 DOM 中插入不可见 `<span>` 导致的重排回流，采用纯内存离屏 Canvas 2D 进行亚像素测宽，并配合双门限施密特迟滞区间与振荡自愈熔断器，消除了极端场景下的布局颠簸。

#### 核心代码结构与逐行实勘剖析

1. **单例 Canvas 2D 离屏度量（Lines 18-33）**：
   ```typescript
   let sharedCanvas: HTMLCanvasElement | null = null;
   let sharedCtx: CanvasRenderingContext2D | null = null;

   export function measureTextWidthCanvas(text: string, font: string): number {
     if (typeof window === 'undefined' && typeof document === 'undefined') return 0;
     if (!sharedCanvas && typeof document !== 'undefined') {
       sharedCanvas = document.createElement('canvas');
       sharedCtx = sharedCanvas.getContext('2d');
     }
     if (!sharedCtx) return text.length * 8;
     sharedCtx.font = font;
     return sharedCtx.measureText(text).width;
   }
   ```
   - 模块级单例缓存：避免反复创建 canvas 节点与上下文；
   - 将文本宽度计算完全移至 GPU/内存中完成，零 DOM 脏标记，测宽耗时控制在微秒级。

2. **虚拟单行容量解耦算法（Lines 68-88）**：
   - 动态获取容器实际宽度 `layoutW = layout.clientWidth`；
   - 探测左侧控制组（`data-composer-grid="left"`）、权限指示器（`perm`）与右侧操作按钮组（`right`）的实际占用尺寸；
   - 计算单行可用空间：
     ```typescript
     const used = (left?.offsetWidth ?? 0) + (perm?.offsetWidth ?? 0) + (right?.offsetWidth ?? 0) + GRID_GUTTER_PX;
     const capacity = Math.max(MIN_CAPACITY_PX, layoutW - used);
     ```
     以纯单行几何模型为基准，解除了多行状态下因布局展开导致测宽基准失真的逆向耦合。

3. **24px 双门限施密特迟滞区间（Lines 107-112）**：
   - 上门限（展开多行）：`textWidth >= capacity`；
   - 下门限（收起为单行）：`textWidth < capacity - HYSTERESIS_BUFFER_PX`（`24px` 死区）；
   - 在临界状态下，必须跌破 24px 缓冲区后才允许收回，防止用户反复删除/输入单一字符时产生肉眼可见的卡片抽搐。

4. **120ms 振荡自愈熔断器（Lines 113-128）**：
   - 维护 `flipHistoryRef: number[]` 时间戳序列；
   - 规则：若在 `FLIP_WINDOW_MS = 120ms` 的狭小时间窗口内，状态翻转次数达到 `FLIP_THRESHOLD = 3` 次；
   - 熔断响应：触发 `lockedUntilRef.current = now + LOCKOUT_DURATION_MS`（`400ms`），在此期间强制死锁为多行网格态，阻断浏览器的级联重排死循环。

5. **ResizeObserver + RAF 调度批处理（Lines 131-162）**：
   - 监听宿主布局容器的尺寸突变；
   - 结合 `window.requestAnimationFrame` 执行帧同步批处理，将一帧内多次 resize 事件合并为单次测量。

---

### 2.13 DraftUndoToast.tsx / DraftUndoToast.module.css（草稿撤销悬浮条，77 行 / 97 行）

- **文件定位**：
  - `apps/crish-desktop/src/components/chat-composer/DraftUndoToast.tsx`（77 行）
  - `apps/crish-desktop/src/components/chat-composer/DraftUndoToast.module.css`（97 行）
- **代码规模**：共 174 行
- **架构职责**：在外部行为（如点击预设 Prompt 模板、会话自动种子填充）覆盖了用户当前已经手动输入的草稿内容时，由宿主触发此浮条，提供长达 6 秒的无损恢复安全窗口，保障用户心智资产不丢失。

#### 核心代码与样式实勘剖析

1. **自动淡出与原子恢复（Lines 23-44）**：
   - 监听 `show` 属性。当为 `true` 时，激活内部定时器 `window.setTimeout(() => setVisible(false), autoDismissMs)`（默认 6000ms / 6 秒）；
   - 当用户主动点击“撤销恢复”按钮时，先调用 `onUndo()` 触发底层 `undoDraft()` 快照回流，随后立即执行 `dismiss()` 关闭悬浮条。

2. **WAI-ARIA 动态广播（Line 49）**：
   - 根节点声明 `role="status"` 与 `aria-live="polite"`，使屏幕朗读器能在不中断当前语音流的前提下，柔和通告“已应用模板并保留原草稿快照”。

3. **视觉红线与 Token 契约（`DraftUndoToast.module.css`）**：
   - **绝对定位与半透材质**：`bottom: calc(100% + 8px); z-index: 30;`，悬浮于输入卡片正上方；
   - **柔和细边框**：严格遵守 ≤10% 的颜色混入铁律：
     ```css
     border: var(--hairline-width, 1px) solid
       color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);
     ```
   - **微动效入场**：`animation: undoToastIn 160ms ease-out;`，位移仅为轻微的 `translateY(4px)`，无生硬突变。

---

### 2.14 序列化与反序列化引擎（markdownSerializer.ts 231 行 / markdownDeserializer.ts 445 行）

- **文件定位**：
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownSerializer.ts`（231 行）
  - `apps/crish-desktop/src/components/chat-composer/serialization/markdownDeserializer.ts`（445 行）
- **代码规模**：共 676 行
- **架构职责**：作为富文本内核与外部纯文本世界的转换枢纽。负责在用户键入、粘贴或外部水合时，在 ProseMirror AST JSON 树与标准 GFM Markdown 字符串之间建立双向保真映射。

#### 核心转换算法与降维契约深度剖析

1. **输入框 Schema 收敛与降维反序列化契约（CRITICAL SSOT）**：
   - **历史惨痛教训**：在早期实现中，反序列化引擎会忠实还原 Markdown 中的标题（`heading`）、多级无序列表（`bulletList`）、有序列表（`orderedList`）以及引用块（`blockquote`）。然而，聊天输入框在 `TiptapEditorExtensions` 中为保持界面纯净，刻意对上述块级排版节点进行了彻底禁用。这导致 `editor.commands.setContent(doc)` 在接收到未知块节点时直接抛出严重类型错误，并静默回退为空白，造成用户已保存的历史草稿在点击后彻底丢失；
   - **降维转换机制（Dimension Reduction）**：`markdownDeserializer.ts` 的反序列化输出**严格受限于行内 Schema 形状**。所有块级排版节点在反序列化时被降维扁平化为包含原生标记文本的普通段落：
     - `# 一级标题` 转换为 `paragraph`，内容为 `text: "# "` + 行内子节点；
     - `- [ ] 待办` 转换为 `paragraph`，内容为 `text: "- [ ] "` + 行内子节点；
     - `1. 有序项` 转换为 `paragraph`，内容为 `text: "1. "` + 行内子节点；
     - `> 引用文本` 转换为 `paragraph`，内容为 `text: "> "` + 行内子节点；
     - 这一精妙设计保证了 `setContent` 永远不会遇到未知节点类型，同时用户在输入框内能够直观看到 Markdown 的原生标记符号，且二次发送时依然能 100% 还原为规范的 Markdown 语法。

2. **嵌套行内 Mark 的双向递归解析（`parseInline`）**：
   - 支持多层行内修饰语法的交织嵌套（如 `**加粗内嵌 `代码`**`，`[**加粗超链接**](url)`，`~~删除线~~`）；
   - 使用深度优先递归，解析出带有复合 `marks: [{ type: 'bold' }, { type: 'code' }]` 的文本节点；
   - 提取硬换行符 `
` 为标准的 `hardBreak` 节点，保证在同一段落内的多行排版不会发生结构分裂。

3. **CommonMark 翼规则安全适配**：
   - 针对斜体标记匹配，采用严格的断言正则：`/^\*(?=\S)(\S(?:[\s\S]*?\S)?)\*/`；
   - 只有当星号 `*` 后紧跟非空白字符时才被识别为斜体，避免 Linux Cron 表达式（如 `0 9 * * *`）中的裸星号被误吞为斜体标记而丢失字符。

4. **Mention 实体元数据保真**：
   - 序列化格式：`@[label](id:kind)`；
   - 反序列化正则：`^@\[([^\]]+)\]\(([^):]+)(?::([^)]+))?\)`；
   - 实体标签、全局唯一 ID 以及类型属性在往返序列化（Roundtrip）中 100% 无损留存。

---

### 2.15 样式体系实勘（TiptapEditorField.module.css / TiptapSlashMenu.module.css / ChatComposer.module.css）

#### 1. TiptapEditorField.module.css（223 行）逐条实勘
- **`.fieldWrapper`（Lines 9-17）**：声明 `flex: 1 1 auto; min-width: 0; width: 100%; border-radius: var(--radius-md); box-shadow: none;`，作为撑满网格插槽的弹性容器；
- **`.proseMirrorField`（Lines 24-44）**：
  - 动态高度计算：
    ```css
    min-height: calc(1em * var(--composer-line-height, 1.45) * var(--composer-min-lines, 2));
    max-height: calc(1em * var(--composer-line-height, 1.45) * var(--composer-max-lines, 10));
    ```
  - 核心排版：`overflow-y: auto; outline: none; box-shadow: none; caret-color: var(--text-primary); word-break: break-word;`；
- **选区混色（Line 53）**：`:global(::selection) { background: color-mix(in srgb, var(--accent-color) 12%, transparent); }`，采用感知极为柔和的 12% 强调色，避免高亮遮挡文字细节；
- **占位符伪元素（Lines 169-175）**：
  ```css
  .proseMirrorField :global(p.is-editor-empty:first-child::before) {
    color: var(--text-tertiary);
    content: attr(data-placeholder);
    float: left;
    height: 0;
    pointer-events: none;
  }
  ```
  利用浮动零高度占位，解决多行富文本光标在首字符闪烁时的对齐偏差；
- **Mention Chip 样式（Lines 178-217）**：
  - 外观呈现：`inline-flex; align-items: center; gap: 4px; padding: 1px 6px 1px 2px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); background: var(--tint-hover);`；
  - 内部图标盒：`width: 16px; height: 16px; border-radius: 3px; background: var(--bg-elevated); color: var(--text-secondary);`。

#### 2. TiptapSlashMenu.module.css（112 行）逐条实勘
- **`.popoverContent`（Lines 18-35）**：
  - 悬浮面板：`z-index: var(--z-popover); width: 256px; max-height: min(var(--radix-popover-content-available-height, 320px), 70vh, 320px);`；
  - 材质与边框：`background: var(--bg-elevated); border: var(--hairline-width, 1px) solid var(--border-color); border-radius: var(--radius-md); box-shadow: none;`；
  - 入场动效：仅使用纯透明度淡入动画 `popoverFadeIn`（0.12s），杜绝任何会导致视觉眩晕的巨幅物理位移。
- **`.menuItem` 与高亮（Lines 43-67）**：
  - 激活高亮：`.menuItem:hover, .menuItemActive { background: var(--tint-active); }`；
  - 标题截断：`white-space: nowrap; text-overflow: ellipsis; overflow: hidden;`，保证单项内容不折行。

#### 3. ChatComposer.module.css 相关输入样式实勘
- **主输入卡片 `.composerCard`（Lines 755-770）**：
  - 容器圆角：`border-radius: 22px;` 形成流线型现代化胶囊；
  - 背景与边框：`background: var(--composer-bg); border: 1px solid var(--border-color); box-shadow: none;`；
- **极度克制的聚焦混色（Lines 776-794）**：
  - 常规态：`border-color: color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%);`；
  - 空态特例：`border-color: color-mix(in srgb, var(--border-color) 95%, var(--text-primary) 5%);`；
- **墨绿色 32px 弹性正圆发送按钮（Lines 924-990）**：
  - 初始隐藏：`width: 0; min-width: 0; margin-left: 0; opacity: 0; transform: scale(0.7);`；
  - 激活展开：`width: 32px; min-width: 32px; margin-left: 6px; opacity: 1; transform: scale(1);`；
  - 贝塞尔过渡：`transition: width 200ms cubic-bezier(0.16, 1, 0.3, 1), margin-left 200ms, opacity 160ms;`。

---

## 三、关键运行机制与核心时序深度剖析

### 3.1 状态真相源与发送回流机制（Host SSOT & Flush-on-Send）

在现代前端富文本体系中，多源状态漂移是导致偶发 Bug 的最主要诱因。在 Crish 对话输入中枢中，架构确立了**宿主唯一真相源（Host as SSOT）** 原则：

```
[编辑器内核 Tiptap]                          [适配层 TiptapComposerField]              [宿主 useChatComposerProps]
         │                                              │                                          │
         │ (用户键入字符)                                 │                                          │
         ├─────────────────────────────────────────────>│ (150ms 防抖更新)                          │
         │                                              ├─────────────────────────────────────────>│ onChange(markdown)
         │                                              │                                          │ 写入 chatInput
         │                                              │                                          │
         │ (用户敲击 Enter 键)                           │                                          │
         ├─────────────────────────────────────────────>│ 1. 立即同步序列化最新 Markdown             │
         │   onSendMarkdown(latestMd)                   │ 2. onChange(latestMd) 强刷宿主            │
         │                                              │ 3. sendRequestRef = latestMd             │
         │                                              │ 4. setSendTick(t + 1)                    │
         │                                              │                                          │
         │ editor.commands.clearContent()               │                                          │
         │   清空触发 onMarkdownChange("")               │                                          │
         ├─────────────────────────────────────────────>│ 5. 发现 sendRequestRef !== null          │
         │                                              │    ==> 强行吞没清空回流，不触发 onChange    │
         │                                              │                                          │
         │                                              │ [React 完成重渲染，携带最新 props]          │
         │                                              │ 6. 校验 !disabled && canSend             │
         │                                              │ 7. 清除 sendRequestRef                   │
         │                                              ├─────────────────────────────────────────>│ onSend()
         │                                              │                                          │ 真正消费 chatInput
         │                                              │                                          │ 并执行发送流程
```

- **时序死锁防范**：
  若没有 `sendRequestRef` 的拦截，编辑器清空操作发出的 `onChange("")` 将在极短时间内覆盖宿主的 `chatInput`，导致宿主在触发 `onSend` 时拿到的发送内容为空，用户输入的内容凭空蒸发。
- **重渲染最新属性守卫**：
  `disabled` 与 `canSend` 是由宿主依据最新 `chatInput` 经业务规则计算出来的属性。在按键敲击瞬间，闭包中的 `canSend` 可能是基于 150ms 前旧文本计算的值。因此，通过 `sendTick` 递增触发 React 的重新渲染，使得发送守卫逻辑能够在**最新衍生状态**下进行最终裁决，彻底消除了异步竞态。

### 3.2 选区同步与 IME 输入法合成保护（CRM-03 三条件防线）

中文、日文等 CJK 语言环境依赖输入法编辑器（IME）将拼音/罗马音转换为对应字符。输入法在操作过程中会频繁使用 Enter（确认拼音上屏）、Space（确认首选字词）、上下左右键（挑选候选词）以及 Escape（放弃本次输入）。若编辑器未实现严苛的合成保护，会导致灾难性的交互破坏。

#### 三条件联合判定网关数学模型

设输入状态为 $S_{	ext{IME}}$，其判定函数定义为：

$$S_{	ext{IME}} = V_{	ext{composing}} \lor E_{	ext{isComposing}} \lor R_{	ext{composingRef}}$$

其中：
- $V_{	ext{composing}}$：ProseMirror `EditorView.composing` 属性；
- $E_{	ext{isComposing}}$：原生 `KeyboardEvent.isComposing`（含 `event.keyCode === 229` 或 `event.key === 'Process'` 兼容判定）；
- $R_{	ext{composingRef}}$：挂载在真实 DOM 上的 `compositionstart` / `compositionend` 事件状态引用。

```
                                  [按键事件到达 Keydown]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       │   计算 S_IME (三条件联合逻辑或)            │
                       └─────────────────────┬─────────────────────┘
                                             │
                        ┌────────────────────┴────────────────────┐
                        │                                         │
                 [S_IME === True]                          [S_IME === False]
                        │                                         │
                        ▼                                         ▼
            [IME 合成态绝对放行分支]                      [正常按键分发网关]
            - 返回 false                                  - Shift+Enter: 硬换行
            - 阻止消息发送                                - CodeBlock: 换行保护 / Tab 缩进
            - 阻止建议菜单选词                            - Enter / Ctrl+Enter: 发送
            - 光标坐标冻结为稳定缓存                      - Escape: 主动退出建议状态
```

- **光标坐标静止机制**：在 `SlashExtension` 与 `DirTreeExtension` 的 `clientRect` 闭包中，检测到 $S_{	ext{IME}} = 	ext{True}$ 时，立即返回上一帧的 `lastCachedBox` 稳定包围盒。由于拼音下划线变化会导致 DOM 选区频繁突变，坐标静止机制确保了浮动菜单在用户选词过程中绝不会因微小的亚像素位移而剧烈抖动。

### 3.3 Slash 菜单与提及建议的浮层生命周期（Radix Popover & WAI-ARIA）

斜杠命令与提及建议的交互由底层 `@tiptap/suggestion` 状态机与上层 `@radix-ui/react-popover` 容器协同驱动：

```
[用户输入 '/' 或 '@']
        │
        ▼
[Suggestion 插件命中字符匹配]
        │
        ▼
[createSuggestionRenderer.onStart 激活]
        │
        ├─> 调用 safeViewDom，在编辑器 DOM 挂载无障碍属性:
        │   aria-expanded="true", aria-controls="{listboxId}"
        │
        ├─> 实例化 ReactRenderer(TiptapSlashMenu)
        │
        └─> 计算初始 safeCursorAnchor 几何包围盒
                 │
                 ▼
        [Radix Popover 挂载至 document.body (Portal)]
        - side: anchor.suggestedSide ("top" | "bottom")
        - onOpenAutoFocus: e.preventDefault() 拦截焦点转移，输入框保留焦点
        - onCloseAutoFocus: e.preventDefault() 拦截关闭焦点夺取
                 │
                 ▼
        [用户按键盘上下键 ArrowDown / ArrowUp]
                 │
                 ├─> onKeyDown 拦截并更新 selectedIndex
                 ├─> itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
                 └─> 编辑器 DOM 动态同步 aria-activedescendant="{listboxId}-opt-{index}"
                 │
                 ▼
        [用户按下 Enter / Tab 选中指令]
                 │
                 ├─> 执行 item.command({ editor, range })
                 ├─> 事务链: deleteRange(range) 删除触发字符并注入指令文本
                 └─> 触发 onExit 生命周期:
                          ├─> 清除 aria-expanded, aria-controls, aria-activedescendant
                          ├─> 销毁 ReactRenderer 实例
                          └─> 清空 lastCachedBox 坐标缓存
```

### 3.4 Markdown 双向序列化保真与 Schema 收敛（CRM-04）

#### 1. 为什么必须执行 Schema 收敛？
在传统富文本体系中，编辑器往往追求对所有 HTML/Markdown 块级元素（标题、多级列表、引用、表格）的全功能支持。但在现代即时对话流产品中，这种做法存在巨大缺陷：
- 输入框内部如果排布了巨大的 H1 标题或层层嵌套的列表缩进，会导致输入卡片高度被撑破，破坏界面的统一呼吸感；
- 更严重的是，未受控的块级节点在与复杂快捷键交互时，会导致 Backspace 行为极其不可控（例如用户误删整个列表容器或产生死节点）。

#### 2. 降维反序列化状态转移矩阵

```
Markdown 源码语法              反序列化降维处理 (Deserializer)             序列化还原 (Serializer)
------------------------------------------------------------------------------------------------
# 一级标题                   --> paragraph 节点 (text: "# 标题内容")      --> # 一级标题
## 二级标题                  --> paragraph 节点 (text: "## 标题内容")     --> ## 二级标题
- [ ] 待办项                 --> paragraph 节点 (text: "- [ ] 待办项")    --> - [ ] 待办项
- [x] 已完成项               --> paragraph 节点 (text: "- [x] 已完成项")  --> - [x] 已完成项
- 无序列表                   --> paragraph 节点 (text: "- 列表内容")      --> - 列表内容
1. 有序列表                  --> paragraph 节点 (text: "1. 列表内容")     --> 1. 列表内容
> 引用文本                   --> paragraph 节点 (text: "> 引用文本")      --> > 引用文本
```

- **全保真节点**：
  - 代码块：`codeBlock` 节点作为唯一合法块级节点保留，维持缩进与换行语义；
  - 行内 Mark：`bold`, `italic`, `strike`, `code`, `link` 原样映射为 ProseMirror Mark，支持任意复合嵌套；
  - 实体 Mention：`@[label](id:kind)` 与 `mention` Atom 节点 1:1 双向映射。

### 3.5 草稿原子暂存、防爆截断与撤销快照（CRM-02 Session Draft）

```
[外部传入新 content] ──> [防爆截断检测 (len > 100,000)]
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
       [超限: 执行硬切片]              [正常: 保持原样]
       追加 >[!WARNING] 警告
               │                             │
               └──────────────┬──────────────┘
                              ▼
                [脏检查: 与 lastContentRef 比较]
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
       [内容相同: 立即返回]            [内容变化: 调度 RAF]
                                             │
                                             ▼
                                 [parseFromMarkdown(safeContent)]
                                             │
                                             ▼
                                 [editor.commands.setContent]
                                             │
                                             ▼
                                 [更新 lastContentRef]
```

- **大文档告警（R-08）与草稿撤销（DraftUndoToast）**：
  - 当单次序列化长度突破 50,000 字符时，防抖末帧触发 `onOversizeWarning`；
  - 若外部 Prompt 模板在用户编辑途中强行覆盖输入，宿主触发 `DraftUndoToast`。底层通过内存快照栈暂存用户被覆盖的内容，在 6 秒内提供“一键原子还原”，彻底根除用户创作中断焦虑。

### 3.6 单行胶囊 ↔ 多行网格动态切换机制（Canvas 2D 离屏度量与迟滞死区）

#### 1. 离屏度量与虚拟单行容量计算
为了实现类似 macOS 原生胶囊输入框的平滑质感，系统在每帧通过 Canvas 2D 计算文本物理像素宽度：

$$	ext{Capacity} = \max\left(200	ext{px},\; W_{	ext{layout}} - \left(W_{	ext{left}} + W_{	ext{perm}} + W_{	ext{right}} + 18	ext{px}ight)ight)$$

#### 2. 双门限施密特迟滞状态转移方程

```
                           textWidth >= Capacity
       ┌─────────────────────────────────────────────────────────────┐
       │                                                             │
       ▼                                                             │
[多行网格态 Multiline]                                         [单行胶囊态 Single-line]
       │                                                             ▲
       │                                                             │
       └─────────────────────────────────────────────────────────────┘
                     textWidth < Capacity - 24px
```

- **迟滞死区（Hysteresis Buffer）**：设定 `24px` 的弹性死区。当文字达到容量上限时，展开为多行；但当文字删除时，必须缩短至容量下方 24px 以外，才允许收拢为单行。这种“易展难缩”的阻尼特性，彻底消除了用户在单行临界点徘徊时的剧烈排版跳变。

---

## 四、设计规范、视觉红线与无障碍门禁

### 4.1 零重阴影（Zero Box-Shadow）设计铁律

在现代化桌面应用 UI 规范中，过度的重阴影（Heavy Dropshadow）往往会带来界面脏乱、视觉焦点分散以及低端 GPU 渲染掉帧等问题。`TiptapEditorField.module.css` 与 `TiptapSlashMenu.module.css` 确立了**零重阴影原则**：

```css
/* 严格规约：输入容器与浮动面板仅允许 none */
.fieldWrapper {
  box-shadow: none;
}

.proseMirrorField,
.proseMirrorField:focus {
  box-shadow: none;
  outline: none;
}

.popoverContent {
  box-shadow: none;
}
```

- **界面层次呈现策略**：完全依赖 Design Token 定义的系统级背景材质梯度（`var(--bg-elevated)` vs `var(--bg-primary)`）以及亚像素细边框（`var(--hairline-width, 1px) solid var(--border-color)`）来界定卡片轮廓，使整个对话流保持现代极简的呼吸感。

### 4.2 纯 Token 驱动（Zero Hardcoded Colors & Z-Index）

在整个 `chat-composer` 域下，严禁出现任何硬编码的 Hex、RGB、RGBA 颜色或魔法数字 Z-Index：

| 规范检查项 | 违规表现（零容忍） | 规范落地形态（严格要求） | 架构设计意图 |
| :--- | :--- | :--- | :--- |
| **色彩空间** | `#ffffff`, `#1a1a1a`, `rgba(0,0,0,0.5)` | `var(--text-primary)`, `color-mix(in srgb, ...)` | 保证暗黑/明亮主题一键无损切换 |
| **浮层层级** | `z-index: 9999`, `z-index: 200` | `z-index: var(--z-popover)`, `var(--z-dock)` | 避免不同开发者设定的 z-index 发生恶性竞争 |
| **强调选区** | 浏览器默认深蓝高亮块 | `color-mix(in srgb, var(--accent-color) 12%, transparent)` | 提供柔和的文本阅读质感 |
| **占位提示** | `#999`, `#aaa` | `var(--text-tertiary)` | 遵循规范的三级文本对比度阶梯 |

### 4.3 极度克制的激活边框（≤10% 混入与 session-empty 5% 特例）

为了避免用户在长文本写作或沉浸式交谈时，输入框焦点态产生突兀刺眼的“黑眼圈”，边框颜色加深采用了极其克制的数学混入比：

1. **常规输入激活态（≤10% 铁律）**：
   ```css
   .composerCard:focus-within,
   .container:focus-within {
     border-color: color-mix(
       in srgb,
       var(--border-color) 94%,
       var(--text-primary) 6%
     );
   }
   ```
   基线边框色占 94%，文本色仅混入 6%，肉眼可见其微微加深，但绝无粗黑生硬感；
2. **全页空态特例（RL-01 规范）**：
   在无任何会话历史的全页空态落地输入框中（`[data-empty-kind='session-empty']`），对比度被进一步压缩至 5%：
   ```css
   .composerCard[data-empty-kind='session-empty']:focus-within,
   .container[data-empty-kind='session-empty']:focus-within {
     border-color: color-mix(
       in srgb,
       var(--border-color) 95%,
       var(--text-primary) 5%
     );
   }
   ```
   这种近乎微感知的光影变化，将视觉注意力完全让渡给居中的光标与引导文案。

### 4.4 墨绿色正圆发送按钮（32x32px Spring 展开动效）

Layer 4 的标志性视觉符号是右侧的**墨绿色正圆发送控制按钮（The Emerald Circle Button）**：

```css
.sendBtnCircle {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  width: 0;
  min-width: 0;
  padding: 0;
  margin-left: 0;
  opacity: 0;
  transform: scale(0.7);
  pointer-events: none;
  border-radius: 50%;
  border: none;
  background: var(--brand);
  color: var(--text-on-brand, white);
  transition:
    width 200ms cubic-bezier(0.16, 1, 0.3, 1),
    margin-left 200ms cubic-bezier(0.16, 1, 0.3, 1),
    opacity 160ms cubic-bezier(0.16, 1, 0.3, 1),
    transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
}

.sendBtnCircle.active {
  width: 32px;
  min-width: 32px;
  margin-left: 6px;
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
  box-shadow: 0 2px 6px color-mix(in srgb, var(--brand) 25%, transparent);
}
```

- **物理弹簧质感**：采用 `cubic-bezier(0.16, 1, 0.3, 1)`（超快入场、平滑制动），在用户敲入有效字符的瞬间，正圆按钮从 0px 宽度优雅弹出；
- **Hover 沉淀**：悬停时平滑过渡至深墨绿 `var(--brand-deep)`，带来极具质感的现代桌面触感。

### 4.5 W3C WAI-ARIA Combobox 全链路规范符合性审查

根据 W3C WAI-ARIA 1.2 Combobox Pattern，具有建议弹层的文本输入框必须建立严格的无障碍角色关系树。Layer 4 核心在无障碍契约上实现了 100% 的规范符合性：

```
[可编辑节点 role="combobox"]
  │
  ├─> aria-haspopup="listbox" (常驻: 声明弹出层为选项列表)
  ├─> aria-autocomplete="list" (常驻: 声明自动补全策略为列表式)
  │
  ├─> [弹层开启时动态注入]
  │     ├─> aria-expanded="true"
  │     └─> aria-controls="{listboxId}" ────┐
  │                                         │
  └─> [光标漫游时动态注入]                   │ (精准指针关联)
        └─> aria-activedescendant=          │
            "{listboxId}-opt-{index}" ──┐   │
                                        │   ▼
                         [浮动面板 div role="listbox" id="{listboxId}"]
                           │
                           ├─> [选项 button role="option" id="{listboxId}-opt-0"]
                           │     aria-selected={index === 0}
                           │
                           └─> [选项 button role="option" id="{listboxId}-opt-1"]
                                 aria-selected={index === 1} <──┘ (无障碍聚焦焦点追踪)
```

- 当弹层关闭或通过 Escape 退出时，`onExit` 生命周期会自动调用 `removeAttribute` 移除 `aria-expanded`, `aria-controls` 与 `aria-activedescendant`，完全符合盲人读屏软件对于 Combobox 状态清理的无障碍规范要求。

---

## 五、测试矩阵与质量断言分析

### 5.1 单元测试与集成测试资产分布

对话输入中枢拥有全仓密度最高的前端自动化测试套件，全面覆盖逻辑、视图、手势、按键与样式红线：

| 测试套件文件 | 测试环境 | 用例数量 | 核心断言与覆盖范围 |
| :--- | :---: | :---: | :--- |
| `TiptapComposerField.test.tsx` | JSDOM | 10 | 受控值水合、Enter 150ms 发送最新内容、防抖回流、IME 门、双态占位、空护栏、Stop L2 |
| `TiptapEditorField.test.tsx` | JSDOM | 15 | Mention 注册、CodeBlock Enter/Tab 保护、DOMPurify XSS 清洗、ARIA 全链、50KB 大文档告警 |
| `TiptapKeymap.test.ts` | JSDOM | 8 | 纯函数决策断言：Shift+Enter、CodeBlock 保护、快捷键偏好分发、IME 三条件联合判定 |
| `TiptapSlashMenu.test.tsx` | JSDOM | 7 | WO-13 物理行高包围盒与 +8px 安全间隙、WO-14 零点非投毒与视口出界判定、WO-19 IME 避让 |
| `TiptapVisualRedline.test.ts` | Node.js | 8 | 静态源码全检：零重阴影（box-shadow 仅 none）、无硬编码色、Z-Index token 化、焦点混色 ≤10% |
| `safeCursorAnchor.test.ts` | JSDOM | 12 | 几何探测器四级备援梯度判定、DPI 0.000031px 噪点过滤、24px 施密特迟滞回差数学模型 |
| `markdownSerializer.test.ts` | Node.js | 10 | GFM 序列化保真、任务清单多行缩进、Mention 元数据往返、T5 逐字稳定与收敛契约测试 |
| `markdownDeserializer.test.ts` | Node.js | 12 | 降维转换测试、复杂嵌套列表展开、CommonMark 翼规则防星号误吞、行内 Mark 复合嵌套 |

### 5.2 JSDOM 环境下的 ProseMirror 交互模拟策略

由于 JSDOM 环境缺乏浏览器原生的 Selection API、物理布局度量引擎以及真实文本编辑管线，测试套件构建了工业级的底层模拟器：

```typescript
async function typeText(text: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 60)); // 等待初始装配完成
  const dom = getEditorDom();
  const sel = document.getSelection();
  // 1. 在 DOM 树中精准找到目标段落并插入真实文本 TextNode
  // 2. 调度 Range API 更新选区至插入文字末尾
  // 3. 手动派发 new Event('input', { bubbles: true })
  // 4. 等待 ProseMirror DOMObserver flush 完成 (约 50ms)
  await new Promise((r) => setTimeout(r, 50));
}
```

- 该机制绕过了 `fireEvent.change` 无法触发 ProseMirror 事务的局限，确保在真实无头环境下测试编辑器对用户输入的真实反馈。

### 5.3 视觉红线源码级自动断言（TiptapVisualRedline.test.ts）

与常规的 DOM 渲染测试不同，`TiptapVisualRedline.test.ts` 采用了**源码静态分析断言（Static Source Code Assertion）**：
- 直接通过 `fs.readFileSync` 读取 CSS Module 源码文件；
- 使用正则全局匹配 `box-shadow:`，断言其值必须完全匹配 `/^none(?:\s+!important)?$/`；
- 正则扫描 `#[0-9a-fA-F]{3,8}` 与 `rgba?\(`，一旦有开发者提交了硬编码色值，门禁在 CI 阶段直接阻断；
- 正则提取所有 `var(--border-color) (\d+)%`，断言其混色百分比绝对不能低于 90%（即混入文本色不能超过 10%）。

### 5.4 几何防漂移与无遮挡断言（safeCursorAnchor.test.ts / WO-13 / WO-14）

- **WO-13 物理安全间距断言**：
  ```typescript
  const clearance = anchorRect.top - popoverBottom;
  expect(clearance).toBe(8); // 严苛断言：必须具备确切的 +8px 正向安全间距，绝对不可遮挡光标文字
  ```
- **WO-14 零点非投毒断言**：
  验证当编辑器返回 `(0, 0, 0, 0)`、负数尺寸或带有亚像素浮点噪点的包围盒时，`isPhysicallyVisibleNonZeroRect` 严格返回 `false`，确保四级备援降级链路被精准激活。

### 5.5 序列化 Roundtrip 保真测试集（markdownSerializer.test.ts）

- **逐字稳定断言**：
  ```typescript
  expect(serializeToMarkdown(parseFromMarkdown(markdown))).toBe(markdown);
  ```
  在 Mention 芯片、Markdown 链接、加粗斜体等标准行内元素上，验证经 AST 解析后重新生成的 Markdown 与输入完全一致；
- **收敛降维断言**：
  对于多层嵌套列表或引用块，深度遍历生成的 AST，断言其内部的已禁用节点类型（如 `heading`, `bulletList`, `taskList`, `blockquote`）集合大小为 0，彻底保证了历史草稿加载时的绝对安全。

---

## 六、现有架构边界缺陷与深度洞察

在对所辖源码与样式的逐行深入研读与现场实勘中，结合全套测试用例的运行表现，本导航提炼出以下五项亟待在后续原子化重构中根除的技术隐患与架构断层：

### 6.1 类型系统残余（any 类型断言与弱类型契约）

- **现状证据**：
  在 `TiptapEditorField.tsx:1`, `TiptapEditorExtensions.ts:1`, `SlashExtension.ts:1`, `composerTypes.ts:1` 等文件的第一行，均显式声明了 `/* eslint-disable @typescript-eslint/no-explicit-any */`；
- **具体隐患**：
  - `editorBridge.editorRef.current` 被标注为 `any`，导致调用 `editor.commands.setContent` 或 `editor.getJSON()` 时完全丧失了 IDE 智能补全与编译期类型保护；
  - 在 `handleKeyDown` 中，ProseMirror 的 `view: any` 以及 `event: KeyboardEvent | any` 被频繁降级为弱类型；
  - 许多事件防御依赖 `(event as any).nativeEvent?.isComposing` 或 `(view as any).input?.composing`，属于典型的运行时动态探测；
- **重构诉求**：在原子化封装中，必须引入严格的 `@tiptap/core` 与 `@tiptap/pm` 泛型契约，封装统一的 `EditorInstance` 强类型句柄，彻底消除 `any` 标注。

### 6.2 ProseMirror DOMObserver 异步同步时差与微小竞态

- **现状证据**：
  ProseMirror 底层依赖浏览器的 `MutationObserver` 监听 DOM 树微小变动并更新内部状态，内部设置了约 20ms 的 `flushSoon` 防抖队列；
- **具体隐患**：
  在极端高频打字并瞬间通过鼠标点击外部发送按钮的场景下，DOM 树上刚刚键入的字符尚未完全进入 ProseMirror 的 `view.state.doc` 中。此时若调用 `editor.getJSON()`，获取到的 AST 会遗漏最后 1~2 个字符。虽然现有代码在 `getMarkdown()` 中追加了 `editor.getText().trim()` 进行或操作兜底，但由于 `getText()` 缺乏 Markdown 行内样式标记，可能导致格式在边缘情况下短暂降级。

### 6.3 大文档全量序列化的性能边界与主线程预算

- **现状证据**：
  `TiptapEditorExtensions.ts` 中的 `onUpdate` 防抖回调与 `handleKeyDown` 中的 `send` 操作，均直接调用 `serializeToMarkdown(editor.getJSON())`；
- **具体隐患**：
  全量 AST 序列化是一个典型的 $O(N)$ 深度优先递归过程。当用户输入或粘贴超过 50KB（约 20,000~30,000 字）的代码段或长文本时，单次序列化在移动端或低性能 CPU 上可能耗费 25~45ms 的主线程时间，超出 16.6ms 的单帧预算，产生偶发掉帧；
- **重构诉求**：未来应引入**按块脏标记增量序列化（Incremental Block Serialization）** 算法，或借助 Web Worker 进行后台异步序列化。

### 6.4 建议插件在连续特殊符号键入时的边界竞争

- **现状证据**：
  系统在同一个编辑器内核中挂载了三个独立的 Suggestion 插件：
  1. `SlashExtension` 监听 `/`
  2. `MentionSuggestionExtension` 监听 `@`
  3. `DirTreeExtension` 监听 `@@`
- **具体隐患**：
  当用户快速连击 `@@` 时，第一个 `@` 会首先激活 `MentionSuggestionExtension`；在第二个 `@` 到达后，两个插件的状态机在微秒级时间内同时处于待命中态。目前的解决方式是在提及插件的 `allow` 钩子中增加硬编码判断：`if (text.startsWith('@@')) return false;`。这种在插件 A 中探测插件 B 词法标记的打补丁方式破坏了扩展的独立性；
- **重构诉求**：需要构建一个统一的**词法建议调度总线（Suggestion Token Dispatcher）**，由总线统一裁决前缀符号的派发归属。

### 6.5 JSDOM 与真实 WebKit/Blink 运行时物理渲染差异

- **现状证据**：
  测试套件运行于 Vitest + JSDOM 环境下，所有 `coordsAtPos`、`getBoundingClientRect` 以及字体宽度度量均依赖单元测试中的 Mock 返回值；
- **具体隐患**：
  真实的 macOS / Windows WebView2 具有复杂的字重平滑、亚像素渲染机制与高分屏缩放比，JSDOM 无法测试真实的物理换行行为。部分在 JSDOM 中通过的测试，在真机环境下仍需依赖严格的 E2E 视觉回归保障。

---

## 七、输入内核原子化标准化提炼与演化方案

为了将当前散落在 `chat-composer` 业务目录中、高度耦合但经过实践检验的优秀内核提炼为可发布、可复用、高鲁棒性的**原子化组件库模块**，提出以下四层演进重构方案：

### 7.1 分层架构演化（Core / Headless / React / UI-Kit）

```
===================================================================================
                               @crish/composer-ui
 [UI 呈现层]: 纯展示型无状态组件与预设主题
 - ComposerLayout (四层空间堆叠卡片网格)
 - ComposerSendButton (墨绿色 32px 弹性正圆按钮)
 - ComposerInlineTag (Mention 实体芯片展示)
 - TiptapSlashMenu (基于 Radix Popover 的建议菜单视图)
 - MinimalBorderlessTheme, DenseSidebarTheme (CSS Module / Design Tokens 注入)
===================================================================================
                             @crish/composer-react
 [React 适配层]: 状态粘合、Context 共享与 Hooks 封装
 - ComposerProvider (集中管理 chatInput, disabled, canSend, sendTick)
 - useComposerContext (组件树跨层状态安全消费)
 - useComposerField (封装 Ref 桥接装配、发送回流、清空吞没)
 - useComposerMultiline (Canvas 2D 离屏度量与 24px 迟滞死区)
===================================================================================
                            @crish/composer-headless
 [无头交互层]: 无 DOM 渲染依赖的纯物理与状态逻辑
 - SafeCursorAnchorEngine (四级备援、物理行高恢复、24px 施密特迟滞、零点熔断)
 - KeymapDecisionResolver (Shift+Enter、CodeBlock 保护、IME 判定纯函数)
 - SuggestionTokenDispatcher (统一词素分发，消除 '/', '@', '@@' 竞争)
===================================================================================
                              @crish/composer-core
 [编辑器内核层]: 纯净富文本引擎与数据流转换
 - TiptapSchemaBuilder (裁剪 StarterKit，收敛至纯净行内修饰流)
 - MarkdownSerializerEngine (GFM AST 递归序列化)
 - MarkdownDeserializerEngine (降维反序列化，防 setContent 崩溃)
 - DOMPurifySanitizer (XSS 严格清洗守卫)
===================================================================================
```

### 7.2 @crish/composer-core：跨框架 Headless 编辑器内核规划

1. **零外部框架依赖**：`@crish/composer-core` 仅依赖 `@tiptap/core`, `@tiptap/pm` 与 `dompurify`，可在 React, Vue 乃至纯 Vanilla JS 中无缝运行；
2. **强类型配置工厂**：
   ```typescript
   export interface ComposerCoreOptions {
     sendShortcut: 'enter' | 'ctrlEnter';
     oversizeWarnThreshold: number; // 默认 50,000
     maxContentLength: number;      // 默认 100,000
     codeBlockIndent: '  ' | '    '; // 2 空格或 4 空格
   }

   export function createComposerEditor(options: ComposerCoreOptions): Editor;
   ```
3. **内置增量序列化缓存**：维护 AST 节点的哈希缓存，仅对变更段落重新执行序列化，将长文本序列化耗时压低至 2ms 以内。

### 7.3 @crish/composer-react：Hooks、Context 与状态管理适配层

1. **`ComposerProvider` 单一入口**：
   ```tsx
   <ComposerProvider
     value={chatInput}
     onChange={setChatInput}
     onSend={handleSend}
     canSend={canSend}
   >
     <ComposerLayout>
       <ComposerField />
       <ComposerSendButton />
     </ComposerLayout>
   </ComposerProvider>
   ```
2. **状态全自动托管**：将当前散落在 `TiptapComposerField.tsx` 中的 `sendRequestRef`、`sendTick`、清空回流拦截以及外置按钮 `flushAndSend` 封装为 `useComposerField` 内部状态机，外层业务无需关注任何底层微任务时序。

### 7.4 @crish/composer-ui：原子化组件与主题样式注入

1. **无头原语与插槽化（Slot Architecture）**：
   - 彻底将输入框与外层网格卡片解耦，输入框只关心自身内容，外层网格只关心网格槽位划分；
2. **CSS 变量标准契约注入表**：
   外部主题只需覆写以下 8 个标称 CSS 变量即可实现全新皮肤定制：
   - `--crish-composer-bg`: 输入卡片背景材质；
   - `--crish-composer-border`: 基线边框色；
   - `--crish-composer-focus-mix`: 聚焦加深混入比例（默认 6%）；
   - `--crish-composer-brand`: 发送按钮主题色（默认墨绿）；
   - `--crish-composer-brand-hover`: 发送按钮悬停色；
   - `--crish-composer-radius`: 外框圆角（默认 22px）；
   - `--crish-composer-line-height`: 基础行高（默认 1.45）；
   - `--crish-composer-max-lines`: 最大伸缩行数（默认 10 行）。

### 7.5 标准化契约与配置扩展规范

为支持工作台未来可能接入的“多模态语音输入”、“公式实时预览”、“表格轻量编辑”等高级场景，在适配层定义标准的插件扩展规范：

```typescript
export interface ComposerExtensionPlugin {
  /** 插件唯一命名 */
  name: string;
  /** 绑定的前缀触发词 (如 '/', '@', '#', '!') */
  triggerChar?: string;
  /** ProseMirror 扩展工厂 */
  extension: Extension | Node | Mark;
  /** 浮动建议面板渲染组件 */
  suggestionPanel?: React.ComponentType<{
    query: string;
    onSelect: (item: any) => void;
    onClose: () => void;
  }>;
}
```

### 7.6 演化迁移路径与防退避落地步骤

为彻底贯彻仓库的**反退避铁律（LOGIC_PLAN_NO_RETREAT.md）**，组件库原子化重构必须按部就班分步推进，禁止一刀切暴力替换：

```
+─────────────────────────────────────────────────────────────────────────+
| 阶段一：实勘建档与契约锁定 (当前阶段)                                     |
| - 完成 06 实勘导航文档，全息锁定全部 20 个源码与样式资产的设计细节       |
| - 固化测试矩阵，确保既有 78+ 用例成为不可破坏的质量红线                 |
+─────────────────────────────────────────────────────────────────────────+
                                    │
                                    ▼
+─────────────────────────────────────────────────────────────────────────+
| 阶段二：底层算法包独立抽取 (Packages 抽取)                              |
| - 创建 packages/composer-core 与 packages/composer-headless            |
| - 提取 markdownSerializer, safeCursorAnchor, TiptapKeymap 纯函数         |
| - 现有 apps/crish-desktop 源码改用新 package 导出，零破坏性业务迁移     |
+─────────────────────────────────────────────────────────────────────────+
                                    │
                                    ▼
+─────────────────────────────────────────────────────────────────────────+
| 阶段三：UI 控件原子化与 CSS Module 治理                                 |
| - 提取 @crish/composer-ui，拆分为 Atom 与 Molecule 粒度组件             |
| - 统一样式至标准 CSS 变量体系，彻底清退残留的行内魔术数字               |
+─────────────────────────────────────────────────────────────────────────+
                                    │
                                    ▼
+─────────────────────────────────────────────────────────────────────────+
| 阶段四：全链路门禁验收与架构闭环                                         |
| - 运行全量 Vitest 测试套件、视觉红线断言与 Rust 73 测试套件             |
| - 在真实 Tauri 桌面端验证 120Hz 滚动与中文/日文输入法实测表现           |
| - 达成架构净收敛，消除所有 any 类型与打补丁代码                         |
+─────────────────────────────────────────────────────────────────────────+
```

---

## 八、总结与实勘结论

通过对 Layer 4 对话输入中枢（`TiptapComposerField`, `TiptapEditorField`, `TiptapEditorExtensions`, `TiptapSlashMenu`, `TiptapKeymap`, `ComposerField`, `safeCursorAnchor` 等）全量源码、样式体系与测试套件的逐行深度实勘，可以得出以下核心结论：

1. **工程成熟度极高**：该编辑器内核绝非简单的组件拼装，而是针对桌面级 AI 交互深度定制的工业级解决方案。其独创的“Ref 桥接装配模式”、“CRM-03 输入法三条件联合防御”、“四级几何安全光标探测器”以及“24px 施密特双门限迟滞回差”，展现了极深厚的前端架构工程底蕴，彻底解决了富文本领域数项困扰已久的历史难题；
2. **设计美学严谨克制**：样式层面严格遵守“零重阴影”、“纯 Token 驱动”与“焦点边框 ≤10% 混入”红线，配合 32px 墨绿色正圆按钮的物理弹簧动效，实现了现代、扁平、轻盈的视觉交互质感；
3. **具备极其明确的原子化提炼条件**：核心按键决策、几何探测算法与 Markdown 序列化引擎已高度纯逻辑化，完全具备向 `@crish/composer-core` 与 `@crish/composer-ui` 独立分层包演进的条件。

本导航文档全景记录了该模块的技术脉络与所有实现细节，为前端原子化组件库战役的后续方案落地提供了不容置疑的事实依据与演进灯塔。
