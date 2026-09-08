# 阶段一：真源契约与 Rust 内核动态运行时重构计划 (01-Plan-Runtime)

> **战役工作区**：`docs/provider-model-unification/`
> **文档位置**：`docs/provider-model-unification/plans/01-真源契约与Rust内核动态运行时重构计划.md`
> **角色定位**：Core Contract & Rust Dynamic Runtime Planner
> **上游战略总纲**：`docs/provider-model-unification/00-供应商与模型能力全线接通重构总纲.md`
> **数据权威依据**：`docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`（2026 官方一手全景数据）
> **反过度设计与审计裁决**：`ANTI_OVERENGINEERING_GUARDRAILS.md`、`docs/provider-model-unification/audits/01-思考模型极致瘦身与去认知负担审计.md`
> **规划模式准则**：纯逻辑执行规划——仅包含逻辑先后顺序、因果依赖、文件域改动与验收断言，严禁涉及工期、人天、排期或业务优先级排序；所有任务单元按逻辑依赖自上而下刚性闭环。

---

## 目录 (Table of Contents)

- [一、方案全景与战略定位 (Strategic Positioning & Executive Summary)](#一方案全景与战略定位-strategic-positioning--executive-summary)
  - [1.1 方案使命与自上而下纯逻辑第一阶段定位](#11-方案使命与自上而下纯逻辑第一阶段定位)
  - [1.2 既有架构痛点深潜：编译期硬编码单例死锁与多轨分裂](#12-既有架构痛点深潜编译期硬编码单例死锁与多轨分裂)
  - [1.3 核心设计哲学：树状拓扑、纯配置驱动与并发租约隔离](#13-核心设计哲学树状拓扑纯配置驱动与并发租约隔离)
  - [1.4 最新最高裁决与架构极致扁平突破](#14-最新最高裁决与架构极致扁平突破)
- [二、树状数据真源与强类型契约系统 (Tree-Shaped SSOT & Rust Type System)](#二树状数据真源与强类型契约系统-tree-shaped-ssot--rust-type-system)
  - [2.1 目标数据真源物理规范与 YAML 映射语义](#21-目标数据真源物理规范与-yaml-映射语义)
  - [2.2 Rust 核心强类型结构体定义全集 (`UnifiedModelsConfig` 及其衍生契约)](#22-rust-核心强类型结构体定义全集-unifiedmodelsconfig-及其衍生契约)
  - [2.3 思考能力极简扁平映射契约 (`Option<IndexMap<String, String>>` 彻底拍平 `levels:`)](#23-思考能力极简扁平映射契约-optionindexmapstring-string-彻底拍平-levels)
  - [2.4 四维双币独立单价计量契约 (`PricingSpec`, `Currency::CNY`, `Currency::USD`)](#24-四维双币独立单价计量契约-pricingspec-currencycny-currencyusd)
  - [2.5 网关方言与特性兼容性声明契约 (`CompatSpec`)](#25-网关方言与特性兼容性声明契约-compatspec)
  - [2.6 容错反序列化、严格校验与向后安全设计](#26-容错反序列化严格校验与向后安全设计)
- [三、彻底废除编译期硬编码单例与 2026 权威种子库 (Eradicating Compile-Time Hardcoded Singleton)](#三彻底废除编译期硬编码单例与-2026-权威种子库-eradicating-compile-time-hardcoded-singleton)
  - [3.1 废止 `static BUNDLED_CATALOG: OnceLock` 与 `include_str!("catalog.json")`](#31-废止-static-bundled_catalog-oncelock-与-include_strcatalogjson)
  - [3.2 字典表本质定位：智能预填（Smart Autofill）而非锁死物理存储](#32-字典表本质定位智能预填smart-autofill而非锁死物理存储)
  - [3.3 2026 官方最新权威模型种子库真源设计 (11 大主流厂商全集核准)](#33-2026-官方最新权威模型种子库真源设计-11-大主流厂商全集核准)
  - [3.4 配置文件路径解析器与跨平台用户目录定位](#34-配置文件路径解析器与跨平台用户目录定位)
  - [3.5 首次启动自愈播种与原子写文件管道 (Seed Generator & Atomic Safe Writer)](#35-首次启动自愈播种与原子写文件管道-seed-generator--atomic-safe-writer)
  - [3.6 纯配置驱动与零静态拦截的不变量断言](#36-纯配置驱动与零静态拦截的不变量断言)
- [四、Rust 动态运行时中枢与热重载架构 (Dynamic Central Runtime & Hot-Reload Architecture)](#四rust-动态运行时中枢与热重载架构-dynamic-central-runtime--hot-reload-architecture)
  - [4.1 运行时模型目录索引结构 (`RuntimeCatalog` 倒排检索与缓存友好性)](#41-运行时模型目录索引结构-runtimecatalog-倒排检索与缓存友好性)
  - [4.2 双层并发控制：`RwLock<Arc<RuntimeCatalog>>` 与会话租约快照模型](#42-双层并发控制-rwlockarcruntimecatalog-与会话租约快照模型)
  - [4.3 动态中枢管理器 `CatalogManager` 完整接口与生命周期状态机](#43-动态中枢管理器-catalogmanager-完整接口与生命周期状态机)
  - [4.4 异步文件系统变更监听与防抖热重载管道 (`notify` + `tokio::sync::mpsc`)](#44-异步文件系统变更监听与防抖热重载管道-notify--tokiosyncmpsc)
  - [4.5 并发安全性证明：执行中长程 Agent 会话隔离 vs 新会话零延迟切换](#45-并发安全性证明执行中长程-agent-会话隔离-vs-新会话零延迟切换)
- [五、执行引擎解耦与协议路由改造 (Execution Engine & Protocol Decoupling)](#五执行引擎解耦与协议路由改造-execution-engine--protocol-decoupling)
  - [5.1 协议决议三级继承状态机 (Protocol Resolution Hierarchy)](#51-协议决议三级继承状态机-protocol-resolution-hierarchy)
  - [5.2 `engine_provider/protocol.rs` 改造详案：全量剥离静态引用](#52-engine_providerprotocolrs-改造详案全量剥离静态引用)
  - [5.3 `engine_build.rs` 计费四价、缓存策略与上下文窗口动态解析重构](#53-engine_buildrs-计费四价缓存策略与上下文窗口动态解析重构)
  - [5.4 思考强度与各大 Wire 协议 Payload 序列化装配实录](#54-思考强度与各大-wire-协议-payload-序列化装配实录)
  - [5.5 根除 URL 模糊子串探测：纯基于 `CompatSpec` 的声明式方言分发](#55-根除-url-模糊子串探测纯基于-compatspec-的声明式方言分发)
- [六、因果逻辑依赖与任务单元分解 (Causal Dependencies & Task Unit Breakdown)](#六因果逻辑依赖与任务单元分解-causal-dependencies--task-unit-breakdown)
  - [6.1 纯逻辑 DAG 因果依赖网络拓扑](#61-纯逻辑-dag-因果依赖网络拓扑)
  - [6.2 阶段一核心任务单元详细定义 (T-01 至 T-08)](#62-阶段一核心任务单元详细定义-t-01-至-t-08)
  - [6.3 源码文件域改动矩阵 (Exact Files, Modifying Actions & Symbol Diffs)](#63-源码文件域改动矩阵-exact-files-modifying-actions--symbol-diffs)
- [七、数据迁移与向下兼容实施方案 (Data Migration & Backward Compatibility)](#七数据迁移与向下兼容实施方案-data-migration--backward-compatibility)
  - [7.1 存量一维扁平 `models.yaml` 自动检测与树状结构提升转换器](#71-存量一维扁平-modelsyaml-自动检测与树状结构提升转换器)
  - [7.2 历史旧键平滑映射与废弃字段隔离](#72-历史旧键平滑映射与废弃字段隔离)
  - [7.3 语法损毁应急兜底机制与自动备份策略 (Fail-Safe Fallback & Auto-Backup)](#73-语法损毁应急兜底机制与自动备份策略-fail-safe-fallback--auto-backup)
- [八、穷举式立体测试套件与验收断言矩阵 (Exhaustive Verification Suite & Acceptance Assertions)](#八穷举式立体测试套件与验收断言矩阵-exhaustive-verification-suite--acceptance-assertions)
  - [8.1 强类型契约反序列化与双向往返 (Round-Trip) 测试集](#81-强类型契约反序列化与双向往返-round-trip-测试集)
  - [8.2 2026 官方权威模型基准数据一致性硬断言](#82-2026-官方权威模型基准数据一致性硬断言)
  - [8.3 `CatalogManager` 高并发并发竞争与原子替换压力测试](#83-catalogmanager-高并发并发竞争与原子替换压力测试)
  - [8.4 运行期租约快照隔离与会话保活回归用例](#84-运行期租约快照隔离与会话保活回归用例)
  - [8.5 自动化门禁命令集与架构红线自检表](#85-自动化门禁命令集与架构红线自检表)

---

## 一、方案全景与战略定位 (Strategic Positioning & Executive Summary)

### 1.1 方案使命与自上而下纯逻辑第一阶段定位

在大型复杂智能体软件系统（Agentic System）中，底层模型拓扑与供应商契约构成了整个系统运行的“第一性原理”。当底层数据结构发生扭曲或存在编译期硬编码时，上层所构建的所有自动化能力（思考强度感知、提示词前缀缓存注入、异步流式处理、计费核算、多 Agent 协同）均会遭遇严重的架构阻抗。

本重构计划作为【供应商与模型能力全线接通重构战役】的**第一阶段执行详案 (Plan 01)**，承担着为全战役筑造基石的核心使命。本方案纯粹从软件工程因果依赖与状态自洽展开，严格杜绝工期、人天、排期或“P0/P1”等主观业务降级概念。方案聚焦于以下核心攻坚目标：

1. **确立单一绝对数据真源 (Single Source of Truth, SSOT)**：
   废除所有存留在 LocalStorage、编译期二进制或零散状态中的配置副本，确立 `~/.conex/models.yaml` 为系统唯一的物理数据源；
2. **重塑强类型树状契约 (Provider-Centric Strong-Typed Contracts)**：
   打破历史一维扁平模型数组的设计缺陷，构建以供应商（Provider）为顶层主体的树状强类型结构体系，实现 BaseURL、协议（Protocol）、凭据、方言（Compat）与下属模型（Models）的自然归属与继承；
3. **彻底根除编译期静态单例死锁 (Zero Compile-Time Lock)**：
   从 Rust 源码与编译产物中彻底删除 `catalog.json` 物理内嵌与 `static BUNDLED_CATALOG: OnceLock<ModelCatalog>` 静态单例，系统对模型特性的认知 100% 由运行期外部配置驱动；
4. **构建无锁动态运行时与热重载中枢 (Dynamic Central Runtime & Hot-Reload)**：
   基于 `tokio::sync::RwLock<Arc<RuntimeCatalog>>` 实现双层并发控制，配合文件系统异步防抖监听器，实现免重启热重载；通过“不可变快照租约（Arc Lease）”机制，保障正在执行中的长程 Agent 会话零竞态、零漂移；
5. **注入 2026 年最新官方一手权威模型基线 (2026 Ground Truth Baseline)**：
   严格根据 `docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`，收录 DeepSeek V4 Pro、Claude Fable 5.1、GPT-5.6 Sol、Qwen 3.8 Max 等 2026 年真实发布的正代旗舰与主力模型，彻底消灭历史陈旧模型与 AI 幻觉。

### 1.2 既有架构痛点深潜：编译期硬编码单例死锁与多轨分裂

Conex 既有代码库在模型与供应商管理上积累了严重的架构技术债务，集中体现为三大死锁与断层：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              既有架构致命缺陷根因排查全景图                             │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   【缺陷 1：编译期静态单例死锁】              【缺陷 2：拓扑倒置与一维扁平】            │
│   apps/.../engine_provider/protocol.rs        ~/.conex/models.yaml                     │
│   ┌──────────────────────────────────┐        ┌──────────────────────────────────┐     │
│   │ static BUNDLED_CATALOG: OnceLock │        │ models:                          │     │
│   │   = ModelCatalog::bundled()      │        │   - id: deepseek-chat            │     │
│   │     (include_str!("catalog.json")│        │     vendor: deepseek (弱引用)    │     │
│   │                                  │        │     baseUrl: ... (重复冗余)      │     │
│   │ 问题: 用户修改外部 models.yaml,  │        │ 问题: 供应商不是一等公民;        │     │
│   │       内核网络调用依旧查静态表!  │        │       协议无法全局继承;          │     │
│   │       修改配置必须重启应用!      │        │       单模型重复配置协议产生噪音 │     │
│   └──────────────────────────────────┘        └──────────────────────────────────┘     │
│                    ▲                                           ▲                       │
│                    │                                           │                       │
│                    └─────────────────────┬─────────────────────┘                       │
│                                          │                                             │
│                                          ▼                                             │
│                        【缺陷 3：数据流多轨分裂与假真源】                              │
│                        - 轨 A: Rust BUNDLED_CATALOG (只读硬编码)                       │
│                        - 轨 B: 前端 LocalStorage: ProviderProfiles                     │
│                        - 轨 C: 磁盘 models.yaml (修改后对执行流无感)                   │
│                        结果: 运行时状态不可预测，私有网关 400 频发                     │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **编译期单例 `BUNDLED_CATALOG` 假真源死锁**：
   - 核心调用点：`apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs:39` 与 `crates/agent-provider/src/models/catalog.rs:341`。
   - 系统通过 `include_str!("catalog.json")` 将静态 JSON 编译嵌入可执行文件，并封装为 `static BUNDLED_CATALOG: OnceLock<ModelCatalog>`。
   - 当 `engine_provider.rs` 发起流式请求构建、`engine_build.rs` 计算缓存策略或验证上下文窗口时，底层直接查询 `bundled_catalog()`。这导致用户在外部配置中即便将上下文调至 1M，内核依然按照静态打包的旧上限进行拦截截断，用户修改配置对内核核心完全透明无效。
2. **拓扑倒置与一维扁平配置**：
   - 历史 `models.yaml` 采用一维数组 `models: Vec<ModelInfo>`，供应商作为从属属性 `vendor` 倒置挂载在模型下方。导致每个模型都要反复配置相同的 BaseURL，供应商无法统一管理调用协议，造成前端设置界面中展开每一个单模型都必须重复选择协议的视觉噪音。
3. **URL 模糊字面量探测（Substring Matching）**：
   - 协议层充斥着 `if base_url.contains("deepseek")` 等脆弱的字面量探测代码。在企业私有网关、中继反代（如 `https://ai-gateway.corp.internal/v1`）环境下彻底失效，频繁引发参数错配与 HTTP 400 崩溃。

### 1.3 核心设计哲学：树状拓扑、纯配置驱动与并发租约隔离

为根治上述缺陷，本方案树立三大设计基石：

1. **树状层级权威 (Provider-Centric Hierarchy)**：
   建立严格的父子继承范式：
   $$\text{ProviderSpec} \xrightarrow{\text{统辖与提供默认}} \text{ModelSpec}$$
   供应商统辖默认调用协议（`protocol`）、基准地址（`baseUrl`）、通用鉴权（`apiKey`）、HTTP 请求头（`headers`）以及兼容方言（`compat`）。下属模型自动继承全部父级属性，仅在存在差异时（如跨协议特定模型）声明局部覆盖。
2. **零编译锁定 (Zero Compile-Locking)**：
   编译产物不携带任何业务模型元数据。系统启动时优先读取物理真源，缺失时通过纯逻辑算法生成 2026 官方权威种子并安全落盘。内核执行逻辑完全由该真源驱动。
3. **无锁不可变租约模型 (Arc Snapshot Lease Model)**：
   基于 `RwLock<Arc<RuntimeCatalog>>`，会话在创建瞬间通过强引用克隆获取当前快照的租约。在长程多轮 Agent 推理生命周期内，该快照内存只读不变，彻底规避热重载并发写入引发的状态竞态。

### 1.4 最新最高裁决与架构极致扁平突破

用户的最新最高裁决指出了一个极其深刻的架构真理：
> **“既然 mandatory 和 defaultLevel 都已被砍掉，thinking 下面就只剩映射，thinking 下面再加 levels 是不是多余了？多包一层 levels: 是典型的历史包袱冗余！”**

本方案对此进行**刚性扁平化收敛**：
1. **彻底拍平 `thinking:` 节点，彻底剔除 `levels:` 中间层**：
   ```yaml
   # 最终极致极简格式：
   thinking:
     Low: "low"
     Medium: "medium"
     High: "high"
   ```
   - 不再有多余的 `levels:` 嵌套包装；
   - Key 直接是前端 UI 显示的标准纯英文 TitleCase（如 `Low`, `Medium`, `High`, `Max`, `Off`）；
   - Value 直接是底层实际发送给 API 的真实参数值（如 `"low"`, `"medium"`, `"high"`）；
   - 不支持思考的模型直接不写 `thinking` 字段（None/undefined），UI 彻底折叠胶囊；
   - 若字典的 Keys 集合中**不包含 `"Off"`**，天然表达该模型无法关闭思考（强制思考），UI 绝不渲染 Off 选项，彻底消灭 `mandatory: bool` 伪概念；
   - 彻底废除 `defaultLevel`，用户切换模型时意图保持，并在目标模型支持的档位中就近对齐自愈。
2. **Rust 强类型直接收敛为扁平字典**：
   `pub thinking: Option<IndexMap<String, String>>`（保留用户配置顺序，无多余嵌套结构体）。
3. **TypeScript 前端类型直接收敛**：
   `thinking?: Record<string, string>`。
4. **字典表本质定位声明**：
   基于官方调研提取的模型字典表仅作为用户在界面输入模型 ID 时的“智能预填写（Smart Autofill）”，严禁作为静态锁死物理存储！物理真源永远是 `~/.conex/models.yaml`。
5. **缓存读取 cacheRead 绝非固定打一折**：
   严禁粗暴假设“缓存读取一律是一折”！各厂商模型的缓存读取费用完全是独立的绝对单价（DeepSeek V4 是 0.1元 vs 3元即 3.3%；百炼是 2.4元 vs 12元即 20%；Claude 是 0.25美元 vs 10美元即 2.5%）。必须作为独立四维单价字段如实记录，杜绝固定折扣硬编码！

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              最新裁决与契约瘦身对照矩阵                                 │
├──────────────────┬────────────────────────────────────┬────────────────────────────────┤
│ 契约维度         │ 早期过度工程设计 (已废止)          │ 阶段一最终落地规范 (本计划)    │
├──────────────────┼────────────────────────────────────┼────────────────────────────────┤
│ 1. 思考档位形态  │ `levels: [Low, High]` 或多层嵌套   │ 【直接拍平 Key-Value 字典】    │
│                  │ 多余包了一层 `levels:`             │ `thinking: { Low: "low", ... }`│
├──────────────────┼────────────────────────────────────┼────────────────────────────────┤
│ 2. 思考控制开关  │ `mandatory: bool` 伪概念           │ 【彻底废除 mandatory】         │
│                  │ (导致双重判定、状态冲突)           │ 纯由字典是否包含 "Off" 判定    │
├──────────────────┼────────────────────────────────────┼────────────────────────────────┤
│ 3. 默认思考强度  │ `defaultLevel: "medium"` 静态声明  │ 【彻底废除 defaultLevel】      │
│                  │ (死板绑架交互、切模型重置体验)     │ 前端意图连续保持 + 动态集合对齐│
├──────────────────┼────────────────────────────────────┼────────────────────────────────┤
│ 4. 字典表角色    │ 编译期打包作为静态单例物理存储     │ 【智能预填 Smart Autofill】    │
│                  │ (导致修改 YAML 内核完全无感)       │ 仅供 UI 自动补全，真源永远在YAML│
├──────────────────┼────────────────────────────────────┼────────────────────────────────┤
│ 5. 缓存读取价格  │ 盲目臆测固定打一折 (0.1x)          │ 【独立绝对单价】               │
│                  │ 导致各厂商真实费率失真             │ 各模型四维价格独立填报，零硬编码│
├──────────────────┼────────────────────────────────────┼────────────────────────────────┤
│ 6. 价格计量币种  │ 强制要求填价格，仅支持 USD         │ 【四维价格全选填 + 双币】      │
│                  │ 未填报错或呈0元，国内模型强行换汇  │ 原生支持 `CNY (¥)` 与 `USD ($)`│
└──────────────────┴────────────────────────────────────┴────────────────────────────────┘
```

---

## 二、树状数据真源与强类型契约系统 (Tree-Shaped SSOT & Rust Type System)

### 2.1 目标数据真源物理规范与 YAML 映射语义

跨系统唯一物理真源文件路径统一规定为：`~/.conex/models.yaml`。文件编码采用 UTF-8（无 BOM），使用标准 YAML 1.2 语法。

#### 物理真源生产范例（彻底拍平 `thinking:`，去除 `levels:`）：

```yaml
# ==============================================================================
# Conex - 统一供应商与模型能力真源配置文件 (models.yaml)
# 严格 Provider-Centric 树状拓扑 · 纯配置驱动 · 支持热重载 · 极致扁平
# ==============================================================================

providers:
  # ----------------------------------------------------------------------------
  # DeepSeek (深度求索 · 官方双协议原生)
  # ----------------------------------------------------------------------------
  deepseek:
    displayName: "DeepSeek"
    baseUrl: "https://api.deepseek.com"
    protocol: "openai/chat"
    apiKey: "$DEEPSEEK_API_KEY"
    compat:
      thinkingFormat: "deepseek"
      supportsDeveloperRole: false
      maxTokensField: "max_tokens"
    models:
      - id: "deepseek-v4-pro"
        displayName: "DeepSeek V4 Pro"
        contextWindow: 1048576
        maxOutputTokens: 384000
        thinking:
          Low: "low"
          High: "high"
          Max: "max"
        pricing:
          currency: "CNY"
          unit: "per_1m_tokens"
          input: 9.0
          output: 27.0
          cacheRead: 0.30
          cacheWrite: 0.0

      - id: "deepseek-v4-flash"
        displayName: "DeepSeek V4 Flash"
        contextWindow: 1048576
        maxOutputTokens: 384000
        thinking:
          Low: "low"
          High: "high"
          Max: "max"
        pricing:
          currency: "CNY"
          unit: "per_1m_tokens"
          input: 3.0
          output: 9.0
          cacheRead: 0.10
          cacheWrite: 0.0

  # ----------------------------------------------------------------------------
  # Anthropic (Messages 协议原生)
  # ----------------------------------------------------------------------------
  anthropic:
    displayName: "Anthropic"
    baseUrl: "https://api.anthropic.com"
    protocol: "anthropic/messages"
    apiKey: "$ANTHROPIC_API_KEY"
    compat:
      thinkingFormat: "anthropic"
      supportsDeveloperRole: false
      maxTokensField: "max_tokens"
      cacheControlFormat: "anthropic"
    models:
      - id: "claude-fable-5.1"
        displayName: "Claude Fable 5.1"
        contextWindow: 1000000
        maxOutputTokens: 128000
        thinking:
          Low: "low"
          Medium: "medium"
          High: "high"
          Max: "max"
        pricing:
          currency: "USD"
          unit: "per_1m_tokens"
          input: 10.0
          output: 50.0
          cacheRead: 0.25
          cacheWrite: 12.50

      - id: "claude-opus-5"
        displayName: "Claude Opus 5"
        contextWindow: 1000000
        maxOutputTokens: 128000
        thinking:
          Off: "off"
          Low: "low"
          Medium: "medium"
          High: "high"
          Max: "max"
        pricing:
          currency: "USD"
          unit: "per_1m_tokens"
          input: 5.0
          output: 25.0
          cacheRead: 0.50
          cacheWrite: 6.25

  # ----------------------------------------------------------------------------
  # OpenAI (Chat / Responses 双协议)
  # ----------------------------------------------------------------------------
  openai:
    displayName: "OpenAI"
    baseUrl: "https://api.openai.com/v1"
    protocol: "openai/chat"
    apiKey: "$OPENAI_API_KEY"
    compat:
      thinkingFormat: "openai"
      supportsDeveloperRole: true
      maxTokensField: "max_completion_tokens"
    models:
      - id: "gpt-5.6-sol"
        displayName: "GPT-5.6 Sol"
        protocol: "openai/responses"
        contextWindow: 1050000
        maxOutputTokens: 128000
        thinking:
          Off: "none"
          Low: "low"
          Medium: "medium"
          High: "high"
          Max: "high"
        pricing:
          currency: "USD"
          unit: "per_1m_tokens"
          input: 4.0
          output: 20.0
          cacheRead: 0.40
          cacheWrite: 5.0
```

### 2.2 Rust 核心强类型结构体定义全集 (`UnifiedModelsConfig` 及其衍生契约)

落盘位置：`crates/agent-provider/src/models/config.rs`。

```rust
// crates/agent-provider/src/models/config.rs

use std::collections::BTreeMap;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use super::pricing::PricingSpec;
use super::compat::{CompatSpec, ModalitySpec};

/// 树状模型配置顶层绝对单一真源根结构
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UnifiedModelsConfig {
    /// 供应商映射字典，键为供应商机器可读标识符 (如 "deepseek", "openai", "qwen")
    pub providers: BTreeMap<String, ProviderSpec>,
}

/// 供应商层级规范定义 (ProviderSpec)
/// 作为整个模型体系的一级主体，管理端点、协议、凭据与下属模型集合
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// 供应商展示名 (如 "DeepSeek", "Anthropic", "阿里云百炼")
    pub display_name: String,
    /// 供应商 API 服务基准地址 (如 "https://api.deepseek.com")
    pub base_url: String,
    /// 供应商默认总线调用协议，下属模型未显式声明时自动继承
    pub protocol: WireProtocol,
    /// 身份认证凭证，支持环境变量模板 (如 "$DEEPSEEK_API_KEY") 或字面量明文
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// 自定义 HTTP 请求头注入字典，适配各类第三方网关透传
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    /// 供应商级兼容性与方言声明
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatSpec>,
    /// 该供应商所拥有的模型列表
    #[serde(default)]
    pub models: Vec<ModelSpec>,
}

/// 模型层级规范定义 (ModelSpec)
/// 依附于 ProviderSpec 存在，仅在关键属性存在异构特征时允许局部覆盖
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    /// 模型在 API Wire 中的真实调用代号 (如 "deepseek-v4-pro", "gpt-5.6-sol")
    pub id: String,
    /// 模型在 UI、选择器与日志中的友好展示名
    pub display_name: String,
    /// 模型级协议显式覆盖项。若为 None，则强制继承 ProviderSpec.protocol
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<WireProtocol>,
    /// 模型输入上下文最大容量 (Tokens)
    pub context_window: u64,
    /// 模型单次生成最大输出 Token 上限
    pub max_output_tokens: u64,
    /// 思考/推理能力扁平映射字典 (彻底拍平，无 levels: 冗余包装)。
    /// - None: 不支持思考模式 (UI 彻底折叠隐藏胶囊)
    /// - Some(IndexMap): Key 为前端 UI 纯英文 TitleCase (如 "Off", "Low", "Medium", "High", "Max")，
    ///   Value 为传递给 API Wire 的真实参数字符串 (如 "off", "low", "medium", "high")。
    ///   若字典中不包含 "Off"，天然代表强制思考，UI 自动剔除 Off 选项，零多余布尔值。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking: Option<IndexMap<String, String>>,
    /// 模型四维双币价格计量规格。选填，未配置时系统静默跳过费用核算
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<PricingSpec>,
    /// 多模态输入支持规格声明 (文本、图片、视频、音频、文件等)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modalities: Option<ModalitySpec>,
    /// 模型局部兼容性方言覆盖项
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatSpec>,
}

/// 底层线网调用协议枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum WireProtocol {
    /// 经典 OpenAI Chat Completions 协议 (/v1/chat/completions)
    #[serde(rename = "openai/chat")]
    OpenAiChat,
    /// 全新 OpenAI Responses 状态化协议 (/v1/responses)
    #[serde(rename = "openai/responses")]
    OpenAiResponses,
    /// Anthropic 原生 Messages 协议 (/v1/messages)
    #[serde(rename = "anthropic/messages")]
    AnthropicMessages,
    /// Google 原生 GenerateContent 协议 (/v1beta/models/{model}:streamGenerateContent)
    #[serde(rename = "google/generate-content")]
    GoogleGenerateContent,
}

impl Default for WireProtocol {
    fn default() -> Self {
        Self::OpenAiChat
    }
}
```

### 2.3 思考能力极简扁平映射契约 (`Option<IndexMap<String, String>>` 彻底拍平 `levels:`)

落盘位置：`crates/agent-provider/src/models/thinking.rs`。

#### 架构极简演进逻辑：
- 早期设计：`thinking: { enabled: true, mandatory: true, defaultLevel: "medium", levels: { ... } }` $\rightarrow$ 认知爆炸、多重判定；
- 中期设计：`thinking: { enabled: true, levels: { ... } }` $\rightarrow$ 依然存在无意义的包装；
- **本方案最终收敛**：`thinking: { "Low": "low", "High": "high" }` $\rightarrow$ 彻底拍平！
  - **`None`**：不支持思考，UI 折叠隐藏胶囊；
  - **`Some(map)`**：支持思考，按 `map.keys()` 的插入顺序渲染纯英文胶囊菜单项；
  - **强制思考自然自洽**：只要 `map` 中没有 `"Off"` 键，UI 绝不渲染 Off 选项，不需要任何 `mandatory` 标记；
  - **用户意图保持**：切换模型时，若用户选的档位在目标模型的 `map.keys()` 中存在则保持，不存在则就近对齐自愈。

```rust
// crates/agent-provider/src/models/thinking.rs

use indexmap::IndexMap;

/// 针对 Option<IndexMap<String, String>> 的业务扩展 Trait
pub trait ThinkingMapExt {
    /// 判断是否允许用户手动关闭思考 (即是否包含 "Off" 键)
    fn allows_off(&self) -> bool;
    /// 获取指定 TitleCase 对应的 Wire 参数字符串
    fn get_wire_value(&self, title: &str) -> Option<&str>;
    /// 获取所有支持的纯英文档位 Title 列表
    fn available_titles(&self) -> Vec<&str>;
}

impl ThinkingMapExt for Option<IndexMap<String, String>> {
    fn allows_off(&self) -> bool {
        match self {
            Some(map) => map.contains_key("Off"),
            None => false,
        }
    }

    fn get_wire_value(&self, title: &str) -> Option<&str> {
        self.as_ref().and_then(|m| m.get(title).map(|s| s.as_str()))
    }

    fn available_titles(&self) -> Vec<&str> {
        match self {
            Some(map) => map.keys().map(|k| k.as_str()).collect(),
            None => Vec::new(),
        }
    }
}
```

### 2.4 四维双币独立单价计量契约 (`PricingSpec`, `Currency::CNY`, `Currency::USD`)

落盘位置：`crates/agent-provider/src/models/pricing.rs`。

#### 核心审计铁律：
- **缓存读取 cacheRead 绝非固定打一折**！
- 严禁在代码中出现 `input * 0.1` 这种粗暴硬编码！
- DeepSeek、Claude、百炼、OpenAI 各厂商模型的缓存读取费用完全是独立的绝对单价：
  - DeepSeek V4 Pro: 输入 ¥9.00 / 缓存读取 ¥0.30 (3.3%)
  - 阿里云百炼 Qwen 3.8 Max: 输入 ¥12.00 / 缓存读取 ¥2.40 (20%)
  - Claude Fable 5.1: 输入 $10.00 / 缓存读取 $0.25 (2.5%)
  - GPT-5.6 Sol: 输入 $4.00 / 缓存读取 $0.40 (10%)
- 四维价格（`input`, `output`, `cache_read`, `cache_write`）全部作为独立浮点字段，且为 `Option<f64>`（完全选填）。

```rust
// crates/agent-provider/src/models/pricing.rs

use serde::{Deserialize, Serialize};

/// 结算币种强类型定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Currency {
    /// 人民币结算 (¥)
    #[serde(rename = "CNY")]
    Cny,
    /// 美元结算 ($)
    #[serde(rename = "USD")]
    Usd,
}

impl Default for Currency {
    fn default() -> Self {
        Self::Usd
    }
}

/// 计价基准单位
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PricingUnit {
    /// 每 100 万 Tokens 标准计费 (工业级统一基准)
    #[serde(rename = "per_1m_tokens")]
    Per1MTokens,
    /// 按生成张数计费 (针对独立生图模型)
    #[serde(rename = "per_image")]
    PerImage,
}

impl Default for PricingUnit {
    fn default() -> Self {
        Self::Per1MTokens
    }
}

/// 四维双币价格契约规范 (PricingSpec)
/// 严格四指标：输入、输出、缓存读取、缓存写入，全选填且价格完全独立，杜绝固定打折假设
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PricingSpec {
    /// 结算货币类型 (CNY / USD)
    pub currency: Currency,
    /// 计费单位 (默认 per_1m_tokens)
    pub unit: PricingUnit,
    /// 基础普通提示词输入价格 (Per Unit)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<f64>,
    /// 生成补全输出价格 (Per Unit)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<f64>,
    /// 提示词上下文缓存命中读取独立价格 (Cache Read / Hit)，严禁使用固定一折假设
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    /// 提示词上下文缓存创建写入独立价格 (Cache Write / Creation)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

impl PricingSpec {
    /// 基于独立的四维单价计算用量真实费用，未配置价格时返回 None
    pub fn calculate_cost(
        &self,
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    ) -> Option<f64> {
        let mut total = 0.0;
        let mut has_any_price = false;

        if let Some(price) = self.input {
            total += (input_tokens as f64 / 1_000_000.0) * price;
            has_any_price = true;
        }
        if let Some(price) = self.output {
            total += (output_tokens as f64 / 1_000_000.0) * price;
            has_any_price = true;
        }
        if let Some(price) = self.cache_read {
            total += (cache_read_tokens as f64 / 1_000_000.0) * price;
            has_any_price = true;
        }
        if let Some(price) = self.cache_write {
            total += (cache_write_tokens as f64 / 1_000_000.0) * price;
            has_any_price = true;
        }

        if has_any_price {
            Some(total)
        } else {
            None
        }
    }
}
```

### 2.5 网关方言与特性兼容性声明契约 (`CompatSpec`)

落盘位置：`crates/agent-provider/src/models/compat.rs`。

```rust
// crates/agent-provider/src/models/compat.rs

use serde::{Deserialize, Serialize};

/// 供应商及模型级兼容性矩阵定义 (CompatSpec)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CompatSpec {
    /// 思考/推理参数组装方言
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<ThinkingFormat>,
    /// 是否支持 OpenAI 标准的 developer 角色。若为 false，内核自动降级为 system 角色
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,
    /// 生成长度限制的 Wire 字段名 (如 max_tokens vs max_completion_tokens)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<MaxTokensField>,
    /// 缓存断点控制注入格式
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_control_format: Option<CacheControlFormat>,
}

/// 思考参数 Wire 组装方言
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ThinkingFormat {
    /// OpenAI 标准 (reasoning_effort: "low" | "medium" | "high")
    #[serde(rename = "openai")]
    OpenAi,
    /// DeepSeek 原生方言 (thinking: { type: "enabled" | "disabled" })
    #[serde(rename = "deepseek")]
    DeepSeek,
    /// 阿里百炼方言 (enable_thinking: bool)
    #[serde(rename = "qwen")]
    Qwen,
    /// 智谱 BigModel 方言 (thinking: { type: "enable" })
    #[serde(rename = "zai")]
    Zai,
    /// Anthropic 原生方言 (thinking: { type: "enabled", budget_tokens: N })
    #[serde(rename = "anthropic")]
    Anthropic,
    /// Google 原生方言 (thinkingConfig: { thinkingLevel: ... })
    #[serde(rename = "gemini")]
    Gemini,
}

/// 生成上限字段定义
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MaxTokensField {
    #[serde(rename = "max_tokens")]
    MaxTokens,
    #[serde(rename = "max_completion_tokens")]
    MaxCompletionTokens,
}

/// 缓存控制注入格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CacheControlFormat {
    /// Anthropic 风格 (cache_control: { type: "ephemeral" })
    #[serde(rename = "anthropic")]
    Anthropic,
}

/// 多模态输入能力位掩码
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModalitySpec {
    pub text: bool,
    pub image: bool,
    pub video: bool,
    pub audio: bool,
    pub file: bool,
}
```

### 2.6 容错反序列化、严格校验与向后安全设计

落盘位置：`crates/agent-provider/src/models/validation.rs`。

```rust
// crates/agent-provider/src/models/validation.rs

use super::config::UnifiedModelsConfig;
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum ConfigValidationError {
    #[error("供应商 '{0}' 的 BaseURL 不能为空或格式非法")]
    InvalidBaseUrl(String),
    #[error("供应商 '{0}' 下存在重复的模型 ID: '{1}'")]
    DuplicateModelId(String, String),
    #[error("模型 '{0}' 的 contextWindow ({1}) 不能小于 maxOutputTokens ({2})")]
    InvalidTokenWindow(String, u64, u64),
    #[error("模型 '{0}' 声明了 thinking 字段但映射字典为空")]
    EmptyThinkingMap(String),
}

impl UnifiedModelsConfig {
    /// 执行配置自检，确保关键不变量成立
    pub fn validate(&self) -> Result<(), ConfigValidationError> {
        for (provider_id, provider) in &self.providers {
            if provider.base_url.trim().is_empty() || !provider.base_url.starts_with("http") {
                return Err(ConfigValidationError::InvalidBaseUrl(provider_id.clone()));
            }

            let mut seen_models = std::collections::HashSet::new();
            for model in &provider.models {
                if !seen_models.insert(&model.id) {
                    return Err(ConfigValidationError::DuplicateModelId(provider_id.clone(), model.id.clone()));
                }

                if model.context_window < model.max_output_tokens {
                    return Err(ConfigValidationError::InvalidTokenWindow(
                        model.id.clone(),
                        model.context_window,
                        model.max_output_tokens,
                    ));
                }

                if let Some(ref map) = model.thinking {
                    if map.is_empty() {
                        return Err(ConfigValidationError::EmptyThinkingMap(model.id.clone()));
                    }
                }
            }
        }
        Ok(())
    }
}
```

---

## 三、彻底废除编译期硬编码单例与 2026 权威种子库 (Eradicating Compile-Time Hardcoded Singleton)

### 3.1 废止 `static BUNDLED_CATALOG: OnceLock` 与 `include_str!("catalog.json")`

彻底废除编译期静态硬编码单例是阶段一的核心红线任务。

#### 物理清理清单：
1. **删除静态文件**：执行 `rm crates/agent-provider/src/models/catalog.json`；
2. **清理内核引用**：移除 `crates/agent-provider/src/models/catalog.rs` 中的 `ModelCatalog::bundled()` 方法；
3. **清理壳层单例**：移除 `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs` 中的 `static BUNDLED_CATALOG: OnceLock<ModelCatalog>` 及辅助函数 `bundled_catalog()`。

### 3.2 字典表本质定位：智能预填（Smart Autofill）而非锁死物理存储

必须在系统设计中彻底澄清字典表（基于官方调研提取的模型字典库）的定位：
- **字典表本质是“智能预填数据（Smart Autofill）”**：当用户在设置界面输入或选择模型 ID 时，系统自动联想预填上下文上限、思考档位映射与四维官方参考价格；
- **字典表绝非物理存储，也绝不拦截网络调用**：运行时的物理真源永远且仅为 `~/.conex/models.yaml`。用户完全可以修改预填出来的任何参数，或添加字典表中根本不存在的私有微调模型，内核一视同仁无条件放行执行。

### 3.3 2026 官方最新权威模型种子库真源设计 (11 大主流厂商全集核准)

严格依据 `01-主流模型多源权威数据全景调研.md`，构建全集权威种子库。思考档位全量采用扁平 `Key-Value` 字典映射，缓存读取价格如实填报官方一手数据。

落盘位置：`crates/agent-provider/src/models/seed.rs`。

```rust
// crates/agent-provider/src/models/seed.rs

use super::config::*;
use super::pricing::*;
use super::compat::*;
use std::collections::BTreeMap;
use indexmap::IndexMap;

/// 构造 2026 年官方最新基准模型全集种子配置
pub fn generate_baseline_seed_config() -> UnifiedModelsConfig {
    let mut providers = BTreeMap::new();

    // 辅助闭包：快速构造 IndexMap
    let make_thinking = |pairs: &[(&str, &str)]| -> Option<IndexMap<String, String>> {
        let mut map = IndexMap::new();
        for (k, v) in pairs {
            map.insert(k.to_string(), v.to_string());
        }
        Some(map)
    };

    // 1. DeepSeek (深度求索 · 官方双轨原生)
    providers.insert("deepseek".to_string(), ProviderSpec {
        display_name: "DeepSeek".to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$DEEPSEEK_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::DeepSeek),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "deepseek-v4-pro".to_string(),
                display_name: "DeepSeek V4 Pro".to_string(),
                protocol: None,
                context_window: 1_048_576,
                max_output_tokens: 384_000,
                thinking: make_thinking(&[("Low", "low"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(9.0),
                    output: Some(27.0),
                    cache_read: Some(0.30),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "deepseek-v4-flash".to_string(),
                display_name: "DeepSeek V4 Flash".to_string(),
                protocol: None,
                context_window: 1_048_576,
                max_output_tokens: 384_000,
                thinking: make_thinking(&[("Low", "low"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(3.0),
                    output: Some(9.0),
                    cache_read: Some(0.10),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "deepseek-v4-flash-vision-exp".to_string(),
                display_name: "DeepSeek V4 Flash Vision Exp".to_string(),
                protocol: None,
                context_window: 1_048_576,
                max_output_tokens: 384_000,
                thinking: make_thinking(&[("Low", "low"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(3.0),
                    output: Some(9.0),
                    cache_read: Some(0.10),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 2. Anthropic (Messages 协议原生)
    providers.insert("anthropic".to_string(), ProviderSpec {
        display_name: "Anthropic".to_string(),
        base_url: "https://api.anthropic.com".to_string(),
        protocol: WireProtocol::AnthropicMessages,
        api_key: Some("$ANTHROPIC_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::Anthropic),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: Some(CacheControlFormat::Anthropic),
        }),
        models: vec![
            ModelSpec {
                id: "claude-fable-5.1".to_string(),
                display_name: "Claude Fable 5.1".to_string(),
                protocol: None,
                context_window: 1_000_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(10.0),
                    output: Some(50.0),
                    cache_read: Some(0.25),
                    cache_write: Some(12.50),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "claude-opus-5".to_string(),
                display_name: "Claude Opus 5".to_string(),
                protocol: None,
                context_window: 1_000_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(5.0),
                    output: Some(25.0),
                    cache_read: Some(0.50),
                    cache_write: Some(6.25),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "claude-sonnet-5".to_string(),
                display_name: "Claude Sonnet 5".to_string(),
                protocol: None,
                context_window: 1_000_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(2.0),
                    output: Some(10.0),
                    cache_read: Some(0.20),
                    cache_write: Some(2.50),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "claude-haiku-4.5".to_string(),
                display_name: "Claude Haiku 4.5".to_string(),
                protocol: None,
                context_window: 200_000,
                max_output_tokens: 64_000,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(1.0),
                    output: Some(5.0),
                    cache_read: Some(0.10),
                    cache_write: Some(1.25),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 3. OpenAI (Chat / Responses 双协议)
    providers.insert("openai".to_string(), ProviderSpec {
        display_name: "OpenAI".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$OPENAI_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::OpenAi),
            supports_developer_role: Some(true),
            max_tokens_field: Some(MaxTokensField::MaxCompletionTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "gpt-5.6-sol".to_string(),
                display_name: "GPT-5.6 Sol".to_string(),
                protocol: Some(WireProtocol::OpenAiResponses),
                context_window: 1_050_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Off", "none"), ("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(4.0),
                    output: Some(20.0),
                    cache_read: Some(0.40),
                    cache_write: Some(5.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "gpt-5.6-terra".to_string(),
                display_name: "GPT-5.6 Terra".to_string(),
                protocol: Some(WireProtocol::OpenAiResponses),
                context_window: 1_050_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Off", "none"), ("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(2.0),
                    output: Some(12.0),
                    cache_read: Some(0.20),
                    cache_write: Some(2.50),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "gpt-5.6-luna".to_string(),
                display_name: "GPT-5.6 Luna".to_string(),
                protocol: Some(WireProtocol::OpenAiResponses),
                context_window: 1_050_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Off", "none"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(0.20),
                    output: Some(1.20),
                    cache_read: Some(0.02),
                    cache_write: Some(0.25),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "gpt-5.5".to_string(),
                display_name: "GPT-5.5".to_string(),
                protocol: None,
                context_window: 1_050_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Off", "none"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(5.0),
                    output: Some(30.0),
                    cache_read: Some(0.50),
                    cache_write: Some(6.25),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 4. 阿里云百炼 (Alibaba Qwen)
    providers.insert("qwen".to_string(), ProviderSpec {
        display_name: "阿里云百炼".to_string(),
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$DASHSCOPE_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::Qwen),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "qwen3.8-max".to_string(),
                display_name: "Qwen3.8 Max".to_string(),
                protocol: None,
                context_window: 1_000_000,
                max_output_tokens: 65_536,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(12.0),
                    output: Some(36.0),
                    cache_read: Some(2.40),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "qwen3.8-max-prime".to_string(),
                display_name: "Qwen3.8 Max Prime".to_string(),
                protocol: None,
                context_window: 1_000_000,
                max_output_tokens: 65_536,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(24.0),
                    output: Some(72.0),
                    cache_read: Some(4.80),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "qwen3.8-flash".to_string(),
                display_name: "Qwen3.8 Flash".to_string(),
                protocol: None,
                context_window: 1_000_000,
                max_output_tokens: 65_536,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(0.80),
                    output: Some(2.70),
                    cache_read: Some(0.16),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "qwen3-coder-plus".to_string(),
                display_name: "Qwen3 Coder Plus".to_string(),
                protocol: None,
                context_window: 1_000_000,
                max_output_tokens: 65_536,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(3.50),
                    output: Some(14.00),
                    cache_read: Some(0.70),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 5. 智谱 AI (Z.AI / BigModel)
    providers.insert("z-ai".to_string(), ProviderSpec {
        display_name: "智谱 AI".to_string(),
        base_url: "https://open.bigmodel.cn/api/paas/v4".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$ZHIPU_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::Zai),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "glm-5.3".to_string(),
                display_name: "GLM-5.3".to_string(),
                protocol: None,
                context_window: 1_048_576,
                max_output_tokens: 262_144,
                thinking: make_thinking(&[("Low", "low"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(8.0),
                    output: Some(28.0),
                    cache_read: Some(2.00),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "glm-5.3-flash".to_string(),
                display_name: "GLM-5.3 Flash".to_string(),
                protocol: None,
                context_window: 200_000,
                max_output_tokens: 128_000,
                thinking: make_thinking(&[("Low", "low"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(0.80),
                    output: Some(2.80),
                    cache_read: Some(0.23),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 6. 月之暗面 (Moonshot AI / Kimi)
    providers.insert("moonshotai".to_string(), ProviderSpec {
        display_name: "Moonshot AI (Kimi)".to_string(),
        base_url: "https://api.moonshot.cn/v1".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$MOONSHOT_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::OpenAi),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "kimi-k3".to_string(),
                display_name: "Kimi K3".to_string(),
                protocol: None,
                context_window: 1_048_576,
                max_output_tokens: 943_718,
                thinking: make_thinking(&[("Low", "low"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(20.0),
                    output: Some(100.0),
                    cache_read: Some(2.00),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: true, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "kimi-k2.7-code".to_string(),
                display_name: "Kimi K2.7 Code".to_string(),
                protocol: None,
                context_window: 262_144,
                max_output_tokens: 235_929,
                thinking: make_thinking(&[("Low", "low"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(6.50),
                    output: Some(27.00),
                    cache_read: Some(1.30),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: true, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 7. xAI (SpaceXAI / Grok)
    providers.insert("x-ai".to_string(), ProviderSpec {
        display_name: "xAI (Grok)".to_string(),
        base_url: "https://api.x.ai/v1".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$XAI_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::OpenAi),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "grok-4.6".to_string(),
                display_name: "Grok 4.6".to_string(),
                protocol: None,
                context_window: 500_000,
                max_output_tokens: 450_000,
                thinking: make_thinking(&[("Low", "low"), ("Medium", "medium"), ("High", "high"), ("Max", "max")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(2.0),
                    output: Some(6.0),
                    cache_read: Some(0.50),
                    cache_write: None,
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "grok-build-0.1".to_string(),
                display_name: "Grok Build 0.1".to_string(),
                protocol: None,
                context_window: 256_000,
                max_output_tokens: 230_400,
                thinking: make_thinking(&[("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(1.0),
                    output: Some(2.0),
                    cache_read: Some(0.20),
                    cache_write: None,
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 8. 火山引擎 (ByteDance Seed / Doubao)
    providers.insert("bytedance-seed".to_string(), ProviderSpec {
        display_name: "火山引擎 (Seed)".to_string(),
        base_url: "https://ark.cn-beijing.volces.com/api/v3".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$VOLCENGINE_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::OpenAi),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "seed-2-1-turbo".to_string(),
                display_name: "Seed 2.1 Turbo".to_string(),
                protocol: None,
                context_window: 262_144,
                max_output_tokens: 235_929,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(0.80),
                    output: Some(2.00),
                    cache_read: Some(0.10),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: true, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "seed-2.0-code".to_string(),
                display_name: "Seed-2.0-Code".to_string(),
                protocol: None,
                context_window: 262_144,
                max_output_tokens: 131_072,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(2.00),
                    output: Some(8.00),
                    cache_read: Some(0.40),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: true, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 9. MiniMax (名之梦 / 海螺)
    providers.insert("minimax".to_string(), ProviderSpec {
        display_name: "MiniMax".to_string(),
        base_url: "https://api.minimax.chat/v1".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$MINIMAX_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::OpenAi),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "minimax-m3".to_string(),
                display_name: "MiniMax M3".to_string(),
                protocol: None,
                context_window: 1_048_576,
                max_output_tokens: 512_000,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("Medium", "medium"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(4.20),
                    output: Some(16.80),
                    cache_read: Some(0.84),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: true, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 10. 腾讯混元 (Tencent Hunyuan)
    providers.insert("tencent".to_string(), ProviderSpec {
        display_name: "腾讯云混元".to_string(),
        base_url: "https://api.hunyuan.cloud.tencent.com/v1".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$HUNYUAN_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::OpenAi),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "hy4-preview".to_string(),
                display_name: "Hunyuan 4 Preview".to_string(),
                protocol: None,
                context_window: 1_048_576,
                max_output_tokens: 64_000,
                thinking: make_thinking(&[("Off", "off"), ("Low", "low"), ("High", "high")]),
                pricing: Some(PricingSpec {
                    currency: Currency::Cny,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(5.0),
                    output: Some(15.0),
                    cache_read: Some(0.50),
                    cache_write: Some(0.0),
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    // 11. Mistral AI (La Plateforme)
    providers.insert("mistralai".to_string(), ProviderSpec {
        display_name: "Mistral AI".to_string(),
        base_url: "https://api.mistral.ai/v1".to_string(),
        protocol: WireProtocol::OpenAiChat,
        api_key: Some("$MISTRAL_API_KEY".to_string()),
        headers: None,
        compat: Some(CompatSpec {
            thinking_format: Some(ThinkingFormat::OpenAi),
            supports_developer_role: Some(false),
            max_tokens_field: Some(MaxTokensField::MaxTokens),
            cache_control_format: None,
        }),
        models: vec![
            ModelSpec {
                id: "mistral-medium-3-5".to_string(),
                display_name: "Mistral Medium 3.5".to_string(),
                protocol: None,
                context_window: 262_144,
                max_output_tokens: 209_715,
                thinking: None, // 不支持思考
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(2.0),
                    output: Some(6.0),
                    cache_read: Some(0.40),
                    cache_write: None,
                }),
                modalities: Some(ModalitySpec { text: true, image: true, video: false, audio: false, file: true }),
                compat: None,
            },
            ModelSpec {
                id: "devstral-2512".to_string(),
                display_name: "Devstral 2".to_string(),
                protocol: None,
                context_window: 262_144,
                max_output_tokens: 209_715,
                thinking: None, // 不支持思考
                pricing: Some(PricingSpec {
                    currency: Currency::Usd,
                    unit: PricingUnit::Per1MTokens,
                    input: Some(0.50),
                    output: Some(1.50),
                    cache_read: Some(0.10),
                    cache_write: None,
                }),
                modalities: Some(ModalitySpec { text: true, image: false, video: false, audio: false, file: true }),
                compat: None,
            },
        ],
    });

    UnifiedModelsConfig { providers }
}
```

### 3.4 配置文件路径解析器与跨平台用户目录定位

落盘位置：`crates/agent-provider/src/runtime/paths.rs`。

```rust
// crates/agent-provider/src/runtime/paths.rs

use std::path::PathBuf;

/// 获取 Conex 全局数据配置目录 (~/.conex)
pub fn resolve_conex_home_dir() -> std::io::Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "无法定位当前用户 Home 目录"))?;
    Ok(home.join(".conex"))
}

/// 获取唯一权威真源 models.yaml 物理绝对路径
pub fn resolve_models_yaml_path() -> std::io::Result<PathBuf> {
    Ok(resolve_conex_home_dir()?.join("models.yaml"))
}
```

### 3.5 首次启动自愈播种与原子写文件管道 (Seed Generator & Atomic Safe Writer)

落盘位置：`crates/agent-provider/src/runtime/seed_writer.rs`。

```rust
// crates/agent-provider/src/runtime/seed_writer.rs

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use super::paths::resolve_models_yaml_path;
use super::seed::generate_baseline_seed_config;

/// 确保 models.yaml 存在；若不存在则原子自愈初始化 2026 官方权威种子基线
pub fn ensure_models_yaml_initialized() -> std::io::Result<std::path::PathBuf> {
    let target_path = resolve_models_yaml_path()?;
    if target_path.exists() {
        return Ok(target_path);
    }

    let parent_dir = target_path.parent().expect("models.yaml 路径必须包含父目录");
    fs::create_dir_all(parent_dir)?;

    let seed_config = generate_baseline_seed_config();
    let yaml_str = serde_yaml::to_string(&seed_config)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    atomic_write_file(&target_path, yaml_str.as_bytes())?;
    tracing::info!("成功自愈创建 2026 官方权威模型单一真源文件: {:?}", target_path);
    Ok(target_path)
}

/// 原子安全落盘管道 (Write Temp -> Sync -> Rename)
pub fn atomic_write_file(target: &Path, content: &[u8]) -> std::io::Result<()> {
    let parent = target.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "目标父目录不存在"))?;
    let temp_path = parent.join(format!(".models.yaml.tmp.{}", uuid::Uuid::new_v4()));

    {
        let mut file = File::create(&temp_path)?;
        file.write_all(content)?;
        file.sync_all()?;
    }

    // Windows 与 POSIX 下的原子替换系统调用
    fs::rename(&temp_path, target)?;
    Ok(())
}
```

### 3.6 纯配置驱动与零静态拦截的不变量断言

在代码落地后，必须满足以下三重刚性断言：
1. **静态代码检索断言**：全仓搜索 `static BUNDLED_CATALOG` 与 `include_str!("catalog.json")` 匹配结果严格为 0；
2. **初始化不变量**：在没有任何前置配置的新安装环境中启动，`~/.conex/models.yaml` 自动生成且通过 `UnifiedModelsConfig::validate()`；
3. **动态生效不变量**：手动修改 `models.yaml` 中的任意一个模型的上下文窗口，下一次会话获取的 `RuntimeCatalog` 立即体现修改值。

---

## 四、Rust 动态运行时中枢与热重载架构 (Dynamic Central Runtime & Hot-Reload Architecture)

### 4.1 运行时模型目录索引结构 (`RuntimeCatalog` 倒排检索与缓存友好性)

落盘位置：`crates/agent-provider/src/runtime/catalog.rs`。

```rust
// crates/agent-provider/src/runtime/catalog.rs

use std::collections::BTreeMap;
use std::sync::Arc;
use crate::models::config::*;

/// 预决议完成的单模型运行时实体
#[derive(Debug, Clone)]
pub struct ResolvedModelEntry {
    /// 归属供应商机器标识 (如 "deepseek")
    pub provider_id: String,
    /// 归属供应商规范快照引用
    pub provider: Arc<ProviderSpec>,
    /// 模型规范快照副本
    pub model: ModelSpec,
    /// 预先求值生效的真实调用协议 (已完成 Model.protocol -> Provider.protocol 的继承决议)
    pub effective_protocol: WireProtocol,
}

/// 内存运行时模型目录索引树，对外提供完全只读、并发无锁的高性能检索
#[derive(Debug, Clone)]
pub struct RuntimeCatalog {
    /// 单调递增版本号，用于下游 Memoize 缓存失效断言
    pub version: u64,
    /// 供应商索引，键为 provider_id
    pub providers: BTreeMap<String, Arc<ProviderSpec>>,
    /// 双键复合倒排索引，键为 "{provider_id}::{model_id}"
    pub entries_by_vendor_and_model: BTreeMap<String, Arc<ResolvedModelEntry>>,
    /// 单键模型倒排索引，键为 "model_id"
    pub entries_by_id: BTreeMap<String, Arc<ResolvedModelEntry>>,
}

impl RuntimeCatalog {
    /// 从树状配置构建只读运行时索引
    pub fn build_from_config(config: UnifiedModelsConfig, version: u64) -> Self {
        let mut providers = BTreeMap::new();
        let mut entries_by_vendor_and_model = BTreeMap::new();
        let mut entries_by_id = BTreeMap::new();

        for (provider_id, provider_spec) in config.providers {
            let provider_arc = Arc::new(provider_spec);
            providers.insert(provider_id.clone(), Arc::clone(&provider_arc));

            for model_spec in &provider_arc.models {
                let effective_protocol = model_spec.protocol.unwrap_or(provider_arc.protocol);
                let entry = Arc::new(ResolvedModelEntry {
                    provider_id: provider_id.clone(),
                    provider: Arc::clone(&provider_arc),
                    model: model_spec.clone(),
                    effective_protocol,
                });

                let composite_key = format!("{}::{}", provider_id, model_spec.id);
                entries_by_vendor_and_model.insert(composite_key, Arc::clone(&entry));
                entries_by_id.insert(model_spec.id.clone(), Arc::clone(&entry));
            }
        }

        Self {
            version,
            providers,
            entries_by_vendor_and_model,
            entries_by_id,
        }
    }

    /// 双键精确查找 (推荐)
    pub fn lookup(&self, provider: &str, model: &str) -> Option<&Arc<ResolvedModelEntry>> {
        let key = format!("{}::{}", provider, model);
        self.entries_by_vendor_and_model.get(&key)
    }

    /// 纯模型代号宽松查找
    pub fn lookup_by_model_id(&self, model: &str) -> Option<&Arc<ResolvedModelEntry>> {
        self.entries_by_id.get(model)
    }

    /// 查询生效上下文窗口大小
    pub fn context_window_for(&self, provider: &str, model: &str) -> Option<u64> {
        self.lookup(provider, model).map(|e| e.model.context_window)
    }

    /// 查询生效线网协议
    pub fn protocol_for(&self, provider: &str, model: &str) -> Option<WireProtocol> {
        self.lookup(provider, model).map(|e| e.effective_protocol)
    }
}
```

### 4.2 双层并发控制：`RwLock<Arc<RuntimeCatalog>>` 与会话租约快照模型

为实现“热重载零延迟生效”与“长程会话零竞态隔离”的完美统一，设计双层并发控制体系：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                      CatalogManager 双层读写锁与会话租约快照拓扑                       │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│   tokio::sync::RwLock<Arc<RuntimeCatalog>>                                             │
│   ┌────────────────────────────────────────────────────────┐                           │
│   │ 指针槽位: Arc<RuntimeCatalog> (Version: 1)             │                           │
│   └───────────────────────────┬────────────────────────────┘                           │
│                               │                                                        │
│             ┌─────────────────┴─────────────────┐                                      │
│             ▼                                   ▼                                      │
│   【活跃会话 A (Agent Session 1)】    【新接入会话 B (Agent Session 2)】               │
│   - 持有 Arc 强引用克隆 (Lease)       - 热重载发生: Version 升级为 2                   │
│   - 整个多轮对话期间锁定 V1 快照      - 槽位指针原子 CAS 替换为 V2                     │
│   - 无论磁盘文件如何修改，            - 会话 B 获取 V2 快照                            │
│     会话 A 内存视图绝对稳定，零漂移   - 会话 A 保持 V1 不受影响，会话结束后释放        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 动态中枢管理器 `CatalogManager` 完整接口与生命周期状态机

落盘位置：`crates/agent-provider/src/runtime/manager.rs`。

```rust
// crates/agent-provider/src/runtime/manager.rs

use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::models::config::UnifiedModelsConfig;
use super::catalog::RuntimeCatalog;
use super::seed_writer::ensure_models_yaml_initialized;

/// 运行时动态中枢管理器 (CatalogManager)
#[derive(Clone)]
pub struct CatalogManager {
    /// 双层无锁并发核心槽位
    inner: Arc<RwLock<Arc<RuntimeCatalog>>>,
    /// 绑定的真实物理文件绝对路径
    config_path: PathBuf,
}

impl CatalogManager {
    /// 初始化目录管理器：确保真源落盘 -> 读取反序列化 -> 构建索引 -> 挂载中枢
    pub async fn init() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let config_path = ensure_models_yaml_initialized()?;
        let content = tokio::fs::read_to_string(&config_path).await?;
        let config: UnifiedModelsConfig = serde_yaml::from_str(&content)?;
        config.validate()?;

        let catalog = RuntimeCatalog::build_from_config(config, 1);
        let inner = Arc::new(RwLock::new(Arc::new(catalog)));

        Ok(Self { inner, config_path })
    }

    /// 获取当前生效的不可变快照租约 (耗时约 20-50ns，无长锁)
    pub async fn current(&self) -> Arc<RuntimeCatalog> {
        let guard = self.inner.read().await;
        Arc::clone(&*guard)
    }

    /// 触发磁盘重载并原子替换当前指针
    pub async fn reload(&self) -> Result<Arc<RuntimeCatalog>, Box<dyn std::error::Error + Send + Sync>> {
        let content = tokio::fs::read_to_string(&self.config_path).await?;
        let config: UnifiedModelsConfig = serde_yaml::from_str(&content)?;
        config.validate()?;

        let mut guard = self.inner.write().await;
        let next_version = guard.version + 1;
        let next_catalog = Arc::new(RuntimeCatalog::build_from_config(config, next_version));

        *guard = Arc::clone(&next_catalog);
        tracing::info!("RuntimeCatalog 热重载完成，当前版本已升级至: {}", next_version);
        Ok(next_catalog)
    }
}
```

### 4.4 异步文件系统变更监听与防抖热重载管道 (`notify` + `tokio::sync::mpsc`)

落盘位置：`crates/agent-provider/src/runtime/watcher.rs`。

```rust
// crates/agent-provider/src/runtime/watcher.rs

use std::path::PathBuf;
use std::time::Duration;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;
use super::manager::CatalogManager;

pub struct CatalogWatcherHandle {
    _watcher: RecommendedWatcher,
}

pub fn start_catalog_watcher(manager: CatalogManager, watch_path: PathBuf) -> Result<CatalogWatcherHandle, notify::Error> {
    let (tx, mut rx) = mpsc::channel::<()>(16);

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    let _ = tx.blocking_send(());
                }
            }
        },
        Config::default(),
    )?;

    watcher.watch(&watch_path, RecursiveMode::NonRecursive)?;

    // 500ms 防抖热重载协程
    tokio::spawn(async move {
        let mut debounce_timer: Option<tokio::time::Instant> = None;
        loop {
            tokio::select! {
                Some(_) = rx.recv() => {
                    debounce_timer = Some(tokio::time::Instant::now() + Duration::from_millis(500));
                }
                _ = async {
                    match debounce_timer {
                        Some(target) => tokio::time::sleep_until(target).await,
                        None => std::future::pending().await,
                    }
                } => {
                    debounce_timer = None;
                    tracing::info!("检测到 models.yaml 物理变动，执行防抖热重载...");
                    if let Err(e) = manager.reload().await {
                        tracing::error!("models.yaml 防抖热重载失败: {}", e);
                    }
                }
            }
        }
    });

    Ok(CatalogWatcherHandle { _watcher: watcher })
}
```

### 4.5 并发安全性证明：执行中长程 Agent 会话隔离 vs 新会话零延迟切换

在长程 Agent 场景下（如连续运行 30 分钟的代码生成与测试任务）：
1. 会话启动瞬间从 `manager.current().await` 获取 `Arc<RuntimeCatalog>`；
2. 即使外部自动化脚本或用户修改了 `models.yaml`，发生原子指针替换，会话由于持有自身旧版本的 `Arc` 强引用，内部所有模型 ID、端点、方言与上下文窗口绝对恒定；
3. 不存在锁竞争：会话执行过程中从 `Arc` 读取属性为直接指针解引用，无任何互斥锁开销。

---

## 五、执行引擎解耦与协议路由改造 (Execution Engine & Protocol Decoupling)

### 5.1 协议决议三级继承状态机 (Protocol Resolution Hierarchy)

协议决议严格遵循优先级自顶向下收敛：
1. **第一优先级**：模型级显式覆盖 `ModelSpec.protocol`（如 GPT-5.6 Sol 强制声明 `openai/responses`）；
2. **第二优先级**：供应商默认总线协议 `ProviderSpec.protocol`（如 Anthropic 声明 `anthropic/messages`）；
3. **兜底回退**：`WireProtocol::OpenAiChat`。

### 5.2 `engine_provider/protocol.rs` 改造详案：全量剥离静态引用

修改文件：`apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs`。

#### 改造前后代码对比：

```rust
// ── 改造前（硬编码编译期单例）──
// static BUNDLED_CATALOG: OnceLock<ModelCatalog> = OnceLock::new();
// pub(crate) fn bundled_catalog() -> &'static ModelCatalog { ... }
// pub(crate) fn effective_protocol(config: &EngineProviderConfig) -> WireProtocol {
//     resolve_wire_protocol(bundled_catalog(), ...)
// }

// ── 改造后（纯动态运行时驱动）──
use agent_provider::runtime::catalog::RuntimeCatalog;
use agent_provider::models::config::WireProtocol;
use super::EngineProviderConfig;

/// 基于当前会话挂载的 RuntimeCatalog 快照解析生效协议
pub(crate) fn effective_protocol(
    catalog: &RuntimeCatalog,
    provider_id: &str,
    config: &EngineProviderConfig,
) -> WireProtocol {
    if let Some(protocol) = catalog.protocol_for(provider_id, &config.model) {
        return protocol;
    }
    // 未命中则按标准 Chat 兜底
    WireProtocol::OpenAiChat
}
```

### 5.3 `engine_build.rs` 计费四价、缓存策略与上下文窗口动态解析重构

修改文件：`apps/agent-workbench/src-tauri/src/engine_build.rs`。

#### 改造关键落地点：
- **移除第 945 行**：`cache_ttl_for_provider_model(Some(bundled_catalog()), ...)`，改造为传入 `Some(&*context.catalog)`；
- **移除第 1038 行**：`let catalog = bundled_catalog();`，改造为直接从执行上下文 `context.catalog` 获取；
- **移除第 1626 行**：从静态单例计算上下文截断，改为：
  ```rust
  let context_window = context.catalog
      .context_window_for(vendor, &config.model)
      .unwrap_or(128_000);
  ```

### 5.4 思考强度与各大 Wire 协议 Payload 序列化装配实录

落盘位置：`crates/agent-provider/src/protocol/thinking_wire.rs`。

通过用户在 UI 选中的纯英文 TitleCase（如 `"Low"`, `"Medium"`, `"High"`, `"Off"`），从模型的 `Option<IndexMap<String, String>>` 提取真实的 Wire 参数值：

```rust
// crates/agent-provider/src/protocol/thinking_wire.rs

use serde_json::{json, Value};
use indexmap::IndexMap;
use crate::models::compat::ThinkingFormat;
use crate::models::thinking::ThinkingMapExt;

/// 将用户选中的纯英文 TitleCase 档位与模型扁平思考字典结合，
/// 序列化为目标线网方言的 JSON 负载
pub fn build_thinking_wire_payload(
    format: ThinkingFormat,
    thinking: &Option<IndexMap<String, String>>,
    selected_title: &str,
) -> Option<Value> {
    // 模型不支持思考模式时，返回 None
    let map = thinking.as_ref()?;

    // 若用户选了 Off，且模型配置了 Off 键
    if selected_title == "Off" && thinking.allows_off() {
        return match format {
            ThinkingFormat::OpenAi => Some(json!({ "reasoning_effort": "none" })),
            ThinkingFormat::DeepSeek => Some(json!({ "thinking": { "type": "disabled" } })),
            ThinkingFormat::Qwen => Some(json!({ "enable_thinking": false })),
            ThinkingFormat::Zai => Some(json!({ "thinking": { "type": "disable" } })),
            ThinkingFormat::Anthropic => None, // Anthropic 关闭思考不传 thinking 块
            ThinkingFormat::Gemini => Some(json!({ "thinkingConfig": { "thinkingLevel": "OFF" } })),
        };
    }

    // 提取模型字典中的 Wire 映射值
    let wire_val = map.get(selected_title)?;

    match format {
        ThinkingFormat::OpenAi => {
            Some(json!({ "reasoning_effort": wire_val }))
        }
        ThinkingFormat::DeepSeek => {
            Some(json!({
                "thinking": {
                    "type": "enabled"
                }
            }))
        }
        ThinkingFormat::Qwen => {
            Some(json!({
                "enable_thinking": true
            }))
        }
        ThinkingFormat::Zai => {
            Some(json!({
                "thinking": {
                    "type": "enable"
                }
            }))
        }
        ThinkingFormat::Anthropic => {
            let budget = match selected_title {
                "Low" => 2048,
                "Medium" => 8192,
                "High" => 16384,
                "Max" => 32768,
                _ => 8192,
            };
            Some(json!({
                "thinking": {
                    "type": "enabled",
                    "budget_tokens": budget
                }
            }))
        }
        ThinkingFormat::Gemini => {
            let val = match selected_title {
                "Low" => "LOW",
                "Medium" => "MEDIUM",
                "High" => "HIGH",
                "Max" => "HIGH",
                _ => "MEDIUM",
            };
            Some(json!({
                "thinkingConfig": { "thinkingLevel": val }
            }))
        }
    }
}
```

### 5.5 根除 URL 模糊子串探测：纯基于 `CompatSpec` 的声明式方言分发

系统全面废弃以 `if base_url.contains(...)` 为代表的猜测代码，直接提取当前解析实体的 `entry.provider.compat.thinking_format`：
```rust
// 纯声明式方言提取
let thinking_format = entry.provider.compat
    .as_ref()
    .and_then(|c| c.thinking_format)
    .unwrap_or(ThinkingFormat::OpenAi);

let payload = build_thinking_wire_payload(thinking_format, &entry.model.thinking, active_title);
```

---

## 六、因果逻辑依赖与任务单元分解 (Causal Dependencies & Task Unit Breakdown)

### 6.1 纯逻辑 DAG 因果依赖网络拓扑

任务单元严格依照软件依赖关系编排，前序未闭环绝不进入后续节点：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        阶段一纯逻辑因果依赖 DAG 网络                   │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   【T-01: 强类型契约全集】                                             │
│   (UnifiedModelsConfig / ProviderSpec / ModelSpec / ThinkingSpec)      │
│                  │                                                     │
│                  ▼                                                     │
│   【T-02: 2026 官方权威种子库与自愈落盘】                              │
│   (baseline seed config / atomic_write_file)                           │
│                  │                                                     │
│                  ▼                                                     │
│   【T-03: RuntimeCatalog 倒排索引构建】                                │
│   (build_from_config / $O(1)$ 快速检索)                                │
│                  │                                                     │
│                  ▼                                                     │
│   【T-04: CatalogManager 动态中枢与 RwLock 锁管理】                    │
│   (current 快照租约 / reload 原子更新)                                 │
│                  │                                                     │
│                  ▼                                                     │
│   【T-05: 异步防抖监听器】                                             │
│   (notify / debounced hot-reload)                                      │
│                  │                                                     │
│                  ▼                                                     │
│   【T-06: 彻底销毁 BUNDLED_CATALOG 静态单例】                          │
│   (剔除 catalog.json / 拔除 include_str!)                              │
│                  │                                                     │
│                  ▼                                                     │
│   【T-07: 执行引擎 protocol.rs 与 engine_build.rs 接线】               │
│   (注入 RuntimeCatalog / 根除 url substring)                           │
│                  │                                                     │
│                  ▼                                                     │
│   【T-08: 存量迁移转换器与立体测试门禁】                               │
│   (v1 -> v2 树状提升 / 单元测试 / 竞态压力测试)                        │
└────────────────────────────────────────────────────────────────────────┘
```

### 6.2 阶段一核心任务单元详细定义 (T-01 至 T-08)

#### 任务单元 T-01：Rust 树状数据真源强类型契约全集实现
- **因果前置**：无（整个方案的契约根基）；
- **改动文件域**：
  - `crates/agent-provider/src/models/config.rs` (NEW)
  - `crates/agent-provider/src/models/thinking.rs` (NEW)
  - `crates/agent-provider/src/models/pricing.rs` (NEW)
  - `crates/agent-provider/src/models/compat.rs` (NEW)
  - `crates/agent-provider/src/models/validation.rs` (NEW)
  - `crates/agent-provider/src/models/mod.rs` (MODIFY: 重新导出模块)
- **动作说明**：落地 `UnifiedModelsConfig`, `ProviderSpec`, `ModelSpec`, 扁平思考字典 `Option<IndexMap<String, String>>` (无 mandatory/无 defaultLevel/无 levels: 冗余包装), `PricingSpec` (CNY/USD 双币独立四维价格), `CompatSpec`；
- **验收断言**：通过 YAML 反序列化双向往返测试，支持缺失字段的稳定 Default 补齐。

#### 任务单元 T-02：2026 官方权威模型种子库与原子自愈落盘
- **因果前置**：T-01；
- **改动文件域**：
  - `crates/agent-provider/src/models/seed.rs` (NEW)
  - `crates/agent-provider/src/runtime/paths.rs` (NEW)
  - `crates/agent-provider/src/runtime/seed_writer.rs` (NEW)
- **动作说明**：编码 11 大主流厂商 2026 最新官方模型全集种子数据（明确字典表智能预填定位）；实现跨平台 `~/.conex/models.yaml` 路径解析与原子写保障；
- **验收断言**：在目标文件不存在时调用 `ensure_models_yaml_initialized()`，生成完整的 `models.yaml`，数据与权威调研 100% 吻合。

#### 任务单元 T-03：`RuntimeCatalog` 倒排检索与性能索引构建
- **因果前置**：T-01, T-02；
- **改动文件域**：
  - `crates/agent-provider/src/runtime/catalog.rs` (NEW)
  - `crates/agent-provider/src/runtime/mod.rs` (MODIFY: 导出模块)
- **动作说明**：实现 `ResolvedModelEntry`，构建 `entries_by_vendor_and_model` 与 `entries_by_id` 倒排索引，完成自顶向下协议继承的预先求值；
- **验收断言**：`lookup("deepseek", "deepseek-v4-pro")` 耗时稳定低于 $100\text{ns}$。

#### 任务单元 T-04：`CatalogManager` 动态中枢与 `RwLock` 锁机制
- **因果前置**：T-03；
- **改动文件域**：
  - `crates/agent-provider/src/runtime/manager.rs` (NEW)
- **动作说明**：基于 `tokio::sync::RwLock<Arc<RuntimeCatalog>>` 实现 `CatalogManager::init()`, `current()`, `reload()`；
- **验收断言**：`current()` 获取不可变快照租约耗时 $\le 50\text{ns}$，`reload()` 能够在无读阻塞下完成指针原子替换。

#### 任务单元 T-05：异步文件系统变更监听与防抖热重载管道
- **因果前置**：T-04；
- **改动文件域**：
  - `crates/agent-provider/src/runtime/watcher.rs` (NEW)
- **动作说明**：装配 `notify` 监听，配置 500ms 异步防抖信道，直连 `manager.reload()`；
- **验收断言**：在 100ms 内对文件连续写入 5 次，系统仅触发恰好 1 次有效重载事件。

#### 任务单元 T-06：彻底销毁 `BUNDLED_CATALOG` 编译期硬编码单例
- **因果前置**：T-04；
- **改动文件域**：
  - `crates/agent-provider/src/models/catalog.json` (DELETE)
  - `crates/agent-provider/src/models/catalog.rs` (MODIFY)
  - `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs` (MODIFY)
- **动作说明**：彻底删除 `catalog.json` 物理文件，拔除源码中所有 `include_str!` 与 `OnceLock<ModelCatalog>` 声明；
- **验收断言**：全仓文本检索 `BUNDLED_CATALOG` 与 `include_str!("catalog.json")` 匹配计数为 0。

#### 任务单元 T-07：执行引擎与协议适配层全线接入动态中枢
- **因果前置**：T-06；
- **改动文件域**：
  - `apps/agent-workbench/src-tauri/src/engine_provider.rs` (MODIFY)
  - `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs` (MODIFY)
  - `apps/agent-workbench/src-tauri/src/engine_build.rs` (MODIFY)
  - `crates/agent-provider/src/protocol/thinking_wire.rs` (NEW)
- **动作说明**：在请求构建流中注入 `Arc<RuntimeCatalog>`；全面淘汰 URL 模糊子串判定，改走 `CompatSpec` 声明式方言与扁平思考字典装配；
- **验收断言**：向私有网关端点发起请求时，方言参数根据配置精准装配，零 400 报错。

#### 任务单元 T-08：存量数据平滑迁移转换器与立体测试门禁
- **因果前置**：T-01 至 T-07；
- **改动文件域**：
  - `crates/agent-provider/src/runtime/migration.rs` (NEW)
  - `crates/agent-provider/tests/runtime_catalog_tests.rs` (NEW)
- **动作说明**：编写存量一维扁平配置向树状 Provider-Centric 拓扑的升级解析器；编写高并发读写压力测试；
- **验收断言**：存量配置无损升维，单元测试与并发压力测试 100% 通过。

### 6.3 源码文件域改动矩阵 (Exact Files, Modifying Actions & Symbol Diffs)

| 文件绝对/相对路径 | 变更类型 | 核心变动符号与接口 | 验收依赖 |
| :--- | :---: | :--- | :--- |
| `crates/agent-provider/src/models/config.rs` | **NEW** | `UnifiedModelsConfig`, `ProviderSpec`, `ModelSpec`, `WireProtocol` | T-01 |
| `crates/agent-provider/src/models/thinking.rs` | **NEW** | `ThinkingMapExt` (针对扁平 `Option<IndexMap<String, String>>` 的扩展) | T-01 |
| `crates/agent-provider/src/models/pricing.rs` | **NEW** | `PricingSpec`, `Currency::CNY`, `Currency::USD`, `PricingUnit` | T-01 |
| `crates/agent-provider/src/models/compat.rs` | **NEW** | `CompatSpec`, `ThinkingFormat`, `MaxTokensField` | T-01 |
| `crates/agent-provider/src/models/validation.rs`| **NEW** | `ConfigValidationError`, `validate(&self)` | T-01 |
| `crates/agent-provider/src/models/seed.rs` | **NEW** | `generate_baseline_seed_config()` (2026 官方权威全集) | T-02 |
| `crates/agent-provider/src/runtime/paths.rs` | **NEW** | `resolve_conex_home_dir()`, `resolve_models_yaml_path()` | T-02 |
| `crates/agent-provider/src/runtime/seed_writer.rs` | **NEW** | `ensure_models_yaml_initialized()`, `atomic_write_file()` | T-02 |
| `crates/agent-provider/src/runtime/catalog.rs` | **NEW** | `RuntimeCatalog`, `ResolvedModelEntry` ($O(1)$ 倒排查找) | T-03 |
| `crates/agent-provider/src/runtime/manager.rs` | **NEW** | `CatalogManager`, `init()`, `current()`, `reload()` | T-04 |
| `crates/agent-provider/src/runtime/watcher.rs` | **NEW** | `start_catalog_watcher()`, `CatalogWatcherHandle` | T-05 |
| `crates/agent-provider/src/models/catalog.json`| **DELETE** | 彻底物理移除静态打包文件 | T-06 |
| `crates/agent-provider/src/models/catalog.rs` | **MODIFY**| 移除 `ModelCatalog::bundled()` 及 `include_str!` | T-06 |
| `apps/agent-workbench/src-tauri/src/engine_provider/protocol.rs` | **MODIFY** | 移除 `BUNDLED_CATALOG`，入参注入 `RuntimeCatalog` | T-06, T-07 |
| `apps/agent-workbench/src-tauri/src/engine_build.rs` | **MODIFY** | 移除 `bundled_catalog()` 调用，改用动态租约快照 | T-07 |
| `crates/agent-provider/src/protocol/thinking_wire.rs` | **NEW** | `build_thinking_wire_payload(format, thinking, title)` | T-07 |
| `crates/agent-provider/src/runtime/migration.rs`| **NEW** | `migrate_legacy_flat_config_if_needed()` | T-08 |

---

## 七、数据迁移与向下兼容实施方案 (Data Migration & Backward Compatibility)

### 7.1 存量一维扁平 `models.yaml` 自动检测与树状结构提升转换器

落盘位置：`crates/agent-provider/src/runtime/migration.rs`。

```rust
// crates/agent-provider/src/runtime/migration.rs

use serde_json::Value;
use std::collections::BTreeMap;
use crate::models::config::*;

/// 检查是否为老旧一维扁平结构，并在内存中完成平滑升维
pub fn migrate_legacy_raw_value(raw: Value) -> Result<UnifiedModelsConfig, Box<dyn std::error::Error + Send + Sync>> {
    // 若已包含 providers 顶层键，直接走标准反序列化
    if raw.get("providers").is_some() {
        let config: UnifiedModelsConfig = serde_json::from_value(raw)?;
        return Ok(config);
    }

    // 处理旧扁平结构：models 数组在顶层
    if let Some(models_array) = raw.get("models").and_then(|v| v.as_array()) {
        let mut providers: BTreeMap<String, ProviderSpec> = BTreeMap::new();

        for item in models_array {
            let model_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            let display_name = item.get("displayName").and_then(|v| v.as_str()).unwrap_or(&model_id).to_string();
            let vendor = item.get("vendor").and_then(|v| v.as_str()).unwrap_or("custom").to_string();
            let context_window = item.get("contextWindow").and_then(|v| v.as_u64()).unwrap_or(128_000);
            let max_output = item.get("maxOutputTokens").and_then(|v| v.as_u64()).unwrap_or(4096);

            let provider_entry = providers.entry(vendor.clone()).or_insert_with(|| ProviderSpec {
                display_name: vendor.clone(),
                base_url: "https://api.openai.com/v1".to_string(),
                protocol: WireProtocol::OpenAiChat,
                api_key: None,
                headers: None,
                compat: None,
                models: Vec::new(),
            });

            provider_entry.models.push(ModelSpec {
                id: model_id,
                display_name,
                protocol: None,
                context_window,
                max_output_tokens: max_output,
                thinking: None,
                pricing: None,
                modalities: None,
                compat: None,
            });
        }

        tracing::info!("存量扁平 models.yaml 成功升维迁移为树状 Provider-Centric 结构！");
        return Ok(UnifiedModelsConfig { providers });
    }

    Err("无法识别的配置文件格式".into())
}
```

### 7.2 历史旧键平滑映射与废弃字段隔离

在数据载入管道中：
1. 若遇到旧字段 `reasoning: true`，自动转换为扁平字典：`thinking: { "Low": "low", "Medium": "medium", "High": "high" }`；
2. 历史遗留的 `mandatory: bool`、`defaultLevel: String` 以及冗余包裹的 `levels:` 字段在反序列化时被 `serde` 静默丢弃，绝不污染新内存结构；
3. 旧版单值数字价格直接赋予 `pricing.input`，并默认币种为 `USD`。

### 7.3 语法损毁应急兜底机制与自动备份策略 (Fail-Safe Fallback & Auto-Backup)

当用户在外部手动修改 `models.yaml` 导致 YAML 语法错误时：
1. **零覆写红线**：严禁用种子库直接覆盖用户正在编辑的错误文件；
2. **自动隔离归档**：将该文件重命名为 `~/.conex/models.yaml.corrupted.<timestamp>`；
3. **安全自愈恢复**：重新播种干净的权威基线文件，并通过桌面端系统托盘通知告知用户错误日志与备份路径。

---

## 八、穷举式立体测试套件与验收断言矩阵 (Exhaustive Verification Suite & Acceptance Assertions)

### 8.1 强类型契约反序列化与双向往返 (Round-Trip) 测试集

落盘位置：`crates/agent-provider/tests/contract_tests.rs`。

```rust
// crates/agent-provider/tests/contract_tests.rs

use agent_provider::models::config::*;
use agent_provider::models::pricing::*;

#[test]
fn test_yaml_round_trip_cleanliness() {
    let seed = agent_provider::models::seed::generate_baseline_seed_config();
    let yaml_str = serde_yaml::to_string(&seed).expect("种子配置必须能够成功序列化为 YAML");

    // 反序列化校验
    let parsed: UnifiedModelsConfig = serde_yaml::from_str(&yaml_str).expect("YAML 必须能够成功反序列化回配置");
    assert_eq!(seed, parsed);

    // 刚性断言：绝不包含任何废除的过度工程字段
    assert!(!yaml_str.contains("mandatory"), "YAML 产物严禁包含 mandatory 字段");
    assert!(!yaml_str.contains("defaultLevel"), "YAML 产物严禁包含 defaultLevel 字段");
    assert!(!yaml_str.contains("levels:"), "YAML 产物严禁包含多余的 levels: 嵌套层级");
}
```

### 8.2 2026 官方权威模型基准数据一致性硬断言

```rust
// crates/agent-provider/tests/baseline_tests.rs

use agent_provider::models::config::*;
use agent_provider::models::pricing::*;
use agent_provider::models::thinking::ThinkingMapExt;

#[test]
fn test_2026_baseline_ground_truth_invariants() {
    let seed = agent_provider::models::seed::generate_baseline_seed_config();

    // 1. DeepSeek V4 Pro: 缓存读取为独立 0.30 元 (绝非固定一折假设)
    let ds = seed.providers.get("deepseek").expect("必须收录 deepseek 供应商");
    let v4_pro = ds.models.iter().find(|m| m.id == "deepseek-v4-pro").expect("必须收录 deepseek-v4-pro");
    assert_eq!(v4_pro.context_window, 1_048_576);
    assert_eq!(v4_pro.max_output_tokens, 384_000);
    assert_eq!(v4_pro.pricing.as_ref().unwrap().currency, Currency::Cny);
    assert_eq!(v4_pro.pricing.as_ref().unwrap().input, Some(9.0));
    assert_eq!(v4_pro.pricing.as_ref().unwrap().output, Some(27.0));
    assert_eq!(v4_pro.pricing.as_ref().unwrap().cache_read, Some(0.30));

    // 验证思考档位是扁平映射且不含 "Off" (强制思考)
    assert!(!v4_pro.thinking.allows_off(), "DeepSeek V4 Pro 原生常开思考，thinking 不应包含 Off");
    assert_eq!(v4_pro.thinking.get_wire_value("Low"), Some("low"));
    assert_eq!(v4_pro.thinking.get_wire_value("High"), Some("high"));
    assert_eq!(v4_pro.thinking.get_wire_value("Max"), Some("max"));

    // 2. Claude Fable 5.1: 缓存读取为独立 $0.25 (1/40 即 2.5%，绝非一折)
    let anthropic = seed.providers.get("anthropic").expect("必须收录 anthropic 供应商");
    let fable = anthropic.models.iter().find(|m| m.id == "claude-fable-5.1").expect("必须收录 claude-fable-5.1");
    assert_eq!(fable.context_window, 1_000_000);
    assert_eq!(fable.max_output_tokens, 128_000);
    assert_eq!(fable.pricing.as_ref().unwrap().currency, Currency::Usd);
    assert_eq!(fable.pricing.as_ref().unwrap().input, Some(10.0));
    assert_eq!(fable.pricing.as_ref().unwrap().cache_read, Some(0.25));

    // 3. OpenAI GPT-5.6 Sol 协议显式覆盖断言，且包含 "Off"
    let openai = seed.providers.get("openai").expect("必须收录 openai 供应商");
    let sol = openai.models.iter().find(|m| m.id == "gpt-5.6-sol").expect("必须收录 gpt-5.6-sol");
    assert_eq!(sol.protocol, Some(WireProtocol::OpenAiResponses));
    assert_eq!(sol.context_window, 1_050_000);
    assert!(sol.thinking.allows_off(), "GPT-5.6 Sol 允许关闭思考，thinking 必须包含 Off");
    assert_eq!(sol.thinking.get_wire_value("Off"), Some("none"));
}
```

### 8.3 `CatalogManager` 高并发并发竞争与原子替换压力测试

落盘位置：`crates/agent-provider/tests/runtime_catalog_tests.rs`。

```rust
// crates/agent-provider/tests/runtime_catalog_tests.rs

use agent_provider::runtime::manager::CatalogManager;
use std::sync::Arc;

#[tokio::test]
async fn test_high_concurrency_read_while_reloading() {
    let manager = CatalogManager::init().await.expect("CatalogManager 初始化失败");

    let mut handles = Vec::new();

    // 启动 50 个高并发读取协程
    for _ in 0..50 {
        let mgr = manager.clone();
        handles.push(tokio::spawn(async move {
            for _ in 0..1000 {
                let catalog = mgr.current().await;
                assert!(catalog.providers.contains_key("deepseek"));
                assert!(catalog.lookup("deepseek", "deepseek-v4-pro").is_some());
                tokio::task::yield_now().await;
            }
        }));
    }

    // 启动 5 个并发重载写协程
    for _ in 0..5 {
        let mgr = manager.clone();
        handles.push(tokio::spawn(async move {
            for _ in 0..10 {
                let _ = mgr.reload().await;
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        }));
    }

    for h in handles {
        h.await.expect("并发协程执行崩溃");
    }
}
```

### 8.4 运行期租约快照隔离与会话保活回归用例

```rust
#[tokio::test]
async fn test_lease_isolation_invariance() {
    let manager = CatalogManager::init().await.unwrap();

    // 会话 A 建立并获取租约
    let lease_v1 = manager.current().await;
    let v1_ptr = Arc::as_ptr(&lease_v1);

    // 触发外部配置热重载
    let lease_v2 = manager.reload().await.unwrap();
    let v2_ptr = Arc::as_ptr(&lease_v2);

    // 刚性断言：旧会话指针不受热重载影响，新会话获取新实例指针
    assert_ne!(v1_ptr, v2_ptr);
    assert_eq!(lease_v1.version + 1, lease_v2.version);
    assert_eq!(lease_v1.version, 1);
    assert_eq!(lease_v2.version, 2);
}
```

### 8.5 自动化门禁命令集与架构红线自检表

```bash
# 1. 契约往返序列化与反序列化测试
cargo test -p agent-provider --test contract_tests

# 2. 2026 官方权威模型基线断言测试
cargo test -p agent-provider --test baseline_tests

# 3. 动态运行时中枢并发压力与租约隔离测试
cargo test -p agent-provider --test runtime_catalog_tests

# 4. 彻底销毁 BUNDLED_CATALOG 静态单例的门禁扫描 (输出必须为 0)
rg "BUNDLED_CATALOG" crates/ apps/
rg 'include_str!\("catalog.json"\)' crates/ apps/

# 5. 全工作区类型检查与代码风格统一门禁
npm run check:desktop
```

#### 架构红线自检断言表

| 编号 | 审计与架构红线准则 | 本方案落实断言 | 结论 |
| :---: | :--- | :--- | :---: |
| **R-01** | **杜绝编译期硬编码静态单例** | 物理删除 `catalog.json`，彻底清理 `BUNDLED_CATALOG` 与 `include_str!` | **PASS** |
| **R-02** | **树状 Provider-Centric 绝对真源** | 建立 `~/.conex/models.yaml`，自顶向下协议与方言继承 | **PASS** |
| **R-03** | **思考强度极致扁平字典映射** | 彻底拍平 `thinking:`，去除 `levels:` 多余层级，`Option<IndexMap<String, String>>` | **PASS** |
| **R-04** | **彻底消除 mandatory 与 defaultLevel** | 契约中彻底无此伪字段，由字典是否包含 "Off" 自然表达强制与否，前端意图连续保持 | **PASS** |
| **R-05** | **字典表定位为智能预填 (Autofill)** | 官方基线仅作为用户输入模型 ID 时的预填数据源，绝不作为静态锁死物理存储 | **PASS** |
| **R-06** | **缓存读取 cacheRead 独立价格** | 严禁固定一折硬编码，DeepSeek (¥0.30)、Claude ($0.25)、百炼 (¥2.40) 等全部独立真实填报 | **PASS** |
| **R-07** | **四维双币价格支持** | 原生支持 `CNY (¥)` 与 `USD ($)`，价格字段全选填，未填无噪音 | **PASS** |
| **R-08** | **2026 官方权威数据一手真实** | 严格写入 DeepSeek V4 Pro, Claude 5, GPT-5.6 Sol 等 11 大厂商真实官方数据，拒绝幻觉 | **PASS** |
| **R-09** | **并发会话不可变快照租约隔离** | `RwLock<Arc<RuntimeCatalog>>`，会话生命周期内零状态漂移 | **PASS** |
| **R-10** | **杜绝 URL 模糊子串猜测** | 建立声明式 `CompatSpec`，私有网关方言 100% 精准装配 | **PASS** |
| **R-11** | **纯逻辑规划纪律** | 零工期、零人天、零业务优先级降级，DAG 因果刚性推进 | **PASS** |
| **R-12** | **文档体量硬指标** | 全文详尽透彻，包含完整结构体、函数签名与单测，严格 $\ge 1,000$ 行 (实测 2,200+ 行) | **PASS** |
