# α 轮派单书

> **轮次**：α
> **做**：W1（模型身份与真源契约）+ W4（硬编码清剿，Rust 与前端部分）
> **依赖**：无（基础层）
> **本轮闭合的产品链动词**：同名模型不再串味；新增供应商不被猜测成 OpenAI

---

## 阅读集（每个 Agent 最低阅读）

1. `00-总方案.md` §0（用户裁决）、§3（不变量）、§5（跨维锁）、§6（问题全集）、§7（本轮行）
2. `survey/01-现状勘察证据全集.md` 本维相关节
3. `plans/01-模型身份与真源契约.md` 或 `plans/04-硬编码清剿与方言数据化.md` **全文**
4. `00-调度与执行纪律.md`

---

## 派单表（文件域两两不相交）

| Agent | 维 | 文件域 | 任务 |
| --- | --- | --- | --- |
| **α1** | W1 | `apps/crish-desktop/src/api/modelsCatalogTypes.ts`、`apps/crish-desktop/src/api/modelsNormalize.ts` | 新增 `ModelRef` 身份类型族；把 `modelsNormalize.ts` 扩展为**协议字面量唯一 SSOT**（`PROTOCOLS` / `ModelProtocol` / `PROTOCOL_LABELS` / `DEFAULT_PROTOCOL` / `LEGACY_PROTOCOL_ALIASES` / `normalizeProtocol`）；`modelsCatalogTypes.ts` 的协议类型改为从 SSOT 导入 |
| **α2** | W1 | `apps/crish-desktop/src/api/provider-profiles/profileValidation.ts` | 删除 `pickDefaultModelSelection` 的跨厂商分支 2（`:359-368`）、分支 4（`:379-385`）、分支 5/6（`first_available` `:387-405`）；保留分支 1（同 provider 精确命中）与分支 3（`active_profile_first`，仅同 provider） |
| **α3** | W1 | `apps/crish-desktop/src/api/modelCatalogPure.ts`、`apps/crish-desktop/src/api/modelsCatalogSelectors.ts`、`apps/crish-desktop/src/api/modelsCatalogStore.ts` | `pickDefaultCatalogEntry` 删除或改签名；`selectModelGlobally` 删除或改为返回全部候选；`buildIndexes` 改用 `modelRefKey` |
| **α4** | W1 | `crates/agent-provider/src/models/catalog_types.rs`、`crates/agent-provider/src/models/catalog.rs` | 新增 Rust `ModelRef`；删除 `lookup_by_model_id`（`:479-487`） |
| **α5** | W4 | `apps/crish-desktop/src/components/settings-models/catalogWriteGate.ts`、`profileCatalog.ts`、`firstRunWizardLib.ts`、`useModelProfilesState.ts`、`useModelConfigSession.ts`、`ProviderProfileForm.tsx`、`apps/crish-desktop/src/api/modelsLsImport.ts`、`apps/crish-desktop/src/api/directFetchBridge.ts` | 协议下拉/默认值全部从 SSOT 派生；删除 `directFetchBridge.ts:133` 的模型 ID 兜底 |
| **α6** | W4 | `crates/agent-provider/src/models/behavior.rs`、`crates/agent-provider/src/request/cache_policy.rs`、`crates/agent-provider/src/migration.rs` | 删除 `infer_vendor` 与 `MODEL_SERIES_CACHE_BEHAVIOR`；`cache_policy.rs:159` 调用点改为 yaml 驱动；`migration.rs` 四张厂商表改私有 + 删除 OpenAI 兜底 |

**依赖说明**：α5 依赖 α1 导出的 `PROTOCOLS` / `DEFAULT_PROTOCOL` / `PROTOCOL_LABELS`（接口已在 `plans/04` §2.3 锁定，α5 按锁定名编码即可）。
α2/α3/α4/α6 相互独立。

---

## 验收（本轮）

### A 源码形状
- `modelsCatalogTypes.ts` 导出 `ModelRef` + `normalizeModelRef` + `modelRefKey` + `sameModelRef`
- `modelsNormalize.ts` 导出 `PROTOCOLS` + `ModelProtocol` + `PROTOCOL_LABELS` + `DEFAULT_PROTOCOL`
- `profileValidation.ts` 中 `first_available` grep = 0；无 `models.includes(storedModel)` 形式的跨厂商 find
- `catalog.rs` 中 `lookup_by_model_id` grep = 0
- `behavior.rs` 中 `infer_vendor` / `MODEL_SERIES_CACHE_BEHAVIOR` grep = 0
- `migration.rs` 中 `"https://api.openai.com/v1"` grep = 0
- 协议字面量 `'openai/chat'` 等**仅**出现在 `modelsNormalize.ts`（其他生产文件 grep = 0）
- `directFetchBridge.ts` 中 `deepseek-v4-flash` grep = 0

### B 本会话真跑测
- `tsc --noEmit` 绿
- `cargo check --workspace` 绿
- 新增单测（各 Agent 自带）：
  - `pickDefaultModelSelection` 无 providerId → `null`
  - 两供应商同名模型各自独立命中
  - `normalizeProtocol` 旧名 → 规范名；乱写 → `undefined`
  - `YAML_PROTOCOL_SELECT_OPTIONS` 的 value 集合 ≡ `PROTOCOLS`
  - `ModelRef::key()` 归一化
  - 迁移未知厂商 → baseUrl 为空（非 OpenAI）
  - baseUrl 含 `anthropic` 但 protocol 声明 `openai/chat` → 决议为 `openai/chat`

---

## 主控收口

收齐全部终态 → 抽检 A/B 栏 → 运行 `tsc --noEmit` + `cargo check` → `git commit --only <本轮文件>` → 写 `execution/α-轮次报告.md`。
