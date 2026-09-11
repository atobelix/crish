# 对话界面与交互缺陷修复：方案评审与最终裁决报告

> **文档标识**：`docs/chat-ui-interaction-repair/plan-reviews/01-final-verdict.md`
> **评审角色**：系统总架构师（Lead Architect & Reviewer）
> **评审对象**：
> - 方案 A：[`docs/chat-ui-interaction-repair/proposals/01-resilient-architecture-plan.md`](../proposals/01-resilient-architecture-plan.md)（系统架构与工程韧性专家）
> - 方案 B：[`docs/chat-ui-interaction-repair/proposals/02-perf-precision-ui-plan.md`](../proposals/02-perf-precision-ui-plan.md)（性能与像素级视效专家）
> **评审日期**：2026-08-20
> **裁决状态**：**APPROVED（融合采纳，准入施工）**

---

## 一、评审背景与输入资产

在 Conex / Crish 桌面端聊天界面的长期演进中，局部组件衍生出了 4 项严重的视效与交互退化缺陷：
1. 输入框（Composer）在临界文本长度下出现一个大一个小同时存在、以 144Hz 极高频率切换抖动（视觉双重视效重影）；
2. 聊天区域右侧滚动刻度（FlowScrubber）出现高达数百像素的粗大深灰实心方块畸变；
3. Markdown 渲染出的代码块与文件目录树（`dir`/`tree`）出现无样式的原生 HTML「复制」按钮，严重压盖文本排版；
4. 消息操作栏中部分按钮（`_buttonGhost_... _buttonSm_...`）与邻近图标按钮尺寸不一致，且右上角存在悬空突兀的提示气泡。

三位独立排查专家（`01-layout-inspector.md`、`02-interaction-inspector.md`、`03-rendering-inspector.md`）在**严禁阅读任何既有方案文档、纯靠独立翻阅真实源码**的盲测排查下，精准锁定了上述问题的代码行号与深层因果链。基于此，方案 A 与 方案 B 进一步给出了两套完整的综合实施方案。

---

## 二、方案 A vs 方案 B 深度交叉评审

```
┌──────────────────────────┬──────────────────────────────────────────────┬──────────────────────────────────────────────┬──────────────────────────────────────────────┐
│ 评审维度                 │ 方案 A（系统架构与工程韧性）                 │ 方案 B（极客性能与像素视效）                 │ 最终裁决与融合决策                          │
├──────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ 1. 输入框 144Hz 振荡重影 │ · 双门限施密特迟滞（展开≥C，收起<C-24px）    │ · 施密特迟滞带（24px Deadband）              │ 🏆 采纳方案 A 架构模型 + 方案 B 性能优化：   │
│                          │ · 虚拟单行基准解耦（不受多行 DOM 展开宽度干扰）│ · 单例 Canvas 2D 离屏度量（0.015ms，0回流）  │ 采用虚拟单行几何预算 + 24px 施密特迟滞死区 + │
│                          │ · 120ms 内反转≥3次触发 400ms 锁定自愈熔断    │ · RAF 批处理调度与微动画平滑过渡             │ Canvas 2D 离屏度量 + 120ms 反转熔断器。      │
├──────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ 2. FlowScrubber 刻度畸变 │ · Slot-Marker 架构解耦（透明 Slot 吸收 flex）│ · 100% 还原 reference 动效阶梯：             │ 🏆 采纳方案 A 架构解耦 + 方案 B 像素级复刻： │
│                          │ · .tick 实体强制锁定 2px 细针               │   8px(常态) -> 16px(激活) -> 32px(悬停)      │ Slot-Marker 物理分离，锁定 height: 2px 细针；│
│                          │ · 6px 上下 + 20px 向左隐形 Hitbox            │ · 轨道悬停 gap: 8px -> 12px 展开             │ 完整复刻 reference 的 8/16/32px 阶梯动效与   │
│                          │                                              │ · 14px 零碰撞槽位与 20px 隐形 Hitbox         │ 14px 滚动槽位 + 20px 隐形扩展 Hitbox。       │
├──────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ 3. Markdown 代码块复制钮 │ · 全局注入 .md-code-block 相对定位包含块     │ · 毛玻璃悬浮胶囊（backdrop-filter: blur(8px)│ 🏆 融合采纳 A + B 终极规范：                 │
│                          │ · .md-code-copy 绝对定位 top:6px, right:8px  │ · 三重排版协同（面包屑 + 语言 Tag + 复制钮） │ .md-code-block relative 包含块 +            │
│                          │ · ASCII 目录树/等宽排版 0 字符压盖           │ · 复制成功 1.8s Sage 绿色渐变微反馈          │ .md-code-copy 绝对定位毛玻璃悬浮胶囊，       │
│                          │                                              │                                              │ 配备 Sage 绿色微反馈，ASCII 目录树零压盖。   │
├──────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────┤
│ 4. 按钮尺寸与悬空气泡    │ · 统一纯图标为 22px 正方形标尺               │ · 统一 22px / 24px 原子类，补齐 SendToNote   │ 🏆 融合采纳 A + B 治理闭环：                 │
│                          │ · 隐形元素强制 pointer-events: none 阻断     │ · Tooltip 增加 isPositionReady 测量锁        │ 补齐 SendToNote 的 iconBtn 类名；            │
│                          │ · 首帧未测量坐标禁止触发 CSS 显形动画        │ · 用户 pinBadge 内聚为气泡内角标，清理冗余   │ 隐形元素补齐 pointer-events: none；          │
│                          │                                              │                                              │ Tooltip 增加 isPositionReady 首帧防闪烁门禁。│
└──────────────────────────┴──────────────────────────────────────────────┴──────────────────────────────────────────────┴──────────────────────────────────────────────┘
```

---

## 三、裁决细则与落地契约

### 1. 输入框（Composer）防抖与多行切换
- **虚拟单行基准（Decoupled Baseline）**：
  判定可用容量 $\text{Capacity}_{\text{single}}$ 时，必须始终基于「容器总宽减去单行控件固定宽度」，严禁在展开后使用多行态通栏宽度进行反向度量；
- **施密特迟滞（Schmitt Trigger）**：
  展开门限：$W_{\text{text}} \ge \text{Capacity}_{\text{single}}$；
  收起门限：$W_{\text{text}} < \text{Capacity}_{\text{single}} - 24\text{px}$；
  在 $[\text{Capacity} - 24\text{px}, \text{Capacity}]$ 死区内保持当前状态不变；
- **Canvas 2D 离屏度量**：
  废弃在 `document.body` 挂载 `<span>` 的昂贵 DOM 回流方案，采用单例 Canvas 2D `ctx.measureText()`，测量耗时降至微秒级；
- **振荡熔断器（Oscillation Breaker）**：
  在 `120ms` 时间窗口内状态反转计数 $\ge 3$ 次时，强制锁定多行态 `400ms`，彻底消灭极端打字场景下的死锁。

### 2. FlowScrubber 滚动刻度体系
- **Slot-Marker 解耦**：
  将 `style={{ flexGrow: tick.flex }}` 移入外层透明容器 `.tickSlot`，实体 `.tick` 强制锁定 `height: 2px; flex: 0 0 2px;`；
- **动效阶梯对齐**：
  - 常态未激活：`width: 8px; opacity: 0.35;`
  - 当前视口激活：`width: 16px; opacity: 0.6;`
  - 轨道悬停激活：`width: 24px; opacity: 0.75;`
  - 刻度自身悬停：`width: 32px; opacity: 1;`
  - 轨道悬停间距展开：`gap: 8px -> 12px;`
- **防脱靶 Hitbox**：
  通过 `::before` 伪元素实现上下 `8px`、向左 `20px` 的隐形扩展命中区，严禁向右侵入滚动条槽位。

### 3. Markdown 代码块与复制按钮
- **包含块与定位**：
  全局注入 `.md-code-block { position: relative; }`；
  `.md-code-copy { position: absolute; top: 6px; right: 8px; z-index: 5; }`；
- **视效材质**：
  半透明毛玻璃底色（`backdrop-filter: blur(8px)`），常态 `opacity: 0`，代码块 Hover 或按钮 Focus 时 `opacity: 1` 优雅平滑渐入；
  点击复制后展示“已复制 ✓”并触发 1.8s Sage 绿色反馈。

### 4. 操作栏按钮与 Tooltip 浮层治理
- **按钮尺寸统一**：
  在 `ChatSendToNoteEntry.tsx` 中补齐 `className={styles.iconBtn}`，使所有消息操作按钮统一为 `22px × 22px` 正方形无内边距标尺；
- **隐形元素物理阻断**：
  为思维链 `.thoughtExpandModalBtn` 等设置了 `opacity: 0` 的元素显式增加 `pointer-events: none;`，Hover 时再激活 `pointer-events: auto;`，根除虚空触发；
- **Tooltip 首帧测量门禁**：
  在 `Tooltip.tsx` 中增加 `isPositionReady` 标记，当 `clampedPos === null`（坐标未测量计算完成）时，强制应用 `visibility: hidden; animation: none;`，彻底根除首帧未就绪时的关键帧闪烁。

---

## 四、执行路线与子 Agent 分工

本次实施分为 3 个专业执行角色流水线落地：

1. **Agent 1（交互与状态机工程师）**：
   - 改造 `useComposerMultiline.ts`，落地 Canvas 2D 度量、24px 施密特迟滞区间与振荡熔断器；
   - 改造 `ChatComposer.module.css`，完善单多行网格过渡。
2. **Agent 2（UI 视效与刻度工程师）**：
   - 改造 `FlowScrubber.tsx`、`flowScrubberModel.ts` 与 `FlowScrubber.module.css`，落地 Slot-Marker 解耦与 reference 动效阶梯；
   - 改造 `design-system.css` / 全局样式，落地 `.md-code-block` 与 `.md-code-copy` 绝对定位毛玻璃胶囊；
   - 改造 `ChatSendToNoteEntry.tsx`、`TimelineThoughtSection.tsx` 与 `Tooltip.tsx`，修复按钮尺寸、隐形事件阻断与首帧测量门禁。
3. **Agent 3（门禁与全量测试工程师）**：
   - 编写单元测试（迟滞门限断言、刻度物理高度断言、Tooltip 门禁断言）；
   - 执行全量 `typecheck`、`vitest` 及 `check-line-counts` 门禁。

---

**裁决结论：批准融合方案，总纲文档已同步沉淀至 `docs/chat-ui-interaction-repair/00-总方案.md`，即刻转入施工阶段！**
