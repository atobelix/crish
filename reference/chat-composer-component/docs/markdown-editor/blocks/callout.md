# Block: `callout`

> 索引：[02-block-catalog.md](../02-block-catalog.md)  
> 扩展语法总表见 `06-extensions.md`  
> **优先级**：P1

---

## 1. 目标 / 非目标

- **目标**：Notion/GitHub 风格提示块（信息/警告/危险/成功等）；可含子段落；MD 可往返。
- **非目标**：任意自定义 HTML；折叠 callout（用 toggle P2）；多列 callout。

---

## 2. 标识

| 字段 | 值 |
|------|-----|
| type id | `callout` |
| slash | `insert.callout`（可再拆 `insert.callout_warning` 等，映射 kind） |
| atom | 否（容器） |

---

## 3. Markdown 语法

### 3.1 主形式（GitHub alerts 兼容）

```md
> [!NOTE]
> 信息说明

> [!TIP]
> 提示

> [!IMPORTANT]
> 重要

> [!WARNING]
> 警告

> [!CAUTION]
> 危险
```

### 3.2 标题扩展（可选）

```md
> [!WARNING] 自定义标题
> 正文
```

无 GFM 原生时，解析器认 `[!KIND]`；序列化写回同形。

### 3.3 降级

- 未知 kind → `note` 或保留 raw 字符串到 `props.kind`。
- 普通 `>` quote 无 `[!` → `quote` 块，非 callout。

---

## 4. props schema

```ts
type CalloutKind =
  | 'note'
  | 'tip'
  | 'important'
  | 'warning'
  | 'caution'
  | 'success'   // 扩展，serialize 为 [!TIP] 或 [!NOTE] 若严格 GH；推荐 [!TIP] + 映射表
  | string;     // 开放，小写

interface CalloutProps {
  kind: CalloutKind;
  title?: string; // 可选自定义标题；默认用 kind 中文/英文标签
}

interface CalloutBlock {
  id: string;
  type: 'callout';
  props: CalloutProps;
  children: Block[]; // 通常 paragraph[]；可 list
}
```

**kind → 默认中文标题**（阅读态 header，非用户 content）：

| kind | 默认标题 |
|------|----------|
| note | 说明 |
| tip | 提示 |
| important | 重要 |
| warning | 警告 |
| caution | 注意 |
| success | 成功 |

用户 `title` 覆盖默认标题显示；serialize 写 `[!KIND] title`。

---

## 5. 阅读 DOM

```html
<div class="mdx-block mdx-block--callout mdx-block--callout-warning mdx-block--reading"
     data-block-type="callout" data-callout-kind="warning" data-state="reading">
  <div class="mdx-block__gutter"></div>
  <div class="mdx-block__body">
    <aside class="mdx-callout mdx-callout--warning" role="note">
      <div class="mdx-callout__header">
        <span class="mdx-callout__icon" aria-hidden="true"></span>
        <span class="mdx-callout__title">警告</span>
      </div>
      <div class="mdx-callout__content">
        <p class="mdx-paragraph">正文</p>
      </div>
    </aside>
  </div>
</div>
```

| class | 用途 |
|-------|------|
| `mdx-callout` | 根 |
| `mdx-callout--{kind}` | 色板钩子（具体色 → `07`） |
| `mdx-callout__icon` | 左簇图标 |
| `mdx-callout__title` | 标题 |
| `mdx-callout__content` | 子块 |

---

## 6. 编辑交互

| 操作 | 行为 |
|------|------|
| Click 正文 | 编辑对应子 paragraph |
| Click 标题 | 编辑 `props.title`（可选 P1）；或打开 kind 菜单 |
| Enter 在内容非空段 | 同 quote：段内拆分，仍在 callout |
| Enter 在内容 **空** 段 | 退出 callout，空段变后方 paragraph |
| Backspace 首段首 | 解除 callout → 普通 quote 或裸 paragraph 们 |
| slash 在空 callout 内 | 可插入子块类型（list 等） |

**kind 切换**：块菜单或 slash 变体；改 `props.kind` 不丢 children。

---

## 7. Placeholder

- 内容空段：`提示内容`
- 无 title 时 header 仍显示默认中文 kind 名（非 placeholder）

---

## 8. 序列化边界

| 情况 | 处理 |
|------|------|
| 空 callout | 可输出 `> [!NOTE]\n> \n` 或省略；slash 新建保留一行 |
| 多子段 | 每行 `>` 前缀 |
| 子 list | `> - item` 缩进规则同 GH |
| success 等扩展 kind | 写出 `[!SUCCESS]`；严格 GH 模式映射 TIP（配置项） |
| 与 quote 互转 | 去 `[!]` 即 quote；加 `[!NOTE]` 即 callout |
| HTML 消毒 | 子内容走统一 inline/block sanitize |

---

## 9. canMergeWith

相邻 callout 同 kind 不自动 merge（P2 可提供命令）。

---

## 10. a11y

- `aside` + `role="note"`；warning/caution 可用 `role="status"` 慎用 alert（避免打断）。
- 标题与 kind 在可访问名中可读：`警告：…`。
- 颜色不作为唯一语义（图标 + 标题文字）。

---

## 11. 测试点

1. 五种 GH kind 往返。  
2. 自定义 title 往返。  
3. Enter 空段退出。  
4. slash 默认 note +「提示内容」。  
5. 未知 `[!FOO]` 保留 kind。

---

## 12. 分期

| 项 | 期 |
|----|-----|
| NOTE/WARNING 等 + 子段 | P1 |
| 自定义 title | P1 |
| success 扩展 | P1 |
| 块内嵌 table | P2 |
