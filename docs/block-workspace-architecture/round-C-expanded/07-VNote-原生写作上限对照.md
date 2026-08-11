# 07 · VNote — 原生写作上限对照

> 代码根：`C:\Software\conex\reference\markdown_compare\vnote`  
> 角色：把 **C++/Qt 原生 Markdown 笔记** 当作「纯原生写作体验」的可测量上界样本，判断是否值得为写作手感放弃 Web/TS 扩展生态。  
> 约束：只读源码 + 公开 submodule 文档；本地 `libs/vtextedit`、`libs/vxcore` 目录在本克隆中为空（未 `git submodule update`），编辑器内核细节以父仓 include/调用面 + [vnotex/vtextedit README/头文件](https://github.com/vnotex/vtextedit) 交叉确认。  
> 准则：效果完整度 → 正确性/不变量 → 可验证性 → 与 AI 工作栈契约一致 → 结构干净。

---

## 0. 结论先行

| 问题                                                            | 结论                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| VNote 是否「纯原生、零 Web」？                                  | **否**。源编辑是原生 `QTextEdit` 系；**阅读/预览/图示/数学/导出** 走 **QtWebEngine + markdown-it + Prism/MathJax/Mermaid…**          |
| 原生栈能否抬高「写作输入」上限？                                | **能，且可归因**——源模式按键热路径不经过 Chromium 布局与 JS 事件环；IME、Vi、滚动、剪贴板可走 Qt 原生控件契约。                      |
| 是否抬高「Notion 块 + 多人协同 + TS 扩展 + AI Agent」上限？     | **否**。VNote 的真相是 **文件系统上的 `.md` + 元数据 JSON**，无语义块图、无 OT/CRDT 实时协同、无 TS 插件运行时、无 AI/Agent 工具面。 |
| 对本产品（Tauri + 块工作区 + AI）是否值得为写作上限改走纯原生？ | **不值得**。可借鉴的是「源编辑热路径减负 / 预览解耦 / 输入模式与防抖」，不是换整壳为 C++/Qt。                                        |

---

## 1. 产品定位与代码地图

### 1.1 自述

- `README.md` / `README_zh_CN.md`：Qt 跨平台（Linux / Windows / macOS）开源 Markdown **笔记平台**，强调「不只是编辑器」，带笔记库管理。
- 许可：GNU LGPLv3。
- 技术门槛：`AGENTS.md` 写明 **C++14、CMake 3.20+、Qt 5/6 + QtWebEngine**。

### 1.2 子模块（内核边界）

| 路径              | 远程                                      | 职责                                                      |
| ----------------- | ----------------------------------------- | --------------------------------------------------------- |
| `libs/vtextedit`  | `https://github.com/vnotex/vtextedit.git` | 源编辑器：`VTextEdit` / `VTextEditor` / `VMarkdownEditor` |
| `libs/vxcore`     | `https://github.com/vnotex/vxcore.git`    | C 库：笔记库、buffer、搜索、git 同步                      |
| `libs/QHotkey`    | 全局热键                                  | 壳层能力                                                  |
| `libs/qwindowkit` | 无边框窗口                                | 壳层能力                                                  |

`libs/CMakeLists.txt` 明确 **vtextedit 必须先于 vxcore**（两边都 pin 了 cmark fork；由 `tests/utils/test_cmark_pin_drift.cpp` 防漂移）。

### 1.3 应用分层（新架构）

```
Controllers (src/controllers/)     QObject 业务逻辑，不继承 QWidget
Models      (src/models/)          QAbstractItemModel
Views       (src/views/)           QTreeView 等
Widgets     (src/widgets/)         MainWindow2 / MarkdownViewWindow2 / 编辑器控件
Services    (src/core/services/)   包装 vxcore C API（core_services 故意不链 QtWidgets/VTextEdit）
vxcore      (libs/vxcore/)         笔记库/buffer/sync 后端
```

依赖注入：`ServiceLocator` 非单例，由 `main.cpp` 栈上装配（`CLAUDE.md` / `AGENTS.md`）。

---

## 2. 编辑器实现：不是「整页 Web」，也不是「纯 QTextDocument WYSIWYG」

### 2.1 源编辑：自研 vtextedit，根基是 Qt `QTextEdit`

父仓直接继承：

```9:10:C:\Software\conex\reference\markdown_compare\vnote\src\widgets\editors\markdowneditor.h
#include <vtextedit/markdownhighlighter.h>
#include <vtextedit/vmarkdowneditor.h>
```

```34:35:C:\Software\conex\reference\markdown_compare\vnote\src\widgets\editors\markdowneditor.h
class MarkdownEditor : public vte::VMarkdownEditor {
```

上游 vtextedit 公开定义：

| 组件              | 继承/角色                                                             |
| ----------------- | --------------------------------------------------------------------- |
| `VTextEdit`       | **`public QTextEdit`**（非 WebView、非自研像素排版引擎）              |
| `VTextEditor`     | 全功能纯文本编辑：Vi、语法高亮                                        |
| `VMarkdownEditor` | Markdown 源编辑 + **in-place preview**（图/公式等在编辑器内嵌预览图） |

证据链（写作热路径 = 原生文本控件）：

- 文档模型是 **`QTextDocument` / `QTextBlock`**（见 `PreviewHelper` 持有 `QTextDocument *`；`MarkdownEditor` 上下文菜单解析 `const QTextBlock &`）。
- 输入模式配置：`TextEditorConfig::InputMode` = `NormalMode | ViMode | VscodeMode`（`src/core/texteditorconfig.h`）。
- 状态栏绑定 `vte::VTextEditor` 的 cursor / Vi mode / spell / syntax（`src/widgets/editors/editorstatusbarbinder.*`）。
- IME：`VTextEdit::forceInputMethodDisabled` 在导航模式等场景被显式控制（`src/gui/services/navigationmodeservice.cpp`）。

**「块」一词在 VNote 里 ≠ Notion block**：`QTextBlock` 是 Qt 文本布局块；`FencedCodeBlock` / `MathBlock` 是 markdown highlighter 解析出的区域，用于 in-place 预览，不是可拖拽、可引用、带稳定 blockId 的文档宇宙。

### 2.2 阅读 / 实时预览：QtWebEngine + JS 生态

```9:11:C:\Software\conex\reference\markdown_compare\vnote\src\widgets\webviewer.h
class WebViewer : public QWebEngineView {
```

```20:21:C:\Software\conex\reference\markdown_compare\vnote\src\widgets\editors\markdownviewer.h
class MarkdownViewer : public WebViewer {
```

- C++↔JS：`WebViewAdapter` / `MarkdownViewerAdapter`（`QWebChannel` 风格 slots/signals）。
- 前端栈在 `src/data/extra/web/`：
  - **markdown-it** 全家桶（task-list / footnote / emoji / texmath / container / inject-linenumbers / anchor / toc…）
  - Prism、MathJax、Mermaid、PlantUML、Graphviz、WaveDrom、flowchart、turndown（HTML→MD 粘贴）
  - mindmap（MindElixir）、pdf.js
- `src/CMakeLists.txt` 强制链接：`WebEngineWidgets`、`WebChannel`、`Widgets`、`PrintSupport` 等。
- `main.cpp` 大量注释处理 **QtWebEngine 平台崩溃**（GPU、sandbox、accessibility tree、remote debugging 须在 WebEngine 初始化前设置）。

### 2.3 双模式窗体（Edit / Read）与分栏预览

`MarkdownViewWindow2` 注释与实现：

- 支持 **Edit / Read** 双模式；编辑器与 viewer **懒初始化**。
- `EditViewMode`：`EditOnly | EditPreview`（`MarkdownEditorConfig`）。
- `EditPreview`：`QSplitter` 分栏 + **500ms 单次防抖** 把源文本 `adapter()->setText(...)` 推到 Web 侧（`MarkdownViewWindowController::previewSyncIntervalMs()` → 500）。

```931:939:C:\Software\conex\reference\markdown_compare\vnote\src\widgets\markdownviewwindow2.cpp
// Path 4: Editor -> Viewer (debounced preview).
void MarkdownViewWindow2::syncEditorContentsToPreview() {
  if (!m_viewerReady || isReadMode() ||
      m_editViewMode == MarkdownEditorConfig::EditViewMode::EditOnly) {
    return;
  }
  // NOTE: Do NOT update m_viewerBufferRevision here.
  // This is visual preview sync only, not a buffer sync event.
  adapter()->setText(m_editor->getText(), m_editor->getTopLine());
}
```

### 2.4 In-place 预览（源编辑区里的「轻 WYSIWYG」）

`PreviewHelper`：

- 源：fenced code（Mermaid/PlantUML/Graphviz/FlowChart/WaveDrom…）与 math。
- 渲染：走 Web 侧生成图 → C++ 收 `PreviewData` → 转 `QPixmap` → 通过 vtextedit `PreviewMgr` / `PreviewItem` 嵌回 `QTextDocument`。
- 缓存：`vte::LruCache` 双份（code / math）；定时器合并 `codeBlocksUpdated` / `mathBlocksUpdated`。

这是 **「源 MD 为真相 + 局部栅格化预览」**，不是 TipTap/ProseMirror 式可编辑 DOM 树，也不是 Typora 全文档 contenteditable 同构模型。

### 2.5 编辑器实现类型一句话

| 层次               | 技术                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| 源编辑内核         | **自研 vtextedit（基于 QTextEdit / QTextDocument）**                    |
| 高亮 / MD 解析辅助 | vtextedit 内 highlighter + **cmark**（与 vxcore 双 pin）                |
| 阅读与分栏预览     | **QtWebEngine + markdown-it 等 JS**                                     |
| 图/公式 in-place   | Web 或外部进程渲染 → 原生文档内嵌图                                     |
| 非 MD 视图         | 纯文本 `TextViewWindow2`；PDF（pdf.js+Web）；思维导图（Web MindElixir） |

**不是**「整应用 WebEngine 包壳」，也**不是**「完全无 Web 的纯原生 Markdown 排版」。

---

## 3. 笔记库组织与 MD 文件关系

### 3.1 身份模型

- `NodeIdentifier`：`notebookId`（GUID）+ `relativePath`（相对笔记库根；`""` 为根，`"folder/note.md"` 为文件）。
- `NodeInfo`：展示元数据（时间戳、tags、preview 前 N 字、是否 external/missing 等）。
- **真相落点**：磁盘上的 Markdown 文件 + 旁路元数据；buffer 内容以 **raw bytes** 进出 vxcore（`Buffer2::getContentRaw` / `setContentRaw`，编码可覆盖，默认 UTF-8）。

### 3.2 Bundled vs Raw 笔记库

`NotebookCoreService`：

```20:21:C:\Software\conex\reference\markdown_compare\vnote\src\core\services\notebookcoreservice.h
enum class NotebookType { Bundled = VXCORE_NOTEBOOK_BUNDLED, Raw = VXCORE_NOTEBOOK_RAW };
```

测试资产 `tests/data/vnote3_notebooks/database_notebook/` 展示 **VNote3 bundled** 形态：

| 路径                           | 角色                                                                    |
| ------------------------------ | ----------------------------------------------------------------------- |
| `*.md`                         | 笔记正文，**用户可见的主数据**                                          |
| `vx.json`                      | 目录级文件清单：`name`、`id`、`signature`、`attachment_folder`、`tags`… |
| `vx_notebook/vx_notebook.json` | 库级配置：`image_folder`、`attachment_folder`、`version`、`config_mgr`… |
| `vx_attachments/<id>/…`        | 附件树                                                                  |

要点：

1. **MD 文件是一等公民**，不是从块数据库「导出凑合」。
2. 元数据（顺序、标签、附件映射）在 **JSON 索引** 里，与文件并列。
3. 支持 external / missing 节点（索引与磁盘不一致时的容错）。
4. 文件夹分享：`FolderSharePaths` = contentRoot + 并行 metadata 树（`NotebookCoreService`）。

### 3.3 Buffer 与保存

- `Buffer2`：类 `QModelIndex` 的轻量句柄；生命周期由 `BufferService` 管。
- `BufferSaveQueue`：**异步保存**，按 notebook 经 `NotebookIoGate` 与 sync 写串行化（防 UI 线程堵在 FS/libgit2）。
- 修订号 `revision` 用于 editor/viewer 与 buffer 对齐；预览路径故意 **不** 提升 `m_viewerBufferRevision`（视觉同步 ≠ 缓冲同步）。

### 3.4 与「块工作区」的结构差

| 维度        | VNote                                 | Notion 向块工作区                     |
| ----------- | ------------------------------------- | ------------------------------------- |
| 文档原子    | 整文件 `.md`                          | 稳定 blockId 节点图                   |
| 编辑 mutate | 文本偏移 / 全文替换                   | 结构化 op（insert/move/update props） |
| 大纲        | 从 heading 区域 / 预览侧 heading 列表 | 块树本身即大纲                        |
| 引用        | 文件路径 / 标题锚点                   | 块引用 / 反向链接一等                 |
| Agent 友好  | 改文件 + 改 JSON 元数据               | 块级事务 + 工具 schema                |

---

## 4. 块模型 / 协同 / AI

### 4.1 块模型

**无 Notion/AFFiNE/思源 式块模型。**

存在的「block」仅：

- Qt `QTextBlock`
- Markdown 结构区域（标题、围栏代码、数学）供高亮与 in-place 预览
- 大纲 `OutlineProvider` / heading 列表

无：blockId 持久化、块拖拽重排为文档语义、块属性面板、数据库视图等。

### 4.2 协同

**有「笔记本级 git 同步」，无「实时多人编辑」。**

- `SyncService`：GUI 线程 facade；worker 队列 `SyncWorkQueueManager` + `SyncOps`；PAT 进 OS keychain，**不在服务成员里缓存**。
- 状态机 S0–S7（`AGENTS.md` § Sync State Model）：JSON 同步字段 + keychain + vxcore `states_` 注册。
- 后端语义：**git remote**（`syncBackend: "git"`），冲突检测与解决对话框；`cloneNotebookFromUrl` 为 snapshot 向。
- 自动同步：尾部节流 debounce（`autoSyncDebounceSeconds`），非 OT 光标同步。

与 Docmost（TipTap+Yjs）/ AFFiNE（Yjs）/ AppFlowy collab **不在同一问题域**。

### 4.3 AI / Agent / 扩展

| 能力                         | VNote 现状                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| LLM / RAG / MCP / Agent 工具 | **代码面未发现产品化集成**                                                                                        |
| 插件                         | **WordPress 式 HookManager**（action 可取消 + filter），常量见 `src/core/hooknames.h`（notebook/node/file/sync…） |
| 扩展语言                     | **C++ 进程内 hook**，不是 Obsidian 式 TS 插件市场                                                                 |
| 隐私                         | `privacy_policy.md`：不收集用户数据                                                                               |

Hook 适合「拦截保存/打开/同步」，**不适合**快速迭代 AI 工具面、社区 TS 扩展与 Web 组件生态。

---

## 5. 性能相关设计（可核对）

| 机制              | 位置 / 行为                                  | 对写作体验的意义                           |
| ----------------- | -------------------------------------------- | ------------------------------------------ |
| 源编辑原生控件    | `VTextEdit : QTextEdit`                      | 按键→文档变更不经过 JS/Chromium 主线程     |
| 预览 500ms 防抖   | `previewSyncIntervalMs()`                    | 打字时不全文同步 Web                       |
| EditOnly 可关预览 | `EditViewMode::EditOnly`                     | 极限输入场景可去掉 Web 侧成本              |
| 懒初始化          | editor/viewer 按模式创建                     | 只读打开不付编辑器初始化                   |
| In-place 预览 LRU | `PreviewHelper` / `GraphHelper`              | 重复图不重复渲染                           |
| 预览合并定时器    | code/math pending + QTimer                   | 避免每次 highlighter 回调都渲染            |
| 笔记树懒加载      | `NotebookNodeModel::canFetchMore/fetchMore`  | 大库不全量建树                             |
| 节点缓存          | `m_nodeCache` / `m_childrenCache`            | 减少服务往返                               |
| 异步保存 + IoGate | `BufferSaveQueue` + `NotebookIoGate`         | 保存不堵输入；与 sync 互斥写               |
| 主题/样式原则     | `docs/UI_DESIGN_PRINCIPLES.md`「Performant」 | 轻样式，非架构级                           |
| WebEngine 成本    | 仍链接完整 Chromium 系                       | **进程级内存税仍在**，只是不在源编辑热路径 |

**可测量上界（定性，非本仓 benchmark）：**

1. **源模式输入延迟**：原生路径通常优于 Electron/WebView contenteditable（少一层合成与 JS 调度）。
2. **分栏预览**：每 500ms 可能把**整篇** `getText()` 推给 markdown-it——大文档预览仍是 O(全文) JS 渲染，与「原生」无关。
3. **进程内存**：QtWebEngine + 原生 UI + vxcore 同时在，**并不保证**比 Tauri（单一 WebView）更省；原生优势集中在 **输入路径**，不是「无浏览器」。

---

## 6. 必答五题

### 6.1 原生栈是否带来可测量的写作体验上限？

**是，但范围收窄到「源编辑热路径 + 桌面输入契约」。**

可测量/可归因点：

| 维度         | 原生 VNote 路径                             | Electron / Tauri WebView 典型路径        |
| ------------ | ------------------------------------------- | ---------------------------------------- |
| 键入 → 上屏  | Qt 文本布局 / 输入法查询 `inputMethodQuery` | DOM + IME 桥 + 合成层                    |
| 撤销/选择    | `QTextDocument` 栈与 `QTextCursor`          | 编辑器框架（ProseMirror/CodeMirror）自管 |
| Vi / 块光标  | vtextedit InputMode + 光标宽度模拟          | 需 JS 实现或编辑器插件                   |
| 滚动与分屏   | Qt `QSplitter` / 原生滚动条                 | CSS overflow / 虚拟列表                  |
| 剪贴板富粘贴 | C++ 处理 MIME + turndown 可选走 Web         | 全在 JS                                  |

**不可夸大：**

- 阅读模式与 EditPreview **仍依赖 WebEngine**，排版质量上限由 markdown-it CSS/HTML 决定，不是原生 CoreText/DirectWrite 段落引擎的「另一套完美排版」。
- 无公开 A/B 数字写在仓库里；上界是 **架构路径差**，不是已发布的 FPS 表。

### 6.2 与 Electron / Tauri WebView 编辑器的结构差

```
VNote（混合）
┌──────────────────────────────────────────────┐
│ Qt Widgets 壳（MainWindow2 / Dock / Tree）   │
│  ┌─────────────────┐  ┌───────────────────┐  │
│  │ vtextedit       │  │ QWebEngineView    │  │
│  │ QTextDocument   │─→│ markdown-it 预览  │  │
│  │ 源 MD 真相      │  │ 阅读/图示/导出    │  │
│  └────────┬────────┘  └─────────┬─────────┘  │
│           └──────── Buffer2 ────┘            │
│                     │                        │
│              vxcore（C）笔记库/git           │
└──────────────────────────────────────────────┘

Electron 块编辑器（典型）
┌──────────────────────────────────────────────┐
│ Chromium 整页                                │
│  块编辑器(Yjs/PM) = 交互真相 + 常为存储真相  │
│  Node 主进程 = 文件/同步/插件                │
└──────────────────────────────────────────────┘

Tauri 块/MD 编辑器（本产品形态）
┌──────────────────────────────────────────────┐
│ 系统 WebView 前端（TS）                      │
│  Rust 后端（命令/FS/会话/Agent）             │
└──────────────────────────────────────────────┘
```

结构差摘要：

1. **双渲染器**：VNote 故意把「打字」和「看渲染」拆开；Web 系常合一（contenteditable/WYSIWYG）或源码模式也在 WebView 内（CodeMirror）。
2. **真相层语言**：VNote 真相在 **文件 + C 库**；Web 块编辑器真相常在 **JS CRDT/事务层**。
3. **扩展面**：VNote = C++ hooks；Web = npm/TS 插件与热更新。
4. **协同面**：VNote = git；Web 块宇宙 = Yjs/自定义 collab。
5. **内存形态**：VNote 仍可能拉起 WebEngine 进程，**不是**「零浏览器」；但源编辑可不创建 viewer。

### 6.3 诚实：纯原生是否更适合「Notion 块 + 多人协同 + TS 扩展 + AI Agent」？

**否。更不适合。**

| 目标能力        | 原生 C++/Qt 路径代价                                                                             | Web/TS（或混合）路径                       |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Notion 级块交互 | 需自研块文档模型、虚拟化、拖拽、嵌套、属性——Qt 无现成块宇宙；QTextDocument 是错误抽象            | BlockSuite / Protyle / TipTap 等已验证路径 |
| 多人实时协同    | 需在 C++ 实现 CRDT/OT + 光标 awareness + 网络层；VNote 选择了 **git 离线合并**，与实时块协同正交 | Yjs / Automerge 等 JS 生态成熟             |
| TS 扩展生态     | 要嵌 JS 运行时或做 FFI 插件 ABI；VNote hook 是进程内 C++                                         | npm、热重载、社区插件默认语言即 TS         |
| AI Agent        | 工具调用、流式 UI、MCP、前端评测循环在 TS/Rust 更顺；C++ UI 绑 LLM 流式与快速试验成本高          | 与现有 Agent 工作栈同构                    |
| 招聘/迭代速度   | Qt/C++ 桌面人才与 Web 笔记人才池错位                                                             | 与产品其余部分一致                         |

VNote 自身已经证明：**即便选了 Qt，Markdown 渲染与现代图示仍不得不回到 Web**。若再叠加块协同与 AI，纯原生会变成「用最慢的语言重写最热的生态」，而不是「用原生换上限」。

### 6.4 何时应选原生：Typora 级静默写作子集

原生（或「源编辑原生 + 预览可降级」）适合 **产品目标被收窄** 时：

1. **单人、本地、以源 MD 为唯一真相**（仓库/Git 友好）。
2. **交互是「打字 + 标题/列表快捷键 + 可选分栏预览」**，不要块拖拽数据库。
3. **输入手感优先于扩展市场**（Vi、IME、低延迟源编辑）。
4. **协同若有，也是文件同步/git，不是同屏光标**。
5. **AI 若有，是外部改文件或侧车进程**，不要求编辑器内深度 Agent 工具图。

即 **Typora / 经典 VNote / 部分 IDE Markdown 预览** 的子集——「舒适写作平台」，不是「块工作区操作系统」。

### 6.5 对本产品：是否值得为写作上限放弃 Web 扩展生态？

**不值得。**

建议立场：

| 可做                                                                              | 不做                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------- |
| 在 WebView 内把 **源码模式** 做到接近原生（虚拟化、IME 专项、输入路径 profiling） | 为「纯原生上限」重写为 C++/Qt 整应用           |
| 预览与编辑解耦、防抖、大文档不全量重排（学 VNote 的 500ms + EditOnly）            | 用 `QTextDocument` 冒充块模型                  |
| 重计算/渲染沉到 **Rust**（解析、索引、Agent），壳保持 Tauri                       | 放弃 TS 扩展与 AI 工具面换「无 Electron 叙事」 |
| 同步策略分轨：文件 MD 同步 vs 块 CRDT 协同，按场景选                              | 假设「换 Qt 就自动获得写作+协同+AI 全上限」    |

**写作上限的真问题** 多半是：块编辑器在大文档/IME/撤销上的工程债，而不是「没用 C++」。VNote 说明：原生能把 **源模式** 做扎实，但一旦需要现代预览与图示，**仍会请回 Chromium 系**；而本产品还需要块、协同与 AI——这三项的生态重心在 Web/TS/Rust，不在 Qt Widgets。

---

## 7. 与 Round C 其他样本的对照位

| 样本            | 与 VNote 的关系                                                            |
| --------------- | -------------------------------------------------------------------------- |
| 思源            | 同为「本地 MD/块纪律强」；思源有 **块 ID + Go 事务 + AI 工具面**，VNote 无 |
| Logseq          | 大纲块 + 查询；VNote 是文件树 + 源 MD                                      |
| Docmost         | 团队 Yjs 协同上限；VNote 是 git 同步上限                                   |
| note-gen        | 同为桌面壳 + AI；VNote 无 AI，note-gen 无 VNote 级原生源编辑               |
| AFFiNE/AppFlowy | 块+协同主叙事；VNote 是反例：**优秀原生写作壳 ≠ 块工作区**                 |

---

## 8. 路径证据索引

| 主题                      | 路径                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| 产品自述                  | `reference/markdown_compare/vnote/README.md`、`README_zh_CN.md`                          |
| 架构/MVC/Sync 状态机      | `…/AGENTS.md`、`…/CLAUDE.md`                                                             |
| 子模块与 cmark 双 pin     | `…/libs/CMakeLists.txt`、`.gitmodules`                                                   |
| Qt + WebEngine 依赖       | `…/src/CMakeLists.txt`                                                                   |
| Markdown 源编辑           | `…/src/widgets/editors/markdowneditor.{h,cpp}`                                           |
| Web 预览                  | `…/src/widgets/webviewer.h`、`…/editors/markdownviewer.*`、`markdownvieweradapter.*`     |
| 双模式窗体                | `…/src/widgets/markdownviewwindow2.{h,cpp}`                                              |
| 预览防抖 500ms            | `…/src/controllers/markdownviewwindowcontroller.cpp`                                     |
| In-place 预览             | `…/src/widgets/editors/previewhelper.h`                                                  |
| 配置 EditOnly/EditPreview | `…/src/core/markdowneditorconfig.h`                                                      |
| 文本/Vi 配置              | `…/src/core/texteditorconfig.h`                                                          |
| 节点身份                  | `…/src/core/nodeidentifier.h`、`nodeinfo.h`                                              |
| Buffer                    | `…/src/core/services/buffer2.h`、`bufferservice.*`、`buffercoreservice.h`                |
| 笔记库服务                | `…/src/core/services/notebookcoreservice.h`                                              |
| Git 同步                  | `…/src/core/services/syncservice.h`、`AGENTS.md` § Sync                                  |
| Hooks                     | `…/src/core/hooknames.h`、`…/services/hookmanager.*`                                     |
| 树懒加载                  | `…/src/models/notebooknodemodel.h`                                                       |
| Web 前端资源              | `…/src/data/extra/web/js/markdown-it/`、`markdownviewer.js`                              |
| Bundled 库样例            | `…/tests/data/vnote3_notebooks/database_notebook/`                                       |
| vtextedit 定义            | 上游 README：`VTextEdit` derived from `QTextEdit`；头文件 `VTextEdit : public QTextEdit` |

---

## 9. 一页决策卡（给评审）

```
问题：要不要为「写作手感上限」把本产品改成 VNote 式纯原生？

答案：不要整栈原生。
  - 要学：源路径减负、预览解耦与防抖、懒加载、异步保存门闩
  - 别学：用文件+git 代替块协同；用 C++ hook 代替 TS/AI 扩展面
  - 真相：VNote 自身已是「原生源编辑 + Web 预览」混合体
  - 本产品目标含 Notion 块 + 协同 + TS + AI → 原生不是更高上限，是错误坐标系
```
