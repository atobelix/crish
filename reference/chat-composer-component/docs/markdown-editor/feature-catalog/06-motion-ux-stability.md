# 06 — 动效 · 视觉精修 · 布局稳定（Feature Catalog）

> **分册**：feature-catalog / 06  
> **读者**：产品验收、UI/CSS 实现 agent、无障碍审查、性能守门  
> **依赖**：[07-visual-system.md](../07-visual-system.md)、[v3-complete/05-motion-system.md](../v3-complete/05-motion-system.md)、`css/flow/motion.css`、`css/design-tokens.css`  
> **产品铁律**：冷静、克制、完整弧线；**禁止**阴影呼吸 / hover 抬升 / 花哨 bounce；**禁止**活动行丑陋描边与大面积底；**禁止**行切换布局跳动。  
> **本册定位**：把「感觉高级」拆成可验收的能力清单；每条做到**业界一流水准（Gold）**，不是「能看见动一下」。

---

## 0. 本册目标与验收哲学

### 0.1 三件事必须同时成立

| 维度 | 一句话 | 失败样貌 |
|------|--------|----------|
| **Motion** | 每个状态变化有完整、可预期、可中断的弧线 | 闪一下、半截停、弹跳、拖尾 |
| **Visual polish** | 像 Composer / Notebook 同族表面：近黑 opacity 阶、发丝线、静态影 | Notion 整套 chrome 复刻、Bootstrap 表、蓝框 active |
| **Layout stability** | 焦点行切换、slash 开闭、placeholder 显隐 **零 CLS 级跳动** | 行高涨缩、菜单顶开正文、caret 乱跳 |

### 0.2 Gold 标准定义（全文统一）

| 等级 | 含义 | 本册要求 |
|------|------|----------|
| **Gold** | 细节与节奏可对标一线写作工具（Notion / Linear / Craft 的**感觉**），但 **chrome 与 token 完全 Conex 自有** | 默认交付档 |
| Silver | 功能正确、动效有但不统一 | 仅过渡期可接受 |
| Bronze | 能点、丑或抖 | **禁止合入主线** |

### 0.3 非目标

- 页面级视差、滚动叙事动画、Lottie 默认依赖  
- 弹簧物理引擎 / GSAP 等重库  
- 复制 Notion 侧栏、顶栏、封面图、大标题 40px 体系  
- 用动效掩盖布局错误（必须先锁高度，再谈动画）

### 0.4 关联分册

| 主题 | 见 |
|------|-----|
| Token 与皮肤基线 | `07-visual-system.md` |
| 动效 token 与 A01–A27 实现向 | `v3-complete/05-motion-system.md` |
| Slash 行为 | `05-slash-commands.md` / `ux/slash-palette.md` |
| 行渲染与焦点模型 | `03-line-renderer.md` |
| 表格高级 | `v3-complete/03-table-advanced.md` |

本册将微交互扩展为 **A01–A40**，并叠加 **布局稳定 / 排版密度 / 状态页 / 性能预算** 的 Gold 规格。

---

## 1. 设计原则（人因 + 品牌）

1. **短而完整**：主程 90–280ms；有头有尾，settle 干净。  
2. **略快不弹**：ease-out / soft spring；**禁止** overshoot 导致正文晃。  
3. **静态阴影**：浮层可有 static `box-shadow`；**禁止**对 shadow 做 transition/animation。  
4. **属性纪律**：优先 `opacity` + `transform`；背景色可轻过渡；禁止 `margin/top/left/height` 做主动画。  
5. **服务空间关系**：动效回答「从哪来、到哪去」，不装饰噪音。  
6. **可关**：`prefers-reduced-motion: reduce` 时功能完整、动画瞬时。  
7. **焦点不抢戏**：块级「当前行」用**极淡**语义，**绝不用**粗边框、高对比底、系统蓝 outline。  
8. **高度先锁后动**：任何可能改变行盒高度的状态切换，先保证 min-height / 占位同构，再播 opacity。  
9. **60fps / 低 INP**：指针与键盘反馈在下一帧可感知，不堵主线程。  
10. **中文优先可读**：行高、字阶、断词按中文 UI 栈调优，不硬搬西文营销站大字号。

---

## 2. Token 阶梯（时长 · 曲线 · 位移）

> 编辑器 **不发明第二套时间哲学**；映射 flow / design tokens。

### 2.1 时长

| Token | 默认 | 语义 |
|-------|------|------|
| `--mdx-motion-instant` | 0ms | reduce / 全量 setDoc |
| `--mdx-motion-xs` | 90ms | hover 显隐、按压、active 底 |
| `--mdx-motion-sm` | 120ms | 工具条、落点线、+ 按钮、焦点环到位 |
| `--mdx-motion-md` | 160ms | 块入场、通用 enter、合并确认 |
| `--mdx-motion-lg` | 200ms | 块离场、表结构变化 |
| `--mdx-motion-xl` | 240ms | slash / 上下文菜单入场 |
| `--mdx-motion-panel` | 280ms | 大面板上限；**罕见** |

### 2.2 曲线

| Token | 值 | 用途 |
|-------|-----|------|
| `--mdx-ease-out` | flow-spring `cubic-bezier(0.22, 1, 0.36, 1)` | 主弹性 settle |
| `--mdx-ease-soft` | flow-spring-soft `cubic-bezier(0.16, 1, 0.3, 1)` | 大面板 / slash |
| `--mdx-ease-linear` | linear | **仅** progress；默认禁用 |

### 2.3 位移幅度（「似有非有」）

| Token | 值 | 场景 |
|-------|-----|------|
| `--mdx-rise-xs` | 2px | 离场微上、工具条 |
| `--mdx-rise-sm` | 3px | 块入场、菜单入场 |
| `--mdx-rise-md` | 4px | 仅 loading 内容 reveal；正文慎用 |
| `--mdx-scale-press` | 0.98 | 拖拽幽灵 **静态** scale |

### 2.4 禁止的 token 用法

- `--dur-smooth`（350ms）做每块 hover  
- 自造回弹 bezier（负中间点）  
- 动画 `box-shadow` / `margin` / `top` / `left` / `filter: blur`  
- 全局强制 `scroll-behavior: smooth`

---

## 3. 微交互总表 A01–A40（Gold 描述）

> **列说明**  
> - **Gold 表现**：交付验收的「最好样子」  
> - **禁止**：一眼判 Fail  
> - **Reduce**：`prefers-reduced-motion: reduce`  
> - **Perf**：主线程 / 合成层注意点  

### 3.1 块生命周期

| ID | 场景 | 触发 | 时长 | 曲线 | 属性 | Gold 表现 | 禁止 | Reduce | Perf |
|----|------|------|------|------|------|-----------|------|--------|------|
| **A01** | 块插入入场 | Enter / insertBlock / slash 新建 | 160ms | ease-out | opacity, transform | 自下 3px 淡入；settle 后无残类；**仅用户手势**插入播动画 | 打开文档整篇雨落入场；scale 弹跳 | 直接出现 | 单帧加类；end 卸类 |
| **A02** | 块删除离场 | Backspace 合删 / 菜单删 | 160–200ms | ease-out | opacity, transform | 上 2px 淡出；`pointer-events: none`；end 再卸 DOM | 闪删；高度塌陷动画拖长 | 同步卸 DOM | generation 取消排队 |
| **A03** | 块类型转换 | slash 转 heading 等 | 120ms | ease-out | opacity（轻） | 内容轻 cross-fade 或瞬时替换 + 0–1 帧 opacity 0.92→1；**高度锁定** | 整块闪白；padding 突变跳 | 即时替换 | 先换 type 再 paint |
| **A04** | 块拖拽幽灵 | DnD start | — | — | 静态样式 | opacity 0.85 + scale 0.98；宽跟 content；**一层 static soft shadow** | 拖动时 shadow 动画；弹簧跟手延迟 | 仅半透明无 scale | 幽灵节点离文档流 |
| **A05** | 落点指示线 | DnD over | ≤120ms | ease | opacity | 2px 横线 doc-ink；两端圆头；左右与 content 齐 | 蓝半透明大罩；宽度扫描光 | 直接显隐 | top 即时设，无插值 |
| **A06** | 拖源占位 | dragging | 90ms | ease | opacity | 源块 → 0.45；布局位保留 | 源块 display:none 导致塌陷跳动 | 即时 0.45 | 状态类 |
| **A07** | 把手显隐 | 块 hover / 键盘焦点 | 90–120ms | ease | opacity | 0→0.42→hover 0.78；gutter **常占位** 不抖 | 把手进出改 gutter 宽 | 可更高静态 opacity | 纯 CSS :hover 优先 |
| **A25** | 多块插入 stagger | 粘贴多块 | 160ms + delay | spring | 同 A01 | delay i×20ms，**i≤5**；其余同步出现 | 百行 stagger 卡顿 | 无 stagger | 批 insert 单 commit |
| **A28** | 块重排 settle（FLIP 可选） | DnD drop 后列表重排 | ≤200ms | ease-out | transform | 邻块短 invert→play；正文不闪 | 整列表 reflow 闪；height 动画 | 即时落位 | 仅邻域 ≤8 块 |
| **A29** | 空块 ↔ 有内容 | 首字输入 / 删至空 | 0–90ms | ease | opacity（placeholder） | placeholder **绝对叠层或同高占位**，显隐不改行高 | placeholder 用 display 切换导致跳行 | 即时 | 见 §5 高度锁 |

### 3.2 菜单与浮层

| ID | 场景 | 触发 | 时长 | 曲线 | 属性 | Gold 表现 | 禁止 | Reduce | Perf |
|----|------|------|------|------|------|-----------|------|--------|------|
| **A08** | Slash 面板开 | `/` 或 `、` | 240–280ms | soft spring | opacity, transform | 0→1 + Y(3px)；static popover 影；锚 caret 下 4px；撞边 flip | bounce；入场时重播过滤动画 | 瞬开 | 挂载一次播；过滤不重播 |
| **A09** | Slash 面板关 | Esc / 选中 / 失焦 | 120ms | ease | opacity, transform | 出比入快；可先类后卸 | 关时整页闪；残留不可点透明层 | 瞬关 | 卸前 pointer-events none |
| **A10** | Slash 项 active | ↑↓ / hover | 90ms | ease | background-color | **仅** `--bg-hover` 级浅底；主标/副标对比清晰 | 左侧粗色条；3px 描边；高饱和底；shadow | 即时 | 不改 layout |
| **A21** | 上下文菜单 | 右键块/表 | 160–200ms | spring | opacity, transform | 同 slash 气质；项高 32–34；分区 micro 标题 | 系统原生丑单与自绘混用无说明 | 瞬开 | portal + clamp |
| **A26** | 菜单项 hover | pointer | 90ms | ease | background | 与 active 同色阶语言 | hover 改 shadow / 抬升 | 即时 | CSS only |
| **A11** | 选区工具条显 | 非空选区 | 120ms | spring | opacity, transform | 淡入 + 微升 2px；static 影 | 选区移动时条位 **插值拖尾** | 瞬显仍定位 | selectionchange→rAF |
| **A12** | 选区工具条隐 | 折叠选区 / composing | 90ms | ease | opacity | 快隐；composing 强制隐 | 隐后仍可点 | 瞬隐 | |
| **A13** | 工具条按钮 press | pointer | 90ms | ease | background, color | active 加深一档；hit ≥28px | 整条 scale 弹 | 即时 | |
| **A30** | 浮层定位校正 | resize / scroll / visualViewport | 0（位置） | — | left/top 无 transition | 坐标 **瞬时**；仅 content 可有 opacity | 浮层 spring 追滚动 | 同 | rAF 合并 |
| **A31** | 菜单空匹配态 | query 无结果 | 90ms | ease | opacity | 「无匹配命令」l2；列表高度 **min-height 锁** 防抖 | 空态高度 0→塌 | 即时 | 固定至少 3 行高 |

### 3.3 表格与结构 affordance

| ID | 场景 | 触发 | 时长 | 曲线 | 属性 | Gold 表现 | 禁止 | Reduce | Perf |
|----|------|------|------|------|------|-----------|------|--------|------|
| **A14** | 表格 + 列/行显 | wrap hover / chrome 焦点 | 120ms | ease | opacity | 0→1；按钮弱墨；**可发现不抢戏** | + 按钮 shadow 呼吸；常驻高对比 | 即时 | |
| **A15** | 表格 + 点击反馈 | click | 90ms | ease | background, border-color | 轻按压色；插入成功有 A16 | 整表 flash | 即时 | |
| **A16** | 新行/列入场 | add row/col | 160ms | spring | opacity, transform | 行 Y(2px)；列 X(2px)；列多时仅表头+首行或整体轻 fade | 每格独立 50 动画 | 即时 | 列≤8 可限 stagger≤4 |
| **A17** | 删行/列离场 | delete | 140ms | ease | opacity | 淡出后卸；邻格不抖 | 高度 height 动画 300ms+ | 即时卸 | |
| **A18** | 单元格选中 | 点击/框选 | 90ms | ease | background-color | `--mdx-selection-bg`；**无** 3px 系统蓝框 | Bootstrap 焦点环；斑马高对比选中 | 即时 | |
| **A19** | 合并预览轮廓 | 合并模式拖选 | 120ms | ease | opacity, border-color | dashed doc-ink 40% + 4% 填；radius 2 | 脉冲阴影；整表变暗 | 瞬显 | |
| **A20** | 合并确认 | 执行 merge | 160ms | ease-out | opacity | 预览收束淡出；DOM 轻 fade | confetti；成功大闪 | 跳过 | |
| **A32** | 列宽拖拽指示 | resize handle | ≤90ms | ease | opacity | 2px 中央指示线 doc-ink 40%；拖时 **跟手无延迟** | 列宽 transition 拖尾难控 | 即时 | 拖中禁用 width transition |
| **A33** | 表头 sticky 阴影（可选） | 纵向滚过阈值 | 90ms | ease | opacity（伪影层） | 极淡顶部分隔 **opacity**；**不是** box-shadow 动画 | 表头 elevation 卡片化 | 可静态线 | 合成层克制 |

### 3.4 焦点 · 光标 · 占位 · 阅读 chrome

| ID | 场景 | 触发 | 时长 | 曲线 | 属性 | Gold 表现 | 禁止 | Reduce | Perf |
|----|------|------|------|------|------|-----------|------|--------|------|
| **A22** | Callout 折叠 | accordion | 180ms | spring | grid 0fr→1fr, opacity | 复用 flow-acc；内容不裁切闪 | height 直接动画难打断 | 即时高度 | contain 内容 |
| **A23** | 代码块模式切换 | read→edit | 120ms | ease | opacity | 单壳轻 cross-fade；**禁止**双壳滑动假预览 | 双编辑器叠化 | 即时 | |
| **A24** | 焦点环（控件） | focus-visible | 90ms | ease | ring（描边式 shadow **静态到位**） | 把手/按钮 2px doc-ink 环；**不** animate 扩散 | 块行大蓝 outline 动画 | 可保留静态环 | |
| **A34** | 当前块 / 当前行强调 | 焦点块 | 90ms | ease | **极淡** bg 或 **无 bg** | **Gold 默认：无边框、无实底**；仅 gutter 把手可见 + caret | **丑陋 active 行：1px solid 边、灰蓝底、左边粗条** | 即时 | 见 §4 |
| **A35** | Caret 呈现 | 编辑态 | 系统 | — | caret-color | `caret-color` = 主墨；IME 下不闪块壳 | 自定义 canvas caret 不同步 IME | — | 不自绘 caret 除非 P2 |
| **A36** | Placeholder 呼吸（可选极弱） | 空块 | **默认无循环** | — | opacity 静态 0.35 | 静态弱墨文案；**禁止**闪烁呼吸动画 | 无限 opacity loop | 静态 | |
| **A37** | 块间 hover 底 | pointer over block | 90ms | ease | background | 可选 0→`rgba(0,0,0,0.02)` **整块极淡**；与 active **同阶或更淡** | hover 卡片阴影；与 active 高对比冲突 | 即时 | |
| **A38** | 链接 / chip hover | pointer | 90ms | ease | color, underline | underline 1px；chip 浅底 | chip shadow 抬升 | 即时 | |
| **A39** | 错误 / 非法操作反馈 | 合并非法等 | 120ms | ease | border-color, color | 描边改 error 色；**ARIA + 文案** | 整表 shake；红闪屏 | 瞬显色 | |
| **A40** | 滚动锚定插入 | 新块出视口 | — | — | scrollIntoView nearest | `behavior: auto`；**不**强制 smooth | 全局 smooth 抢键盘 | auto | 见 A27 |

| ID | 场景 | 触发 | 时长 | Gold 表现 | 禁止 | Reduce |
|----|------|------|------|-----------|------|--------|
| **A27** | 滚动锚定策略 | 插入块 | — | nearest + auto；reduce 同 | smooth 全局 | auto |

---

## 4. 活动行 / 焦点行：无丑陋边框与底（硬规格）

### 4.1 问题定义

常见失败实现：

- `.is-active { border: 1px solid #ddd; background: #f5f5f5; }` → **瓷砖墙**、阅读被 chrome 打断  
- 系统 `:focus { outline: 2px solid Highlight }` 落在整行块容器上 → **蓝框手术台**  
- active 与 hover 使用高对比不同色 → 行间切换「跳色」眩晕  

### 4.2 Gold 规则（冻结）

| 状态 | 允许 | 禁止 |
|------|------|------|
| 块 `is-active`（鼠标点入编辑） | **默认无边框、无实底**；caret + 可选把手 opacity | 1px+ 全周 border；≥3% 黑实底；左边 3px 色条作为唯一强调 |
| 块 `is-active`（键盘块选，非文本编辑） | 可用 **1.5–2px 描边式 focus-ring**（doc-ink 35% mix），**radius 与块 pad 协调**；或极淡 bg `rgba(0,0,0,0.02)` **二选一，勿叠满** | 同时 border + 重底 + ring 三重 |
| 表格单元格 selected | 仅 `--mdx-selection-bg` | 单元格 3px 蓝框、外发光 |
| Slash / 菜单 `is-active` | 仅 `--bg-hover`（约 3.5% 黑） | 左侧色条、加粗边、shadow |
| 行 hover | ≤2–3.5% 黑底 **或** 仅把手出现 | hover 抬升阴影 |

### 4.3 与「可发现性」的平衡

- **可编辑暗示**靠：caret、placeholder 文案、把手在 hover/焦点时出现，**不靠**画框。  
- **键盘可达**靠：focus-visible 在 **控件**（把手、按钮、菜单项）上清晰；块容器仅在「块选模式」轻环。  
- **截图验收**：并排对比「无 active 框」与「有框」——Gold 必须是前者气质。

### 4.4 验收清单（Active 行）

- [ ] **AR-1** 连续上下键换块：无边框闪烁、无底色跳变眩晕  
- [ ] **AR-2** 鼠标点入段落：看不到「卡片描边」  
- [ ] **AR-3** 表格选格：仅浅选区底，无系统蓝粗框  
- [ ] **AR-4** slash 高亮项：浅底 only，与 Composer 菜单同族  
- [ ] **AR-5** 打印 / 导出阅读：无 active chrome 残留  

---

## 5. 布局稳定：行切换零跳动（Height Lock · Debounce）

### 5.1 跳动来源清单（必须逐项灭掉）

| 源 | 现象 | Gold 对策 |
|----|------|-----------|
| Placeholder 显隐改 flow 高度 | 空↔非空跳一行 | placeholder 与正文 **同 line-height / 同 min-height**；用绝对定位叠字或 `::before` 不占双份高度 |
| 读写模式 DOM 切换 | read 壳与 edit 壳高度差 | **单壳**优先；或锁 `min-height` 为测量值再切换（见 line-renderer） |
| 块 type 转换（p→h1） | 字号行高突变 | 允许字阶变，但 **块 pad 与 gap 不变**；转换帧避免额外 margin |
| 把手 / + 按钮进 DOM | 挤宽挤高 | gutter **常在**；+ 绝对定位于表缘，不参与文档流高度 |
| Slash 打开 | 顶开正文 | **portal 浮层**，不插入块流 |
| 选区工具条 | 挤内容 | 绝对定位于选区上方，不占流 |
| 焦点 ring | outline 外扩导致 CLS | ring 用 inset 或不影响布局的 box-shadow；预留空间策略统一 |
| IME 候选框 | 浏览器 UI，非我控 | 不为此改行高；浮层避让 visualViewport |
| 字体异步加载 | 闪缩 | 编辑器区域 font-display 策略与宿主一致；关键 UI 系统字体栈 |
| 图片 / embed 加载 | 下文下推 | 已知尺寸锁 aspect-ratio；未知用稳定骨架高 |
| 表格 + 行显隐 | 表外高度抖 | + 不占表外文档流；hover 仅 opacity |

### 5.2 高度锁（Height Lock）协议

**原则**：任何「模式切换」在第一帧 paint 前，目标盒的 **占用高度 ≥ 切换前**，或 **差值 < 1px**。

| 场景 | 锁法 |
|------|------|
| 空段落 | `min-height` = 1 行 body（14px × lh 1.7 + pad-y×2） |
| 空标题 | 按 heading 字阶算一行 min-height，**不是**段落高硬套 |
| 空列表项 | 与列表行高一致 |
| 空表格单元格 | min-height 28px（可点） |
| 代码块空 | 至少 2 行 micro 高 + bar 28 |
| read→edit 同行 | 测量 read 高 → edit 设 min-height → 聚焦 → 下一帧可卸锁（内容已撑开） |
| 多行块内部 | 内部行变化不改 **文档块** 焦点模型；避免外层 re-mount |

### 5.3 Debounce / 合并（防抖与批处理）

| 事件 | 策略 | 理由 |
|------|------|------|
| `selectionchange` | rAF 合并 1 次/帧 | 避免工具条坐标风暴 |
| 菜单过滤输入 | 输入即时过滤 UI；**aria-live** 可 300ms debounce | 读屏不刷屏 |
| resize / scroll 重定位浮层 | rAF；scroll 用 passive | 不掉帧 |
| 连续 Backspace 删块 | leave generation；只动画「最后一个」或 shorten | 防离场队列卡顿 |
| hover 显把手 | CSS 优先；若 JS，**不** debounce 到 300ms（会显钝） | 90–120ms 内响应 |
| 拖拽 over 落点 | 指针 move 直接更新；**不** debounce 落点 top | 跟手 |
| 全量 `setDoc` | `animate: false`；无 enter | 打开文档稳定 |

### 5.4 行切换（焦点块切换）Gold 路径

1. 提交旧块（静默，无离场动画除非真删除）。  
2. 新块 `is-active` 类切换：**无** border 动画、**无** height 动画。  
3. 若需 enterEdit：单壳或高度锁后聚焦；caret 放置 **一次**。  
4. 把手 opacity 由 CSS :hover / 焦点态过渡，**不**改变 gutter 几何。  
5. **禁止**为「好看」在切换时播放块 enter（A01 仅插入）。

### 5.5 验收清单（布局稳定）

- [ ] **LS-1** 空文档敲第一字：无垂直跳  
- [ ] **LS-2** 删光一行变 placeholder：无跳  
- [ ] **LS-3** 上下键连续 20 块：无累计偏移、无滚动抽搐  
- [ ] **LS-4** 打开 slash：正文位置不变  
- [ ] **LS-5** 表 hover 出 +：表宽高稳定  
- [ ] **LS-6** 字体加载后：无整页重排（系统栈下）  
- [ ] **LS-7** 布局偏移 CLS 体感为 0（块编辑核心路径）  
- [ ] **LS-8** IME 中文输入：块壳不闪、行高不抖  

---

## 6. Slash · 上下文菜单 · 表格 affordance 动效专章

### 6.1 Slash 面板（A08–A10, A31）

| 项 | Gold 规格 |
|----|-----------|
| 入场 | 240–280ms soft spring；opacity + translateY(3px) |
| 出场 | 120ms 偏快；不对称（出＜入）显「利落」 |
| 阴影 | static popover only |
| 过滤 | 列表 DOM 更新 **不**重播入场 |
| 高亮 | bg-hover only（呼应 §4） |
| 空匹配 | 文案 + **min-height ≥ 约 3 项**，防高度抖动 |
| 定位 | caret 下 4px；flip；visualViewport 软键盘优先上方 |
| 焦点模型 | 焦点保留编辑器；列表 `aria-activedescendant` |
| z-index | ≥ notebook 80，建议 90+ |
| 与中文 `、` | 同面板同动效，无第二套 |

**Gold 体感一句话**：像呼吸一样打开，过滤时安静，关掉干脆；**从不**把正文顶歪。

### 6.2 上下文菜单（A21）

| 项 | Gold 规格 |
|----|-----------|
| 入场 | 160–200ms spring；幅度同 slash 家族 |
| 项 | 高 32–34；危险项用 ink/error 色，**不**整行大红底 |
| 分隔 | hairline；上下 4–6px |
| 二级（若有） | 同侧滑入 120ms opacity+X(2px)；reduce 瞬切 |
| 关闭 | 外点 / Esc / 选中；120ms 或瞬 |

### 6.3 表格 + 与结构（A14–A20, A32）

| 项 | Gold 规格 |
|----|-----------|
| + 显隐 | 120ms opacity；默认隐，hover/焦点 chrome 显 |
| + 位置 | 行尾 / 列下绝对贴边，**不**撑开 notebook 宽高 |
| 新行列 | 微位移 2px + fade；大表降级 |
| 选区 | selection-bg；合并预览 dashed |
| 非法 | 色变 + 文案；**禁止 shake** |
| 列宽拖 | 指示线跟手；拖中无 width transition |

### 6.4 选区工具条（A11–A13）

| 项 | Gold 规格 |
|----|-----------|
| 显 | 120ms；scale 0.98→1 可选用，幅度克制 |
| 移 | **left/top 不插值**；仅显隐动画 |
| composing | 强制隐藏 |
| 按钮 | press 90ms 背景 |

---

## 7. 焦点过渡 · Caret · Placeholder

### 7.1 焦点层级

| 层级 | 对象 | 视觉 |
|------|------|------|
| L0 | 文档表面 | 无环 |
| L1 | 文本编辑 | caret + 选区色；块 **无**重 chrome |
| L2 | 块选（键盘） | 轻 ring **或** 极淡底，见 §4 |
| L3 | 可聚焦控件 | focus-visible 2px doc-ink 环 |
| L4 | 模态浮层 | 焦点在浮层内循环（slash 例外：焦在编辑器） |

### 7.2 焦点过渡 Gold

- 块间切换：≤90ms 内状态类稳定；**无** outline 扩散动画。  
- 从菜单回编辑器：caret 恢复到触发前语义位置；无「先跳到块首再修正」。  
- Tab 策略：slash 打开时 Tab **不**陷阱（见 slash 分册）；焦点离开时面板关。  

### 7.3 Caret（A35）

| 项 | 规格 |
|----|------|
| 颜色 | 主墨 `--flow-ink` |
| 宽度 | 浏览器默认；不强制粗 caret |
| IME | 合成中不隐藏错误块壳、不改 block type |
| 只读块 | 无文本 caret；块选视觉走 L2 |
| 表格 | 单元格内系统 caret；选多格时 caret 可在锚点格 |

### 7.4 Placeholder（A29, A36）

| 项 | 规格 |
|----|------|
| 文案 | 「输入 `/` 或 `、` 插入块…」类短句；l2 / 0.35 opacity |
| 字阶 | 与该块 body 字阶一致（标题空块用标题字阶弱化色） |
| 布局 | **不占双高度**；与首行对齐 |
| 动效 | **默认静态**；禁止呼吸闪烁 |
| 空文档 | 单一空 paragraph；**不**居中大插画空态（产品阅读态） |

---

## 8. `prefers-reduced-motion`（完整契约）

### 8.1 原则

- Reduce = **功能 100% + 动画 0%**（或 0.01ms 级瞬间）。  
- 状态、颜色、ARIA、布局稳定 **全部保留**。  
- 不依赖动效传达唯一信息（错误、选中、非法合并）。

### 8.2 行为矩阵

| 能力 | 默认 | Reduce |
|------|------|--------|
| A01/A02 进出 | 有 | 瞬出瞬入；leave 同步卸 |
| A08/A09/A21 菜单 | 有 | 瞬开瞬关 |
| A11/A12 工具条 | 有 | 瞬显隐，仍定位 |
| A14–A17 表 | 有 | 即时 |
| A05 落点 | 淡入 | 直接显隐 |
| A04 幽灵 | scale+透明 | 仅透明 |
| A25 stagger | 有 | 无 delay |
| A22 折叠 | 动画高 | 即时高度 |
| A27 滚动 | auto | auto |
| A34 active | 无动画需求 | 同 |
| 进度类（若有） | linear | 可静态条 |

### 8.3 JS 侧义务

- 统一 `prefersReducedMotion()` 读取 `matchMedia`。  
- insert/leave/open 分支判断。  
- 可选订阅 `change`（用户运行中切换系统设置）。  
- `setDoc` / fullRender：**始终** `animate: false` 语义。

### 8.4 验收

- [ ] **RM-1** 系统「减少动态效果」开：所有面板可开可关  
- [ ] **RM-2** 无「卡在 opacity:0」残层  
- [ ] **RM-3** 读屏与键盘路径无回归  
- [ ] **RM-4** 无仅靠闪烁表达的错误态  

---

## 9. 性能预算（60fps · INP · 主线程）

### 9.1 帧率预算

| 场景 | 目标 | 测量提示 |
|------|------|----------|
| 菜单开闭 | 60fps 全程 | Performance panel；无长任务 >50ms |
| 拖拽落点跟随 | 指针跟手 ≤1 帧延迟感 | 中档机 Notebook 内 |
| 块 enter 单次 | 不掉到 <50fps 可感卡顿 | 避免 filter/blur |
| 多块粘贴 | 前 5 可 stagger；其余同步；**主线程 commit 批量化** | 禁止每块强制同步 layout |
| 连续输入 | **零**块级动画 | 输入路径不进 A01 |

### 9.2 INP / 交互延迟

| 交互 | Gold INP 体感 | 做法 |
|------|---------------|------|
| 点击块聚焦 | 下一帧 caret 可见 | 少测 DOM；避免聚焦前全文档 diff |
| 打开 slash | ≤100ms 内面板可见（reduce 更短） | 预创建 portal 或快速 mount |
| 菜单键上下 | ≤1 帧高亮移动 | activeIndex 状态轻量 |
| 工具条按钮 | 90ms 内 press 反馈 | CSS :active 优先 |
| 表 + 点击 | 90ms 内按压态；结构变更可接 A16 | 插入事务合并 |

> 产品化数字：核心点击 **INP 良好档**（尽量 &lt;200ms p75）；编辑器内导航 **体感瞬时**。

### 9.3 合成与布局 thrash 禁令

| 禁止 | 原因 |
|------|------|
| 动画 `top/left/width/height/margin` | 触 layout |
| 每帧 `getBoundingClientRect` 无 rAF 合并 | 强制同步布局 |
| 长期 `will-change: transform` 堆多层 | 内存与层爆炸 |
| `filter: blur` 入场 | 贵 |
| 输入时 virtual list 错误复用导致整表重挂 | 掉字与 INP 炸 |

### 9.4 允许的优化

- 进行中短暂 `will-change`，end 移除  
- 浮层 `contain: layout style`（慎测）  
- 拖拽幽灵与落点独立层  
- selection / 定位 rAF 合并  
- 大表列动画降级（§3 A16）

### 9.5 验收清单（性能）

- [ ] **PF-1** 连续输入 50 字：无动画类抖动、无 jank  
- [ ] **PF-2** slash 过滤：列表更新流畅  
- [ ] **PF-3** 拖 1 块经过 30 块：落点跟手  
- [ ] **PF-4** CI/人工 grep：无 `transition:.*box-shadow`  
- [ ] **PF-5** 中档 Windows 机 Notebook 内演示不掉帧感  

---

## 10. 排版系统（Notion 感密度 · 非 Notion chrome）

### 10.1 目标气质

- **密度**：信息紧凑、块距克制，长文可扫读——接近现代文档工具的 **垂直节奏**。  
- **非复制**：不要 Notion 的大封面、超大 H1、左右大留白营销风、灰色侧挂 UI 套件。  
- **同族**：与对话流 14px body、Notebook 面板、Composer 浮层 **同一 opacity 语言**。

### 10.2 字阶表（冻结，与 visual-system 对齐）

| 元素 | size | weight | line-height | letter-spacing | 色 |
|------|------|--------|-------------|----------------|-----|
| body / p | 14px | 400 | 1.7 | normal | l0 |
| h1 | **15px** | 600 | 1.35 | -0.01em | solid ink |
| h2 | 14px | 600 | 1.35 | normal | solid ink |
| h3 | 13px | 600 | 1.4 | normal | solid ink |
| h4–h6 | 13px | 600 | 1.4 | normal | l1 |
| 列表 | 14px | 400 | 1.65 | — | l0 |
| 引用 | 14px | 400 | 1.65 | — | l1 |
| 行内 code | 0.92em | 400 | inherit | — | solid + 浅底 |
| 代码块 | 12px | 400 | 1.55 | — | solid |
| 表格 | 13px | 400 / 600 th | 1.45 | — | solid |
| callout 标题 | 13px | 600 | 1.4 | — | solid |
| 菜单主标 | 13–14px | 400–500 | 1.3 | — | solid |
| 菜单副标 | 12px | 400 | 1.3 | — | l2 |
| placeholder | 随块 | 400 | 随块 | — | ~0.35 |

**纪律**：正文字重不上 500；标题最多 600；**禁止** 700/800 标题；**禁止** 18px+ 文档标题。

### 10.3 垂直节奏（密度核心）

| 规则 | 值 | 说明 |
|------|-----|------|
| 块间 gap | 6px | 紧凑可扫 |
| 块内 pad-y | 3px | 热区够、视觉仍紧 |
| 块内 pad-x | 2px | |
| 列表项间距 | 2px | 更紧 |
| 表前后外距 | 8–10px | 稍透气 |
| hr 上下 | 10px | hairline |
| 首块上 / 末块下 | 2 / 12 | 贴 header 与底安全区 |
| 菜单项高 | 32–34 | 手点与密度平衡 |

### 10.4 水平与 gutter

| 规则 | 值 |
|------|-----|
| 左 gutter（把手） | 28px 常在；窄面板可 22 |
| 列表缩进 | 1.25em × depth；视觉深度感 3 |
| 中文断词 | `word-break: break-word`；系统 UI 字体栈 |
| 数字 | 表格与有序清单 tabular 数字更佳 |

### 10.5 「像 Notion」但不抄的清单

| 借鉴（感觉） | 我们的落地 | 明确不抄 |
|--------------|------------|----------|
| 悬停才出把手 | A07 + 常在 gutter | 左缘大「+」常驻系统 |
| 轻 slash | A08–A10 | 命令面板重皮肤 |
| 紧凑块距 | gap 6 | 大标题封面流 |
| 表格细线 | hairline + 浅表头 | 斑马炫彩 |
| 冷静动效 | 本册 token | 弹跳与阴影呼吸 |

### 10.6 验收清单（排版）

- [ ] **TY-1** 正文 14 / 行高 ~1.7；h1=15 仅 +1 档  
- [ ] **TY-2** 长文 3 屏内不显「稀松营销页」  
- [ ] **TY-3** 与 nb-panel 同屏无第二套圆角/字号语言  
- [ ] **TY-4** 中文标点与列表标记齐平观感合格  
- [ ] **TY-5** 无 700+ 粗标题、无 18px 文档标题  

---

## 11. 空态 · 加载态 · 错误态（视觉）

> 编辑器内嵌 Notebook 时，**优先克制**；完整「应用级」空态留给宿主壳。本册分 **文档内** 与 **宿主装载** 两层。

### 11.1 文档内空态（Empty document / empty block）

| 状态 | 视觉 | 动效 | 文案 |
|------|------|------|------|
| 全新空文档 | 单一空 paragraph + placeholder | 无入场雨落 | 输入 `/` 或 `、` 插入块… |
| 空标题块 | 弱化同字阶 placeholder | 静态 | 如「标题」短提示（可选） |
| 空表 | 2×2 骨架；单元格 min-height 28 | 无 | 弱墨「」或无字 |
| 空代码 | bar + 最小高度预 | 无 | 可选语言占位 |
| slash 无匹配 | 面板内 l2 文案 | A31 高度锁 | 无匹配命令 |

**禁止**：居中大插画、Lottie、鼓励性多段营销文案抢编辑区。

### 11.2 加载态（Loading）

| 场景 | Gold 视觉 | 动效 | 禁止 |
|------|-----------|------|------|
| 宿主拉取 Markdown | 内容区 skeleton 条 **或** 极弱居中 spinner；160ms 内淡入 | opacity；reduce 瞬显 | 整页白闪；假进度乱跳 |
| 大文档解析 | 可保持上一帧或 skeleton；解析完一次 reveal | 内容 160ms opacity+Y(4px) 可选 | 逐块雨落 100+ |
| 表格/图片懒加载 | 占位盒锁高；loaded 后短 fade | 120–160ms opacity | 无占位导致 CLS |
| 扩展芯片解析中 | chip 骨架宽近似 | 90ms | 宽度 0→炸布局 |

Skeleton 规格建议：

- 条高与 body 行高同阶；圆角 4；色 `rgba(0,0,0,0.04)`  
- **禁止**高对比闪烁 shimmer 过强（可极弱 1.2s linear 位移，reduce 关闭）

### 11.3 错误态（Error）

| 场景 | Gold 视觉 | 动效 | 文案 / a11y |
|------|-----------|------|-------------|
| 文档加载失败 | 简洁图标 + 一行原因 + 重试/关闭（宿主） | 160ms 淡入 | 短句；不堆栈 |
| 块级渲染失败 | 块内错误条：左边 error 2px + 浅底；可「显示源码」 | 无 shake | `role="alert"` 适时 |
| 粘贴过大/截断 | toast 或行内提示 l1 | toast 120–160ms opacity | 说明限制 |
| 合并非法 | A19 红描边 | A39 无抖动 | 文案「无法合并」 |
| 权限只读 | 无 caret；控件 disabled 弱墨 | 无 | `aria-readonly` |

**禁止**：全屏红爆炸、错误时整编辑器 shake、自动 retry 死循环无说明。

### 11.4 状态转换矩阵

| From → To | 视觉 | 布局 |
|-----------|------|------|
| loading → ready | skeleton/spinner → 内容 fade | 骨架高≈首屏，防跳 |
| loading → error | 替换为错误面板 | 居中安全区，不顶碎壳 |
| ready → error（保存失败等） | **非阻断** toast/banner 优先 | 不卸编辑器 DOM |
| error → retry → loading | 错误淡出 → 加载 | 高度稳定 |

### 11.5 验收清单（状态）

- [ ] **ST-1** 空文档不显「半残 UI」  
- [ ] **ST-2** 加载→就绪无闪白、无大 CLS  
- [ ] **ST-3** 错误可恢复、文案短、有下一步  
- [ ] **ST-4** reduce 下状态页仍完整  
- [ ] **ST-5** 块级错误不摧毁整篇其余块  

---

## 12. CSS / JS 职责与文件落点（规范级，无实现码）

### 12.1 职责划分

| 职责 | CSS | JS |
|------|-----|-----|
| 时长曲线 token | ✅ | 仅测量时读 computed |
| hover/focus 微反馈 | ✅ | ❌ |
| enter/leave keyframes | ✅ | 类增删、end、generation |
| 浮层坐标 | 无 transition 的 left/top | ✅ 测量 + clamp |
| 是否播放 | 提供类 | ✅ 手势 / setDoc / reduce |
| 高度锁 min-height | ✅ 基线 | ✅ 模式切换时测量写入 |
| FLIP 重排 | transform 终点 | ✅ first/last/invert |
| 阴影 | static only | ❌ 不 animate |
| aria-live | — | ✅ debounce 策略 |

### 12.2 推荐落点

| 路径 | 职责 |
|------|------|
| `css/markdown-editor/motion.css` | token 映射、keyframes、reduce |
| `css/markdown-editor/chrome.css` | 把手、hover、**无丑陋 active 边** |
| `css/markdown-editor/slash-menu.css` | 面板与项 |
| `css/markdown-editor/table.css` | +、选区、ctx |
| `css/markdown-editor/focus.css` | focus-visible、selection、caret-color |
| `css/markdown-editor/base.css` | 排版、空态、placeholder 高度锁 |
| `src/motion/*` | reduced-motion、run-enter/leave、stagger |

---

## 13. 硬性禁止清单（合入门禁）

| # | 禁止项 | 替代 |
|---|--------|------|
| 1 | `transition` / `@keyframes` 驱动 `box-shadow` | static 影 |
| 2 | 块 active 粗边框 / 高对比底 / 左边粗色条（默认编辑态） | caret + 把手 + 可选极淡底 |
| 3 | 块 hover 大面积阴影卡片化 | 极淡底或仅把手 |
| 4 | overshoot bounce 导致正文晃 | soft spring 无负值 |
| 5 | 输入路径触发块 enter 动画 | 仅插入/删除/结构 |
| 6 | placeholder 显隐导致行跳 | 高度锁 / 叠层 |
| 7 | slash 插入文档流顶开正文 | portal |
| 8 | 选区工具条 left/top 插值拖尾 | 瞬移坐标 + 显隐 opacity |
| 9 | 非法操作整表 shake | 描边色 + 文案 |
| 10 | 全局 `scroll-behavior: smooth` | 按需 auto |
| 11 | 打开文档 fullRender 雨落入场 | animate:false |
| 12 | 复制 Notion 整套 chrome / 大标题体系 | 本册字阶与 Conex token |
| 13 | reduce 下功能残缺或透明残层 | 瞬切 + 完整交互 |
| 14 | 用 blur/filter 做默认入场 | opacity+transform |
| 15 | active 与 hover 高对比跳色 | 同族浅阶 |

---

## 14. 场景化验收脚本（手工）

### 14.1 动效观感（Motion Pass）

1. 系统动效正常：Enter 新块 → 微入场 settle 干净。  
2. 连续删 5 块 → 无排队卡死、最后布局稳。  
3. `/` 打开 slash → 轻上移淡入；输入过滤 → 无重播弹入。  
4. Esc 关 → 快于打开。  
5. 拖块 → 落点线淡入、无蓝罩；幽灵半透明不弹。  
6. 表 hover → + 显；点 + → 行微入场。  
7. 合并预览 → 框清晰；非法变红 **不抖**。  
8. 选区工具条 → 显隐顺；拖选移动 → 条不拖尾。  
9. 与 Flow 消息同页 → 时间节奏一家亲。  

### 14.2 稳定与焦点（Stability Pass）

1. 空文档首字、删空 → **肉眼零跳**。  
2. 上下键 20 块 → 无框闪、无底跳。  
3. 打开 slash / 右键菜单 → 正文几何不变。  
4. 中文 IME 长句 → 无壳闪。  
5. 焦点从菜单回正文 → caret 位置正确一次到位。  

### 14.3 Reduce Pass

1. 开系统减少动态效果。  
2. 重复 14.1 功能路径 → 全可完成、无动画、无残层。  

### 14.4 性能 Pass

1. 快速打字 30s → 无 jank。  
2. 粘贴 20 块 → 仅前 5 可有 stagger 感，整体不卡死。  
3. 拖拽穿越长文 → 跟手。  

### 14.5 状态 Pass

1. 模拟慢加载 → skeleton/spinner 不闪白。  
2. 模拟加载失败 → 短文案 + 重试。  
3. 块级错误 → 邻块仍可编。  

### 14.6 排版截图 Pass

1. 固定夹具文档截图：字阶、间距、表、代码、callout。  
2. 与 `07-visual-system` DoD V1–V3 勾选对齐。  
3. **无** active 行丑框。  

---

## 15. 优先级与分期

| 优先级 | 项 | 说明 |
|--------|----|------|
| **P0** | Token + reduce 全局 | 地基 |
| **P0** | §4 无丑陋 active 行 | 观感一票否决 |
| **P0** | §5 高度锁 + placeholder 不跳 | 稳定一票否决 |
| **P0** | Slash / 工具条 / 把手 / 表 + 动效 | 高频路径 |
| **P0** | 禁 shadow 动画审计 | CI grep |
| **P1** | A01/A02 块进出、A16/A17 表行列 | 完整感 |
| **P1** | A19/A20 合并预览、A39 非法 | 表能力 |
| **P1** | 加载/错误状态视觉 | 宿主集成 |
| **P2** | A25 stagger、A28 FLIP | 锦上添花 |
| **P2** | A23 代码模式 cross-fade | 注意单壳 |
| **P2** | A33 sticky 表头弱分隔 | 大表 |

---

## 16. 与既有文档的差异（本册增量）

| 既有 | 本册增量 |
|------|----------|
| `05-motion-system` A01–A27 | 扩展 **A28–A40**；全部升格 **Gold 描述** |
| 动效实现向细节 | 补强 **布局稳定 / 高度锁 / debounce** 专章 |
| visual-system 皮肤 | 冻结 **反丑陋 active 行** 为硬门禁 |
| 分散性能句 | 独立 **60fps / INP 预算** |
| 字阶表 | 重申 **Notion 感密度 vs 不抄 chrome** |
| 状态页 | 空/载/错 **分层**（文档内 vs 宿主） |

实现冲突时：**更严者优先**（通常本册门禁 + visual token 数值）。

---

## 17. 决策冻结摘要

1. **时长阶梯**：90 / 120 / 160 / 200 / 240–280ms。  
2. **曲线**：flow-spring 系；无硬 bounce。  
3. **属性**：opacity + transform 为主；bg 可；**阴影不可动画**。  
4. **Active 行**：**无丑框无重底**；靠 caret / 把手 / 可选极淡底。  
5. **行切换**：**高度锁 + 单壳优先 + portal 浮层** → 零跳动。  
6. **Slash / 菜单 / 表 +**：家族化入场；过滤不重播；+ 不占流。  
7. **Reduce**：功能完整、动画无。  
8. **性能**：输入零块动画；rAF 合并定位；60fps 体感；INP 良好。  
9. **排版**：14 体系、h1 仅 15、gap 6；密度似一线文档工具，chrome 纯 Conex。  
10. **状态**：空态克制；加载锁高；错误短句可恢复、不 shake。  
11. **打开文档 fullRender**：不动效。  
12. **JS 管状态与测量，CSS 管观感与曲线**。

---

## 18. 微交互 Gold 文案卡（A01–A40 速查）

> 供验收人口头对齐「最好是什么样」。

| ID | 一句话 Gold |
|----|-------------|
| A01 | 新块像纸页多出一行，轻轻落定，不弹。 |
| A02 | 删除像轻轻抽走，抽完位置立刻诚实，不鬼畜折叠。 |
| A03 | 类型变了，字阶变了，但页面没「吓你一跳」。 |
| A04 | 拖起来的是半透明真身，不是夸张卡片。 |
| A05 | 落点一根细线，说清楚「放这里」。 |
| A06 | 原地变淡留位，不塌坑。 |
| A07 | 把手像礼貌出现，不推挤文字。 |
| A08 | 命令面板吸气出现，阴影安静。 |
| A09 | 关掉比打开更干脆。 |
| A10 | 高亮像手指拂过浅纸，不画杠。 |
| A11 | 工具条礼貌浮现，不抢选区。 |
| A12 | 选区没了，条立刻退场。 |
| A13 | 按下有一声「咔」的色，没有整条弹跳。 |
| A14 | 表的 + 会害羞地出现。 |
| A15 | 点 + 有按压，随即结构生长。 |
| A16 | 新行新列 ded 一声到位。 |
| A17 | 删行安静离开。 |
| A18 | 选中格像荧光笔极淡一抹。 |
| A19 | 合并预览是虚线诚实框。 |
| A20 | 确认后框收走，格子成一家。 |
| A21 | 右键菜单与 slash 是亲戚。 |
| A22 | 折叠像手风琴，不砸内容。 |
| A23 | 代码读写切换不玩双门幻术。 |
| A24 | 控件焦点环清晰，正文不套蓝枷锁。 |
| A25 | 多块进来最多五片涟漪，其余老实出现。 |
| A26 | 菜单 hover 与键盘高亮同一种浅。 |
| A27 | 滚动手脚老实，不抢自动丝滑。 |
| A28 | 放下后邻块轻轻让位，不整表洗牌闪白。 |
| A29 | 空与非空，行高像尺子量过。 |
| A30 | 浮层钉死坐标，滚动时不「晃悠追」。 |
| A31 | 无匹配时面板不瘪下去丢人。 |
| A32 | 拖列宽，指示线粘在指针上。 |
| A33 | 表头粘顶只有一丝分隔，不端架子。 |
| A34 | 当前行被你看见，是因为你在写，不是因为被框住。 |
| A35 | 光标就是墨色一竖，IME 也不慌。 |
| A36 | 占位符安静待着，不呼吸不止。 |
| A37 | 掠过块时纸色几乎不变，或只变一点。 |
| A38 | 链接与芯片会点头，不抬阴影。 |
| A39 | 错了就说清楚，不把桌子抖给你看。 |
| A40 | 新块若在远处，只轻轻卷入视野，不丝滑漂移眩晕。 |

---

## 19. 交叉检查表（实现前自问）

| # | 问题 | 期望答案 |
|---|------|----------|
| 1 | 活动行有没有边框/重底？ | 没有（默认编辑态） |
| 2 | 空行打字跳不跳？ | 不跳 |
| 3 | slash 是否 portal？ | 是 |
| 4 | 阴影有没有 transition？ | 无 |
| 5 | reduce 测过吗？ | 是 |
| 6 | 输入会不会加 enter 类？ | 否 |
| 7 | 字号是否 14 体系？ | 是 |
| 8 | 表 + 占不占流高度？ | 不占 |
| 9 | 工具条移动插值吗？ | 否 |
| 10 | 错误依赖动画吗？ | 否 |
| 11 | fullRender 动效关了吗？ | 关 |
| 12 | 中文 IME 壳闪吗？ | 不闪 |
| 13 | 60fps 拖拽可接受吗？ | 是 |
| 14 | 与 flow token 数值漂移吗？ | 否 |
| 15 | 空/载/错有没有短文案与锁高？ | 有 |

---

## 20. 参考锚点

| 路径 | 内容 |
|------|------|
| `docs/markdown-editor/07-visual-system.md` | 皮肤、字阶、禁令 |
| `docs/markdown-editor/v3-complete/05-motion-system.md` | 实现向 A01–A27、token |
| `docs/markdown-editor/03-line-renderer.md` | 焦点与读写切换 |
| `docs/markdown-editor/05-slash-commands.md` | slash 行为与 a11y |
| `docs/file-preview/04-视觉与动效系统.md` | 家族动效气质 |
| `css/flow/motion.css` | spring、entrance、reduce 范例 |
| `css/design-tokens.css` | `--dur-*` / `--ease-*` |
| `css/markdown-editor/*` | 现网 chrome / table / sel-bar |

---

## 21. 文档维护

| 变更类型 | 动作 |
|----------|------|
| 新增微交互 | 分配 A41+；补 Gold 一句 + 总表行 + reduce/perf |
| 改时长 | 同步 `05-motion-system` 与 flow token，防三处漂移 |
| 改 active 行策略 | 必须更新 §4 与验收 AR-*；产品设计双签 |
| 发现跳动 bug | 记入 §5.1 来源表 + 回归 LS-* |

---

**文档结束（feature-catalog / 06）**  

本册验收口令：

> **动得克制、停得干净、行不跳、框不丑、60 帧、可关闭。**
