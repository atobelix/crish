# Conex / Crish — 自研现代化原子组件体系与 Appica 动效解构总方案

> **战役工作区**：`docs/ui-component-modernization/`  
> **版本**：v1.0 (Master Architecture Blueprint)  
> **设计基准与思想源泉**：深入解构 `reference/appica-ui/` 优秀动效、物理学与几何体系  
> **最高铁律**：**严禁引入第三方外部 npm 组件库，严禁复制粘贴代码；100% 纯净自研，掌握核心动效算法与同心几何，打造符合 Crish Design Tokens 的顶级原生组件。**

---

## 战役总览与 5 大核心组件矩阵

```
                               ┌──────────────────────────────────────────────────────────┐
                               │  Crish Native Modern Component Architecture (Zero-Deps)  │
                               └────────────────────────────┬─────────────────────────────┘
                                                            │
         ┌───────────────────┬──────────────────────┼──────────────────────┬───────────────────┐
         ▼                   ▼                      ▼                      ▼                   ▼
  【1. Switch】        【2. Tabs】          【3. Select/Combobox】   【4. PreviewCard】     【5. Toast】
  流体果冻拉伸 1.56x    3.5% 灰底+纯白滑块     同心圆角 8px↔14px↔8px   双层贝塞尔平滑小三角    3D 层叠缩放 1-0.1*i
  微勾选 SVG 动态绘制   弹性微回弹 0.97 按压    Chips 自适应多选排版    Safe-Aim 防误触多边形   悬停扇形展开自适应
  品牌绿 #10b981        FLIP / CSS 单变量驱动  Raycast 全键盘无障碍    弹性气泡入场缩放        倒计时条+手势滑离
```

---

## 一、5 大组件的核心解构与自研方案速查

### 1. Switch（流体果冻拉伸开关）
- **详案文档**：[`01-Switch流体果冻动效与自研React实现方案.md`](./independent-plans/01-Switch流体果冻动效与自研React实现方案.md)
- **核心精髓**：
  - **Pill Stretch 动力学**：滑块在 $0\% \to 50\%$ 移动时横向拉伸至 $1.56\times$ 宽度（$16\text{px} \to 25\text{px}$），前缘提前触达终点边界，后缘受张力回缩恢复正圆；
  - **SVG Checkmark 延迟绘制**：滑块落定前 $200\text{ms}$，内部微对勾通过 `strokeDashoffset: 12 -> 0` 动态一笔勾勒；
  - **项目专属品牌绿**：`var(--brand, #10b981)`，关闭为 `var(--switch-track-bg)`，支持 `sm` / `md` / `lg` 三档与 `loading` 锁定态。

### 2. Tabs / SegmentedControl（3.5% 灰底纯白卡片分段滑块）
- **详案文档**：[`02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md`](./independent-plans/02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md)
- **核心精髓**：
  - **严格色彩规范**：底板为纯中性 3.5% 暖灰 `var(--bg-secondary)`，滑块为纯白卡底 `var(--bg-card)` + 发丝边框 `var(--border-subtle)` + 微投影；
  - **物理弹性微回弹**：`transition: transform 250ms cubic-bezier(0.175, 0.885, 0.32, 1.5)`，产生 $5\% \sim 8\%$ 的自然微过冲；
  - **按压缩放反馈**：按下时 `scale(0.97)` + `translateY(1px)` 模拟真实机械下陷；
  - **同心几何**：$R_{\text{inner}} = R_{\text{outer}} - \text{Padding}$（如外框 7px/8px，滑块 5px/6px）。

### 3. Select / Combobox（同心圆角与原生搜索多选体系）
- **详案文档**：[`03-Select与Combobox同心圆角与原生搜索方案.md`](./independent-plans/03-Select与Combobox同心圆角与原生搜索方案.md)
- **核心精髓**：
  - **彻底消灭圆角脱节**：Trigger 外壳（8px）↔ Popup 浮层（14px，Padding 6px）↔ Item 行（8px）严格几何对齐；
  - **Compound 架构**：`<Select>` / `<Combobox>` 支持任意分组、Slot、清除按钮与多选 `<ComboboxChips>`；
  - **零依赖浮层解算**：继承 `position.ts` 纯函数，动态注入 `--anchor-width`，双向碰撞自动翻折（Flip Y/X）；
  - **Raycast 级体验**：全键盘漫游 + IME 输入法合成锁防误触。

### 4. PreviewCard / RichTooltip（富媒体悬停预览与贝塞尔小三角）
- **详案文档**：[`04-PreviewCard富媒体悬停预览与贝塞尔小三角方案.md`](./independent-plans/04-PreviewCard富媒体悬停预览与贝塞尔小三角方案.md)
- **核心精髓**：
  - **双层贝塞尔平滑小三角**：三次贝塞尔圆角倒角（$R \approx 3.2\text{px}$）+ 填充层深插卡片内壁，消灭 1px 白缝与直角生硬感；
  - **Safe-Aim 120Hz 虚拟碰撞多边形**：基于 2D 向量叉积，光标斜向移动时维持浮层开启，彻底杜绝悬停死区；
  - **弹性缩放入场**：`cubic-bezier(0.175, 0.885, 0.32, 1.5)` 气泡式轻微回弹浮现。

### 5. Toast（3D 层叠缩放与悬停扇形展开通知中心）
- **详案文档**：[`05-Toast3D层叠缩放与悬停扇形展开通知方案.md`](./independent-plans/05-Toast3D层叠缩放与悬停扇形展开通知方案.md)
- **核心精髓**：
  - **3D 空间层叠卡片**：最新一张 1.0，后方各张依次缩放为 `--scale: max(0, 1 - 0.1*i)`，顶部向上露出发丝阶梯 `--peek: 12px`，只占单张屏幕高度；
  - **悬停扇形展开**：鼠标移入时自动平滑展开为自适应垂直列表，时钟毫秒级冻结；
  - **手势滑离（Swipe to Dismiss）**：支持 Pointer Events 拖拽与弹性阻尼；
  - **Promise 异步流转**：原生 `toast.promise()`（Loading $\to$ Success / Error 原地过渡）。

---

## 二、战役文档清单索引

| 序号 | 方案文档 | 涉及组件 | 状态 |
|---|---|---|---|
| **01** | [`01-Switch流体果冻动效与自研React实现方案.md`](./independent-plans/01-Switch流体果冻动效与自研React实现方案.md) | `ui/Switch` | 详案已落盘 |
| **02** | [`02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md`](./independent-plans/02-Tabs与分段滑块3.5灰底纯白卡片动效方案.md) | `ui/Tabs` / `ui/SegmentedControl` | 详案已落盘 |
| **03** | [`03-Select与Combobox同心圆角与原生搜索方案.md`](./independent-plans/03-Select与Combobox同心圆角与原生搜索方案.md) | `ui/Select` / `ui/Combobox` | 详案已落盘 |
| **04** | [`04-PreviewCard富媒体悬停预览与贝塞尔小三角方案.md`](./independent-plans/04-PreviewCard富媒体悬停预览与贝塞尔小三角方案.md) | `ui/PreviewCard` / `ui/Tooltip` | 详案已落盘 |
| **05** | [`05-Toast3D层叠缩放与悬停扇形展开通知方案.md`](./independent-plans/05-Toast3D层叠缩放与悬停扇形展开通知方案.md) | `services/toast` / `ToastViewport` | 详案已落盘 |

---

## 三、下一步实施规划（自研零依赖落地）

1. **第一波（Wave 1 - 交互微动效基元）**：
   - 落地全新 `ui/Switch`（果冻拉伸 + SVG 勾选描边 + 品牌绿）；
   - 落地全新 `ui/Tabs` 与增强 `ui/SegmentedControl`（3.5% 灰底 + 纯白滑块 + 0.97 按压缩放）。
2. **第二波（Wave 2 - 浮层与选择基元）**：
   - 落地全新 `ui/Select`（同心圆角 8px/14px + Compound 模式 + 兼容适配器）；
   - 落地全新 `ui/Combobox`（单选/多选 Chips + 原地拼音模糊搜索 + 高亮）。
3. **第三波（Wave 3 - 浮层预览与通知中心）**：
   - 落地全新 `ui/PreviewCard`（双层贝塞尔平滑小三角 + Safe-Aim 防误触）；
   - 落地全新 3D 层叠 `ToastViewport` 与 `toast.promise()`。
