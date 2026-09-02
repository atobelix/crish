# 统一滚动条体系与 ScrollArea 高频组件架构总案

> **所属战役**：`docs/unified-scrollbar-system/`  
> **权威原则**：严格遵守根目录 `AGENTS.md`、`ANTI_OVERENGINEERING_GUARDRAILS.md` 与 §7.1 立体验证纪律。  
> **核心诉求**：彻底收敛全应用散落的滚动条配置；抽象出统一高频使用的 `<ScrollArea>` 组件；支持带/不带上下圆角三角箭头与物理防越界；宽度严格收敛于 Token 体系（严禁硬编码）；颜色严格遵循起始灰度 8.2（偏暖橙底韵）、激活灰度 20 左右（差值约 12%）的温润色阶。

---

## 一、背景与用户明确裁决

1. **高频组件抽象诉求**：
   - 客户端内部用到滚动条的地方极多（侧栏会话、主消息流、模型选择菜单、权限弹窗、Select、SmartPanel、设置各 Tab、流式表格等）；
   - 现存 18+ 处滚动条各自为政，存在硬编码、过深纯黑（激活高达 31.4）、缺少统一出口的顽疾；必须抽象为统一体系与高频组件。
2. **上下圆角三角箭头与物理防越界**：
   - 参考用户实测确认的优质形态（模型选择菜单等），支持可配置的上下圆角三角箭头（`showButtons={true|false}`）；
   - **防越界机制**：三角箭头充当轨道的端点安全护栏（Padded Endcaps），Thumb 滑块在两端箭头之间运行，物理上彻底避免了滑块贴近外层圆角或越界截断的丑态。
3. **宽度 Token 体系（严禁硬编码）**：
   - 宽度保留多层级自由定制，但**只能在 Token 体系内选取**，严禁在业务 CSS 中硬编码 `width: 5px` 或 `width: 7px`；
   - 预设 Token：`--scrollbar-width-xs` (4px)、`--scrollbar-width-sm` (5px)、`--scrollbar-width-md` (7px)、`--scrollbar-width-lg` (9px)。
4. **严格二元灰度铁律（绝不搞三种灰度）**：
   - 用户最高定案铁律：“**滚动条就是两种灰度，别给我整成三种的，就是激活和未激活，没有激活分成hover和active两种的。**”
   - **未激活态（Inactive / Idle）**：屏幕实测灰度严格保持在 **8.2 左右**（色相混入暖橘底韵 `var(--accent-orange)`，融入浅色纸温底板）；
   - **激活态（Active，光标悬停 Hover 与鼠标拖拽 Active 统统同色）**：屏幕实测灰度从当前过深的 31.4 下调至 **20 左右**；
   - **差值死锁**：激活态与未激活态之间严格保持在 **约 12% 差值**，反馈柔和明快，杜绝花哨中间态。

---

## 二、子 Agent 协同阵列与责任分工

| 子 Agent 角色 | 核心职责 | 交付文档 |
| :--- | :--- | :--- |
| **1. Scrollbar Inventory & Usage Surveyor** | 全仓滚动条与容器清单白盒普查，排查 18+ 处宿主与替换可行性 | `surveys/01-full-inventory-and-usage.md` |
| **2. Arrow Button & WebKit Engine Specialist** | 上下圆角三角箭头逆向分析、WebKit 按钮机制与技术选型 | `independent-plans/02-arrow-buttons-and-engine-mechanism.md` |
| **3. Design Token & Colorimetry Architect** | 8.2 起始 / 20 激活 / 暖橙底韵与分级宽度 Token 体系定义 | `independent-plans/03-design-token-architecture.md` |
| **4. ScrollArea Component Architect** | `<ScrollArea>` 高频组件契约、防越界控制与多级消费模式 | `independent-plans/04-scroll-area-component-plan.md` |
| **5. Cross-Platform Boundary & Devil Auditor** | 跨平台 WebView2 陷阱、高 DPI 缩放对齐、虚拟滚动兼容性魔鬼审计 | `audits/05-boundary-and-devil-audit.md` |

---

## 三、总体技术架构设计

### 1. 双层消费架构（Dual-Tier Consumption Architecture）

为了既满足 React 组件化的高效复用，又避免虚拟滚动等极端性能视口增加无谓的 DOM 包装开销，系统设计为两层无缝互通模式：

- **层级 A: `<ScrollArea>` 组件**（用于独立面板、弹窗、下拉菜单、设置等）：
  - 支持 `size="xs"|"sm"|"md"|"lg"`；
  - 支持 `showButtons={true|false}`；
  - 具备防越界几何端点保护与点击步进平滑滚动。
- **层级 B: 统一 CSS 类体系**（用于虚拟滚动、侧栏、流式长列表）：
  - `.scrollArea`、`.scrollAreaSm`、`.scrollAreaWithButtons`；
  - 纯原生 CSS，零 DOM 额外包装，零运行时 JS 损耗。

### 2. 上下三角箭头与物理防越界机理

在带有上下三角箭头的模式下：
1. **几何护栏**：轨道两端分别常驻 `ButtonSize` 的三角按钮，轨道可用滑行长度自动扣除 $2 \times \text{ButtonSize}$；
2. **端点对齐**：当内容滚动到 `scrollTop === 0` 时，Thumb 顶边恰好贴在顶部三角下缘，离外层容器圆角保持安全间距，完全消除圆角截断（Corner Clipping）；
3. **步进微调**：点击顶部三角执行向上微调平滑滚动（每次滚动 40px），点击底部三角向下微调，手感与原生 Windows / macOS 经典应用无缝对齐。
