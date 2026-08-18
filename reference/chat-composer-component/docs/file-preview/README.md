# Conex 文件预览系统（File Preview）

> **位置**：`reference/chat-composer-component/docs/file-preview/`  
> **性质**：设计与实现规格库；多 agent 执行的唯一真相源。  
> **范围**：先在 reference 做完 → 再迁 `apps/crish-desktop` / workbench。  
> **关联**：Markdown 块编辑器见 [`../markdown-editor/`](../markdown-editor/)；对话流见 `CONVERSATION_FLOW_SPEC.md`。

---

## 0. 产品一句话

做一个 **高级、克制、组件化** 的多格式文件预览工作台：

- 真实解析常用格式（PDF / Markdown / Word / 表格 / 图片 / 代码与纯文本）
- Markdown **复用**现有块编辑器，以 **仅查看** 宿主形态接入（界面不出现「只读」「预览模式」等解释性文案）
- 工具栏与图标 **只服务当前格式能做的事**
- 入场 / 切换 / 关闭动效完整但略快，符合人因与现有 flow motion 语言

---

## 1. 文档地图

| 文件 | 主题 | 用途 |
|------|------|------|
| [CROSSCUTTING.md](./CROSSCUTTING.md) | **冻结决策 D1–D12（必读）** | 多 agent 开工前 |
| [AGENT_BRIEFING.md](./AGENT_BRIEFING.md) | 子 agent 全局须知 | spawn 时注入 |
| [README.md](./README.md) | 本总览 | 导航 |
| [00-现状与差距.md](./00-现状与差距.md) | 当前代码体检 | 为何重构 |
| [01-产品愿景与信息架构.md](./01-产品愿景与信息架构.md) | 目标 / 非目标 / 场景 | 产品边界 |
| [02-架构与组件树.md](./02-架构与组件树.md) | 模块边界、数据流 | 实现蓝图 |
| [03-格式适配器.md](./03-格式适配器.md) | 各格式解析与降级 | 适配器规格 |
| [04-视觉与动效系统.md](./04-视觉与动效系统.md) | 壳层 UI + motion | 高级感落地 |
| [05-Markdown-查看态复用.md](./05-Markdown-查看态复用.md) | 编辑器 view-only 宿主 | 复用方案 |
| [06-实现路线图与多-Agent分工.md](./06-实现路线图与多-Agent分工.md) | 分期 + agent DAG | **执行入口** |
| [adapters/](./adapters/) | 单格式深度说明 | 按需实现 |
| [ux/](./ux/) | 工具栏矩阵、快捷键 | 交互细节 |

---

## 2. 执行顺序（摘要）

详见 [06-实现路线图与多-Agent分工.md](./06-实现路线图与多-Agent分工.md)。

```
P0  壳层组件化 + 路由 + 动效骨架
P1  Markdown 查看态（复用 MdxEditor）
P2  PDF 真解析（pdf.js）
P3  表格（CSV 真解析 + XLSX 库）
P4  Word（docx → HTML/Markdown）
P5  代码/纯文本 + 图片工作台精修
P6  演示数据、无障碍、迁 desktop 清单
```

**本阶段交付物**：方案文档 + **P0–P6 实现（reference 已落地）**。

| Phase | 状态 |
|-------|------|
| P0 壳/路由/工具栏/动效 | ✅ |
| P1 Markdown viewOnly | ✅ |
| P2 PDF (pdf.js) | ✅ |
| P3 表格 CSV/XLSX | ✅ |
| P4 DOCX (mammoth) | ✅ |
| P5 Image 工作台 | ✅ |
| P6 Text + 收口 | ✅ |

代码入口：`js/file-preview/` · 样式：`css/file-preview/` · 夹具：`fixtures/file-preview/`

---

## 3. 与现有代码的关系

| 现状 | 走向 |
|------|------|
| `js/preview-modal.js` 单体 ~676 行 | 拆为 `js/file-preview/*` 组件树 |
| `css/preview-modal.css` | 拆为 `css/file-preview/*` + tokens |
| PDF `renderRealPdfFile` 假 HTML | pdf.js 真渲染 |
| docx / xlsx 无解析 | 独立 adapter |
| Markdown 无 viewport | 复用 `markdown-editor` view-only |
| 图片裁剪/画笔已有 | 保留能力，收入 ImageViewer 组件 |

---

## 4. 阅读建议

1. 先读 **CROSSCUTTING**  
2. 再读 **00 现状** 与 **02 架构**  
3. 实现时读 **06 路线图** 对应 Phase 的 agent 提示  
4. Markdown 相关必读 **05** + `docs/markdown-editor/CROSSCUTTING.md`
