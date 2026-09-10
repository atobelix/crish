# 轮次 α 派单（S1 真源契约与 IPC 同构）

## 1.1 问题识别

| 字段 | 值 |
| --- | --- |
| 轮次代号 | α |
| 对应维 | S1 |
| 本轮要对齐的 §3 动词 | 尚无「点保存」。闭合物理前提：读 IPC 消费 `providers`；往返树含 thinking/modalities/pricing/protocol/baseUrl/apiKey；`live_catalog().find` 可调用 |
| 上轮未闭合 | 无上轮。前置：八个未提交旧岛不提交、不作为实现面 |
| 依赖是否已满足 | 是（α 无前置实现轮） |
| 工作区风险 | `modelCatalog.ts` / `modelCatalogMeta.ts` / `modelCatalogTypes.ts` 仍有未提交 diff，禁止提交、禁止 restore |

## 1.2 任务分解

| 任务单元 ID | 来源 | 写集 | 禁动 | 本轮验收 |
| --- | --- | --- | --- | --- |
| S1-U1 | plans/01 §5 U1 | catalog_types.rs；catalog.rs；catalog_tests.rs；devil_cases_tests.rs / wire_integration.rs 仅结构体字面量 | models_yaml.rs；engine_provider.rs；前端 | ProviderSpec 有 headers；ModelSpec 窗口/名为 Option；yaml→条目保留 TitleCase thinking 与 input_modalities；坏文件 ≠ 空配置成功 |
| S1-U2U3 | plans/01 §5 U2 U3 | models_yaml.rs | catalog_types.rs 主体；前端 | DTO 复用 catalog_types；IPC `providers` 与树同构；flatten 标注 lossy；往返测钉 thinking.Low |
| S1-U5 | plans/01 §5 U5 | protocol.rs；engine_provider.rs（仅字段+load）；所有 `EngineProviderConfig {` 字面量文件仅补新字段 | request_options 方言装配；build_*.rs | live_catalog 无 dead_code；LiveModels.find 可调用；load 灌槽；不改 Default 清空 map |
| S1-U1TS-U2U3FE | plans/01 U1 前端 + U2 U3 | modelsCatalogTypes.ts；modelsCatalogIpc.ts；YamlConfigEditorModal.tsx 仅类型对齐 | Store；旧岛 modelCatalog* | 只 invoke workbench_*；删除 convertFlat 与幽灵名；serialize 只写 SSOT 键 |
| S1-U4-U6 | plans/01 U4 U6 | modelsCatalogStore.ts；modelsCatalogStore.test.ts；probeIncremental.test.ts | IPC 生产实现（可改测试 mock） | 失败 loaded=false 不覆盖成功快照；未加载拒绝写盘；测试 mock 仅 workbench_* + providers 树 |

## 1.3 Agent 分配

| Agent | 角色 | 任务单元 | 写集 |
| --- | --- | --- | --- |
| α-1 | 实现 | S1-U1 | `crates/agent-provider/src/models/catalog_types.rs`；`catalog.rs`；`catalog_tests.rs`；`crates/agent-provider/tests/devil_cases_tests.rs`；`wire_integration.rs`（仅补 ProviderSpec/ModelSpec 字段） |
| α-2 | 实现 | S1-U2U3 | `apps/agent-workbench/src-tauri/src/models_yaml.rs` |
| α-3 | 实现 | S1-U5 | `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs`；`engine_provider.rs`（结构体+load_provider_endpoint，禁止改 request_options 函数体装配逻辑）；`engine_provider_tests.rs`；`engine_tests.rs`；`core_run_commands_tests.rs`；`server/core_backend.rs`；`scripted_mock_server.rs` 仅补新字段 |
| α-4 | 实现 | S1-U1TS + U2 U3 前端 | `apps/crish-desktop/src/api/modelsCatalogTypes.ts`；`modelsCatalogIpc.ts`；必要时 `YamlConfigEditorModal.tsx` 类型对齐 |
| α-5 | 实现 | S1-U4 U6 | `apps/crish-desktop/src/api/modelsCatalogStore.ts`；`modelsCatalogStore.test.ts`；`probeIncremental.test.ts` |
| α-6 | 审计 | 抽检 S1 契约 | 只读；产出 `docs/model-config-product-chain/audits/α-执行位抽检.md`（实现收齐后再派） |

## 1.4 互斥表（本轮）

| 路径 | 所有者 |
| --- | --- |
| catalog_types.rs / catalog.rs / catalog_tests.rs | α-1 |
| devil_cases_tests.rs / wire_integration.rs | α-1（仅字面量） |
| models_yaml.rs | α-2 |
| protocol.rs / engine_provider.rs | α-3 |
| EngineProviderConfig 其它字面量文件 | α-3 |
| modelsCatalogTypes.ts / modelsCatalogIpc.ts | α-4 |
| YamlConfigEditorModal.tsx | α-4（仅编译对齐） |
| modelsCatalogStore.ts 及其测试 / probeIncremental.test.ts | α-5 |
| modelCatalog*.ts 旧岛 | 无人；禁写禁提交 |

交叉契约（并行时按此对齐，禁止各写一套）：

- IPC 读成功 = 命令命中 ∧ parseError 空 ∧ `providers` 为对象（含 `{}`）。树 = `{ version: 2, providers }`。
- `live_catalog() -> Arc<LiveModels>`，`LiveModels.find(provider_id, model_id) -> Option<&ModelSpec>`。
- 文件缺失 = 诚实空树。解析失败 = 保持上一份成功快照或显式错误，不得吞成空配置再当已加载。
- 前端生产零命中：`models_yaml_read` / `models_yaml_write` / `models_yaml_reload` / `convertFlatModelsToTree` / `wire.tree`。
