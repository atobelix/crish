# 07 — Markdown 分层扩展模型（做到最好）

> **分册**：`feature-catalog/07-markdown-extension-model.md`  
> **角色**：定义 Conex Markdown **如何正确扩展** 的唯一权威规格；所有语法、往返、导出、注册表以本册分层为准。  
> **读者**：Parser/Serializer 作者、扩展作者、导出适配器、产品验收、实现 agent。  
> **原则**：先想透标准 Markdown → 再想非 MD 结构 → 最后给出整体扩展体系。  
> **关联**：[README](./README.md) · [00-master-index](./00-master-index.md) · [../06-extensions.md](../06-extensions.md) · [../10-data-format.md](../10-data-format.md) · [../extensions/](../extensions/)  
> **状态**：W0 规格冻结草案 · 2026-08-02  
> **编码**：UTF-8（无 BOM）

---

## 0. 阅读指引与决策顺序

### 0.1 为什么先「想透标准」再「扩展」

扩展 Markdown 最常见的失败模式：

| 失败模式 | 现象 | 本册对策 |
|----------|------|----------|
| 先做花活后补标准 | 标题/列表/强调往返不稳，扩展再完美也无用 | **Layer A 为硬门槛** |
| 扩展语法与 GFM 抢 token | 同一串被两种规则解释 | 显式优先级档位 B0–B10 / I0–I7 |
| 把运行时状态写进 MD | 文档脏、外站打开炸 | Layer E 永不序列化 |
| 把无法表达的结构硬塞进 pipe 表 | 合并单元格「假保存」 | Layer D 显式 sidecar / comment |
| 未知扩展静默丢数据 | 用户文件被「吃掉」 | 未知块透传 + `raw` 保真 |
| 导出目标一刀切 | GitHub 能看、剪贴板却是私货 | 兼容矩阵按目标降级 |

**决策顺序（铁律）**：

1. **标准 MD 应该怎样**（CommonMark 实用子集 + 规范化偏好）  
2. **GFM 增量怎样**（表、任务、删除线、自动链接）  
3. **仍可用「看起来像 MD」的字符串表达的 Conex 能力**（callout / wiki / file / embed）  
4. **MD 根本表达不了的结构**（合并单元格、列宽、列类型）如何外挂且不谎称无损  
5. **仅编辑器会话存在的 AI/协作注解**如何绝不污染落盘  
6. 最后才是 **注册表、钩子、导出矩阵、功能金标准清单**

### 0.2 本册覆盖的 F-ID 族

| F-ID 前缀 | 含义 |
|-----------|------|
| F-EXT-LAY-* | 分层策略本身 |
| F-EXT-REG-* | 扩展注册表与钩子 |
| F-EXT-A-* | Layer A 保真 |
| F-EXT-B-* | Layer B GFM 增量 |
| F-EXT-C-* | Layer C Conex 友好语法 |
| F-EXT-D-* | Layer D 不可 MD 结构 |
| F-EXT-E-* | Layer E 瞬时注解 |
| F-EXT-IO-* | 导出目标兼容 |
| F-EXT-PASS-* | 未知块透传 |
| F-EXT-FEAT-* | 每个扩展的「做到最好」 |

### 0.3 与历史文档关系

| 文档 | 关系 |
|------|------|
| `06-extensions.md` | 实现契约与解析顺序细节；**冲突时以本册分层语义为准**，细节回写 06 |
| `extensions/*` | 单扩展深度规格；本册给总层与金标准索引 |
| `10-data-format.md` | Doc/Block 形状；本册定义「哪些字段进 MD / sidecar / 不序列化」 |
| `v3-complete/03-table-advanced.md` | 合并表算法；本册只定 Layer D 序列化策略 |

---

## 1. 心智模型：五层洋葱

```
┌─────────────────────────────────────────────────────────────┐
│ Layer E · 瞬时 / AI / 选区 / 协作光标 · 永不进 MD            │
├─────────────────────────────────────────────────────────────┤
│ Layer D · MD 不可表达结构 · frontmatter / HTML 注释 / sidecar │
├─────────────────────────────────────────────────────────────┤
│ Layer C · Conex 扩展但 MD 友好 · 可往返 · 可降级              │
├─────────────────────────────────────────────────────────────┤
│ Layer B · GFM 增量 · 表 / 任务 / 删除线 / autolink           │
├─────────────────────────────────────────────────────────────┤
│ Layer A · CommonMark 实用子集 · 纯保真硬门槛                  │
└─────────────────────────────────────────────────────────────┘
         ▲ 外站阅读器大致停在 A+B
         ▲ Conex 读写默认 A+B+C
         ▲ 专业表格/布局进入 D
         ▲ 编辑会话装饰停留在 E
```

### 1.1 每层一句话

| 层 | 一句话 | 序列化默认 |
|----|--------|------------|
| **A** | 「打开任何正常 MD 都不该错」 | 纯文本 Markdown |
| **B** | 「GitHub 能预览的那些增量」 | 纯文本 GFM |
| **C** | 「外站可能不识别，但人类可读、可降级」 | Conex MD 字符串 |
| **D** | 「标准 MD 数学上表达不了」 | MD 近似 + 元数据外挂 |
| **E** | 「只活在当前会话」 | **禁止**写入任何持久化 |

### 1.2 做到最好（分层总则）

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-LAY-01 | 层边界清晰 | 任意字段能回答：进 A/B/C/D/E 哪一层；无「灰色地带」 |
| F-EXT-LAY-02 | 下层不被上层破坏 | 开/关 Layer C 扩展不得改变 A/B 往返结果 |
| F-EXT-LAY-03 | 降级可解释 | 导出到较弱目标时，用户可理解「丢了什么、没丢什么」 |
| F-EXT-LAY-04 | 往返可测 | 每层有固定 fixture 与 `semanticEqual` 判据 |
| F-EXT-LAY-05 | 安全默认 | 未知 HTML、危险协议、远程脚本扩展默认拒绝 |
| F-EXT-LAY-06 | 版本可演进 | `conex-md` / `doc.version` 只加不破；旧引擎遇未知则透传 |

---

## 2. 先想透：标准 Markdown 应该怎样工作

### 2.1 产品立场（不是「完整 cmark 字节级一致」）

Conex 的目标 **不是** 成为 CommonMark 合规证明器，而是：

1. **作者意图可预测**：用户输入/粘贴常见 MD，得到符合预期的块结构。  
2. **往返语义相等**：Conex → MD → Conex 在语义层一致（可忽略 runtime id、光标、exists 等）。  
3. **序列化规范化**：同语义多次导出，风格稳定（列表统一 `-`、强调偏好 `*`/`**` 等）。  
4. **安全**：原始 HTML 不当 DOM 执行。

**明确不追求**：与某个具体 cmark 二进制逐字节一致；完整 HTML 块；定义列表（除非未来进 Layer C）。

### 2.2 标准 MD 的「真相源」分工

| 面 | 真相源 | 说明 |
|----|--------|------|
| 磁盘 / 剪贴板 / 宿主交换 | **Markdown 字符串** | UTF-8、LF 优先 |
| 编辑 / 拖拽 / 撤销 | **Block[]** | 不操作原始字符串切片 |
| 验收 | **语义图** | 规范化后的块树 + 行内 runs，不是导出字符串是否逐字相同 |

「做到最好」的标准 MD 引擎：

- 解析：**宽松输入**（接受 `*`/`+`/`-` 列表、`[X]`/`[x]` 任务等）。  
- 序列化：**严格偏好**（输出统一方言）。  
- 显示：失焦 = 渲染态；聚焦行 = 源码态（见 01 分册）——**扩展不得破坏此模型**。

### 2.3 标准块：行为契约摘要

| 结构 | 解析要点 | 序列化偏好 | 聚焦源码（概念） |
|------|----------|------------|------------------|
| 段落 | 空行分段；软换行→空格 | 纯文本 + 行内 marks | 同行显示 marks 源 |
| ATX 标题 | `#{1,6}` + 空格 | 同 level 的 `#` + 空格 | `## 标题` |
| 无序列表 | `-` `*` `+` | 统一 `-` | 源标记与圆点阶梯见 F-CORE-05 |
| 有序列表 | `1.` / `1)` | 递增 `1.` `2.`… | 数字源可见 |
| 引用 | 连续 `>` | 每行 `> ` | 灰 `>` 或源可见 |
| 围栏代码 | \`\`\` / ~~~ | 始终 \`\`\` + lang | 单卡片含完整围栏 |
| 分隔线 | `---` `***` `___` | `---` | 渲染线；聚焦可显示 `---` |
| 行内强调 | `*`/`**`/`_`/`__` | 偏好 `*`/`**` | 聚焦可见标记 |
| 行内代码 | 反引号 | 最短足够反引号 | 源可见 |
| 链接 | `[t](url)` | 同形；title 可选 | 源可见 |
| 图片 | `![alt](src)` | 同形 | 图或源切换见媒体分册 |

### 2.4 标准 MD 的硬边界（禁止用「扩展」破坏）

1. **围栏内永不解释** 其它 MD / 扩展语法。  
2. **行内代码 span 内永不解释** 强调、链接、wiki、file。  
3. **不把用户粘贴的任意 HTML 升级为可执行 DOM**。  
4. **不把缩进代码块作为推荐作者路径**（可解析，序列化鼓励改 fence）。  
5. **Setext 标题**（`===`）可选；v1 可不实现，遇之不得崩溃。

### 2.5 Layer A 金标准清单

| ID | 功能 | 做到最好 | 验收要点 |
|----|------|----------|----------|
| F-EXT-A-01 | ATX H1–H6 往返 | level 与正文 marks 不丢 | fixture 含中文标题 |
| F-EXT-A-02 | 段落软/硬换行 | 策略文档化且稳定 | 两空格硬换行或 `\` 锁定一种 |
| F-EXT-A-03 | 强调嵌套 | 常见 `***` 不炸 | 与 gfm-baseline 一致 |
| F-EXT-A-04 | 列表嵌套 | indent 语义正确 | 2/4 空格策略锁定 |
| F-EXT-A-05 | 引用多段 | 空 `>` 分段 | 与 callout 首行规则不冲突 |
| F-EXT-A-06 | 围栏语言 | info string 首词为 lang | 未闭合吃到 EOF 再补闭合 |
| F-EXT-A-07 | 分隔线 vs 表分隔 | 整行 hr 不与表混淆 | 边界表 fixture |
| F-EXT-A-08 | 链接安全 | 危险协议不可点 | `javascript:` 等 |
| F-EXT-A-09 | HTML 当文本 | 不执行 script | 粘贴消毒 |
| F-EXT-A-10 | 规范化导出 | 同 Doc 两次 `getMarkdown` 在偏好规则下稳定 | 快照测 |
| F-EXT-A-11 | 换行归一 | CRLF→LF 读入 | Windows 路径场景 |
| F-EXT-A-12 | 空文档 | 空串 ↔ 单空段落或空 blocks 策略锁定 | 打开不崩 |

**Layer A 出口标准**：上述 P0 项全部 ≥ 金标准打分 4；任何 Layer C 扩展关闭后，A 的 fixture **零回归**。

---

## 3. 再想透：GFM 增量（Layer B）应该怎样工作

### 3.1 定位

Layer B = **GitHub Flavored Markdown 中已被广泛依赖、且仍是「纯文本 MD」的那部分**。  
它们不是 Conex 私货，但是 CommonMark 严格子集之外的「事实标准」。

| 能力 | 语法印象 | 为何属 B 而非 C |
|------|----------|-----------------|
| 表格 | pipe + 分隔行 | GH/VS Code/多数预览器原生 |
| 任务列表 | `- [ ]` / `- [x]` | GFM 标准 |
| 删除线 | `~~text~~` | GFM 标准 |
| 自动链接 | `<>` 与裸 URL | GFM extended |
| （可选）脚注 | `[^1]` | 许多引擎有；Conex 默认 **P2 预留**，未实现前不抢 token |

### 3.2 表格（GFM 无合并）在 Layer B 的契约

**能表达**：

- 矩形网格、表头行、列对齐（`:---` / `:---:` / `---:`）  
- 单元格内 **行内** marks（粗体、链接、代码等）  
- 单元格内 Layer C 行内 atom（wiki/file）——解析允许，属「B 容器 + C 内容」

**不能表达（推到 Layer D）**：

- `rowspan` / `colspan`  
- 列宽像素、冻结列  
- 列类型（人员、公式）  
- 单元格背景色作为文档语义（若仅主题则可 E 或 D）

**做到最好**：

| ID | 做到最好 |
|----|----------|
| F-EXT-B-01 | GFM 表 100% 可读写；对齐符号往返 |
| F-EXT-B-02 | 表编辑永远是网格 UI，不整表源码框 |
| F-EXT-B-03 | 无合并时 `conex` 与 `pure-gfm` 导出一致（仅风格空白可差） |
| F-EXT-B-04 | 畸形表（缺分隔行）不崩溃；降级为段落或尽力表 |

### 3.3 任务列表

| 规则 | 值 |
|------|-----|
| 识别 | bullet + `[ ]` / `[x]` / `[X]` |
| 存储 | `checked: boolean` |
| 写回 | 未完成 `[ ]`，完成 `[x]`（小写） |
| 与普通列表 | 同一缩进体系；切换类型可逆 |

| ID | 做到最好 |
|----|----------|
| F-EXT-B-05 | 勾选立即反映到序列化；撤销可恢复 |
| F-EXT-B-06 | 嵌套任务与嵌套 bullet 共存且 indent 正确 |

### 3.4 删除线与自动链接

| ID | 做到最好 |
|----|----------|
| F-EXT-B-07 | `~~` 与强调嵌套规则明确；code 内不生效 |
| F-EXT-B-08 | `<>` autolink 与裸 URL 可关 flag；关闭后不误伤 |
| F-EXT-B-09 | 裸 URL 尾部标点剥离策略稳定、可测 |

### 3.5 Layer B 与 Layer A 的关系

- B **建立在** A 之上：列表规则复用 A 的 list 扫描，再特化任务。  
- B **不得** 改变 A 中非 GFM 结构的序列化偏好。  
- 导出 `pure-gfm` **必须** 完整保留 B（这是「外站可读」的底线之上的默认）。

---

## 4. 再想透：非标准 / 扩展语法应该怎样工作

### 4.1 判定树：一个新能力进哪一层？

对任意候选功能问四个问题：

```
Q1. 能否用 CommonMark/GFM 已有语法完整表达语义？
    是 → Layer A 或 B（不要发明新语法）
    否 ↓
Q2. 能否发明一种「人类可读、像 Markdown、外站降级后仍不糟」的文本语法？
    是 → Layer C
    否 ↓
Q3. 是否必须在「专业编辑」中保留，但允许 MD 近似丢失细节？
    是 → Layer D（MD 近似 + 外挂元数据）
    否 ↓
Q4. 是否只服务当前会话（AI 高亮、协作光标、临时批注）？
    是 → Layer E
    否 → 重新定义产品需求（不要硬塞 MD）
```

### 4.2 Layer C 设计准则（MD 友好扩展）

| 准则 | 含义 | 反例 |
|------|------|------|
| **可读** | 外站当纯文本打开，人仍能猜意图 | 二进制 blob、无意义短码 |
| **可降级** | pure-gfm 映射到链接/引用/代码等 | 导出后语义全无 |
| **可往返** | conex 模式 Conex→MD→Conex 语义相等 | 只写不读或只读丢字段 |
| **不抢 A/B** | 优先级档位固定；围栏/code 内无效 | 在 code 里解析 `[[` |
| **安全** | 路径、协议、长度 cap | 任意 `javascript:`、无限回溯正则 |
| **可开关** | feature flag；关解析仍 serialize 已有块 | 关扩展就丢用户块 |
| **有版本** | meta.id + syntaxVersion | 无 id 的隐式 if-else |

### 4.3 Layer C 推荐语法形态（白名单风格）

| 形态 | 适用 | 示例印象 |
|------|------|----------|
| GitHub Alert 引用 | callout | `> [!NOTE]` |
| 双括号协议 atom | file / wiki | `[[file:…]]` `[[doc:…]]` |
| 显式扩展链接 | embed | `@[embed](url)` |
| 围栏语言特化 | mermaid | \`\`\`mermaid |
| 独占行 `$$` | 数学块 | `$$ … $$` |
| `:::` 容器 | **仅兼容解析**，默认不写回 | VuePress 粘贴 |

**禁止作为默认写回**（除非产品显式开关）：

- 任意 HTML 自定义标签  
- 依赖预处理的 MDX 表达式  
- 无协议的模糊 `[[自由标题]]`（易与未来冲突；可 P2 再开）

### 4.4 Layer D 设计准则（不可 MD 表达）

| 准则 | 含义 |
|------|------|
| **诚实** | 文档与 UI 不声称「GFM 无损保存合并表」 |
| **主文件仍是 MD** | 默认产品路径 `.md`；sidecar 可选 |
| **近似可读** | MD 侧仍有可理解的表/段落，不是空壳 |
| **权威在结构化层** | 合并等以 JSON Doc / sidecar / 注释块为权威 |
| **可剥离** | 用户可「导出纯 GFM」丢掉 D 细节 |
| **可迁移** | 注释/sidecar schema 有版本号 |

### 4.5 Layer E 设计准则（瞬时）

| 准则 | 含义 |
|------|------|
| **永不进 getMarkdown()** | 自动化测试锁死 |
| **永不进 Doc 持久化字段** | 可进内存 `EditorSession` |
| **刷新即无** | 除非宿主自己另存会话 |
| **不进撤销的「文档语义」** 可选 | AI 建议未应用前不进 history；应用后变 A–D 内容 |

---

## 5. Layer A — CommonMark 实用子集纯保真

### 5.1 保证范围

| 结构 | 保证 | 备注 |
|------|------|------|
| ATX 标题 | ✅ | Setext 可选 |
| 段落 / 硬换行 | ✅ | 策略锁定 |
| 强调 | ✅ | 序列化偏好 `*`/`**` |
| 行内代码 | ✅ | |
| 链接 / 图片语法 | ✅ | 图片块体验可分期 |
| 列表 ul/ol | ✅ | |
| 引用 | ✅ | 与 callout 分流在 B6 |
| 围栏代码 | ✅ | |
| 分隔线 | ✅ | |
| 缩进代码 | ⚠️ | 不推荐 |
| HTML 块 | ❌ 当文本 | 安全 |
| 定义列表 | ❌ | 未进层 |

### 5.2 保真定义（语义相等）

以下差异 **允许**（不破坏保真）：

- 块 `id` 重新生成  
- 空白行数量在块边界的归一  
- 列表标记 `*` → `-`  
- 强调 `_` → `*`（在等价前提下）  
- 有序标记全 `1.` vs 递增（实现锁定一种后测试跟锁定走）

以下差异 **不允许**：

- 标题 level 变  
- 任务勾选状态变  
- 链接 href 丢  
- 代码语言丢  
- 列表嵌套层级变  
- 表格行列内容错位  

### 5.3 解析优先级中的 A 档（概念）

块扫描中属于 A 的核心档：围栏、标题、hr、引用（非 alert）、列表（非任务特化亦可算 B）、段落。  
详见 §9 与 `06-extensions` 的 B0–B10；**本层要求：扩展注册不得插入到围栏锁定之内**。

### 5.4 做到最好 — Layer A 扩展点（即使是「内置」）

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-A-20 | gfm.baseline 作为内置包 | 以扩展形态注册，便于测试替身，但不可被用户卸载导致引擎空心 |
| F-EXT-A-21 | 解析错误可定位 | 坏文档给出行号级警告，不整篇失败 |
| F-EXT-A-22 | 极大文档 | 2k 块软警告；>500 虚拟化策略不改语义 |

---

## 6. Layer B — GFM 增量

### 6.1 表格（无合并）

**语法轮廓**：

```md
| 左 | 中 | 右 |
| --- | :---: | ---: |
| a | b | c |
```

| 主题 | 规范摘要 |
|------|----------|
| 表头 | 默认首行为 header；`hasHeader` 可关（序列化仍常保留分隔行） |
| 对齐 | 列级 `align[]` |
| 单元格 marks | 走同一 `parseInline` |
| 空单元格 | 允许 |
| 导出 | pipe 表；不对齐时用 `---` |

**与 Layer D 交界**：一旦用户合并单元格，块进入「增强表」状态——见 §8。

### 6.2 任务 / 删除线 / autolink

已在 §3 列出；本层强调：

- **feature flags**：`gfm`、`autolink` 可关；`gfm=false` 时表/任务/删除线策略需文档化（建议仍解析表，或整体降级——**锁定：gfm flag 控制 B 全套**）。  
- **测试**：GitHub 官方样例子集进 CI。

### 6.3 Layer B 金标准

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-B-10 | 表 + 任务 + 删除线 + autolink 全开默认 | Notebook 开箱即 GH 可读 |
| F-EXT-B-11 | 关闭 autolink 不破坏显式链接 | 回归 fixture |
| F-EXT-B-12 | 任务与 callout/列表混排 | 复杂文档 fixture |

---

## 7. Layer C — Conex 扩展（MD 友好）与往返策略

### 7.1 扩展总表（Layer C）

| meta.id | 形态 | 分期 | 默认 | 主序列化 | pure-gfm 降级 |
|---------|------|------|------|----------|---------------|
| `conex.callout` | 块 | P1 | 开 | `> [!KIND]` | 同左或 `> **提示**` |
| `conex.file_chip` | 行内/可独占块 | P1 | 开 | `[[file:path]]` | 链接或行内代码 |
| `conex.wiki_link` | 行内 | P1 | 开 | `[[doc:title]]` | 链接或纯文本 |
| `conex.embed` | 块 | P2 | 关 | `@[embed](url)` | 普通链接段 |
| `conex.math` | 块+行内 | P2 | 关 | `$$` / `$` | 保留源码 |
| `conex.mermaid` | fence 语言 | P2 | 关 | \`\`\`mermaid | 同左（外站自便） |
| `conex.footnotes` | 行内+尾定义 | P2 | 关 | `[^id]` | 同左或展开括号 |

### 7.2 往返策略总则（Round-Trip Policy）

定义三种序列化模式：

| mode | 名称 | 用途 |
|------|------|------|
| `conex` | Conex 完整 | 默认保存、autosave、内部复制 |
| `pure-gfm` | 纯 GFM 友好 | 外站粘贴、GitHub 讨论、保守导出 |
| `lossy-plain` | 纯文本 | 搜索索引、无格式通知 |

**往返承诺**：

| 路径 | 承诺 |
|------|------|
| Doc --conex--> MD --parse--> Doc' | **语义相等**（Layer A+B+C 已启用部分） |
| Doc --pure-gfm--> MD --parse--> Doc' | A+B 全等；C **降级后语义 ⊆ 原语义**（可弱不可妄增） |
| 外站编辑过的 pure-gfm 再导入 | 尽力；Layer C 可能变 A/B 结构（如 callout 变 quote） |

**写回偏好（conex 模式）**：

1. callout → 始终 GitHub Alert，不写 `:::`（除非 flag `preferContainerFence`）  
2. file/wiki → 规范双括号协议；path 统一 `/`  
3. embed → `@[embed]` 形式，不写 iframe  
4. 不写默认 frontmatter（保持 artifact 干净）

### 7.3 Callout（`conex.callout`）

**主语法**：

```md
> [!TIP] 可选标题
> 正文
```

**兼容解析**：`::: tip 标题` … `:::`

| 主题 | 做到最好 |
|------|----------|
| 与 quote 分流 | 仅首有效行 `[!KIND]` 才升级 |
| kind 归一 | 大小写不敏感；别名 info→note 等 |
| 子块 | 可含段落/列表；v1 不嵌套 callout |
| 主题 | class 钩子；色不唯一语义（a11y） |
| 降级 | pure-gfm 仍 Alert 或 bold-prefix 可配 |

| ID | 做到最好一句话 |
|----|----------------|
| F-EXT-C-CALL-01 | 主路径创建/编辑/序列化/再开一致 |
| F-EXT-C-CALL-02 | `:::` 粘贴可识别且写回 Alert |
| F-EXT-C-CALL-03 | 非法 kind 不崩溃，fallback 样式 |
| F-EXT-C-CALL-04 | slash 插入五种标准 kind + success |

### 7.4 File chip（`conex.file_chip`）

**主语法**：`[[file:src/a.ts]]` · 可选 `|label`

| 主题 | 做到最好 |
|------|----------|
| 点击 | `onOpenPath(path, { kind: 'file-chip' })` |
| 安全 | 控制字符拒绝；打开时宿主防 `..` 逃逸 |
| 独占行 | 可升块，序列化字符串一致 |
| 运行时 `exists` | **仅内存**，属 Layer E 旁路，不写 MD |
| 降级 | `` [`basename`](path) `` 或 `` `path` `` |

| ID | 做到最好一句话 |
|----|----------------|
| F-EXT-C-FILE-01 | 路径规范化稳定（`\`→`/`） |
| F-EXT-C-FILE-02 | code span 内不解析 |
| F-EXT-C-FILE-03 | 半截 `[[file:` 保持纯文本 |
| F-EXT-C-FILE-04 | 与对话流 ActionRow 视觉同源 |

### 7.5 Wiki link（`conex.wiki_link`）

**主语法**：`[[doc:标题.md]]` · 可选 `|显示名` · `ref:` 预留

| 主题 | 做到最好 |
|------|----------|
| 与 file 分工 | doc→Notebook；file→Files 面板（产品铁律） |
| v1 要求协议前缀 | 无前缀 `[[x]]` 当文本（或 P2） |
| 降级 | `[title](#)` 或纯文本 |
| 补全 | 宿主端口；编辑器不内置全库搜索实现 |

| ID | 做到最好一句话 |
|----|----------------|
| F-EXT-C-WIKI-01 | doc/ref 往返；label 不丢 |
| F-EXT-C-WIKI-02 | 中文标题可用 |
| F-EXT-C-WIKI-03 | 与 `[t](url)` 不互相误吃 |

### 7.6 Embed（`conex.embed`，P2）

**主语法**：`@[embed](https://…)` · 可选标题

| 主题 | 做到最好 |
|------|----------|
| 安全 | 仅 http(s)；默认无任意 iframe |
| 元数据 | OG 缓存可内存/宿主；**不强制进 MD**（可 D 若需持久） |
| 降级 | 链接段落 |
| flag 关 | 不升级裸 URL |

| ID | 做到最好一句话 |
|----|----------------|
| F-EXT-C-EMB-01 | 开关默认关；开启后往返稳定 |
| F-EXT-C-EMB-02 | 失败卡片显示 URL 可点 |

### 7.7 Math / Mermaid / Footnotes（P2 预留）

| 扩展 | 主语法 | 降级 | 注意 |
|------|--------|------|------|
| math | 行 `$$` / 行内 `$` | 保留源码 | 货币 `$` 误伤规则 |
| mermaid | fence `mermaid` | 同 fence | 沙箱渲染，禁止 eval |
| footnotes | `[^id]` + 尾定义 | 保留或展开 | 未实现时勿吞 token |

| ID | 做到最好一句话 |
|----|----------------|
| F-EXT-C-MATH-01 | 显示/行内可关；失败显示源 |
| F-EXT-C-MMD-01 | 失焦图、聚焦源；serialize 标准 fence |
| F-EXT-C-FN-01 | 实现前 `[^` 当文本；实现后完整往返 |

### 7.8 Layer C 横切金标准

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-C-00 | 扩展互不抢 token | 固定 I/B 档位；冲突有表 |
| F-EXT-C-01 | flag 关仍 serialize | 已有 callout 再打开不丢 |
| F-EXT-C-02 | 剪贴板 | 外部粘贴 pure-gfm；内部可带 conex |
| F-EXT-C-03 | a11y | atom 可键盘激活；callout 不靠色辨义 |
| F-EXT-C-04 | 长度 cap | path≤512、wiki target≤256、kind≤32 |
| F-EXT-C-05 | 中文与标点 | 全套 fixture 含中文 |

---

## 8. Layer D — MD 不可表达结构

### 8.1 哪些结构属于 D

| 结构 | 为何不可用标准 MD 完整表达 | 权威存哪里 |
|------|------------------------------|------------|
| 单元格合并 rowspan/colspan | pipe 表是矩形文本网格 | JSON Doc / sidecar / HTML 注释块 |
| 列宽（px/%） | GFM 无列宽 | block.meta / sidecar |
| 列类型（人员、单选…） | 非文档表模型 | meta.columnTypes（可灰显） |
| 表级筛选/排序视图状态 | 视图非内容 | **更偏 E**；若「保存视图」则 D |
| 文档级布局（分栏） | MD 无分栏原语 | 暂不做或 D |
| 自定义块属性面板杂项 | 无通用语法 | block.meta + 策略 |

### 8.2 三种外挂载体（可组合）

#### 8.2.1 YAML Frontmatter（文档级）

```md
---
conex-md: 1
title: 可选
table-model: v3
---
```

| 用途 | 适合 |
|------|------|
| 语法版本、标题、locale | ✅ |
| 整表合并数据 | ⚠️ 过大时不推荐全塞 frontmatter |
| 默认 | Notebook **可不写** frontmatter |

#### 8.2.2 HTML 注释块（文档内、靠近结构）

示例形态（规格级，非鼓励用户手写）：

```md
<!-- conex:table-meta v1
{"blockId":"b_xxx","merges":[{"r":0,"c":0,"rowspan":2,"colspan":2}]}
-->
```

| 规则 | 值 |
|------|-----|
| 仅引擎读写 | 用户源码态可折叠显示为「元数据」芯片 |
| 未知版本 | 整块保留为 raw 注释，不删 |
| 安全 | 不执行注释内任何脚本；JSON 严格 parse |
| pure-gfm 导出 | **剥离** 或保留取决于 `export.stripConexComments`（默认剥离） |

#### 8.2.3 Sidecar 文件

| 形态 | 说明 |
|------|------|
| `note.md` + `note.conex.json` | 同目录；Doc JSON 完整 |
| 单文件 `.conex.md.json` | 宿主可选主存 JSON |

| 规则 | 值 |
|------|-----|
| 默认产品路径 | 仍是单 `.md` |
| 冲突 | 若 sidecar 与 MD 时间戳冲突，策略：`prefer: md|json|newest` 可配；默认 **md 正文 + sidecar 增强字段合并** |
| 无 sidecar | 增强字段丢失，MD 近似仍可读 |

### 8.3 合并表格的导出策略（诚实矩阵）

| 导出目标 | 合并如何处理 | 用户感知 |
|----------|--------------|----------|
| `conex` + 注释/sidecar | 完整保留 | 再开仍合并 |
| `conex` 仅 MD 无外挂 | **展开为重复单元格文本** 或 **仅 anchor 文本、其余空**（锁定一种并测） | 外站看到平铺表 |
| `pure-gfm` | 同上平铺 + 剥离注释 | GH 可读矩形表 |
| JSON Doc | 完整 cells 含 rowspan/colspan | 宿主加速路径 |
| HTML 导出（若有） | 真 `rowspan`/`colspan` | 浏览器正确 |

**禁止**：在 pipe 单元格里塞不可见 Unicode 伪协议「假装」合并还在——不可维护、不可读。

### 8.4 列宽与其它 meta

| 字段 | 序列化 |
|------|--------|
| columnWidths | sidecar / block.meta；MD 忽略 |
| hasHeader | 可反映到是否输出表头行 |
| caption | 表下段落或 `*caption*` 约定；或 meta |

### 8.5 Layer D 金标准

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-D-01 | 合并权威不谎称 GFM 无损 | UI 文案与导出对话框诚实 |
| F-EXT-D-02 | 无 sidecar 时 MD 仍打开为合法表 | 不崩、不丢已有文字 |
| F-EXT-D-03 | 注释块版本化 | v1 schema 冻结；未知保留 |
| F-EXT-D-04 | pure-gfm 默认剥离引擎注释 | 外站干净 |
| F-EXT-D-05 | JSON Doc 往返合并 100% | 主路径测例 |
| F-EXT-D-06 | 平铺策略单一可测 | 展开算法有 fixture |
| F-EXT-D-07 | 用户不可因注释误伤 | 源码态误删注释 → 警告或可恢复 |

---

## 9. Layer E — AI / 瞬时注解（不序列化）

### 9.1 属于 E 的典型对象

| 对象 | 说明 |
|------|------|
| 选区高亮、查找高亮 | 会话装饰 |
| AI 建议幽灵文本（未接受） | Accept 前 |
| AI review 批注气泡 | 未「写入文档」前 |
| 协作远端光标 / 选区 | 若未来有 |
| file_chip `exists` 探测结果 | 运行时 |
| embed OG 拉取中状态 | loading |
| 撤销栈指针、IME composition | 引擎态 |
| 悬浮菜单、slash 打开态 | UI 态 |
| 临时 TOC 滚动 spy | 视图态 |

### 9.2 严格禁令

1. `getMarkdown()` / `serialize(mode: conex|pure-gfm)` **不得** 出现 E 痕迹。  
2. `getDoc()` 持久化形状 **不得** 含 E；允许 `getSessionState()` 另口。  
3. 自动化：序列化快照测试注入 AI 高亮后，MD 不变。  
4. 应用 AI 结果后：内容进入 A–C（或用户表格操作进 D），**建议文本本身**不再以 E 形式残留。

### 9.3 AI 端口与层的关系

| 阶段 | 所在层 |
|------|--------|
| 上下文收集（选区 MD） | 从 A–D 投影 |
| 流式预览 | E |
| 用户接受 rewrite | 写入块 → A–C |
| review 评论「仅建议」 | E |
| review「插入为 callout」 | C |

### 9.4 Layer E 金标准

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-E-01 | 序列化隔离 | 测试强制 |
| F-EXT-E-02 | 刷新丢失符合预期 | 产品文案不承诺持久 |
| F-EXT-E-03 | Accept/Reject 清晰 | 幽灵与正文不糊成一团 |
| F-EXT-E-04 | 无后端时 mock 完整 | 不写假数据进 MD |

---

## 10. 扩展注册表、解析/序列化钩子、未知块透传

### 10.1 注册表职责

扩展注册表（逻辑名 `ExtensionRegistry`，与 `BlockRegistry` 协作）负责：

| 职责 | 说明 |
|------|------|
| 唯一 id | `meta.id` 冲突 → 启动失败或后者拒绝 |
| 启用矩阵 | feature flags × enabledByDefault |
| 钩子挂载 | parse / parseLine / parseInline / serialize / slash / theme |
| 优先级带 | 块档 B*、行内档 I* |
| 降级策略 id | 映射到导出管线 |
| 版本 | syntaxVersion 协商 |

### 10.2 扩展描述符（规格字段，非实现代码）

每个扩展必须声明：

| 字段 | 含义 |
|------|------|
| id | 如 `conex.callout` |
| layer | A / B / C / D / E（E 通常不注册为 MD 扩展） |
| syntaxVersion | 整数 |
| priority | P0 / P1 / P2 |
| enabledByDefault | 布尔 |
| blockTypes / inlineTypes | 产出类型 |
| parse 钩子 | 块或行 |
| parseInline 钩子 | 行内 |
| serialize 钩子 | 按 mode 分支 |
| degrade | pure-gfm / lossy-plain 策略名 |
| slash | 可选 |
| security | 协议/路径策略引用 |
| fixtures | 必交往返样例 id 列表 |

### 10.3 解析钩子语义

| 钩子 | 何时 | 成功 | 失败 |
|------|------|------|------|
| parseLine | 行扫描 | 产出 token/block + 消费行数 | null，不改 index |
| parse | token→block | block + consumed | null |
| parseInline | 线性扫描 | node + consumed 字符 | null |
| 围栏锁定 | 任意 | 非代码扩展 **禁止** 消费锁定区 | — |

**铁律**：失败必须无副作用；禁止「先改 buffer 再失败」。

### 10.4 序列化钩子语义

| 输入 | 行为 |
|------|------|
| mode=conex | 写规范 Conex 方言 |
| mode=pure-gfm | 调用 degrade；不得输出仅引擎能懂的协议（或输出最弱可读形） |
| 子块 | 通过 ctx.serializeChildren 递归 |
| 行内 | ctx.serializeInline |

**顺序**：按文档块序；块间空行规则全局统一（扩展不得私自改全局空白策略，除非声明 `spacing: tight|loose`）。

### 10.5 未知块 / 未知行内透传（Passthrough）

#### 10.5.1 场景

- 未来版本写的块，当前引擎不识  
- 第三方工具插入的 HTML 注释 `<!-- conex:… -->` 新 schema  
- 半截损坏但仍有 raw  

#### 10.5.2 策略

| 情况 | 行为 |
|------|------|
| 未知 blockType 于 JSON Doc | 保留 `type` + `meta.raw` + 原字段；UI 显示「未知块」卡片；serialize 优先 raw |
| 未知 MD 结构 | 不丢行：落入 paragraph 或 `raw_block`（若有） |
| 未知行内 atom 协议 `[[foo:…]]` | v1：纯文本；未来：可注册 |
| 未知 frontmatter 键 | 保留键值，引擎不解释 |
| 未知 HTML 注释 conex 块 | 原样写回 |
| feature flag 关闭的已知扩展 | 若 MD 仍是该语法：可选「不升级为类型、当文本/quote」；若 Doc 已有类型：仍渲染+serialize |

#### 10.5.3 `raw_block` 概念（推荐）

| 字段 | 含义 |
|------|------|
| type | `raw_block` |
| format | `markdown` / `html-comment` / `unknown` |
| text | 原始字符串 |
| 编辑 | 默认只读源码卡片；允许删除整块 |

**做到最好**：用户升级引擎后，raw 可被新扩展重新认领（reparse 通道）。

### 10.6 注册与解析总顺序（块）

概念顺序（与 06 对齐，本册冻结语义）：

| 档 | 内容 | 层 |
|----|------|----|
| B0 | 围栏代码 | A |
| B1 | `$$` 数学 | C |
| B2 | `:::` 容器 | C |
| B3 | GFM 表 | B |
| B4 | ATX 标题 | A |
| B5 | HR | A |
| B6 | 引用 / Callout | A/C |
| B7 | 列表 / 任务 | A/B |
| B8 | 独占 file/wiki 行 | C |
| B9 | 段落 | A |
| B10 | 空行 | A |
| Bx | HTML 注释 meta | D |

### 10.7 行内总顺序

| 档 | 内容 | 层 |
|----|------|----|
| I0 | 行内代码 | A |
| I1 | `<>` autolink | B |
| I2 | 链接 / 图片 | A |
| I3 | `[[file:]]` / `[[doc:]]` | C |
| I4 | 强调 / 删除线 | A/B |
| I5 | 裸 URL | B |
| I6 | 裸 email | B |
| I7 | 文本 | A |

### 10.8 注册表金标准

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-REG-01 | 无核心巨石 if-else | 新语法=新 ExtensionSpec |
| F-EXT-REG-02 | 启动校验 id/档位冲突 | 清晰报错 |
| F-EXT-REG-03 | flag 热切换策略 | 文档化：仅影响新 parse 或即时 reparse |
| F-EXT-REG-04 | 未知块不丢字节 | raw 往返测 |
| F-EXT-REG-05 | serialize 模式注入 | 所有扩展尊重 mode |
| F-EXT-REG-06 | 单测每扩展最小包 | parse/serialize/degrade 三件套 |
| F-EXT-PASS-01 | 未来块 reparse | 升级路径文档化 |
| F-EXT-PASS-02 | 坏 JSON meta 不崩 | 回退 raw |

---

## 11. 兼容性矩阵：导出目标

### 11.1 目标定义

| 目标 id | 说明 | 典型 mode |
|---------|------|-----------|
| `conex-md` | Conex 默认落盘 | conex |
| `github` | GitHub 文件预览 / PR | pure-gfm 偏 Alert 保留 |
| `vscode` | VS Code 预览 | pure-gfm |
| `obsidian` | 社区库（双链友好） | conex 或特化（可选 wiki 无前缀 P2） |
| `notion-paste` | 粘贴到 Notion | pure-gfm / 简化 |
| `clipboard-md` | 系统剪贴板 | pure-gfm 默认 |
| `clipboard-conex` | 内部多块 | conex + 可选 JSON |
| `json-doc` | Doc JSON | 全 A–D |
| `html-export` | 静态 HTML | 渲染后 HTML，安全消毒 |
| `pdf-export` | 打印/PDF | 宿主；语义来自渲染树 |
| `plain-text` | 纯文本 | lossy-plain |
| `search-index` | 搜索 | plain + 标题权重 |

### 11.2 结构 × 目标矩阵

图例：`✅` 完整 · `◐` 降级可读 · `▽` 剥离/丢失增强 · `❌` 不支持/不输出

| 结构 | conex-md | github | vscode | clipboard-md | json-doc | plain |
|------|----------|--------|--------|--------------|----------|-------|
| 段落/标题/列表 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 强调/链接/代码 | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| GFM 表（无合并） | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| 任务列表 | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| 删除线 | ✅ | ✅ | ✅ | ✅ | ✅ | ◐ |
| Callout Alert | ✅ | ✅ | ◐ | ✅/◐ | ✅ | ◐ |
| file_chip | ✅ | ◐ | ◐ | ◐ | ✅ | ◐ |
| wiki_link | ✅ | ◐ | ◐ | ◐ | ✅ | ◐ |
| embed | ✅ | ◐ | ◐ | ◐ | ✅ | ◐ |
| mermaid 源 | ✅ | ✅源 | ✅源 | ✅源 | ✅ | ◐ |
| math 源 | ✅ | ◐ | ◐ | ◐ | ✅ | ◐ |
| 合并单元格 | ✅+D | ▽平铺 | ▽平铺 | ▽平铺 | ✅ | ▽ |
| 列宽 | D | ▽ | ▽ | ▽ | ✅ | ▽ |
| AI 幽灵/批注 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 引擎 HTML 注释 | ✅可选 | ▽默认剥 | ▽ | ▽ | 不需要 | ▽ |

### 11.3 降级策略命名（供扩展引用）

| strategy id | 行为摘要 |
|-------------|----------|
| `identity` | 原样 |
| `github-alert` | callout 写 `> [!KIND]` |
| `bold-quote-prefix` | `> **提示：**` |
| `md-link` | 变为 `[label](target)` |
| `inline-code` | 变为 `` `path` `` |
| `plain-label` | 仅标签文本 |
| `fence-keep` | 保留围栏源码 |
| `table-flatten-merges` | 合并表→矩形重复/清空 |
| `strip-conex-comments` | 删引擎注释 |
| `strip-frontmatter` | 删 YAML 头（可选） |

### 11.4 导出 UX 金标准

| ID | 功能 | 做到最好 |
|----|------|----------|
| F-EXT-IO-01 | 导出对话框说明将丢失项 | 合并/芯片/批注列表 |
| F-EXT-IO-02 | 一键「复制为 GitHub MD」 | pure-gfm + strip comments |
| F-EXT-IO-03 | 默认保存不伤 Conex 语义 | conex-md |
| F-EXT-IO-04 | 矩阵有自动测 | 每目标至少 1 fixture 包 |
| F-EXT-IO-05 | 宿主可注册自定义目标 | 适配器接口稳定 |

---

## 12. 全扩展「做到最好」功能清单（总册）

> 下列为 **扩展模型视角** 的完整清单；交互细节仍以各 `extensions/*` 与块分册为准。  
> 状态栏：规格阶段一律 `缺失→待实现`；金标准列是验收靶心。

### 12.1 平台与注册

| ID | 功能 | 做到最好 | 层 | 优先级 |
|----|------|----------|----|--------|
| F-EXT-REG-01 | 扩展注册表 | 无巨石；热插拔策略清 | — | P0 |
| F-EXT-REG-02 | id/优先级冲突检测 | 启动即失败并指出双方 | — | P0 |
| F-EXT-REG-03 | feature flags | 与产品开关同步 | — | P0 |
| F-EXT-REG-04 | serialize mode 全局 | conex / pure-gfm / plain | — | P0 |
| F-EXT-REG-05 | 往返测试框架 | semanticEqual + 规范化 | — | P0 |
| F-EXT-REG-06 | 语法版本协商 | conex-md frontmatter 可选 | — | P1 |
| F-EXT-PASS-01 | 未知块 raw 透传 | 不丢字节、可再解析 | D/C | P0 |
| F-EXT-PASS-02 | 未知 frontmatter 键 | 保留 | D | P1 |
| F-EXT-PASS-03 | 损坏文档恢复 | 最大努力块切分 | A | P0 |

### 12.2 Layer A

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-A-01 | 标题往返 | level+marks | P0 |
| F-EXT-A-02 | 段落换行策略 | 锁定可测 | P0 |
| F-EXT-A-03 | 强调 | 嵌套稳定 | P0 |
| F-EXT-A-04 | 列表嵌套 | indent 正确 | P0 |
| F-EXT-A-05 | 引用 | 多段 | P0 |
| F-EXT-A-06 | 围栏代码 | 语言+补闭合 | P0 |
| F-EXT-A-07 | 分隔线 | 与表不打架 | P0 |
| F-EXT-A-08 | 链接安全 | 危险协议 | P0 |
| F-EXT-A-09 | HTML 当文本 | 不执行 | P0 |
| F-EXT-A-10 | 规范化导出稳定 | 快照 | P0 |
| F-EXT-A-11 | 换行归一 | CRLF | P0 |
| F-EXT-A-12 | 空文档 | 不崩 | P0 |
| F-EXT-A-20 | baseline 内置包 | 可测 | P0 |
| F-EXT-A-21 | 错误可定位 | 行号警告 | P1 |
| F-EXT-A-22 | 大文档策略 | 软限制 | P1 |

### 12.3 Layer B

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-B-01 | GFM 表读写 | 对齐往返 | P0 |
| F-EXT-B-02 | 表网格编辑 | 非整表源码 | P0 |
| F-EXT-B-03 | 无合并导出一致 | conex=pure | P0 |
| F-EXT-B-04 | 畸形表 | 降级不崩 | P0 |
| F-EXT-B-05 | 任务勾选序列化 | 即时正确 | P0 |
| F-EXT-B-06 | 嵌套任务 | indent | P0 |
| F-EXT-B-07 | 删除线 | 与 code 隔离 | P0 |
| F-EXT-B-08 | autolink 可关 | 不误伤 | P0 |
| F-EXT-B-09 | 裸 URL 标点 | 稳定剥离 | P0 |
| F-EXT-B-10 | B 全开默认 | 开箱 GH | P0 |
| F-EXT-B-11 | 关 autolink 回归 | fixture | P0 |
| F-EXT-B-12 | 混排文档 | 复杂 fixture | P1 |

### 12.4 Layer C — Callout

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-C-CALL-01 | Alert 主路径 | 往返 | P1 |
| F-EXT-C-CALL-02 | `:::` 兼容 | 写回 Alert | P1 |
| F-EXT-C-CALL-03 | kind 归一与 fallback | 不崩 | P1 |
| F-EXT-C-CALL-04 | slash 插入 | 标准 kinds | P1 |
| F-EXT-C-CALL-05 | 子列表/段落 | 正确 children | P1 |
| F-EXT-C-CALL-06 | pure-gfm 策略可配 | alert/bold | P1 |
| F-EXT-C-CALL-07 | a11y note 角色 | 不靠色 | P1 |

### 12.5 Layer C — File chip

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-C-FILE-01 | 路径规范化 | `\`→`/` | P1 |
| F-EXT-C-FILE-02 | code 内不解析 | 隔离 | P1 |
| F-EXT-C-FILE-03 | 残缺语法 | 纯文本 | P1 |
| F-EXT-C-FILE-04 | 视觉同源流 | chip UI | P1 |
| F-EXT-C-FILE-05 | label 管道 | 往返 | P1 |
| F-EXT-C-FILE-06 | 降级链接/代码 | pure-gfm | P1 |
| F-EXT-C-FILE-07 | 独占行块形态 | 串一致 | P1 |
| F-EXT-C-FILE-08 | 安全 cap | 长度/控制符 | P1 |
| F-EXT-C-FILE-09 | exists 不进 MD | Layer E | P1 |
| F-EXT-C-FILE-10 | 键盘打开 | Enter/Space | P1 |

### 12.6 Layer C — Wiki link

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-C-WIKI-01 | doc/ref 往返 | label | P1 |
| F-EXT-C-WIKI-02 | 中文标题 | 可用 | P1 |
| F-EXT-C-WIKI-03 | 与 MD 链接分流 | 不误吃 | P1 |
| F-EXT-C-WIKI-04 | onOpenPath wiki-link | 宿主 | P1 |
| F-EXT-C-WIKI-05 | pure-gfm 降级 | 文本/链接 | P1 |
| F-EXT-C-WIKI-06 | 无前缀策略 | v1 当文本 | P1 |
| F-EXT-C-WIKI-07 | 补全端口 | 宿主注入 | P1 |
| F-EXT-C-WIKI-08 | 与 file 铁律 | 源码不进 Notebook | P0 产品 |

### 12.7 Layer C — Embed / Math / Mermaid / Footnotes

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-C-EMB-01 | 开关默认关 | 开启往返 | P2 |
| F-EXT-C-EMB-02 | 失败可点 URL | 卡片 | P2 |
| F-EXT-C-EMB-03 | 仅 http(s) | 安全 | P2 |
| F-EXT-C-EMB-04 | 裸 URL 升级规则严 | 整段唯一 | P2 |
| F-EXT-C-MATH-01 | 块公式 | 失败显源 | P2 |
| F-EXT-C-MATH-02 | 行内 `$` 防货币误伤 | 规则清 | P2 |
| F-EXT-C-MMD-01 | 失焦渲染聚焦源 | 单表面 | P2 |
| F-EXT-C-MMD-02 | 沙箱/失败 | 无 eval | P2 |
| F-EXT-C-FN-01 | 未实现不吞 `[^` | 文本 | P2 |
| F-EXT-C-FN-02 | 实现后定义往返 | 尾注 | P2 |

### 12.8 Layer C — 横切

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-C-00 | 优先级档位 | 冲突表公开 | P0 |
| F-EXT-C-01 | flag 关仍 serialize | 不丢块 | P0 |
| F-EXT-C-02 | 剪贴板策略 | 内外部区分 | P1 |
| F-EXT-C-03 | a11y | 键盘+角色 | P1 |
| F-EXT-C-04 | 长度 cap | 防 DoS | P0 |
| F-EXT-C-05 | 中文 fixture | 全覆盖 | P0 |
| F-EXT-C-06 | slash 与扩展 meta 对齐 | 无幽灵命令 | P1 |
| F-EXT-C-07 | 主题仅 class 钩子 | 色值归视觉册 | P1 |

### 12.9 Layer D

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-D-01 | 合并诚实导出 | 文案+行为 | P0 |
| F-EXT-D-02 | 无 sidecar 可开 | 平铺表 | P0 |
| F-EXT-D-03 | 注释版本化 | 未知保留 | P1 |
| F-EXT-D-04 | pure 剥注释 | 默认 | P0 |
| F-EXT-D-05 | JSON 合并完整 | 往返 | P0 |
| F-EXT-D-06 | 平铺算法单一 | fixture | P0 |
| F-EXT-D-07 | 误删 meta 可恢复 | 警告/undo | P1 |
| F-EXT-D-08 | 列宽 meta | 可选持久 | P1 |
| F-EXT-D-09 | frontmatter 可选 | 不强制脏文件 | P1 |
| F-EXT-D-10 | sidecar 冲突策略 | 可配 | P2 |

### 12.10 Layer E

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-E-01 | 序列化隔离 | 测锁 | P0 |
| F-EXT-E-02 | 刷新即无 | 预期管理 | P0 |
| F-EXT-E-03 | AI Accept 边界 | 清 | P1 |
| F-EXT-E-04 | mock 不进 MD | 无后端 | P1 |
| F-EXT-E-05 | Session API 分离 | getSessionState | P1 |
| F-EXT-E-06 | 查找高亮不进 Doc | 显然 | P0 |

### 12.11 导出 IO

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-IO-01 | 丢失项说明 | 导出 UI | P1 |
| F-EXT-IO-02 | 复制 GitHub MD | 一键 | P1 |
| F-EXT-IO-03 | 默认保存完整 | conex | P0 |
| F-EXT-IO-04 | 矩阵自动测 | CI | P0 |
| F-EXT-IO-05 | 自定义目标 | 宿主适配 | P2 |
| F-EXT-IO-06 | HTML 导出消毒 | 无脚本 | P2 |
| F-EXT-IO-07 | plain 索引可用 | 搜索 | P2 |

### 12.12 分层元能力

| ID | 功能 | 做到最好 | 优先级 |
|----|------|----------|--------|
| F-EXT-LAY-01 | 字段分层可回答 | 设计评审清单 | P0 |
| F-EXT-LAY-02 | 上层不破坏下层 | 关 C 测 A/B | P0 |
| F-EXT-LAY-03 | 降级可解释 | 文档+UI | P0 |
| F-EXT-LAY-04 | 往返可测 | 每层 fixture | P0 |
| F-EXT-LAY-05 | 安全默认 | 拒绝危险 | P0 |
| F-EXT-LAY-06 | 版本只加不破 | 演进策略 | P0 |

---

## 13. 安全边界（扩展视角）

| 域 | 规则 |
|----|------|
| 协议 | 允许 http/https/mailto/相对路径；拒绝 javascript/vbscript 等 |
| HTML | 不解析为可执行 DOM；注释仅 JSON meta |
| 路径 | 打开时宿主 resolve；防出工作区 |
| 正则 | 禁止灾难性回溯；手写扫描优先 |
| 资源 | 单 fence 体积、块数软限制 |
| 远程扩展 | **禁止**运行时加载远程脚本扩展；仅编译期/启动注册 |
| mermaid | 官方渲染+沙箱；失败回源码 |

| ID | 做到最好 |
|----|----------|
| F-EXT-SEC-01 | 安全表有测（危险 href 不可点） |
| F-EXT-SEC-02 | 粘贴 HTML 消毒进 MD 子集 |
| F-EXT-SEC-03 | 扩展声明 security profile |

---

## 14. 版本与演进

### 14.1 `conex-md` 语法版本

| 版本 | 内容 |
|------|------|
| 1 | GFM 子集 + Alert callout + `[[file:]]` + `[[doc:]]` |
| 2+ | 仅添加可忽略节点；旧引擎透传未知 |

### 14.2 引擎读更高版本

1. 能识别的子集照常解析  
2. 不能识别的 → raw / 文本 / 保留注释  
3. 警告可进宿主 toast（不阻断打开）

### 14.3 写回

- 不主动升级 frontmatter 除非用户功能需要  
- serialize 使用 min(文档版本, 引擎版本) 能力集  

---

## 15. 测试与验收矩阵（规格要求）

### 15.1 测试类型

| 类型 | 覆盖 |
|------|------|
| L0 语义往返 | A+B+C 全扩展 fixture |
| L1 规范化快照 | 序列化偏好 |
| L2 降级快照 | pure-gfm / plain |
| L3 透传 | 未知块、未知注释 |
| L4 安全 | 危险链接、巨大输入 |
| L5 分层隔离 | E 注入不影响 MD；关 C 不影响 A |
| L6 导出目标 | 矩阵每列至少 1 包 |

### 15.2 最低 fixture 包（命名建议）

| 包名 | 内容 |
|------|------|
| `a-basic-zh` | 中文标题列表代码链接 |
| `b-table-task` | 表+任务+删除线+URL |
| `c-callout-roundtrip` | Alert + ::: |
| `c-file-wiki` | 混排芯片 |
| `d-merge-flatten` | 合并→平铺 |
| `d-comment-meta` | 注释保留/剥离 |
| `e-ai-no-leak` | 高亮后 MD 不变 |
| `pass-unknown-block` | raw 往返 |

### 15.3 验收打分对齐

沿用 [00-master-index](./00-master-index.md) 0–5 分；本册 P0 出口：相关 F-ID ≥4 且无 0–2。

---

## 16. 与其它分册的接口

| 分册 | 本册提供 | 本册依赖 |
|------|----------|----------|
| 01 核心块/行源码 | 扩展不得破坏聚焦源码模型 | 块编辑体验 |
| 02 代码/公式/图 | math/mermaid 层归属 C | 渲染单表面 |
| 03 表格 | 合并属 D；GFM 属 B | 网格 UX |
| 04 媒体结构 | file/wiki/callout/embed 索引 | 交互细节 |
| 05 AI/导出 | E 与 IO 矩阵 | 端口 UX |
| 06 动效 | 无序列化影响 | 无 |
| 08 包模块 | 注册表模块边界 | 包路径 |

---

## 17. 决策附录：常见争议题

### 17.1 为什么 callout 不做成 HTML？

HTML 外站不安全、难往返、易变 XSS 面。Alert 语法 GH 已认，降级最好。

### 17.2 为什么 file/wiki 要用 `[[proto:]]` 而不是普通链接？

- 与「打开工作区路径 / 打开文档 store」产品动作绑定  
- 避免与普通 URL 导航混淆  
- 可在阅读态用 chip 组件而非浏览器默认蓝链

### 17.3 为什么合并表不发明「扩展 pipe 语法」？

任何把 rowspan 塞进单元格文本的方言都会：

- 人类不可读  
- 外站显示垃圾  
- 与真单元格内容冲突  

故走 Layer D 外挂 + 诚实平铺。

### 17.4 为什么 AI 批注不能写 HTML 注释？

会污染 diff、引起误合并、让「未接受建议」变成文件内容。Accept 后应变成正常 A–C 内容。

### 17.5 能否支持 MDX / 任意组件？

默认 **否**。MDX 是编译期程序，不是 Notebook 文档格式。若未来要做，单开 Layer 与安全模型，不混进默认 C。

### 17.6 与 Typora / Obsidian / Notion 的边界

| 产品 | 我们学什么 | 我们不学什么 |
|------|------------|--------------|
| Typora | 行源码聚焦体验 | 其全部私有语法 |
| Obsidian | 双链心智 | 全库图谱强制 |
| Notion | 块操作手感 | Database 与私有存储当主格式 |
| GitHub | GFM 可读底线 | 以 GH 为唯一功能上限 |

---

## 18. 实施波次建议（仅扩展模型相关）

| 波次 | 内容 |
|------|------|
| W0 | 本册冻结；F-ID 回填 00 索引 |
| W1 | Layer A 往返测试先绿（与行源码并行但 parse 独立） |
| W1+ | Layer B 表/任务 fixture |
| W6 | Layer C callout/file/wiki 主路径 |
| W3/W6 | Layer D 合并导出策略与 JSON |
| W8 | Layer E 与 AI 端口隔离测试 |
| 全程 | 注册表与透传作为 parse 骨架的一部分，禁止事后打补丁 |

**规则**：没有 Layer A 绿灯，不允许宣称 Layer C「完成」。

---

## 19. 速查：扩展作者检查清单

发布一个新扩展前，作者必须能勾选：

1. 已用 §4.1 判定树选对层  
2. 若 Layer C：有人类可读语法 + pure-gfm 降级 + 往返测  
3. 若 Layer D：有权威载体 + 诚实降级 + 不谎称无损  
4. 若 Layer E：证明序列化快照不变  
5. 声明 id、档位、flags、security、fixtures  
6. 不在围栏/code 内抢解析  
7. 不把逻辑塞进核心上帝文件  
8. 中文与空/极大/残缺边界有例  
9. a11y：键盘可达或明确 void  
10. 在本册 §12 补 F-ID 与「做到最好」  

---

## 20. 总结：整体如何扩展 Markdown

用一段话收束：

> **先保证 CommonMark 实用子集与 GFM 增量在语义上绝对可靠（A+B）；  
> 再只对「仍像 Markdown、可降级、可往返」的能力发明 Conex 方言（C）；  
> 对数学上无法用 MD 表达的结构，外挂版本化元数据并诚实降级（D）；  
> 对 AI 与会话装饰，永远留在内存（E）。  
> 一切扩展进注册表，按固定优先级钩子解析/序列化，未知者透传，导出按目标矩阵降级。**

这就是 Conex「做到最好」的 Markdown 扩展模型。

---

## 21. 文档维护

| 项 | 值 |
|----|----|
| 权威 | 本文件（功能与分层） |
| 实现细节回写 | `06-extensions.md`、`10-data-format.md` |
| 单扩展深稿 | `extensions/*.md` |
| 变更流程 | 改层语义须 bump 本节版本说明并加 fixture |
| 行数目标 | 600–1200；超出则拆附录不删层定义 |

**分册状态**：W0 规格 · agent 交付 · 待调度回填 [00-master-index](./00-master-index.md) §4。

---

*（完）*
