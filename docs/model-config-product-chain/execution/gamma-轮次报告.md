# 轮次报告：γ

## 轮次元信息

- 轮次：γ
- 对应维：S3
- 本轮 Agent 数：10（实现 8 / 补洞 1 / 审计 1）
- 任务单元：T3.1–T3.7（唯一读 API、thinkingTitle、Composer、Picker、视觉入口、水合/header、设置读侧、发送 handoff）
- 输入包：00-总方案 + plans/03 + execution/β-轮次报告.md
- 本轮闭合的产品链环节（只用调度 §3 动词）：
  - [x] 设置抽屉编辑 modalities / thinking / pricing / protocol（写面：β；读侧：本轮 γ-7）
  - [x] 点保存（β 栏 A；栏 C 仍未跑 4000）
  - [ ] 磁盘 ~/.conex/models.yaml 出现同等字段（形状已接线；真机读盘未跑）
  - [x] modelsCatalogStore 与 live_catalog 同时反映该树（α；本轮 UI 订 `models-catalog-changed`）
  - [x] Composer 模型徽标 / 思考档位 / 附件入口读同一棵树（栏 A；栏 C 未跑 4000）
  - [x] 用户选档位、发消息（栏 A：handoff 写入 `thinkingTitle`/`thinkingWire`；出站 HTTP 仍断）
  - [ ] 出站 HTTP JSON 含 yaml 字典 wire
  - [x] 无图模型禁图（入口层栏 A；出站硬拒归 δ）
  - [ ] SSE usage 进入 PricingEngine
  - [ ] 会话 UI 费用 = 微元
- 门禁：源码形状 **过（本轮写集）** · 真跑测 **各 Agent 自称绿；主控抽测见第五节** · 用户路径 **本轮未触达**

## 一、已完成

| 任务单元 | 文件域 | 闭合 |
| --- | --- | --- |
| T3.1 | `modelsCatalogLive.ts`；`modelsCatalogSelectors.ts`；`modelsCatalogQuery.ts` | 六符号读 API；窗口缺省 `undefined`；`findCatalogModel` 两参 |
| T3.2 | `SessionRuntimeRegistry.ts` | 会话 `thinkingTitle`；`set/getSessionThinkingTitle` |
| T3.3 | `ComposerFusedTrigger.tsx` | 档位 = yaml key；空字典物理卸载；不写 settings |
| T3.4 | `ModelBadgePickerMenu*` | 列表/能力 live；空 catalog 不回落种子 |
| T3.5 | `modelVisionSupport.ts`；`slashSendPreflight.ts`；`useChatAttachments.ts`；`ChatComposer.tsx`；`TiptapEditorExtensions.ts` | `modelAcceptsInput`；入口禁图；发送第二道闸仍在 |
| T3.6 | `bootstrap-full.ts`；`ChatHeaderControls.tsx`；`useChatModelPicker.ts` | 并行 `ensureModelsCatalogLoaded`；header/picker 订 catalog |
| T3.7 | `ModelProfileList.tsx`；`ModelsSettingsTab.tsx`；`useModelProfilesState.ts`；`ModelList.tsx` | 启用/展示名/窗口读 live；停用仍出现在设置列表 |
| T3.8 | `readiness.ts`；`streamSession.ts`；`slashSendPreflight.ts` 组装点 | 窗口 live；`reasoningEffort` = 字典 value |

## 二、未闭合与阻断

| 项 | 阻断 | 承接 |
| --- | --- | --- |
| 4000 用户路径 9.1–9.4 | 未跑 MCP | η |
| `request_options` `..Default::default()` 清空 thinking_map | 本维禁动 engine | δ · S4 |
| 出站硬拒 / 四 builder dialect | 本维禁动 | δ · S4 |
| PricingEngine 入账 | 本维禁动 | δ · S5 |
| Picker 写 thinkingTitle 后 Composer 胶囊不自动刷新 | registry 无订阅 | 本轮补洞 γ-9 |
| `PhysicalGeometryGuards` GEO-VP-02 / `permAndModelExclusive` 仍灌 LS 种子 | Picker 不再回落 DEFAULT_PROFILES | 本轮补洞 γ-9 |
| `directFetchBridge.ts` 仍读 `defaultThinkingLevel` | C3.4 废路径 | ζ |
| `selectEffectiveProtocol` 找不到仍 `'openai/chat'` | 选择器猜测 | ζ / 读路径收尾 |
| `ModelList` `getModelMeta.lastTest` | 连通性非规格 | ζ |
| 凭据壳 `loadProfiles` | S7 前允许 | ζ |
| `thinkingGear` bootstrap 并行 IIFE | plans/03 允许 | ζ |
| PriceConfigModal LS 价 | 非抽屉四维 | δ · S5 切断消费 / ζ 删模块 |
| 未提交 `modelCatalog*` | 禁止提交 | 全程 |

不阻断 δ：S4/S5 文件域与本轮无交集。S4 可用 yaml 夹具 + `reload_live_catalog` + 直接 `stream` 验收 W*/M*。

## 三、文件清单

本轮写集在 `apps/crish-desktop/src/api/modelsCatalogLive.ts`（新）、选择器/查询、SessionRuntimeRegistry、Composer 融合触发、Picker、视觉入口、bootstrap/header/picker 宿主、设置读侧、发送 readiness/streamSession。未改 `engine_provider.rs` / `build_*` / `pricing.rs` / β 的 `saveConfig`。未提交。旧岛八文件仍 dirty，禁止提交。

## 四、新发现（同权）

1. S1 读边界 `modelsCatalogIpc.ts` 仍把 `contextLength` 提升为 `contextWindow`。选择器本身不发明 128000；经 IPC 加载后旧键会变成窗口数字。
2. `ChatCompletionsRequestOptions` 已有 `thinking_map`/`thinking_format` 字段；Anthropic/Gemini options **没有**。S4 必须先补字段再灌，否则 Chat 通、另两轨仍 Default 清空。
3. γ-8 交给引擎的 `reasoningEffort` 是字典 **value**（如 `HIGH` / `disabled`）。S4 `parse_reasoning_effort` 仍认 off/low/medium/high；`disabled` 可能变 `None`。S4 必须以 yaml 字典键（TitleCase）或显式 `thinkingWire` 查 map，禁止再 `to_openai_str` 折叠。
4. `RunTaskOptions` 无 `content`/`hasImages`：S3 入口禁图后，出站守卫若只看 `AgentMessage` 仍可能假绿。S4 TU-5 必须把 IPC content 写入 `metadata.contentParts`。
5. 同展示名不再折叠：yaml 两个 provider id 在 Picker 各一行（与 LS `foldProfilesByDisplayName` 不同）。

## 五、验证

### A. 源码形状（主控本会话 grep）

- 生产 `ComposerFusedTrigger.tsx` / `ModelBadgePickerMenu.tsx` 读 `modelsCatalogLive`，不引 `getModelMeta` / `thinkingGear`。
- 生产 `findCatalogModel(` 单参：0（`modelVisionSupport` 已改 `modelAcceptsInput`）。
- 生产 `VISION_MODEL_PATTERNS`：0。
- 生产 `128_000`：选择器/readiness 无发明；剩余命中为测试夹具与 placeholder「如 128000」。
- `bootstrap-full.ts` 含 `ensureModelsCatalogLoaded`。
- `engine_provider.rs:190` 仍 `..ChatCompletionsRequestOptions::default()`（本维未动，δ 输入）。

### B. 本会话真跑测

主控本会话复跑（仓库根 `npx vitest run --project=unit` 下列 13 文件）：**13 files / 160 tests 全绿**。

覆盖：`modelsCatalogLive` 9、`modelsCatalogStore` 35、`bootstrap-full` 7、`ComposerFusedTrigger` 7、`modelVisionSupport` 6、`useModelProfilesState` 13、`ChatHeaderControls.catalog` 9、`useChatModelPicker` 4、`ModelBadgePickerMenu` 20、`ModelsSettingsTab.liveRead` 6、`ModelProfileList` 5、`ModelList` 2、`ConnectionLifecycle` 37。

未纳入本次复跑、仍以 Agent 自称计：γ-5 附件/preflight 全链、γ-8 assemble handoff 分文件、γ-2 registry 测。补洞测归 γ-9。

### C. Tauri 4000

未跑。不能宣称「设置改 yaml → 不刷新 → Composer/Picker 即时变」或「纯文本模型加号不可挂图」的真机路径。

## 六、双轨

- 生产规格读路径：yaml 镜像（`modelsCatalogLive` / `modelsCatalogStore`）。
- 身份键 `getActiveProfileId` / `getActiveModelId` 仍作「选了谁」（§3.7 允许）。
- 凭据壳仍 `loadProfiles`。
- lastTest 仍旧岛。
- 新引入 fallback / TODO / 第二套 ViewModel：**0**（`getLive*` 是 store 门面 + `loaded` 门闩）。

## 七、输出到下一轮

- 启动：**S4 与 S5 并行**（文件域互斥）。
- 可假定：UI 读 live；发送带 `thinkingTitle`/`thinkingWire`；视觉入口信 `modalities.input`；`live_catalog()` 可 `find(provider_id, model_id)`；`EngineProviderConfig` 有槽位但 `request_options` 仍 Default 清空。
- 不可启动：S7 删旧轨（读路径还有凭据壳/lastTest/废桥）；S8 用户全链。
- S4 第一刀：`request_options` 显式写 `thinking_map`/`thinking_format`；lookup 键 `(provider_id, model)`；热路径零 `bundled_catalog`。
- S5 第一刀：`PricingEngine` 进 `engine_build` 收口；前端删除 `estimateCostUsd` 账本。
