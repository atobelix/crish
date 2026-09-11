# Conex / Crish — Markdown 统一架构战役索引与执行纪律

> **战役工作区**：`docs/markdown-unified-architecture/`
> **文档性质**：战役根目录导航、纪律与索引规范文档

---

## 一、 战役工作区结构规范遵循

本战役严格恪守 `AGENTS.md` §4 与 `docs/agent-roles/README.md` 规范：

```
docs/markdown-unified-architecture/
├── 00-master-plan.md                  # 方案实现总文档（权威 SSOT 总纲）
├── 01-index-and-discipline.md         # 战役索引、调度状态与纪律规范（本文件）
└── independent-plans/                 # 唯一一级子文件夹：多 Agent 独立方案集
    ├── 01-kernel-and-ast-plan.md      # 维度一：Rust 内核与 AST 契约
    ├── 02-token-and-typography-plan.md# 维度二：Design Tokens 与全局排版体系
    ├── 03-unified-component-architecture-plan.md # 维度三：统一组件与消费端收敛
    ├── 04-table-and-interaction-plan.md          # 维度四：表格物理排版与交互总线
    ├── 05-verification-and-gates-plan.md         # 维度五：立体验证与 CI 质量门禁
    └── 06-challenger-fullstack-plan.md           # 维度六：全栈系统批判与净收敛
```

- **根目录白名单**：根目录仅存放总方案（`00-master-plan.md`）与导航纪律文档（`01-index-and-discipline.md`），无任何多余杂物文件；
- **子文件夹仅一级**：所有各领域专家的独立调研方案归入 `independent-plans/`，严禁多层嵌套。

---

## 二、 核心架构演进与执行纪律

1. **单一真理源（SSOT）纪律**：
   - 杜绝双轨/多轨逻辑：统一由 Rust `conex-markdown` 担任解析编译真理源，TS 端回退层保持契约对齐；
   - 统一由 `<MarkdownDocumentView>` 担任静态完成态消费入口，全仓废除直接拼装 `dangerouslySetInnerHTML`。
2. **零硬编码与 Token 绝对守门**：
   - 严禁在 Markdown 样式中书写任何裸 Hex / 裸 RGB 颜色；
   - 强制使用 `tokens.css` 中声明的 `--md-*` 语义化变量，混色使用现代 `color-mix(in srgb, ...)` 或 `hsl()` 语法。
3. **彻底消除功能伪连通**：
   - 代码复制必须具备真实剪贴板写入、`.is-copied` 挂载与 1.5s 对勾状态反馈；
   - 路径跳转必须拆解目标行列号（`path:line:col`）并联动真实工作区编辑器；
   - 外部链接必须由系统安全沙箱接管打开。
4. **立体验证纪律（AGENTS.md §7.1）**：
   - 必须通过双端结构对齐单测、Token 静态扫描脚本，并在以 `SECURITY.md` 为基准的现场视觉中严格对齐验收，严禁单一检查冒充验收。
