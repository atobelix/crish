# 动效与微交互体验润色战役（Motion & Micro-Interaction Polish）

> **工作区定位**：针对客户端下拉菜单（Dropdown/Menu）、输入框浮层（NoticeBar/SlashMenu）、用户消息发送过渡（Message Send Transition）、超链接视觉标识（Hyperlink Styling）及全局平铺微交互死角展开系统性排查与高质量动效润色。
> **核心设计哲学**：**不打扰、恰到好处、不过喧宾夺主**。干净利落，丝滑响应，严禁果冻式的弹跳与过度冗长拖沓，坚守 GPU 合成与零 Reflow 性能底线。

---

## 目录结构（遵循 AGENTS.md §4 根目录白名单与一级子目录规范）

```
docs/motion-micro-interaction-polish/
├── README.md                                   # 本导航与纪律文档
├── RESUMPTION_ANCHOR.md                        # 换号续航锚点与阶段性封存记录（当前就绪）
├── DISCOVERED_ISSUES.md                        # 过程发现重大问题登记册
├── 00-总方案.md                                 # 战役系统级改造总方案
├── 01-下拉菜单与浮层动效详案.md                   # 分维详案：Dropdown / Menu / Popover
├── 02-输入框提示与快捷菜单动效详案.md              # 分维详案：NoticeBar / SlashMenu / Mentions
├── 03-消息发送飞行与列表过渡动效详案.md            # 分维详案：Send Transition / Glide Up
├── 04-超链接视觉标识与虚线下划线详案.md            # 分维详案：Hyperlink / Dashed Underline / Blue Token
├── 05-全局平铺微交互死角与体验润色详案.md          # 分维详案：Sidebar / Foldable / Reasoning / Tabs
├── audits/                                     # 一级子目录：各专业子 Agent 审查与现场诊断报告 (01~06)
└── reviews/                                    # 一级子目录：可行性、红线、跨模块与物理体验审查报告 (01~09)
```

---

## 战役核心铁律与设计准则

1. **克制利落（Restrained & Crisp）**：
   - 绝大多数浮层与菜单动画时长严格控制在 **120ms ~ 180ms** 之间。
   - 缓动函数统一使用项目 Design Token：`var(--ease-emphasized, cubic-bezier(0.2, 0, 0, 1))` 或 `cubic-bezier(0.16, 1, 0.3, 1)`。
   - **零果冻弹跳**：严禁出现超出边界的 overshoot、弹性往复或果冻摇晃。

2. **性能与纯合成层（Compositor Only）**：
   - 动画原则上严格限定在 `transform` 与 `opacity` 两个属性上，杜绝直接动画 `height`、`width`、`top`、`margin` 等引发整页重排（Reflow）的属性。
   - 折叠展开等不可避免的尺寸过渡，优先使用 CSS Grid `grid-template-rows: 0fr -> 1fr` 技巧。
   - 适度标注 `will-change: transform, opacity;`，在动画结束或静止态释放，避免无节制显存常驻。

3. **视觉层次与语义统一**：
   - **超链接统一规范**：文字采用高对比度蓝色（Light: `hsl(217 91% 54%)` / Dark: `hsl(212 96% 68%)`），标配虚线下划线（`text-decoration: underline dashed; text-underline-offset: 3px;`），悬停平滑加深/提亮。
   - **输入框与焦点态**：严格遵守 `AGENTS.md §13`，禁止粗黑/深重阴影，焦点对比度上限保持在 ~10% 以内，柔和浅灰。
