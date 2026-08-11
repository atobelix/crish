# W0-B · Conex-MD 块 ID 与嵌套落位（一次钉死）

## 机器主编码

- 每个块在 Conex-MD 中以 **独占行** 起始：`<!--c:UUID-->`（小写 hex UUID）
- **禁止** 行内夹带其它文本
- pure-gfm 导出：剥离所有 `<!--c:…-->` 行，并记 `lossy: stripped_block_ids`

## 可选别名

- `{#short}` 仅作人类锚点；**不**作 Agent/反链主键
- 冲突时机器 ID 胜

## 嵌套落位（统一，关闭 D3 两处矛盾）

```
<!--c:parent-uuid-->
# 标题文本

<!--c:child-uuid-->
子段落…
```

- ID 注释 **永远** 在该块内容之前、独占行
- 子块 ID 在父块内容流内、子内容之前
- 列表项：ID 行在 `- ` 内容块之前（序列化时父 list 容器可有容器 ID）

## 手写注释保护

- 仅匹配 `<!--c:` + UUID v4 形 + `-->`
- `<!-- comment -->` 普通 HTML 注释 **不** 当块 ID、**不** 剥离（pure-gfm 策略：仅剥 conex ID）

## 测试

- golden：`crates/conex-md-ast/tests/golden/`（W2-A 填充）
- 单测：`encode/decode/strip` 已在 crate
