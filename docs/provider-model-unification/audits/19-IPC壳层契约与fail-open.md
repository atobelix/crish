# 19 · IPC 壳层契约与 fail-open 审计（models.yaml 真源）

> **文档编号**：`19-IPC-Shell-Contract`
> **工作区归属**：`docs/provider-model-unification/audits/`
> **审计角色**：IPC & Shell Contract Auditor（只读；对齐 `docs/agent-roles/review/review.md` §8 跨语言边界）
> **审计日期**：2026-09-08
> **本会话验证口径**：源码形状审计；**未**跑 `cargo test` / `vitest` / 真机 IPC。下文「测试会红」均为对照断言与注册面的静态漂移，不当作本会话实测绿灯/红灯。
> **审查对象**：`models.yaml` 三命令（读/校验/保存）在 Rust 注册面、TS registry、前端 invoke 三者是否同名；Wave 4（`f98b7f62`）自称「IPC 降级清除」是否属实；保存/读取是否诚实 fail-closed；会话运行时消费 live yaml 还是编译期目录。

---

## 目录

- [一、给主控的结论](#一给主控的结论)
- [二、命令对照表（Rust 符号 / registry / 前端 invoke）](#二命令对照表rust-符号--registry--前端-invoke)
  - [2.1 真源三命令（workbench_*）](#21-真源三命令workbench_)
  - [2.2 幽灵三命令（models_yaml_*）——UI 有条无 IPC](#22-幽灵三命令models_yaml_ui-有条无-ipc)
  - [2.3 并行旧轨（catalog_get / catalog_refresh）](#23-并行旧轨catalog_get--catalog_refresh)
  - [2.4 计数断言 125→131（ddbf6d6e）是否仍匹配](#24-计数断言-125131ddbf6d6e是否仍匹配)
- [三、Wave 4「清除 IPC 降级」逐条拆穿](#三wave-4清除-ipc-降级逐条拆穿)
- [四、fail-open 点清单](#四fail-open-点清单)
  - [4.1 读路径：幽灵命令 + 拍平重建 + 丢弃 providers](#41-读路径幽灵命令--拍平重建--丢弃-providers)
  - [4.2 读失败把空 providers 当成合法配置](#42-读失败把空-providers-当成合法配置)
  - [4.3 写路径：幽灵优先；测试桩 ≠ 生产命令](#43-写路径幽灵优先测试桩--生产命令)
  - [4.4 保存失败：Rust 与 Store 回滚诚实，UI 主保存入口未走该路径](#44-保存失败rust-与-store-回滚诚实ui-主保存入口未走该路径)
  - [4.5 旧轨 catalog_* 与 LocalStorage 显式 fail-open](#45-旧轨-catalog_-与-localstorage-显式-fail-open)
  - [4.6 crate 解析器 fail-open 与死代码热重载](#46-crate-解析器-fail-open-与死代码热重载)
- [五、会话运行时：live yaml 还是编译期目录](#五会话运行时live-yaml-还是编译期目录)
- [六、分层违规（壳层塞定价 / 方言）](#六分层违规壳层塞定价--方言)
- [七、旧轨 modelCatalogIpc 是否仍走另一套命令](#七旧轨-modelcatalogipc-是否仍走另一套命令)
- [八、敏感信息：apiKey 是否进日志 / 前端错误](#八敏感信息apikey-是否进日志--前端错误)
- [九、invoke 类型是否 any](#九invoke-类型是否-any)
- [十、诚实 fail-closed 存量（不要误杀）](#十诚实-fail-closed-存量不要误杀)
- [十一、给主控的收敛建议（只列证据，不关账）](#十一给主控的收敛建议只列证据不关账)

---

## 一、给主控的结论

**裁决：models.yaml IPC/壳层并未诚实 fail-closed。** Wave 4（`f98b7f62`，提交说明含「IPC降级清除」，对该文件 `+151/-44`）是**假关**：生产读/写主路径仍先 invoke 三支从未登记的幽灵命令，缺失后再回退 `workbench_*`，并把 Rust 已解析的 v2 `providers` 树丢掉、用手拼拍平表重建。设置页主保存按钮仍写 LocalStorage 旧轨。会话出站协议/思考白名单/上下文窗口仍读编译期 `catalog.json`，`reload_live_catalog()` 写入的是带 `#[allow(dead_code)]` 的死锁存。

| 检查项（任务书） | 裁决 | 一句话 |
| --- | --- | --- |
| 三命令 Rust / registry / 前端 invoke 同名 | **部分成立** | `workbench_{read,validate,save}_models_yaml` 四端同名已接线；**生产 Store 不打这三名作主路径** |
| 计数 125→131（`ddbf6d6e`）仍匹配 | **只锁 workbench 注册表** | `tauri-command-registry.test.ts` 仍断言 131；`command_manifest.rs` / `BUILTIN_COMMAND_MANIFEST` / `main.rs` 已是 **142** |
| Wave 4 清除 IPC 降级 | **假关** | 幽灵命令优先 + `convertFlatModelsToTree` 仍在；`modelsCatalogIpc.ts` 当前 363 行 |
| 保存失败阻断 UI 且保留旧文件 | **Rust 层成立 / 产品层半连通** | 原子写 + Store 回滚诚实；YAML 编辑器 fail-closed；设置抽屉保存走 LS，不碰 yaml |
| 读失败空 providers 覆盖用户数据 | **成立（内存镜像）** | `ensureLoaded` 失败把 tree 置空且不把 `loaded` 打回 false |
| 壳层塞引擎逻辑 | **成立** | 壳侧重定义 yaml schema；前端 IPC 手写厂商 URL/协议别名；选择器 JS 浮点算费 |
| 旧 `modelCatalogIpc` 另一套命令 | **成立且仍是启动路径** | `catalog_get` / `catalog_refresh`；`bootstrap-full.ts` 仍调它 |
| apiKey 进日志 | **未发现 tracing 明文** | 全量 YAML（含 key）经 IPC `content` 回前端编辑器；错误 `JSON.stringify` 有夹带风险 |
| invoke 类型 any | **成立** | `invokeTyped<any>`、`any[]`、`Record<string, any>`、`as any` |

对齐 §8：**UI 有条无 IPC**（幽灵 `models_yaml_*` + 从未发射的 `models-yaml-reloaded`）、**命令未注册**、**fail-open 自毁**（拍平重建丢掉 apiKey/thinking/modalities，下一次 Store 写回会残杀磁盘树）、**错误被吞**（旧轨 `catalog_*` 失败降级静态表；crate `load_user_catalog_or_default` 失败回空目录）。

---

## 二、命令对照表（Rust 符号 / registry / 前端 invoke）

### 2.1 真源三命令（workbench_*）

四端名称字节一致，且 `registered=true` / `status: implemented`。这是**唯一合法**的 models.yaml IPC 面。

| 前端 invoke 名 | Rust 符号 | `command_manifest.rs` | `commandManifest.ts` | `tauri-command-registry.ts` | `main.rs` `command_registry!` |
| --- | --- | --- | --- | --- | --- |
| `workbench_read_models_yaml` | `models_yaml::workbench_read_models_yaml` `apps/agent-workbench/src-tauri/src/models_yaml.rs:492-494` | `:92` `registered=true` | `:76` | `:80-82` `implemented` | `:199-203` |
| `workbench_validate_models_yaml` | `models_yaml::workbench_validate_models_yaml` `:497-501` | `:93` | `:77` | `:85-87` | `:204-207` |
| `workbench_save_models_yaml` | `models_yaml::workbench_save_models_yaml` `:504-506` | `:94` | `:78` | `:90-92` | `:208-211` |

**直接打这三名的生产调用方（诚实路径）**：

- `YamlConfigEditorModal.tsx:105` 读、`:144` 校验、`:257` 保存。missing / error → `serviceError`，`canSave` 为 false（`:313`）。
- `modelsCatalogIpc.ts` **仅作为幽灵命令 missing 之后的回退**（读 `:116`、写 `:270-273`），不是第一公民。
- `modelsCatalogIpc.ts` **从不调用** `workbench_validate_models_yaml`。校验只发生在 Rust `save_models_yaml_at` 入口（`models_yaml.rs:473-474`）和 YAML 编辑器。

### 2.2 幽灵三命令（models_yaml_*）——UI 有条无 IPC

| 前端 invoke 名 | Rust 注册 | manifest / registry | 生产行为 |
| --- | --- | --- | --- |
| `models_yaml_read` | **无** | **无** | `modelsCatalogIpc.ts:84` 每次 `ensureLoaded` 先打；missing 再回退 |
| `models_yaml_write` | **无** | **无** | `modelsCatalogIpc.ts:255` 每次 `updateTree` 先打；单测主 mock 名 |
| `models_yaml_reload` | **无** | **无** | `modelsCatalogIpc.ts:292`；无 Rust 实现、无事件发射方 |

文件头仍把幽灵名写成「权威对接」（`modelsCatalogIpc.ts:4-6`）。类型注释同样撒谎：`modelsCatalogTypes.ts:226`「Rust 命令 `models_yaml_read` 的 Wire 响应载荷」——Rust 实际命令是 `workbench_read_models_yaml`，载荷字段是 `providers` 不是 `tree`。

这是 §8 **「UI 有条无 IPC」** 的标准形态：Store 主路径、测试桩、类型文档都当这三名存在；`isRegisteredCommand('models_yaml_read')` 为 false（不在 `BUILTIN_COMMAND_MANIFEST`）。`invokeTyped` **不经** `resolveTauriCommand` 白名单（`tauriInvoke.ts:170-185` 直接 `invoke`），所以幽灵名会真实打到 Tauri，被 `isMissingCommandMessage` 收成 `status: 'missing'`，再走回退。

事件 `models-yaml-reloaded`：全仓 **仅** `modelsCatalogIpc.ts:352` 监听，Rust **零** `emit`。热重载监听器是死接线。

### 2.3 并行旧轨（catalog_get / catalog_refresh）

| 前端 invoke 名 | Rust 符号 | 用途 | 与 models.yaml 关系 |
| --- | --- | --- | --- |
| `catalog_get` | `catalog_commands::catalog_get` `catalog_commands.rs:43-50` | 启动快照 → `pricingStore` | 读 **Tauri state 里的 `ModelCatalog::bundled()`**（`main.rs:990-994`），**不是** `~/.conex/models.yaml` |
| `catalog_refresh` | `catalog_commands::catalog_refresh` `:58-71` | 扫描结果 upsert 内存目录 | 只改进程内 bundled 克隆，**不写** yaml |

前端：`modelCatalogIpc.ts:107` / `:236`；启动：`bootstrap-full.ts:14-19` 经 `modelCatalog.ts:67` 再导出。

两套「模型目录」命令面并存，**不是同一命令**。

### 2.4 计数断言 125→131（ddbf6d6e）是否仍匹配

提交 `ddbf6d6e`（2026-09-04）说明原文：

> `fix(commands): tauri-command-registry 与 Rust 注册面同步——补齐 models_yaml 三命令与 usage 五命令登记，清退 computer_estop 残留，计数断言 125→131（15/15 通过）`

**三命令本身仍在该注册表中**（`tauri-command-registry.ts:80-92`），与 `command_manifest.rs:92-94`、`main.rs:199-211` 同名。

**131 这个数字不再等于真源清单：**

| 面 | 条数 | 锁点 |
| --- | --- | --- |
| `tauri-command-registry.ts` + 其测试 | **131** | `tauri-command-registry.test.ts:161,170,255` 仍写「126 → 131」「含 models_yaml 三命令与 usage 五命令」 |
| `command_manifest.rs` 测试 | **142** | `command_manifest.rs:322-327` `assert_eq!(total, 142)`；`:449` 同数 |
| `BUILTIN_COMMAND_MANIFEST` | **142** | `commandManifest.test.ts:80-81`；注释 `:76-79` 写明 126→131→135→142 |
| `main.rs` `command_registry!` | **142**（含 `auth_*` 7 + `note_document_{list,create,rename,delete}` 4） | 与 manifest 对齐；**比 workbench 注册表多 11 条** |

`command_manifest.rs:63` 文件头注释仍写「命令清单（127 条…）」；`:72` 停在「core_jsonl_append 退役后 126」。**注释 126/127、测试 142、workbench 注册表 131 三套数字并存。**

`tauri-command-registry.test.ts:151-161` 还断言 `extractRegisteredTauriCommands(main.rs) === wired` 且 `registered.size === 131`。若提取器吃全 `command_registry!` 元组，该测试与 142 注册面**静态互斥**（本会话未跑测，标为源码形状风险）。

`tauri-command-registry.ts` **缺**的 11 条（131+11=142）：

- `auth_login` / `auth_logout` / `auth_get_session` / `auth_refresh_token` / `auth_list_devices` / `auth_revoke_device` / `auth_get_relay_ticket`
- `note_document_list` / `note_document_create` / `note_document_rename` / `note_document_delete`

与本专项三命令无直接冲突，但说明 **ddbf6d6e 的 131 已不是全仓注册面真源**；后续 auth/笔记命令加进了 manifest + `main.rs`，**未回写** workbench `REGISTERED_TAURI_COMMANDS`。

---

## 三、Wave 4「清除 IPC 降级」逐条拆穿

提交 `f98b7f62`（BATCH-UNIFY-04）stat：`modelsCatalogIpc.ts | 151 ++++++++++++++++++-------`（+107 净行）。任务书「151 行大改」即此。当前工作区该文件 **363 行**。

Wave 4 **确实做了**：写路径不再手拼 `models:\n- model:` 扁平字符串，改为 `yaml` 库 `yamlStringify` 输出 v2 树（`serializeModelsYamlTree`，`:156-245`）。注释 `:249` 自称「绝不擅自将 v2 降级为残疾 v1」。

Wave 4 **没有清除**、且当前仍在的降级：

1. **幽灵命令优先**（`:83-84`、`:254-255`、`:292`）——生产环境每次必 miss 一次。
2. **`convertFlatModelsToTree`**（`:25-76`）——读回退仍用手拼树；内嵌 openai/anthropic/deepseek **硬编码 URL**（`:35-42`）。
3. **忽略 Rust `providers` 字段**——全仓 TS `wire.providers` / `data.providers` **零命中**。
4. **`invokeTyped<any>`**（`:116`）。
5. **`models_yaml_reload` 死命令**（`:292-299`）。

因此「清除 IPC 降级」是提交说明抬关，不是源码事实。

---

## 四、fail-open 点清单

`modelsCatalogIpc.ts` **没有**业务 `catch` 把失败变成空目录；唯一 `catch` 在防抖回调（`:337-339`，只 log 回调异常）。fail-open 不在空 catch，而在 **missing 回退、拍平重建、Store 置空、旧轨降级**。

### 4.1 读路径：幽灵命令 + 拍平重建 + 丢弃 providers

`readModelsYamlIpc`（`modelsCatalogIpc.ts:82-150`）逐步：

1. `invokeTyped('models_yaml_read')` —— 命令不存在 → `missing`。
2. `invokeTyped<any>('workbench_read_models_yaml')` —— 这是真命令。
3. 若 `wire.parseError` → `{ ok: false, kind: 'PARSE_ERROR' }`（这一步 **fail-closed**）。
4. `const tree = wire.tree || convertFlatModelsToTree(wire.models || [])`（`:133`）。

Rust `ReadModelsYamlResult`（`models_yaml.rs:217-231`）字段是：

`path / content / models / template / seeded / parse_error / version / providers`

**没有 `tree`。** serde camelCase 后前端拿到的是 `providers`（v2 树，含 `apiKey` / `headers` / `thinking` / `modalities`）和拍平后的 `models`（`ModelsYamlModel`，**无** thinking / modalities / apiKey / baseUrl / headers）。

前端只用拍平 `models` 重建树。`convertFlatModelsToTree` 后果：

- `apiKey` / `apiKeyRef` / `headers` / `compat` / `proxyUrl` / `thinking` / `modalities` **全部丢失**；
- `baseUrl` 按 vendor 字符串猜（未知厂商 → `https://api.openai.com/v1`，`:35-42`）；
- `protocol as any` 缺省 `openai/chat`（`:43`）。

若随后 `modelsCatalogStore.updateTree` 把这棵残树 `writeModelsYamlIpc` 回去，**磁盘 v2 真源被残杀**——这是 fail-open 自毁，不是「兼容」。

`ensureLoaded` 成功分支（`modelsCatalogStore.ts:192-196`）同样：`result.data.tree || { version: 2, providers: {} }`，**不读 IPC 的 `providers`**。即使将来幽灵命令碰巧返回 rust 形状，只要没有 `tree` 包装，仍会落到空对象或拍平重建。

### 4.2 读失败把空 providers 当成合法配置

`modelsCatalogStore.ts:172-189`：

```172:189:apps/crish-desktop/src/api/modelsCatalogStore.ts
    inflightLoadPromise = (async () => {
      const result = await readModelsYamlIpc();
      if (!result.ok) {
        state = {
          ...state,
          tree: { version: 2, providers: {} },
          providerMap: new Map(),
          modelIndex: new Map(),
          globalModelIndex: new Map(),
          version: state.version + 1,
          lastError: { ... },
        };
        notify();
        emitUiEvent('models-catalog-changed', undefined);
        return false;
      }
```

- 失败时 **把 tree 写成空 providers**（覆盖内存里已有的用户树）。
- **不**设置 `loaded: false`（spread 保留旧值）。成功加载后再 `ensureLoaded(true)` 失败 → `loaded === true` 且目录为空。
- 仍 `notify` + `models-catalog-changed`：UI 会把空目录当当前配置渲染。
- `listCatalogModels()`（`modelsCatalogQuery.ts:127-137`）在 accessor 已注入时对空 map 返回 `[]`，与「尚未加载」无法区分。

Rust 读损坏文件（`models_yaml.rs:437-440`、测试 `:582-590`）返回 `parse_error` + `models=[]` + `providers=None`，**不覆盖磁盘**。前端 PARSE_ERROR 路径把镜像清空，磁盘仍在——内存 overlay 仍是「空目录冒充合法配置」。

Rust 空文件合法态（`models_yaml.rs:376-382`）是诚实空 `providers: {}`（默认模板 `models.default.yaml:1-2` 即此）。问题不是空文件合法，而是 **IPC/解析失败也变成同一空树**。

### 4.3 写路径：幽灵优先；测试桩 ≠ 生产命令

`writeModelsYamlIpc`（`:251-286`）：

1. `models_yaml_write` + `{ tree }` —— 未注册。`status === 'error'` 则 **不回退**（`:263-265`，相对诚实）。`missing` 才回退。
2. 生产：`serializeModelsYamlTree(tree)` + `workbench_save_models_yaml({ content })`。

`serializeModelsYamlTree` 会写入 `apiKey` / `thinking` / `modalities`（`:181-229`）。**写比读完整。** 危险在于读已截肢后再写。

单测主路径 mock 的是幽灵名 `models_yaml_write`（`modelsCatalogStore.test.ts:202,331,366,389,451,529,538,567`；`probeIncremental.test.ts:88`）。生产根本打不中该命令。回滚用例同时 error 了两名（`:538-539`）才覆盖生产回退。**测桩把未注册命令当成成功写盘**（§7 测只快乐路径 / 过度 mock）。

`debounceSaveModelsYaml`（`:311-342`）300ms 合并；回调 `catch` 只 log，不改变写结果。

### 4.4 保存失败：Rust 与 Store 回滚诚实，UI 主保存入口未走该路径

**Rust fail-closed（成立）**

- `save_models_yaml_at`（`models_yaml.rs:472-476`）：先 `parse_models_yaml`，失败 `diagnostic_to_core_error`，**不写盘**。
- 再 `conex_fs::atomic_write_file`（临时文件 → `.bak` → 替换，`crates/conex-fs/src/atomic_write.rs:189-194`）。
- 单测钉死非法保存不破坏原文件（`models_yaml.rs:647-656`）。

**Store fail-closed（成立，仅该入口）**

- `updateTree`（`modelsCatalogStore.ts:229-258`）：先乐观更新，写失败回滚 `prevSnapshot` + `WRITE_REJECTED`。

**YAML 编辑器 fail-closed（成立）**

- missing 禁存（`YamlConfigEditorModal.tsx:261-263`）；error 解析行号、不改 `originalCode`（`:265-269`）；`canSave` 绑定 `!syntaxError && !serviceError`（`:313`）。

**产品设置抽屉（半连通 / 错轨）**

- `applyMetaForModel`（`modelsIpcHelpers.ts:66-177`）调用 `setModelDisplayName` / `setModelCapability` / `setModelPricing` / `upsertPrice` —— **LocalStorage 旧轨**（`modelCatalog` / `pricingStore`），**零** `writeModelsYamlIpc`。
- 调用方：`useModelConfigSession.ts:186`、`useModelProfilesState.ts:320`、`useModelProviderActions.ts:99`。用户点设置页「保存」**不会**因 yaml IPC 失败而阻断，因为根本没打 yaml 保存命令。

§8「UI 有条无 IPC」在这里是：**有保存按钮，IPC 打的不是真源命令。**

### 4.5 旧轨 catalog_* 与 LocalStorage 显式 fail-open

`modelCatalogIpc.ts` 把 fail-open 写成契约：

| 函数 | 失败行为 | 证据 |
| --- | --- | --- |
| `uploadScannedModels` | missing/error **不阻塞扫描**；`errorStore` info + 空 catch ignore | `:96-146` |
| `fetchCatalogSnapshot` | 失败 / entries 空 → **定价回退静态表**，返回 false，恒不抛 | `:226-291`；启动 `bootstrap-full.ts:14-19` 依赖此降级 |
| `scanProviderModels` / `testProviderModel` | catch 折叠为 `{ ok: false }` | `:66-70`、`:317-321` |

空 `catch { /* ignore */ }` 出现 4 次（`:124-126`、`:143-145`、`:250-252`、`:265-267`、`:287-289`）—— errorStore 自身失败再吞。

`listAvailablePickerModels`（`:344-352`）读 `loadProfiles()`（LS）+ `getModelMeta`（LS），**不读** `modelsCatalogStore`。

### 4.6 crate 解析器 fail-open 与死代码热重载

`ModelCatalog::load_user_catalog_or_default`（`crates/agent-provider/src/models/catalog.rs:392-397`）：任何失败 `unwrap_or_else` → `Self::empty()` + `tracing::warn`。这是目录层 fail-open。

`parse_yaml_to_catalog`（`:820-823`）对空 model id **`continue` 跳过**；壳层 `models_yaml.rs:300-307` 对同一情况 **return Err**。双解析器语义不一致。

`reload_live_catalog`（`protocol.rs:56-61`）：写锁 `if let Ok` —— **poison 时静默不更新**。且 `live_catalog` 标了 `#[allow(dead_code)]`（`:39`）。

保存成功后 `save_models_yaml_at` 调用 `reload_live_catalog()`（`models_yaml.rs:479`）——刷新的是无人读取的锁。

---

## 五、会话运行时：live yaml 还是编译期目录

**结论：会话出站读编译期 `catalog.json`，不读 `~/.conex/models.yaml`。**

| 消费点 | 实际目录 | 证据 |
| --- | --- | --- |
| 协议路由 `effective_protocol` | `bundled_catalog()` | `protocol.rs:112-114` |
| Responses 支持 / 上下文窗口 | `bundled_catalog()` | `:178`、`:189` |
| 请求 cache policy | `bundled_catalog()` | `engine_provider.rs:145-148` |
| 思考档位白名单 `validate_reasoning_effort` | `bundled_catalog()` | `thinking.rs:86-91` |
| TTL / `engine_build.rs` | `bundled_catalog()` | grep 命中 `:945`、`:1038` |
| `catalog_get` Tauri state | `ModelCatalog::bundled()` | `main.rs:990-994` |
| `live_catalog()` / `reload_live_catalog()` | 读 yaml，但 **零生产调用方**（除 save 后刷新死锁存） | `protocol.rs:34-61`；`live_catalog` `#[allow(dead_code)]` |

`bundled()`（`catalog.rs:350-356`）= `include_str!("catalog.json")` 编译期打包。注释 `:65-67` 自己写「T-24 壳侧挂 Arc 后此处可换为运行时实例」——state 挂了 bundled，**没有**换成 yaml。

因此：设置页改 yaml → `workbench_save` 落盘 → `reload_live_catalog` 空转 → **下一轮对话协议/思考/窗口仍按 catalog.json**。这是跨语言边界的最大半连通：写路径连通磁盘，读路径（会话）不连通。

`headers.rs` 不读目录，只按 `WireProtocol` 组 Bearer / x-api-key。方言选择在 `effective_protocol` ← bundled。

---

## 六、分层违规（壳层塞定价 / 方言）

review.md §1「壳层业务逻辑含量」+ 本任务第 5 条。

| 位置 | 违规 | 证据 |
| --- | --- | --- |
| Tauri 壳 `models_yaml.rs:26-202` | 完整 yaml schema（协议枚举、定价 v1/v2、capabilities、拍平）与 crate `catalog.rs` `parse_yaml_to_catalog` **双份解析** | 壳层应用 serde 结构；crate 用另一套 `DynamicYamlRoot` |
| `convertFlatModelsToTree` | 前端 IPC 层硬编码厂商 URL + 默认协议 | `modelsCatalogIpc.ts:35-43` |
| `serializeModelsYamlTree` | 前端做 `google/interactions` → `google/generate-content` 方言归一 | `:161-170` |
| `modelsCatalogQuery.ts:79-83` | 反向映射 `google/generate-content` → `google/interactions` | 查询门面擅自改协议字面 |
| `modelsCatalogSelectors.ts:65-107` `selectEstimatedCost` | **JS 浮点四维算费**（含 tiers）在前端 Store 选择器；crate `PricingEngine` 不在此路径 | 生产 UI 调用仅测试文件命中；仍是壳/前端定价逻辑 |
| `selectEffectiveContextWindow` | 缺窗口 **发明 128_000** | `modelsCatalogSelectors.ts:47-53`（与「消灭 128K 假上限」叙事相反） |
| `selectEffectiveProtocol` | 缺省 `openai/chat` | `:37-45` |
| `engine_provider` 思考/协议 | 壳适配器消费 **bundled** 而非 yaml `thinking` 拍平字典 | `thinking.rs:86-91` |
| `modelsIpcHelpers.ts:121-175` | 设置保存把价格写入 `pricingStore`（LS），并 `findCatalogModel` 预填 | 定价双轨 |

壳层 `models_yaml.rs` 作为 IPC DTO 可以有镜像类型；违规点是 **第二套语义解析器 + 前端再手写厂商方言/URL/算费**，而会话执行又不消费这套 DTO。

---

## 七、旧轨 modelCatalogIpc 是否仍走另一套命令

**是。且启动路径仍在。**

| 项 | 旧轨 `modelCatalogIpc.ts` | 新轨 `modelsCatalogIpc.ts` |
| --- | --- | --- |
| 命令 | `catalog_get` / `catalog_refresh` / `provider_probe_*` | 幽灵 `models_yaml_*` → 回退 `workbench_*` |
| 真源 | bundled `catalog.json` + LS profiles/meta | 声称 `~/.conex/models.yaml` |
| 启动 | `bootstrap-full.ts:18-19` `fetchCatalogSnapshot()` | 设置页 `ensureModelsCatalogLoaded()`（`ModelsSettingsTab.tsx:193`） |
| fail 策略 | 文档化 fail-open（静态表 / 不阻塞扫描） | 部分三态，但 missing 回退 + 空树 overlay |
| git | `git status` 曾标 `M`；**内容 hash 与 `HEAD` 相同**（`6a6d8c6d…`），属 racy/stat 脏，**无未提交内容差** | 已入库 `f98b7f62` |

`modelCatalog.ts:62-73` 把旧轨函数再导出；`thinkingGear.ts:200` 注释写明与 `catalog_get` 共用 IPC。Picker 列表（`listAvailablePickerModels`）继续 LS。

旧轨未提交内容改动：**无**。双轨是已提交状态，不是工作区漂移。

---

## 八、敏感信息：apiKey 是否进日志 / 前端错误

| 通道 | 是否含 apiKey | 说明 |
| --- | --- | --- |
| `ModelsYamlProviderV2.api_key` | 字段存在 | `models_yaml.rs:177` |
| `workbench_read` 的 `content` | **是（全文 YAML）** | 编辑器需要原文；经 IPC 进 WebView |
| `serializeModelsYamlTree` | 有则写入 | `modelsCatalogIpc.ts:228-229` |
| `convertFlatModelsToTree` | **丢失**（非泄露，是残杀） | 拍平模型无 key |
| `tracing` in `models_yaml.rs` | **未见 key** | `:412-417` info 只打 backup/providers/models 计数；`:423-427` warn 打 `error` + `path` |
| `formatInvokeError` / `extractErrorKind` | **有夹带风险** | `tauriInvoke.ts:41-54` 对 object `JSON.stringify(err)`；若 CoreError detail 含 yaml 片段可能带 key。当前诊断消息是 serde 行号+字段名（`models_yaml.rs:387-397`），**未**把全文塞进错误 |
| `console.error` 防抖回调 | 只 log `err` | `:338` |
| `console.info` 热重载 | 无载荷 | `:354` |
| `headers.rs` Authorization | 运行时用 key，无 log | `:49` |

未发现 `tracing` / `console` 明文打印 apiKey。真正暴露面是 **IPC 把整份 yaml（含 key）交给前端**——编辑器合法，但任何把 `content` / `tree` 丢进 logger 或 errorStore 的后续改动都会泄密。当前 `ModelsCatalogError.message` 走 IPC `res.message` / parse 诊断，不走 content。

---

## 九、invoke 类型是否 any

| 位置 | 形态 |
| --- | --- |
| `modelsCatalogIpc.ts:25` | `convertFlatModelsToTree(flatList: any[])` |
| `:43` | `(item.protocol as any) \|\| 'openai/chat'` |
| `:116` | `invokeTyped<any>('workbench_read_models_yaml', {})` |
| `:157` | `Record<string, any>` |
| `:172` | `Record<string, any>` |
| `:270` | `invokeTyped<{ path: string; models?: any[] }>` |
| `:350` | `window as any` |
| `:360` | `unlisten: any` |
| `modelsCatalogTypes.ts:240` | `models?: any[]` |
| `tauriInvoke.ts:177` | `(await invoke(cmd, args)) as T` —— 无运行时校验，泛参默认 `unknown` |

`YamlConfigEditorModal` 对三命令使用具名 interface（`:41-54`、`:105`、`:144`、`:257`），是对照组。Store 主路径反而 `any`。

`invokeTyped` 本身区分 ok/missing/error（`tauriInvoke.ts:170-185`），**不是**旧的 `T | null` 折叠。问题是调用方用 `any` 丢掉 `providers` 契约，让错误形状通过编译。

---

## 十、诚实 fail-closed 存量（不要误杀）

下列路径是诚实的，收敛时应保留而不是重写：

1. **YAML 编辑器三命令直调 + missing 禁存**（`YamlConfigEditorModal.tsx:10,105-170,252-313`）。
2. **Rust 先校验再原子写，非法内容不碰原文件**（`models_yaml.rs:472-476,647-656`）。
3. **路径不收前端参数**（`models_yaml.rs:6-8,255-265`），防路径注入。
4. **读损坏文件返回 content + parse_error，不播种覆盖**（`:437-440,582-590`）。
5. **`updateTree` 写失败回滚 Last-Known-Good**（`modelsCatalogStore.ts:229-258`；测试 `:526-561`）。
6. **v1 `ModelsYamlModel` `deny_unknown_fields`**（`:87`）；注意 v2 `ModelsYamlModelV2` / `UnifiedModelsYamlFile` **没有** deny，未知字段（如前端写的 `enabled`）静默丢失——这是另一处弱 fail-open，但是 rust 侧的。
7. **`invokeTyped` 三态**（已删除 `T | null` 折叠，注释 `tauriInvoke.ts:13-16` 对齐 §6）。

---

## 十一、给主控的收敛建议（只列证据，不关账）

删除裁决权在主控（review.md 文首）。下列是按证据排出的逻辑依赖，**不是**工期排序。

1. **斩断幽灵命令（§8 UI 有条无 IPC）**
   `modelsCatalogIpc.ts` 只 invoke `workbench_{read,validate,save}_models_yaml`。删除 `models_yaml_read/write/reload` 与 `models-yaml-reloaded` 死监听。类型注释改为真实命令名。单测 mock 改为 `workbench_save_models_yaml`（现在 mock 幽灵名会在删除后立刻红——这是要的）。

2. **读路径使用 Rust `providers`，删除 `convertFlatModelsToTree`**
   全仓 TS 零读取 `providers` 是数据残杀根因。映射 `ReadModelsYamlResult.providers` → `ModelsYamlTree`。拍平 `models` 仅作只读兼容门面，禁止再生成写回树。

3. **`ensureLoaded` 失败不得用空树覆盖已加载镜像**
   失败：保留 `prevSnapshot.tree`，`loaded` 维持，`lastError` 必填；首次失败 `loaded=false` 且 UI 走错误态，禁止 `listCatalogModels()` 把空当「用户没配供应商」。

4. **设置抽屉保存接到 `modelsCatalogStore.updateTree` / `workbench_save`**
   否则 YAML 编辑器是唯一真源写入口，主按钮仍 LS（`modelsIpcHelpers.ts`）。不关「设置保存」EL。

5. **会话执行改读 live yaml（或证明 bundled 为有意）**
   `effective_protocol` / `validate_reasoning_effort` / `effective_context_window` / `catalog_get` state 仍 `bundled()`。`reload_live_catalog` 在无人消费时是假热更新。二选一：接线 `live_catalog()` 并去掉 `#[allow(dead_code)]`；或删除 reload 以免假装连通。

6. **统一解析器**
   壳层 `parse_models_yaml` 与 crate `parse_yaml_to_catalog` 对空 id 一拒一跳。应只留 crate（或壳只做 IPC 包装）。`load_user_catalog_or_default` 的空目录回退与「损坏不得当合法空配置」冲突。

7. **注册表 131 vs 142**
   把 `REGISTERED_TAURI_COMMANDS` 补齐 auth 7 + note_document 4，测试改为 142；或明确 workbench 注册表降级为子集并停止断言等于 `main.rs` 全量。文件头「127 条」注释一并改，避免下一轮再按 131 关门。

8. **旧轨 `catalog_get` 启动降级**
   `bootstrap-full.ts` + `fetchCatalogSnapshot` 的静态表 fail-open 与 yaml SSOT 互斥。要么启动改 `ensureModelsCatalogLoaded` 且失败可见，要么文档承认定价仍走 bundled/静态表（当前注释写「Rust 目录真源」是撒谎）。

**不建议**：再加一层 `models_yaml_write` 新命令「与测试桩对齐」——那是把幽灵扶正，制造第四个名字。已有 `workbench_save_models_yaml` 收 `content: String`，树序列化放前端或放 Rust 都可以，但命令名必须停在已登记的三名。
