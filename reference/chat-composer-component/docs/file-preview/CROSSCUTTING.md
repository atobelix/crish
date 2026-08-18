# 文件预览 — 交叉决策冻结

> **版本**：1.0  
> **状态**：方案冻结（实现前如需改决策，先改本文再改代码）  
> **读者**：所有参与 file-preview 的 agent / 工程师

---

## D1 — 工作范围

| 项 | 决策 |
|----|------|
| 首选宿主 | `reference/chat-composer-component` |
| 迁移 | 规格稳定后再迁 desktop / workbench |
| 不在本阶段 | 完整在线协作编辑 Office、服务端转换管道 |

---

## D2 — 组件化边界

| 层 | 职责 | 禁止 |
|----|------|------|
| **PreviewShell** | 遮罩、入场退场、Esc、焦点陷阱、标题栏 | 解析文件 |
| **PreviewRouter** | 按 kind 选 Viewer | 直接操作 DOM 画布细节 |
| **FormatAdapter** | `File | blob | url | text` → `PreviewModel` | 画 UI 壳 |
| **Viewer\*** | 只消费 PreviewModel 渲染 | 再发明一套 modal 壳 |
| **Toolbar** | 按 capability 矩阵显示动作 | 显示「模式说明」文案 |

---

## D3 — 格式能力矩阵（目标态）

| Kind | 真解析 | 库（优先浏览器端） | 降级 |
|------|--------|-------------------|------|
| `image` | ✅ 已有加强 | 原生 + canvas | 缩略图 |
| `pdf` | ✅ 目标 | **pdf.js** | 下载 + 占位说明（非假页） |
| `markdown` | ✅ 目标 | **复用 MarkdownEditor view-only** | markdown-lite 静态 |
| `docx` | ✅ 目标 | **mammoth** → HTML 或 md | 提示不支持 + 下载 |
| `xlsx` / `xls` | ✅ 目标 | **SheetJS (xlsx)** 或轻量 CSV-only 先 | 表头预览失败则下载 |
| `csv` / `tsv` | ✅ 目标 | 自研流式/分块解析 | 纯文本 viewer |
| `code` / `text` | ✅ 目标 | 文本 + 可选 highlight | 纯 pre |
| `pptx` | P2 | 可选；默认可下载 + 元信息 | 不假装 PDF |
| `unknown` | — | — | 元信息 + 下载，不假装已解析 |

**禁止**：再出现「假 PDF 页写死概述段落」冒充解析成功。

---

## D4 — Markdown 查看态

| 项 | 决策 |
|----|------|
| 实现 | 复用 `js/markdown-editor/*`，新增 **view-only 宿主选项** |
| UI 文案 | **不出现**「只读 / 预览模式 / 不可编辑」等解释性标签 |
| 行为 | 不可聚焦编辑、无 slash、无 DnD 把手、无闪烁光标 |
| 可做 | 滚动、选中复制、目录（若有）、字号/主题若与 shell 统一 |
| 工具栏 | 仅与查看相关：关闭、下载/打开源文件、（可选）目录切换 |

详见 [05-Markdown-查看态复用.md](./05-Markdown-查看态复用.md)。

---

## D5 — 视觉与高级感

| 项 | 决策 |
|----|------|
| 语言 | 对齐 Composer + conversation-tokens：白底、细 hairline、少阴影 |
| 禁止 | 蓝色链接墙、厚重阴影呼吸、每按钮都有 hover 阴影动画 |
| 壳 | 圆角工作台卡片；backdrop 轻模糊可选（注意 Windows 性能，可降级纯色） |
| 排版 | 标题一行省略；工具栏图标 16–18px；密度接近 Linear/Notion 预览 |

---

## D6 — 动效

| 项 | 决策 |
|----|------|
| 曲线 | 与 flow 共用 `--flow-spring` / 略快时长（160–280ms） |
| 入场 | shell scale(0.98→1) + opacity；完整弧线 |
| 切换格式 | 内容区 cross-fade 或轻微 y 位移，不整页闪白 |
| 关闭 | 反向 140–180ms |
| 禁止 | 无限 bounce、阴影动画、长于 400ms 的装饰动画 |
| a11y | `prefers-reduced-motion: reduce` 时瞬切 |

---

## D7 — 数据入口

```
openPreview(source)
  source =
    | { kind:'card', el }           // 现有 file-card
    | { kind:'file', file: File }
    | { kind:'path', path, name? }  // 桌面迁移预留
    | { kind:'text', name, text, mime? }
    | { kind:'url', url, name? }
```

统一经 **PreviewRouter.resolve → Adapter.load → Viewer.mount**。

---

## D8 — 错误与降级 UX

- 解析失败：**明确**失败态（图标 + 一行人话 + 下载），不假装成功  
- 大文件：进度条或 skeleton；PDF 分页懒加载  
- 损坏文件：同失败态  
- 不支持格式：元信息卡 + 下载，**不**路由到假 PDF

---

## D9 — 安全

| 项 | 决策 |
|----|------|
| HTML（mammoth/docx） | 消毒后再插入（DOMPurify 或等价） |
| Markdown | 现有序列化链路；外链 `rel=noopener` |
| PDF | worker 同源或可信 CDN；不执行 PDF 内脚本 |
| 图片 | object URL 生命周期 `revoke` |

---

## D10 — 依赖策略

| 库 | 加载 | 备注 |
|----|------|------|
| pdf.js | 动态 import / 按需 script | 体积大，勿打进首屏 |
| mammoth | 按需 | 仅 docx |
| xlsx (SheetJS) | 按需 | 可先 CSV 真解析，xlsx 第二波 |
| highlight.js / shiki | 可选 P1.5 | code viewer |

CDN 可 demo；迁 desktop 时改为打包 chunk。

---

## D11 — 与 Notebook / Artifact 的关系

| 场景 | 打开方式 |
|------|----------|
| 对话流「已生成」文档 chip | 仍可走 NotebookPanel（编辑态） |
| 附件栏 file-card / 路径打开 | **File Preview Shell**（查看优先） |
| 同一 md 文件 | Preview = view-only；Notebook = 可编辑宿主；**不合并成双模式 toggle** |

用户明确要求：预览界面 **不要** 预览/源码硬切换文案；查看就是查看。

---

## D12 — 中文与编码

- 新文档与注释：**中文**  
- 写入方式遵循 chinese-encoding-guard  
- 不在 shell 重定向写中文源码  

---

## 变更流程

改 D1–D12 任一决策：

1. 先改本文件并 bump 版本号  
2. 同步 02 / 03 / 06 中引用处  
3. 再改代码  
