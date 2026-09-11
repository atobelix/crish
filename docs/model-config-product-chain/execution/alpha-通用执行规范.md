# α 轮通用执行规范

> 实现子 Agent = `00-总方案.md` + `plans/01-真源契约与IPC同构.md` + 本文件。
> 轮次：α。对应维：S1。禁止 git commit / restore / reset / checkout。禁止派生子 Agent。

## 本轮鼓励

- 按 `plans/01` 任务单元做根因修复：类型同构、IPC 只打已注册三命令、消费 `providers`、镜像 fail-closed、`live_catalog()` 可调用。
- 写出键只许 SSOT（`contextWindow`、`input`/`output`/`cacheRead`/`cacheWrite`、`google/generate-content`、拍平 `thinking`）。
- 本会话真跑你文件域内的测试；命令与出口写进轮末汇总。
- 中文注释，UTF-8 无 BOM。用编辑工具写文件，禁止 shell 重定向写中文。

## 本轮禁止

- 把 YAML 弹窗能打开、单测绿、命令已注册写成产品链已通。
- 改 Composer / Picker / `useModelConfigSession` / `ModelConfigPanel*` / `build_*.rs` / `request_options` 的 `..Default::default()` 方言装配。
- 提交或「顺手修」八个未提交旧岛：`modelCatalog.ts` / `modelCatalogMeta.ts` / `modelCatalogTypes.ts` 及其测试。
- 登记 `models_yaml_read` / `models_yaml_write` / `models_yaml_reload`。
- 生产路径保留 `convertFlatModelsToTree`、`wire.tree`、幽灵命令优先。
- 新增 fallback / TODO / 双轨读。坏 yaml 或命令缺失当成空 `providers` 成功。
- 发明 `--surface-primary`、第三份 CatalogTypes、运行时 merge `catalog.json`。
- 改 `catalog_types::ModelPricingSpec::calculate_cost` 公式（S5 独占）。

## 阅读集（禁止要求聊天记录）

1. `docs/model-config-product-chain/00-总方案.md` §0–§5、§7 α 行、§10
2. `docs/model-config-product-chain/plans/01-真源契约与IPC同构.md` 全文
3. `docs/model-config-product-chain/00-调度与执行纪律.md` L1–L12
4. 本文件 + `execution/α-派单.md` 你那一行

## 并行纪律

- 只改派单写集。必须动他人文件 → 写入汇总「遗留」，停手上报。
- 先读互斥表。同文件已有所有者则不得写入。
- `EngineProviderConfig` 新字段在其它文件的字面量：由 α-3 独占补 `None` / `..Default::default()`，其它 Agent 禁止改那些测试文件。

## 验证

- 源码形状：你负责的 grep 反例必须本会话跑过。
- 真跑测：写完整命令、是否本会话真跑、绿/红。没跑就写没跑。
- 用户路径：本轮默认未跑 4000，不要拿 vitest 冒充。

## 轮末汇总格式

```
## 轮末汇总：<Agent 编号> / <任务单元>
- 目标：
- 完成：<路径:行号>
- 未完成：
- 新发现：
- 遗留：
- 验证-源码形状：
- 验证-本会话真跑测：<命令 + 出口>
- 验证-用户路径：本轮未跑 4000
- 新引入 fallback/TODO/双轨：必须 0
```
