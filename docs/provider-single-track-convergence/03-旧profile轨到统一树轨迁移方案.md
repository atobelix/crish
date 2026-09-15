# 旧 profile 轨 → 统一树轨 迁移方案（03）

> 战役：`docs/provider-single-track-convergence/`
> 触发：`#10` 真实宿主 MCP 取证发现的**用户可见故障**（配置未迁移 / 切换活动模型失败 / 定价回退静态表）
> 状态：**方案已出，未动任何生产代码**；范围待用户裁决

---

## 一、症状与根因链（实证，逐跳可核）

用户侧症状：模型列表空、定价缺失、日志 `模型目录快照拉取跳过（missing），定价回退静态表`。

1. 应用启动 → `app/AppBootstrap.ts:180-182` 动态 import `../api/providerProfiles` 并拉起 `migrateLegacyProfiles()`；
2. → `api/provider-profiles/migrateLegacyProfiles.ts:231` 调 `configProfileApply({ profileId, apiKey })`；
3. → `api/provider-profiles/rustProfileStore.ts:102` 执行 `invokeTyped('config_profile_apply', …)` —— **该命令已退役**（`main.rs` 无注册、`command_manifest.rs` 无条目）；
4. → 必然 `missing` ⇒ **迁移失败** ⇒ 配置目录**不生成 `models.yaml`**（实测 `%APPDATA%/Crish/AgentWorkbench` 只有旧档案 `profile-config.json` / `provider-config.json` / `provider-direct-key.dpapi` / `secrets/`）；
5. → 启动时拉快照拿不到数据 → 日志 `模型目录快照拉取跳过（missing）`；
6. → 定价恒回退静态表。

---

## 二、旧轨残留全量清单

### 2.1 已退役但仍有调用的命令（D11 ⑤ 棘轮已登记，目标 = 0）

| 退役命令 | 调用点 | 用户可见影响 |
|---|---|---|
| `config_profile_apply` | `rustProfileStore.ts:102`（唯一封装）→ 经它触达 `migrateLegacyProfiles.ts:231` / `profileKeySecret.ts:107` / `profileStoreActivation.ts:59` / `:167` | **配置迁移失败 + 切换活动模型失败 + 密钥保存后的激活同步失败** |
| `catalog_get` | `modelCatalogIpc.ts:236`（启动定价快照）、`thinkingGear.ts:208` | 定价回退静态表；思考档位快照缺失 |
| `catalog_refresh` | `modelCatalogIpc.ts:107` | 扫描结果上送失败 |

**调用点分布的关键事实**：`config_profile_apply` 的 4 处调用**全部经同一个封装** `rustProfileStore.ts:102` —— 这是本方案能做到「单文件域、可独立合入」的前提。

### 2.2 旧轨真相源残留

- **`hasKey` 标记**：`provider-profiles/profileKeySecret.ts:63` 的 `saveProfiles(list)` 写本地 LS 档案，唯一目的是回写 `p.hasKey`（D8 岛内债务 16 处之一）。
- **旧档案文件**：`profile-config.json` / `provider-config.json`（实测存在于配置目录）。

### 2.3 新轨（统一单轨）已有能力

| 能力 | 命令 / 位置 | 证据 |
|---|---|---|
| 读树 | `workbench_read_models_yaml` | 返回 `ModelsCatalogSnapshot`（树 + `revision` + `credentialStates`） |
| 整树 CAS apply | `workbench_apply_models_config({ tree, expectedRevision })` → `ModelsSnapshot` | `apps/agent-workbench/src-tauri/src/models_yaml.rs:57-66` |
| 校验 | `workbench_validate_models_yaml` | `models_yaml.rs:83` 起 |
| 凭据槽 | `config_secret_set` / `_clear` / `_get` / `_has` / `_reveal` | `apps/agent-workbench/src-tauri/src/config/credentials.rs` |

---

## 三、目标态

「活动模型选择」= 统一树里的 `active_model` 字段；「密钥」= 统一树凭据槽（DPAPI，不出 webview）；「定价 / 思考快照」= 由统一树派生。旧档案退化为**只读迁移来源**，不再作为任何标记的真相源。

---

## 四、分期（每期独立可合入、可回滚、带特性开关）

### 期 1：`configProfileApply` 内部改走统一树（**签名不变，4 处调用点零改动**）

- **文件域**：`apps/crish-desktop/src/api/provider-profiles/rustProfileStore.ts`（唯一实现点）+ 新增单测文件。
- **做法**：保持 `configProfileApply(args): Promise<InvokeTypedResult<ConfigProfileApplyResult>>` 签名与返回形状；内部改为：
  1. 读树（`workbench_read_models_yaml`）拿 `tree` + `revision`；
  2. 按 `profileId` 在树中定位 provider（不存在则按旧档案字段构造一个最小 provider）；
  3. 把 `model` 写入该 provider 的 models（不存在则补），并设置 `tree.active_model = { providerId, modelId }`；
  4. `workbench_apply_models_config({ tree, expectedRevision: revision })`；
  5. **CAS 冲突** → 重读最新 `revision` 后有限重试（不忽略、不静默）；
  6. 返回脱敏状态（`ok` + `hasKey`/last4 语义对齐旧形状）。
- **特性开关**：新增前端开关（如 `localStorage['crish.apply-via-tree']`，缺省关）。**关** = 走旧命令（当前行为）；**开** = 走树。支持灰度与零代码回滚。
- **验收断言**：
  - 单测：apply 成功路径 / CAS 冲突重试成功 / 树读取失败显式降级（三态，正逆向对称）；
  - 真实宿主：配置目录**生成 `models.yaml`**；设置页切换活动模型成功；日志无 `engine_unavailable`。
- **回滚**：关开关即回旧路径。

### 期 2：定价 / 思考快照改走统一树派生

- **文件域**：`apps/crish-desktop/src/api/modelCatalogIpc.ts`（`fetchCatalogSnapshot` + 扫描上送）、`apps/crish-desktop/src/api/thinkingGear.ts`。
- **做法**：新增**纯转换函数**（树 → 定价面快照 `CatalogSnapshotWire` 形状）+ 单测；用 `workbench_read_models_yaml` 的结果喂给它，替换 `catalog_get` / `catalog_refresh` 调用。
- **验收断言**：`applyCatalogCacheSnapshot` 被调用且数据非空；日志无「快照拉取跳过（missing）」；转换函数单测覆盖缺字段 / 空树 / 多 provider。
- **回滚**：新旧路径并存，开关切换。

### 期 3：`hasKey` 真相源收敛（D8 路线 A）

- **文件域**：`provider-profiles/profileKeySecret.ts`（删 `saveProfiles` 调用）+ `hasKey` 消费面逐点迁移。
- **验收断言**：D8 岛内债务条数下降；`hasKey` 全部读 `credentialStates`。
- **回滚**：读优先统一树、LS 镜像仅作兜底（读侧保留）。

---

## 五、跨期不变量（不得违反）

1. **CAS 不弱化**：`workbench_apply_models_config` 的 `expectedRevision` 必须传真实 revision；冲突必须重试或显式失败，**禁止忽略**。
2. **凭据不出 webview**：明文 key 只经 `config_secret_set`；apply 路径不得携带明文。
3. **fail-closed**：树读取 / apply 失败 → 显式错误（沿用 `engine_unavailable`），**不得静默降级为「假装成功」**。
4. **测试资产只增不减**：新增断言不得替换既有断言；旧命令的负向断言（「退役命令零回潮」）保留在 D11 ⑤ 棘轮中。

---

## 六、风险与未解（实施前必须确认）

1. **映射规则**：旧 `profileId` 与统一树 `providerId` 是否同值？若不同，期 1 的「按 profileId 定位 provider」需要一张映射表，且影响迁移幂等性 —— **需在实施前确认**。
2. **旧档案一次性迁移**：`profile-config.json` → `models.yaml` 的搬迁是否并入期 1，还是另立期？**待裁决**。
3. **首次写入的 revision**：当前配置目录无 `models.yaml`，期 1 实施后首次 apply 的 `expectedRevision` 从何而来（空树 revision？空串？）——需以 `ModelsStore::apply` 的实现在实施前核对。
4. **开关的默认值**：期 1 合并时默认开还是关？默认关更安全（行为不变），默认开能立即修用户故障 —— **待裁决**。

---

## 七、续航锚点

- **当前状态**：方案已出，**未动任何生产代码**。
- **已完成**：根因链实证（`00-执行记录.md` 对应章节）；D11 ⑤ 棘轮登记 4 处调用；D8 失真登记更正。
- **进行中**：无。
- **阻塞**：待用户裁决范围（期 1 是否含旧档案一次性迁移）、开关默认值、映射规则确认。
- **下一步**：裁决后按期 1 实施（文件域单一，可独立合入、可零代码回滚）。
