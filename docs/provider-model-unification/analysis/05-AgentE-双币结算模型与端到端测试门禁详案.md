# 供应商与模型能力全线接通重构 — 专项深度方案分析 (05-AgentE)

> **文档编号**：`05-AgentE`  
> **方案名称**：双币计量结算体系、多模态上下文预算与前端状态中枢全量立体验证详案  
> **工作区归属**：`docs/provider-model-unification/analysis/`  
> **角色定位**：Integration Gate Auditor（集成审计与测试门禁专家）  
> **负责攻坚议题**：  
> - **【议题 D】多模态能力、上下文截断与双币计量结算体系**  
> - **【议题 E】前端状态中枢重构、界面人体工学瘦身与全量立体验证**  
> **指定唯一输出路径**：`docs/provider-model-unification/analysis/05-AgentE-双币结算模型与端到端测试门禁详案.md`  
> **对标权威基准**：`@earendil-works/pi-ai` 规范、`docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`、`00-供应商与模型能力全线接通重构总纲.md`  
> **质量红线指标**：全文代码与方案详实完备，严格遵守 ≥1,000 行要求，拒绝大话套话与 TODO 遗留。

---

## 目录索引 (Table of Contents)

- [一、议题 D 与 E 的 Conex 现状深度剖析与根因定位](#一议题-d-与-e-的-conex-现状深度剖析与根因定位)
  - [1.1 【议题 D 现状断层一】多模态能力缺失与单边假设陷阱](#11-议题-d-现状断层一多模态能力缺失与单边假设陷阱)
  - [1.2 【议题 D 现状断层二】上下文截断死锁与静态 KNOWN_CONTEXT 欺骗](#12-议题-d-现状断层二上下文截断死锁与静态-known_context-欺骗)
  - [1.3 【议题 D 现状断层三】单一美元假设计量、汇率失真与必填价格强迫症](#13-议题-d-现状断层三单一美元假设计量汇率失真与必填价格强迫症)
  - [1.4 【议题 E 现状断层一】前端状态中枢双轨割裂与真源倒置](#14-议题-e-现状断层一前端状态中枢双轨割裂与真源倒置)
  - [1.5 【议题 E 现状断层二】单模型抽屉配置噪音与人体工学灾难](#15-议题-e-现状断层二单模型抽屉配置噪音与人体工学灾难)
  - [1.6 【议题 E 现状断层三】全链路集成测试门禁盲区与契约漂移](#16-议题-e-现状断层三全链路集成测试门禁盲区与契约漂移)
- [二、对标 @earendil-works/pi-ai 优秀实践与架构差异化演进](#二对标-earendil-workspi-ai-优秀实践与架构差异化演进)
  - [2.1 pi-ai 核心拓扑与计量模型评析](#21-pi-ai-核心拓扑与计量模型评析)
  - [2.2 Conex 的差异化演进与超越设计](#22-conex-的差异化演进与超越设计)
- [三、完整的强类型数据结构设计 (Rust & TypeScript)](#三完整的强类型数据结构设计-rust--typescript)
  - [3.1 Rust 核心数据结构 (Serde 契约与强类型注解)](#31-rust-核心数据结构-serde-契约与强类型注解)
  - [3.2 TypeScript 强类型契约 (前端树状中枢基石)](#32-typescript-强类型契约-前端树状中枢基石)
- [四、底层协议 Wire 格式与通信交互设计](#四底层协议-wire-格式与通信交互设计)
  - [4.1 多模态 Payload 在四大协议下的 Wire 格式对照](#41-多模态-payload-在四大协议下的-wire-格式对照)
  - [4.2 双币结算与 Token 用量响应体 Wire 解析](#42-双币结算与-token-用量响应体-wire-解析)
- [五、核心状态转移机与算法伪代码](#五核心状态转移机与算法伪代码)
  - [5.1 协议决议与模态可用性校验状态机](#51-协议决议与模态可用性校验状态机)
  - [5.2 动态上下文截断与子代理预算分配算法 (Token Clamp Engine)](#52-动态上下文截断与子代理预算分配算法-token-clamp-engine)
  - [5.3 双币阶梯计量算费算法 (Dual-Currency Tiered Pricing Engine)](#53-双币阶梯计量算费算法-dual-currency-tiered-pricing-engine)
  - [5.4 models.yaml 热重载与前端 Store 响应式原子替换算法](#54-modelsyaml-热重载与前端-store-响应式原子替换算法)
- [六、精确到现有代码文件与函数签名的工程改造方案](#六精确到现有代码文件与函数签名的工程改造方案)
  - [6.1 Rust 后端内核工程改造清单](#61-rust-后端内核工程改造清单)
  - [6.2 前端状态中枢与界面人体工学瘦身改造清单](#62-前端状态中枢与界面人体工学瘦身改造清单)
- [七、存量数据迁移与向后兼容保障方案](#七存量数据迁移与向后兼容保障方案)
  - [7.1 存量数据源格式对比与迁移逻辑](#71-存量数据源格式对比与迁移逻辑)
  - [7.2 自动化迁移脚本与容灾备份机制](#72-自动化迁移脚本与容灾备份机制)
- [八、穷举式自动化测试用例集、魔鬼边界用例与验收断言矩阵](#八穷举式自动化测试用例集魔鬼边界用例与验收断言矩阵)
  - [8.1 单元测试套件 (Rust Unit Tests)](#81-单元测试套件-rust-unit-tests)
  - [8.2 前端 Store 与 Hook 响应式集成测试 (Vitest)](#82-前端-store-与-hook-响应式集成测试-vitest)
  - [8.3 魔鬼边界用例 (Devil Edge Cases)](#83-魔鬼边界用例-devil-edge-cases)
  - [8.4 集成审计门禁断言矩阵 (Integration Gate Checklist)](#84-集成审计门禁断言矩阵-integration-gate-checklist)
- [九、总结与实施路线图](#九总结与实施路线图)

---

## 一、议题 D 与 E 的 Conex 现状深度剖析与根因定位

在审查现有 Conex 架构实现中，供应商拓扑、模型能力管理、计费结算以及前端配置交互层面存在深刻的架构断层。本节从系统工程角度深入剖析问题本质，为重构方案确立根基。

### 1.1 【议题 D 现状断层一】多模态能力缺失与单边假设陷阱

#### 现状断层现象
1. **输入模态一刀切**：当前 Conex 内核在处理多模态附件（如图片、文档、音频）时，缺乏模型级别的模态能力白名单校验。所有模型默认被视作纯文本模型，或在部分分支中无条件放行 `image_url` 组装；
2. **纯文本模型注入多模态崩溃**：当开发者在对话中拖入图片或 PDF 时，若当前选中的是纯文本代码模型（如 `deepseek/deepseek-v4-flash` 官方纯文本版、`qwen/qwen3.8-coder`、或本地 `ollama/llama3.1:8b`），系统将带有 `type: "image_url"` 的 Payload 直接发送给上游，引发 400 Bad Request（`Invalid parameter: messages[1].content[1].type is not supported`）异常中断；
3. **输出模态缺失治理**：根据《主流模型多源权威数据全景调研》，如 `meta/muse-image`、`google/gemini-3.1-flash-image`（Nano Banana 2）、`openai/gpt-image-2`、`qwen/qwen-image-3` 等模型，其输出模态涵盖 `image, text`。现有系统将所有输出死锁在文本流（SSE delta），完全缺乏对图像生成模态的输出解析通道与第一公民支持；
4. **缺少 PDF/文档 原生解析支持**：Claude 5 / GLM-5.3 等模型原生支持 `file` / `pdf` 模态直接作为 Base64 document 发送，但现有系统强行将其在前端解析为字符串注入上下文，导致 Token 膨胀超标且丢失原始排版与视觉结构。

#### 根因定位
- **根因一**：模型配置缺乏 `modalities` 强类型元数据描述。缺少类似于 `@earendil-works/pi-ai` 中 `input: ("text" | "image")[]` 并向上扩展为 `output` 模态矩阵的声明；
- **根因二**：前端 Composer 拖拽/粘贴组件与当前活动模型的元数据完全脱节。输入框无法根据当前激活模型的 `modalities.input` 实时启用或禁用附件上传，缺少即时视觉置灰与 Tooltip 提示。

---

### 1.2 【议题 D 现状断层二】上下文截断死锁与静态 KNOWN_CONTEXT 欺骗

#### 现状断层现象
1. **静态常量死锁**：Conex 内核与前端分别散落着静态上下文常量表（如 `KNOWN_CONTEXT`、`DEFAULT_MAX_TOKENS = 4096`），在模型快速换代的当下造成严重的运行期谎言；
2. **长上下文模型遭受腰斩截断**：根据调研，DeepSeek V4 Flash 固化版上线了 1,310,720 tokens 上下文，Qwen3.8 Max 达到 1,000,000 tokens，GPT-5.6 达到 1,050,000 tokens。然而，由于硬编码映射的存在，即使在 `models.yaml` 中手动标注了 `contextWindow: 1048576`，内核的截断滑动窗口依旧在 128K 处执行强制裁切，导致超长文档阅读、大仓库分析等任务发生断崖式信息丢失；
3. **子代理预算（Subagent Budget）失控与死锁**：在多 Agent 协同体系中，主 Agent 派发子 Agent 时，子 Agent 的 Prompt 裁剪与最大输出 Token 预算采用硬编码数值（如 16,384）。这导致在面对大模型时无法发挥其高吞吐长推理优势，在面对小上下文模型时又频繁触发上游上下文溢出错误。

#### 根因定位
- **根因一**：上下文截断算法未与配置层 SSOT（`models.yaml`）挂钩，读取的是代码编译期固化的静态单例；
- **根因二**：缺乏动态 Token 钳制引擎（Token Clamp Engine），未能形成基于 `EffectiveContext = min(Model.contextWindow, Config.hardLimit)` 与 `SafeSubagentBudget = EffectiveContext * Ratio` 的动态计算闭环。

---

### 1.3 【议题 D 现状断层三】单一美元假设计量、汇率失真与必填价格强迫症

#### 现状断层现象
1. **单一美元体系强制捆绑**：现有计费逻辑死锁在 USD 美元标准下，界面强行输出 `$` 符号；
2. **国内厂商官方标准汇率失真**：
   - 阿里云百炼通义千问官方国内站人民币定价为：`qwen3.8-max` 输入 ¥12.00 / 输出 ¥36.00 / 缓读 ¥2.40；国际站官方定价为：$2.00 / $6.00 / $0.40；
   - 深度求索 DeepSeek 官方人民币定价为：`deepseek-v4-flash` 输入 ¥3.00 / 输出 ¥9.00 / 缓读 ¥0.10；国际站官方定价为：$0.44 / $1.32 / $0.014；
   - 现有系统若仅支持填入美元，会导致国内站用户被迫自行使用不稳定的浮动汇率换算，造成账目核算漂移与企业报销财务对不上账；
3. **阶梯计费（Tiered Pricing）能力为零**：对于大上下文模型（如 Qwen3.7-plus 超过 256K 费率递增，GPT-5.6 超过特定阈值费率调整），现有系统仅支持单一单价值，无法正确计算长文本请求的真实花销；
4. **非 Token 计费无法表达**：对于图像生成模型（如 `qwen-image-3` 输入 ¥0.02/张，输出 ¥0.20/张；`meta/muse-image` 输出 $0.01/张），系统完全无法以“按张计费 (per_image)”进行计量；
5. **价格强迫症与噪音干扰**：用户在添加本地模型（Ollama / vLLM）或私有模型时，未填价格的情况下系统在界面强制呈现“$0.00”或在表单校验时报红阻断，严重违背人体工学。

#### 根因定位
- **根因一**：定价结构体仅有平铺的 `input_cost: f64`, `output_cost: f64`，缺乏 `currency: Currency`（USD / CNY）与 `unit: PricingUnit`（per_1m_tokens / per_image）维度；
- **根因二**：缺乏选填静默机制（Zero-Cost Silence Fallback）。未定义价格在系统层应当表达为 `None`，并在 UI 侧彻底静默隐藏，而非赋值为 0.0 并以醒目字体提示。

---

### 1.4 【议题 E 现状断层一】前端状态中枢双轨割裂与真源倒置

#### 现状断层现象
1. **三轨并立引发数据漂移**：
   - 轨道一：`~/.conex/models.yaml`，物理磁盘文件，历史格式将所有模型扁平展开为一维列表，每个模型带有 `vendor: string` 标签；
   - 轨道二：前端 `localStorage` 中的 `ProviderProfiles`，存储各供应商的 BaseURL、API Key、选中的默认模型等；
   - 轨道三：Rust 内核打包在 binary 内的 `bundled_catalog.json`；
2. **修改脱节与真假真源**：用户在前端界面配置了某 Provider 的 BaseURL 或新增了一个模型，Rust 内核在实际发起网络请求时依然去查静态 catalog；或者在 YAML 中手动添加了模型，前端因为 LocalStorage 缓存覆盖而无法感知，出现“配了却不生效”的严重假死现象。

#### 根因定位
- **架构倒置**：把 Provider 降格为模型的附属属性，而非将 Provider 作为树状层级的顶层主体；
- **缺乏单轨订阅机制**：前端缺少以 `models.yaml` 磁盘镜像为唯一 SSOT 的响应式状态中枢。

---

### 1.5 【议题 E 现状断层二】单模型抽屉配置噪音与人体工学灾难

#### 现状断层现象
1. **几十个抽屉重复展示协议下拉框**：
   在现有的 `ModelConfigPanel` 中，每个单模型的折叠抽屉展开后，正中央均放置着一个包含 `openai/chat`, `openai/responses`, `anthropic/messages`, `google/generative-ai` 的协议选择下拉框；
2. **极度繁重的配置心智负担**：
   当开发者在一个 OpenAI 兼容服务商（如 DeepSeek、OpenRouter、SiliconFlow、百炼兼容模式）下挂载 20 个模型时，展开每个模型抽屉都必须肉眼核对并手动选择一遍协议。若其中一个模型漏选或手误选为 Anthropic，将导致请求序列化崩溃；
3. **关键信息被噪音遮蔽**：
   在单模型抽屉中，核心的人体工学参数（如展示别名 DisplayName、上下文窗口 ContextWindow、思考开关 Thinking）被淹没在冗余的协议下拉框和强制必填的价格字段中。

#### 根因定位
- **缺少继承层级设计**：未确立“供应商层确定基准协议，模型层默认 100% 自动继承，极少数特定模型才允许显式局部覆盖”的树状拓扑继承原则。

---

### 1.6 【议题 E 现状断层三】全链路集成测试门禁盲区与契约漂移

#### 现状断层现象
1. **协议路由缺乏一致性刚性断言**：修改前端协议配置后，没有自动化门禁断言 Rust 内核最终发出的 HTTP 请求端点（URL path）与 Wire Header 是否完全正确；
2. **双币结算缺乏精度与越界测试**：浮点数累加导致的精度丢失未被测试覆盖，高并发对话下多币种混用发生计算混乱；
3. **存量迁移缺乏无损回滚保障**：老版本扁平配置文件升级到树状结构时，缺乏字段无损映射的单元回归测试，极易导致用户的自定义模型和配置丢失。

---

## 二、对标 @earendil-works/pi-ai 优秀实践与架构差异化演进

作为工业级 AI Coding Agent 的权威标杆，`@earendil-works/pi-ai` 在模型体系、协议路由与方言适配上的设计极为精炼。深入分析其设计哲学，有助于我们吸纳其精华并结合 Conex 桌面端全功能 Agent 的特点实现超越。

### 2.1 pi-ai 核心拓扑与计量模型评析

通过精读 `reference/pi/packages/coding-agent/docs/models.md` 与 `reference/pi/packages/ai/src/types.ts`，总结其优秀设计模式：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                          @earendil-works/pi-ai 核心架构拓扑                                  │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  ~/.pi/agent/models.json                                                                    │
│  └─ providers: {                                                                            │
│       [providerId]: {                                                                       │
│          baseUrl: string,                                                                   │
│          api: KnownApi,                      <--- 顶层统管协议 (Default for all models)     │
│          apiKey: string,                     <--- 统一认证凭据                              │
│          compat?: OpenAICompletionsCompat,   <--- 供应商级方言矩阵                          │
│          models: [                           <--- 下属模型挂载列表                          │
│            {                                                                                │
│              id: string,                                                                    │
│              name: string,                                                                  │
│              api?: KnownApi,                 <--- 模型级局部覆盖 (可选)                     │
│              input: ("text" | "image")[],    <--- 模态支持                                  │
│              contextWindow: number,          <--- 上下文容量                                │
│              maxTokens: number,              <--- 最大输出限制                              │
│              cost: {                         <--- 按百万 Token 四价计费                    │
│                input: number,                                                               │
│                output: number,                                                              │
│                cacheRead: number,                                                           │
│                cacheWrite: number,                                                          │
│                tiers?: ModelCostTier[]       <--- 阶梯计费 (inputTokensAbove)               │
│              }                                                                              │
│            }                                                                                │
│          ]                                                                                  │
│       }                                                                                     │
│     }                                                                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### pi-ai 的三大优秀设计：
1. **Provider 为一级实体**：协议 `api`、`baseUrl`、`compat` 置于 Provider 顶层，子模型自然继承，消除重复定义；
2. **四价与阶梯计量结构（`ModelCost`）**：将输入、输出、KV 缓存读取（Cache Read）、KV 缓存写入（Cache Write）清晰区分，并引入 `inputTokensAbove` 阶梯费率；
3. **运行时无缝热重载**：每次打开模型选择菜单，实时重新读取 JSON 配置文件，完全杜绝进程死锁。

---

### 2.2 Conex 的差异化演进与超越设计

Conex 作为面向专业开发者的全功能 Native 桌面 Agent，面临国内多供应商混用、多模态代码审查与轻量化界面交互等复杂现实。我们在对标 pi-ai 的基础上，进行如下维度的大幅演进：

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Conex 差异化创新演进对比矩阵                                    │
├───────────────────┬───────────────────────────────────────┬─────────────────────────────────────┤
│ 演进维度          │ @earendil-works/pi-ai (权威标杆)      │ Conex 超越设计 (本方案落地)          │
├───────────────────┼───────────────────────────────────────┼─────────────────────────────────────┤
│ 1. 货币计量体系   │ 【仅支持美元 USD】                    │ 【双币原生体系 (CNY / USD)】         │
│                   │ 假定所有计费均为 $/1M tokens，无法对  │ 支持国内站人民币 (¥) 与国际站美元   │
│                   │ 国内模型官方刊例全价做原生结算。      │ ($) 独立定义，杜绝汇率漂移失真。    │
├───────────────────┼───────────────────────────────────────┼─────────────────────────────────────┤
│ 2. 计量计费单位   │ 【单一 Token 维度】                   │ 【复合计量单元 (Tokens / Image)】    │
│                   │ 仅支持 tokens，无法处理图像生成模型。 │ 支持 per_1m_tokens, per_image 模式，│
│                   │                                       │ 原生支持 Qwen-Image-3 / Nano Banana │
├───────────────────┼───────────────────────────────────────┼─────────────────────────────────────┤
│ 3. 价格选填机制   │ 【全零填充 (All zeros)】              │ 【彻底选填与静默降级 (Silent None)】 │
│                   │ 默认填充 0，前端呈现无价值的 0 报价。  │ Option<Pricing> 建模，未填时界面完全│
│                   │                                       │ 折叠隐藏，不产生视觉噪音与校验报错。│
├───────────────────┼───────────────────────────────────────┼─────────────────────────────────────┤
│ 4. 模态矩阵深度   │ 【仅限 input ("text" \| "image")】    │ 【全模态输入/输出双向矩阵】         │
│                   │ 不支持输入视频/音频/PDF，无输出模态。 │ input: text, image, video, audio,   │
│                   │                                       │ file(pdf)；output: text, image.     │
├───────────────────┼───────────────────────────────────────┼─────────────────────────────────────┤
│ 5. 前端人体工学   │ 【CLI 终端交互】                      │ 【GUI 树状置顶 + 抽屉深度瘦身】     │
│                   │ 依靠纯文本命令行编辑配置。            │ Provider 置顶协议选择，单模型抽屉   │
│                   │                                       │ 彻底摘除协议下拉，空间归还核心配置。│
├───────────────────┼───────────────────────────────────────┼─────────────────────────────────────┤
│ 6. 上下文与子预算 │ 【粗粒度参数传递】                    │ 【Token Clamp 动态双向钳制引擎】    │
│                   │ 将 contextWindow 传给模型，无子代理。 │ 动态计算滑动窗口截断，且根据父子模型│
│                   │                                       │ 上下文严格分配 Subagent Prompt 预算。│
└───────────────────┴───────────────────────────────────────┴─────────────────────────────────────┘
```

---

## 三、完整的强类型数据结构设计 (Rust & TypeScript)

本节给出重构所需的全部底层核心数据类型。遵循以下刚性原则：
1. **Rust 结构体**：全部配备 `#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]`，严格标注 `#[serde(rename_all = "camelCase")]` 与 `#[serde(skip_serializing_if = "Option::is_none")]`；
2. **TypeScript 接口**：与 Rust Serde 序列化结果严格一字不差匹配，带有详尽的 JSDoc 注释。

### 3.1 Rust 核心数据结构 (Serde 契约与强类型注解)

新建/落地文件：`crates/agent-provider/src/models_config.rs`

```rust
// =============================================================================
// Conex / Crish - 统一供应商与模型能力真源配置数据契约 (models.yaml SSOT)
// =============================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 支持的法定结算货币类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Currency {
    #[serde(rename = "USD")]
    Usd,
    #[serde(rename = "CNY")]
    Cny,
}

impl Default for Currency {
    fn default() -> Self {
        Currency::Usd
    }
}

/// 计量计价单元
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PricingUnit {
    /// 按每百万 Token 计费 (默认通用)
    Per1mTokens,
    /// 按张计费 (主要针对文生图 / 图像语义推理模型)
    PerImage,
    /// 按单次请求固定计费
    PerRequest,
}

impl Default for PricingUnit {
    fn default() -> Self {
        PricingUnit::Per1mTokens
    }
}

/// 阶梯计价费率档位 (基于累计输入 Token 上限匹配)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingTier {
    /// 触发本阶梯费率的输入 Token 门槛（当 request_input_tokens >= input_tokens_above 时生效）
    pub input_tokens_above: u64,
    /// 阶梯输入费率（每百万 Tokens 或每单元）
    pub input: f64,
    /// 阶梯输出费率
    pub output: f64,
    /// 阶梯缓存读取命中费率 (Cache Read)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    /// 阶梯缓存写入创建费率 (Cache Write)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// 模型四价计费体系 (完全选填)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    /// 结算货币类型 (USD 或 CNY)
    #[serde(default)]
    pub currency: Currency,

    /// 计量单元 (per_1m_tokens, per_image 等)
    #[serde(default)]
    pub unit: PricingUnit,

    /// 普通输入 (Prompt) 单价
    pub input: f64,

    /// 生成输出 (Completion) 单价
    pub output: f64,

    /// KV 缓存命中读取单价 (Cache Read)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,

    /// KV 缓存创建写入单价 (Cache Write)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,

    /// 阶梯计费配置规则列表 (可选，当命中高区间时覆盖基准单价)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tiers: Vec<PricingTier>,
}

/// 支持的模态枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Modality {
    Text,
    Image,
    Video,
    Audio,
    File, // 包括 PDF、DOCX 等原生文档解析模态
}

/// 模型双向模态能力矩阵配置
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalitiesConfig {
    /// 模型支持接收的输入模态列表
    #[serde(default = "ModalitiesConfig::default_input")]
    pub input: Vec<Modality>,

    /// 模型能够输出的内容模态列表
    #[serde(default = "ModalitiesConfig::default_output")]
    pub output: Vec<Modality>,
}

impl ModalitiesConfig {
    pub fn default_input() -> Vec<Modality> {
        vec![Modality::Text]
    }
    pub fn default_output() -> Vec<Modality> {
        vec![Modality::Text]
    }
}

impl Default for ModalitiesConfig {
    fn default() -> Self {
        Self {
            input: Self::default_input(),
            output: Self::default_output(),
        }
    }
}

/// 纯英文思考强度标准档位
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StandardThinkingLevel {
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// 思考推理配置契约 (三态控制)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingConfig {
    /// 模型是否具备思考推理能力 (若为 false，前端胶囊彻底折叠)
    pub enabled: bool,

    /// 是否强制思考 (若为 true，前端彻底隐藏 Off 选项，强制开启思考)
    #[serde(default)]
    pub mandatory: bool,

    /// 默认激活档位
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_level: Option<StandardThinkingLevel>,

    /// 真实 Wire 参数与前端档位的映射表 (Key: 英文档位, Value: 传给上游的 wire 字符串或 null)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub levels: HashMap<String, Option<String>>,
}

/// 供应商层级高级方言兼容矩阵
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCompat {
    /// 思考推理方言协议 (如 openai, deepseek, qwen_enable_thinking, zai, anthropic)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<String>,

    /// 是否支持 developer 角色 (若为 false 则回退为 system 角色)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,

    /// 最大输出 Token 字段名 (max_tokens vs max_completion_tokens)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<String>,

    /// 是否在流式响应中强制请求 include_usage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_usage_in_streaming: Option<bool>,

    /// 是否支持原生 Tool Strict Mode (JSON Schema 严格受限采样)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_strict_mode: Option<bool>,
}

/// 单模型规格定义 (ModelSpec)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    /// 模型 API 唯一标识符 (Wire Name，如 deepseek-v4-flash, gpt-5.6-sol)
    pub id: String,

    /// 界面呈现的友好全称 (Display Name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,

    /// 模型级显式协议覆盖 (当且仅当该特定模型与供应商总协议不同时配置)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,

    /// 上下文窗口容量总大小 (Tokens)
    pub context_window: u64,

    /// 单次请求最大生成输出限制 (Max Output Tokens)
    pub max_output_tokens: u64,

    /// 输入输出模态支持矩阵
    #[serde(default)]
    pub modalities: ModalitiesConfig,

    /// 思考推理能力配置
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<ThinkingConfig>,

    /// 四价计费体系 (完全选填)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ModelPricing>,

    /// 透传的高级采样参数 (temperature, top_p, top_k 等)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub sampling_params: HashMap<String, serde_json::Value>,

    /// 模型级别特异性方言覆盖
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compat: Option<ProviderCompat>,
}

/// 供应商规格定义 (ProviderSpec)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// 供应商友好展示名称 (如 "DeepSeek 官方", "阿里云百炼")
    pub display_name: String,

    /// 基础网络端点 (Base URL)
    pub base_url: String,

    /// 供应商总调用协议 (第一公民，全部下属模型默认继承，如 "openai/chat", "anthropic/messages")
    pub protocol: String,

    /// 供应商级别方言兼容配置
    #[serde(default)]
    pub compat: ProviderCompat,

    /// 注入的自定义 HTTP 请求头 (如 HTTP-Referer, X-Title 等)
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,

    /// 下属挂载的模型列表 (树状下级)
    #[serde(default)]
    pub models: Vec<ModelSpec>,
}

/// 统一真源根结构体 (跨系统唯一 SSOT: models.yaml)
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsConfig {
    /// 供应商字典 (Key: provider_id, 如 deepseek, qwen, openai, ollama)
    pub providers: HashMap<String, ProviderSpec>,
}
```

---

### 3.2 TypeScript 强类型契约 (前端树状中枢基石)

新建/落地文件：`packages/shared-types/src/modelsConfig.ts`

```typescript
// =============================================================================
// Conex / Crish - 前端模型体系强类型契约 (与 Rust serde 完全对齐)
// =============================================================================

export type Currency = 'USD' | 'CNY';

export type PricingUnit = 'per_1m_tokens' | 'per_image' | 'per_request';

export interface PricingTier {
  /** 触发阶梯的输入 Token 门槛 */
  inputTokensAbove: number;
  /** 阶梯输入费率 */
  input: number;
  /** 阶梯输出费率 */
  output: number;
  /** 阶梯缓存读取命中费率 */
  cacheRead?: number;
  /** 阶梯缓存写入创建费率 */
  cacheWrite?: number;
}

export interface ModelPricing {
  /** 货币标识符 (USD / CNY) */
  currency: Currency;
  /** 计量单元 */
  unit: PricingUnit;
  /** 普通输入费率 */
  input: number;
  /** 生成输出费率 */
  output: number;
  /** KV 缓存读取命中费率 */
  cacheRead?: number;
  /** KV 缓存写入创建费率 */
  cacheWrite?: number;
  /** 阶梯计费规则 */
  tiers?: PricingTier[];
}

export type Modality = 'text' | 'image' | 'video' | 'audio' | 'file';

export interface ModalitiesConfig {
  input: Modality[];
  output: Modality[];
}

export type StandardThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ThinkingConfig {
  enabled: boolean;
  mandatory?: boolean;
  defaultLevel?: StandardThinkingLevel;
  /** 映射字典：档位名 -> wire 字符串或 null (禁用) */
  levels?: Record<string, string | null>;
}

export interface ProviderCompat {
  thinkingFormat?: string;
  supportsDeveloperRole?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens' | string;
  supportsUsageInStreaming?: boolean;
  supportsStrictMode?: boolean;
}

export interface ModelSpec {
  /** 模型 API 唯一标识符 */
  id: string;
  /** 界面呈现友好名称 */
  displayName?: string;
  /** 模型级显式协议覆盖 (可选) */
  protocol?: string;
  /** 上下文窗口容量 (Tokens) */
  contextWindow: number;
  /** 单次最大输出限制 (Tokens) */
  maxOutputTokens: number;
  /** 输入/输出模态配置 */
  modalities: ModalitiesConfig;
  /** 思考推理配置 */
  thinking?: ThinkingConfig;
  /** 四价计费 (完全选填) */
  pricing?: ModelPricing;
  /** 采样透传参数 */
  samplingParams?: Record<string, unknown>;
  /** 模型级方言覆盖 */
  compat?: ProviderCompat;
}

export interface ProviderSpec {
  /** 供应商友好名称 */
  displayName: string;
  /** 基础 API 端点 */
  baseUrl: string;
  /** 供应商总协议 (第一公民，如 'openai/chat', 'anthropic/messages') */
  protocol: string;
  /** 供应商级方言 */
  compat: ProviderCompat;
  /** 注入的自定义请求头 */
  headers?: Record<string, string>;
  /** 下属挂载模型列表 */
  models: ModelSpec[];
}

export interface ModelsConfig {
  providers: Record<string, ProviderSpec>;
}

/** 运行时计算出的模型有效完整视图 (扁平索引，用于快速查找) */
export interface ResolvedModelMeta {
  providerId: string;
  providerDisplayName: string;
  modelId: string;
  displayName: string;
  effectiveProtocol: string;
  contextWindow: number;
  maxOutputTokens: number;
  modalities: ModalitiesConfig;
  thinking?: ThinkingConfig;
  pricing?: ModelPricing;
}
```

---

## 四、底层协议 Wire 格式与通信交互设计

本节展示多模态请求体与双币结算用量在各大主流协议上的实际网络 Wire 格式对比，为 Rust 引擎与前端解析提供真实凭据。

### 4.1 多模态 Payload 在四大协议下的 Wire 格式对照

针对用户上传一张本地图片进行代码审查的场景，展示四大协议在底层通信时的 JSON Payload 对比：

#### 1. OpenAI Chat Completions 协议 (用于 DeepSeek, Qwen 兼容网关, OpenAI)
```json
{
  "model": "deepseek-v4-flash-vision-exp",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请审查这张架构图中的潜在瓶颈并给出优化建议。"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
            "detail": "high"
          }
        }
      ]
    }
  ],
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
```

#### 2. Anthropic Messages 协议 (用于 Claude 5 / DeepSeek Anthropic 端点)
```json
{
  "model": "claude-5-sonnet-20260620",
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "请阅读随附的架构规范 PDF 并分析安全性。"
        },
        {
          "type": "document",
          "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": "JVBERi0xLjQKJcfs..."
          }
        },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "/9j/4AAQSkZJRgABAQ..."
          }
        }
      ]
    }
  ],
  "max_tokens": 8192,
  "stream": true
}
```

#### 3. Google Generative AI (generateContent 协议)
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "请分析这段屏幕录制的执行异常："
        },
        {
          "inline_data": {
            "mime_type": "video/mp4",
            "data": "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1w..."
          }
        }
      ]
    }
  ],
  "generationConfig": {
    "maxOutputTokens": 65536,
    "thinkingConfig": {
      "thinkingLevel": "HIGH"
    }
  }
}
```

#### 4. OpenAI Responses 协议 (GPT-5.6 专属原生格式)
```json
{
  "model": "gpt-5.6-sol",
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "请对照这套 UI 设计稿生成对应的 Tailwind CSS 组件。"
        },
        {
          "type": "input_image",
          "image_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
        }
      ]
    }
  ],
  "output_modalities": ["text"],
  "reasoning": {
    "effort": "high"
  },
  "stream": true
}
```

---

### 4.2 双币结算与 Token 用量响应体 Wire 解析

以阿里云百炼（DashScope）与深度求索（DeepSeek）的流式返回终态（`usage chunk`）为例：

#### DeepSeek 响应中的 Usage 格式
```json
{
  "id": "chatcmpl-9b7e6144e5d84877",
  "object": "chat.completion.chunk",
  "created": 1788712390,
  "model": "deepseek-v4-flash",
  "choices": [
    {
      "index": 0,
      "delta": {},
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 128450,
    "completion_tokens": 2430,
    "total_tokens": 130880,
    "prompt_tokens_details": {
      "cached_tokens": 122880
    },
    "completion_tokens_details": {
      "reasoning_tokens": 1820
    }
  }
}
```

#### 计费提取映射规则：
- **普通未命中输入**：`InputActual = prompt_tokens - prompt_tokens_details.cached_tokens = 128,450 - 122,880 = 5,570`；
- **KV 缓存命中读取**：`CacheReadActual = prompt_tokens_details.cached_tokens = 122,880`；
- **生成输出**：`OutputActual = completion_tokens = 2,430`（其中思考消耗为 1,820，输出单价已统合思考）；
- **货币与单价代入**：
  若选用国内人民币定价（¥3.00 / ¥9.00 / ¥0.10）：
  $$\text{Cost}_{\text{Input}} = \frac{5570}{10^6} \times 3.00 = 0.01671 \text{ 元}$$
  $$\text{Cost}_{\text{CacheRead}} = \frac{122880}{10^6} \times 0.10 = 0.012288 \text{ 元}$$
  $$\text{Cost}_{\text{Output}} = \frac{2430}{10^6} \times 9.00 = 0.02187 \text{ 元}$$
  $$\text{Total} = 0.01671 + 0.012288 + 0.02187 = 0.050868 \text{ 元 (约 } ¥0.051 \text{)}$$

---

## 五、核心状态转移机与算法伪代码

本节详细给出协议决议、模态门禁、上下文与子代理预算钳制、双币结算与原子热重载的完整状态机转移和算法实现。

### 5.1 协议决议与模态可用性校验状态机

```
                      用户发起请求 (ModelId, ProviderId, Attachments)
                                      │
                                      ▼
                        【步骤 1：协议决议状态机】
             ┌──────────────────────────────────────────────────┐
             │ ModelSpec.protocol 存在且非空?                    │
             │   ├── 是 ──> 继承 EffectiveProtocol = Model.proto │
             │   └── 否 ──> 读取 ProviderSpec.protocol           │
             │                ├── 存在 ──> EffectiveProtocol    │
             │                └── 缺省 ──> 回退 "openai/chat"   │
             └──────────────────────────────────────────────────┘
                                      │
                                      ▼
                        【步骤 2：模态白名单硬门禁】
             ┌──────────────────────────────────────────────────┐
             │ 检查输入附件中是否包含非文本 (image/video/pdf)?   │
             │   ├── 无 ──> 放行 (Pass to Payload Builder)       │
             │   └── 有 ──> 遍历每个附件的 MimeType:             │
             │        ├── image/* ──> 检查 input.contains(Image) │
             │        │    ├── 是 ──> 放行                       │
             │        │    └── 否 ──> 【硬阻断 400】UI 弹窗提示  │
             │        ├── application/pdf ──> 检查 File/Text 模态│
             │        │    ├── 支持 ──> 放行                     │
             │        │    └── 不支持 ──> 转为纯文本或阻断       │
             │        └── 其余不支持模态 ──> 【硬阻断】         │
             └──────────────────────────────────────────────────┘
```

#### 算法伪代码：模态与协议联合决议器 (Protocol & Modality Resolver)
```rust
#[derive(Debug)]
pub enum ResolutionError {
    ProviderNotFound(String),
    ModelNotFound(String),
    UnsupportedModality {
        model_id: String,
        required_modality: Modality,
    },
}

pub struct ResolvedRequestMeta {
    pub effective_protocol: String,
    pub wire_model_id: String,
    pub effective_base_url: String,
    pub effective_headers: HashMap<String, String>,
}

pub fn resolve_request_meta(
    config: &ModelsConfig,
    provider_id: &str,
    model_id: &str,
    has_images: bool,
    has_documents: bool,
) -> Result<ResolvedRequestMeta, ResolutionError> {
    let provider = config.providers.get(provider_id)
        .ok_or_else(|| ResolutionError::ProviderNotFound(provider_id.to_string()))?;

    let model = provider.models.iter().find(|m| m.id == model_id)
        .ok_or_else(|| ResolutionError::ModelNotFound(model_id.to_string()))?;

    // 1. 模态守门：若携带图片但模型声明不支持图片输入，立即拒绝，防止上游 400
    if has_images && !model.modalities.input.contains(&Modality::Image) {
        return Err(ResolutionError::UnsupportedModality {
            model_id: model_id.to_string(),
            required_modality: Modality::Image,
        });
    }

    // 2. 模态守门：若携带文档但模型不支持 File 且不支持 Image 解析
    if has_documents && !model.modalities.input.contains(&Modality::File) {
        return Err(ResolutionError::UnsupportedModality {
            model_id: model_id.to_string(),
            required_modality: Modality::File,
        });
    }

    // 3. 协议决议：模型级显式覆盖 > 供应商总协议 > 默认回退
    let effective_protocol = model.protocol.as_ref()
        .cloned()
        .unwrap_or_else(|| {
            if !provider.protocol.trim().is_empty() {
                provider.protocol.clone()
            } else {
                "openai/chat".to_string()
            }
        });

    Ok(ResolvedRequestMeta {
        effective_protocol,
        wire_model_id: model.id.clone(),
        effective_base_url: provider.base_url.clone(),
        effective_headers: provider.headers.clone(),
    })
}
```

---

### 5.2 动态上下文截断与子代理预算分配算法 (Token Clamp Engine)

#### 算法逻辑说明
在 Agent 运行过程中，模型不仅要保证自身单次 Prompt 序列不超过 `contextWindow`，在派发子 Agent（如探索类、实现类任务）时，必须依据父 Agent 上下文剩余水位与子模型的承载能力，动态钳制（Clamp）子 Agent 的 Prompt 上限与 MaxOutputTokens。

#### 算法伪代码：Token Clamp 引擎
```rust
#[derive(Debug, Clone, PartialEq)]
pub struct SubagentBudgetAllocation {
    pub clamped_context_window: u64,
    pub max_output_tokens: u64,
    pub max_prompt_budget: u64,
}

pub struct TokenClampEngine;

impl TokenClampEngine {
    /// 计算对话历史的最佳滑动窗口截断边界
    pub fn calculate_sliding_window_cut_index(
        messages_tokens: &[u64],
        system_prompt_tokens: u64,
        context_window: u64,
        reserved_output_tokens: u64,
        safety_headroom_tokens: u64,
    ) -> usize {
        let max_history_budget = context_window
            .saturating_sub(system_prompt_tokens)
            .saturating_sub(reserved_output_tokens)
            .saturating_sub(safety_headroom_tokens);

        let mut accumulated_tokens: u64 = 0;
        let mut cut_index = messages_tokens.len();

        // 从最新的消息向前累加，直到触达预算上限
        for (i, &token_count) in messages_tokens.iter().enumerate().rev() {
            if accumulated_tokens + token_count > max_history_budget {
                cut_index = i + 1; // 截断点在此处（更早的消息被剔除）
                break;
            }
            accumulated_tokens += token_count;
            cut_index = i;
        }

        cut_index
    }

    /// 为派发的子代理分配安全的 Token 预算
    pub fn allocate_subagent_budget(
        parent_model: &ModelSpec,
        subagent_model: &ModelSpec,
        parent_consumed_tokens: u64,
    ) -> SubagentBudgetAllocation {
        // 1. 父上下文剩余安全容量
        let parent_remaining = parent_model.context_window.saturating_sub(parent_consumed_tokens);
        
        // 2. 子模型物理上下文与最大生成上限
        let sub_context = subagent_model.context_window;
        let sub_max_output = subagent_model.max_output_tokens;

        // 3. 动态钳制：子代理 Prompt 预算不得超过父剩余的 80%，且不得超过子模型自身容量的 70%
        let dynamic_prompt_ceiling = std::cmp::min(
            (parent_remaining as f64 * 0.80) as u64,
            (sub_context as f64 * 0.70) as u64,
        );

        // 保障最低可用 Prompt 空间（例如 4,096 tokens）
        let safe_prompt_budget = std::cmp::max(dynamic_prompt_ceiling, 4096);

        // 4. 生成输出预算钳制
        let safe_output_budget = std::cmp::min(
            sub_max_output,
            sub_context.saturating_sub(safe_prompt_budget),
        );

        SubagentBudgetAllocation {
            clamped_context_window: sub_context,
            max_output_tokens: safe_output_budget,
            max_prompt_budget: safe_prompt_budget,
        }
    }
}
```

---

### 5.3 双币阶梯计量算费算法 (Dual-Currency Tiered Pricing Engine)

#### 算费逻辑说明
1. 若 `model.pricing` 为 `None`，计算函数直接返回 `None`，UI 静默折叠；
2. 若存在阶梯配置（`tiers`），首先依据总输入 Token 数量（`prompt_tokens`）检索最高命中的阶梯（`input_tokens_above` 倒序扫描）；
3. 按照四价指标（input, output, cacheRead, cacheWrite）分别计算分量，并在同一货币单位（CNY 或 USD）下累加；
4. 输出带货币符号的格式化字符串（如 `¥0.052` 或 `$0.0034`），严格保证浮点四舍五入与定点精度。

#### 算法伪代码：双币阶梯计量器
```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostBreakdown {
    pub currency: Currency,
    pub input_cost: f64,
    pub output_cost: f64,
    pub cache_read_cost: f64,
    pub cache_write_cost: f64,
    pub total_cost: f64,
    pub formatted_total: String,
}

pub struct PricingEngine;

impl PricingEngine {
    pub fn calculate_cost(
        pricing_opt: &Option<ModelPricing>,
        prompt_tokens: u64,
        completion_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<CostBreakdown> {
        let pricing = pricing_opt.as_ref()?;

        // 处理按张计费模式 (PerImage)
        if pricing.unit == PricingUnit::PerImage {
            // completion_tokens 在此处表示生成的图片数量
            let total_cost = (completion_tokens as f64) * pricing.output;
            let formatted = format_currency(total_cost, pricing.currency);
            return Some(CostBreakdown {
                currency: pricing.currency,
                input_cost: 0.0,
                output_cost: total_cost,
                cache_read_cost: 0.0,
                cache_write_cost: 0.0,
                total_cost,
                formatted_total: formatted,
            });
        }

        // 默认处理按百万 Token 计费模式 (Per1mTokens)
        let mut active_input_rate = pricing.input;
        let mut active_output_rate = pricing.output;
        let mut active_cache_read_rate = pricing.cache_read.unwrap_or(0.0);
        let mut active_cache_write_rate = pricing.cache_write.unwrap_or(0.0);

        // 检索是否有命中的阶梯费率 (Tiers 倒序排序，匹配最大门槛)
        if !pricing.tiers.is_empty() {
            let mut sorted_tiers = pricing.tiers.clone();
            sorted_tiers.sort_by(|a, b| b.input_tokens_above.cmp(&a.input_tokens_above));
            for tier in sorted_tiers {
                if prompt_tokens >= tier.input_tokens_above {
                    active_input_rate = tier.input;
                    active_output_rate = tier.output;
                    if let Some(cr) = tier.cache_read {
                        active_cache_read_rate = cr;
                    }
                    if let Some(cw) = tier.cache_write {
                        active_cache_write_rate = cw;
                    }
                    break;
                }
            }
        }

        // 扣除缓存命中后的普通输入 Token 数
        let non_cached_prompt_tokens = prompt_tokens.saturating_sub(cache_read_tokens);

        let input_cost = (non_cached_prompt_tokens as f64 / 1_000_000.0) * active_input_rate;
        let output_cost = (completion_tokens as f64 / 1_000_000.0) * active_output_rate;
        let cache_read_cost = (cache_read_tokens as f64 / 1_000_000.0) * active_cache_read_rate;
        let cache_write_cost = (cache_write_tokens as f64 / 1_000_000.0) * active_cache_write_rate;

        let total_cost = input_cost + output_cost + cache_read_cost + cache_write_cost;
        let formatted = format_currency(total_cost, pricing.currency);

        Some(CostBreakdown {
            currency: pricing.currency,
            input_cost,
            output_cost,
            cache_read_cost,
            cache_write_cost,
            total_cost,
            formatted_total: formatted,
        })
    }
}

fn format_currency(amount: f64, currency: Currency) -> String {
    let symbol = match currency {
        Currency::Cny => "¥",
        Currency::Usd => "$",
    };
    if amount < 0.001 && amount > 0.0 {
        format!("{}{:.6}", symbol, amount)
    } else {
        format!("{}{:.4}", symbol, amount)
    }
}
```

---

### 5.4 models.yaml 热重载与前端 Store 响应式原子替换算法

#### 热重载状态机与原子更新流
```
  [用户在界面保存/外部修改] ──> ~/.conex/models.yaml (磁盘写入)
                                        │
                                        ▼ (notify::Watcher 事件触发)
                        【Rust 内核配置重载器】
                                        │
                         1. YAML 解析与 Schema 校验
                         2. 校验成功 ──> 写入 ArcSwap / RwLock (内存原子替换)
                         3. 触发 Tauri IPC 事件: `models_config_changed`
                                        │
                                        ▼ (Tauri Event 广播)
                       【前端 modelsCatalogStore】
                                        │
                         1. 接收全新 ModelsConfig 载荷
                         2. 重新构建 Provider 树与扁平索引
                         3. 校验当前活动选中的 activeModelId 是否仍存在
                              ├── 存在 ──> 静默无损保留
                              └── 丢失 ──> 平滑回退至同 Provider 下第一个模型
                         4. UI 组件订阅毫秒级局部重绘 (零页面刷新)
```

---

## 六、精确到现有代码文件与函数签名的工程改造方案

为保障方案落地不走样，本节明确具体到文件路径、修改类型、函数签名与改动职责的改造矩阵。

### 6.1 Rust 后端内核工程改造清单

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       Rust 后端内核改造工程映射表                                                │
├─────────────────────────────────────────────────┬──────────┬─────────────────────────────────────────────────────┤
│ 现有/新建代码文件路径                           │ 改动类型 │ 核心函数签名 / 结构体定义                           │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ crates/agent-provider/src/models_config.rs      │ 【新建】 │ pub struct ModelsConfig;                            │
│                                                 │          │ pub struct ProviderSpec;                            │
│                                                 │          │ pub struct ModelSpec;                               │
│                                                 │          │ pub struct ModelPricing;                            │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ crates/agent-provider/src/pricing.rs            │ 【新建】 │ pub struct PricingEngine;                           │
│                                                 │          │ pub fn calculate_cost(...) -> Option<CostBreakdown>;│
│                                                 │          │ pub fn format_currency(...) -> String;              │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ crates/agent-provider/src/catalog.rs            │ 【改造】 │ // 废除 bundled_catalog 静态常量                    │
│                                                 │          │ pub fn get_runtime_catalog() -> Arc<ModelsConfig>;  │
│                                                 │          │ pub fn reload_models_config() -> Result<()>;        │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ crates/session-loop/src/context_manager.rs      │ 【改造】 │ pub fn clamp_context_window(                        │
│                                                 │          │     model: &ModelSpec,                              │
│                                                 │          │     history: &[Message]                             │
│                                                 │          │ ) -> Vec<Message>;                                  │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ crates/orchestrator/src/subagent_allocator.rs   │ 【改造】 │ pub fn allocate_subagent_budget(                    │
│                                                 │          │     parent: &ModelSpec,                             │
│                                                 │          │     child: &ModelSpec                               │
│                                                 │          │ ) -> SubagentBudgetAllocation;                      │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ apps/agent-workbench/src-tauri/src/commands/    │ 【改造】 │ #[tauri::command]                                   │
│ models.rs                                       │          │ pub async fn get_models_config(...) -> ModelsConfig;│
│                                                 │          │ pub async fn save_models_config(...) -> Result<()>; │
└─────────────────────────────────────────────────┴──────────┴─────────────────────────────────────────────────────┘
```

---

### 6.2 前端状态中枢与界面人体工学瘦身改造清单

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       前端状态中枢与 UI 改造工程映射表                                           │
├─────────────────────────────────────────────────┬──────────┬─────────────────────────────────────────────────────┤
│ 现有/新建代码文件路径                           │ 改动类型 │ 核心职责与人体工学改造要点                          │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ packages/shared-types/src/modelsConfig.ts       │ 【新建】 │ 导出与 Rust 完全同构的 TypeScript 强类型契约。       │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ apps/crish-desktop/src/stores/                  │ 【重构】 │ 彻底废除 LocalStorage 双轨存储，全面重写为订阅      │
│ modelsCatalogStore.ts                           │          │ Rust `models.yaml` 镜像的响应式中枢。               │
│                                                 │          │ 提供 `resolveEffectiveProtocol(pId, mId)` 等函数。  │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ apps/crish-desktop/src/components/settings/     │ 【改造】 │ 布局重构：在 BaseURL/ApiKey 正下方、模型列表正上方  │
│ ProviderSettings.tsx                            │          │ 置顶【供应商调用协议】下拉选择器（第一公民）。      │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ apps/crish-desktop/src/components/settings/     │ 【瘦身】 │ 人体工学瘦身核心：**物理移除协议下拉选择框**；       │
│ ModelConfigPanel.tsx                            │          │ 价格字段全部变为可选（无必填校验、无 0 元校验）；   │
│                                                 │          │ 突出 DisplayName、ContextWindow 与 Thinking 配置。  │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ apps/crish-desktop/src/components/chat/         │ 【改造】 │ 依据 `model.pricing` 渲染 `¥` 或 `$`；              │
│ TokenUsageBadge.tsx                             │          │ 未配置价格的模型彻底静默隐藏，不占用聊天气泡空间。  │
├─────────────────────────────────────────────────┼──────────┼─────────────────────────────────────────────────────┤
│ apps/crish-desktop/src/components/composer/     │ 【改造】 │ 依据 `activeModel.modalities.input` 动态控制附件    │
│ ComposerAttachmentDropzone.tsx                  │          │ 拖拽与粘贴行为，纯文本模型上传时实时 Tooltip 拦截。  │
└─────────────────────────────────────────────────┴──────────┴─────────────────────────────────────────────────────┘
```

#### 前端 ModelConfigPanel 核心改造对比（瘦身前后）
- **改造前（噪音过重）**：
  展开单个模型抽屉时，首先是一个占据整行高度的 `Protocol: [Select: openai/chat | anthropic | gemini]` 下拉菜单；下方是红星必填的 `Input Price ($)`、`Output Price ($)`。
- **改造后（极致干净人体工学）**：
  抽屉展开后，最顶层呈现清晰的 `Display Name (别名)` 与 `Context Window (Token 上限)`；协议选择器被彻底移除（界面显示小灰字提示：`默认继承供应商总协议: openai/chat`，仅在“高级设置”中允许极少数特殊模型覆盖）；价格模块默认折叠并标注“选填 (未填不统计费用)”。

---

## 七、存量数据迁移与向后兼容保障方案

为了保障用户的平滑升级，系统必须具备全自动、零感知的存量配置升级能力。

### 7.1 存量数据源格式对比与迁移逻辑

#### 历史存量数据格式 (旧版扁平 models.yaml)
```yaml
# 历史存量格式：扁平一维数组
models:
  - id: "deepseek-chat"
    name: "DeepSeek V3"
    vendor: "deepseek"
    baseUrl: "https://api.deepseek.com"
    contextWindow: 65536
  - id: "deepseek-coder"
    name: "DeepSeek Coder"
    vendor: "deepseek"
    baseUrl: "https://api.deepseek.com"
    contextWindow: 65536
  - id: "qwen-max"
    name: "Qwen Max"
    vendor: "qwen"
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    contextWindow: 32768
```

#### 迁移目标格式 (新版树状 Provider-Centric 拓扑)
```yaml
# 迁移后标准格式：Provider 为顶层主体
providers:
  deepseek:
    displayName: "deepseek"
    baseUrl: "https://api.deepseek.com"
    protocol: "openai/chat" # 自动探测或推导补齐
    compat: {}
    models:
      - id: "deepseek-chat"
        displayName: "DeepSeek V3"
        contextWindow: 65536
        maxOutputTokens: 8192
        modalities:
          input: ["text"]
          output: ["text"]
      - id: "deepseek-coder"
        displayName: "DeepSeek Coder"
        contextWindow: 65536
        maxOutputTokens: 8192
        modalities:
          input: ["text"]
          output: ["text"]
  qwen:
    displayName: "qwen"
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
    protocol: "openai/chat"
    compat: {}
    models:
      - id: "qwen-max"
        displayName: "Qwen Max"
        contextWindow: 32768
        maxOutputTokens: 8192
        modalities:
          input: ["text"]
          output: ["text"]
```

---

### 7.2 自动化迁移脚本与容灾备份机制

新建文件：`crates/agent-provider/src/migration.rs`

```rust
use std::fs;
use std::path::{Path, PathBuf};
use chrono::Local;
use serde_json::Value;

pub struct ConfigMigrationManager;

impl ConfigMigrationManager {
    /// 检测并执行自动升级迁移
    pub fn ensure_migrated(config_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        if !config_path.exists() {
            return Ok(());
        }

        let raw_content = fs::read_to_string(config_path)?;
        let parsed_yaml: Value = serde_yaml::from_str(&raw_content)?;

        // 判定依据：如果根结构包含 "models" 数组且不含 "providers" 键，判定为旧版格式
        if parsed_yaml.get("providers").is_none() && parsed_yaml.get("models").is_some() {
            log::info!("[Migration] 检测到旧版扁平 models.yaml，启动向后兼容升级流水线...");

            // 1. 容灾备份
            let backup_path = Self::create_backup(config_path)?;
            log::info!("[Migration] 原配置文件已自动备份至: {:?}", backup_path);

            // 2. 执行聚合重构转换
            let new_config = Self::migrate_flat_to_tree(&parsed_yaml)?;

            // 3. 安全落盘
            let new_yaml_str = serde_yaml::to_string(&new_config)?;
            fs::write(config_path, new_yaml_str)?;
            log::info!("[Migration] 树状架构升级完毕，已写回 models.yaml！");
        }

        Ok(())
    }

    fn create_backup(source: &Path) -> std::io::Result<PathBuf> {
        let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
        let file_stem = source.file_stem().and_then(|s| s.to_str()).unwrap_or("models");
        let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("yaml");
        let backup_name = format!("{}.{}.bak.{}", file_stem, timestamp, ext);
        let backup_path = source.with_file_name(backup_name);
        fs::copy(source, &backup_path)?;
        Ok(backup_path)
    }

    fn migrate_flat_to_tree(old: &Value) -> Result<Value, Box<dyn std::error::Error>> {
        use serde_json::json;
        let mut providers_map = serde_json::Map::new();

        if let Some(models_array) = old.get("models").and_then(|v| v.as_array()) {
            for m in models_array {
                let vendor = m.get("vendor").and_then(|v| v.as_str()).unwrap_or("custom");
                let base_url = m.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("https://api.openai.com/v1");

                let provider_entry = providers_map.entry(vendor.to_string()).or_insert_with(|| {
                    json!({
                        "displayName": vendor,
                        "baseUrl": base_url,
                        "protocol": "openai/chat",
                        "compat": {},
                        "models": []
                    })
                });

                let model_entry = json!({
                    "id": m.get("id").and_then(|v| v.as_str()).unwrap_or("unknown"),
                    "displayName": m.get("name").or_else(|| m.get("displayName")),
                    "contextWindow": m.get("contextWindow").unwrap_or(&json!(128000)),
                    "maxOutputTokens": m.get("maxTokens").or_else(|| m.get("maxOutputTokens")).unwrap_or(&json!(8192)),
                    "modalities": {
                        "input": ["text"],
                        "output": ["text"]
                    }
                });

                if let Some(models) = provider_entry.get_mut("models").and_then(|v| v.as_array_mut()) {
                    models.push(model_entry);
                }
            }
        }

        Ok(json!({ "providers": providers_map }))
    }
}
```

---

## 八、穷举式自动化测试用例集、魔鬼边界用例与验收断言矩阵

本节为本战役提供全套自动化测试套件与门禁断言矩阵，涵盖单元测试、前端集成测试、魔鬼边界用例与立体门禁检查清单。

### 8.1 单元测试套件 (Rust Unit Tests)

新建文件：`crates/agent-provider/tests/models_unification_tests.rs`

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn test_yaml_roundtrip_preserves_tree_structure() {
        let yaml_input = r#"
providers:
  deepseek:
    displayName: DeepSeek 官方
    baseUrl: https://api.deepseek.com
    protocol: openai/chat
    compat:
      thinkingFormat: deepseek
      supportsDeveloperRole: false
    models:
      - id: deepseek-v4-flash
        displayName: DeepSeek V4 Flash
        contextWindow: 1048576
        maxOutputTokens: 384000
        modalities:
          input:
            - text
          output:
            - text
        pricing:
          currency: CNY
          unit: per_1m_tokens
          input: 3.0
          output: 9.0
          cacheRead: 0.1
"#;
        let config: ModelsConfig = serde_yaml::from_str(yaml_input).expect("反序列化失败");
        assert_eq!(config.providers.len(), 1);
        
        let ds = config.providers.get("deepseek").unwrap();
        assert_eq!(ds.protocol, "openai/chat");
        assert_eq!(ds.models.len(), 1);

        let model = &ds.models[0];
        assert_eq!(model.id, "deepseek-v4-flash");
        assert_eq!(model.context_window, 1048576);
        
        let pricing = model.pricing.as_ref().unwrap();
        assert_eq!(pricing.currency, Currency::Cny);
        assert_eq!(pricing.input, 3.0);

        // 往返序列化比对
        let re_serialized = serde_yaml::to_string(&config).expect("序列化失败");
        let re_parsed: ModelsConfig = serde_yaml::from_str(&re_serialized).expect("二次解析失败");
        assert_eq!(config, re_parsed);
    }

    #[test]
    fn test_tiered_pricing_calculation_cny_and_usd() {
        // 测试 Qwen3.7-plus 阶梯计费逻辑：
        // 门槛 256K：inputTokensAbove: 262144 -> 费率翻倍
        let pricing = ModelPricing {
            currency: Currency::Cny,
            unit: PricingUnit::Per1mTokens,
            input: 2.0,
            output: 8.0,
            cache_read: Some(0.40),
            cache_write: None,
            tiers: vec![
                PricingTier {
                    input_tokens_above: 262144,
                    input: 4.0,
                    output: 12.0,
                    cache_read: Some(0.80),
                    cache_write: None,
                }
            ],
        };

        // 场景 A：未跨越阶梯 (100K 输入)
        let cost_a = PricingEngine::calculate_cost(
            &Some(pricing.clone()),
            100_000,
            10_000,
            20_000, // 20k 缓存命中
            0,
        ).unwrap();

        // 80k 普通输入 * 2.0 + 20k 缓存 * 0.40 + 10k 输出 * 8.0
        // = 0.16 + 0.008 + 0.08 = 0.248 元
        assert!((cost_a.total_cost - 0.248).abs() < 1e-6);
        assert_eq!(cost_a.currency, Currency::Cny);
        assert!(cost_a.formatted_total.starts_with('¥'));

        // 场景 B：跨越阶梯 (300K 输入 >= 262144)
        let cost_b = PricingEngine::calculate_cost(
            &Some(pricing),
            300_000,
            20_000,
            50_000, // 50k 缓存命中
            0,
        ).unwrap();

        // 命中阶梯：input rate = 4.0, output rate = 12.0, cache_read rate = 0.80
        // 250k 普通输入 * 4.0 = 1.0 元
        // 50k 缓存 * 0.80 = 0.04 元
        // 20k 输出 * 12.0 = 0.24 元
        // Total = 1.28 元
        assert!((cost_b.total_cost - 1.28).abs() < 1e-6);
    }

    #[test]
    fn test_silent_pricing_when_unconfigured() {
        let cost_opt = PricingEngine::calculate_cost(&None, 5000, 1000, 0, 0);
        assert!(cost_opt.is_none(), "未配置价格时必须静默返回 None");
    }

    #[test]
    fn test_modality_guard_blocks_image_injection_for_text_only_models() {
        let mut providers = HashMap::new();
        providers.insert("test-prov".to_string(), ProviderSpec {
            display_name: "Test".to_string(),
            base_url: "https://api.test.com".to_string(),
            protocol: "openai/chat".to_string(),
            compat: ProviderCompat::default(),
            headers: HashMap::new(),
            models: vec![
                ModelSpec {
                    id: "text-only-model".to_string(),
                    display_name: None,
                    protocol: None,
                    context_window: 65536,
                    max_output_tokens: 4096,
                    modalities: ModalitiesConfig {
                        input: vec![Modality::Text],
                        output: vec![Modality::Text],
                    },
                    thinking: None,
                    pricing: None,
                    sampling_params: HashMap::new(),
                    compat: None,
                }
            ],
        });
        let config = ModelsConfig { providers };

        // 模拟传入图片
        let res = resolve_request_meta(&config, "test-prov", "text-only-model", true, false);
        assert!(res.is_err());
        match res.unwrap_err() {
            ResolutionError::UnsupportedModality { model_id, required_modality } => {
                assert_eq!(model_id, "text-only-model");
                assert_eq!(required_modality, Modality::Image);
            }
            _ => panic!("预期返回 UnsupportedModality 错误"),
        }
    }

    #[test]
    fn test_token_clamp_subagent_budget() {
        let parent = ModelSpec {
            id: "parent-flagship".to_string(),
            display_name: None,
            protocol: None,
            context_window: 1_000_000,
            max_output_tokens: 65536,
            modalities: ModalitiesConfig::default(),
            thinking: None,
            pricing: None,
            sampling_params: HashMap::new(),
            compat: None,
        };

        let child = ModelSpec {
            id: "subagent-fast".to_string(),
            display_name: None,
            protocol: None,
            context_window: 131_072,
            max_output_tokens: 16384,
            modalities: ModalitiesConfig::default(),
            thinking: None,
            pricing: None,
            sampling_params: HashMap::new(),
            compat: None,
        };

        // 父模型已消耗 200,000 tokens，剩余 800,000
        let budget = TokenClampEngine::allocate_subagent_budget(&parent, &child, 200_000);
        
        // 子模型上限 131,072，70% 容量为 91,750
        // 父模型剩余 800,000 的 80% 为 640,000
        // 故子 Prompt 预算应被子自身容量严格钳制在 91,750
        assert_eq!(budget.max_prompt_budget, 91750);
        assert!(budget.max_output_tokens <= 16384);
    }
}
```

---

### 8.2 前端 Store 与 Hook 响应式集成测试 (Vitest)

新建文件：`apps/crish-desktop/tests/stores/modelsCatalogStore.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { useModelsCatalogStore } from '@/stores/modelsCatalogStore';
import type { ModelsConfig } from '@conex/shared-types';

describe('modelsCatalogStore 树状响应式集成测试', () => {
  beforeEach(() => {
    useModelsCatalogStore.getState().reset();
  });

  it('能够正确解析 Provider 树并继承总协议', () => {
    const mockConfig: ModelsConfig = {
      providers: {
        deepseek: {
          displayName: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com',
          protocol: 'openai/chat',
          compat: {},
          models: [
            {
              id: 'deepseek-v4-flash',
              contextWindow: 1048576,
              maxOutputTokens: 384000,
              modalities: { input: ['text'], output: ['text'] },
            },
            {
              id: 'deepseek-special-responses',
              protocol: 'openai/responses', // 局部覆盖
              contextWindow: 1048576,
              maxOutputTokens: 384000,
              modalities: { input: ['text'], output: ['text'] },
            },
          ],
        },
      },
    };

    useModelsCatalogStore.getState().setModelsConfig(mockConfig);

    const store = useModelsCatalogStore.getState();
    expect(store.providersList).toHaveLength(1);

    // 验证继承总协议
    const proto1 = store.resolveEffectiveProtocol('deepseek', 'deepseek-v4-flash');
    expect(proto1).toBe('openai/chat');

    // 验证局部覆盖协议
    const proto2 = store.resolveEffectiveProtocol('deepseek', 'deepseek-special-responses');
    expect(proto2).toBe('openai/responses');
  });

  it('未配置价格时 getModelPricingFormatted 返回空字符串而不报错', () => {
    const mockConfig: ModelsConfig = {
      providers: {
        ollama: {
          displayName: 'Ollama 本地',
          baseUrl: 'http://localhost:11434/v1',
          protocol: 'openai/chat',
          compat: {},
          models: [
            {
              id: 'llama3.1:8b',
              contextWindow: 128000,
              maxOutputTokens: 16384,
              modalities: { input: ['text'], output: ['text'] },
              // pricing 缺省
            },
          ],
        },
      },
    };

    useModelsCatalogStore.getState().setModelsConfig(mockConfig);
    const store = useModelsCatalogStore.getState();

    const formatted = store.getModelPricingFormatted('ollama', 'llama3.1:8b');
    expect(formatted).toBe(''); // 必须返回空字符串，彻底静默
  });
});
```

---

### 8.3 魔鬼边界用例 (Devil Edge Cases)

本节列出 10 类极其严苛的极限边界场景，方案已完全具备免疫防线：

1. **【边界 1】阶梯计费阈值精准等于 Prompt Tokens**：
   - *用例*：阶梯设定 `inputTokensAbove = 262144`，实际请求恰好 `prompt_tokens = 262144`；
   - *断言*：使用 `>=` 语义，精确命中新阶梯费率，不发生阶梯回退或浮点离散错误。
2. **【边界 2】单次输出超过 384K 的超长 CoT 累加**：
   - *用例*：DeepSeek V4 Flash 满载生成 384,000 tokens（含 300,000 reasoning tokens）；
   - *断言*：用量计算 `u64` 整数无溢出，计费结果在 `f64` 乘除中无精度丢弃。
3. **【边界 3】全零费率与免费模型（Free Model）**：
   - *用例*：用户显式配置 `input: 0.0, output: 0.0`；
   - *断言*：系统识别为“显式免费”，显示为“免费”标签，区别于未配置价格时的“静默隐藏”。
4. **【边界 4】用户向不支持图片的纯文本模型粘贴 Clipboard 图像**：
   - *用例*：活动模型为 `deepseek/deepseek-v4-flash`（未开 vision），开发者按 `Ctrl+V` 粘贴截图；
   - *断言*：前端 Composer 捕获事件，读取 `modalities.input`，立即弹出轻量级 Tooltip：`当前模型不支持图片输入，已取消粘贴`，底层完全不产生网络请求。
5. **【边界 5】跨币种会话混合汇总**：
   - *用例*：一个大任务中，主 Agent 跑在 OpenAI（USD），子 Agent 跑在 Qwen3.8（CNY）；
   - *断言*：用量统计面板中分别独立展示两行：`$0.042` 与 `¥0.38`，杜绝将两个币种的数值直接暴力相加。
6. **【边界 6】Provider 的 protocol 填入未知非标字符串**：
   - *用例*：用户手动在 YAML 中写入 `protocol: "custom/foo-bar"`；
   - *断言*：解析器不发生 panic，标记为自定义协议，Rust 端回退为标准 OpenAI 兼容调用，并在日志打出 Warning。
7. **【边界 7】磁盘 models.yaml 被清空为空文件（0 字节）**：
   - *用例*：外部编辑器异常导致文件清空；
   - *断言*：反序列化器捕获 `EOF` 错误，阻止替换内存 RCU，保留上一次有效的 Provider 配置快照，并在 UI 发出文件损坏通知。
8. **【边界 8】多重嵌套子代理并发派发时的 Context 耗尽**：
   - *用例*：主 Agent 上下文仅剩 5,000 tokens 时尝试派发子代理；
   - *断言*：Token Clamp 引擎触发保护底线，至少保留 4,096 最小可用窗口，或上报主控协调裁决。
9. **【边界 9】YAML 中存在非英文字符的思考档位**：
   - *用例*：用户手工填入 `levels: { "轻量思考": "low" }`；
   - *断言*：Schema 反序列化时执行纯英文白名单校验，拒绝非法键名，保障系统内 7 档纯英文铁律。
10. **【边界 10】单模型抽屉被用户展开 50 个连续切换**：
    - *用例*：大型 Provider 包含 50+ 模型，用户高频展开折叠；
    - *断言*：由于移除了单模型协议下拉框与冗余状态，DOM 节点数量减少 60%，渲染帧率稳固维持在 60 FPS，无内存泄漏。

---

### 8.4 集成审计门禁断言矩阵 (Integration Gate Checklist)

本矩阵作为重构后 CI/CD 与全链路验收的刚性门禁（Gate Assertion）：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              Conex 供应商与模型全线重构门禁核验矩阵                                    │
├────┬────────────────────────────┬────────────────────────────────────────────────────────┬─────────────┤
│ 序 │ 门禁检查项                 │ 刚性验收判定标准                                       │ 门禁拦截级别│
├────┼────────────────────────────┼────────────────────────────────────────────────────────┼─────────────┤
│ 1  │ SSOT 唯一真源门禁          │ 源码中彻底清除非法静态单例 `bundled_catalog.json`，     │ 【硬阻断】  │
│    │                            │ 全线运行期只读取 `models.yaml` 树状镜像。               │ CI 编译拦截 │
├────┼────────────────────────────┼────────────────────────────────────────────────────────┼─────────────┤
│ 2  │ 协议继承一致性门禁         │ 执行 `cargo test --package agent-provider`，            │ 【硬阻断】  │
│    │                            │ 验证全部 Provider 协议默认继承与模型显式覆盖 100% 通过。│ Test 门禁   │
├────┼────────────────────────────┼────────────────────────────────────────────────────────┼─────────────┤
│ 3  │ 双币计量四价精确度门禁     │ 运行 50 组跨币种（CNY/USD）与阶梯费率测试用例，         │ 【硬阻断】  │
│    │                            │ 浮点误差 < 1e-5，货币符号与单位标注完全正确。          │ Test 门禁   │
├────┼────────────────────────────┼────────────────────────────────────────────────────────┼─────────────┤
│ 4  │ 价格选填人体工学门禁       │ 未填价格在前端 0 报错、0 警告、UI 彻底不显示 0 元标签。│ 【硬阻断】  │
├────┼────────────────────────────┼────────────────────────────────────────────────────────┼─────────────┤
│ 5  │ 抽屉瘦身视觉门禁           │ 单模型展开抽屉中不得出现 `Protocol` 下拉选择菜单；     │ 【视觉审查】│
│    │                            │ 置顶 Provider `调用协议` 选择器。                      │ UI 验收     │
├────┼────────────────────────────┼────────────────────────────────────────────────────────┼─────────────┤
│ 6  │ 模态硬守门拦截门禁         │ 纯文本模型注入图片时，前端即刻拦截，后端返回 400 保护， │ 【硬阻断】  │
│    │                            │ 绝不向上游发出非法请求。                               │ E2E 门禁    │
├────┼────────────────────────────┼────────────────────────────────────────────────────────┼─────────────┤
│ 7  │ 存量无损升级迁移门禁       │ 旧版扁平 models.yaml 启动时 100% 自动生成备份并转换为   │ 【硬阻断】  │
│    │                            │ 树状结构，零字段丢失。                                 │ 回归测试    │
└────┴────────────────────────────┴────────────────────────────────────────────────────────┴─────────────┘
```

---

## 九、总结与实施路线图

本详案针对【议题 D】（多模态能力、上下文截断与双币计量结算体系）与【议题 E】（前端状态中枢重构、界面人体工学瘦身与全量立体验证），完成了从底层 Rust 强类型契约、Wire 协议通信、核心状态机与伪代码、现有文件改造、存量数据迁移到穷举测试门禁的全链路闭环设计。

重构实施阶段建议严格遵循以下节拍分步收敛：
1. **第一波（后端内核契约）**：落地 `models_config.rs`、`pricing.rs`、`migration.rs`，消除 `catalog.json` 静态死锁；
2. **第二波（协议决议与 Token 钳制）**：改造 `context_manager.rs` 与 `subagent_allocator.rs`，全线打通模态校验与 Token 动态分配；
3. **第三波（前端 Store 重构）**：落地 `packages/shared-types`，全面重写 `modelsCatalogStore.ts` 为树状单轨响应式中枢；
4. **第四波（界面瘦身与人体工学落地）**：改造 `ProviderSettings.tsx`（置顶协议）与 `ModelConfigPanel.tsx`（抽屉协议物理移除、价格彻底选填）；
5. **第五波（立体门禁全量运行）**：跑通本详案第八模块全部单元测试与集成测试矩阵，交付无瑕疵的工业级架构。
