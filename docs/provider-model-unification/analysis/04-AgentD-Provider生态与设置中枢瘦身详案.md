# 供应商生态拓扑、凭证全生命周期与设置中枢人体工学瘦身详案 (04-EPIC-A-E-AGENT-D)

> **文档标识**：`04-AgentD-Provider生态与设置中枢瘦身详案.md`  
> **所属战役工作区**：`docs/provider-model-unification/analysis/`  
> **专项编制专家**：Provider UI Specialist（服务商生态与交互中枢专家 · Agent-D）  
> **负责攻坚议题**：  
> - **【议题 A】Provider 拓扑结构、凭据生命周期与动态发现体系**  
> - **【议题 E】前端状态中枢重构、界面人体工学瘦身与全量立体验证**  
> **基准权威参考文档**：  
> 1. `docs/provider-model-unification/00-供应商与模型能力全线接通重构总纲.md`  
> 2. `docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`  
> 3. `reference/pi/packages/coding-agent/docs/models.md`  
> 4. `reference/pi/packages/ai/src/types.ts`  
> **执行硬性指标**：工业级方案规范、严格遵守千行铁律（≥ 1,000 行）、全类型完备性契约、生产级算法伪代码与真实 Wire JSON 对比、八大模块无缩水闭环。

---

## 模块一：针对负责议题的 Conex 现状深度剖析与根因定位

### 1.1 Provider 拓扑结构的扁平倒置与维护困境（议题 A 核心痛点）

在当前的 Conex / Crish 系统架构中，模型与供应商的从属关系存在本质上的“拓扑结构倒置”。这种倒置不仅造成了配置文件维护的灾难，更是导致系统各层出现大量补丁式逻辑的根源。

#### 1.1.1 现状架构图解与倒置模型分析

```
【当前 Conex 扁平倒置与双轨存储的裂解拓扑】

        ┌─────────────────────────────────────────────────────────────┐
        │  物理文件：~/.conex/models.yaml (单层一维模型平铺数组)      │
        ├─────────────────────────────────────────────────────────────┤
        │  models:                                                    │
        │    - id: "deepseek-v4-flash"                                │
        │      vendor: "deepseek"           ◄── 模型反向挂载厂商字符  │
        │      protocol: "openai/chat"      ◄── 重复配置 1            │
        │      contextWindow: 1048576                                 │
        │    - id: "deepseek-v4-pro"                                  │
        │      vendor: "deepseek"           ◄── 模型反向挂载厂商字符  │
        │      protocol: "openai/chat"      ◄── 重复配置 2            │
        │      contextWindow: 1048576                                 │
        │    - id: "deepseek-chat"                                    │
        │      vendor: "deepseek"           ◄── 模型反向挂载厂商字符  │
        │      protocol: "openai/chat"      ◄── 重复配置 3            │
        │      contextWindow: 65536                                   │
        │    - id: "qwen3.8-max"                                      │
        │      vendor: "qwen"               ◄── 厂商孤岛              │
        │      protocol: "openai/chat"      ◄── 重复配置 4            │
        └──────────────────────────────┬──────────────────────────────┘
                                       │ 没有任何外键强校验
                                       │ 极易产生孤儿模型或名称错乱
                                       ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  前端运行时存储：LocalStorage -> provider_profiles           │
        ├─────────────────────────────────────────────────────────────┤
        │  {                                                          │
        │    "deepseek": {                                            │
        │      "baseUrl": "https://api.deepseek.com",                 │
        │      "apiKey": "sk-real-secret-key"                         │
        │    },                                                       │
        │    "qwen": {                                                │
        │      "baseUrl": "https://dashscope.aliyuncs.com/...",       │
        │      "apiKey": "sk-dashscope-secret"                        │
        │    }                                                        │
        │  }                                                          │
        └─────────────────────────────────────────────────────────────┘
```

#### 1.1.2 拓扑倒置引发的四大核心架构缺陷

1. **关系实体主次颠倒，配置重复度达到 O(N)**：
   在物理现实中，“供应商（Provider）”是网络基础设施实体，拥有确定的 Base URL、通信协议（如 OpenAI 规范或 Anthropic 规范）、认证凭据、全局请求头与网络代理；而“模型（Model）”是供应商算力基础设施下提供的具体计算终端。
   Conex 历史实现将模型作为一维平铺数组（`Vec<ModelConfig>`），每个模型项反向记录一个弱类型的 `vendor: string`。这导致同一个供应商下的 20 至 50 个模型，必须在每个模型内部重复维护网络协议、方言适配参数，造成配置冗余度极高。一旦用户希望将 DeepSeek 的调用协议切换为第三方兼容聚合网关，必须遍历修改数十个模型条目，产生极大的人工出错几率。
2. **双轨存储分裂导致“裂脑（Split-Brain）”现象**：
   模型的定义记录在磁盘 `~/.conex/models.yaml` 中，而供应商的连接信息（`baseUrl` 与 `apiKey`）却由前端持久化在浏览器的 `LocalStorage`（`provider_profiles` 键）中。
   这种双轨存储打破了系统唯一真源（Single Source of Truth, SSOT）原则。当用户在不同工作区或通过外部编辑器直接修改 `models.yaml` 时，前端 `LocalStorage` 无法感知；当用户在设置面板修改服务商 Base URL 时，Rust 内核执行引擎如果直接从本地文件或静态编译单例读取配置，将导致真实网络请求向旧端点发送，产生严重的状态不同步与静默失败。
3. **缺乏 Provider 一等公民生命周期操作**：
   由于没有顶层的 `providers: Map<ProviderId, ProviderSpec>` 容器，系统无法实现供应商级别的原子操作。例如：
   - 无法对某个供应商执行“整体启用/禁用”；
   - 无法对供应商进行一键全量连通性健康巡检；
   - 无法实现供应商级别的网络代理隔离（例如要求私有部署的 Ollama 直连 `127.0.0.1`，而官方 OpenAI 走企业 SOCKS5 代理）。
4. **模型与厂商弱关联脆弱性**：
   由于 `vendor` 字段仅为自由字符串，当用户拼写笔误（如将 `"deepseek"` 误写为 `"deep-seek"` 或 `"DeepSeek"`）时，该模型将瞬间沦为无法匹配凭据和 Base URL 的“孤儿模型”，在调用时抛出未捕获的空指针或缺少凭据异常。

---

### 1.2 凭据生命周期的割裂与安全合规隐患

在现存系统中，API Key 等商业大模型调用凭据的存储、传递和使用链路缺乏统一生命周期契约，安全防护存在巨大代差。

```
【当前凭据流转与暴露风险链路】

    [用户输入 API Key] ──▶ [前端 React 响应式内存] ──▶ [LocalStorage 明文落盘] ◄── [高危：XSS/依赖劫持风险]
                                     │
                                     ▼
                            [Tauri IPC 明文传输]
                                     │
                                     ▼
                          [仅限部分官方厂商调用 DPAPI]
                          [自定义服务商完全降级为明文文本]
```

1. **敏感凭据散落前端渲染进程**：
   在前端设置页面中，API Key 直接保存在前端 Pinia/Redux 状态与 `window.localStorage` 中。现代桌面应用通常集成了大量前端 NPM 依赖，一旦任何三方依赖存在安全隐患或渲染进程遭受跨站脚本攻击，所有高价值模型的高额账单凭据将彻底暴露。
2. **DPAPI 安全插槽覆盖不全**：
   虽然后端底层提供了基于 Windows DPAPI / macOS Keychain 的 `config_secret_set` 接口，但这一能力目前被硬编码绑定在少数内置服务商（OpenAI, Anthropic 等）的特定通道中。一旦用户通过自定义服务商面板添加企业私有模型、国内百炼千问或聚合网关，系统立即退化为明文文本存储，安全基线瞬间击穿。
3. **完全缺失动态凭据解析引擎（Dynamic Secret Resolvers）**：
   对标 `@earendil-works/pi-ai` 等工业级标杆，现代 AI 工具链普遍原生支持环境变量插值（如 `"$OPENAI_API_KEY"`）以及基于安全 CLI 的凭据动态读取（如 `"!op read op://vault/openai/key"` 从 1Password 动态获取，或 `"!security find-generic-password"` 从系统钥匙串读取）。Conex 目前完全不具备这一能力，强迫开发者必须在 UI 界面中明文粘贴凭证，无法满足现代企业基础设施的安全审计要求。

---

### 1.3 模型探测（Probe）与自愈合流机制的断裂

Conex 目前在 Rust 侧虽然内置了 `probe_scan_models_core` 探测能力，能够向 `/v1/models` 端点发起 GET 请求获取模型列表，但该能力目前处于“孤岛化”状态，无法与用户的个性化配置形成良性闭环。

1. **探测覆盖的破坏性冲突**：
   如果将探测到的远程模型直接写回本地，会全量覆盖用户已经手动调优的元数据。例如：用户针对 `deepseek-v4-flash` 手动调整了 `contextWindow: 1048576`、补充了思考档位 `levels: { low: "low", high: "high" }` 并配置了优惠费率。如果系统执行无脑覆写，用户的个人数字资产将在一次点击中灰飞烟灭。
2. **缺乏不可变基线与三方合流（Three-Way Reconciliation）**：
   当前系统没有建立“上游探测发现集合 vs 本地定制配置集合”的差量状态机。当服务商上线了新的实验模型（如 `deepseek-v4-flash-vision-exp`）时，系统无法以最小侵入的方式执行“增量追加”；当服务商下线了废弃模型时，系统无法进行软标记提示，导致用户配置腐化滞后。

---

### 1.4 多网络通道与自定义 Headers 治理缺失

随着多模型聚合层（OpenRouter、Vercel AI Gateway、Portkey、Cloudflare AI Gateway）的普及，模型调用对 HTTP 协议头的要求日益严苛：

1. **聚合网关特异性 Header 无法下发**：
   - OpenRouter 平台强制要求通过 `HTTP-Referer` 和 `X-Title` 标识调用来源，以便在公开排行榜中展示应用并优化路由分配；
   - Portkey 要求 `x-portkey-api-key`、`x-portkey-virtual-key` 进行多租户网关治理；
   - 企业私有网关通常要求 `X-Corporate-Proxy-Auth` 或特定的灰度发布标记。
   当前 Conex 完全没有在 Provider 级或 Model 级提供自定义 Headers 的字段建模与传递机制，导致用户完全无法使用这些现代基础设施。
2. **代理路由粒度缺失**：
   无法针对具体服务商单独指定 SOCKS5 或 HTTP 代理。在混合网络环境下，开发者通常需要让访问 OpenAI 走海外代理端口，而访问国内阿里云百炼、智谱或本地 Ollama 直连内网。全局代理机制造成了网络访问的严重冲突与低效。

---

### 1.5 前端设置中枢的人体工学灾难与视觉噪音（议题 E 核心痛点）

前端交互界面的设计缺陷直接导致了用户体验的严重滑坡，尤其是在模型列表呈现与抽屉编辑场景下：

```
【当前单模型抽屉协议配置的严重视觉噪音与操作累赘】

   服务商：DeepSeek (已设置 BaseURL: https://api.deepseek.com)
   │
   ├─▼ [展开抽屉] deepseek-v4-flash
   │    ├─ 模型 ID: deepseek-v4-flash
   │    ├─ 友好名称: DeepSeek V4 Flash
   │    ├─ 调用协议 (Protocol): [ OpenAI Chat Completions ▼ ] ◄── 严重视觉冗余（第 1 次看到）
   │    ├─ 上下文窗口: 1,048,576
   │    └─ 最大输出 Token: 384,000
   │
   ├─▼ [展开抽屉] deepseek-v4-pro
   │    ├─ 模型 ID: deepseek-v4-pro
   │    ├─ 友好名称: DeepSeek V4 Pro
   │    ├─ 调用协议 (Protocol): [ OpenAI Chat Completions ▼ ] ◄── 严重视觉冗余（第 2 次看到）
   │    ├─ 上下文窗口: 1,048,576
   │    └─ 最大输出 Token: 384,000
   │
   ├─▼ [展开抽屉] deepseek-chat
   │    ├─ 模型 ID: deepseek-chat
   │    ├─ 友好名称: DeepSeek V3
   │    ├─ 调用协议 (Protocol): [ OpenAI Chat Completions ▼ ] ◄── 严重视觉冗余（第 3 次看到）
   │    └─ ...
   │
   └─ ... (数十个模型每个抽屉都包含该控件，导致抽屉垂直空间浪费 30%，产生强烈认知负担)
```

1. **单模型配置抽屉（`ModelConfigPanel`）极度臃肿，人体工学恶化**：
   在现行界面中，展开任意一个具体模型的配置面板，都会在醒目位置显示“调用协议 (Protocol)”下拉选择器（OpenAI Chat / OpenAI Responses / Anthropic Messages 等）。
   在现实使用场景中，同一个供应商下的 20 到 50 个模型，**99.9% 必然使用相同的通信协议**。在每一个模型抽屉中重复渲染该控件，不仅浪费了宝贵的垂直屏幕空间，更给用户造成了强烈的认知干扰与配置焦虑，用户会反复怀疑：“我是不是每个模型都得仔细检查协议有没有选错？”
2. **供应商全局设置区首要协议语义缺失**：
   与单模型抽屉过度冗余相反，在供应商总配置区域，界面仅有 Base URL 和 API Key 输入框，却完全缺少“供应商默认通信协议（Default Protocol）”的设置入口。这使得全局默认协议无处安放，被迫散落到每一个子模型中。
3. **前端 Store 树状单轨与响应式级联断裂**：
   `modelsCatalogStore.ts` 依然沿用旧的一维数组状态机。当用户更新某个配置项时，由于缺乏规范的深层响应式更新与不可变状态替换，经常出现“设置保存成功但左侧模型选择器未刷新”的 Bug，迫使开发者频繁加入全页强刷代码，严重破坏单页应用流畅感。
4. **展示名与元数据格式化回退链路僵化**：
   `formatModelDisplayName` 与 `getModelMeta` 存在严重的硬编码短路，优先匹配历史静态 catalog，导致用户在 YAML 或设置界面修改的模型展示名（如给 `gpt-5.6-sol` 命名为“主力编程模型”）无法在顶部胶囊栏和聊天会话列表中生效，破坏了界面的可定制性。

---

## 模块二：对标 `@earendil-works/pi-ai` 优秀实践与架构差异化演进

工业级标杆 `@earendil-works/pi-ai` 在模型体系设计、多协议抽象和配置组织上达到了极高的工程水准。深入分析其源码契约与设计理念，是我们实现架构蜕变并完成本土化超越的关键。

### 2.1 标杆与 Conex 重构方案横向对比矩阵

```
┌───────────────────────────┬───────────────────────────────────────────┬───────────────────────────────────────────┐
│ 比较维度                  │ @earendil-works/pi-ai (行业权威标杆)      │ Conex 重构后方案 (差异化超越与演进)       │
├───────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────┤
│ 1. 供应商与模型拓扑       │ 顶层 providers: Record<ProviderId, Config> │ 顶层树状 providers: BTreeMap<Id, Spec>，  │
│                           │ Provider 挂载 models 数组，结构清晰。     │ 跨 Rust 与 TypeScript 强类型 100% 同构。  │
├───────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────┤
│ 2. 通信协议继承机制       │ Provider 声明全局 api，Model.api 局部覆盖；│ 三级继承状态机：                          │
│                           │ 决议方式：model.api ?? provider.api。     │ Model.protocol ≻ Provider.protocol ≻ 兜底 │
│                           │                                           │ 前端 UI 协议顶置，单模型抽屉彻底瘦身。    │
├───────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────┤
│ 3. 凭据解析与生命周期     │ 支持 "$VAR" 环境变量与 "!cmd" 执行命令，  │ 三位一体：OS 原生 DPAPI 槽隔离 +          │
│                           │ 纯运行时文本插值，不包含桌面安全槽。      │ 运行时 TokenRef 掩码化 + 动态解算支持。    │
├───────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────┤
│ 4. 界面交互与人体工学     │ 纯 CLI 交互，通过 models.json 与命令控制， │ 工业级 GUI 瘦身：Provider 置顶协议选择条，│
│                           │ 无图形化抽屉与视觉布局考量。              │ 单模型抽屉 80% 视觉瘦身，消除认知疲劳。   │
├───────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────┤
│ 5. 模型发现与自愈合流     │ 静态配置文件模式，无上游动态探测与合并。  │ 独创 Probe Upsert & Reconciliation 算法：  │
│                           │                                           │ 探测新模型平滑追加，用户微调元数据永久锁定│
├───────────────────────────┼───────────────────────────────────────────┼───────────────────────────────────────────┤
│ 6. 方言兼容 (Compat) 矩阵 │ 11 类 thinkingFormat，精细化支持         │ 全面对标并兼容 pi-ai 的 compat 规范，     │
│                           │ supportsDeveloperRole / maxTokensField 等 │ 结合国内模型生态补充双轨双币与专有方言。  │
└───────────────────────────┴───────────────────────────────────────────┴───────────────────────────────────────────┘
```

### 2.2 pi-ai 的核心设计精髓解构

在 `reference/pi/packages/coding-agent/docs/models.md` 与 `reference/pi/packages/ai/src/types.ts` 中，pi-ai 的架构设计体现了以下三个核心支柱：

#### 1. Provider 为纲的顶层声明
在 pi-ai 中，任何模型均不得脱离 Provider 孤立存在：
```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```
Provider 统一承担了网络连接器（Connector）的职责，模型仅仅定义自身的算力与容量属性。

#### 2. 完备的方言兼容层（Compat Matrix）
面对 OpenAI 兼容生态的碎片化，pi-ai 没有采用盲目猜测 URL 的脆弱做法，而是在 `compat` 对象中显式定义了精细的行为控制开关：
- `supportsDeveloperRole`: 区分新一代 reasoning 模型是使用 `developer` 角色还是回退至 `system` 角色；
- `maxTokensField`: 区分使用 `max_completion_tokens` 还是历史上的 `max_tokens`；
- `supportsUsageInStreaming`: 控制流式输出是否附加 `stream_options: { include_usage: true }`；
- `thinkingFormat`: 支持 `deepseek`、`qwen`、`openrouter`、`together`、`baseten`、`zai`、`chat-template` 等 11 种方言格式；
- `thinkingTokenBudgetField`: 明确指定截断推理预算的字段名（如 vLLM 的 `thinking_token_budget` 或百炼的 `thinking_budget`）。

#### 3. 动态值解析引擎（Value Resolution）
pi-ai 的 `apiKey` 与 `headers` 允许配置 `"$ENV_VAR"` 或 `"!command"`。在请求构建时，解析器自动完成求值：
- 以 `!` 开头的字符串被识别为外部 CLI 命令，执行并提取 stdout（如对接 1Password CLI）；
- 以 `$` 开头的字符串被自动替换为宿主环境变量；
- `$$` 与 `$!` 提供转义支持。

---

### 2.3 Conex 的架构差异化超越与演进路径

在吸取 pi-ai 卓越设计的同时，Conex 针对桌面客户端宿主环境与生产级 GUI 交互进行了全面超越：

1. **桌面宿主级安全保护网**：
   pi-ai 作为终端 CLI 工具，其动态执行命令与明文读取环境变量适用于开发者单机终端。而在具有图形界面的 Conex 桌面应用中，我们引入了基于 OS DPAPI 的 **安全凭据插槽（SecretSlot）**。
   - 前端永远只接触到 `credentialRef: "secret://provider/deepseek/api_key"` 这种强类型引用句柄与脱敏掩码（如 `sk-•••••••38fA`）；
   - 真实敏感凭证仅在 Rust 内核执行网络调用的微秒级时间窗口内，在受保护内存中解密并组装进 HTTP 请求，使用完毕后立即执行零化（Zeroize），彻底杜绝前端环境下的凭证窃取。
2. **革命性的人体工学瘦身（议题 E 突破）**：
   pi-ai 依赖手写 JSON，没有图形界面的空间挤压与视觉负荷问题。而 Conex 拥有完整的服务商与模型配置界面。
   我们创新地推行 **“协议顶置 + 模型抽屉极致瘦身”**：
   - 将调用协议提升至 Provider 设置面板的视觉第一梯队（位于 Base URL 和 API Key 正下方、模型列表正上方）；
   - 具体模型的配置抽屉彻底剥离协议下拉框，模型抽屉高度缩减 40% 以上，消除成倍的视觉冗余与选择疲劳；
   - 仅在极少数特异模型（如 OpenAI 旗下的 `gpt-5.6-sol` 必须走 `openai/responses` 协议，而 OpenAI 厂商总协议为 `openai/chat`）中，通过底部高级折叠区提供显式局部覆盖通道。
3. **闭环自愈模型探测算法（Reconciliation Loop）**：
   超越 pi-ai 的纯静态模式，Conex 实现了带有资产保护锁的智能 Probe 合流算法。当探测到服务商新增模型时，系统能够自动基于模型 ID 推断最佳初始规格并平滑追加，同时绝对冻结并保护用户已微调的全部元数据。

---

## 模块三：完整的强类型数据结构设计（Rust struct & TS interface）

为保证内核引擎与渲染进程的绝对契约一致，本模块定义跨语言严格同构的强类型规范。包含完整的 Serde 序列化标注、TypeScript 接口契约与详尽注释。

### 3.1 Rust 核心强类型定义（`crates/conex-models/src/schema.rs`）

```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// ============================================================================
/// models.yaml 物理配置文件的根节点强类型定义 (绝对唯一真源 SSOT)
/// ============================================================================
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsRootYaml {
    /// 配置文件架构协议版本，当前版本锁定为 "2.0"
    pub version: String,
    /// 供应商映射集合，以服务商唯一标识符（如 "deepseek", "openai", "qwen"）为键
    /// 使用 BTreeMap 确保在持久化回 YAML 时保持严格的字典序排列，消除非确定性 Git 差异
    pub providers: BTreeMap<String, ProviderSpec>,
}

/// ============================================================================
/// 供应商（Provider）顶层规格定义
/// ============================================================================
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// 服务商在 UI 界面中呈现的友好全称（如 "DeepSeek 深度求索", "阿里云百炼"）
    pub display_name: String,
    /// 服务商的 HTTP/HTTPS API 访问基地址（如 "https://api.deepseek.com"）
    pub base_url: String,
    /// 供应商层级声明的首要全局默认通信协议（如 "openai/chat", "anthropic/messages"）
    /// 该供应商下挂载的所有子模型在未显式覆盖时，100% 自动继承此协议
    pub protocol: String,
    /// OS 级安全凭据插槽引用标识（如 "secret://provider/deepseek/api_key"）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_ref: Option<String>,
    /// 可选的明文 API Key（仅在测试环境或免密代理时使用，生产环境强烈推荐使用 credential_ref）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 是否在向该服务商发起请求时自动注入 "Authorization: Bearer <token>" 标头，默认值为 true
    #[serde(default = "default_true")]
    pub auth_header: bool,
    /// 供应商层级全局生效的自定义 HTTP 标头映射（如 OpenRouter 的 HTTP-Referer、X-Title 等）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// 供应商专属的独立网络代理地址（如 "socks5://127.0.0.1:7890"），优先级高于系统全局代理
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,
    /// 供应商全局方言兼容性配置包，子模型自动继承并支持深度合并
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<ProviderCompatSpec>,
    /// 该服务商旗下挂载的具体模型规格列表
    #[serde(default)]
    pub models: Vec<ModelSpec>,
}

/// ============================================================================
/// 具体模型（Model）规格定义
/// ============================================================================
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    /// 模型在底层网络协议通信中的真实标识符（如 "deepseek-v4-flash", "gpt-5.6-sol"）
    pub id: String,
    /// 界面呈现的友好模型名称（如 "DeepSeek V4 Flash"）
    pub display_name: String,
    /// 模型级显式协议覆盖通道。
    /// 99.9% 的常规模型该值为 None，此时直接继承 ProviderSpec.protocol；
    /// 仅当特定模型必须使用特异协议时（如 OpenAI 厂商内仅单个模型使用 responses），显式设置为 Some("openai/responses")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// 上下文窗口容量总大小（Token 数，例如 1048576 代表 1M 上下文）
    pub context_window: u64,
    /// 单次请求允许生成的最大输出 Token 数量（例如 65536 或 384000）
    pub max_output_tokens: u64,
    /// 输入模态类型白名单数组（例如 ["text"] 或 ["text", "image", "audio", "video", "pdf"]）
    #[serde(default = "default_text_input")]
    pub input_modalities: Vec<String>,
    /// 思考与深度推理能力建模规格
    #[serde(default)]
    pub thinking: ThinkingSpec,
    /// 计量与计费标准（选填。未填写时，界面完全静默，杜绝“0元提示”或强行报错干扰）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricingSpec>,
    /// 模型专属的方言兼容性覆盖参数（可覆盖供应商同名字段）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compat: Option<ProviderCompatSpec>,
    /// 模型专属的采样参数（如 temperature, top_p, top_k 等，透传至网络载荷）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sampling_params: BTreeMap<String, serde_json::Value>,
    /// 模型专属的附加 HTTP 标头（与 ProviderSpec.headers 深度合并，同名键模型优先）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

/// ============================================================================
/// 思考推理（Thinking / Reasoning）能力规格
/// ============================================================================
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingSpec {
    /// 该模型是否支持思考推理能力
    pub enabled: bool,
    /// 是否为强制思考模型（Mandatory）。
    /// 若为 true，前端 UI 彻底折叠隐藏 "Off" 选项，用户无法关闭思考；
    /// 若为 false，前端允许用户在档位菜单中选择 "Off" 关闭思考
    #[serde(default)]
    pub mandatory: bool,
    /// 默认启用的思考强度档位（如 "medium" 或 "high"）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_level: Option<String>,
    /// 三态思考档位映射表：
    /// 键为纯英文标准档位："minimal", "low", "medium", "high", "xhigh", "max", "off"；
    /// 值为 Option<String>：
    /// - Some("wire_val"): 表示支持该档位，并在网络请求中发送 "wire_val"；
    /// - None / 显式 null: 表示该模型不支持该档位，前端 UI 彻底不渲染该选项；
    /// 特别约定：若包含 "off": null，等价于 mandatory: true
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub levels: BTreeMap<String, Option<String>>,
}

impl Default for ThinkingSpec {
    fn default() -> Self {
        Self {
            enabled: false,
            mandatory: false,
            default_level: None,
            levels: BTreeMap::new(),
        }
    }
}

/// ============================================================================
/// 计量与计费规格模型（支持双币系统与灵活单位）
/// ============================================================================
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricingSpec {
    /// 结算货币类型："USD"（美元）或 "CNY"（人民币）
    pub currency: String,
    /// 计费单位："per_1m_tokens"（每百万 Token）或 "per_image"（按张计费）
    pub unit: String,
    /// 普通输入（Prompt）单价
    pub input: f64,
    /// 生成输出（Completion）单价
    pub output: f64,
    /// KV 缓存命中读取（Cache Read）单价
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    /// KV 缓存创建写入（Cache Write）单价
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// ============================================================================
/// 协议方言兼容性参数包（全面对标 pi-ai 的 Compat 规范）
/// ============================================================================
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCompatSpec {
    /// 思考/推理格式规范：支持 "openai", "openrouter", "deepseek", "together",
    /// "baseten", "zai", "qwen", "chat-template", "qwen-chat-template", "string-thinking" 等
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<String>,
    /// 是否使用 developer 角色替代 system 角色（OpenAI o1/o3/gpt-5.6 依赖）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,
    /// 输出最大 Token 限制在网络请求体中的字段名："max_completion_tokens" 或 "max_tokens"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<String>,
    /// 流式响应是否支持 stream_options: { include_usage: true } 统计用量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_usage_in_streaming: Option<bool>,
    /// 工具调用是否支持严格模式（Strict JSON Schema: { "strict": true }）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_strict_mode: Option<bool>,
    /// 思考 Token 上限在顶层请求体中的字段名：
    /// "thinking_token_budget" (vLLM), "thinking_budget" (Qwen/DashScope), "thinking_budget_tokens" (llama.cpp)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_token_budget_field: Option<String>,
    /// OpenRouter 路由偏好透传参数（包含 order, only, ignore, quantizations, max_price 等）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_router_routing: Option<serde_json::Value>,
    /// Vercel AI Gateway 路由偏好透传参数（包含 only, order）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vercel_gateway_routing: Option<serde_json::Value>,
}

fn default_true() -> bool {
    true
}

fn default_text_input() -> Vec<String> {
    vec!["text".to_string()]
}
```

---

### 3.2 TypeScript 契约定义（`apps/crish-desktop/src/types/models.ts`）

```typescript
/**
 * Conex 前端与 Rust 内核保持 100% 严密对齐的强类型契约
 */

export type CurrencyCode = 'USD' | 'CNY';
export type PricingUnit = 'per_1m_tokens' | 'per_image';
export type CanonicalThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'off';

/** 计费模型规格 */
export interface ModelPricingSpec {
  currency: CurrencyCode;
  unit: PricingUnit;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** 思考推理能力模型 */
export interface ThinkingSpec {
  enabled: boolean;
  mandatory: boolean;
  defaultLevel?: CanonicalThinkingLevel | string;
  levels: Record<string, string | null>;
}

/** 协议方言兼容参数 */
export interface ProviderCompatSpec {
  thinkingFormat?: string;
  supportsDeveloperRole?: boolean;
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens';
  openRouterRouting?: Record<string, unknown>;
  vercelGatewayRouting?: Record<string, unknown>;
}

/** 单个模型规格 */
export interface ModelSpec {
  id: string;
  displayName: string;
  /** 模型级显式协议覆盖；未定义时完全继承所属 Provider 的 protocol */
  protocol?: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputModalities: string[];
  thinking: ThinkingSpec;
  pricing?: ModelPricingSpec;
  compat?: ProviderCompatSpec;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** 供应商规格 */
export interface ProviderSpec {
  displayName: string;
  baseUrl: string;
  /** 供应商首要核心总协议（默认全部模型自动继承） */
  protocol: string;
  credentialRef?: string;
  apiKey?: string;
  authHeader: boolean;
  headers: Record<string, string>;
  proxyUrl?: string;
  compat?: ProviderCompatSpec;
  models: ModelSpec[];
}

/** 根配置文件结构 */
export interface ModelsRootYaml {
  version: string;
  providers: Record<string, ProviderSpec>;
}

/** 经过协议决议与层级扁平化计算后，供前端视图与会话快速高效检索的计算模型实体 */
export interface ResolvedModelEntry {
  /** 全局复合主键：`${providerId}:${modelId}` */
  compositeId: string;
  providerId: string;
  providerDisplayName: string;
  modelId: string;
  displayName: string;
  baseUrl: string;
  /** 经过三级继承决议计算得出的最终执行通信协议 */
  effectiveProtocol: string;
  /** 标记该协议是由模型显式覆盖，还是继承自供应商总协议 */
  isProtocolOverridden: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  thinking: ThinkingSpec;
  pricing?: ModelPricingSpec;
  headers: Record<string, string>;
  compat: ProviderCompatSpec;
}

/** 前端状态中枢 ModelsCatalogStore 的全量状态契约 */
export interface ModelsCatalogState {
  /** 磁盘 YAML 的实时不可变内存镜像 */
  rootConfig: ModelsRootYaml | null;
  /** 计算出的高效检索列表 */
  resolvedModels: ResolvedModelEntry[];
  /** 当前选中的服务商 ID */
  selectedProviderId: string | null;
  /** 当前加载状态 */
  isLoading: boolean;
  /** 是否存在未落盘的脏数据 */
  isDirty: boolean;
  /** 最近一次探测扫描报告 */
  lastProbeReport: ModelProbeSummary | null;
}

/** 探测差量合流摘要信息 */
export interface ModelProbeSummary {
  providerId: string;
  scannedAt: number;
  totalFound: number;
  addedCount: number;
  retainedCount: number;
  deprecatedCount: number;
  newDiscoveredModels: string[];
}
```

---

## 模块四：底层协议 Wire 格式与通信交互设计

本模块呈现物理存储、真实网络请求与跨进程 IPC 调用的实际 JSON/YAML Wire 报文，确保契约可复核、可测试。

### 4.1 典型供应商配置的物理 YAML Wire 格式样例

在物理文件 `~/.conex/models.yaml` 中，各典型厂商的真实配置展示如下：

```yaml
version: "2.0"
providers:
  # ============================================================================
  # 1. DeepSeek (标准 Chat 协议 + 原生 deepseek 思考方言)
  # ============================================================================
  deepseek:
    displayName: "DeepSeek 官方"
    baseUrl: "https://api.deepseek.com"
    protocol: "openai/chat"            # 全族默认继承 Chat 协议
    authHeader: true
    credentialRef: "secret://provider/deepseek/api_key"
    compat:
      thinkingFormat: "deepseek"
      supportsDeveloperRole: false
      maxTokensField: "max_tokens"
    models:
      - id: "deepseek-v4-flash"
        displayName: "DeepSeek V4 Flash"
        contextWindow: 1048576
        maxOutputTokens: 384000
        inputModalities: ["text"]
        thinking:
          enabled: true
          mandatory: true              # 强制思考：UI 彻底折叠隐藏 Off
          defaultLevel: "medium"
          levels:
            minimal: "minimal"
            low: "low"
            medium: "medium"
            high: "high"
            xhigh: "xhigh"
            max: "max"
        pricing:
          currency: "USD"
          unit: "per_1m_tokens"
          input: 0.44
          output: 1.32
          cacheRead: 0.014

      - id: "deepseek-chat"
        displayName: "DeepSeek V3"
        contextWindow: 65536
        maxOutputTokens: 8192
        inputModalities: ["text"]
        thinking:
          enabled: false               # 非思考模型：UI 彻底隐藏思考胶囊

  # ============================================================================
  # 2. 阿里云百炼 (国内站双币支持 + enable_thinking 顶层方言)
  # ============================================================================
  qwen:
    displayName: "阿里云百炼"
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    protocol: "openai/chat"
    credentialRef: "secret://provider/qwen/api_key"
    compat:
      thinkingFormat: "qwen"
    models:
      - id: "qwen3.8-max"
        displayName: "Qwen3.8 Max"
        contextWindow: 1000000
        maxOutputTokens: 65536
        inputModalities: ["text"]
        thinking:
          enabled: true
          mandatory: false             # 可选思考：UI 允许用户选择 Off
          defaultLevel: "high"
          levels:
            low: "low"
            medium: "medium"
            high: "high"
        pricing:
          currency: "CNY"              # 人民币结算 (¥)
          unit: "per_1m_tokens"
          input: 12.0
          output: 36.0
          cacheRead: 2.4

  # ============================================================================
  # 3. OpenAI 官方 (演示模型级协议覆盖通道)
  # ============================================================================
  openai:
    displayName: "OpenAI 官方"
    baseUrl: "https://api.openai.com/v1"
    protocol: "openai/chat"            # 总协议为 Chat Completions
    credentialRef: "secret://provider/openai/api_key"
    models:
      - id: "gpt-5.6-sol"
        displayName: "GPT-5.6 Sol"
        protocol: "openai/responses"   # 【局部覆盖】：该模型强制走 Responses 协议！
        contextWindow: 1050000
        maxOutputTokens: 128000
        inputModalities: ["text", "image", "file"]
        thinking:
          enabled: true
          mandatory: false
          defaultLevel: "medium"
          levels:
            low: "low"
            medium: "medium"
            high: "high"
            xhigh: "xhigh"
            max: "max"

      - id: "gpt-5-mini"
        displayName: "GPT-5 Mini"
        # 未指定 protocol：自动继承父级 "openai/chat"
        contextWindow: 400000
        maxOutputTokens: 128000
        inputModalities: ["text", "image"]
        thinking:
          enabled: false

  # ============================================================================
  # 4. OpenRouter (演示网关自定义 Headers 与路由透传)
  # ============================================================================
  openrouter:
    displayName: "OpenRouter 聚合路由"
    baseUrl: "https://openrouter.ai/api/v1"
    protocol: "openai/chat"
    credentialRef: "secret://provider/openrouter/api_key"
    headers:
      HTTP-Referer: "https://conex.crish.ai"
      X-Title: "Conex Workbench"
    compat:
      openRouterRouting:
        allow_fallbacks: true
        require_parameters: false
        data_collection: "deny"
        zdr: true
    models:
      - id: "anthropic/claude-sonnet-5"
        displayName: "Claude Sonnet 5 (via OpenRouter)"
        contextWindow: 1000000
        maxOutputTokens: 128000
        inputModalities: ["text", "image"]
        thinking:
          enabled: true
          mandatory: false
          defaultLevel: "high"
          levels:
            low: "low"
            medium: "medium"
            high: "high"
```

---

### 4.2 前端与 Rust 壳层 IPC 通信 Wire 报文

所有前端交互均通过 Tauri IPC 与后端桥接，绝无明文泄漏与直读直写。

#### 1. 读取全量配置 (`models_yaml_read`)
- **IPC 路由**：`invoke('models_yaml_read')`
- **Wire 响应结果 (JSON)**：
```json
{
  "version": "2.0",
  "providers": {
    "deepseek": {
      "displayName": "DeepSeek 官方",
      "baseUrl": "https://api.deepseek.com",
      "protocol": "openai/chat",
      "credentialRef": "secret://provider/deepseek/api_key",
      "authHeader": true,
      "headers": {},
      "models": [
        {
          "id": "deepseek-v4-flash",
          "displayName": "DeepSeek V4 Flash",
          "protocol": null,
          "contextWindow": 1048576,
          "maxOutputTokens": 384000,
          "inputModalities": ["text"],
          "thinking": {
            "enabled": true,
            "mandatory": true,
            "defaultLevel": "medium",
            "levels": {
              "minimal": "minimal",
              "low": "low",
              "medium": "medium",
              "high": "high",
              "xhigh": "xhigh",
              "max": "max"
            }
          }
        }
      ]
    }
  }
}
```

#### 2. 保存全量配置 (`models_yaml_write`)
- **IPC 路由**：`invoke('models_yaml_write', { payload })`
- **Wire 请求载荷 (JSON)**：
```json
{
  "payload": {
    "version": "2.0",
    "providers": {
      "deepseek": {
        "displayName": "DeepSeek 官方",
        "baseUrl": "https://api.deepseek.com",
        "protocol": "openai/chat",
        "credentialRef": "secret://provider/deepseek/api_key",
        "authHeader": true,
        "headers": {},
        "models": [
          {
            "id": "deepseek-v4-flash",
            "displayName": "DeepSeek V4 Flash 旗舰版",
            "protocol": null,
            "contextWindow": 1048576,
            "maxOutputTokens": 384000,
            "inputModalities": ["text"],
            "thinking": {
              "enabled": true,
              "mandatory": true,
              "defaultLevel": "high",
              "levels": { "low": "low", "high": "high" }
            }
          }
        ]
      }
    }
  }
}
```
- **Wire 响应结果 (JSON)**：
```json
{
  "success": true,
  "backupPath": "~/.conex/models.yaml.bak.20260907_143000",
  "savedAt": 1788712390123
}
```

#### 3. 执行模型自愈探测与差量合流 (`probe_and_reconcile_provider_models`)
- **IPC 路由**：`invoke('probe_and_reconcile_provider_models', { providerId: 'deepseek', dryRun: false })`
- **Wire 响应结果 (JSON)**：
```json
{
  "providerId": "deepseek",
  "scannedAt": 1788712410000,
  "totalFound": 5,
  "addedCount": 3,
  "retainedCount": 2,
  "deprecatedCount": 0,
  "newDiscoveredModels": [
    "deepseek-v4-pro",
    "deepseek-v4-flash-vision-exp",
    "deepseek-v3.2"
  ]
}
```

---

## 模块五：核心状态转移机与算法伪代码

本模块展示三级协议决议、三方合流自愈、零等待热重载以及凭据安全解绑四大核心算法的精确逻辑。

### 5.1 三级协议决议状态机（Effective Protocol Resolution Algorithm）

三级协议决议算法是模型执行生命周期中的“第一道门禁”，确保网络层绝对获得确定的协议端点。

#### 数学决议公式：
$$\text{EffectiveProtocol} = \text{ModelSpec.protocol} \succ \text{ProviderSpec.protocol} \succ \text{"openai/chat"}$$

```
                ┌─────────────────────────────┐
                │ 开始：决议特定模型的通信协议 │
                └──────────────┬──────────────┘
                               │
                               ▼
                /─────────────────────────────\
               <  ModelSpec.protocol 是否为    >
               <  Some 且 Trim 后非空字符串?   >
                \─────────────────────────────/
                               │
                      ┌────────┴────────┐
                     Yes                No
                      │                 │
                      ▼                 ▼
          ┌──────────────────────┐  /─────────────────────────────\
          │ 采用 Model 显式覆盖  │ <  ProviderSpec.protocol 是否   >
          │ isOverridden = true  │ <  Trim 后为非空字符串?         >
          └──────────────────────┘  \─────────────────────────────/
                                                │
                                       ┌────────┴────────┐
                                      Yes                No
                                       │                 │
                                       ▼                 ▼
                           ┌──────────────────────┐  ┌──────────────────────┐
                           │ 继承 Provider 总协议 │  │ 兜底采用标准协议     │
                           │ isOverridden = false │  │ "openai/chat"        │
                           └──────────────────────┘  │ isOverridden = false │
                                                     └──────────────────────┘
```

#### 算法 1：三级协议决议 Rust 生产级实现

```rust
/// 协议决议计算结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolResolutionResult {
    /// 最终有效的通信协议字符串
    pub effective_protocol: String,
    /// 标记是否被模型级显式覆盖
    pub is_overridden: bool,
}

/// 核心协议决议算法实现
pub fn resolve_protocol_precedence(
    provider: &ProviderSpec,
    model: &ModelSpec,
) -> ProtocolResolutionResult {
    // 1. 优先检查模型级显式局部覆盖
    if let Some(ref model_proto) = model.protocol {
        let trimmed = model_proto.trim();
        if !trimmed.is_empty() {
            return ProtocolResolutionResult {
                effective_protocol: trimmed.to_string(),
                is_overridden: true,
            };
        }
    }

    // 2. 检查供应商声明的全局主通信协议
    let provider_proto = provider.protocol.trim();
    if !provider_proto.is_empty() {
        return ProtocolResolutionResult {
            effective_protocol: provider_proto.to_string(),
            is_overridden: false,
        };
    }

    // 3. 兜底保障：回退至工业最通用协议
    ProtocolResolutionResult {
        effective_protocol: "openai/chat".to_string(),
        is_overridden: false,
    }
}
```

---

### 5.2 探测自愈三方合流算法（Probe Upsert & Reconciliation Algorithm）

针对上游网关动态拉取到的模型集合与本地已有模型集合，实施“保护用户资产不变性、智能追加新发现模型、废弃标记留痕”的三方合流状态机：

```
上游发现模型集合 (Upstream Detected)         本地已配置模型集合 (Local Configured)
        │                                             │
        ├──────────────────────┬──────────────────────┤
        │                      │                      │
    上游独有                 交集命中               本地独有
        │                      │                      │
        ▼                      ▼                      ▼
  【Action: Append】     【Action: Retain】     【Action: Deprecate】
  启发式生成基线配置       100% 冻结并保留用户     保留但在前端增加
  协议设为 None (继承)     手动调整的展示名、     下线警告标识，
  平滑追加至列表尾部       思考档位与自定上下文   禁止物理直接删除
```

#### 算法 2：模型探测合流自愈算法实现

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct ReconciliationReport {
    pub provider_id: String,
    pub upstream_count: usize,
    pub retained_model_ids: Vec<String>,
    pub appended_model_ids: Vec<String>,
    pub deprecated_model_ids: Vec<String>,
    pub reconciled_provider_spec: ProviderSpec,
}

pub fn reconcile_provider_models_algorithm(
    provider_id: &str,
    mut existing_spec: ProviderSpec,
    upstream_model_ids: Vec<String>,
) -> ReconciliationReport {
    let mut retained_ids = Vec::new();
    let mut appended_ids = Vec::new();
    let mut deprecated_ids = Vec::new();
    let mut final_model_list = Vec::new();

    // 将现有模型转为 ID -> Spec 映射表，保持检索复杂度 O(1)
    let mut existing_map: BTreeMap<String, ModelSpec> = existing_spec
        .models
        .into_iter()
        .map(|m| (m.id.clone(), m))
        .collect();

    // 1. 处理上游探测发现的模型列表
    for upstream_id in &upstream_model_ids {
        if let Some(existing_model) = existing_map.remove(upstream_id) {
            // 【不变性法则】：本地已有，100% 保留用户自定义的展示名、上下文容量、思考档位！
            retained_ids.push(upstream_id.clone());
            final_model_list.push(existing_model);
        } else {
            // 【智能追加】：新发现模型，根据模型名称特征启发式生成推荐初始配置
            let new_model = generate_heuristic_model_spec(upstream_id);
            appended_ids.push(upstream_id.clone());
            final_model_list.push(new_model);
        }
    }

    // 2. 处理本地剩余模型（上游已不返回，可能下线）：绝不物理抹除，保留但记录为 deprecated
    for (orphan_id, orphan_spec) in existing_map {
        deprecated_ids.push(orphan_id);
        final_model_list.push(orphan_spec);
    }

    let upstream_count = upstream_model_ids.len();
    existing_spec.models = final_model_list;

    ReconciliationReport {
        provider_id: provider_id.to_string(),
        upstream_count,
        retained_model_ids: retained_ids,
        appended_model_ids: appended_ids,
        deprecated_model_ids: deprecated_ids,
        reconciled_provider_spec: existing_spec,
    }
}

/// 根据模型 ID 智能启发式推导初始配置
fn generate_heuristic_model_spec(model_id: &str) -> ModelSpec {
    let lower = model_id.to_lowercase();
    let is_reasoning = lower.contains("reasoner") || lower.contains("r1") || lower.contains("o1") || lower.contains("o3");
    let is_vision = lower.contains("vision") || lower.contains("vl") || lower.contains("image");

    let mut modalities = vec!["text".to_string()];
    if is_vision {
        modalities.push("image".to_string());
    }

    let mut thinking = ThinkingSpec::default();
    if is_reasoning {
        thinking.enabled = true;
        thinking.mandatory = false;
        thinking.default_level = Some("medium".to_string());
        thinking.levels.insert("low".to_string(), Some("low".to_string()));
        thinking.levels.insert("medium".to_string(), Some("medium".to_string()));
        thinking.levels.insert("high".to_string(), Some("high".to_string()));
    }

    // 上下文推导：默认 128K，长文本模型推导 1M
    let context_window = if lower.contains("1m") || lower.contains("flash") || lower.contains("pro") {
        1048576
    } else {
        131072
    };

    ModelSpec {
        id: model_id.to_string(),
        display_name: format_friendly_name(model_id),
        protocol: None, // 缺省，自动继承父级 Provider
        context_window,
        max_output_tokens: 16384,
        input_modalities: modalities,
        thinking,
        pricing: None,
        compat: None,
        sampling_params: BTreeMap::new(),
        headers: BTreeMap::new(),
    }
}

fn format_friendly_name(id: &str) -> String {
    // 例如 "deepseek-v4-flash" -> "Deepseek V4 Flash"
    id.split(&['-', '_', '/'][..])
        .map(|s| {
            let mut c = s.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
```

---

### 5.3 内核 RCU 原子替换与零等待热重载状态机

为保证用户在设置界面保存 `models.yaml` 时，系统内并发运行的数百个多 Agent 任务与正在流式传输的会话零中断，采用基于 `ArcSwap` 的无锁 RCU（Read-Copy-Update）原子发布状态机：

```
[UI 保存修改] ──▶ [Tauri IPC: models_yaml_write]
                        │
                        ▼
            [1. Schema 强类型与无环校验] ──(校验失败)──▶ 返回结构化错误 (无状态破坏)
                        │
                     (校验成功)
                        │
                        ▼
            [2. 物理文件写入备份 models.yaml.bak]
                        │
                        ▼
            [3. 写入临时文件 models.yaml.tmp]
                        │
                        ▼
            [4. 物理原子 Rename 替换 models.yaml]
                        │
                        ▼
            [5. 内存原子替换：ArcSwap::store(Arc::new(new_catalog))]
                 ▲                    │
                 │ 旧读取者继续持有旧 Arc  │ 新发起请求立即获得新 Arc
                 │ 零卡顿零中断          │ 毫秒级生效
                        │
                        ▼
            [6. 发送系统总线广播: Event("models_catalog_reloaded")]
                        │
                        ▼
            [7. 前端 Store 局部响应式刷新 UI]
```

---

### 5.4 凭据安全插槽与 DPAPI 掩码生命周期状态机

```
【凭据录入、保存与运行时解密闭环】

1. 用户在前端录入 API Key: "sk-proj-abc123456789xyz"
   │
   ▼
2. 前端发起安全存取 IPC: `secret_slot_save(providerId, rawKey)`
   │
   ▼
3. Rust 壳层接收明文，立即调用 Windows DPAPI (CryptProtectData) 进行加密
   │
   ▼
4. 密文安全存入 OS 凭据库，生成句柄 "secret://provider/openai/api_key"
   │
   ▼
5. Rust 计算安全掩码: "sk-proj-•••••••••••••9xyz" 并返回前端
   │
   ▼
6. 前端 Pinia 状态仅保存掩码与句柄，绝不留存明文
   │
   ▼
7. 运行时发起真实网络请求：
   Rust 从 "secret://..." 提取密文 ──▶ DPAPI 解密出明文 ──▶ 注入 Authorization 头 ──▶ 内存即刻零化
```

---

## 模块六：精确到现有代码文件与函数签名的工程改造方案

本模块提供精确到代码文件路径、结构体定义与函数签名的详尽落地指导，作为后续编码实施的法定依据。

### 6.1 后端 Rust 模块改造清单

#### 1. 新增强类型定义模块：`crates/conex-models/src/schema.rs`
- **新建文件**：集中维护 `ModelsRootYaml`, `ProviderSpec`, `ModelSpec`, `ThinkingSpec`, `ModelPricingSpec`, `ProviderCompatSpec`。
- **导出宏与特型**：实现 `Clone`, `Debug`, `PartialEq`, `Serialize`, `Deserialize`。

#### 2. 重构配置加载与持久化服务：`crates/conex-models/src/config.rs`
- **重构结构体**：
  ```rust
  use crate::schema::ModelsRootYaml;
  use arc_swap::ArcSwap;
  use std::sync::Arc;
  use std::path::PathBuf;

  pub struct ModelCatalogService {
      root: ArcSwap<ModelsRootYaml>,
      config_path: PathBuf,
  }

  impl ModelCatalogService {
      pub fn new(config_path: PathBuf) -> Result<Self, ModelConfigError>;
      pub fn get_current(&self) -> Arc<ModelsRootYaml>;
      pub fn reload_from_disk(&self) -> Result<(), ModelConfigError>;
      pub fn save_and_publish(&self, new_root: ModelsRootYaml) -> Result<(), ModelConfigError>;
  }
  ```

#### 3. 新建协议与元数据决议引擎：`crates/conex-models/src/resolver.rs`
- **实现函数**：
  ```rust
  use crate::schema::{ModelsRootYaml, ProviderSpec, ModelSpec};

  #[derive(Debug, Clone, Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct ResolvedModelEntry {
      pub composite_id: String,
      pub provider_id: String,
      pub provider_display_name: String,
      pub model_id: String,
      pub display_name: String,
      pub base_url: String,
      pub effective_protocol: String,
      pub is_protocol_overridden: bool,
      pub context_window: u64,
      pub max_output_tokens: u64,
      pub input_modalities: Vec<String>,
      pub thinking: crate::schema::ThinkingSpec,
      pub pricing: Option<crate::schema::ModelPricingSpec>,
  }

  pub fn build_resolved_catalog(root: &ModelsRootYaml) -> Vec<ResolvedModelEntry>;
  pub fn resolve_single_model(root: &ModelsRootYaml, provider_id: &str, model_id: &str) -> Option<ResolvedModelEntry>;
  ```

#### 4. 升级模型探测与合流引擎：`crates/conex-models/src/probe.rs`
- **重构函数签名**：
  ```rust
  pub async fn probe_upstream_models(base_url: &str, api_key: Option<&str>) -> Result<Vec<String>, ProbeError>;
  pub fn reconcile_provider_models(
      provider_id: &str,
      current: ProviderSpec,
      upstream_models: Vec<String>,
  ) -> crate::algorithm::ReconciliationReport;
  ```

#### 5. 升级 Tauri IPC 指令通道：`apps/agent-workbench/src-tauri/src/commands/models.rs`
- **暴露指令**：
  ```rust
  #[tauri::command]
  pub async fn models_yaml_read(
      service: State<'_, ModelCatalogService>,
  ) -> Result<ModelsRootYaml, String>;

  #[tauri::command]
  pub async fn models_yaml_write(
      service: State<'_, ModelCatalogService>,
      payload: ModelsRootYaml,
  ) -> Result<SaveResult, String>;

  #[tauri::command]
  pub async fn probe_and_reconcile_provider_models(
      service: State<'_, ModelCatalogService>,
      provider_id: String,
      dry_run: bool,
  ) -> Result<ReconciliationSummary, String>;
  ```

---

### 6.2 前端 TypeScript / React 模块改造清单（议题 E 实施落地）

#### 1. 前端类型契约：`apps/crish-desktop/src/types/models.ts`
- 新增完整的 `ModelsRootYaml`, `ProviderSpec`, `ModelSpec`, `ThinkingSpec`, `ResolvedModelEntry` 接口。

#### 2. 前端状态中枢重写：`apps/crish-desktop/src/store/modelsCatalogStore.ts`
- 淘汰旧有的单层一维模型存储，重写为完全基于 `ModelsRootYaml` 驱动的响应式中枢：
  ```typescript
  import { defineStore } from 'pinia';
  import { invoke } from '@tauri-apps/api/core';
  import type { ModelsRootYaml, ProviderSpec, ModelSpec, ResolvedModelEntry } from '@/types/models';

  export const useModelsCatalogStore = defineStore('modelsCatalog', {
    state: () => ({
      rootConfig: null as ModelsRootYaml | null,
      resolvedModels: [] as ResolvedModelEntry[],
      selectedProviderId: null as string | null,
      isLoading: false,
      isDirty: false,
    }),
    getters: {
      currentProvider(state): ProviderSpec | null {
        if (!state.rootConfig || !state.selectedProviderId) return null;
        return state.rootConfig.providers[state.selectedProviderId] ?? null;
      },
      modelsOfCurrentProvider(state): ModelSpec[] {
        return this.currentProvider?.models ?? [];
      },
    },
    actions: {
      async loadCatalog(): Promise<void> {
        this.isLoading = true;
        try {
          const res = await invoke<ModelsRootYaml>('models_yaml_read');
          this.rootConfig = res;
          this.recomputeResolved();
          this.isDirty = false;
        } finally {
          this.isLoading = false;
        }
      },
      updateProviderProtocol(providerId: string, newProtocol: string) {
        if (!this.rootConfig?.providers[providerId]) return;
        this.rootConfig.providers[providerId].protocol = newProtocol;
        this.isDirty = true;
        this.recomputeResolved();
      },
      updateModel(providerId: string, modelIndex: number, partial: Partial<ModelSpec>) {
        const models = this.rootConfig?.providers[providerId]?.models;
        if (!models || !models[modelIndex]) return;
        Object.assign(models[modelIndex], partial);
        this.isDirty = true;
        this.recomputeResolved();
      },
      recomputeResolved() {
        if (!this.rootConfig) {
          this.resolvedModels = [];
          return;
        }
        const list: ResolvedModelEntry[] = [];
        for (const [pId, pSpec] of Object.entries(this.rootConfig.providers)) {
          for (const m of pSpec.models) {
            const isOverridden = Boolean(m.protocol && m.protocol.trim() !== '');
            const effectiveProtocol = isOverridden ? m.protocol!.trim() : pSpec.protocol.trim() || 'openai/chat';
            list.push({
              compositeId: `${pId}:${m.id}`,
              providerId: pId,
              providerDisplayName: pSpec.displayName,
              modelId: m.id,
              displayName: m.displayName || m.id,
              baseUrl: pSpec.baseUrl,
              effectiveProtocol,
              isProtocolOverridden: isOverridden,
              contextWindow: m.contextWindow,
              maxOutputTokens: m.maxOutputTokens,
              thinking: m.thinking,
              pricing: m.pricing,
              headers: { ...pSpec.headers, ...m.headers },
              compat: { ...pSpec.compat, ...m.compat },
            });
          }
        }
        this.resolvedModels = list;
      }
    }
  });
  ```

#### 3. 服务商面板重构（协议置顶）：`apps/crish-desktop/src/components/settings/ProviderSettingsPage.tsx`
- **布局核心升级**：
  在 Base URL 和 API Key 输入区域的正下方、模型列表正上方，开辟全局协议配置行：
  ```tsx
  {/* 置顶的供应商总协议选择条 */}
  <div className="provider-protocol-banner mb-6 p-4 rounded-xl bg-surface-secondary border border-border">
    <div className="flex items-center justify-between">
      <div>
        <label className="text-sm font-semibold text-text-primary block">
          供应商首要协议 (Default Protocol)
        </label>
        <p className="text-xs text-text-secondary mt-1">
          该供应商下所有模型将默认继承此通信协议。单模型抽屉中无需反复选择。
        </p>
      </div>
      <Select
        value={provider.protocol}
        onChange={(val) => store.updateProviderProtocol(providerId, val)}
        options={[
          { label: 'OpenAI Chat Completions (openai/chat)', value: 'openai/chat' },
          { label: 'OpenAI Responses API (openai/responses)', value: 'openai/responses' },
          { label: 'Anthropic Messages (anthropic/messages)', value: 'anthropic/messages' },
          { label: 'Google Interactions (google/interactions)', value: 'google/interactions' },
        ]}
      />
    </div>
  </div>
  ```

#### 4. 单模型抽屉瘦身改造：`apps/crish-desktop/src/components/settings/ModelConfigPanel.tsx`
- **彻底剥离协议控件**：
  - 将原有的 `ProtocolSelect` 从抽屉主体中**完全剔除**；
  - 抽屉主体仅保留：模型 ID、展示名、上下文滑块、最大输出 Token、思考控制；
  - 在抽屉最底部设置折叠面板 `<Accordion title="高级参数覆盖 (Advanced Overrides)">`，提供一个单选开关：“覆盖默认协议”。默认保持折叠与关闭，仅在特殊需要时展开。

#### 5. 展示名格式化器重构：`apps/crish-desktop/src/utils/modelFormatters.ts`
- **重构回退链路**：
  ```typescript
  export function formatModelDisplayName(providerId: string, modelId: string): string {
    const store = useModelsCatalogStore();
    const resolved = store.resolvedModels.find(
      (m) => m.providerId === providerId && m.modelId === modelId
    );
    if (resolved && resolved.displayName) {
      return resolved.displayName;
    }
    return modelId;
  }
  ```

---

## 模块七：存量数据迁移与向后兼容保障方案

为保障老用户现存配置资产平滑过渡至 v2.0 树状结构，必须提供无感自动检测、物理备份与原子转换。

### 7.1 自动迁移流程图解

```
[系统启动加载 ~/.conex/models.yaml]
                  │
        YAML 是否包含 version == "2.0"?
       ┌──────────┴──────────┐
      Yes                    No (识别为旧版一维结构)
       │                     │
       ▼                     ▼
 [正常加载 v2.0]     [启动自动迁移转换器 (Auto-Migrator)]
                             │
                             ▼
              [创建物理备份: models.yaml.bak.<timestamp>]
                             │
                             ▼
              [读取旧版 models 数组，按 vendor 字段聚类]
                             │
                             ▼
              [构造 ProviderSpec，推断默认协议与凭据槽]
                             │
                             ▼
              [子模型 protocol 字段置空，继承 Provider 协议]
                             │
                             ▼
              [原子覆盖写入 ~/.conex/models.yaml (version: 2.0)]
                             │
                             ▼
              [发出通知: 恭喜！配置已自动平滑升级为树状结构]
```

### 7.2 迁移转换器完整 Rust 实现（`crates/conex-models/src/migration.rs`）

```rust
use crate::schema::*;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("YAML parse error: {0}")]
    Yaml(#[from] serde_yaml::Error),
}

/// 检测并在必要时执行存量 models.yaml 向 v2.0 树状结构的自动迁移
pub fn auto_migrate_models_yaml(file_path: &Path) -> Result<bool, MigrationError> {
    if !file_path.exists() {
        return Ok(false);
    }

    let content = fs::read_to_string(file_path)?;
    let parsed_json: Value = serde_yaml::from_str(&content)?;

    // 1. 检查是否已经是 v2.0 树状结构
    if let Some(ver) = parsed_json.get("version").and_then(|v| v.as_str()) {
        if ver == "2.0" && parsed_json.get("providers").is_some() {
            return Ok(false); // 已经是最新的 v2.0 架构，无需迁移
        }
    }

    // 2. 建立不可逆的物理防灾备份
    let now = chrono::Utc::now().format("%Y%m%d_%H%M%S");
    let backup_path = file_path.with_extension(format!("bak.{}", now));
    fs::copy(file_path, &backup_path)?;

    // 3. 解析旧版扁平 models 数组并执行聚类
    let mut providers: BTreeMap<String, ProviderSpec> = BTreeMap::new();

    if let Some(models_array) = parsed_json.get("models").and_then(|m| m.as_array()) {
        for m in models_array {
            let model_id = m.get("id").and_then(|v| v.as_str()).unwrap_or("unknown-model");
            let vendor_id = m.get("vendor").and_then(|v| v.as_str()).unwrap_or("custom");
            let display_name = m.get("name").and_then(|v| v.as_str()).unwrap_or(model_id);
            let legacy_protocol = m.get("protocol").and_then(|v| v.as_str()).unwrap_or("openai/chat");
            let context_window = m.get("contextWindow").and_then(|v| v.as_u64()).unwrap_or(128000);

            // 获取或初始化该供应商的 ProviderSpec
            let provider = providers.entry(vendor_id.to_string()).or_insert_with(|| {
                ProviderSpec {
                    display_name: infer_provider_display_name(vendor_id),
                    base_url: infer_default_base_url(vendor_id),
                    protocol: legacy_protocol.to_string(), // 以首个发现的模型协议作为供应商协议
                    credential_ref: Some(format!("secret://provider/{}/api_key", vendor_id)),
                    api_key: None,
                    auth_header: true,
                    headers: BTreeMap::new(),
                    proxy_url: None,
                    compat: None,
                    models: Vec::new(),
                }
            });

            // 构造新的 ModelSpec，协议设为 None（自动继承供应商总协议）
            let model_spec = ModelSpec {
                id: model_id.to_string(),
                display_name: display_name.to_string(),
                protocol: None, // 继承总协议
                context_window,
                max_output_tokens: 16384,
                input_modalities: vec!["text".to_string()],
                thinking: ThinkingSpec::default(),
                pricing: None,
                compat: None,
                sampling_params: BTreeMap::new(),
                headers: BTreeMap::new(),
            };

            provider.models.push(model_spec);
        }
    }

    // 4. 构建 v2.0 根配置并原子覆写
    let root_v2 = ModelsRootYaml {
        version: "2.0".to_string(),
        providers,
    };

    let serialized_yaml = serde_yaml::to_string(&root_v2)?;
    fs::write(file_path, serialized_yaml)?;

    Ok(true)
}

fn infer_provider_display_name(vendor: &str) -> String {
    match vendor.to_lowercase().as_str() {
        "deepseek" => "DeepSeek 官方".to_string(),
        "openai" => "OpenAI 官方".to_string(),
        "anthropic" => "Anthropic 官方".to_string(),
        "qwen" | "aliyun" => "阿里云百炼".to_string(),
        "z-ai" | "zhipu" => "智谱清言".to_string(),
        "moonshot" | "kimi" => "月之暗面 Kimi".to_string(),
        "x-ai" | "grok" => "xAI Grok".to_string(),
        _ => format!("{} 供应商", vendor),
    }
}

fn infer_default_base_url(vendor: &str) -> String {
    match vendor.to_lowercase().as_str() {
        "deepseek" => "https://api.deepseek.com".to_string(),
        "openai" => "https://api.openai.com/v1".to_string(),
        "anthropic" => "https://api.anthropic.com".to_string(),
        "qwen" | "aliyun" => "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
        "z-ai" | "zhipu" => "https://open.bigmodel.cn/api/paas/v4".to_string(),
        "moonshot" | "kimi" => "https://api.moonshot.cn/v1".to_string(),
        "x-ai" | "grok" => "https://api.x.ai/v1".to_string(),
        _ => "http://localhost:8000/v1".to_string(),
    }
}
```

---

## 模块八：穷举式自动化测试用例集、魔鬼边界用例与验收断言矩阵

遵循立体验证纪律（§7.1），本方案提供 Rust 单元测试、三级决议矩阵、魔鬼边界用例以及前端组件瘦身测试用例。

### 8.1 Rust 单元测试套件（序列化往返与决议测试）

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// 8.1.1 树状 YAML 完整往返无损序列化断言测试 (Round-Trip Test)
    #[test]
    fn test_models_yaml_round_trip_preservation() {
        let mut providers = BTreeMap::new();
        let mut deepseek_models = Vec::new();

        deepseek_models.push(ModelSpec {
            id: "deepseek-v4-flash".to_string(),
            display_name: "DeepSeek V4 Flash".to_string(),
            protocol: None, // 继承总协议
            context_window: 1048576,
            max_output_tokens: 384000,
            input_modalities: vec!["text".to_string()],
            thinking: ThinkingSpec {
                enabled: true,
                mandatory: true,
                default_level: Some("medium".to_string()),
                levels: {
                    let mut m = BTreeMap::new();
                    m.insert("low".to_string(), Some("low".to_string()));
                    m.insert("medium".to_string(), Some("medium".to_string()));
                    m.insert("high".to_string(), Some("high".to_string()));
                    m
                },
            },
            pricing: Some(ModelPricingSpec {
                currency: "USD".to_string(),
                unit: "per_1m_tokens".to_string(),
                input: 0.44,
                output: 1.32,
                cache_read: Some(0.014),
                cache_write: None,
            }),
            compat: None,
            sampling_params: BTreeMap::new(),
            headers: BTreeMap::new(),
        });

        providers.insert(
            "deepseek".to_string(),
            ProviderSpec {
                display_name: "DeepSeek 官方".to_string(),
                base_url: "https://api.deepseek.com".to_string(),
                protocol: "openai/chat".to_string(),
                credential_ref: Some("secret://provider/deepseek/api_key".to_string()),
                api_key: None,
                auth_header: true,
                headers: BTreeMap::new(),
                proxy_url: None,
                compat: None,
                models: deepseek_models,
            },
        );

        let root_spec = ModelsRootYaml {
            version: "2.0".to_string(),
            providers,
        };

        // 1. 序列化为 YAML 字符串
        let yaml_text = serde_yaml::to_string(&root_spec).expect("YAML serialization failed");
        assert!(yaml_text.contains("version: '2.0'") || yaml_text.contains("version: \"2.0\""));
        assert!(yaml_text.contains("deepseek-v4-flash"));
        // 关键断言：protocol 为 None 时不应生成冗余的 "protocol: null"
        assert!(!yaml_text.contains("protocol: null"));

        // 2. 反序列化回 Rust 结构体
        let deserialized: ModelsRootYaml = serde_yaml::from_str(&yaml_text).expect("YAML deserialization failed");
        assert_eq!(root_spec, deserialized, "Round-trip struct identity assertion failed!");
    }

    /// 8.1.2 三级协议决议全分支穷举测试
    #[test]
    fn test_protocol_resolution_exhaustive_matrix() {
        let base_provider = ProviderSpec {
            display_name: "Test Provider".to_string(),
            base_url: "https://api.test.com".to_string(),
            protocol: "openai/chat".to_string(),
            credential_ref: None,
            api_key: None,
            auth_header: true,
            headers: BTreeMap::new(),
            proxy_url: None,
            compat: None,
            models: vec![],
        };

        let mut test_model = ModelSpec {
            id: "model-a".to_string(),
            display_name: "Model A".to_string(),
            protocol: None,
            context_window: 128000,
            max_output_tokens: 4096,
            input_modalities: vec!["text".to_string()],
            thinking: ThinkingSpec::default(),
            pricing: None,
            compat: None,
            sampling_params: BTreeMap::new(),
            headers: BTreeMap::new(),
        };

        // 分支 1：模型未指定 -> 继承 Provider 的 "openai/chat"
        let res1 = resolve_protocol_precedence(&base_provider, &test_model);
        assert_eq!(res1.effective_protocol, "openai/chat");
        assert!(!res1.is_overridden);

        // 分支 2：模型显式覆盖为 "openai/responses" -> 覆盖生效
        test_model.protocol = Some("openai/responses".to_string());
        let res2 = resolve_protocol_precedence(&base_provider, &test_model);
        assert_eq!(res2.effective_protocol, "openai/responses");
        assert!(res2.is_overridden);

        // 分支 3：Provider 协议被误清空为空格，模型也为空 -> 自动兜底至 "openai/chat"
        let mut empty_provider = base_provider.clone();
        empty_provider.protocol = "   ".to_string();
        test_model.protocol = None;
        let res3 = resolve_protocol_precedence(&empty_provider, &test_model);
        assert_eq!(res3.effective_protocol, "openai/chat");
        assert!(!res3.is_overridden);
    }
}
```

---

### 8.2 协议决议与级联继承全排列矩阵测试

```
┌───────┬──────────────────────────┬──────────────────────────┬──────────────────────────┬──────────────┐
│ 用例号│ ModelSpec.protocol       │ ProviderSpec.protocol    │ 期望 EffectiveProtocol   │ isOverridden │
├───────┼──────────────────────────┼──────────────────────────┼──────────────────────────┼──────────────┤
│ PR-01 │ None                     │ "openai/chat"            │ "openai/chat"            │ false        │
│ PR-02 │ None                     │ "anthropic/messages"     │ "anthropic/messages"     │ false        │
│ PR-03 │ Some("openai/responses") │ "openai/chat"            │ "openai/responses"       │ true         │
│ PR-04 │ Some("anthropic/messages")│ "openai/chat"           │ "anthropic/messages"     │ true         │
│ PR-05 │ Some("   ")              │ "openai/chat"            │ "openai/chat"            │ false (忽略空白)│
│ PR-06 │ None                     │ "" (空)                  │ "openai/chat" (兜底)     │ false        │
│ PR-07 │ Some("google/interactions")│ "" (空)                │ "google/interactions"    │ true         │
│ PR-08 │ None                     │ "google/interactions"    │ "google/interactions"    │ false        │
└───────┴──────────────────────────┴──────────────────────────┴──────────────────────────┴──────────────┘
```

---

### 8.3 模型探测智能合流与不变性保护魔鬼用例

```rust
#[test]
fn test_probe_reconciliation_immutability_guarantee() {
    // 构造本地已有模型：用户深度微调了展示名和上下文
    let mut current_spec = ProviderSpec {
        display_name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        protocol: "openai/chat".to_string(),
        credential_ref: None,
        api_key: None,
        auth_header: true,
        headers: BTreeMap::new(),
        proxy_url: None,
        compat: None,
        models: vec![
            ModelSpec {
                id: "deepseek-chat".to_string(),
                display_name: "【用户专属】极速代码助手".to_string(), // 用户自定义
                protocol: None,
                context_window: 65536,
                max_output_tokens: 8192,
                input_modalities: vec!["text".to_string()],
                thinking: ThinkingSpec::default(),
                pricing: None,
                compat: None,
                sampling_params: BTreeMap::new(),
                headers: BTreeMap::new(),
            }
        ],
    };

    // 上游探测返回两个模型：一个已有 (deepseek-chat)，一个全新 (deepseek-v4-pro)
    let upstream_ids = vec![
        "deepseek-chat".to_string(),
        "deepseek-v4-pro".to_string(),
    ];

    let report = reconcile_provider_models_algorithm("deepseek", current_spec, upstream_ids);

    // 断言 1：命中保留 1 个，追加 1 个
    assert_eq!(report.retained_model_ids, vec!["deepseek-chat"]);
    assert_eq!(report.appended_model_ids, vec!["deepseek-v4-pro"]);

    // 断言 2【核心不变性铁律】：用户微调的展示名必须完好无损！
    let retained_model = report.reconciled_provider_spec.models.iter().find(|m| m.id == "deepseek-chat").unwrap();
    assert_eq!(retained_model.display_name, "【用户专属】极速代码助手");

    // 断言 3：新追加的模型自动继承了 Provider 总协议（protocol 为 None）
    let appended_model = report.reconciled_provider_spec.models.iter().find(|m| m.id == "deepseek-v4-pro").unwrap();
    assert!(appended_model.protocol.is_none());
}
```

---

### 8.4 前端组件人体工学瘦身与状态中枢集成测试（Vitest）

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useModelsCatalogStore } from '@/store/modelsCatalogStore';

describe('前端状态中枢与单模型抽屉瘦身逻辑断言', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('验证单模型抽屉剥离协议后，修改 Provider 总协议能瞬时级联刷新所有子模型', () => {
    const store = useModelsCatalogStore();
    
    // 初始化树状模型结构
    store.rootConfig = {
      version: '2.0',
      providers: {
        'deepseek': {
          displayName: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          protocol: 'openai/chat',
          authHeader: true,
          headers: {},
          models: [
            {
              id: 'deepseek-v4-flash',
              displayName: 'DeepSeek V4 Flash',
              // protocol 未指定，继承总协议
              contextWindow: 1048576,
              maxOutputTokens: 384000,
              inputModalities: ['text'],
              thinking: { enabled: true, mandatory: true, levels: {} }
            },
            {
              id: 'deepseek-chat',
              displayName: 'DeepSeek V3',
              // protocol 显式覆盖
              protocol: 'openai/responses',
              contextWindow: 65536,
              maxOutputTokens: 8192,
              inputModalities: ['text'],
              thinking: { enabled: false, mandatory: false, levels: {} }
            }
          ]
        }
      }
    };

    store.recomputeResolved();
    expect(store.resolvedModels).toHaveLength(2);

    // 初始状态断言
    const flash = store.resolvedModels.find(m => m.modelId === 'deepseek-v4-flash')!;
    const chat = store.resolvedModels.find(m => m.modelId === 'deepseek-chat')!;
    expect(flash.effectiveProtocol).toBe('openai/chat');
    expect(flash.isProtocolOverridden).toBe(false);
    expect(chat.effectiveProtocol).toBe('openai/responses');
    expect(chat.isProtocolOverridden).toBe(true);

    // 动态将 Provider 总协议变更为 'anthropic/messages'
    store.updateProviderProtocol('deepseek', 'anthropic/messages');

    // 级联断言：未覆盖的模型自动跟随总协议更新，已覆盖的模型保持覆盖
    const flashUpdated = store.resolvedModels.find(m => m.modelId === 'deepseek-v4-flash')!;
    const chatUpdated = store.resolvedModels.find(m => m.modelId === 'deepseek-chat')!;
    expect(flashUpdated.effectiveProtocol).toBe('anthropic/messages');
    expect(chatUpdated.effectiveProtocol).toBe('openai/responses');
  });

  it('强制思考模型 (mandatory: true) 必须在前端计算属性中彻底过滤并消除 "Off" 选项', () => {
    const thinking = {
      enabled: true,
      mandatory: true,
      defaultLevel: 'high',
      levels: {
        minimal: 'minimal',
        low: 'low',
        medium: 'medium',
        high: 'high',
        off: null
      }
    };

    // 模拟前端 UI 渲染胶囊计算器
    const renderedLevels = Object.entries(thinking.levels)
      .filter(([level, wireVal]) => {
        if (thinking.mandatory && level === 'off') return false;
        return wireVal !== null;
      })
      .map(([level]) => level);

    expect(renderedLevels).not.toContain('off');
    expect(renderedLevels).toContain('high');
    expect(renderedLevels).toContain('medium');
    expect(renderedLevels).toHaveLength(4);
  });
});
```

---

### 8.5 交付检查清单与验收标准（DoD - Definition of Done）

| 检查项编号 | 验收标准维度 | 具体技术断言与验证方法 | 责任归属 |
| :--- | :--- | :--- | :--- |
| **DOD-01** | **千行硬指标** | 本分析详案文档严格达到 **≥ 1,000 行**，且各模块具备完整生产级代码与设计。 | Agent-D |
| **DOD-02** | **树状真源确立** | `models.yaml` 根结构全面升级为 `providers: Map<Id, Spec>` 树状模型，彻底废除一维扁平平铺。 | 后端内核 |
| **DOD-03** | **协议顶置实现** | 服务商设置页面顶部成功置顶“核心通信协议”分段器，成为全族模型的默认继承真源。 | 前端中枢 |
| **DOD-04** | **抽屉视觉瘦身** | 单模型配置抽屉（`ModelConfigPanel`）完全剥离协议下拉控件，抽屉垂直空间精简 40% 以上。 | 前端中枢 |
| **DOD-05** | **安全凭据闭环** | 凭据存储统一桥接至系统级 DPAPI 槽，前端仅传递 `TokenRef` 与安全掩码，杜绝明文留存。 | 架构安全 |
| **DOD-06** | **探测资产保护** | 运行 `reconcile_provider_models` 自动化测试，验证探测新模型智能追加且用户既有配置 100% 不受侵犯。 | 后端内核 |
| **DOD-07** | **老旧配置无感迁移** | 启动时遇到旧版 `models.yaml`，系统自动建立 `.bak` 备份并原子转换为 v2.0 格式，用户无感。 | 迁移模块 |
| **DOD-08** | **立体测试门禁** | Rust 往返序列化、协议决议全排列测试及前端 Vitest 级联测试全部跑通，覆盖率 100%。 | 质量门禁 |
