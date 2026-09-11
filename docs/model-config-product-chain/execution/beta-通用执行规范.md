# β 轮通用执行规范

> 实现子 Agent = `00-总方案.md` + `plans/02-设置写路径保存即落盘.md` + 上轮 `execution/α-轮次报告.md` + 本文件。
> 轮次：β。对应维：S2。禁止 git commit / restore / reset / checkout / --no-verify。禁止派生子 Agent。

## 本轮鼓励

- 用户点保存后 **读磁盘** 出现 thinking / modalities / pricing / protocol / contextWindow。
- 唯一写核：`ensureLsImported` → `ensureLoaded` → store `updateModel|addModel|updateProvider|addProvider|removeModel` → `workbench_save_models_yaml`。成功才 `models-catalog-changed`。
- 一次性 LS→yaml 导入：有完成标记；yaml 已有字段赢；导入后生产不再写三把配置 LS 键。
- 本会话真跑你文件域内的测试。中文注释，UTF-8 无 BOM。

## 本轮禁止

- 把「保存按钮存在 / applyMeta 被调用」写成完成。
- 提交或实现面使用未提交旧岛 `modelCatalog*` 扩字段 / setter。
- `applyMetaForModel` / `setModelModalities|Thinking|Pricing` / `upsertPrice` 作为配置真源。
- 写失败改写 LS；双写 yaml+LS；保存接到 300ms 防抖。
- 把 `defaultThinkingLevel` 写入 yaml。
- 改 Composer / Picker / `request_options` / `build_*.rs` / CSS。
- `cacheRead = input * 0.1`；空价抄预填/catalog 牌价进 yaml。
- 明文 apiKey 写入 yaml。
- 新 fallback / TODO / 无日期完成。

## 阅读集

1. `docs/model-config-product-chain/00-总方案.md` §0–§5、§7 β 行、M10/M11/M15
2. `plans/02-设置写路径保存即落盘.md` 全文
3. `execution/α-轮次报告.md` 第七节
4. 本文件 + `execution/β-派单.md` 你那一行

## 并行纪律

只改派单写集。交叉契约：

- `draftToModelPatch` 符号放 `apps/crish-desktop/src/api/modelsDraftMap.ts`
- `ensureLsImported` 放 `apps/crish-desktop/src/api/modelsLsImport.ts`
- S1 已保证 store 写 IPC 诚实；本轮不要改 `modelsCatalogIpc.ts` / `catalog_types.rs` / `engine_provider.rs`

## 轮末汇总格式

同 α-通用执行规范。用户路径：实现 Agent 默认未跑 4000，不要拿 vitest 冒充「点保存改了磁盘」。
