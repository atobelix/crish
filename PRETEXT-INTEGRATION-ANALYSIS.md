# Pretext 库集成分析报告

> 3 个 Agent 交叉分析：API 能力、DOM 优化场景、集成可行性

---

## 一、Pretext 是什么？

Pretext (`@chenglou/pretext@0.0.8`) 是一个纯 JS/TS 文本测量与布局库。核心创新：**用 Canvas 测量文本宽度 + 纯算术做换行布局，完全不触发 DOM layout/reflow**。

### 核心 API

```
prepare(text, font)     → PreparedText（一次性昂贵计算：分词 + Canvas 测量）
layout(prepared, width, lineHeight) → { height, lineCount }（热路径：纯算术，~0.0002ms）
```

---

## 二、在 Crish 中可优化的 5 个场景

| 场景 | 可行性 | 当前问题 | Pretext 方案 | 预期收益 |
|------|--------|---------|-------------|---------|
| **1. Composer 自动增长** | ✅ 完全可行 | 每次按键触发 `scrollHeight` 强制布局 | 用 `prepare()` + `layout()` 计算高度，直接设 `el.style.height` | **消除所有同步布局**，从 O(DOM) → O(1) |
| **2. 工具输出像素截断** | ✅ 完全可行 | `TOOL_OUTPUT_DOM_CHAR_CAP = 8000` 按字符数截断不准确 | 按像素高度截断（Pretext 测量 `<pre>` 实际高度） | 截断更准确，避免 DOM 溢出 |
| **3. 消息列表虚拟滚动** | 🟡 部分可行 | `MESSAGE_ESTIMATED_ROW_HEIGHT = 120` 固定估算 | 纯文本消息高度精确测量；但含工具调用/图片的消息仍需 DOM | 滚动更准确，可消除 `scrollHeight` |
| **4. Markdown 骨架占位** | 🟡 部分可行 | 纯文本 loading 态与渲染后高度不同导致 CLS | 骨架占位使用 Pretext 测量的精确高度 | 减少布局偏移，但不能像素级精确 |
| **5. 侧栏标题截断** | 🟢 低价值 | CSS `text-overflow: ellipsis` 已高效 | Pretext 检测是否截断 | 收益极小，CSS 已最优 |

---

## 三、集成可行性

| 维度 | 结论 | 说明 |
|------|------|------|
| 安装方式 | 🟢 npm install | 零依赖，MIT 许可证 |
| 体积 | 🟢 3-5 KB gzip | tree-shake 友好 |
| ESM 兼容 | 🟢 完全兼容 | Vite 原生支持 |
| 字体对接 | 🟡 需桥接 | 需从 `tokens.css` / `fontStore` 构建 CSS font 字符串 |
| 运行环境 | 🟢 Tauri 全部支持 | WebView2 / WKWebView 均支持 Canvas |
| 并发安全 | 🟢 安全 | 单线程 + 同步 API |

---

## 四、推荐实施方案

1. **安装依赖**：`npm install @chenglou/pretext@0.0.8`
2. **创建字体桥接**：`src/utils/pretextFontBridge.ts`（从 `fontStore` 和 `tokens.css` 构造 font 字符串）
3. **封装 hook**：`src/hooks/useTextMeasure.ts`
4. **优先改造 Composer** (`useAutoGrowTextarea.ts`) — 收益最大，改造成本最低
5. **其次改造工具输出截断** (`ChatToolCallBlock.tsx`)
