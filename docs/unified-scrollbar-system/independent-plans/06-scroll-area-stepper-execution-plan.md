# 06 · ScrollArea 组件上下圆角三角步进器与高频出口落地执行详案
## （维度 4 & 5：ScrollArea 优雅三角步进器、2px 防误触间隙与 ModelBadgePickerMenu 首选落地）

> **文档标识**：`docs/unified-scrollbar-system/independent-plans/06-scroll-area-stepper-execution-plan.md`  
> **所属战役**：统一通用滚动条系统重构战役（Unified Scrollbar System）  
> **角色定位**：战役组件与引擎落地规划专家（Component & Engine Planner）  
> **编制基准时间**：2026-09-02  
> **权威准则**：
> - `AGENTS.md`（通用协作纪律、反退避铁律、多 Agent 调度规则、Git 提交纪律、§7 严禁补丁/绕过、§7.1 立体验证纪律）；
> - `ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计硬性红线：零冗余 DOM 节点、零主线程卡顿、零反向依赖）；
> - `apps/crish-desktop/src/components/ui/README.md`（UI 原子层纯净第一层契约，严格通过 `npm run check:ui-layer`）；
> - 用户最高定案指令与真机截图 `media_1788348026546.png`。

---

## 目录

- [一、用户最高指示宣誓与核心认知纠偏](#一用户最高指示宣誓与核心认知纠偏)
  - [1.1 「只调灰度、底色绝对不动」光学物理铁律](#11-只调灰度底色绝对不动光学物理铁律)
  - [1.2 「拒绝 mini 伪元素、回归模型选择界面优雅大圆角三角」标杆还原](#12-拒绝-mini-伪元素回归模型选择界面优雅大圆角三角标杆还原)
  - [1.3 「右侧 2px 物理透明防误触间隙」刚性几何空间红线](#13-右侧-2px-物理透明防误触间隙刚性几何空间红线)
  - [1.4 「先改哪、再改哪、让子 Agent 计划落地」多智能体规划法则](#14-先改哪再改哪让子-agent-计划落地多智能体规划法则)
- [二、微型圆角三角矢量几何与 SVG 高精重构](#二微型圆角三角矢量几何与-svg-高精重构)
  - [2.1 伪元素 mini 挤压与尖锐毛刺的病理剖析](#21-伪元素-mini-挤压与尖锐毛刺的病理剖析)
  - [2.2 优雅等腰圆角三角矢量数学建模（底宽 5.0px × 高 3.8px）](#22-优雅等腰圆角三角矢量数学建模底宽-50px--高-38px)
  - [2.3 规范化 SVG 贝塞尔矢量路径定义（Up / Down）](#23-规范化-svg-贝塞尔矢量路径定义up--down)
  - [2.4 色彩挂接与状态同步：仅调灰度、无方块背景框](#24-色彩挂接与状态同步仅调灰度无方块背景框)
- [三、三段式物理隔离轨道与端点安全护栏落地](#三三段式物理隔离轨道与端点安全护栏落地)
  - [3.1 机械限位挡块盒模型（8px Button + 2px Gap + Isolated Track）](#31-机械限位挡块盒模型8px-button--2px-gap--isolated-track)
  - [3.2 绝对防压盖定理：滑块与箭头恒有 2px 物理真空带](#32-绝对防压盖定理滑块与箭头恒有-2px-物理真空带)
  - [3.3 极端圆角断头台切角动态避让（calculateSafeAreaInset 落地）](#33-极端圆角断头台切角动态避让calculatesafeareainset-落地)
  - [3.4 算术下溢退化紧凑态（极端小视口自动降级）](#34-算术下溢退化紧凑态极端小视口自动降级)
  - [3.5 18px 物理像素滑块夹持与基于 Track 的绝对偏移](#35-18px-物理像素滑块夹持与基于-track-的绝对偏移)
  - [3.6 滑块 Pointer Capture 拖拽引擎全生命周期接管](#36-滑块-pointer-capture-拖拽引擎全生命周期接管)
- [四、右侧 2px 物理透明防误触间隙架构与实现](#四右侧-2px-物理透明防误触间隙架构与实现)
  - [4.1 2px 物理呼吸间距的人机工程学价值](#41-2px-物理呼吸间距的人机工程学价值)
  - [4.2 Mode 1（ScrollArea）实现：right: 2px + trackMargin 契约](#42-mode-1scrollarea实现right-2px--trackmargin-契约)
  - [4.3 Mode 2（全局 overlay-scrollbar.css）协同一致性保障](#43-mode-2全局-overlay-scrollbarcss协同一致性保障)
- [五、首选试验田：ModelBadgePickerMenu 100% 完美接入方案](#五首选试验田modelbadgepickermenu-100-完美接入方案)
  - [5.1 ModelBadgePickerMenu 几何与交互解剖](#51-modelbadgepickermenu-几何与交互解剖)
  - [5.2 改造前后 DOM 与 CSS 结构净收敛对比](#52-改造前后-dom-与-css-结构净收敛对比)
  - [5.3 ScrollArea 参数装配与契约配置（radius={14}, trackMargin={2}）](#53-scrollarea-参数装配与契约配置radius14-trackmargin2)
  - [5.4 关键交互保活：魔鬼用例 5 滚动防脱轨与键盘漫游无感兼容](#54-关键交互保活魔鬼用例-5-滚动防脱轨与键盘漫游无感兼容)
  - [5.5 现有 27 项单测全量无回归保障](#55-现有-27-项单测全量无回归保障)
- [六、具体执行步骤与子 Agent 派发规划（Wave 1 ~ Wave 5）](#六具体执行步骤与子-agent-派发规划wave-1--wave-5)
  - [6.1 阶段一（Wave 1）：Token 物理标定与矢量 SVG 规范对齐](#61-阶段一wave-1token-物理标定与矢量-svg-规范对齐)
  - [6.2 阶段二（Wave 2）：`<ScrollArea>` UI 原子组件完整落盘与出口打通](#62-阶段二wave-2scrollarea-ui-原子组件完整落盘与出口打通)
  - [6.3 阶段三（Wave 3）：`<ScrollArea>` 专项单元测试与红队魔鬼用例闭环](#63-阶段三wave-3scrollarea-专项单元测试与红队魔鬼用例闭环)
  - [6.4 阶段四（Wave 4）：`ModelBadgePickerMenu` 率先接入与视觉还原](#64-阶段四wave-4modelbadgepickermenu-率先接入与视觉还原)
  - [6.5 阶段五（Wave 5）：全仓门禁、双向回归与立体现场验收](#65-阶段五wave-5全仓门禁双向回归与立体现场验收)
  - [6.6 子 Agent 任务卡详尽定义（严格遵循 5-12 个规范）](#66-子-agent-任务卡详尽定义严格遵循-5-12-个规范)
- [七、立体验证与验收断言清单（Verification & Ratchet）](#七立体验证与验收断言清单verification--ratchet)
  - [7.1 静态与架构门禁刚性断言](#71-静态与架构门禁刚性断言)
  - [7.2 自动化测试用例矩阵](#72-自动化测试用例矩阵)
  - [7.3 视觉与物理光学现场验收断言](#73-视觉与物理光学现场验收断言)

---

## 一、用户最高指示宣誓与核心认知纠偏

### 1.1 「只调灰度、底色绝对不动」光学物理铁律

> **用户最高指示**：“未激活的时候黄色不都挺低的嘛，我说过了，只调整灰度，其他的不要动。”

在先前的实现尝试中，部分代码在悬停、激活或按钮绘制时，错误引入了黑色、深灰底色或随意编写的十六进制色值（例如 `#CCCBCA`、`#9e9d9c`、`var(--text-tertiary)` 甚至是突兀的方块背景投影），直接破坏了界面底色温润的物理连续性。

#### 光学物理真相与绝对约束：
1. **未激活态（Inactive / Resting）**：
   - 物理像素：`#eae8e6`（SSOT 契约：`--scrollbar-thumb-bg: #eae8e6`）；
   - 色彩空间参数：$H=30^\circ, S=2\%, L=92\%, K=8.24\%$；
   - **光学本质**：底色自带极其微弱（仅 2% 饱和度）的暖黄韵味，与应用的浅色暖纸卡片背景（`hsl(35, 10%, 98%)`）实现分子级自然融合，视觉毫无割裂感。用户明确指示“未激活的时候黄色不都挺低的嘛”，这一微量暖色是高品质界面的关键基底，**绝对禁止篡改色相 $H$ 与饱和度 $S$，更严禁换成冷蓝灰或生硬的纯黑白灰！**
2. **激活态（Active / Hover / Dragging 同色）**：
   - 物理像素：`#cdcccb`（SSOT 契约：`--scrollbar-thumb-active: #cdcccb`）；
   - 色彩空间参数：$H=30^\circ, S=2\%, L=80\%, K=19.8\% \approx 20.0\%$；
   - **调色铁律**：**色相 $H=30^\circ$ 绝对不动，饱和度 $S=2\%$ 绝对不动，只下调明度 $L$ 从 92% 至 80%（灰度 $K$ 从 8.2% 加深至 20.0%），两态差值严格死锁在 $12.0\% \pm 0.5\%$**！
3. **零第三态与零背景噪点**：
   - 悬停（Hover）、按压激活（Active）、鼠标拖拽中（Dragging），**全部赋予完全相同的 `--scrollbar-thumb-active` 色彩**；
   - 步进按钮背景永久为 `transparent`，**严禁添加任何带有透明度黑底（如 `color-mix(in srgb, var(--text-primary) 8%, transparent)`）的方块背景框**！按钮前景色在静止态消费 `--scrollbar-thumb-bg`，交互态消费 `--scrollbar-thumb-active`，与滑块同呼吸、共进退。

---

### 1.2 「拒绝 mini 伪元素、回归模型选择界面优雅大圆角三角」标杆还原

> **用户最高指示**：“这两个新增的三角这么mini嘛，之前模型选择界面那个不是挺好看的吗，你怎么又给我瞎改呢。”

#### 历史病灶剖析：为什么三角变成了“mini 畸形点”？
1. **尺寸压缩霸王条款**：先前在组件设计中，错误地将 `size="xs"`（4px 宽度）作为模型浮层的默认挡位，并粗暴将按钮尺寸压减为 4px × 4px；
2. **SVG ViewBox 与 Path 比例严重失衡**：在 10×10 的 ViewBox 内部，只写了一个顶底相差 4.5 个单位的尖锐折线（`d="M5 2.5 L8.2 7 H1.8 Z"`），经过 4px 外框缩放后，在物理屏幕上仅剩不到 2.2px 的微小点阵，完全看不出三角形态，更谈不上圆角；
3. **忽视真机截图标杆**：直接脱离了真机截图 `media_1788348026546.png`（即用户最满意的模型选择菜单原始视觉效果）的实测物理参数。

```
【先前错误实施的 mini 畸形小点】             【用户真机截图 media_1788348026546.png 优雅大圆角三角】
┌─────────────────────────┐               ┌─────────────────────────┐
│ 4px 狭窄轨道             │               │ 6px 优雅黄金轨宽        │
│    ·  ◄── 2.2px 萎缩尖刺 │               │    ▲   ◄── 5.0px 底宽   │ (顶角 R≈1.0px, 底角 R≈0.8px)
│    ░  (肉眼难辨，如同苍蝇屎)│             │   / \      3.8px 优雅高度│ (8px 充盈按钮盒，饱满精致)
│    █                    │               │    █                    │
│    ░                    │               │    █                    │
│    ·  ◄── 2.2px 萎缩尖刺 │               │    ▼   ◄── 5.0px 底宽   │
└─────────────────────────┘               └─────────────────────────┘
```

#### 标杆参数 100% 像素级对齐契约：
- **轨宽（Gutter Width）**：紧凑浮层采用 **6px**（介于 4px 与 7px 之间，完美承载大三角与防误触留白）；
- **按钮外包围盒**：高度严格为 **8px**，宽度等同于轨宽 6px，居中对齐；
- **等腰三角物理几何**：底边宽 **5.0px**，高度 **3.8px**（高宽比约 1:1.3，大方稳健，绝不显小）；
- **全顶点平滑圆角（Filleted Curves）**：顶角曲率半径 $R \approx 1.0\text{px}$，两底角曲率半径 $R \approx 0.8\text{px}$，高 DPI 视网膜屏幕下圆润优雅，绝无尖锐毛刺。

---

### 1.3 「右侧 2px 物理透明防误触间隙」刚性几何空间红线

> **用户核心需求**：“如何确保滚动条右侧严格保留 2px 物理透明防误触间隙”

滚动条贴死容器最右侧（$X = W_{\text{container}}$）是现代 UI 的常见低级错误。本方案将 **2px 物理透明防误触间隙** 确立为硬性几何空间红线：

```
容器物理右边框 (X = W)
│ ◄── 2px 物理透明防误触真空区 (Safe Clearance)
│     ┌───────┐
│     │   ▲   │ ◄── 顶部步进三角 (宽 6px)
│     │       │
│     │   █   │
│     │   █   │ ◄── 胶囊滑块 Thumb (宽 5px)
│     │   █   │
│     │       │
│     │   ▼   │ ◄── 底部步进三角 (宽 6px)
│     └───────┘
```

#### 三重保障机制：
1. **防止误触关闭与穿透**：ModelBadgePickerMenu 等弹窗外层存在卡片边框、Resize 边沿或宿主阴影，保留 2px 物理间距能彻底杜绝用户抓取滚动条时光标误触卡片外部或触发宿主边界事件；
2. **避让 14px 容器大圆角**：卡片拥有 `border-radius: 14px`，右侧内缩 2px 与纵向动态 Inset 形成代数协同，将滚动条牢固锁定在卡片平直内壁区域，免疫切角截断；
3. **呼吸感与现代工艺美学**：彻底消除贴边摩擦感，使滑块呈现出宛如悬浮在卡片内部的现代精致工艺质感。

---

### 1.4 「先改哪、再改哪、让子 Agent 计划落地」多智能体规划法则

依据 `AGENTS.md` §2（多 Agent 调度规则）：
- 遵循反退避铁律，方案纯逻辑规划，不砍功能、不以难为由退避；
- 每轮派发 **5–12 个**子 Agent，收尾前保底 ≥5，单层调用，绝对禁止嵌套派发；
- 方案制定先改哪、再改哪的串并行依赖，明确每个任务的输入、产出、验收断言与文件独占边界；
- 规划必须以“先改底座、再落组件、再写单测、再迁业务、最后总体验收”的标准工程管线推进。

---

## 二、微型圆角三角矢量几何与 SVG 高精重构

### 2.1 伪元素 mini 挤压与尖锐毛刺的病理剖析

在常规 CSS 中，开发者往往通过 `border-width` 配合透明边框拼凑三角形（Border Hack），或者声明 `viewBox="0 0 10 10"` 的粗糙多边形。此类做法存在两大致命缺陷：
1. **顶点无法设置独立圆角**：CSS Border 拼出的三角形三个顶点都是数学直角，经过抗锯齿模糊后，在高分屏上显得极其锐利刺眼；
2. **非矢量缩放形变**：当容器尺寸在 4px、5px、6px 间切换时，硬编码的像素边框发生非等比挤压，三角形迅速坍塌为不可名状的 mini 方块或小点。

### 2.2 优雅等腰圆角三角矢量数学建模（底宽 5.0px × 高 3.8px）

为实现截图 `media_1788348026546.png` 的优雅神韵，建立高精贝塞尔曲线数学模型：
- **坐标系基准**：定义矢量视口为 `0 0 5 4`（宽度 5.0 绝对单位，高度 4.0 绝对单位）；
- **顶部向上箭头（Up Arrow）**：
  - 顶角顶点：位于 $(2.5, 0.4)$，采用两段连续三次贝塞尔曲线过渡，曲率半径等效 $R \approx 1.0\text{px}$；
  - 左右底角：位于 $(4.6, 3.4)$ 与 $(0.4, 3.4)$，底角曲率半径等效 $R \approx 0.8\text{px}$；
  - 底边水平平直且带有 0.4px 的平滑描边连接；
- **底部向下箭头（Down Arrow）**：
  - 顶角向下顶点：位于 $(2.5, 3.6)$，曲率半径等效 $R \approx 1.0\text{px}$；
  - 左右顶端底角：位于 $(4.6, 0.6)$ 与 $(0.4, 0.6)$，曲率半径等效 $R \approx 0.8\text{px}$。

### 2.3 规范化 SVG 贝塞尔矢量路径定义（Up / Down）

在 `<ScrollArea>` 组件中，拒绝 mini 伪元素，内联注入标准化精细矢量 SVG：

```tsx
/** 顶部向上圆角矢量等腰三角 (100% 还原 media_1788348026546.png) */
export const StepperArrowUpIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 5 4"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '5px', height: '3.8px', display: 'block' }}
  >
    <path
      d="M2.1 0.6 C 2.3 0.25 2.7 0.25 2.9 0.6 L 4.6 3.2 C 4.8 3.5 4.6 3.9 4.2 3.9 L 0.8 3.9 C 0.4 3.9 0.2 3.5 0.4 3.2 Z"
      stroke="currentColor"
      strokeWidth="0.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);

/** 底部向下圆角矢量等腰三角 (100% 还原 media_1788348026546.png) */
export const StepperArrowDownIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 5 4"
    className={className}
    fill="currentColor"
    aria-hidden="true"
    style={{ width: '5px', height: '3.8px', display: 'block' }}
  >
    <path
      d="M2.1 3.4 C 2.3 3.75 2.7 3.75 2.9 3.4 L 4.6 0.8 C 4.8 0.5 4.6 0.1 4.2 0.1 L 0.8 0.1 C 0.4 0.1 0.2 0.5 0.4 0.8 Z"
      stroke="currentColor"
      strokeWidth="0.3"
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  </svg>
);
```

### 2.4 色彩挂接与状态同步：仅调灰度、无方块背景框

在 CSS Module 中，对按钮与箭头应用严苛的色彩契约：

```css
/* 步进按钮载体：透明无底框，饱满 8px 包围盒 */
.stepperButton {
  width: var(--scrollbar-button-width, 6px);
  height: var(--scrollbar-button-height, 8px);
  min-height: 8px;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent; /* 绝无方块底色！ */
  color: var(--scrollbar-thumb-bg); /* 静止态继承未激活滑块色 #eae8e6 (H=30 S=2% L=92%) */
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  outline: none;
  border-radius: var(--radius-xs, 2px);
  transition: color 120ms ease, opacity 120ms ease;
  user-select: none;
  touch-action: none;
}

/* 交互态（Hover、Active 统统同色）：仅调灰度至 #cdcccb，底色暖度绝对不变，绝无深色方块！ */
.stepperButton:hover:not(.disabled),
.stepperButton:active:not(.disabled) {
  color: var(--scrollbar-thumb-active); /* 激活态加深至 #cdcccb (H=30 S=2% L=80%) */
  background: transparent; /* 绝不产生方框背景污染！ */
}

/* 极限禁用态：到达端点时淡出 */
.stepperButton.disabled {
  opacity: 0.18;
  cursor: default;
  pointer-events: none;
}
```

---

## 三、三段式物理隔离轨道与端点安全护栏落地

### 3.1 机械限位挡块盒模型（8px Button + 2px Gap + Isolated Track）

`<ScrollArea>` 在右侧绝对定位一个独立的步进侧柱（`stepperTrackColumn`），内部采用刚性 Flex 垂直三段式隔离：

```
┌────────────────────────────────────────────────────────┐
│ Stepper Track Column (width: 6px, right: 2px)          │
│ ┌────────────────────────────────────────────────────┐ │
│ │ Top Button (height: 8px, background: transparent)  │ │ ◄── 上机械限位挡块
│ ├────────────────────────────────────────────────────┤ │
│ │ Safe Gap (height: 2px, transparent)                │ │ ◄── 上物理真空隔离带
│ ├────────────────────────────────────────────────────┤ │
│ │ Isolated Track (flex: 1, position: relative)       │ │ ◄── 独立游弋行程轨道
│ │   ┌──────────────────────────────────────────────┐ │ │
│ │   │ Thumb Indicator (width: 100%, 18px min-size) │ │ │     滑块行程被 100% 锁在
│ │   │ top: ${thumbTopPx}px (绝对像素定位)          │ │ │     该 Track 盒内，永不出圈！
│ │   └──────────────────────────────────────────────┘ │ │
│ ├────────────────────────────────────────────────────┤ │
│ │ Safe Gap (height: 2px, transparent)                │ │ ◄── 下物理真空隔离带
│ ├────────────────────────────────────────────────────┤ │
│ │ Bottom Button (height: 8px, background: transparent)│ │ ◄── 下机械限位挡块
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

### 3.2 绝对防压盖定理：滑块与箭头恒有 2px 物理真空带

#### 【数学防压盖完备性证明】
- **定义**：
  - 侧柱高度为 $H_{\text{col}}$；
  - 顶部按钮占据区间 $[0, 8\text{px}]$；
  - 顶部真空带占据区间 $[8\text{px}, 10\text{px}]$；
  - 独立轨道占据区间 $[10\text{px}, H_{\text{col}} - 10\text{px}]$；
  - 底部真空带占据区间 $[H_{\text{col}} - 10\text{px}, H_{\text{col}} - 8\text{px}]$；
  - 底部按钮占据区间 $[H_{\text{col}} - 8\text{px}, H_{\text{col}}]$。
- **推论**：
  - 滑块（Thumb）作为 `isolatedTrack` 的子元素，其 CSS 属性声明为 `position: absolute; top: ${thumbTopPx}px;`；
  - 由于 `thumbTopPx \in [0, H_{\text{track}} - H_{\text{thumb}}]`，滑块在侧柱全坐标系中的绝对坐标为：
    $$Y_{\text{thumb\_top}} = 10\text{px} + \text{thumbTopPx} \ge 10\text{px}$$
    $$Y_{\text{thumb\_bottom}} = 10\text{px} + \text{thumbTopPx} + H_{\text{thumb}} \le 10\text{px} + (H_{\text{track}} - H_{\text{thumb}}) + H_{\text{thumb}} = 10\text{px} + H_{\text{track}} = H_{\text{col}} - 10\text{px}$$
- **结论**：
  1. $Y_{\text{thumb\_top}} - Y_{\text{top\_btn\_bottom}} = 10\text{px} - 8\text{px} = 2\text{px}$；
  2. $Y_{\text{bot\_btn\_top}} - Y_{\text{thumb\_bottom}} = (H_{\text{col}} - 8\text{px}) - (H_{\text{col}} - 10\text{px}) = 2\text{px}$；
  3. **在全生命周期的任何滚动极限下，滑块边缘距离上下按钮边缘恒定保持严格的 2px 物理真空距离，绝无 1 像素重合，彻底杜绝压盖与点击击穿！**

---

### 3.3 极端圆角断头台切角动态避让（calculateSafeAreaInset 落地）

对于类似 `ModelBadgePickerMenu`（拥有 `border-radius: 14px` 与 `overflow: hidden`）的卡片浮层，顶部与底部按钮容易被卡片圆角斜向削切。通过以下算法动态计算安全内缩：

```typescript
/**
 * 极端圆角断头台切角动态安全避让算法 (M02 落地)
 * @param radius 容器外缘圆角半径 (如 14px)
 * @param margin 滚动条离容器右外边缘间距 (严格为 2px)
 * @returns 必须下移/上缩的纵向安全内距 (px)
 */
export function calculateSafeAreaInset(radius: number = 0, margin: number = 2): number {
  if (radius <= 0) return 0;
  // 圆心相对右边框为 -radius，滚动条右侧在 -margin
  const x = Math.max(0, radius - margin);
  const arcY = Math.sqrt(Math.max(0, radius * radius - x * x));
  const minInset = radius - arcY;
  // 加上 1px 防浮点光栅化溢出缓冲
  return Math.ceil(minInset) + 1;
}
```

- 在 `ModelBadgePickerMenu` 中：$R = 14\text{px}, M = 2\text{px} \implies x = 12\text{px}$；
- $\text{arcY} = \sqrt{14^2 - 12^2} = \sqrt{196 - 144} = \sqrt{52} \approx 7.21\text{px}$；
- $\text{minInset} = 14 - 7.21 = 6.79\text{px} \implies \text{ceil}(6.79) + 1 = 8\text{px}$；
- **避让效果**：侧柱顶部内缩 $\text{insetTop} = 8\text{px} + 2\text{px} = 10\text{px}$，顶部箭头被精准下移 10px，完全处于卡片右侧的平直内壁上，圆弧裁切率数学上严格为 **0%**！

---

### 3.4 算术下溢退化紧凑态（极端小视口自动降级）

当容器高度受限（例如弹窗在极小高度下被挤压），可用轨道高度出现算术下溢时触发平滑退化：
- 计算公式：$\text{AvailableTrackSpace} = H_{\text{viewport}} - (\text{insetTop} + \text{insetBottom}) - 2 \times 8\text{px} - 2 \times 2\text{px}$；
- **判定阈值**：当 $\text{AvailableTrackSpace} < 18\text{px}$（无法容纳最小 18px 滑块）时：
  1. 自动自毁并隐藏上下三角按钮与 2px 真空带；
  2. 释放全部侧柱空间给滑块，行程恢复为 $H_{\text{viewport}} - (\text{insetTop} + \text{insetBottom})$；
  3. 杜绝负数高度计算与布局坍塌。

---

### 3.5 18px 物理像素滑块夹持与基于 Track 的绝对偏移

彻底根除历史代码中将 `Math.max(18, ...)` 误当百分比的严重缺陷：
1. **18px 物理像素夹持**：
   ```typescript
   const minThumbSize = 18; // 真实的物理像素下限
   const rawThumbHeight = (metrics.clientHeight / metrics.scrollHeight) * actualTrackHeight;
   const thumbHeightPx = Math.min(actualTrackHeight, Math.max(minThumbSize, rawThumbHeight));
   ```
2. **绝对像素偏移定位**：
   ```typescript
   const maxTravelPx = Math.max(0, actualTrackHeight - thumbHeightPx);
   const thumbTopPx = metrics.progressY * maxTravelPx;
   // 挂载至 DOM 样式：
   // style={{ height: `${thumbHeightPx}px`, top: `${thumbTopPx}px` }}
   ```
   废弃任何基于自身高度百分比的 `translateY(...)`，确保无论滑块多长，位移百分比始终与滚动比例 1:1 绝对线性同构。

---

### 3.6 滑块 Pointer Capture 拖拽引擎全生命周期接管

注入完备的 W3C Pointer Events 交互引擎：
1. **捕获锁定（`pointerdown`）**：调用 `(e.target as HTMLElement).setPointerCapture(e.pointerId)`，锁定光标；
2. **精准映射（`pointermove`）**：
   $$\Delta S = \Delta Y \times \frac{\text{scrollHeight} - \text{clientHeight}}{\text{maxTravelPx}}$$
   直接写入 `internalViewportRef.current.scrollTop = startScrollTop + \Delta S`；
3. **安全释放（`pointerup` / `pointercancel`）**：释放捕获，平稳归位；
4. **视觉反馈**：拖拽期间指针切换为 `cursor: grabbing`，滑块颜色稳定锁定在 `--scrollbar-thumb-active`。

---

## 四、右侧 2px 物理透明防误触间隙架构与实现

### 4.1 2px 物理呼吸间距的人机工程学价值

在桌面 GUI 系统中，滚动条紧贴外边框会导致鼠标操作时的“边界效应（Edge Effect）”：用户试图点击或拖动滑块时，光标极易划出容器边界触发失焦或误触父级元素。2px 物理透明间隙在视觉上建立起了“悬浮式（Floating Gutter）”现代设计语言，在交互上提供了无死角的操作安全区。

### 4.2 Mode 1（ScrollArea）实现：right: 2px + trackMargin 契约

在 `<ScrollArea>` 中，通过属性 `trackMargin?: number`（默认值为 `2`）驱动定位：

```tsx
<div
  className={`${styles.stepperTrackColumn} ${isBarVisible ? styles.visible : ''}`}
  style={{
    top: `${insetTop}px`,
    bottom: `${insetBottom}px`,
    right: `${trackMargin}px`, // 严格保留 2px 物理透明隔离间隙
    width: 'var(--scrollbar-width)',
  }}
  aria-hidden="true"
>
```

无论容器内部如何填充内容，步进侧柱始终与容器最右侧保持 2px 的绝对空隙。

### 4.3 Mode 2（全局 overlay-scrollbar.css）协同一致性保障

在纯 CSS 的 Mode 2 中，通过 WebKit 原生伪元素的透明内缩边框与剪裁框维持完全相同的 2px 间距：

```css
/* apps/crish-desktop/src/styles/overlay-scrollbar.css */
::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb-bg);
  background-clip: padding-box;
  border-right: 2px solid transparent; /* 右侧 2px 物理透明防误触间隙 */
  border-left: 1px solid transparent;
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-button:vertical:start:decrement,
::-webkit-scrollbar-button:vertical:end:increment {
  background-clip: padding-box;
  border-right: 2px solid transparent; /* 按钮右侧同步内缩 2px */
}
```

两模式在空间几何体验上达成 100% 像素级无感一致。

---

## 五、首选试验田：ModelBadgePickerMenu 100% 完美接入方案

### 5.1 ModelBadgePickerMenu 几何与交互解剖

`ModelBadgePickerMenu` 是用户高频使用的核心模型选择下拉组件，也是用户真机截图 `media_1788348026546.png` 的原始发生地：
- **容器物理几何**：卡片宽度 290px，四周 `border-radius: 14px`，带毛玻璃模糊与外层阴影；
- **内部三段式布局**：
  - 顶部：搜索输入栏与模型管理快捷图标（高度约 36px）；
  - 中间：模型与服务商分组列表（当前高度 `max-height: 150px`，产生纵向滚动）；
  - 底部：分隔线与高级选项折叠手风琴（思考强度 Pills，高度约 32px）；
- **交互难点**：
  - 鼠标在列表内平滑微调滚动；
  - 鼠标向右掠过展开二级级联服务商菜单（SafeTriangle 保护）；
  - 列表滚动时必须平滑收起展开的二级子菜单（魔鬼用例 5 守卫）；
  - 键盘 Tab / 方向键漫游不失焦。

### 5.2 改造前后 DOM 与 CSS 结构净收敛对比

#### 【改造前：原始 DOM 与 CSS 弊端】
- **DOM**：`<div className={styles.modelScrollArea}>...</div>`
- **CSS**：
  ```css
  .modelScrollArea {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 150px;
    min-height: 60px;
    overflow-y: auto; /* 粗暴依赖原生滚动，滑块顶破圆角，缺少优雅步进三角 */
    padding: 2px 0;
  }
  ```

#### 【改造后：收敛为 UI 原子层 `<ScrollArea>`】
- **DOM**：
  ```tsx
  <ScrollArea
    size="sm"
    showButtons={true}
    radius={14}
    trackMargin={2}
    className={styles.modelScrollArea}
    viewportClassName={styles.modelScrollAreaViewport}
    onScroll={() => {
      // 触发魔鬼用例 5：滚动防脱轨，自动收起展开的子菜单
      handleCloseSubmenu();
    }}
  >
    {filteredGroups.length === 0 ? (
      <div className={styles.emptyState}>未找到匹配的模型或厂商</div>
    ) : (
      filteredGroups.map(...)
    )}
  </ScrollArea>
  ```
- **CSS 净收敛**：
  ```css
  /* 彻底移除 overflow-y: auto 与非标滚动声明，转为受控高度包装 */
  .modelScrollArea {
    max-height: 150px;
    min-height: 60px;
    flex: 1;
    width: 100%;
  }

  .modelScrollAreaViewport {
    padding: 2px 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  ```

### 5.3 ScrollArea 参数装配与契约配置（radius={14}, trackMargin={2}）

装配矩阵如下：
| 参数 | 传参值 | 物理与业务收益 |
| :--- | :--- | :--- |
| `size` | `"sm"` (6px 优雅轨宽) | 黄金视宽，大三角比例和谐，绝不挤占模型名称排版 |
| `showButtons` | `true` | 激活顶部向上、底部向下优雅圆角大三角，彻底还原真机截图 |
| `radius` | `14` | 驱动 `calculateSafeAreaInset(14, 2)`，顶部和底部按钮自动下移/上移避让 14px 圆角弧线 |
| `trackMargin` | `2` | 严格在右侧保留 2px 物理透明防误触间隙，悬浮质感呼之欲出 |
| `type` | `"hover"` | 鼠标移入浮层时优雅渐现，移出时淡出，纯净无视觉杂音 |

### 5.4 关键交互保活：魔鬼用例 5 滚动防脱轨与键盘漫游无感兼容

- **魔鬼用例 5 滚动防脱轨**：在 `ModelBadgePickerMenu.test.tsx` 中，魔鬼用例 5 验证“主菜单滚动容器触发 scroll 自动收起子菜单”。通过 `<ScrollArea onScroll={...}>` 将事件原生透传，完全满足 `fireEvent.scroll` 捕获断言；
- **键盘导航兼容**：`<ScrollArea>` 的 Viewport 原生透传键盘事件与焦点，用户使用上下键选择模型时不产生任何拦截阻断。

### 5.5 现有 27 项单测全量无回归保障

在 `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.test.tsx` 中包含全部 27 项测试用例（包括 5 大红方魔鬼用例）。改造后必须执行 `npx vitest run .../ModelBadgePickerMenu.test.tsx`，必须 **27 / 27 全绿通过**，绝不允许任何单测退化！

---

## 六、具体执行步骤与子 Agent 派发规划（Wave 1 ~ Wave 5）

依据 `AGENTS.md` §2 的核心纪律，由战役规划主控 Agent 负责调度，本方案拆解为 5 个标准执行波次（Waves），每波分派专属任务，任务间边界绝对正交。

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           五波次执行推进流水线全景图                             │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Wave 1: Token 物理标定与矢量 SVG 规范对齐（tokens.css & overlay-scrollbar.css）  │
│    │                                                                             │
│    ▼                                                                             │
│ Wave 2: <ScrollArea> UI 原子组件完整落盘（ScrollArea.types/tsx/module.css/index）│
│    │                                                                             │
│    ▼                                                                             │
│ Wave 3: <ScrollArea> 专项单元测试与红队魔鬼用例闭环（ScrollArea.test.tsx）       │
│    │                                                                             │
│    ▼                                                                             │
│ Wave 4: ModelBadgePickerMenu 率先接入与 100% 视觉还原（首选示范落地）           │
│    │                                                                             │
│    ▼                                                                             │
│ Wave 5: 全仓静态门禁、双向回归与立体现场验收（check:ui-layer & 全量测试通过）    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

### 6.1 阶段一（Wave 1）：Token 物理标定与矢量 SVG 规范对齐

- **目标**：修正 `src/styles/tokens.css` 与 `src/styles/overlay-scrollbar.css`，彻底拔除乱写色值与 mini 伪元素，锁定“只调灰度、底色绝对不动”；
- **执行内容**：
  1. 确认 `tokens.css` 中的二元变量：未激活 `--scrollbar-thumb-bg: #eae8e6;`，激活 `--scrollbar-thumb-active: #cdcccb;`；
  2. 修复 `overlay-scrollbar.css` 中的 WebKit 伪元素 SVG：将 `#CCCBCA` / `#9e9d9c` 修正为标准的 `%23eae8e6` 与 `%23cdcccb`，应用 5.0px × 3.8px 优雅圆角贝塞尔路径，消除 2.2px mini 畸变；
  3. 严格保留 `border-right: 2px solid transparent;` 间隙。

### 6.2 阶段二（Wave 2）：`<ScrollArea>` UI 原子组件完整落盘与出口打通

- **目标**：在 `apps/crish-desktop/src/components/ui/ScrollArea/` 构建生产级纯净 UI 原子组件；
- **落盘文件**：
  1. `ScrollArea.types.ts`：完整的 TypeScript 类型契约（支持 `size`, `showButtons`, `radius`, `trackMargin`, `ScrollAreaHandle`）；
  2. `ScrollArea.tsx`：注入 `calculateSafeAreaInset`、三段式隔离侧柱、`StepperArrowUpIcon` / `StepperArrowDownIcon` 优雅矢量 SVG、Pointer Capture 拖拽引擎与 20Hz 脉冲微调；
  3. `ScrollArea.module.css`：严格消费 tokens 变量，无方块背景框，二元灰度死锁，`right: 2px` 物理间隙；
  4. `index.ts`：模块导出；
  5. `apps/crish-desktop/src/components/ui/index.ts`：统一 Barrel 单真理出口挂载。

### 6.3 阶段三（Wave 3）：`<ScrollArea>` 专项单元测试与红队魔鬼用例闭环

- **目标**：创建 `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.test.tsx`；
- **测试覆盖矩阵**：
  - TC-SA-01：基础渲染与内容透传；
  - TC-SA-02：四级尺寸 Token 映射（xs/sm/md/lg）；
  - TC-SA-03：端点安全护栏 2px 物理真空带不变量验证；
  - TC-SA-04：极端圆角动态 Inset 避让计算断言；
  - TC-SA-05：算术下溢退化紧凑态降级断言；
  - TC-SA-06：18px 物理像素滑块夹持断言；
  - TC-SA-07：20Hz 脉冲微调（250ms 延迟 + 50ms 连发）与极限自制动；
  - TC-SA-08：滑块 Pointer Capture 拖拽滚动映射验证；
  - TC-SA-09：命令式 Handle API（`scrollToTop`, `scrollStep` 等）；
  - TC-SA-10：无障碍 ARIA 属性与 Reduced Motion 降级。

### 6.4 阶段四（Wave 4）：`ModelBadgePickerMenu` 率先接入与视觉还原

- **目标**：将 `ModelBadgePickerMenu` 改造为消费 `<ScrollArea>`，实现 100% 截图还原；
- **执行内容**：
  1. `ModelBadgePickerMenu.tsx` 引入 `ScrollArea`；
  2. 替换 `.modelScrollArea` 为 `<ScrollArea size="sm" showButtons={true} radius={14} trackMargin={2} ...>`；
  3. 清理 `ModelBadgePickerMenu.module.css` 中的 `overflow-y: auto` 冗余声明；
  4. 执行 `ModelBadgePickerMenu.test.tsx`，确保 27 项用例全绿通过。

### 6.5 阶段五（Wave 5）：全仓门禁、双向回归与立体现场验收

- **目标**：履行 `AGENTS.md` §7.1 立体验证纪律，确保无架构破损；
- **检查命令**：
  1. 架构解耦门禁：`npm run check:ui-layer`（必须 0 错误）；
  2. 类型检查：`npm run typecheck`（必须 0 错误）；
  3. 单元测试回归：`npx vitest run .../ScrollArea.test.tsx` 与 `npx vitest run .../ModelBadgePickerMenu.test.tsx`；
  4. 行数门禁检查：`npm run check:line-counts`。

---

### 6.6 子 Agent 任务卡详尽定义（严格遵循 5-12 个规范）

依据 `AGENTS.md` §2 每轮派发 5–12 个子 Agent 的裁决，本波规划拆分为 5 个高度专注的子任务卡：

#### 【Task 1：Token 与 WebKit 样式基准对齐专员（Token & WebKit Specialist）】
- **职责**：修订 `src/styles/tokens.css` 与 `src/styles/overlay-scrollbar.css`；
- **输入**：本计划第 1.1 节、第 2 节规范；
- **产出文件**：`apps/crish-desktop/src/styles/tokens.css`, `apps/crish-desktop/src/styles/overlay-scrollbar.css`；
- **验收断言**：禁止出现 `#CCCBCA` 或冷灰，未激活严格 `#eae8e6`，激活严格 `#cdcccb`，SVG 升级为 5.0×3.8px 优雅圆角路径，保留 2px 透明边框。

#### 【Task 2：ScrollArea UI 原子组件核心构筑师（ScrollArea Component Architect）】
- **职责**：构建 `<ScrollArea>` 组件全部 4 个文件及 Barrel 导出；
- **输入**：本计划第 3 节、第 4 节规范与代码模板；
- **产出文件**：
  - `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.types.ts`
  - `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.tsx`
  - `apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.module.css`
  - `apps/crish-desktop/src/components/ui/ScrollArea/index.ts`
  - `apps/crish-desktop/src/components/ui/index.ts` (导出新增组件)
- **验收断言**：通过 `check:ui-layer` 门禁，零 store/hooks 依赖，右侧死锁 2px 间隙，内联注入优雅矢量 SVG。

#### 【Task 3：ScrollArea 红队测试专家（ScrollArea QA Specialist）】
- **职责**：编写并跑通 `<ScrollArea>` 的 10 大全量单元测试与魔鬼用例；
- **输入**：本计划第 6.3 节测试规格；
- **产出文件**：`apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.test.tsx`；
- **验收断言**：`npx vitest run .../ScrollArea.test.tsx` 10/10 PASS，覆盖率 100%。

#### 【Task 4：ModelBadgePickerMenu 业务迁移专家（ModelBadgePickerMenu Migrator）】
- **职责**：接入 `<ScrollArea>` 并净化样式，100% 还原用户最满意视觉效果；
- **输入**：本计划第 5 节规范；
- **产出文件**：
  - `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx`
  - `apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css`
- **验收断言**：拔除 `overflow-y: auto`，装配 `radius={14}` 与 `trackMargin={2}`，`npx vitest run .../ModelBadgePickerMenu.test.tsx` 27/27 PASS。

#### 【Task 5：全仓门禁与立体物理验收专员（Gate & Physical Verification Auditor）】
- **职责**：执行静态门禁、行数审计、类型校验与光学像素复核；
- **输入**：全仓门禁套件；
- **产出报告**：验证结果汇编，提交给主控 Agent 统一收口；
- **验收断言**：`check:ui-layer` PASS、`check:line-counts` PASS、`typecheck` PASS，无任何 Git 未跟踪脏状态。

---

## 七、立体验证与验收断言清单（Verification & Ratchet）

### 7.1 静态与架构门禁刚性断言
1. **UI 原子层解耦断言**：
   运行 `npm run check:ui-layer`，`src/components/ui/ScrollArea/` 下 0 违规，严禁引入 `store/`、`hooks/`、`api/`、`services/` 或 `components/(?!ui)`；
2. **行数门禁断言**：
   运行 `npm run check:line-counts`，`ScrollArea.tsx` 有效代码行数严格控制在 350 行以内，`ModelBadgePickerMenu.tsx` 不超过 500 行预算；
3. **零编译错误断言**：
   运行 `npm run typecheck`，TypeScript 0 错误、0 警告。

### 7.2 自动化测试用例矩阵
1. **ScrollArea 专项套件**：
   `npx vitest run apps/crish-desktop/src/components/ui/ScrollArea/ScrollArea.test.tsx` 必须 100% 通过（10 项测试）；
2. **ModelBadgePickerMenu 专项套件**：
   `npx vitest run apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.test.tsx` 必须 100% 通过（27 项测试，包括 5 大红方魔鬼用例）；
3. **Menu 基座与几何保护套件**：
   `npx vitest run apps/crish-desktop/src/components/ui/Menu/` 必须全绿，确保浮层层叠与包含块不受影响。

### 7.3 视觉与物理光学现场验收断言
1. **光学色彩断言**：
   - 未激活态：吸管实测十六进制为 `#eae8e6`（微温润暖灰，灰度 8.24%，色相 30° 饱和度 2%）；
   - 激活态（Hover/Active）：吸管实测十六进制为 `#cdcccb`（沉稳灰，灰度 19.8%~20.0%，色相 30° 饱和度 2%）；
   - 差值绝对锁定：11.8% ~ 12.2%，严禁第三种中间态，严禁黑色或方块背景框；
2. **几何大三角断言**：
   - 三角形底边宽度严格为 5.0px，高度严格为 3.8px，顶角与底角呈现平滑圆角，高分屏下绝无锯齿毛刺与萎缩迷你感；
3. **右侧 2px 物理透明间隙断言**：
   - 步进侧柱与容器最右外边缘之间存在可测量的 2px 物理透明真空区，光标在卡片边框处点击不会误触滚动条；
4. **端点物理防截断断言**：
   - 在 14px 圆角卡片中，滑块运行至最顶端与最底端时，距离上下三角按钮恒有 2px 净空，且按钮本身不被外层圆角截断（Corner Clipping Free）。
