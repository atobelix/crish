# S1 · 真源契约与 IPC 同构

> **指示文档**：交给实现 Agent 的任务书。本维只闭合「读/写 yaml 在类型与 IPC 上诚实同构」，让前端镜像不再自毁。  
> **权威工作区**：`docs/model-config-product-chain/`  
> **纪律**：`.agents/LOGIC_PLAN_NO_RETREAT.md`；`00-调度与执行纪律.md` L1–L6、L12；三原则（思考拍平字典、cacheRead 独立单价、预填库不是运行真源）。  
> **规划模式**：纯逻辑。只规定依赖边、任务单元、文件域、验收断言。禁止工期、人员、业务优先级排序。问题同权。  
> **本轮禁止**：改产品源码以外的「顺手重构」；提交 git；改 Composer；把 S2 保存按钮接线当成本维完成句。

---

## 0. 效果锁（用户可感知增量）

用户用 **YAML 弹窗**保存一棵含 `thinking` / `modalities` / `pricing` / `protocol` / `baseUrl` / `apiKey` 的 v2 树（或后续 S2 经 `updateModel` 写出同一棵树）之后：

1. 磁盘 `~/.conex/models.yaml` 仍是那棵树（字段不被拍平残杀）。
2. 下一次 `workbench_read_models_yaml` 的 **`providers`** 含上述字段。
3. `modelsCatalogStore` 镜像的 `tree.providers[id].models[]` **读回同样字段**，而不是 `convertFlatModelsToTree` 用扁平 `models` + 硬编码厂商 URL 重建出的残树。

无 UI 时，本维也必须能用 IPC 往返证明同一不变量（轮次 α：契约闭合）。

---

## 1. 已锁定真源裁决（本维必须落实，不得另起炉灶）

| 锁 | 本维动作 | 禁止 |
| --- | --- | --- |
| L1 | 物理真源仍是 `~/.conex/models.yaml`（v2 `providers` 树） | 把 LS / `catalog.json` / 预填 JSON 当读/写真源 |
| L2 | 前端唯一镜像仍是 `modelsCatalogStore`（内存树 = yaml 投影） | 本维去改 Picker/Composer 去读 LS |
| L3 | 生产只 invoke 已注册三命令 `workbench_{read,validate,save}_models_yaml` | 生产再打 `models_yaml_read/write/reload`；用扁平重建生产树 |
| L4 | 读 IPC **消费 Rust 已返回的 `providers`** | 找不存在的 `wire.tree`；从扁平 `models` 丢字段后冒充树 |
| L5 | `live_catalog()` 去掉 `dead_code`，成为运行时**唯一 getter** | 热路径继续把 `bundled_catalog()` / `catalog.json` 当 yaml 真源 |
| L6 | `EngineProviderConfig` **具备**并从 live 快照**灌入** `thinking_map` / `thinking_format` / `vendor` / `protocol` 槽位 | 本维把 `request_options` 的 `..Default::default()` 改掉冒充 S4 已接通（调用点属 S4，本维只规定契约并灌槽） |
| L10 | 未提交 `modelCatalogTypes.ts` 复制树 **丢弃，不提交，不作为实现面** | 在旧岛补类型 |
| L12 | 完成 = 往返树字段不丢 + 命令诚实 + live getter 可被后续热路径调用 | 「函数已导出 / 单测绿 / 命令已注册」关账 |

三原则（不得削弱）：

1. `thinking` = TitleCase → wire 字符串字典；缺省则非思考。
2. `cacheRead` / `cacheWrite` 为独立绝对单价，禁止「输入价 × 折扣」。
3. 预填库只在用户键入模型 ID 时建议填充，不是运行时真源。

---

## 2. 当前断层（对照代码，禁止凭记忆）

### 2.1 注册面：三命令已同名，幽灵名从未登记

已注册且四端同名（这是**唯一合法** IPC 面）：

| 命令 | Rust 符号 | `command_manifest.rs` | `tauri-command-registry.ts` | `commandManifest.ts` | `main.rs` |
| --- | --- | --- | --- | --- | --- |
| `workbench_read_models_yaml` | `models_yaml.rs:492-494` | `:92` | `:80-82` | `:76` | `:201-203` |
| `workbench_validate_models_yaml` | `:497-501` | `:93` | `:85-87` | `:77` | `:205-207` |
| `workbench_save_models_yaml` | `:504-506` | `:94` | `:90-92` | `:78` | `:209-211` |

**不存在** `models_yaml_read` / `models_yaml_write` / `models_yaml_reload`（全仓 Rust 注册与两份 manifest 零命中）。

YAML 弹窗已经直打真命令：`YamlConfigEditorModal.tsx:105` 读、`:144` 校验、`:257` 保存；missing 禁存。**Store 主路径没有走这条诚实路。**

### 2.2 Rust DTO：有 `providers`，没有 `tree`；扁平 `models` 是残肢

`ReadModelsYamlResult`（`models_yaml.rs:217-231`）字段：

`path` / `content` / `models` / `template` / `seeded` / `parse_error` / `version` / `providers`

`SaveModelsYamlResult`（`:245-251`）同样带 `models` + `providers`，**没有 `tree`。**

v2 树上 `ModelsYamlModelV2`（`:142-165`）**有** `thinking` / `modalities` / `pricing` / `protocol` / `compat`。  
`ModelsYamlProviderV2`（`:169-184`）**有** `base_url` / `api_key` / `headers` / `protocol` / `models`。

拍平循环（`:317-337`）写入的 `ModelsYamlModel`（`:87-106`）**只有** `model/vendor/displayName/contextWindow/maxOutputTokens/protocol/capabilities/pricing`，**丢掉** `thinking` / `modalities` / `compat` / 供应商级 `baseUrl` / `apiKey` / `headers`。

解析失败（`:437-440`）：`models=[]`，`providers=None`，`parse_error=Some`，**不覆盖磁盘**。空文件诚实态（`:376-382`）才是 `providers: Some({})`。

### 2.3 前端 IPC：先打幽灵命令，再丢掉 `providers`，用手拼树自毁

`modelsCatalogIpc.ts`：

- 文件头把幽灵名写成「权威对接」（`:4-6`）。
- `readModelsYamlIpc`（`:82-150`）：先 `invokeTyped('models_yaml_read')`（`:84`）；missing 才打 `workbench_read_models_yaml`（`:116`，还是 `any`）。
- 成功时找 `res.data.tree`（`:96`）——Rust **无此字段**。
- 否则 `convertFlatModelsToTree(res.data.models)`（`:101-107`、`:133`）。
- `convertFlatModelsToTree`（`:25-75`）：不拷 `thinking` / `modalities` / `apiKey` / `headers`；`baseUrl` 按 vendor 字符串硬编码 openai/anthropic/deepseek，其余落到 `https://api.openai.com/v1`（`:35-42`）；协议缺省 `openai/chat`（`:43`）。
- 全仓 TS **零**读取 `wire.providers`。
- `writeModelsYamlIpc`（`:251-286`）：先打未注册的 `models_yaml_write` + `{ tree }`；missing 才 `serializeModelsYamlTree` + `workbench_save_models_yaml`。`serializeModelsYamlTree`（`:156-245`）其实会写出 thinking/modalities/apiKey——**写比读完整**，所以「读残树再写回」会物理残杀磁盘。
- `reloadModelsYamlIpc`（`:291-299`）打 `models_yaml_reload`；Rust 无实现、无 `models-yaml-reloaded` emit。监听器（`:347-362`）是死接线。

`ReadModelsYamlWire`（`modelsCatalogTypes.ts:226-241`）把载荷注释成「Rust 命令 `models_yaml_read`」，字段是 `tree` / `rawYaml` / 可选 `models`，**没有 `providers` / `template`**。与 `ReadModelsYamlResult` 不同构。

### 2.4 镜像 fail-open：失败当成空配置

`modelsCatalogStore.ts:173-189`：`readModelsYamlIpc` 失败时把 `tree` 写成 `{ version: 2, providers: {} }`，**不**把 `loaded` 打回 `false`（spread 保留旧值）。成功后再强制重载失败 → `loaded===true` 且目录为空。随后 `updateTree` / `updateModel` 会把空树写盘。

成功分支（`:192-196`）只认 `result.data.tree`，不认 `providers`。

`updateModel`（`modelsCatalogActions.ts:144-181` + Store `:277-278`）纯函数本身会 spread 保留 patch 字段；**生产 UI 零调用**（问题 2，属 S2）。本维必须让这条写 IPC **具备不丢字段的能力**，但不把设置保存按钮接线算本维交付。

### 2.5 类型双轨

| 轨 | 路径 | 问题 |
| --- | --- | --- |
| 内核树契约 | `crates/agent-provider/src/models/catalog_types.rs` `UnifiedModelsConfig` / `ProviderSpec` / `ModelSpec` | 协议字面量 `google/generate-content`（`:110` alias `google/interactions`）；`thinking: Option<IndexMap<String,String>>`；`modalities: {input, output}`；`pricing.input/output/cache_read/cache_write`。`ProviderSpec` **无** `headers`。`ModelSpec.display_name/context_window/max_output_tokens` 非 Option，与用户 yaml 缺省字段冲突。 |
| 壳层 yaml DTO | `models_yaml.rs` 再定义一套 `ModelsYaml*` | `thinking`/`modalities` 是 `serde_yaml::Value`（`:156-160`）；`ModelsYamlProtocol`（`:29-38`）**无** `google/interactions` alias。 |
| 前端 SSOT | `modelsCatalogTypes.ts` | 协议联合含内核名 + 旧名 `google/interactions`（`:11-16`）；`contextLength` 别名（`:137`）；pricing 同时留 `input` 与 `inputPerMTok`（`:110-116`）。 |
| 未提交复制 | `modelCatalogTypes.ts:142-345` | 再复制一棵树；`ModelProtocol` **只有** `google/interactions`、无 `google/generate-content`（`:147-152`）。L10：**丢弃**。 |

### 2.6 `live_catalog` 花瓶；yaml→目录投影丢模态形状

`protocol.rs:35-53`：`LIVE_CATALOG` + `live_catalog()` 标 `#[allow(dead_code)]`（`:39-40`）。`reload_live_catalog`（`:56-61`）在 `models_yaml.rs:479` 保存后写入，**无人读取**。

热路径仍 `bundled_catalog()`（`catalog.json`）：

- `protocol.rs:114` `effective_protocol`
- `engine_provider.rs:145-148` `request_options` → `build_cache_policy`
- `thinking.rs:87` `validate_reasoning_effort`
- `engine_build.rs:945,1038`

`EngineProviderConfig`（`engine_provider.rs:64-77`）只有 `base_url/api_key/model/endpoint/stream/extra`，**无** vendor/protocol/thinking_map/thinking_format。`request_options`（`:154-162`）`..Default::default()` 把 `thinking_map` 清成 `None`——本维不改该调用点的装配逻辑（S4），但必须让配置结构能装 yaml 字典。

`ModelCatalog::load_user_catalog_or_default`（`catalog.rs:392-398`）失败回空目录（fail-open）。`parse_yaml_to_catalog`（`:810-929`）另写一套 `DynamicYaml*`：

- `DynamicYamlModalities`（`:752-759`）是 `{image,video,audio: bool}`，**不是** yaml/TS 的 `{input: string[], output: string[]}`。条目已有 `input_modalities` / `output_modalities`（`:224-227`），投影却不填。
- `DynamicYamlProvider` 不读 `compat` / `headers`。
- `thinking` 经 `parse_thinking_value`（`:773-808`）可保留 TitleCase 键——这点要钉死，禁止再做一次小写归一当「兼容」。

### 2.7 测试桩打未注册命令

`modelsCatalogStore.test.ts` 读路径已 mock `workbench_read_models_yaml`（`:90` 等），但载荷是扁平 `models`、无 `providers`、无 thinking（`:53-81`）。写路径主 mock `models_yaml_write`（`:202,331,366,389,451,529,567`）。`probeIncremental.test.ts:88` 同。生产打不中该名。

---

## 3. 本维效果、边界、非目标

### 3.1 本维交付（效果）

1. **类型同构**：Rust `catalog_types.rs` ↔ 前端**一份** `modelsCatalogTypes.ts`。磁盘/IPC 树字段名与内核树一致（camelCase）。禁止第三份树契约。
2. **IPC 同构**：读命令返回的 `providers` 就是前端 Store 的树；写命令吃这棵树序列化出的 yaml 文本；往返不丢 §0 字段。
3. **命令诚实**：生产与测试只打已注册三命令。幽灵名从生产路径、类型注释、测试桩消失。
4. **镜像不自毁**：禁止用扁平 `models` 重建生产树；禁止读失败把空 `providers` 当成已加载真源再写回磁盘。
5. **live getter**：`live_catalog()` 可被后续热路径调用；去掉 `dead_code`；成为运行时唯一入口。`EngineProviderConfig` 增加槽位并在加载时从 live 快照灌入（能灌则灌，不能唯一命中则保持 `None`，不猜前缀）。
6. **updateModel/write 不丢字段**：`serializeModelsYamlTree` + `workbench_save_models_yaml` 是唯一写路径；patch `thinking/modalities/pricing/protocol` 后读回仍在。S2 只需要把 UI 保存接到已有 `updateModel`。

### 3.2 边界（本维必须碰到、但不是下游维的活）

- YAML 弹窗已走真命令：本维不得把它改去打幽灵名。弹窗保存后已调用 `ensureModelsCatalogLoaded(true)`（`YamlConfigEditorModal.tsx:275`）——这是本维用户侧主验收路径。
- `modelsCatalogStore.updateTree` / `updateModel` 的写盘函数在本维改诚实；**设置抽屉保存按钮**仍属 S2。
- `request_options` / `effective_protocol` / `thinking.rs` / `engine_build.rs` 里对 `bundled_catalog()` 的遗留调用：**本维列出契约，不在那些调用点改方言装配**（文件域归 S4/S5）。本维要让他们**有唯一 getter 可换**。

### 3.3 非目标（禁止本维去做、也禁止把它们写成「本维完成」）

| 非目标 | 归属 |
| --- | --- |
| 设置抽屉「保存」从 LS 改到 yaml；`useModelConfigSession` / `modelsIpcHelpers` / `ModelConfigPanel*` | S2 |
| Composer / Picker / `slashSendPreflight` / `modelVisionSupport` 改读 Store | S3 |
| `request_options` 停止 `Default`、四协议 builder 走 `assemble_thinking_dialect`、`ensure_content_modalities` 挂 stream | S4 |
| `PricingEngine` 进 session-loop；删 JS 浮点账本 | S5 |
| 四态输入 / token / sticky / 思考区物理卸载样式 | S6 |
| 物理删除 `modelCatalog*`、LS 写路径、陪葬测试 | S7 |
| 注册新命令 `models_yaml_*` 来「兼容」旧名 | 永久禁止（L3） |
| 把 `defaultThinkingLevel` 写进 yaml | 禁止。思考真源是拍平字典；缺省 = 非思考 |
| 改 Composer | 本维文件域禁止 |
| 提交未提交的 `modelCatalogTypes.ts` 扩字段 | L10 |

---

## 4. 与 S2 / S3 / S4 的接口契约（本维输出保证）

后维不得在本维契约未闭合时发明第二真源。本维闭合后，下游**只依赖**下列结构，不依赖扁平 `models`、不依赖 `wire.tree`、不依赖幽灵命令。

### 4.1 磁盘 / IPC 树（S2 写入、S3 读取的同一形状）

```text
ModelsYamlTree / UnifiedModelsConfig
  version: 2
  providers: {
    [providerId]: {
      displayName: string
      baseUrl: string
      protocol: ProtocolKind          // 序列化字面量见 §4.3
      apiKey?: string                 // 允许 $ENV 引用
      headers?: { [k: string]: string }
      compat?: { thinkingFormat?: ThinkingFormat, ... }
      models: [{
        id: string
        displayName?: string
        protocol?: ProtocolKind       // 缺省继承供应商
        contextWindow?: number        // 磁盘键名只有 contextWindow
        maxOutputTokens?: number
        thinking?: { [TitleCase]: wire }   // 缺省 = 非思考
        modalities?: { input: string[], output: string[] }
        pricing?: {
          currency: 'USD' | 'CNY'
          input?: number
          output?: number
          cacheRead?: number          // 独立绝对单价
          cacheWrite?: number
          perImage?: number
        }
        compat?: ...
      }]
    }
  }
```

**写盘只许这一套键名。** 读边界允许一次性认旧键，写出必须归一：

| 旧键（只读边界） | 写出键（SSOT） |
| --- | --- |
| `google/interactions` | `google/generate-content` |
| `contextLength` | `contextWindow` |
| `inputPerMTok` / `input_per_m_tok` | `input` |
| `outputPerMTok` / `output_per_m_tok` | `output` |
| `cacheReadPerMTok` / `cache_read_per_m_tok` | `cacheRead` |
| `cacheWritePerMTok` / `cache_write_per_m_tok` | `cacheWrite` |
| `perImageCost` | `perImage` |
| thinkingFormat `google` / `qwen_enable_thinking` | 内核 `gemini` / `qwen` |

禁止运行时永久双字段（问题 17）。禁止前端再复制 `modelCatalogTypes.ts` 里的树。

### 4.2 读 IPC 载荷（前端必须按此消费）

Rust `ReadModelsYamlResult` 保持（可删前端误用，不可改名糊弄）：

- `path` / `content` / `template` / `seeded` / `parseError` / `version`
- **`providers`**：`Option<Map<String, ProviderSpec>>`（与 §4.1 同构；解析失败为 `None`）
- `models`：若暂时保留，类型与注释必须标明 **lossy 投影，禁止生产消费**。实现 Agent 删除前端 `ReadModelsYamlWire.models` / `.tree` 更干净。

前端 `readModelsYamlIpc` 成功当且仅当：命令命中 **且** `parseError` 为空 **且** `providers` 为对象（含诚实空 `{}`）。  
树 = `{ version: 2, providers }`。**禁止** `wire.tree || convertFlat(...)`。

写 IPC：`serializeModelsYamlTree(tree)` → `workbench_save_models_yaml({ content })`。返回的 `providers` 可作镜像校验，但不得在写失败时用空对象覆盖。

校验：YAML 弹窗继续 `workbench_validate_models_yaml`；Store 写路径依赖 Rust save 入口的 fail-closed 解析（`models_yaml.rs:473-474`）。本维不必新造第四命令。

### 4.3 协议字面量（S4 出站键）

内核 `ProtocolKind`（`catalog_types.rs:99-112`）为唯一运行时枚举：

- `openai/chat`
- `openai/responses`
- `anthropic/messages`
- `google/generate-content`（serde alias 可读 `google/interactions`，**写出只有规范名**）

`ModelsYamlProtocol` 必须与此同构（补 alias 或直接改用 `ProtocolKind`，禁止两套枚举行为分叉）。

### 4.4 交给 S2 的写能力

S2 可以假设：

```text
await modelsCatalogStore.ensureLoaded()
await modelsCatalogStore.updateModel(providerId, modelId, {
  thinking, modalities, pricing, protocol, ...
})
await modelsCatalogStore.updateProvider(providerId, { baseUrl, apiKey, protocol, ... })
```

效果：磁盘 yaml 出现同等字段；失败则 Store 回滚到上一份**成功加载**的树，磁盘不被残树覆盖。  
S2 禁止再 `upsertModelMeta` / `crish_model_meta_v1`。本维不改那些文件。

### 4.5 交给 S3 的读能力

S3 可以假设 `modelsCatalogStore.getState().tree` 在 `loaded===true && lastError===null` 时与磁盘 v2 树同构，选择器能读到 thinking 字典与 `modalities.input`。  
本维不改 Composer；S3 把读点从 LS 迁到该镜像。

### 4.6 交给 S4 的 live 调用契约（本维必须写成可调用，即使不改 request_options）

**唯一 getter**（改名禁止玩花样；现有 `live_catalog` 零调用方可改返回值）：

```text
live_catalog() -> Arc<LiveModels>

LiveModels:
  tree: UnifiedModelsConfig          // 第一公民 = yaml 树
  catalog: ModelCatalog              // 由 tree 投影，供既有 lookup/价格 API
  find(provider_id, model_id) -> Option<&ModelSpec>
```

加载规则：

- 读 `~/.conex/models.yaml`，与 IPC **同一套** v2 解析（禁止 `DynamicYamlModalities` 那种第二解析器继续当生产投影）。
- 文件缺失：诚实空树 + 空目录（与默认模板 `providers: {}` 一致），**不是** `catalog.json`。
- 解析失败：getter **不得**假装「用户配置了空 providers」；保持上一份成功快照，或显式错误态。禁止 `load_user_catalog_or_default` 把坏文件吞成空目录还继续当热路径真源（`catalog.rs:392-398` 这条 fail-open 必须收口：坏 yaml ≠ 空配置）。

投影到 `ModelCatalogEntry` 的最低保证（S4/S5 可继续用旧 lookup）：

| yaml 树字段 | 条目字段（不得丢） |
| --- | --- |
| `thinking` TitleCase→wire | `thinking_tiers` **保留 TitleCase 键**；另可供 `EngineProviderConfig.thinking_map` |
| `modalities.input/output` | `input_modalities` / `output_modalities`；`supports_vision` 仅作派生位 |
| `protocol` | 不得塞进注释所写的 `mode: chat\|responses\|both` 里糊弄；S4 读 `ModelSpec.protocol` / `ProviderSpec.protocol` |
| `pricing.input/output/cacheRead/cacheWrite` | `input_price` 等四价，禁止用 input 折扣填 cache |
| `compat.thinkingFormat` | `thinking_format` |
| 供应商 `baseUrl`/`apiKey` | 供 `EngineProviderConfig` 在能唯一命中时对照，不在本维改 HTTP 客户端装配 |

`bundled_catalog()`：仅内置 `catalog.json`（测试、预填、历史 lookup）。**热路径新代码禁止再调用。** 本维不改 `request_options` / `effective_protocol` / `engine_build.rs` 的既有调用点，但必须在 `protocol.rs` 用注释 + 本文件契约写明：S4/S5 替换为 `live_catalog()`。

`EngineProviderConfig` 本维增量字段（`engine_provider.rs` 结构体，约 `:64-77`）：

```text
vendor: Option<String>
protocol: Option<ProtocolKind>
thinking_map: Option<IndexMap<String, String>>
thinking_format: Option<ThinkingFormat>
provider_id: Option<String>
```

`load_provider_endpoint`（`:81-98`）必须调用 `live_catalog()` 灌槽：

- 配置面尚无 `providerId`（问题 15，S3 主修）：仅当 `tree` 中模型 id **唯一**命中时灌入；多命中或零命中 → 槽位 `None`（fail-closed，禁止前缀表猜厂商）。
- **不**在本维修改 `request_options` 的 `..Default::default()`。S4 的不变量是：一旦槽位为 `Some`，`request_options` 必须复制它们，禁止再 Default 清空。

`reload_live_catalog`：save 成功后继续调用；内容必须重解析 **tree + 投影**，不是只刷新空 `ModelCatalog`。

---

## 5. 任务单元（逻辑序，不是重要性序）

依赖边：先有同构类型 → 才能诚实 IPC → 才能不自毁镜像 → live getter 才有正确投影可给 S4。

### U1 · 类型同构（单份树契约）

**做：**

- `catalog_types.rs`：`ProviderSpec` 补磁盘需要的可选 `headers`；`ModelSpec` 的 `display_name` / `context_window` / `max_output_tokens` 改为 `Option`（缺省不发明 128K）；协议 alias 已存在则保持。
- `models_yaml.rs`：v2 树节点停止用无类型 `serde_yaml::Value` 承载 thinking/modalities；改为 `IndexMap<String,String>` / `ModalitiesSpec`（直接复用 `catalog_types`，禁止再复制一套 struct 行为分叉）。`ModelsYamlProtocol` 与 `ProtocolKind` 合并或 alias。
- `modelsCatalogTypes.ts`：成为前端**唯一**树契约。`ReadModelsYamlWire` 与 Rust DTO 字段对齐（`providers`、`content`、`template`、`parseError`）。删除或停止导出生产用的 `tree?` 作为「Rust 已返回」的谎言。
- 协议联合：运行时以 `google/generate-content` 为准；旧名只在读边界归一。
- pricing / 窗口：类型上可以暂时留旧别名作输入，但注释写明「只读边界」；`serializeModelsYamlTree` 只写 SSOT 键。

**禁止：** 编辑并以 `modelCatalogTypes.ts` 的树当 SSOT；把树再复制第三份。

### U2 · 读 IPC 消费 `providers`

**做：**

- `readModelsYamlIpc`：只 invoke `workbench_read_models_yaml`。`missing` → `{ ok:false, kind:'MISSING' }`，**禁止**再 fallback 到另一个名字，也禁止 fallback 到空树当成功。
- 有 `parseError` → `{ ok:false, kind:'PARSE_ERROR' }`，不构造生产树。
- 成功 → `tree = { version: 2, providers: wire.providers ?? 拒绝 }`。`providers` 缺失且无 parseError → 视为协议漂移，fail-closed，**禁止** `convertFlatModelsToTree`。
- **删除生产路径上的 `convertFlatModelsToTree`**（函数可删；禁止留一条「兼容 v1」给 Store 走）。v1 扁平升级已在 Rust `ConfigMigrationManager::ensure_migrated`（`models_yaml.rs:406-428`）。

**YAML 弹窗：** 继续直打三命令；若 `ReadModelsYamlWire` 字段改名，只改类型以匹配 `content/template/parseError/path`，不得改成打幽灵命令。

### U3 · 写 IPC 不丢字段 + 拒绝残树落盘

**做：**

- `writeModelsYamlIpc`：删除 `models_yaml_write` 优先分支。唯一路径：`serializeModelsYamlTree` → `workbench_save_models_yaml({ content })`。
- `serializeModelsYamlTree`：已能写 thinking/modalities/apiKey（`:181-229`）；本维钉死写出键为 §4.1，归一协议旧名，pricing 只写 `input/output/cacheRead/cacheWrite`。
- `reloadModelsYamlIpc`：删除幽灵实现。热重载改为写成功后由调用方 `ensureLoaded(true)`（弹窗已如此）。删除只听不发的 `models-yaml-reloaded` 监听，或在 save 命令用 `AppHandle` **真的 emit**——禁止半截死接线。
- `updateModel` 纯函数保持 spread；加测试：patch thinking/modalities/pricing 后 `serialize` 文本含这些键。

### U4 · Store 镜像 fail-closed

**做：**

- `ensureLoaded` 失败：`loaded = false`；**不得**用空 `providers` 覆盖上一份成功快照；`lastError` 区分 `IPC_DISCONNECTED` / `PARSE_FAILURE`。
- 成功：只从 `providers` 建索引。
- `updateTree` / `updateModel` / `updateProvider`：若从未成功加载（`loaded!==true`），拒绝写盘（防止「命令缺失 → 空树 → 保存」覆盖用户文件）。
- 诚实空配置（解析成功且 `providers: {}`）允许写——那是用户清空，不是 IPC 失败。

### U5 · live_catalog 唯一 getter + EngineProviderConfig 槽位

**做：**

- 去掉 `protocol.rs:39` `#[allow(dead_code)]`。
- `LIVE_CATALOG` 持有 §4.6 `LiveModels`（tree + 投影 catalog）。
- `reload_live_catalog` 与 IPC save 共用同一解析。
- 修正 `parse_yaml_to_catalog`（或废止它、改为从 `UnifiedModelsConfig` 投影）：`modalities` 按 `{input, output}` 填 `input_modalities`/`output_modalities`；thinking 保留 TitleCase；读 `compat`。
- `EngineProviderConfig` 增槽；`load_provider_endpoint` 调用 `live_catalog()` 按 §4.6 灌入。
- `bundled_catalog` 保留给内置表；在 `live_catalog` 文档注释写明热路径唯一入口。

**禁止本维：** 改 `request_options` 的 Default 展开去「顺便接通」出站方言；改 `build_chat.rs` / `dialect.rs` / Composer。

### U6 · 测试改写（本维测钉契约，不是 S7 全删旧岛）

**做：**

- Rust：`models_yaml.rs` 增加往返用例——yaml 含 thinking/modalities/pricing/protocol/baseUrl/apiKey，`read_models_yaml_at` 的 **`providers`** 字段等值，且 `models` 扁平即使仍在也不得被测试当成 thinking 真源。
- Rust：损坏文件读回 `parse_error`，磁盘内容不变（已有 `:582-590`，保持）。
- Rust：`live_catalog`/`from_yaml_str` 填入 TitleCase thinking 与 `input_modalities`。
- TS：`readModelsYamlIpc` / Store 测试 mock **仅** `workbench_*`；载荷给 `providers` 树，断言镜像含 thinking/modalities/baseUrl/apiKey。
- TS：禁止 mock `models_yaml_write` 当成功写盘（`modelsCatalogStore.test.ts`、`probeIncremental.test.ts`）。
- TS：命令 missing → `loaded===false` → `updateModel` 不得调用 save。
- 静态：生产 `apps/crish-desktop` 对 `models_yaml_read|models_yaml_write|models_yaml_reload` 零命中（测试字符串也尽量不把幽灵名当主路径）。

---

## 6. 文件域与禁止改哪些

### 6.1 本维可写（实现期互斥；同文件内 U1→U6 串行）

| 文件 | 改什么 |
| --- | --- |
| `crates/agent-provider/src/models/catalog_types.rs` | 树契约补全；与 yaml 缺省字段对齐 |
| `crates/agent-provider/src/models/catalog.rs` | yaml→`ModelCatalog` 投影（modalities 形状、thinking 键、compat）；收口 `load_user_catalog_or_default` 坏文件 ≠ 空配置 |
| `apps/agent-workbench/src-tauri/src/models_yaml.rs` | DTO 与 `catalog_types` 同构；flatten 不得再当生产树 |
| `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs` | `live_catalog` 唯一 getter / `LiveModels` / reload |
| `apps/agent-workbench/src-tauri/src/engine_provider.rs` | **仅** `EngineProviderConfig` 字段 + `load_provider_endpoint` 灌槽；不改 `request_options` 方言装配 |
| `apps/crish-desktop/src/api/modelsCatalogTypes.ts` | 唯一前端树 + 与 DTO 对齐的 Wire 类型 |
| `apps/crish-desktop/src/api/modelsCatalogIpc.ts` | 三命令诚实读写；删扁平重建与幽灵优先 |
| `apps/crish-desktop/src/api/modelsCatalogStore.ts` | `ensureLoaded` 消费 `providers`；fail-closed `loaded` |
| `apps/crish-desktop/src/api/modelsCatalogStore.test.ts` | mock 真命令 + providers 树往返 |
| `apps/crish-desktop/src/api/probeIncremental.test.ts` | 写盘 mock 改为 `workbench_save_models_yaml` |
| `YamlConfigEditorModal.tsx` | **仅当** Wire 类型字段改名导致编译失败时做类型对齐；不得改命令名 |

命令注册三文件（`command_manifest.rs` / `tauri-command-registry.ts` / `main.rs` / `commandManifest.ts`）：**三命令已在，本维不要加幽灵名。** 只有在改 save 签名（例如加 `AppHandle` emit）时才动 `main.rs` 注册点。

### 6.2 禁止本维修改

- `apps/crish-desktop/src/components/composer/**` 以及一切 Composer / `TiptapEditorField` / 附件入口
- `useChatModelPicker.ts` / `ModelBadgePickerMenu*` / `ComposerFusedTrigger.tsx` / `slashSendPreflight.ts` / `modelVisionSupport.ts`（S3）
- `useModelConfigSession.ts` / `modelsIpcHelpers.ts` / `ModelConfigPanel*`（S2 保存按钮）
- `modelCatalog.ts` / `modelCatalogMeta.ts` / `modelCatalogTypes.ts`（L10 丢弃面；S7 删除）
- `build_chat.rs` / `build_responses.rs` / `build_anthropic*` / `build_gemini*` / `dialect.rs` / `messages_content.rs`（S4）
- `engine_provider.rs` 的 `request_options` 函数体 Default 展开、`stream.rs`（S4）
- `engine_build.rs` / session-loop 计费（S5）
- `settings-models/**` CSS、`tokens.css`（S6）
- 不得 `git commit` / `reset` / `restore`

---

## 7. 验收断言（用户侧或端到端；禁止「已导出」当完成）

### 7.1 IPC 往返树字段不丢失

构造最小 v2 yaml（可走 YAML 弹窗或测试写临时文件）：

```yaml
version: 2
providers:
  acme:
    displayName: Acme
    baseUrl: https://example.invalid/v1
    protocol: openai/chat
    apiKey: $ACME_API_KEY
    models:
      - id: acme-think
        displayName: Acme Think
        contextWindow: 128000
        thinking:
          Low: low
          High: high
        modalities:
          input: [text, image]
          output: [text]
        pricing:
          currency: USD
          input: 1
          output: 2
          cacheRead: 0.1
          cacheWrite: 0.2
```

断言：

1. `workbench_save_models_yaml` 后磁盘文本含 `thinking` / `modalities` / `cacheRead` / `baseUrl` / `apiKey` / `protocol`。
2. `workbench_read_models_yaml` 的 JSON **`providers.acme.models[0].thinking.Low === "low"`**，且 `modalities.input` 含 `image`，且 `baseUrl` 仍是 `https://example.invalid/v1`（不是 openai 硬编码）。
3. `ensureModelsCatalogLoaded(true)` 后 `selectModel('acme','acme-think')` 能读到同一 thinking / modalities / pricing.cacheRead。
4. `updateModel('acme','acme-think',{ thinking: { Low: 'low', Max: 'max' } })` 再读，磁盘与镜像均含 `Max`。

用户侧：打开 YAML 弹窗 → 粘贴上述内容 → 保存 → 关开弹窗再读，文本字段仍在；设置列表/Store 不是残树。本维**不**要求设置抽屉那颗保存钮改接线。

### 7.2 前端禁止生产调用未注册命令

- `apps/crish-desktop/src` 生产代码（不含故意断言「未注册」的测试）对 `models_yaml_read` / `models_yaml_write` / `models_yaml_reload` 零 `invokeTyped`。
- `isRegisteredCommand('workbench_read_models_yaml') === true`（三命令皆然）。
- `isRegisteredCommand('models_yaml_read') === false`，且没有生产回退逻辑依赖这个 false。

### 7.3 live_catalog 可被后续热路径调用

- `live_catalog` 无 `#[allow(dead_code)]`；至少 `load_provider_endpoint` 调用它（编译期即非死代码）。
- 写入 §7.1 yaml 后 `reload_live_catalog()`，`live_catalog().find("acme","acme-think")` 得到 thinking 字典与 `modalities.input` 含 image。
- 文档/注释写明：S4 必须把 `request_options` 的 catalog 参数从 `bundled_catalog()` 换成 `live_catalog()`，并复制 `EngineProviderConfig.thinking_map`；本维不改该调用点不得宣称出站已通。

### 7.4 fail-closed（命令缺失、解析失败不得空 providers 覆盖用户文件）

| 场景 | 磁盘 | 内存镜像 | 写 |
| --- | --- | --- | --- |
| 三命令 missing | 不变 | `loaded=false`；保留上一份成功树（若有） | `updateModel`/`updateTree` 拒绝 |
| yaml 语法损坏 | 不变（Rust 已保证） | 不把空树标为已加载合法配置 | 拒绝 |
| 合法空 `providers: {}` | 可以是空 | `loaded=true`，诚实空 | 允许 |
| save 校验失败 | 不变（`models_yaml.rs:647-656` 已有） | 回滚 last-known-good | 不落盘 |

禁止：missing 时先 `convertFlatModelsToTree([])` 再 `writeModelsYamlIpc`。

---

## 8. 对应问题全集编号

本维**闭合**（验收 §7 通过即这些问题不得再以「IPC/类型」形态出现）：

| # | 问题 | 本维闭合面 |
| --- | --- | --- |
| 4 | IPC 先打未注册命令；扁平重建丢 thinking/modalities；硬编码厂商 URL | U2/U3 删除幽灵优先与 `convertFlatModelsToTree` |
| 5 | Rust DTO 有 `providers` 无 `tree`，前端读错字段 | U1/U2 消费 `providers` |
| 6 | `live_catalog` dead_code；热路径 `bundled_catalog` | U5：getter 复活并成为唯一入口；遗留调用点列入 S4 契约而非假装已换 |
| 16 | `google/interactions` vs `google/generate-content` | U1 内核字面量 + 读边界单向归一 |
| 17 | `contextWindow` vs `contextLength`；`input` vs `input_per_m_tok` 永久双字段 | U1/U3 写出单键；读边界一次性认旧名 |
| 23 | 测试桩打未注册命令（本维涉及 Store/IPC 的那部分） | U6 |

本维**使能、不关账**（下游维仍必须做）：

| # | 问题 | 本维只保证 |
| --- | --- | --- |
| 2 | `updateModel` 生产 UI 零调用 | 写 IPC 不丢字段；UI 接线是 S2 |
| 7 | `EngineProviderConfig` 无协议/字典；`request_options` Default 清空 | 槽位 + load 灌入；Default 清除是 S4 |
| 3 / 10 | 未提交旧轨；`modelCatalogTypes` 复制树 | L10 丢弃；本维不提交、不以它为 SSOT |
| 15 | `findCatalogModel` 不传 providerId | load 多命中 fail-closed；S3 修调用方 |
| 1、8–14、18–22、24 | 保存按钮、出站方言、计费、Composer、样式、旧轨删除 | S2–S7 |

问题 6 的「热路径仍调用 `bundled_catalog`」在 S4/S5 换调用点之前**不得**写成产品链已通；本维只保证调用契约与 getter 可用。

---

## 9. 防回潮（本维之后必须钉死的反例）

实现完成后，下列 grep 应为 **0 命中**（生产路径；测试里若出现必须是「断言禁止」而不是主 mock 名）：

```text
models_yaml_read
models_yaml_write
models_yaml_reload
convertFlatModelsToTree
wire.tree
```

`apps/crish-desktop/src/api/modelsCatalogIpc.ts` 不得再出现 `https://api.openai.com/v1` 作为 vendor 猜测默认。

`protocol.rs` 的 `live_catalog` 不得重新标 `#[allow(dead_code)]`。

`modelsCatalogTypes.ts` 的 `ReadModelsYamlWire` 不得把幽灵命令名写进注释冒充 Rust 契约。

新增测试不得 `mockTauriCommand('models_yaml_write', ...)` 充当写盘成功。

禁止新增「兼容层」：第三份 `*CatalogTypes`、前端再 flatten、注册第四个 yaml 命令「更干净」。路径合法排序键是效果完整度 → 正确性 → 可验证性 → 与 L1–L6 一致 → 结构干净，不是再包一层适配器。

---

## 10. 实现 Agent 自检（对照 LOGIC_PLAN_NO_RETREAT）

- 未把「YAML 弹窗能打开」当成完成；完成句是往返树字段还在。
- 未把 S2 保存按钮、S4 HTTP 体划进本维，也未把它们从战役效果里删掉。
- 未用「先扁平再补字段」打补丁；根因是读错 `providers` 与幽灵命令。
- 未把不确定写成不可能；类型同构是改字段对齐，不是新框架。
- 未引入工期、P0、MVP 砍项用语。
- 坏 yaml / 命令缺失不得写成空配置成功。
- 不提交、不回撤、不改 Composer。
