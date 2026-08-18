# Extension: `gfm.baseline` — Conex 保证的 GFM 子集

> 索引：[06-extensions.md](../06-extensions.md)  
> 块索引：[02-block-catalog.md](../02-block-catalog.md)  
> **优先级**：P0（默认启用，不可关解析核心）  
> **meta.id**：`gfm.baseline`

---

## 1. 目标 / 非目标

### 目标

- 冻结 Notebook / 块编辑器 **必须正确解析与往返** 的 GFM/CommonMark 实用子集。  
- 给出可测语法、序列化规范（L1 规范化偏好）、边界与安全。  
- 作为所有 Conex 扩展的 **底层前提**（扩展不得破坏本子集）。

### 非目标

- 完整 CommonMark 规范证明 / 与 cmark 逐字节一致。  
- 原始 HTML 块、定义列表、脚注（脚注见 06 §8.3 P2）。  
- 表格单元格合并、复杂嵌套 block quote 列表（v2）。

---

## 2. 保证范围总表

| 结构 | 支持 | 备注 |
|------|------|------|
| ATX 标题 `#`–`######` | ✅ | 闭合 `#` 可选忽略 |
| 段落与硬换行 | ✅ | 尾两空格或 `\\` → hard_break（实现锁定一种） |
| 强调 `*` / `**` / `_` / `__` | ✅ | 序列化偏好 `*` / `**` |
| 删除线 `~~` | ✅ | GFM |
| 行内代码 `` ` `` | ✅ | |
| 链接 `[t](url)` | ✅ | title 可选 |
| 图片 `![alt](src)` | ✅ P2 块体验；语法 P0 可解析为 image 块或段内 | |
| 自动链接 `<>` | ✅ | |
| 裸 URL | ✅（flag） | |
| 无序/有序列表 | ✅ | 嵌套靠 indent |
| 任务列表 | ✅ | GFM |
| 引用 `>` | ✅ | |
| 围栏代码 \`\`\` / ~~~ | ✅ | 优先 \`\`\` |
| 分隔线 | ✅ | |
| GFM 表格 | ✅ | 无合并 |
| 缩进代码块（4 空格） | ⚠️ 可选 | v1 可映射 paragraph 或 code；推荐作者用 fence |
| HTML 块 | ❌ 当文本 | 安全 |
| Setext 标题 | ⚠️ 可选 | v1 可不实现；遇 `===` 当下划线段落 |

---

## 3. 数据形状

本扩展不引入独立 BlockType；映射到 catalog 已有类型：

```ts
// 块
'paragraph' | 'heading' | 'bullet_list' | 'ordered_list' | 'list_item'
| 'task_list' | 'task_item' | 'quote' | 'code_block' | 'table'
| 'table_row' | 'table_cell' | 'divider' | 'image'

// 行内
InlineNode + Mark（bold/italic/strike/link/inline_code）
```

若引擎采用 **扁平 list item**（见 01），则无 `bullet_list` 容器块，仅 `bullet_list_item` 等——**语义测试按 item 序列**，DOM 视觉成组。实现锁定一种并在测试 helper `semanticEqual` 中归一。

---

## 4. 块级语法细则

### 4.1 标题

```md
# 一级
## 二级
### 三级
```

| 规则 | 值 |
|------|-----|
| 语法 | `^#{1,6}\s+.+` |
| props | `{ level: 1..6 }` |
| 序列化 | `'#'.repeat(level) + ' ' + inline` |
| 空标题 | 允许；placeholder 见 catalog |

**不保证**：Setext（`Title\n===`）v1。

### 4.2 段落

- 连续非结构行合并为一段；中间单换行 → 软换行（空格拼接）或保留 `\n`（实现锁定：**软换行变空格**，硬换行用两空格+NL）。  
- 空行分段。

### 4.3 围栏代码

````md
```typescript
const x = 1;
```
````

| 字段 | 规则 |
|------|------|
| 开启 | 行首最多 3 空格 + \`\`\` 或 ~~~ + 可选 info string |
| language | info 首词；其余 meta 可进 `props.meta`（P2） |
| 关闭 | 同行数以上同种围栏标记 |
| 未闭合 | 吃到 EOF；serialize 补闭合 |
| 内容 | **不**做 MD 解析 |

**序列化偏好**：始终 \`\`\`；language 小写可选规范化（`TS`→`ts` 可关）。

### 4.4 列表

```md
- 无序 A
- 无序 B
  - 嵌套

1. 有序
2. 有序
```

| 项 | 规范 |
|----|------|
| bullet 标记 | `-` `*` `+` 均解析；**serialize 统一 `-`** |
| ordered | `1.` / `1)` ；serialize `1.` 递增或全 `1.`（GFM 宽松，实现锁定 **递增**） |
| 缩进 | 2 或 4 空格；实现 indent 级别 |
| 懒续行 | v1 可要求子段缩进；简化：续行并入 item 文本 |

### 4.5 任务列表

```md
- [ ] 未完成
- [x] 完成
- [X] 完成
```

- 仅 bullet 前缀 + 空格 + `[ ]` / `[x]` / `[X]`。  
- `props.checked: boolean`。  
- serialize：未完成 `[ ]`，完成 `[x]`（小写 x）。

### 4.6 引用

```md
> 一行
> 二行
```

- 连续 `>` 合并。  
- 首行若为 callout marker → 交给 `conex.callout`，**本 baseline 不产出 callout**。  
- 嵌套 `>>`：v1 flatten 一层或保留 indent；**测试只保证一层**。

### 4.7 分隔线

```md
---
***
___
```

- 整行（可空白）至少 3 个同种符号，可含空格间隔。  
- 与 setext/段落冲突：空行后的 `---` 优先 hr。

### 4.8 表格（GFM）

```md
| 左 | 中 | 右 |
| --- | :---: | ---: |
| a | b | c |
```

| 规则 | 说明 |
|------|------|
| 表头 | 必需 |
| 分隔行 | 每列 `-` 且可选 `:` 对齐 |
| align | left / center / right / null |
| 单元格 | 行内 MD；**v1 无块级嵌套** |
| 列数 | 以表头为准；短缺补空，过长截断或保留（锁定 **补空**） |
| 序列化 | 对齐符按 props；单元格内 `|` 转义 `\|` |

---

## 5. 行内语法细则

### 5.1 代码

- 一对反引号；内容可含 `*` `_` 等。  
- 内容需反引号时用更多围栏反引号（GFM）。  
- serialize：优先单反引号。

### 5.2 强调

| 标记 | mark |
|------|------|
| `**text**` / `__text__` | bold |
| `*text*` / `_text_` | italic |
| `***text***` | bold+italic |
| `~~text~~` | strike |

**序列化偏好**：`**` / `*` / `~~`（不用 `__` `_` 除非原文仅有下划线且 L2 不保证）。

**边界**：

- 中文邻接：`**加粗**。` 允许。  
- 字中下划线 `snake_case`：不开启 italic（左右侧需边界，贴近 GFM）。  
- code 内不强调。

### 5.3 链接与图片

```md
[标签](https://example.com "title")
![alt](./img.png "title")
```

- 目标括号平衡；title 单双引号。  
- 危险协议：见 06 §7；解析为 text 或 link 但 `href` 清空 + UI blocked。  
- 图片：可提升为 `image` 块（独占段时）或 paragraph 内 atom——**catalog 倾向块**；baseline 要求至少不丢 alt/src。

### 5.4 自动链接

见 [06-extensions.md](../06-extensions.md) §9。本扩展 **保证** 尖括号形式；裸 URL/email 默认开。

---

## 6. 序列化连接规则

| 前块 \ 后块 | 连接 |
|-------------|------|
| list_item → list_item 同列表 | 单 `\n` |
| paragraph / heading / code / table / hr | 块后 `\n\n` |
| quote 内多行 | 每行 `>` 前缀，块后空行 |
| 文档尾 | 单尾 `\n` |

---

## 7. 交互

| 场景 | 行为 |
|------|------|
| 阅读态 | 语义 HTML：`h1–h6` `p` `ul/ol` `pre/code` `blockquote` `table` `hr` `a` `img` `del` `strong` `em` |
| 编辑态 | 整块切换；列表 Enter 拆项等见 catalog / blocks/* |
| 粘贴 GFM | 走 `fromMarkdown`；优先识别 fence/table |
| 粘贴富文本 | 降为纯文本或简易 MD（宿主） |

---

## 8. 边界情况

| 情况 | 处理 |
|------|------|
| 仅 `*` 无闭合 | 纯文本 |
| 表无分隔行 | 当段落（含 `\|`） |
| 列表标记后无空格 | 不当列表 |
| 标题无空格 `#Foo` | 不当标题（严格）或兼容（锁定 **需空格**） |
| 混用 CRLF | 预规范化 `\n` |
| 超大表格 | 正常解析；虚拟化是视图问题 |
| emoji | 按字符串码元，不拆 mark |

---

## 9. a11y

- 标题层级不跳级警告属产品层；DOM 用真 `h1–h6`。  
- 表格：`<th scope="col">`。  
- 任务列表：checkbox `aria-checked` 与键盘切换（编辑态）。  
- 链接：可见焦点环；外链可提示（可选）。

---

## 10. 安全

- 见 06 §7。  
- 图片 src 同链接协议白名单。  
- code 内容始终 textContent 转义，禁止 `innerHTML` 灌原始 fence。

---

## 11. 测试点

1. RT-G01–G05（06 矩阵）。  
2. 强调嵌套 `**a *b* c**`。  
3. 表格对齐往返。  
4. 任务 `[X]` → serialize `[x]`。  
5. 围栏内 `# 标题` 保持字面。  
6. 列表嵌套 indent 往返。  
7. 危险链接不可点击。  
8. 中文 + 英文混排强调。  
9. 空文档 → 单空 paragraph。  
10. 仅 hr / 仅 code 文档。

---

## 12. 分期

| 项 | 期 |
|----|-----|
| 标题/段/强调/链接/列表/任务/引用/fence/hr/表 | P0 |
| 裸 autolink | P0 |
| 图片块精致编辑 | P2（语法可 P0 解析） |
| 4 空格代码 / Setext | 可选 / 不做 |

---

## 13. 修订

| 版本 | 日期 | 说明 |
|------|------|------|
| 0.1 | 2026-08-02 | 首版 GFM 保证子集 |
