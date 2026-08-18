# 09 — 实现路线图（Implementation Roadmap）

> **读者**：排期、多 agent 分派、验收  
> **依赖**：[07](./07-visual-system.md)、[08](./08-integration.md)、[AGENT_BRIEFING](./AGENT_BRIEFING.md)  
> **原则**：每阶段 **可演示（demoable）**；工作包按 **文件所有权** 切开，减少冲突。

---

## 1. 目标 / 非目标

### 目标

- M0→M6 增量交付块编辑器；每阶段有明确 DoD、测试、复杂度。
- 首宿主 Notebook；末段为 perf + desktop 移植预备。
- 多 agent 可并行：CSS / 引擎 / 宿主 / 测试 分人。

### 非目标

- 本路线图 **不** 在设计轮写完整引擎代码。
- 不含协同、评论、版本树、移动端原生。
- 不把对话流 Phase 0–2 重做绑进编辑器排期。

---

## 2. 总览

| 阶段 | 名称 | 演示一句话 | 复杂度 |
|------|------|------------|--------|
| **M0** | Scaffold | 空编辑器挂进 Notebook body | S |
| **M1** | 行级读写 | 段/标题/列表可读可编 | L |
| **M2** | Slash | `/` 与 `、` 插入块 | M |
| **M3** | DnD | 拖把手重排 | M |
| **M4** | 抛光块 | 表 / 代码 / callout 精致 | L |
| **M5** | 扩展 | file-chip / wiki-link | M |
| **M6** | Perf + 桌面预备 | 虚拟化 + 包边界清晰 | L |

```
M0 ─┬─► M1 ─┬─► M2 ─► M3 ─┬─► M4 ─► M5 ─► M6
    │       │              │
    │       └─ 可提前开 CSS 骨架（07）
    └─ flag + host 骨架（08）
```

**硬依赖**：M1 ← M0；M2/M3 ← M1；M4 可与 M3 部分并行（表编辑 vs DnD）；M5 ← M1 + 部分 M4 链接皮肤；M6 ← M1 稳定 API。

---

## 3. 仓库落点（实现时）

```
reference/chat-composer-component/
  js/markdown-editor/
    index.js              # mount/destroy 导出
    model.js              # Block 类型 + 事务
    parse.js              # md → blocks
    serialize.js          # blocks → md
    editor.js             # 输入/选区/命令
    registry.js           # registerBlockType
    host-notebook.js      # Notebook 适配
    blocks/               # paragraph.js, heading.js, …
    ui/                   # slash-menu.js, handle.js, dnd.js
    virtualize.js         # M6
  css/markdown-editor/    # 见 07 §10
  docs/markdown-editor/   # 本设计库
  tests/markdown-editor/  # 单测 / 往返 / 交互
```

未来 desktop：`packages/markdown-editor` 或 `apps/crish-desktop/src/features/markdown-editor`（M6 定案）。

---

## 4. 多 Agent 文件所有权（全局）

| Owner 角色 | 独占路径 | 可读可建议 |
|------------|----------|------------|
| **A-Engine** | `js/markdown-editor/model|parse|serialize|registry|editor.js` | blocks/* |
| **B-Blocks** | `js/markdown-editor/blocks/**` | registry 注册点 |
| **C-UI** | `js/markdown-editor/ui/**`、`css/markdown-editor/**` | editor 钩子 |
| **D-Host** | `host-notebook.js`、`NotebookPanel.js` 接入段、flags | index 导出 |
| **E-Test** | `tests/markdown-editor/**`、fixtures | 全部只读实现 |
| **F-Docs** | `docs/markdown-editor/**` | — |

冲突规则：改 `NotebookPanel.js` **仅 D-Host**；改 `artifact-notebook.css` 需与 C-UI 协调（优先不改，用 mdx 覆盖）。

---

## 5. M0 — Scaffold

### 5.1 目标

包骨架 + **空** `.mdx-root` 挂到 Notebook；flag 可回退 lite。

### 5.2 文件

| 路径 | Owner | 动作 |
|------|-------|------|
| `js/markdown-editor/index.js` | A | `mount` / `destroy` / 空 handle |
| `js/markdown-editor/host-notebook.js` | D | 适配 API |
| `css/markdown-editor/_tokens.css` | C | 变量 |
| `css/markdown-editor/base.css` | C | root 最小样式 |
| `css/markdown-editor/index.css` | C | import |
| `js/components/NotebookPanel.js` | D | flag 分支 mount |
| `index.html`（demo） | D | 引入 css/js |
| `tests/markdown-editor/m0-mount.test.js` | E | mount/destroy |

### 5.3 测试

- mount 后 host 内存在 `.mdx-root`
- destroy 后节点移除、无泄漏监听（简单计数）
- `blockEditor:false` 仍出现 `.nb-content` + lite

### 5.4 验收（Demo）

1. 打开 artifact → Notebook 白底区域可见 mdx 根（可显示「编辑器 M0」占位一行）。  
2. 关 pin 关面板、拖 header 仍正常。  
3. flag 关闭 → 旧 click-to-edit source 行为恢复。

### 5.5 依赖 / 复杂度

- 依赖：无  
- **S**（0.5–1d）

---

## 6. M1 — 段 / 标题 / 列表 行级读写

### 6.1 目标

parse/serialize 基础块；**整块**阅读渲染 + 点击进入编辑；autosave 写 docStore；**禁止**全文 `innerHTML` 重绘。

### 6.2 文件

| 路径 | Owner |
|------|-------|
| `model.js` `parse.js` `serialize.js` `registry.js` `editor.js` | A |
| `blocks/paragraph.js` `heading.js` `list.js` | B |
| `css/.../blocks.css` `focus.css` | C |
| `host-notebook.js` + `NotebookPanel` flush/onAutosave | D |
| `tests/**/parse-serialize-roundtrip.test.js` | E |
| `tests/**/m1-edit.test.js` | E |

### 6.3 功能清单

- [ ] `#`–`###`、段落、ul/ol 往返
- [ ] 块 click → 该块编辑（contenteditable 或 textarea 策略按 03）
- [ ] Enter 拆块 / Backspace 合并（最小可用）
- [ ] debounce 400ms → `docStore`
- [ ] 空文档占位提示

### 6.4 测试

- 往返夹具 ≥ 15 篇（中英混排、列表嵌套 1 层）
- 编辑单块不触发其它块 DOM 替换（mutation 断言或 spy）
- flush 后 reopen 内容一致

### 6.5 验收（Demo）

1. 打开含标题+列表的生成文档 → **阅读态**精致而非 raw MD。  
2. 改一段字 → 切块/关面板 → 再开，字还在。  
3. 性能：输入时无整页闪白。

### 6.6 依赖 / 复杂度

- 依赖：M0  
- **L**（3–5d）

### 6.7 工作包拆分

| WP | 内容 | Owner | 并行 |
|----|------|-------|------|
| WP-1a | model + transaction | A | 先 |
| WP-1b | parse/serialize | A | 接 1a |
| WP-1c | paragraph/heading/list 视图 | B | // 1b 后半 |
| WP-1d | editor 选区/回车 | A+B | 接 1c |
| WP-1e | host autosave | D | // 1d |
| WP-1f | 往返测试 | E | // 1b |

---

## 7. M2 — Slash + `、` 面板插入

### 7.1 目标

空段或行首 `/`、中文 `、` 打开命令面板；选命令插入/转换块。

### 7.2 文件

| 路径 | Owner |
|------|-------|
| `ui/slash-menu.js` | C/A |
| `css/slash-menu.css` | C |
| `editor.js` 触发与过滤 | A |
| `registry` slash 元数据 | B（各块自描述） |
| `tests/m2-slash.test.js` | E |
| 文档对齐 `05-slash-commands.md` | F |

### 7.3 功能清单

- [ ] 触发：行首 `/`、行首 `、`（flag `slashChineseDun`）
- [ ] 模糊过滤中英文关键词
- [ ] 键盘 ↑↓ Enter Esc（见 keyboard-map）
- [ ] 插入 paragraph→heading/list/…（M4 类型可先占位 disabled）
- [ ] 菜单定位与 notebook 边界 flip

### 7.4 测试

- 触发/过滤/插入后 MD 快照
- `、` 与 `/` 等价用例
- Esc 关菜单不关面板

### 7.5 验收（Demo）

1. 新行输入 `、标题` → 选「标题 1」→ 块变为 h1。  
2. 鼠标与键盘均可完成一次插入。  
3. 菜单视觉符合 07（static shadow）。

### 7.6 依赖 / 复杂度

- 依赖：M1  
- **M**（2–3d）

---

## 8. M3 — DnD 重排

### 8.1 目标

Notion 式左侧把手拖拽重排；落点 2px 指示线；序列化顺序更新。

### 8.2 文件

| 路径 | Owner |
|------|-------|
| `ui/dnd.js` `ui/handle.js` | C |
| `css/chrome.css` `dnd.css` | C |
| `model` 重排事务 | A |
| `tests/m3-dnd.test.js` | E |

### 8.3 功能清单

- [ ] hover 显 handle；pointer 拖拽
- [ ] drop indicator；禁止错误嵌套（v1 平铺列表为主）
- [ ] 与 **header 拖面板** 事件隔离
- [ ] 键盘：Alt+↑/↓ 移块（最低 a11y）

### 8.4 测试

- 重排后 serialize 顺序
- 拖到首/尾边界
- header 拖动不被 handle 抢（集成）

### 8.5 验收（Demo）

1. 三块文档拖中间到顶部，保存再开顺序正确。  
2. 拖拽中有指示线，无整页蓝罩。  
3. pin 面板拖 header 仍移动窗口。

### 8.6 依赖 / 复杂度

- 依赖：M1（M2 非硬依赖，可并行收尾）  
- **M**（2–4d）

---

## 9. M4 — 表 / 代码 / Callout 抛光

### 9.1 目标

可建表、改单元格；围栏代码 + 语言条；callout 变体；视觉 DoD（07 §14）过线。

### 9.2 文件

| 路径 | Owner |
|------|-------|
| `blocks/table.js` `code.js` `callout.js` `quote.js` | B |
| `parse/serialize` 扩展 | A |
| `table.css` `code.css` `callout.css` | C |
| slash 词条启用 | B+C |
| 视觉 fixtures + 截图清单 | E+C |

### 9.3 功能清单

- [ ] GFM 表：增删行/列（最小）、单元格编辑
- [ ] 代码块：进出 fence、lang 可选
- [ ] callout：note/tip/warn（序列化语法见 06）
- [ ] quote 皮肤
- [ ] 无合并单元格（v2）

### 9.4 测试

- 表 round-trip；含空单元格
- 代码内 MD 字符不二次解析
- 截图清单 V3–V5

### 9.5 验收（Demo）

1. slash 插入 3×3 表，填中文，保存再开不丢。  
2. 代码块与 callout 观感「不像 Bootstrap」。  
3. 与 nb-panel 同族，无 hover 阴影。

### 9.6 依赖 / 复杂度

- 依赖：M1；slash（M2）强烈建议先完成  
- **L**（3–5d）

### 9.7 并行包

| WP | Owner |
|----|-------|
| 表模型+编辑 | B |
| 代码块 | B |
| callout+quote | B |
| CSS 抛光 | C |
| parse 表/fence | A |

---

## 10. M5 — 扩展 file-chip / wiki-link

### 10.1 目标

扩展语法解析/渲染/插入；`onOpenPath` 打通。

### 10.2 文件

| 路径 | Owner |
|------|-------|
| `blocks` 或 `extensions/file-chip.js` `wiki-link.js` | B |
| 行内 token 解析 | A |
| `onOpenPath` host | D |
| 皮肤 `mdx-file-chip` | C |
| `tests/m5-extensions.test.js` | E |
| 对齐 `06-extensions.md` | F |

### 10.3 功能清单

- [ ] wiki `[[page]]` / 约定语法往返
- [ ] file-chip 行内组件（只读点击打开）
- [ ] slash 插入 chip 占位
- [ ] 安全：路径消毒

### 10.4 测试

- 解析/序列化；非法协议拒绝
- 点击回调参数

### 10.5 验收（Demo）

1. 文档内 chip 与流内 artifact 气质接近。  
2. 点击触发 host 回调（console/demo 即可）。  
3. flag 可关扩展。

### 10.6 依赖 / 复杂度

- 依赖：M1；视觉 07；集成 08  
- **M**（2–3d）

---

## 11. M6 — 虚拟化 + Desktop 移植预备

### 11.1 目标

- 文档 &gt;500 块可开虚拟窗口；滚动仍可用。  
- API/包边界适合搬进 `crish-desktop`；无 window 全局死绑。

### 11.2 文件

| 路径 | Owner |
|------|-------|
| `virtualize.js` | A |
| editor 窗口化渲染 | A |
| `index` 双导出 ESM | A |
| desktop 挂载样例文档（可仅 docs + 伪代码） | D/F |
| perf 测试 fixtures 1k 块 | E |
| CSS sticky/scroll 微调 | C |

### 11.3 功能清单

- [ ] `features.virtualize` 或 auto &gt;500  
- [ ] 滚动锚定；编辑时正确 mount 可见块  
- [ ] 无 `window.FlowComponents` 硬依赖（注入 host）  
- [ ] README 移植清单（peer：tokens、mount）

### 11.4 测试

- 1k 块首屏可交互时间预算（自定 baseline，记文档）
- 虚拟化开关往返编辑不丢块

### 11.5 验收（Demo）

1. 大文档滚动流畅，输入无整表重绘。  
2. 展示「零全局」mount 示例页。  
3. 移植检查表全部勾选（见下）。

### 11.6 Desktop 移植检查表

- [ ] 纯 JS 入口，无 demo-only 副作用
- [ ] CSS 不依赖未文档化的全局顺序（除 tokens）
- [ ] 回调可接 React state
- [ ] 触控板滚动 + 浮层 z-index 可配
- [ ] 中文 `、` 在桌面 IME 下可测

### 11.7 依赖 / 复杂度

- 依赖：M1 API 稳定；建议 M4 后  
- **L**（3–6d）

---

## 12. 跨阶段质量门

每阶段合并前：

| 门 | 标准 |
|----|------|
| 往返 | 本阶段涉及语法 round-trip 绿 |
| 宿主 | Notebook pin/drag/Esc 未回归 |
| 视觉禁令 | 无 hover shadow；无预览源码 soft toggle chrome |
| 安全 | 无 raw HTML 注入；链接 rel |
| 中文 | 文件 UTF-8；界面文案无 `?` 乱码 |
| 性能 | 输入路径无全文 re-parse（M1+ 起） |

---

## 13. 风险与缓解

| 风险 | 缓解 |
|------|------|
| contenteditable 光标坑 | 块级隔离；单测选区；必要时 textarea 方案 |
| 与 panel 拖拽冲突 | handle `stopPropagation`；测试 M3 |
| 表编辑范围膨胀 | M4 砍合并/粘贴 Excel 到 v2 |
| 虚拟化与测量 | M6 前 API 预留 `getBlockHeight` |
| 多 agent 改同一文件 | §4 所有权；registry 只追加 |

---

## 14. 建议排期（参考人日）

| 阶段 | 人日 | 可演示日（累计） |
|------|------|------------------|
| M0 | 1 | D1 |
| M1 | 4 | D5 |
| M2 | 2.5 | D8 |
| M3 | 3 | D11 |
| M4 | 4 | D15 |
| M5 | 2.5 | D18 |
| M6 | 4 | D22 |

单人串行约 **3–4 周**；A+B+C 并行可压到 **~2 周**。

---

## 15. 阶段退出检查（汇总 DoD）

- [ ] **M0** 空编辑器在 notebook 内；flag 回退  
- [ ] **M1** 段标题列表读写 + autosave + 无全文闪烁  
- [ ] **M2** `/` 与 `、` 插入演示  
- [ ] **M3** 拖拽重排 + 键盘移块  
- [ ] **M4** 表代码 callout 抛光 + 视觉清单  
- [ ] **M5** chip/wiki + onOpenPath  
- [ ] **M6** 大文档虚拟化 + desktop 预备清单  

---

## 16. 相关文档

- [07-visual-system.md](./07-visual-system.md)  
- [08-integration.md](./08-integration.md)  
- [ux/keyboard-map.md](./ux/keyboard-map.md)  
- 块/引擎细节：01–06（并行设计）
