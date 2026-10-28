# UI 原子层（components/ui）Agent 协作红线指南

本目录是前端第一层「UI 原子层」，所有修改必须遵守以下 6 大核心铁律，违者门禁硬阻断：

1. **分层隔离零业务依赖**：
   - 严禁 import 业务组件、`store/`、`hooks/`、`api/`、`services/` 等非原子层代码；
   - 状态与事件回调一律通过 Props 传入，保持组件纯粹可复用与零业务粘连。

2. **样式 Design Tokens 唯一源**：
   - 颜色/间距/圆角/字号一律使用 `var(--token)`（统一定义于 `styles/tokens.css`）；
   - 严禁使用裸 Hex（`#fff`）、裸 RGB/RGBA 或任意硬编码数值。

3. **严禁内联裸样式与裸数值**：
   - 严禁在 `style={{...}}` 中写裸数值（`gap: 8`）、裸 px（`'12px'`）或裸色值；
   - 动态布局与私有样式请迁入同名 `.module.css` 或直接消费标准 Design Token。

4. **CVA 变体与 cn 组合范式**：
   - 视觉与尺寸变体必须使用 `cva` 声明，类名合并统一使用 `cn(...)`；
   - 严禁在 JSX 模板中手写三元表达式做原始字符串拼接。

5. **Tooltip 规范（严禁原生 title）**：
   - 严禁在任何原生 DOM 或组件上使用 HTML `title="..."` 属性（观感陈旧且破坏视觉）；
   - 必须统一使用 `<Tooltip content="...">` 组件包裹可交互元素。

6. **输入框与焦点态硬约束**：
   - 焦点态对比度混入上限严格 <=10%（`color-mix(in srgb, var(--border-color) 90%, var(--text-primary) 10%)`）；
   - 严禁粗、深、实心黑边（如纯黑环），焦点投影严禁粗重（`box-shadow <= 1.5px`）；
   - 搜索与内联筛选框（形态 ④）必须为无边框纯净型（透明背景与边框，仅光标闪烁）。

---

## 规范补充（导出面与 React 19 范式）
- **最小化导出面**：每个组件仅 export 组件本身及 `*Props` 类型，禁止导出内部私有 helper。
- **React 19 纯函数范式**：使用 Ref-as-prop，严禁使用 `forwardRef` 样板包装。

---

> 违规速查：运行 `npm run gate:report` 输出只读治理报告（不写盘）；修改必须用原生编辑工具逐处落地（AGENTS §17）。组件 API 详见同目录 `llms.txt`。