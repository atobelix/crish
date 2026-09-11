# 01 · Multi-Provider 与 Gateway 系统性补全方案

| 字段     | 内容                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------- |
| 文档编号 | `SCP-PLAN-01`                                                                                             |
| 状态     | 方案就绪，待执行轮实施                                                                                    |
| 日期     | 2026-07                                                                                                   |
| 上游审计 | [`audits/00-master-findings.md`](../audits/00-master-findings.md) §2.1                                    |
| 总编排   | [`00-master-multi-agent-roadmap.md`](../00-master-multi-agent-roadmap.md)（若尚未落盘，以本方案自洽为准） |
| 范围     | 产品契约 → desktop profiles → daemon factory → runtime providers                                          |
| **禁止** | 本文件**仅方案**；执行轮前**不得**改产品代码。开源仓 clone 在执行轮进行。                                 |

---

## 0. 一句话结论

**生产主链只有 OpenAI-compatible 是真实现**；`provider-anthropic.ts` / `provider-gemini.ts` 是**空壳 stub**（`stream → yield* []`，`complete → {}`），且接口与正式 `AgentProvider`（`types.ts` 的 `id + stream(AgentProviderRequest)`）**不一致**；daemon 工厂**硬编码** `createOpenAICompatibleProviderFromPlan`。桌面种子 profile 却存在「Anthropic 兼容」壳（`baseUrl: https://api.anthropic.com/v1`），会把原生 Anthropic 端点误塞进 OpenAI 兼容请求路径。

**目标**：自上而下建立诚实的 **provider family 契约**，再按 family 实现真 Anthropic / 真 Gemini，最后把 daemon 多路由与 probe 接上，并用 mock-server 单测 + **真实 Tauri 软件内**验收，杜绝「UI 可选、底层空转」。

---

## 1. 背景与现状

### 1.1 证据级现状（代码路径）

| 层               | 路径                                                                                                                                  | 真实状态                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime 正式接口 | `packages/agent-runtime/src/types.ts` → `AgentProvider`                                                                               | 仅 `id` + `stream(AgentProviderRequest): AsyncIterable<ProviderStreamEvent>`                                                                                |
| OpenAI 真实现    | `packages/agent-runtime/src/provider-openai-compatible.ts` + `openai-request-build.ts` / `openai-stream-parse.ts` / `openai-retry.ts` | **生产级**：Responses / Chat Completions、SSE、tool schema、auth headers、retry、systemPromptWireMode、transport（含 Rust 路径）                            |
| Anthropic stub   | `packages/agent-runtime/src/provider-anthropic.ts`                                                                                    | `stream` 空迭代；`complete` 返回 `{}`；实现的是 `provider-factory.ts` 的**另一套** `AgentProvider`（`name/complete/embed/health`），**未**接到 session loop |
| Gemini stub      | `packages/agent-runtime/src/provider-gemini.ts`                                                                                       | 同上，空壳；health 可打 list models，但 stream/complete 无效                                                                                                |
| 旁路工厂         | `packages/agent-runtime/src/provider-factory.ts`                                                                                      | 注册表式工厂，与 gateway 主链**平行**，易造成「看起来有多 provider」的幻觉                                                                                  |
| Gateway 抽象     | `packages/agent-runtime/src/provider-gateway.ts`                                                                                      | 路由目录、凭证解析、`ProviderFactoryPlan`、健康/冷却已有；**materialize 依赖 route 上的 providerFactory**                                                   |
| Daemon 网关      | `packages/agent-daemon/src/daemon-provider-gateway.ts`                                                                                | 默认/缺省 factory **一律** `createOpenAICompatibleProviderFromPlan`；`routeWithDefaultFactory` 也只补 OpenAI-compatible                                     |
| Prompt family    | `packages/agent-runtime/src/prompt-assembly.ts`                                                                                       | 已有 `PromptProviderFamily`: `openai \| anthropic \| gemini \| openai-compatible \| unknown`                                                                |
| Cache hints      | `packages/agent-runtime/src/provider-cache-hints.ts`                                                                                  | 已规划 anthropic breakpoints / gemini context cache **元数据**，但无原生 adapter 消费                                                                       |
| Stream 契约      | `packages/agent-runtime/src/provider-stream-contract.ts`                                                                              | 统一 envelope（start/delta/tool-call/end/done/error）已设计，OpenAI 路径部分落地                                                                            |
| Desktop profiles | `apps/crish-desktop/src/api/providerProfiles.ts`                                                                                      | 多 profile + `update-config` 主轨；种子含 `anthropic` 名「Anthropic **兼容**」，base 指向官方 Anthropic，**无 family 字段**                                 |
| 死轨 API         | `apps/crish-desktop/src/api/clientApi.ts` `getProviders`                                                                              | 正式 `[]`（HONEST-HIDE）；demo 另有 Google Gemini / Anthropic Claude 展示壳                                                                                 |

### 1.2 用户可见风险

1. **静默空响应**：若某日误把 stub 注册进 factory 而不改实现，run 会「完成」但无 token，难排查。
2. **误配路径**：用户选「Anthropic」profile + 真 key → daemon 仍按 OpenAI-compatible 拼 `/chat/completions` 或 `/responses` → 401/404/协议错误，且诊断未必说「family 不匹配」。
3. **表面完成度 > 功能完成度**：文件名存在、demo 列表有品牌、prompt family 有枚举 → 审计与产品都易误判「已支持」。
4. **双接口污染**：`provider-factory.ts` 的宽接口 vs `types.ts` 的窄接口，后续 agent 容易「补全 stub 的 complete/embed」却永远进不了 `AgentSessionLoop`。

### 1.3 已有可复用资产（不要推倒重来）

- OpenAI-compatible 的 SSE 读流、retry、error 分类、`ProviderStreamEvent` 映射。
- `DefaultProviderGateway` + daemon controller 的 plan / status / readiness / credential 模式。
- `assemblePromptForProvider` + cache hint plan（stable prefix 优先）。
- Desktop：`providerProfiles` + `engineConfig.updateEngineConfig` 已是唯一供应商配置主轨（见 `docs/plans/2026-07-product-trust-topdown.md`）。

### 1.4 非目标（本方案不做）

- 不引入 LiteLLM **运行时依赖**或旁路 Python 进程；只**对照实现**协议映射。
- 不实现完整 NewAPI/OneAPI 商业网关产品。
- 不在本方案改 Goal / MCP / 审批（仅依赖其「run 能真正吃到 provider 流」）。
- 不重写 session loop；provider 只吐统一 `ProviderStreamEvent`。

---

## 2. 目标架构（自上而下）

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  L0 产品契约（Product Contract）                                         │
│  · ProviderFamily: openai-compatible | anthropic | gemini                 │
│  · 能力矩阵：stream / tools / systemPrompt / cacheHints / listModels      │
│  · 诚实 UI：未实现 family → 禁用或「仅兼容代理」文案，禁止可点假成功       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│  L1 Desktop profiles（本地多组 + 活动组）                                 │
│  · ProviderProfile 增加 family（必填）+ 可选 authStyle / nativeBaseUrl     │
│  · 激活时 update-config：baseUrl, model, apiKey, providerId, **family**   │
│  · 种子：anthropic 默认 family=anthropic 或标注「需 OpenAI 兼容网关」       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ daemon update-config / env / workspace
┌───────────────────────────────▼─────────────────────────────────────────┐
│  L2 Daemon Provider Gateway Controller                                   │
│  · RouteOffer.metadata.family 或 endpointType 族                          │
│  · providerFactory 按 family 分派：                                       │
│      openai-compatible → createOpenAICompatibleProviderFromPlan           │
│      anthropic         → createAnthropicProviderFromPlan                  │
│      gemini            → createGeminiProviderFromPlan                     │
│  · 多路由 catalog：同模型多上游 + 健康/冷却（已有骨架）                     │
│  · probe family：list-models / 最小 completion / 协议嗅探                  │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ ProviderFactoryPlan
┌───────────────────────────────▼─────────────────────────────────────────┐
│  L3 Runtime providers（唯一实现面）                                       │
│  · 统一实现 types.AgentProvider.stream(AgentProviderRequest)              │
│  · 内部：消息映射 → HTTP+SSE/JSON → ProviderStreamEvent                    │
│  · 可选 complete() 仅测试/probe 用，不进正式 loop 契约                     │
│  · 删除或降级 provider-factory.ts 双轨，避免第二套接口复活                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 契约字段建议（产品级）

```ts
/** 产品/引擎共用的家族枚举（与 PromptProviderFamily 对齐，去掉 unknown 作配置默认） */
type CrishProviderFamily = 'openai-compatible' | 'anthropic' | 'gemini';

interface ProviderFamilyCapability {
  family: CrishProviderFamily;
  stream: true; // 主路径必须流式
  tools:
    'openai-functions' | 'anthropic-tools' | 'gemini-function-declarations';
  systemPrompt:
    | 'native-system'
    | 'user-prefix'
    | 'anthropic-system'
    | 'gemini-system-instruction';
  auth:
    | 'authorization-bearer'
    | 'x-api-key'
    | 'query-key'
    | 'google-api-key-header';
  cacheHints:
    | 'openai-metadata'
    | 'anthropic-cache-control'
    | 'gemini-cached-content'
    | 'none';
  listModelsPath?: string; // probe 用
  readinessProbe: 'list-models' | 'minimal-messages' | 'both';
}
```

**规则**：

1. UI 可选 model 列表必须来自 **已声明 family 且 readiness≠unsupported** 的 profile。
2. `family=anthropic` 且 baseUrl 指向 `api.anthropic.com` → **必须**走原生 adapter，禁止 OpenAI 路径静默吞掉。
3. 若用户坚持用第三方「Anthropic 的 OpenAI 兼容代理」→ 显式选 `family=openai-compatible`，profile 名可仍叫 Anthropic，但 **family 诚实**。
4. Daemon `providerStatus` 投影必须带 `family` + `adapter: real|stub|unsupported`；stub 不得标 `ready`。

### 2.2 消息与工具映射边界

| 统一内部            | OpenAI-compatible          | Anthropic Messages                            | Gemini generateContent       |
| ------------------- | -------------------------- | --------------------------------------------- | ---------------------------- |
| systemPrompt        | system role 或 user-prefix | 顶层 `system` / blocks + 可选 `cache_control` | `systemInstruction`          |
| user/assistant text | content string / parts     | content blocks                                | `contents[].parts`           |
| tool defs           | tools[] function           | tools[] input_schema                          | `tools.functionDeclarations` |
| tool_call           | tool_calls / function_call | `tool_use` block                              | `functionCall` part          |
| tool_result         | tool role message          | `tool_result` block                           | `functionResponse` part      |
| stream text         | delta content              | `content_block_delta`                         | SSE/JSON chunks `text`       |
| usage               | usage.*                    | usage input/output + cache                    | usageMetadata                |

所有 adapter **出口**必须是现有 `ProviderStreamEvent`：

- `text-delta` / `thought-delta`
- `tool-call`（完整或可修复 JSON 参数）
- `provider-diagnostic`
- `stop`（含 usage）

### 2.3 密钥与 Header（auth）

| Family            | 默认 Header / 参数                                                 | 备注                                                      |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| openai-compatible | `Authorization: Bearer <key>`（可配 `authHeader`）                 | 已有 `OpenAICompatibleAuthHeader`                         |
| anthropic         | `x-api-key: <key>` + `anthropic-version: 2023-06-01`（或配置版本） | **禁止**只发 Bearer 当默认；可选 beta headers             |
| gemini            | `x-goog-api-key` 或 `?key=`                                        | 与 generativelanguage 端点一致；勿复用 OpenAI base 拼路径 |

凭证仍走现有：`api-key` 直连 / account-backed resolver；投影侧 redact。

---

## 3. 开源参考：LiteLLM

### 3.1 拉取方式（执行轮，非本方案阶段）

```bash
# 在仓库根执行；勿将整个巨型历史强制提交进主仓（submodule 或 .gitignore reference/litellm 按团队约定）
git clone --depth 1 https://github.com/BerriAI/litellm.git C:\Software\conex\reference\litellm
```

- 目标路径：**`C:\Software\conex\reference\litellm`**
- 用途：**对照协议与映射**，**禁止**把 litellm 作为 Node 运行时依赖打进 daemon。
- 若已有其它 reference 仓，保持并列：`reference/litellm`。

### 3.2 要抄什么（精确清单）

对照 litellm 源码时，优先阅读（路径随上游可能微调，以 clone 后检索为准）：

| 主题                 | 建议检索关键字 / 模块                                                                              | 落到 conex 的产物                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **Streaming SSE**    | Anthropic `messages` stream、`content_block_delta`、`message_stop`；Gemini `streamGenerateContent` | `anthropic-stream-parse.ts` / `gemini-stream-parse.ts`：帧边界、JSON 事件类型、取消与 idle timeout |
| **Tool schema 映射** | OpenAI tools ↔ Anthropic `input_schema` ↔ Gemini `function_declarations`；tool_choice 映射         | `toAnthropicTools` / `toGeminiTools`；参数名、required、strict 降级                                |
| **Auth headers**     | `x-api-key`、`anthropic-version`、`anthropic-beta`；Gemini key 放置                                | `authHeaderObject` 的 family 变体；禁止硬编码用户 key 进日志                                       |
| 消息角色折叠         | system 合并、连续 user、tool_result 附着                                                           | 请求 build 阶段纯函数 + 单测黄金样例                                                               |
| 错误与 retry         | 429 Retry-After、529 overloaded、401 不可重试                                                      | 复用 `openai-retry.ts` 思想，抽 `provider-retry.ts` 或 family 包装                                 |
| Usage 归一           | cache read/write、thinking tokens                                                                  | 写入 `ProviderUsage` + 既有 cache metrics 维度                                                     |

### 3.3 明确不抄什么

- 不抄 litellm 的「统一代理服务」进程模型与计费路由。
- 不抄其全量 100+ provider；conex **只**做 openai-compatible / anthropic / gemini 三族。
- 不把 Python 类型/Pydantic 模型直接翻译成运行时依赖。

### 3.4 对照工作流（每个原生 adapter 强制）

1. 从 litellm 抽出 **最小请求 JSON 样例**（无 tools / 有 tools / 多轮 tool_result）。
2. 用 mock HTTP server 录制 **SSE 事件序列** 作 vitest fixture。
3. 实现 conex builder + parser，**字节级事件类型对齐**（字段名可本地化，语义不可丢）。
4. 反作弊：禁止 `stream() { yield* []; }` 或固定字符串冒充「已实现」。

---

## 4. 多轮多 Agent 执行方案

> **规则**：每轮 **≥ 4 个并行 Agent**（除非本节写明可减）。
> **隔离**：按文件所有权拆分，禁止两 agent 同写一文件。
> **合流**：每轮结束由 **Inspector（反偷懒）** 做 diff + 测试门禁，不通过不得开下一轮。
> **本方案阶段不改代码**；下列为执行轮剧本。

### Round 0 · 准备（可减至 2 agent，因无产品改动）

| Agent            | 职责                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R0-A 参考拉取    | clone litellm 到 `reference/litellm`；索引 SSE/tools/auth 文件清单写入本方案附录或 `reference/analysis-reports/litellm-provider-notes.md`（仅 reference，非产品） |
| R0-B 契约草案 PR | 仅文档/类型草案分支：确认 `CrishProviderFamily` 与 profile 字段命名；**可不合并代码**                                                                             |

---

### Round 1 · 契约与诚实 UI（≥4 agents）

**目标**：产品层不再假装支持原生 Anthropic/Gemini；配置面可表达 family。

| Agent ID | 角色                    | 文件所有权（建议）                                                                                                          | 交付                                                                                                                                                       |
| -------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-A     | **契约与类型**          | `packages/shared-types/src/provider-defaults.ts`（及导出）、必要时 `packages/agent-daemon/src/types.ts` 中 status 类型      | 增加 `family`、`adapterStatus`；`DaemonProviderStatusSnapshot` 带 family                                                                                   |
| R1-B     | **Daemon 配置合并**     | `packages/agent-daemon/src/daemon-provider-gateway.ts`（仅配置/schema 层，不接原生 factory）、`PROVIDER_CONFIG_SCHEMA` 相关 | `update-config` 接受 `family`；未知 family → 校验警告；默认 `openai-compatible`                                                                            |
| R1-C     | **Desktop profiles**    | `apps/crish-desktop/src/api/providerProfiles.ts`、`engineConfig.ts`（仅同步字段）                                           | profile 增加 `family`；种子「Anthropic」：要么 `family: 'anthropic'` + UI 标「原生（未实现则 disabled）」，要么改名为明确「OpenAI 兼容代理」并改 base 说明 |
| R1-D     | **诚实 UI**             | 设置模型页相关组件（ModelsSettingsTab / ModelPicker 等，以实际路径为准）、文案                                              | 未实现 family：**禁用选择**或只读说明 + 链接文档；禁止可编辑后静默失败；`getProviders` 死轨不得复活假列表                                                  |
| R1-E     | **Inspector（反偷懒）** | 只读 + 测试                                                                                                                 | 断言：正式路径无 stub ready；中文无乱码；`npm run check:desktop` / daemon 类型检查；扫描是否仍展示「已支持 Claude 原生」类虚假文案                         |

**Round 1 验收**：

- [ ] 配置契约表更新（可补丁 `docs/plans/2026-07-product-trust-topdown.md` 或本方案附录）
- [ ] 用户无法在「adapter=stub/unsupported」时把 run readiness 看成完全 ready（或明确 degraded 文案）
- [ ] 无产品路径调用空 `provider-anthropic` 却不报错

**可减条件**：若桌面设置页由同一人改完 R1-C+D，可合并为 1 agent，但 **总数仍 ≥4**（保留契约/daemon/UI/Inspector）。

---

### Round 2 · Anthropic 真实现（对照 litellm）（≥4 agents）

**目标**：`AnthropicProvider` 实现 **`types.AgentProvider`**，可被 factory plan 创建；mock SSE 全绿。

| Agent ID | 角色                | 文件所有权                                                                                                                                  | 交付                                                                                                                                                                                  |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2-A     | **请求构建**        | 新建 `packages/agent-runtime/src/anthropic-request-build.ts`                                                                                | messages/tools/system → Anthropic body；tool_choice；max_tokens；model                                                                                                                |
| R2-B     | **SSE 解析**        | 新建 `packages/agent-runtime/src/anthropic-stream-parse.ts`                                                                                 | 解析 `message_start` / `content_block_*` / `message_delta` / `message_stop`；映射 `ProviderStreamEvent`；错误帧                                                                       |
| R2-C     | **Provider 本体**   | **重写** `provider-anthropic.ts`（删除 factory 宽接口依赖）；共享 timeout/retry 工具可抽到 `provider-http-shared.ts` 若冲突则 R2-C 独占抽离 | `stream(AgentProviderRequest)`；headers：`x-api-key`、`anthropic-version`；`cache_control` 消费 `provider-cache-hints` 的 anthropic-style breakpoints（能挂则挂，否则 TODO 单测标记） |
| R2-D     | **单测 + fixtures** | `provider-anthropic.test.ts`、`fixtures/anthropic/*.sse.jsonl`                                                                              | 无 tools 流式；有 tools + tool_use；多 block；401/429；abort signal                                                                                                                   |
| R2-E     | **Inspector**       | 只读                                                                                                                                        | **禁止** `yield* []` / 空 complete 冒充；对照 litellm 事件名 checklist；`npm run check:runtime` + 目标 vitest                                                                         |

**对照 litellm 检查表（R2 强制）**：

- [ ] streaming SSE 事件类型覆盖主路径
- [ ] tool schema：`name` / `description` / `input_schema`
- [ ] auth headers 完整
- [ ] stop reason → `stop.reason` 映射（end_turn / tool_use / max_tokens）

**不在本轮**：daemon 多路由切换（Round 4）；Gemini。

---

### Round 3 · Gemini 真实现（≥4 agents）

**目标**：与 Round 2 对称的 Gemini 原生实现。

| Agent ID | 角色                | 文件所有权                                           | 交付                                                                                                 |
| -------- | ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| R3-A     | **请求构建**        | `packages/agent-runtime/src/gemini-request-build.ts` | `contents` / `systemInstruction` / `tools.functionDeclarations` / generationConfig                   |
| R3-B     | **流解析**          | `packages/agent-runtime/src/gemini-stream-parse.ts`  | `streamGenerateContent` 响应（SSE 或 JSON array 分帧，以官方与 litellm 为准）→ `ProviderStreamEvent` |
| R3-C     | **Provider 本体**   | **重写** `provider-gemini.ts`                        | `stream` 真实现；auth；model path 拼装；embed 可继续 throw/unsupported（非主链）                     |
| R3-D     | **单测 + fixtures** | `provider-gemini.test.ts`、`fixtures/gemini/*`       | 文本流；functionCall；安全过滤/封锁诊断；abort                                                       |
| R3-E     | **Inspector**       | 只读                                                 | 同 R2；确认 prompt-assembly `providerFamily=gemini` 与 adapter 一致                                  |

**可减条件**：无。Gemini 与 Anthropic 对称，保持 ≥4。

---

### Round 4 · Daemon 多路由 + probe family（≥4 agents）

**目标**：工厂按 family 分派；多 route；probe 能区分协议族。

| Agent ID | 角色               | 文件所有权                                                                           | 交付                                                                                                                                |
| -------- | ------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| R4-A     | **Factory 分派**   | `daemon-provider-gateway.ts` 中 `create*ProviderFromPlan`、`routeWithDefaultFactory` | 按 `family` 选择 OpenAI / Anthropic / Gemini factory；缺省 openai-compatible；**禁止**再对 anthropic 官方 base 静默套 OpenAI        |
| R4-B     | **多路由 catalog** | 同包测试 + server 配置注入点（`server-runtime-factory.ts` / 配置文档）               | 支持 routes[]：priority、fallback、health cooldown；外部 catalog 保留「无 factory 时按 family 补默认」而非写死 OpenAI               |
| R4-C     | **Probe family**   | 新建或扩展 `provider-probe.ts`（runtime 或 daemon）；`providerStatus` 投影           | `probe(family)`：listModels 和/或 minimal stream；结果写入 diagnostic（latency、http status、familyMismatch）；UI/capabilities 可读 |
| R4-D     | **Desktop 同步**   | `providerProfiles` / 设置页「测试连接」                                              | 测试连接调用 probe；失败展示 family 级原因（鉴权/协议/网络）                                                                        |
| R4-E     | **Inspector**      | 只读                                                                                 | 集成测试：三条 family 各一条 mock route；fallback 从 unhealthy anthropic → openai-compatible；状态快照字段齐全                      |

**Probe family 语义**：

```text
probe(family, credential, baseUrl) →
  { ok, family, latencyMs, checks: [
      { name: "auth-headers", ok },
      { name: "list-models" | "minimal-stream", ok, detail },
      { name: "protocol-shape", ok }  // 响应是否像该 family
  ], mismatchHint?: "baseUrl looks anthropic but family=openai-compatible" }
```

---

### Round 5 · 测试与反偷懒（≥4 agents）

**目标**：自动化门禁 + 软件内验收脚本/清单；杜绝回归 stub。

| Agent ID | 角色                        | 交付                                                                                                                                                                    |
| -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R5-A     | **静态反偷懒**              | 脚本或 CI 步骤：禁止 `provider-anthropic.ts`/`provider-gemini.ts` 再出现 `yield* []` 与空 `return {}` 作为 stream/complete 主路径；禁止新增 `as any` 掩盖 provider 类型 |
| R5-B     | **Runtime/Daemon 单测矩阵** | 表格用例全绿：三 family × (no-tool, tool, error, abort)；gateway plan 字段                                                                                              |
| R5-C     | **In-app 验收剧本**         | 见 §6；在 **Tauri 真软件** 中执行（非仅 Vite 端口）；记录 `__crishStreamDiag` / providerStatus / 首包时间                                                               |
| R5-D     | **文档与 CHANGELOG**        | 更新本方案状态、ARCHITECTURE.md provider 段、用户可见「支持的服务商」说明                                                                                               |
| R5-E     | **Inspector 终审**          | 对照 §5 验收标准全勾；抽查 litellm 对照项未删；无「假 ready」                                                                                                           |

---

## 5. 验收标准

### 5.1 功能

| #   | 标准                                                                            | 验证方式                                                                                 |
| --- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| F1  | OpenAI-compatible 回归不退化（含 endpoint auto、systemPromptWireMode）          | 既有 `daemon-provider-gateway.test.ts` / `provider-gateway.test.ts` / openai 相关 vitest |
| F2  | Anthropic：mock SSE 下完整 text + tool_use 一轮                                 | `provider-anthropic.test.ts`                                                             |
| F3  | Gemini：mock 流下 text + functionCall 一轮                                      | `provider-gemini.test.ts`                                                                |
| F4  | Daemon 可按 family 创建对应 provider，错误 family/baseUrl 组合有明确 diagnostic | daemon 单测 + status 快照                                                                |
| F5  | Desktop profile 带 family；未实现/失败时 UI 诚实                                | 组件测或 in-app                                                                          |
| F6  | Probe 能报告 family 级失败（401 vs 协议不匹配）                                 | probe 单测                                                                               |
| F7  | 主链 `AgentSessionLoop` 只依赖 `types.AgentProvider.stream`                     | 类型 + 集成                                                                              |

### 5.2 质量与反偷懒

| #   | 标准                                                            |
| --- | --------------------------------------------------------------- |
| Q1  | 禁止 stub 空流标记为 `readiness: ready`                         |
| Q2  | 禁止 `it.skip` / 恒真断言冒充 provider 测通                     |
| Q3  | 禁止用 OpenAI 兼容路径「有报错」当作 Anthropic「已支持」        |
| Q4  | 新增代码无无故 `as any` / 空 catch 吞鉴权错误                   |
| Q5  | 中文 UI/提交信息 UTF-8 无乱码                                   |
| Q6  | litellm 仅 reference；产品 `package.json` 无 litellm 运行时依赖 |

### 5.3 性能与体验（合理下限）

| #   | 标准                                                                      |
| --- | ------------------------------------------------------------------------- |
| P1  | 首字节超时/空闲超时与 OpenAI 路径同级可配（request/firstByte/streamIdle） |
| P2  | 诊断事件不泄露完整 apiKey                                                 |
| P3  | 流式 delta 可被既有 coalescing/backpressure 消费（不发明第二套 UI 事件）  |

---

## 6. 与 in-app 测试的关系

### 6.1 为何必须软件内测

| 能力                                      | 仅浏览器 Vite | Tauri + daemon |
| ----------------------------------------- | ------------- | -------------- |
| 真 daemon provider factory                | 否/部分 mock  | **是**         |
| update-config → 下一 run 生效             | 易假          | **是**         |
| providerStatus / readiness → capabilities | 易 stub       | **是**         |
| 流式背压、sidecar、密钥文件               | 否            | **是**         |
| MCP/审批等同进程干扰下的 provider 稳定性  | 否            | **是**         |

与总审计一致：**系统能力验收必须在 WebView2/Tauri 真软件内**；vitest mock server 是开发期必要但不充分条件。

### 6.2 In-app 剧本（Round 5-C）

1. **准备**：构建并启动 crish-desktop（Tauri），daemon 随 sidecar 起。
2. **OpenAI-compatible 基线**：配置已知可用兼容端点 → 发一条短消息 → 见流式 token → `providerStatus.family=openai-compatible`。
3. **Anthropic 真 key 或 mock 网关**：
   - 有真 key：family=anthropic，base 官方 → 一轮对话 + 强制 tool（如 read）→ 轨迹有 tool_call。
   - 无真 key：本地 mock Anthropic SSE 端口 + profile 指向 mock → 同断言。
4. **Gemini** 同上。
5. **误配**：family=openai-compatible + anthropic 官方 base → UI/诊断出现 **mismatch**，不得无限转圈。
6. **采集**：保存 session 诊断导出、`DaemonProviderStatusSnapshot`、可选 `provider-smoke-report` 类 JSON，作为长程 Goal 测试的 provider 前置条件。

### 6.3 与长程 Goal / AI 测试的依赖顺序

```text
本方案 (Provider 真) → Goal 引擎接线方案 → 软件内长程跑数
```

Provider 仍假时，Goal 长程数据无意义（空响应会被当成模型失败或假 DONE）。**本方案是长程测试的 P0 前置之一**（与审计 P0 列表一致）。

### 6.4 Computer-use

**不**作为本方案 CI 门禁；仅人工探索「设置页点击」可用，不替代 daemon 协议测。

---

## 7. 禁止事项（执行轮红线）

1. **禁止**在未实现原生协议时，把 Anthropic/Gemini 标为已支持或 ready。
2. **禁止**继续维护两套 `AgentProvider` 而不标明废弃：`provider-factory.ts` 宽接口要么删除要么标注 `@deprecated` 且不进 daemon。
3. **禁止** `stream { yield* [] }` / `complete { return {} }` 作为合并态。
4. **禁止**为绿测而 `skip`、硬编码假 usage、假 tool_call。
5. **禁止**引入 litellm/Python sidecar 作为默认生产路径。
6. **禁止**在本专项改 Goal DONE 逻辑、MCP 启停、插件商店等无关面（除非类型导出被迫联动，且 diff 最小）。
7. **禁止**把密钥写入仓库 fixture；fixture 只用 `test-key` + mock server。
8. **禁止**仅用 Vite 浏览器测代替 Tauri 验收。
9. **禁止**执行轮前（方案阶段）修改产品代码——**本文件落地不等于开工写实现**。

---

## 8. 建议文件变更清单（执行轮索引）

| 动作     | 路径                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 重写     | `packages/agent-runtime/src/provider-anthropic.ts`                        |
| 重写     | `packages/agent-runtime/src/provider-gemini.ts`                           |
| 新建     | `anthropic-request-build.ts` / `anthropic-stream-parse.ts`                |
| 新建     | `gemini-request-build.ts` / `gemini-stream-parse.ts`                      |
| 可选新建 | `provider-http-shared.ts`（timeouts、header merge、error classify）       |
| 扩展     | `packages/agent-runtime/src/provider-gateway.ts`（family 元数据，若需要） |
| 扩展     | `packages/agent-daemon/src/daemon-provider-gateway.ts`                    |
| 扩展     | `packages/agent-daemon/src/types.ts`（status）                            |
| 扩展     | `packages/shared-types/src/provider-defaults.ts`                          |
| 扩展     | `apps/crish-desktop/src/api/providerProfiles.ts` + 设置 UI                |
| 测试     | `*.test.ts` + `fixtures/anthropic                                         | gemini/` |
| 参考     | `C:\Software\conex\reference\litellm`（clone，执行轮）                    |
| 废弃处理 | `provider-factory.ts` 双轨收敛                                            |

---

## 9. 轮次依赖图

```text
Round 0 (可选 litellm clone)
    ↓
Round 1 契约 + 诚实 UI ──────────────────────────────┐
    ↓                                                  │
Round 2 Anthropic 真实现（可与 R3 部分并行，但 factory 接入在 R4）
    ↓                                                  │
Round 3 Gemini 真实现                                  │
    ↓                                                  │
Round 4 daemon 多路由 + probe ←────────────────────────┘
    ↓
Round 5 测试门禁 + in-app + 文档
```

**并行说明**：R2 与 R3 在 **runtime 文件不重叠** 时可同迭代双开（各 ≥4 agent 或合并波次时按人力改为顺序）。R4 必须在 R2/R3 的 `types.AgentProvider` 实现可 import 之后。

---

## 10. 风险与缓解

| 风险                       | 缓解                                                            |
| -------------------------- | --------------------------------------------------------------- |
| 官方 API 变更              | 解析层隔离 + fixture 版本号；对照 litellm 跟进                  |
| Tool JSON 半流式差异       | 复用 OpenAI 路径的 tool JSON repair 思路                        |
| 桌面旧 profile 无 family   | 迁移默认 `openai-compatible`；对 anthropic 官方 host 启发式警告 |
| 范围膨胀抄全 litellm       | 三族白名单；Inspector 拒绝对 100+ provider 的 PR                |
| 与 account-center 凭证耦合 | 先直连 api-key 路径；account resolver 只传 key/headers          |

---

## 11. 附录 A · 与审计条目映射

| 审计结论                            | 本方案动作                           |
| ----------------------------------- | ------------------------------------ |
| Anthropic/Gemini 空壳               | R2/R3 真实现                         |
| Daemon 只 createOpenAICompatible    | R4 factory 分派                      |
| Desktop Anthropic base 误走兼容路径 | R1 family + R4 校验                  |
| getProviders 正式 []                | 保持 HONEST-HIDE；不以 demo 列表冒充 |
| 长程测试前置                        | §6 依赖顺序                          |

---

## 附录 B · Inspector 速查命令（执行轮）

```bash
# 按仓库实际脚本名为准
npm run check:runtime
npm run check:daemon
npm run check:desktop

# 定向 vitest 示例
npm exec vitest -- packages/agent-runtime/src/provider-anthropic.test.ts packages/agent-runtime/src/provider-gemini.test.ts --run
npm exec vitest -- packages/agent-daemon/src/daemon-provider-gateway.test.ts packages/agent-runtime/src/provider-gateway.test.ts --run

# 反偷懒：空实现回归（示例，落地时写成 scripts）
rg "yield\\* \\[\\]" packages/agent-runtime/src/provider-anthropic.ts packages/agent-runtime/src/provider-gemini.ts
rg "return \\{\\}" packages/agent-runtime/src/provider-anthropic.ts packages/agent-runtime/src/provider-gemini.ts
```

---

## 附录 C · LiteLLM 对照记录模板（R0/R2/R3）

```markdown
### 事件/字段对照

| conex ProviderStreamEvent | Anthropic SSE                  | Gemini chunk                       | litellm 参考文件:行 |
| ------------------------- | ------------------------------ | ---------------------------------- | ------------------- |
| text-delta                | content_block_delta.delta.text | candidates[0].content.parts[].text |                     |
| tool-call                 | content_block_start tool_use   | functionCall                       |                     |
| stop                      | message_stop                   | finishReason                       |                     |

### Auth

| Header | 值来源 | litellm 参考 |
| ------ | ------ | ------------ |
```

---

**文档结束。** 下一执行动作：总编排排期 → Round 0/1 开工；在启动 Round 2 前完成 `reference/litellm` clone 与对照表草稿。
