# 07 · 跨产品优点对照：Notion · Typora · AFFiNE → 本产品

| 元数据                   | 值                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **状态**                 | 调研落盘（round-A-affine）                                                                                                                                                                                                        |
| **证据口径**             | **【公开产品观察】**：Notion / Typora 无源码，基于产品行为与业界共识；**【源码证据】**：本地镜像 `reference/markdown_compare/AFFiNE` 与本仓 `reference/markdown-editor`、`reference/chat-composer-component/docs/markdown-editor` |
| **本产品目标（效果锁）** | Tauri + TS + RS；**Notion 皮**（块 + 丰富交互）+ **Rust 心**（极速、低内存、原生协同）；块操作；多人实时协同；TS 扩展生态；**性能与体验双双超过**参考产品                                                                         |
| **关联**                 | [00-调研边界与效果锁.md](../00-调研边界与效果锁.md) · 本仓 BAN 视觉：`reference/chat-composer-component/docs/markdown-editor/BANNED-VISUAL-UX.md` · 行级引擎：`reference/markdown-editor`                                         |
| **不做**                 | 工期 / 人天 / 业务 P0 排序；禁止「照抄 AFFiNE」作为终局设计句                                                                                                                                                                     |

---

## 0. 结论先行

| 参考系     | 做得出色的「一句话」                                                                                 | 对本产品的映射                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Notion** | 块是一等公民：把手 / 多选 / slash / 浮动工具 / 嵌套与数据库，交互密度高且可发现                      | **皮**：块操作面、命令面板、多块选择与重排必须达到同级完整感         |
| **Typora** | 写作静默：纸面极净、行内即时预览、源码与渲染几乎无缝，Chrome 不抢戏                                  | **静默感**：默认无激活行底色、无永久顶栏格式条；键入即见排版         |
| **AFFiNE** | 开源可拆的完整块工作区：BlockSuite 块模型 + Yjs 协同 + nbstore 本地优先 + 白板/文档超融合 + 扩展装载 | **可拆架构与协同面**可学；**性能/原生心/MD 往返/写作静默**必须压过它 |

**融合立场（本产品）**：  
默认路径是 **Typora 式静默写作面** + **Notion 式按需块操作**（hover / 多选 / `/` 才露出 chrome）；数据与协同走 **Rust 心**，交互与扩展走 **TS 皮**——不是三选一，是三维同时达标。

---

## 1. 三维对照表

> 列「本产品应达到的效果」为效果锁目标，不可自行降级为「简化版 / MVP 砍功能」。  
> 维度覆盖：写作体验、块操作、模型与格式、协同、性能、扩展、视觉 chrome、架构栈。

### 1.1 总表（维度 × 三产品 × 本产品效果）

| 维度                     | Notion【公开产品观察】                              | Typora【公开产品观察】                                | AFFiNE【源码证据 + 公开叙事】                                                                                                                             | **本产品应达到的效果**                                                                                                                             |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **写作静默感**           | 块边界清晰；hover 把手与菜单较常出现，chrome 可感知 | 极净纸面；几乎无块 chrome；「敲字即排版」             | Page 模式接近 Notion 块感；有 drag-handle / slash / toolbar 等 widget 叠加；非 Typora 级静默                                                              | **默认 Typora 静默**：系统 caret + 极淡 hover 把手；**禁止**激活行全行底色/描边（对齐 BAN-01）；chrome 仅 hover / 多选 / 命令态出现                |
| **行内即时渲染**         | 富文本属性即时生效（粗斜链等）；Markdown 非一等公民 | 键入闭合标记即渲染；源码/预览融合是产品招牌           | `rich-text` 上 `markdownMatches`：空格/Enter 触发前缀模式变换（如 `# `→标题）【源码：`blocksuite/affine/rich-text/src/rich-text.ts` ~L188–244】           | **融合交互（BAN-02/03）**：行内 mark 闭合即渲染；列表/待办/标题/代码/公式默认可编，禁止 read/write 两套皮跳变                                      |
| **块模型**               | Everything is a block；嵌套、拖拽、转换成熟         | 弱块 / 以文档流与 Markdown 结构为主，块操作非产品中心 | 强块：`affine:paragraph` / list / code / database / note / surface 等独立 package【`blocksuite/affine/blocks/*`】；Store + Yjs 同步【`framework/store`】  | **一等 Block 树**（内存真相）+ **Markdown 可往返**为主序列化；块边界编辑；不做成「textarea + blur 再 render」                                      |
| **Slash / 命令插入**     | `/` 命令面板行业标杆；过滤、分类、键盘导航完备      | 无同等 slash 体系（靠 Markdown 语法与菜单）           | `widgets/slash-menu` 独立包 + 各 block `configs/slash-menu.ts` 注册词条【源码目录证据】                                                                   | `/` **与中文 `、`** 双触发；过滤/键盘/左簇锚定；核心块词条完备（对齐产品愿景 G-S1–G-S5）                                                           |
| **拖拽重排**             | 6-dot 把手、多块拖、嵌套落点成熟                    | 基本不提供 Notion 级块 DnD                            | `widgets/drag-handle`：hover 锚点、add-block、page/edgeless 双场景 watcher、列表 reorder 中间件【`drag-handle.ts` + middleware】                          | 左侧把手 hover 极淡出现；同级重排 + 落点指示线；拖拽中不整页闪；键盘上移/下移块可达                                                                |
| **多块选择**             | 框选/Shift 多选 + 批量操作成熟                      | 文本选区为主，弱「块多选」                            | `BlockSelection` / `TextSelection` + page-dragging-area；remote 同步选区【`remote-selection`】                                                            | 多块选区 + 批量移动/删除/转类型；多选可用极淡 inset（非激活编辑 chrome）                                                                           |
| **浮动格式面**           | 选区浮条（粗斜链色等）强；顶栏偏文档操作            | 极简菜单；写作时几乎无浮条打扰                        | `widgets/toolbar` + 各块 toolbar config；选区/块级工具面                                                                                                  | **无页顶永久格式工具条（D16）**；需要时用选区浮层或 `/`，不抢纸面                                                                                  |
| **列表 / 待办**          | 缩进、转换、勾选一等                                | Markdown 任务列表即时勾选感好                         | `blocks/list` + commands/keymap；checkbox 行为在块内                                                                                                      | 勾选不进废源码态；Tab/Shift-Tab 缩进；有序/无序/任务互转                                                                                           |
| **代码 / 公式 / 表格**   | 代码块、公式、表格（及 DB）完整                     | 代码/公式/表格 MD 友好、即时预览出色                  | code（含 turbo worker 绘制）、latex、table、database 全套 package                                                                                         | 文档内代码/公式/GFM 表可编辑可渲染；**不做** Notion DB/CRM 污染默认 MD 写作（BAN-05）                                                              |
| **Database / 看板**      | 核心竞争力（多视图 DB）                             | 无                                                    | `blocks/database` + `data-view` 大包【源码】                                                                                                              | **非默认写作主路径**；若工作区后续要视图，与 MD 文档壳解耦，不绑架编辑器默认态                                                                     |
| **白板 / 画布**          | 弱（偏文档）                                        | 无                                                    | 产品叙事「Docs + whiteboard 超融合」；`gfx/*`、`surface`、edgeless widgets 完整【源码 + README】                                                          | 块工作区 **文档主路径优先**；画布可作为后续扩展面，不阻塞文档块 + 协同效果锁                                                                       |
| **文档链接 / 嵌入**      | 反向链接、子页、嵌入强                              | 相对路径/导出友好                                     | `embed-doc`、`linked-doc` widget（含 notion-html/obsidian/markdown 等 transformers）【源码】                                                              | Wiki 链 / 文件 chip / embed 走 **TS 扩展登记表**；序列化可往返                                                                                     |
| **Markdown 往返**        | 导出可用，内部非 MD 真相源                          | **MD 即真相**；往返是产品根基                         | 有 adapters（markdown/html/notion-html 等），内部真相是 **Yjs 块属性** 而非纯 MD 行缓冲【adapters 分布在各 block】                                        | **MD（+ 登记扩展）为主往返格式**；块操作不破坏可预期序列化；Agent/外部工具可读可写                                                                 |
| **本地优先存储**         | 云优先（有本地缓存语义，非 vault 哲学）             | 本地文件为中心                                        | `packages/common/nbstore`：IDB / SQLite / cloud / broadcast；Worker 化 SpaceStorage【README + impls】                                                     | 工作区本地权威 + 可选同步；**Rust/SQLite 路径**承担重 IO 与索引，主线程不堵                                                                        |
| **实时协同**             | 成熟多人光标与权限                                  | 基本单人                                              | Yjs 驱动 Store【`sync-controller` / reactive flat-native-y】；`remote-selection` 绘制远端选区；nbstore peer 同步                                          | **多人实时协同为一等效果**；选区/光标/块更新；冲突由 **Rust 侧协同计算** 主导，TS 只渲染与扩展                                                     |
| **远端光标 / Awareness** | 彩色光标 + 名牌                                     | 无                                                    | `AwarenessStore` + remote-selection widget + color manager【store + widgets/remote-selection】                                                            | 低开销 awareness；大量协作者时仍流畅（见 §3 必须更强）                                                                                             |
| **扩展生态**             | 封闭；模板与集成为主                                | 主题/导出扩展有限                                     | `@blocksuite/affine-ext-loader`：Store/View ExtensionProvider + zod schema + scope（page/edgeless）【ext-loader README】                                  | **TS 扩展生态一等**：`registerBlockType` / 命令 / 序列化钩子；扩展热路径不得拖垮 Rust 内核                                                         |
| **Native / 性能心**      | 专有客户端；编辑内核偏 Web 技术栈                   | 轻量桌面；大文档有上限口碑                            | Rust 用于 **nbstore/sqlite/importer/preview 等外围**（`packages/frontend/native`、`Cargo.toml` workspace）；**编辑与 CRDT 热路径仍在 JS/Yjs**【源码分工】 | **Rust 心进热路径**：解析/行高/协同合并/大文档索引；TS 负责块 UI 与扩展；目标 **内存与帧率双双超过** AFFiNE/Notion 体感                            |
| **大文档滚动**           | 云文档分页/懒载策略产品化                           | 中长文流畅；超大文件口碑分化                          | GFX viewport 有 bound 扩大与 survival 策略【`framework/std/src/gfx/viewport.ts`】；文档页块虚拟化非 CM6 级行引擎                                          | 对齐本仓行级投资：HeightMap / 局部更新 / 滚动帧少 React 提交【`reference/markdown-editor/docs/analysis/01-性能帧率路线.md`】；块层与行层坐标可映射 |
| **IME / 中文**           | 可用                                                | 中文用户基本盘，composition 成熟                      | composition 在 inline editor 路径有分支（`isComposing` 跳过部分 markdown 变换）【rich-text.ts】                                                           | IME 一等公民；`、` 触发 slash；composition 期间不误触命令/不拆 grapheme                                                                            |
| **撤销重做**             | 文档级可靠                                          | 文档级可靠                                            | `store.captureSync` + undoManager 与 inline 变换协作【drag-handle / rich-text】                                                                           | 块事务 + 行内编辑统一历史；协同下可解释的 undo 边界                                                                                                |
| **剪贴板**               | 块级复制粘贴强                                      | MD/HTML 互贴友好                                      | 各块 clipboard config + notion-html 等导入                                                                                                                | 内贴 MD/HTML/块 JSON 策略清晰；外贴不炸结构                                                                                                        |
| **视觉：激活态**         | 选中块有背景/轮廓反馈                               | 几乎仅 caret                                          | 块选与拖手柄状态机完整；产品侧仍有块级 chrome                                                                                                             | **BAN-01**：无 is-active 全行底色/描边/阴影；反馈 = caret + hover 把手 + 多选 inset                                                                |
| **视觉：页面 chrome**    | 顶栏分享/评论/历史；侧栏工作区                      | 极简菜单栏，沉浸写作                                  | 完整工作区壳（`packages/frontend/core` 体量巨大）+ BlockSuite host                                                                                        | 文档纸面沉浸；工作区壳与编辑纸面分层；**不**把 Database/CRM 控件塞进默认 MD 纸面                                                                   |
| **测试资产**             | 闭源                                                | 闭源                                                  | `tests/blocksuite`、`tests/affine-local` 等大量 e2e【源码树】                                                                                             | 块交互 + 引擎门禁 + 视觉禁令回归；测试是资产不可丢                                                                                                 |
| **架构栈**               | 专有                                                | 原生桌面 + WebView 类技术（产品层）                   | Electron/Web + BlockSuite(Lit) + Yjs + 部分 Rust NAPI                                                                                                     | **Tauri + TS + RS** 固定；禁止以「业界都用 Yjs/Electron」否决自研协同与原生心                                                                      |

---

## 2. 分产品「出色点」深描（证据向）

### 2.1 Notion 类块体验【公开产品观察】

| 出色点         | 用户可感知行为                                     | 本产品吸收方式                              |
| -------------- | -------------------------------------------------- | ------------------------------------------- |
| 块原子性       | 任意段落/列表/嵌入都是可点选、可拖、可转类型的单元 | Block 注册表 + 统一 Transaction             |
| 可发现操作     | 左把手、`⋮`、`/`、选区浮条分层出现                 | 分层触发：hover / 选区 / 命令，避免常驻噪声 |
| 多块批处理     | 框选后统一移动、删、转                             | 多选模型与批量命令                          |
| 嵌套与缩进     | 列表与块引用层级直觉                               | 列表 indent 与父块 children 语义一致        |
| 工作区信息架构 | 页树、权限、评论、DB                               | **皮可参考交互；默认文档编辑不绑定 DB**     |

**刻意不抄**：整套品牌皮肤、Database 作为写作默认、页顶永久格式刷。

### 2.2 Typora 类写作静默感【公开产品观察】

| 出色点        | 用户可感知行为                        | 本产品吸收方式                            |
| ------------- | ------------------------------------- | ----------------------------------------- |
| 零干扰纸面    | 几乎看不到「编辑器控件」              | BAN-01/D16；chrome 按需                   |
| 源码↔渲染一体 | 不切换预览模式也能写 MD               | 融合交互；禁 read/write 换壳（BAN-02/04） |
| 键入即排版    | `**` / `#` / 列表标记即时或近即时生效 | 行内 mark 热路径 + 块类型 markdown 快捷   |
| 文件即文档    | 打开即 MD，关掉仍是 MD                | **MD 往返为一等契约**                     |
| 心流          | 长文连续输入不破节奏                  | 输入热路径局部更新；IME 不卡              |

**刻意不抄**：放弃块操作；把一切做成「纯 textarea 语法高亮」。

### 2.3 AFFiNE【源码证据】

| 出色点                | 证据位置（本地镜像）                                                               | 本产品态度                                                          |
| --------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 块类型产品化拆包      | `blocksuite/affine/blocks/{paragraph,list,code,table,database,note,surface,...}`   | 学「注册与边界」；不照搬 Lit 组件树                                 |
| Widget 横切能力       | `widgets/{drag-handle,slash-menu,toolbar,remote-selection,page-dragging-area,...}` | 学能力清单；实现绑到本产品控制器，不引入其 widget 运行时            |
| Slash 可扩展          | 各块 `configs/slash-menu.ts` + `widgets/slash-menu`                                | TS 扩展登记 slash 词条                                              |
| Markdown 快捷进块类型 | `rich-text.ts` `markdownMatches` + 空格/Enter                                      | 保留快捷；与静默纸面共存（变换后无额外激活框）                      |
| Yjs 块同步            | `framework/store` SyncController / flat-native-y                                   | **效果**（实时合并）要达到；**实现**走 Rust 心，不默认 Yjs 为唯一解 |
| 远端选区              | `widgets/remote-selection`                                                         | 要有；性能与样式更克制                                              |
| 本地优先存储矩阵      | `packages/common/nbstore` IDB/SQLite/cloud/worker                                  | 学分层（doc/blob/indexer/awareness）；桌面以 SQLite+Rust 为重       |
| 扩展装载              | `affine-ext-loader` Store/View provider + scope                                    | TS 扩展生态对标并更易嵌入 Tauri 宿主                                |
| 导入生态              | linked-doc transformers：notion-html / obsidian / markdown / docx…                 | 导入适配器可后置；格式契约先稳                                      |
| Native 外围加速       | `Cargo.toml`：nbstore、sqlite、importer、preview(typst/mermaid)…                   | 认可方向；**本产品把 native 推进编辑/协同热路径**                   |
| 文档+画布超融合       | README + `gfx` + edgeless                                                          | 战略可选项；**不**用画布复杂度稀释文档块效果锁                      |
| 测试密度              | `tests/blocksuite`、`tests/affine-local` 等                                        | 同级或更高的可回归资产                                              |

---

## 3. AFFiNE 强、但本产品必须更强的点

> 原则：承认对方已交付的完整度；效果锁要求 **性能与体验双双超过**，且栈为 Tauri+TS+RS。下列「必须更强」是逻辑目标，不是工期表。

| #   | AFFiNE 已强在哪           | 本产品必须更强的效果                                                           | 为何必须更强（逻辑）                                                                       |
| --- | ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| M1  | 块 + Widget 交互面完整    | **同级块操作完整度** + **更静默的默认纸面**（Typora 静默 ∩ Notion 按需块操作） | 只学块操作会变「又一个 AFFiNE 皮」；效果锁要求皮+静默同时成立                              |
| M2  | Yjs 实时协同可用          | **更低内存 / 更稳大文档协同**；合并与索引在 **Rust**                           | 效果锁「Rust 心」；JS CRDT 全量在超大文档与弱设备上是天花板                                |
| M3  | nbstore 多后端            | **桌面路径 IO/检索更快、主线程更闲**（Tauri 侧 Rust 直达）                     | 对标并超过其 Worker+NAPI 外围加速；热路径不回流重 JS                                       |
| M4  | 编辑内核在 TS/Lit         | **输入与滚动帧预算达标**（60 保底，冲 120/140 路线已有本仓分析）               | `reference/markdown-editor` 已投行列模型/HeightMap 方向；必须压过「块 DOM 堆叠」的默认成本 |
| M5  | Markdown 为适配器而非真相 | **MD 往返正确性与可预期性更强**（Agent/外部工具友好）                          | 本产品文档与 AI 流水线以 MD 为交接物；不能「导出凑合」                                     |
| M6  | 扩展 loader 存在          | **更薄的扩展契约 + 宿主嵌入成本更低**（Notebook/工作区多宿主）                 | TS 扩展生态是效果锁；扩展失败不得拖垮内核                                                  |
| M7  | 远端选区功能在            | **多协作者下仍静默、低闪烁、低 layout 抖动**                                   | 协同是一等能力；chrome 不能毁 Typora 静默                                                  |
| M8  | Database/画布能力面大     | **默认写作路径更干净**（无 DB/CRM 污染；画布不挡文档）                         | BAN-05 与产品愿景非目标；「更多功能」不是默认纸面胜利条件                                  |
| M9  | 产品体量大而全            | **关键路径延迟与内存占用更优**（冷启动、打开万行、500 token/s 流式）           | 「性能体验双双超过」的可感知面                                                             |
| M10 | e2e 广                    | **引擎单测门禁 + 块交互 + 视觉禁令**三位一体，防回归更狠                       | 本仓已有 markdown-editor 门禁与 e2e 专项资产铁律                                           |

**一句话**：AFFiNE 证明「开源块工作区 + 协同 + 本地优先」可做全；本产品用 **更静默的皮、更硬的 MD 契约、更深的 Rust 热路径** 在同一能力地图上取胜，而不是功能清单堆叠取胜。

---

## 4. 「融合」建议：静默写作 + 块操作如何共存

> 只谈逻辑分层与不变量，不谈工期。

### 4.1 双层交互模型

```
┌─────────────────────────────────────────────────────────────┐
│ L0  静默写作面（默认，Typora 向）                              │
│     · 唯一持续反馈：系统 caret / 原生选区                      │
│     · 键入 → 行内 mark / 块类型 markdown 快捷（低噪声）         │
│     · 无激活行底色、无永久格式条、无呼吸阴影（BAN-01/D16）      │
└───────────────────────────┬─────────────────────────────────┘
                            │ 触发（显式意图）
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ L1  块操作面（按需，Notion 向）                                │
│     · hover 块 → 极淡把手（opacity）                          │
│     · `/` 或 `、` → slash 面板                                │
│     · 拖拽 / 多选 / 块菜单 → 批量与结构操作                    │
│     · 选区浮层 → 行内格式（用完即走）                          │
└───────────────────────────┬─────────────────────────────────┘
                            │ 结束条件
                            ▼
                     失焦 / Esc / 拖放完成 → 回到 L0
```

**不变量**：

1. **L0 永远可写**：不依赖进入「块编辑模式」才能改字（禁止半吊子 read 岛）。
2. **L1 不改变 L0 的视觉基线**：退出 L1 后纸面无残留激活框。
3. **结构操作走块事务，字形输入走行/inline 热路径**：两者可同一历史栈，但渲染脏区分离。

### 4.2 数据层融合（块 × 行 × MD）

| 层                   | 职责                            | 静默写作时               | 块操作时               |
| -------------------- | ------------------------------- | ------------------------ | ---------------------- |
| **Document（块树）** | 块类型、顺序、children、块属性  | 仅当类型/边界变化时改    | 拖拽、转类型、增删块   |
| **Text/Line buffer** | 字符、行内 mark、表格单元格文本 | 每次击键主路径           | 合并/拆分块时重切分    |
| **Markdown 投影**    | 序列化/反序列化、扩展语法登记   | debounce 保存 / 协作编码 | 结构变更后立即投影校验 |
| **协同日志（Rust）** | 可合并 op、awareness            | 高频文本 op 合并         | 低频结构 op            |

逻辑依赖：**块边界**由解析与用户结构命令共同维护；**禁止**「为了块 DOM 漂亮」丢掉行级 O(log n) 定位能力（本仓 HeightMap/行引擎投资要接到块视口）。

### 4.3 输入路由（谁先吃键）

优先级（高 → 低）：

1. IME composition 中 → **只进文本**，不触发 slash/markdown 块变换。
2. slash 面板打开 → 面板键盘导航。
3. 多块选择激活 → 块级快捷键（删、移、转）。
4. markdown 块级快捷（行首 `# `、`- ` 等）→ 块类型变换。
5. 行内 mark 快捷。
6. 普通字符插入。

这样 **Typora 的连续输入** 与 **Notion 的命令姿态** 不会互相误触。

### 4.4 Chrome 显隐状态机（逻辑）

| 状态         | 把手   | Slash | 选区浮条 | 多选遮罩   |
| ------------ | ------ | ----- | -------- | ---------- |
| Idle 书写    | 隐     | 隐    | 隐       | 无         |
| Hover 单块   | 极淡   | 隐    | 隐       | 无         |
| 文本选区非空 | 可隐   | 隐    | 可显     | 无         |
| Slash 开启   | 隐或淡 | 显    | 隐       | 无         |
| 多块选中     | 可显   | 隐    | 块级菜单 | 极淡 inset |
| 拖拽中       | 拖影   | 隐    | 隐       | 落点线     |

### 4.5 与视觉禁令的对齐（本仓已锁）

| 禁令                   | 融合含义                                                     |
| ---------------------- | ------------------------------------------------------------ |
| BAN-01 无激活行 chrome | 块「正在编辑」≠ 整行高亮；Notion 的强选中反馈改为多选/拖拽态 |
| BAN-02 无读写两套皮    | 静默不是「只读渲染」，而是「可编且不换壳」                   |
| BAN-03 无半吊子可编    | 待办/代码/公式在 L0 就可操作                                 |
| BAN-04 禁换壳架构终局  | 融合不能靠 `enterEdit` 换 innerHTML 堆出来                   |
| BAN-05 / D16           | 无永久顶栏格式条；无 DB 污染默认 MD                          |

### 4.6 协同下的静默

- 远端光标：**细线 + 轻名牌**，禁止大色块刷行。
- 远端块更新：局部 patch，避免整页 re-render（与 L0 心流一致）。
- Awareness 节流：移动合并；Rust 侧可丢弃过期光标。

### 4.7 宿主嵌入

- **Notebook / 对话产物**：先 L0 扫读 + 轻改；L1 用于重排与插入。
- **工作区文档**：L0/L1 同契约；壳层负责页树/权限/同步状态，不侵入纸面。
- **扩展**：只注册块类型、slash、序列化、命令；不得强制常驻 chrome。

---

## 5. 映射到本仓已有资产

| 资产                        | 路径                                                                          | 在对照中的角色                 |
| --------------------------- | ----------------------------------------------------------------------------- | ------------------------------ |
| 效果锁 / 调研边界           | `docs/block-workspace-architecture/00-调研边界与效果锁.md`                    | 栈与目标冻结                   |
| 产品愿景（块+MD+slash+DnD） | `reference/chat-composer-component/docs/markdown-editor/00-product-vision.md` | Notion 皮目标条目（G-*）       |
| 视觉禁令                    | `.../BANNED-VISUAL-UX.md`                                                     | Typora 静默硬约束              |
| Notion 排版观察             | `.../references/notion-alignment-notes.md`                                    | 纸面：透明块底、无永久格式条   |
| 架构分层                    | `.../01-architecture.md`                                                      | 块模型 + Registry + 非目标边界 |
| 行级引擎 / 性能             | `reference/markdown-editor` + `docs/analysis/01-性能帧率路线.md`              | 超过 AFFiNE 热路径的技术投资面 |
| AFFiNE 镜像                 | `reference/markdown_compare/AFFiNE`                                           | 块/协同/存储/扩展源码证据      |

---

## 6. 验收用检查清单（对照是否落地时用）

### 6.1 三维同时为真

- [ ] **静默**：连续输入 1 分钟无多余块 chrome 闪烁；无激活行底色。
- [ ] **块操作**：把手拖拽、多选移动、`/` 与 `、` 插入、块类型转换均可完成。
- [ ] **心**：大文档滚动与多人编辑时内存/帧率优于参考体感；MD 往返抽样结构不丢。

### 6.2 相对三产品的「达到线」

| 相对      | 达到线                                                                   |
| --------- | ------------------------------------------------------------------------ |
| vs Notion | 块操作完整感不逊；默认更静；MD/扩展/原生性能更强                         |
| vs Typora | 静默与 MD 心流不逊；**额外**具备一等块操作与实时协同                     |
| vs AFFiNE | 能力地图可覆盖文档主路径；静默、MD 契约、Rust 热路径、默认纸面纯净度更强 |

### 6.3 证据口径（本文写作约束自检）

- [x] Notion / Typora 论断标【公开产品观察】
- [x] AFFiNE / 本仓论断可回溯到路径或文件
- [x] 含完整三维对照表
- [x] 含静默×块操作融合逻辑
- [x] 含「AFFiNE 强但必须更强」专节

---

## 7. 修订

| 日期       | 说明                                                             |
| ---------- | ---------------------------------------------------------------- |
| 2026-08-10 | 初版：Notion / Typora / AFFiNE 跨产品优点对照 → 本产品效果锁映射 |
