# 供应商与模型能力全线接通重构 — 专项深度方案分析（Agent-A 详案）

> **方案代号**：`01-AgentA-Provider拓扑与内核协议打通详案`  
> **责任架构师**：Core Topology Architect（内核架构与拓扑专家）  
> **攻坚领域**：  
> - **【议题 A】Provider 拓扑结构、凭据生命周期与动态发现体系**  
> - **【议题 B】AI 通信协议路由、请求方言与内核执行链条全线打通**  
> **权威基准**：  
> - `docs/provider-model-unification/00-供应商与模型能力全线接通重构总纲.md`  
> - `docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md`  
> - `reference/pi/packages/coding-agent/docs/models.md`  
> - `reference/pi/packages/ai/src/types.ts`  
> **目标真源**：`~/.conex/models.yaml` 树状绝对唯一真源（Single Source of Truth, SSOT）  
> **版本**：v1.0.0-PROPOSAL

---

## 目录索引

- [模块一：针对负责议题的 Conex 现状深度剖析与根因定位](#模块一针对负责议题的-conex-现状深度剖析与根因定位)
  - [1.1 【议题 A】Provider 拓扑结构与凭据生命周期的现状痛点剖析](#11-议题-aprovider-拓扑结构与凭据生命周期的现状痛点剖析)
  - [1.2 【议题 B】AI 通信协议路由与内核执行链条的现状断层剖析](#12-议题-bai-通信协议路由与内核执行链条的现状断层剖析)
  - [1.3 核心矛盾归纳与根因定位拓扑图](#13-核心矛盾归纳与根因定位拓扑图)
- [模块二：对标 `@earendil-works/pi-ai` 优秀实践与架构差异化演进](#模块二对标-earendil-workspi-ai-优秀实践与架构差异化演进)
  - [2.1 `@earendil-works/pi-ai` 核心架构模式深度解构](#21-earendil-workspi-ai-核心架构模式深度解构)
  - [2.2 Conex 差异化诉求与桌面原生超越性设计](#22-conex-差异化诉求与桌面原生超越性设计)
  - [2.3 架构对比与演进决策矩阵](#23-架构对比与演进决策矩阵)
- [模块三：完整的强类型数据结构设计](#模块三完整的强类型数据结构设计)
  - [3.1 Rust 内核数据结构全集（带 serde 与 camelCase 契约）](#31-rust-内核数据结构全集带-serde-与-camelcase-契约)
  - [3.2 TypeScript 强类型契约全集（跨进程与前端中枢）](#32-typescript-强类型契约全集跨进程与前端中枢)
- [模块四：底层协议 Wire 格式与通信交互设计](#模块四底层协议-wire-格式与通信交互设计)
  - [4.1 四大主流通信协议 Wire 格式深度对比与端点映射](#41-四大主流通信协议-wire-格式深度对比与端点映射)
  - [4.2 11 大方言（Compat）请求体 Wire 转换实录](#42-11-大方言compat请求体-wire-转换实录)
  - [4.3 请求端点决议与请求头注入引擎](#43-请求端点决议与请求头注入引擎)
- [模块五：核心状态转移机与算法伪代码](#模块五核心状态转移机与算法伪代码)
  - [5.1 多层协议与方言决议状态机（Protocol Resolution Machine）](#51-多层协议与方言决议状态机protocol-resolution-machine)
  - [5.2 凭据生命周期四级解析算法（Credential Resolution Pipeline）](#52-凭据生命周期四级解析算法credential-resolution-pipeline)
  - [5.3 模型动态探测与智能自愈合流算法（Probe Scan & Three-Way Merge）](#53-模型动态探测与智能自愈合流算法probe-scan--three-way-merge)
  - [5.4 内核零中断无锁热重载状态机（RCU / ArcSwap Hot-Reload Engine）](#54-内核零中断无锁热重载状态机rcu--arcswap-hot-reload-engine)
- [模块六：精确到现有代码文件与函数签名的工程改造方案](#模块六精确到现有代码文件与函数签名的工程改造方案)
  - [6.1 影响模块范围与工程改造拓扑](#61-影响模块范围与工程改造拓扑)
  - [6.2 具体文件改造清单、结构体变更与方法签名重构](#62-具体文件改造清单结构体变更与方法签名重构)
- [模块七：存量数据迁移与向后兼容保障方案](#模块七存量数据迁移与向后兼容保障方案)
  - [7.1 存量扁平 `models.yaml` 向树状 Schema 平滑迁移器](#71-存量扁平-modelsyaml-向树状-schema-平滑迁移器)
  - [7.2 前端 LocalStorage / ProviderProfiles 凭据收口归一](#72-前端-localstorage--providerprofiles-凭据收口归一)
  - [7.3 双向版本兼容、自动备份与灾难恢复流程](#73-双向版本兼容自动备份与灾难恢复流程)
- [模块八：穷举式自动化测试用例集、魔鬼边界用例与验收断言矩阵](#模块八穷举式自动化测试用例集魔鬼边界用例与验收断言矩阵)
  - [8.1 树状 Schema 往返序列化与反序列化测试集](#81-树状-schema-往返序列化与反序列化测试集)
  - [8.2 协议决议与方言路由边界用例集](#82-协议决议与方言路由边界用例集)
  - [8.3 凭据解析四级状态机与安全擦除用例集](#83-凭据解析四级状态机与安全擦除用例集)
  - [8.4 高频热重载并发无锁替换与会话保活断言集](#84-高频热重载并发无锁替换与会话保活断言集)
  - [8.5 验收测试断言全景矩阵](#85-验收测试断言全景矩阵)

---

## 模块一：针对负责议题的 Conex 现状深度剖析与根因定位

### 1.1 【议题 A】Provider 拓扑结构与凭据生命周期的现状痛点剖析

在当前 Conex 架构中，模型与供应商体系存在严重的**“拓扑倒置”**与**“双轨割裂”**问题，直接削弱了系统的可扩展性、安全性和跨端一致性：

1. **一维扁平化倒置导致的冗余与脆弱性**：
   - 历史设计中，`models.yaml` 将全部模型拍平成一维模型数组（`models: ModelInfo[]`）。Provider（供应商）并非一等公民实体，而是作为弱类型的可选字段 `vendor: Option<String>` 倒置依附在每一个单独的模型节点上。
   - 这种倒置直接导致严重的配置冗余：当一个供应商下挂有 20 个模型时，用户或系统必须在每个模型中重复配置其归属关系；一旦供应商的 `baseUrl`、`protocol` 或通用认证方式发生变更，无法实现级联生效，必须遍历并修改每一个模型节点。
2. **凭据存储双轨割裂与前端孤岛化**：
   - 目前系统存在致命的“双轨存储”：Rust 后端在执行会话时依赖配置文件中的密钥读取，但前端界面在 `ProviderProfiles` 中又将 `baseUrl` 和 `apiKey` 保存在浏览器的 `LocalStorage` 或渲染进程状态中。
   - 这造成了**真源分裂（Split-Brain）**：用户在设置界面添加了一个新 Provider 的 API Key，前端可能更新了本地存储，但后端由于没有统一的持久化桥接，或者写入了格式不一致的中间态，导致下一次引擎启动或跨会话调用时凭据丢失或不生效。
3. **凭据生命周期管理原始，缺乏企业级与桌面级安全规范**：
   - 现存方案对于 API Key 的解析仅支持明文字符串。
   - 缺乏现代研发环境必需的高级凭据解析能力：不支持环境变量自动插值（如 `$DEEPSEEK_API_KEY`、`${OPENAI_KEY_PREFIX}_SECRET`）、不支持 1Password / macOS Keychain / 系统密码项的动态脚本获取（如 `!security find-generic-password`、`!op read`）。
   - 缺乏 OS 级安全凭据保管库桥接：Windows DPAPI、macOS Keychain 与 Linux SecretService 的安全通道没有与配置文件生命周期解耦，明文密钥直接裸露保存在本地文件中，存在严重的安全审计隐患。
4. **动态探测（Probe Scan）缺乏合流不变性保障**：
   - 现有的 `probe_scan_models_core` 在通过 `/v1/models` 端点探测服务商可用模型列表后，缺乏健壮的合并状态机。
   - 探测结果与用户已在 `models.yaml` 中深度定制的元数据（如精细调整的 `displayName`、`contextWindow`、`maxOutputTokens`、`thinking` 级别配置、`pricing` 费率等）发生冲突时，往往粗暴地直接覆写，导致用户配置丢失；或者简单地完全丢弃探测结果，导致新上线模型无法被动态发现。

### 1.2 【议题 B】AI 通信协议路由与内核执行链条的现状断层剖析

在底层通信和执行引擎层面，Conex 存在严重的**“硬编码死锁”**与**“执行断层”**：

1. **编译期静态单例伪真源（致命硬编码）**：
   - Rust 核心执行模块内部广泛绑定了静态打包的 `BUNDLED_CATALOG`（即编译期内嵌的 `catalog.json`）。
   - 内核在解析模型能力（例如是否支持流式输出、上下文长度上限、默认系统提示词模板等）时，优先甚至强制查询静态单例，导致用户在外部 `~/.conex/models.yaml` 中所做的任何深度参数修改（如调大上下文窗口至 1M tokens、修改支持的思考档位），在真实网络请求链条中被静态单例覆盖或被拦截报错。
2. **协议归属缺失与单模型抽屉噪音**：
   - 系统缺乏顶层的“协议（Protocol）”继承机制。Provider 级别没有定义通信协议（如 `openai/chat`、`openai/responses`、`anthropic/messages`、`google/generate-content`）。
   - 用户在配置界面添加或管理模型时，必须为每一个单模型重复展开下拉框选择协议。一个供应商包含 30 个模型时，用户需要点击配置 30 次，产生了极大的视觉和交互噪音。
   - 运行时路由层面，请求分发器无法从 Provider 节点自顶向下推导协议，造成大量 fallback 逻辑与冗余判断。
3. **盲目字符串匹配猜测（URL Substring Guessing）**：
   - Rust 内核在决定请求方言（Dialect / Compat）时，充斥着针对 `baseUrl` 的字面量猜测逻辑。例如通过 `if base_url.contains("deepseek")` 来判断是否开启 deepseek 思考方言，通过 `if base_url.contains("dashscope")` 猜测百炼方言。
   - 这种实现方式在面对企业内部私有网关、反向代理、中继服务（如 OneAPI、NewAPI、OpenRouter、Vercel AI Gateway、Portkey 等）时彻底失效。一旦用户将代理部署在 `https://my-ai-proxy.company.internal/v1`，内核便无法识别底层真正的模型架构，导致错误的 Payload 结构（如向 DeepSeek 代理发送了 OpenAI 的 `developer` 角色，或向不支持 `stream_options` 的兼容网关强行发送导致 400 报错）。
4. **缺乏零中断热重载（RCU / ArcSwap Hot-Reload）机制**：
   - 当用户在外部编辑器或前端修改了 `models.yaml` 时，Rust 内核没有基于无锁原子指针替换（Read-Copy-Update）的动态目录管理器。
   - 正在执行的长周期流式 Agent 任务可能因为静态重载而出现并发竞态崩溃，或者必须重启桌面客户端才能使配置生效，严重违背专业级开发者工具的流畅体验。

### 1.3 核心矛盾归纳与根因定位拓扑图

```
【现状割裂架构 (Legacy Split-Brain)】
┌──────────────────────────────────────┐       ┌──────────────────────────────────────┐
│        前端渲染进程 / Storage        │       │        Rust 执行内核 / Engine        │
├──────────────────────────────────────┤       ├──────────────────────────────────────┤
│ LocalStorage: ProviderProfiles       │       │ 静态内置: BUNDLED_CATALOG (只读死锁) │
│ - 存放 baseUrl / apiKey (明文)       │       │ - 硬编码 contextWindow, 协议映射     │
│ - 独立状态，随时与后端脱节           │       │                                      │
│                                      │       │ models.yaml (一维扁平数组伪真源)      │
│ 单模型配置抽屉:                      │       │ - models: [{ vendor: "...", ... }]   │
│ - 每个模型单独选协议 (重复30次)      │       │ - 缺少 Provider 顶层主体与协议继承   │
│ - 缺乏凭据命令解析 (!op, $ENV)       │       │                                      │
│                                      │       │ 脆弱方言判定:                        │
│                                      │       │ - if url.contains("deepseek") ...    │
└──────────────────────────────────────┘       └──────────────────────────────────────┘
                                  ▲                ▲
                                  │                │
                              【执行断层与状态漂移 (Drift)】
                                  │                │
                                  ▼                ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 运行时故障：                                                                        │
│ 1. 用户改了 models.yaml，内核请求依旧被 BUNDLED_CATALOG 拦截。                      │
│ 2. 私有代理 URL 无法命中 substring，发送错误字段引发 400 Bad Request。             │
│ 3. 探针扫描 (Probe) 粗暴覆盖用户本地价格与思考档位配置。                           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 模块二：对标 `@earendil-works/pi-ai` 优秀实践与架构差异化演进

### 2.1 `@earendil-works/pi-ai` 核心架构模式深度解构

在 `@earendil-works/pi-ai` 与 `coding-agent` 的参考实现中，展现了一套高度成熟、严谨且经过工业级考验的供应商与模型拓扑设计。其核心设计准则体现在以下几个维度：

1. **Provider-Centric 树状拓扑（供应商作为第一公民）**：
   - 顶级结构采用 `providers: Record<ProviderId, ProviderConfig>`，每一个 Provider 是一个自治的命名空间，集中管理 `baseUrl`、`api`、`apiKey`、`headers`、`compat` 以及其统辖的 `models` 列表。
   - 确立了严格的**自顶向下继承与局部覆盖（Inheritance & Override）**语义：
     - `Model.api` 默认为空，自动继承 `Provider.api`；仅当特殊模型需要跨协议时（例如在 OpenAI 体系内，大部分走 `openai-completions`，而 GPT-5.6 Sol 显式指定 `openai-responses`），才由 Model 显式声明并覆盖。
     - `compat` 兼具 Provider 级统一约束与 Model 级深度合并（Shallow / Deep Merge）能力。
2. **凭据求值引擎（Flexible Value Resolution Pipeline）**：
   - `apiKey` 与 `headers` 的取值采用统一的动态求值解析器，支持四种表达式语法：
     - **命令执行态 (`!command`)**：以 `!` 开头表示执行外部命令并提取 stdout（如 `!security find-generic-password -ws 'deepseek'` 或 `!op read 'op://dev/deepseek/key'`）。
     - **环境变量插值态 (`$ENV` / `${ENV}`)**：支持读取宿主环境变量，并允许嵌入复杂字符串模板。
     - **转义防护态 (`$$` / `$!`)**：允许开发者传递包含 `$` 或 `!` 的字面量字符串，避免语法误伤。
     - **字面量裸串 (Literal)**：兜底纯文本明文配置。
   - 该解析管道确保了敏感凭据可以无缝对接企业级 Secret Manager，避免密钥硬编码入库。
3. **细粒度的兼容性方言矩阵（Declarative Compat Matrix）**：
   - `pi-ai` 彻底摒弃了 URL 字符串模糊猜测，将所有协议怪癖（Protocol Quirks）与网关差异转化为声明式的 `compat` 配置项：
     - 角色转换：`supportsDeveloperRole: false` ➔ 将 `developer` 角色退化为 `system`。
     - 字段路由：`maxTokensField: "max_tokens"` vs `"max_completion_tokens"`。
     - 思考方言：`thinkingFormat` 支持 11 种精确形态（`openai`、`deepseek`、`qwen`、`together`、`baseten`、`zai`、`chat-template`、`qwen-chat-template`、`string-thinking` 等）。
     - 缓存控制：`cacheControlFormat: "anthropic"` 声明在 OpenAI 兼容端点上使用 Anthropic 风格的 `cache_control` 断点。
     - 路由透传：`openRouterRouting` 与 `vercelGatewayRouting` 原生透传上游网关调度参数。

### 2.2 Conex 差异化诉求与桌面原生超越性设计

在吸收 `@earendil-works/pi-ai` 优秀实践的基础上，结合 Conex 作为 **“Rust 内核 + Tauri 桌面宿主 + 深度 Agent 会话系统”** 的独特性，我们进行以下超越性演进设计：

1. **OS 原生凭据保管库（DPAPI / Keychain / SecretService）深度集成**：
   - `pi-ai` 基于 Node.js CLI 环境，依赖外部命令行（如 `op` 或 `security`）调用系统钥匙串。
   - Conex 拥有 Rust 原生系统调用层，将本地系统加密存储作为凭据解析的第一级通道。设计 `vault://<credential-id>` 统一虚拟协议，在 Windows 上走 DPAPI、macOS 上走 Security.framework、Linux 上走 SecretService。
   - 实现四级凭据解析流水线：`OS Vault (vault://)` ➔ `External Command (!cmd)` ➔ `Environment Variable ($ENV)` ➔ `Literal Plaintext`。
2. **多进程跨端响应式热重载（RCU Engine）**：
   - `pi-ai` 在 CLI 单次运行中通过重新加载文件刷新模型列表。
   - Conex 是由 Tauri 后台多线程运行时与前端 WebView 构成的多进程架构。必须在 Rust 内核实现基于 `ArcSwap` 的无锁 RCU 目录管理器，配合 `notify` 监控 `~/.conex/models.yaml` 文件变动，实现：
     - 外部编辑器修改 YAML ➔ 内核毫秒级原子热替换；
     - 替换期间，正在执行的流式调用继续持有旧配置的 `Arc<RuntimeCatalog>` 引用，生命周期隔离，零并发冲突与零中断；
     - 新发起的 Agent 会话立即可见新模型与新端点。
3. **探针探测与用户配置的智能三向合并（Three-Way Merge）**：
   - 当用户在前端点击“探测刷新模型”时，执行 `probe_scan_models_core`。
   - 算法并非覆盖或丢弃，而是执行严格的三向合并（Three-Way Merge）：
     - 保留用户对已有模型的改名（`displayName`）、调价（`pricing`）、思考档位（`thinking`）与兼容性覆盖（`compat`）；
     - 追加探针探测到的上游新增模型（`id` 维度增量）；
     - 对上游已下线的模型标记 `stale: true`，但不强行删除，避免历史对话会话无法回溯。
4. **前端人体工学与单模型抽屉降噪**：
   - 将“调用协议”置顶于 Provider 设置卡片中，作为该供应商的全局主协议；
   - 单模型配置抽屉（`ModelConfigPanel`）默认彻底隐藏协议选择器，消除 95% 的重复配置视觉负担；仅在极其罕见的特殊跨协议模型上提供“高级覆盖”开关。

### 2.3 架构对比与演进决策矩阵

| 架构维度 | Conex 现状 (Legacy) | @earendil-works/pi-ai 模式 | Conex 重构后目标架构 (Target SSOT) |
| :--- | :--- | :--- | :--- |
| **拓扑组织** | 扁平一维数组，vendor 弱字段反向挂载 | 树状 Map 结构，Provider 为主体，下挂 models 列表 | 树状 `models.yaml` 绝对真源，`ProviderSpec` 嵌套 `ModelSpec` |
| **真源位置** | 前端 LocalStorage 与后端 models.yaml 双轨割裂 | 单一 JSON/YAML 配置文件 (`models.json`) | `~/.conex/models.yaml` 跨进程唯一真源，淘汰前端独立存储 |
| **执行解析** | 静态编译期单例 `BUNDLED_CATALOG` 拦截 | 运行时纯配置驱动，直接对接流适配器 | 动态运行时 `RuntimeCatalog`，彻底淘汰 `BUNDLED_CATALOG` |
| **协议继承** | 无继承机制，每个模型必须单独选协议 | Provider 层声明 `api`，Model 自动继承，支持显式覆盖 | 三层决议：`Model.protocol` ➔ `Provider.protocol` ➔ 默认 `openai/chat` |
| **凭据求值** | 仅支持明文存储在配置文件或 LocalStorage | 支持 `!cmd`、`$ENV`、转义与明文 | 四级解析：`vault://` (OS原生) ➔ `!cmd` ➔ `$ENV` ➔ 明文字面量 |
| **方言判定** | 基于 `baseUrl` 的脆弱子串匹配猜测 | 显式声明的 `compat` 配置字典（11 种方言） | 精确强类型 `CompatConfig`，支持 Provider 全局与 Model 级深合并 |
| **热重载机制**| 需重启应用或无感知，并发存在竞态断流 | 每次打开选模菜单重新读文件 | Rust 内核 `ArcSwap` 原子替换，文件监控防抖，会话平滑保活 |
| **探针合流** | 粗暴覆盖或完全忽略 | 不涉及（由外部静态生成维护） | 智能三向合流算法，保护用户个性化元数据，平滑同步新上线模型 |

---

## 模块三：完整的强类型数据结构设计

### 3.1 Rust 内核数据结构全集（带 serde 与 camelCase 契约）

在 Rust 内核（位于 `crates/conex-providers/src/models.rs` 及对应模块）中，彻底淘汰原有扁平结构，建立严密的树状强类型定义：

```rust
//! Conex 统一供应商与模型能力树状 Schema 强类型契约
//! 对应物理文件: ~/.conex/models.yaml

use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};

/// 树状配置顶层根节点：跨系统唯一 SSOT
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedModelsConfig {
    /// 配置文件架构版本 (当前固定为 1)
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,

    /// 供应商主体映射表，Key 为供应商机器标识符 (如 "deepseek", "openai", "qwen")
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderSpec>,
}

fn default_schema_version() -> u32 {
    1
}

/// 供应商主体规格定义 (Provider 作为第一公民)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSpec {
    /// 前端界面展示全称 (如 "DeepSeek 官方", "阿里云百炼")
    pub display_name: String,

    /// API 基础端点地址 (如 "https://api.deepseek.com")
    pub base_url: String,

    /// 供应商全局默认通信协议 (如 "openai/chat", "anthropic/messages")
    #[serde(default = "default_provider_protocol")]
    pub protocol: ProtocolKind,

    /// 凭据配置表达式 (支持 vault://, !command, $ENV, 或明文)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,

    /// 是否自动注入 Authorization: Bearer <apiKey> 请求头，默认 true
    #[serde(default = "default_true")]
    pub auth_header: bool,

    /// 自定义全局请求头 (如 X-Portkey-API-Key, HTTP-Referer 等)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,

    /// 供应商层级通用方言兼容性配置
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatConfig>,

    /// 自定义网络代理 (如 "socks5://127.0.0.1:7890" 或 "http://127.0.0.1:8080")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_url: Option<String>,

    /// 供应商状态 (是否在界面与调度中启用)
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// 排序权重 (数值越小排序越靠前)
    #[serde(default)]
    pub sort_order: i32,

    /// 供应商统辖的模型列表
    #[serde(default)]
    pub models: Vec<ModelSpec>,
}

fn default_provider_protocol() -> ProtocolKind {
    ProtocolKind::OpenAiChat
}

fn default_true() -> bool {
    true
}

/// 支持的底层 AI 通信协议枚举
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProtocolKind {
    /// OpenAI Chat Completions 协议 (POST /v1/chat/completions)
    #[serde(rename = "openai/chat")]
    OpenAiChat,

    /// OpenAI Responses 协议 (POST /responses) - 面向 GPT-5.6+ 与原生 Agent
    #[serde(rename = "openai/responses")]
    OpenAiResponses,

    /// Anthropic Messages 协议 (POST /v1/messages)
    #[serde(rename = "anthropic/messages")]
    AnthropicMessages,

    /// Google Generative AI 协议 (POST /v1beta/models/{model}:streamGenerateContent)
    #[serde(rename = "google/generate-content")]
    GoogleGenerateContent,

    /// Google Interactions 协议 (POST /v1beta/interactions)
    #[serde(rename = "google/interactions")]
    GoogleInteractions,

    /// AWS Bedrock Converse Stream 协议
    #[serde(rename = "bedrock/converse-stream")]
    BedrockConverseStream,

    /// Mistral Conversations 协议
    #[serde(rename = "mistral/conversations")]
    MistralConversations,
}

/// 单个模型节点规格定义
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    /// 模型在线 API 真实标识符 (Wire Name, 如 "deepseek-v4-flash", "gpt-5.6-sol")
    pub id: String,

    /// 人类友好展示名称 (如 "DeepSeek V4 Flash 极速版")
    pub display_name: String,

    /// 模型级协议显式覆盖 (若为 None，则继承 ProviderSpec.protocol)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolKind>,

    /// 上下文总窗口大小 (Tokens, 如 1048576)
    pub context_window: u64,

    /// 最大单次生成输出上限 (Tokens, 如 384000)
    pub max_output_tokens: u64,

    /// 思考推理能力规格
    #[serde(default)]
    pub thinking: ThinkingSpec,

    /// 模态输入与输出能力矩阵
    #[serde(default)]
    pub modalities: ModalityMatrix,

    /// 计费与结算体系 (完全选填，未填时不展示价格噪音)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<PricingSpec>,

    /// 默认采样超参数配置 (温度、Top-P、惩罚系数等)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub sampling_params: BTreeMap<String, serde_json::Value>,

    /// 模型专属自定义请求头
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,

    /// 模型级方言覆盖 (与 ProviderSpec.compat 深度合并)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compat: Option<CompatConfig>,

    /// 模型是否启用
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// 探针扫描探测标记 (由动态探测生成，用于合流管理)
    #[serde(default)]
    pub is_probed: bool,
}

/// 思考与深度推理控制规格
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingSpec {
    /// 模型物理架构是否支持思考 (为 false 时 UI 彻底折叠隐藏胶囊)
    #[serde(default)]
    pub enabled: bool,

    /// 是否为强制思考模型 (为 true 时 UI 物理隐藏 Off 选项，如 o3, Muse Spark)
    #[serde(default)]
    pub mandatory: bool,

    /// 默认激活档位 (必须为白名单纯英文: "minimal", "low", "medium", "high", "xhigh", "max")
    #[serde(default = "default_thinking_level")]
    pub default_level: String,

    /// 纯英文 7 档严格三态映射表 (Key: 档位, Value: Some(wire值) 或 None(不支持/不渲染))
    #[serde(default)]
    pub levels: BTreeMap<String, Option<String>>,

    /// 自定义思考 Token 预算钳制参数 (面向 Anthropic/Gemini 预算制模型)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<ThinkingBudgetConfig>,
}

fn default_thinking_level() -> String {
    "medium".to_string()
}

impl Default for ThinkingSpec {
    fn default() -> Self {
        Self {
            enabled: false,
            mandatory: false,
            default_level: default_thinking_level(),
            levels: BTreeMap::new(),
            token_budget: None,
        }
    }
}

/// 思考预算微调配置
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThinkingBudgetConfig {
    pub minimal: Option<u64>,
    pub low: Option<u64>,
    pub medium: Option<u64>,
    pub high: Option<u64>,
    pub xhigh: Option<u64>,
    pub max: Option<u64>,
}

/// 模态能力矩阵
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModalityMatrix {
    /// 允许输入的模态白名单 (如 ["text", "image", "video", "file", "audio"])
    #[serde(default = "default_input_modalities")]
    pub input: Vec<String>,

    /// 允许输出的模态 (如 ["text"] 或 ["text", "image"])
    #[serde(default = "default_output_modalities")]
    pub output: Vec<String>,
}

fn default_input_modalities() -> Vec<String> {
    vec!["text".to_string()]
}

fn default_output_modalities() -> Vec<String> {
    vec!["text".to_string()]
}

impl Default for ModalityMatrix {
    fn default() -> Self {
        Self {
            input: default_input_modalities(),
            output: default_output_modalities(),
        }
    }
}

/// 计费计量规格定义
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingSpec {
    /// 结算货币种类: "USD" 或 "CNY"
    #[serde(default = "default_currency")]
    pub currency: String,

    /// 计量单位基准: "per_1m_tokens" 或 "per_image"
    #[serde(default = "default_unit")]
    pub unit: String,

    /// 普通输入提示词单价 (Prompt)
    pub input: f64,

    /// 生成输出单价 (Completion)
    pub output: f64,

    /// 缓存命中读取单价 (Cache Read)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,

    /// 缓存写入创建单价 (Cache Write)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

fn default_currency() -> String {
    "USD".to_string()
}

fn default_unit() -> String {
    "per_1m_tokens".to_string()
}

/// 11 大类方言与协议适配参数集 (CompatConfig)
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatConfig {
    /// 是否支持 developer 角色 (OpenAI o-series/GPT-5 使用；若 false 则自动降级为 system 角色)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_developer_role: Option<bool>,

    /// 是否支持 reasoning_effort 顶层字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_reasoning_effort: Option<bool>,

    /// 思考推理传输格式方言
    /// 可选: "openai", "openrouter", "deepseek", "together", "baseten", "zai",
    ///       "qwen", "qwen_enable_thinking", "chat-template", "qwen-chat-template"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_format: Option<String>,

    /// Max Tokens 字段选用
    /// 可选: "max_completion_tokens" 或 "max_tokens"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens_field: Option<String>,

    /// 流式响应中是否支持 stream_options: { include_usage: true }
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_usage_in_streaming: Option<bool>,

    /// 工具调用返回值是否强制要求 name 字段
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_tool_result_name: Option<bool>,

    /// 工具返回后是否必须插入 assistant 消息以防连续 user 消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_assistant_after_tool_result: Option<bool>,

    /// 是否要求将 thinking 块转换为 <thinking> 纯文本回放
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_thinking_as_text: Option<bool>,

    /// 回放 assistant 消息时是否必须附带空的 reasoning_content 字段 (如 DeepSeek 某些网关)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires_reasoning_content_on_assistant_messages: Option<bool>,

    /// 思考 Token 预算字段映射 (如 "thinking_token_budget", "thinking_budget", "thinking_budget_tokens")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_token_budget_field: Option<String>,

    /// 提示词缓存格式规范 (如 "anthropic")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control_format: Option<String>,

    /// 是否发送 Session 亲和性请求头 (用于服务端缓存命中优化)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub send_session_affinity_headers: Option<bool>,

    /// 会话亲和性格式 (如 "openai", "openai-nosession", "openrouter")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_affinity_format: Option<String>,

    /// 是否支持 Strict JSON Schema 工具约束模式
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_strict_mode: Option<bool>,

    /// OpenRouter 专有网关路由控制参数 (透传至 request.provider)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_router_routing: Option<serde_json::Value>,

    /// Vercel AI Gateway 专有网关路由控制参数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vercel_gateway_routing: Option<serde_json::Value>,
}
```

### 3.2 TypeScript 强类型契约全集（跨进程与前端中枢）

在共享类型库（`packages/shared/src/types/models.ts`）中，镜像导出与 Rust 契约 100% 严格对称的 TypeScript 类型：

```typescript
/**
 * Conex 统一供应商与模型能力树状 Schema (TypeScript 镜像契约)
 * 与 Rust crates/conex-providers/src/models.rs 保持严格 1:1 双向序列化兼容
 */

export type ProtocolKind =
  | 'openai/chat'
  | 'openai/responses'
  | 'anthropic/messages'
  | 'google/generate-content'
  | 'google/interactions'
  | 'bedrock/converse-stream'
  | 'mistral/conversations';

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ModelThinkingLevel = 'off' | ThinkingLevel;

export interface ThinkingBudgetConfig {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
  xhigh?: number;
  max?: number;
}

export interface ThinkingSpec {
  /** 模型架构是否支持思考 (若为 false，前端胶囊彻底折叠隐藏) */
  enabled: boolean;
  /** 是否强制思考 (若为 true，前端物理隐藏 Off 选项) */
  mandatory: boolean;
  /** 默认档位 */
  defaultLevel: ThinkingLevel;
  /** 纯英文 7 档严格映射表 (value 为 null 代表该档不支持) */
  levels: Record<string, string | null>;
  /** 思考预算微调 (预算制协议专用) */
  tokenBudget?: ThinkingBudgetConfig;
}

export interface ModalityMatrix {
  /** 允许输入的模态白名单 (如 ["text", "image", "file"]) */
  input: string[];
  /** 允许输出的模态 (如 ["text"]) */
  output: string[];
}

export interface PricingSpec {
  currency: 'USD' | 'CNY';
  unit: 'per_1m_tokens' | 'per_image';
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CompatConfig {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  thinkingFormat?:
    | 'openai'
    | 'openrouter'
    | 'deepseek'
    | 'together'
    | 'baseten'
    | 'zai'
    | 'qwen'
    | 'qwen_enable_thinking'
    | 'chat-template'
    | 'qwen-chat-template';
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  supportsUsageInStreaming?: boolean;
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens';
  cacheControlFormat?: 'anthropic';
  sendSessionAffinityHeaders?: boolean;
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter';
  supportsStrictMode?: boolean;
  openRouterRouting?: Record<string, unknown>;
  vercelGatewayRouting?: Record<string, unknown>;
}

export interface ModelSpec {
  id: string;
  displayName: string;
  protocol?: ProtocolKind;
  contextWindow: number;
  maxOutputTokens: number;
  thinking: ThinkingSpec;
  modalities: ModalityMatrix;
  pricing?: PricingSpec;
  samplingParams?: Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: CompatConfig;
  enabled: boolean;
  isProbed?: boolean;
}

export interface ProviderSpec {
  displayName: string;
  baseUrl: string;
  protocol: ProtocolKind;
  apiKey?: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  compat?: CompatConfig;
  proxyUrl?: string;
  enabled: boolean;
  sortOrder: number;
  models: ModelSpec[];
}

export interface UnifiedModelsConfig {
  schemaVersion: number;
  providers: Record<string, ProviderSpec>;
}
```

---

## 模块四：底层协议 Wire 格式与通信交互设计

### 4.1 四大主流通信协议 Wire 格式深度对比与端点映射

根据权威基准与模型调研，AI 底层请求协议必须根据有效决议协议（Effective Protocol）分发至对应的序列化器与网络端点：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                       四大主流通信协议端点与 Wire 架构对比                                       │
├───────────────────────┬───────────────────────────────┬─────────────────────────────────┬────────────────────────┤
│ 协议标识 (Protocol)   │ 标准 HTTP 端点                │ 核心 Payload 顶层键             │ 流式响应 SSE 块特征    │
├───────────────────────┼───────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ 1. openai/chat        │ POST {base_url}/chat/completions│ model, messages, stream, tools, │ data: {"choices": [{   │
│                       │                               │ temperature, stream_options     │   "delta": {"content"} │
├───────────────────────┼───────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ 2. openai/responses   │ POST {base_url}/responses     │ model, input, stream, tools,    │ event: response.output_│
│                       │                               │ reasoning: {effort}, containers │ text.delta             │
├───────────────────────┼───────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ 3. anthropic/messages │ POST {base_url}/v1/messages   │ model, messages, system, stream,│ event: content_block_  │
│                       │                               │ max_tokens, thinking: {type}    │ delta                  │
├───────────────────────┼───────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ 4. google/generate-   │ POST {base_url}/models/       │ contents, generationConfig,     │ data: {"candidates": [{│
│    content            │ {model}:streamGenerateContent │ tools, safetySettings           │   "content": {"parts"} │
└───────────────────────┴───────────────────────────────┴─────────────────────────────────┴────────────────────────┘
```

### 4.2 11 大方言（Compat）请求体 Wire 转换实录

#### 案例 1：标准 OpenAI Chat (`openai/chat` + GPT-4o / 通用网关)
```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are Conex Agent." },
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "temperature": 0.7,
  "max_tokens": 4096
}
```

#### 案例 2：OpenAI o-series / GPT-5.6 思考模型 (`supportsDeveloperRole: true`, `supportsReasoningEffort: true`)
```json
{
  "model": "o3-mini",
  "messages": [
    { "role": "developer", "content": "You are Conex Agent." },
    { "role": "user", "content": "Solve math puzzle." }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "reasoning_effort": "high",
  "max_completion_tokens": 16384
}
```

#### 案例 3：DeepSeek 官方 Chat Completions 思考方言 (`thinkingFormat: "deepseek"`)
```json
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "You are Conex Agent." },
    { "role": "user", "content": "Analyze performance bottleneck." }
  ],
  "stream": true,
  "thinking": {
    "type": "enabled"
  },
  "max_tokens": 384000
}
```

#### 案例 4：阿里云百炼 Qwen 顶层布尔思考方言 (`thinkingFormat: "qwen_enable_thinking"`)
```json
{
  "model": "qwen3.8-max",
  "messages": [
    { "role": "system", "content": "You are Conex Agent." },
    { "role": "user", "content": "Write high-concurrency Rust code." }
  ],
  "stream": true,
  "enable_thinking": true,
  "max_tokens": 65536
}
```

#### 案例 5：OpenRouter 思考控制与多上游路由参数透传 (`thinkingFormat: "openrouter"`, `openRouterRouting`)
```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "messages": [
    { "role": "user", "content": "Draft RFC document." }
  ],
  "stream": true,
  "reasoning": {
    "effort": "medium"
  },
  "provider": {
    "order": ["anthropic", "amazon-bedrock"],
    "only": ["anthropic", "amazon-bedrock"],
    "allow_fallbacks": true,
    "zdr": true
  }
}
```

#### 案例 6：OpenAI Responses API 原生形态 (`openai/responses` + GPT-5.6 Sol)
```json
{
  "model": "gpt-5.6-sol",
  "input": [
    { "role": "developer", "content": "You are an autonomous engineering agent." },
    { "role": "user", "content": "Refactor database connection pool." }
  ],
  "stream": true,
  "reasoning": {
    "effort": "high"
  },
  "max_output_tokens": 128000,
  "prompt_cache_options": {
    "ttl": "30m"
  },
  "tools": [
    {
      "type": "function",
      "name": "read_file",
      "description": "Read file content from local repository",
      "parameters": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        },
        "required": ["path"]
      }
    }
  ]
}
```

#### 案例 7：Anthropic Messages 原生前缀缓存与自适应思考 (`anthropic/messages` + Claude 5.1 Fable)
```json
{
  "model": "claude-fable-5.1",
  "system": [
    {
      "type": "text",
      "text": "You are a software architect agent.",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Review architecture diff.",
          "cache_control": { "type": "ephemeral" }
        }
      ]
    }
  ],
  "stream": true,
  "max_tokens": 128000,
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "high"
  }
}
```

#### 案例 8：Google Generative AI 原生思考与结构化流 (`google/generate-content` + Gemini 3.8 Flash)
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "Synthesize distributed trace logs." }
      ]
    }
  ],
  "generationConfig": {
    "maxOutputTokens": 65536,
    "temperature": 0.2,
    "thinkingConfig": {
      "thinkingLevel": "HIGH"
    }
  },
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "query_logs",
          "description": "Query traces",
          "parameters": {
            "type": "OBJECT",
            "properties": { "traceId": { "type": "STRING" } },
            "required": ["traceId"]
          }
        }
      ]
    }
  ]
}
```

### 4.3 请求端点决议与请求头注入引擎

在 Rust 网络调度层，统一封装 `resolve_request_endpoint` 与 `assemble_request_headers`：

```rust
//! crates/conex-providers/src/endpoint.rs

use crate::models::{ProtocolKind, ProviderSpec, ModelSpec};
use std::collections::BTreeMap;

pub struct ResolvedEndpoint {
    pub url: String,
    pub protocol: ProtocolKind,
}

pub fn resolve_request_endpoint(
    provider: &ProviderSpec,
    model: &ModelSpec,
    effective_protocol: ProtocolKind,
) -> ResolvedEndpoint {
    let mut base = provider.base_url.trim_end_matches('/').to_string();

    let url = match effective_protocol {
        ProtocolKind::OpenAiChat => {
            if base.ends_with("/chat/completions") {
                base
            } else if base.ends_with("/v1") {
                format!("{}/chat/completions", base)
            } else {
                // 标准兼容网关通常补全 /v1/chat/completions 或直接 /chat/completions
                format!("{}/v1/chat/completions", base)
            }
        }
        ProtocolKind::OpenAiResponses => {
            if base.ends_with("/responses") {
                base
            } else {
                format!("{}/responses", base)
            }
        }
        ProtocolKind::AnthropicMessages => {
            if base.ends_with("/v1/messages") {
                base
            } else if base.ends_with("/v1") {
                format!("{}/messages", base)
            } else {
                format!("{}/v1/messages", base)
            }
        }
        ProtocolKind::GoogleGenerateContent => {
            // Google API: {base_url}/models/{model}:streamGenerateContent?alt=sse
            format!("{}/models/{}:streamGenerateContent?alt=sse", base, model.id)
        }
        ProtocolKind::GoogleInteractions => {
            format!("{}/v1beta/interactions", base)
        }
        ProtocolKind::BedrockConverseStream => {
            format!("{}/model/{}/converse-stream", base, model.id)
        }
        ProtocolKind::MistralConversations => {
            format!("{}/v1/chat/completions", base)
        }
    };

    ResolvedEndpoint {
        url,
        protocol: effective_protocol,
    }
}

pub fn assemble_request_headers(
    provider: &ProviderSpec,
    model: &ModelSpec,
    effective_protocol: ProtocolKind,
    resolved_api_key: Option<&str>,
) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();

    // 1. 注入默认 Content-Type 与 Accept
    headers.insert("content-type".to_string(), "application/json".to_string());
    headers.insert("accept".to_string(), "text/event-stream, application/json".to_string());

    // 2. 注入认证头
    if let Some(key) = resolved_api_key {
        if provider.auth_header {
            match effective_protocol {
                ProtocolKind::AnthropicMessages => {
                    headers.insert("x-api-key".to_string(), key.to_string());
                    headers.insert("anthropic-version".to_string(), "2023-06-01".to_string());
                    headers.insert(
                        "anthropic-beta".to_string(),
                        "fine-grained-tool-streaming-2025-05-14".to_string(),
                    );
                }
                ProtocolKind::GoogleGenerateContent | ProtocolKind::GoogleInteractions => {
                    headers.insert("x-goog-api-key".to_string(), key.to_string());
                }
                _ => {
                    headers.insert("authorization".to_string(), format!("Bearer {}", key));
                }
            }
        }
    }

    // 3. 注入 Provider 级自定义 Headers (如 X-Title, HTTP-Referer)
    for (k, v) in &provider.headers {
        headers.insert(k.to_lowercase(), v.clone());
    }

    // 4. 注入 Model 级自定义 Headers (局部覆盖)
    for (k, v) in &model.headers {
        headers.insert(k.to_lowercase(), v.clone());
    }

    headers
}
```

---

## 模块五：核心状态转移机与算法伪代码

### 5.1 多层协议与方言决议状态机（Protocol Resolution Machine）

AI 请求构建前，必须通过确定性的优先级决议器计算出本次调用的最终协议与方言配置：

$$\text{EffectiveProtocol} = \text{Model.protocol} \succ \text{Provider.protocol} \succ \text{ProtocolKind::OpenAiChat}$$

```rust
//! crates/conex-providers/src/resolution.rs

use crate::models::{CompatConfig, ModelSpec, ProtocolKind, ProviderSpec};

#[derive(Debug, Clone)]
pub struct ResolvedCallContext {
    pub protocol: ProtocolKind,
    pub compat: CompatConfig,
}

pub fn resolve_call_context(provider: &ProviderSpec, model: &ModelSpec) -> ResolvedCallContext {
    // 1. 协议三层继承决议
    let effective_protocol = model
        .protocol
        .unwrap_or(provider.protocol);

    // 2. 方言配置深度逐字段合并 (Model 显式覆盖 Provider 默认)
    let p_compat = provider.compat.clone().unwrap_or_default();
    let m_compat = model.compat.clone().unwrap_or_default();

    let merged_compat = CompatConfig {
        supports_developer_role: m_compat
            .supports_developer_role
            .or(p_compat.supports_developer_role),
        supports_reasoning_effort: m_compat
            .supports_reasoning_effort
            .or(p_compat.supports_reasoning_effort),
        thinking_format: m_compat
            .thinking_format
            .or(p_compat.thinking_format),
        max_tokens_field: m_compat
            .max_tokens_field
            .or(p_compat.max_tokens_field),
        supports_usage_in_streaming: m_compat
            .supports_usage_in_streaming
            .or(p_compat.supports_usage_in_streaming),
        requires_tool_result_name: m_compat
            .requires_tool_result_name
            .or(p_compat.requires_tool_result_name),
        requires_assistant_after_tool_result: m_compat
            .requires_assistant_after_tool_result
            .or(p_compat.requires_assistant_after_tool_result),
        requires_thinking_as_text: m_compat
            .requires_thinking_as_text
            .or(p_compat.requires_thinking_as_text),
        requires_reasoning_content_on_assistant_messages: m_compat
            .requires_reasoning_content_on_assistant_messages
            .or(p_compat.requires_reasoning_content_on_assistant_messages),
        thinking_token_budget_field: m_compat
            .thinking_token_budget_field
            .or(p_compat.thinking_token_budget_field),
        cache_control_format: m_compat
            .cache_control_format
            .or(p_compat.cache_control_format),
        send_session_affinity_headers: m_compat
            .send_session_affinity_headers
            .or(p_compat.send_session_affinity_headers),
        session_affinity_format: m_compat
            .session_affinity_format
            .or(p_compat.session_affinity_format),
        supports_strict_mode: m_compat
            .supports_strict_mode
            .or(p_compat.supports_strict_mode),
        open_router_routing: m_compat
            .open_router_routing
            .or(p_compat.open_router_routing),
        vercel_gateway_routing: m_compat
            .vercel_gateway_routing
            .or(p_compat.vercel_gateway_routing),
    };

    ResolvedCallContext {
        protocol: effective_protocol,
        compat: merged_compat,
    }
}
```

### 5.2 凭据生命周期四级解析算法（Credential Resolution Pipeline）

支持安全擦除（Zeroize）、OS 级 Vault、命令执行、环境变量与转义字符的完整解析管道：

```rust
//! crates/conex-storage/src/credentials.rs

use std::process::Command;
use thiserror::Error;
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Error, Debug)]
pub enum CredentialError {
    #[error("OS 凭据管理器读取失败: {0}")]
    VaultError(String),
    #[error("外部命令执行失败 (Command: {cmd}): {reason}")]
    CommandExecutionFailed { cmd: String, reason: String },
    #[error("环境变量不存在: {0}")]
    EnvVarNotFound(String),
    #[error("空凭据配置")]
    EmptyConfig,
}

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(s: String) -> Self {
        Self(s)
    }
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

pub struct CredentialResolver;

impl CredentialResolver {
    /// 统一解析 API Key
    pub fn resolve(raw: &str, provider_id: &str) -> Result<SecretString, CredentialError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(CredentialError::EmptyConfig);
        }

        // 1. 级别一：OS 级原生保管库协议 (vault://<key_id>)
        if let Some(key_id) = trimmed.strip_prefix("vault://") {
            return Self::resolve_from_vault(key_id);
        }

        // 2. 级别二：外部动态脚本与 CLI 执行态 (!command ...)
        if let Some(cmd_str) = trimmed.strip_prefix('!') {
            return Self::resolve_from_command(cmd_str);
        }

        // 3. 级别三：转义处理 ($$ 转换为 $, $! 转换为 !)
        if trimmed.starts_with("$$") {
            return Ok(SecretString::new(trimmed[1..].to_string()));
        }
        if trimmed.starts_with("$!") {
            return Ok(SecretString::new(trimmed[1..].to_string()));
        }

        // 4. 级别四：环境变量插值 ($ENV_VAR 或 ${ENV_VAR})
        if trimmed.starts_with('$') {
            return Self::resolve_from_env(trimmed);
        }

        // 5. 兜底：字面量纯文本明文
        Ok(SecretString::new(trimmed.to_string()))
    }

    fn resolve_from_vault(key_id: &str) -> Result<SecretString, CredentialError> {
        // 调用底层平台原生凭据存储 (Windows DPAPI / Credential Manager, macOS Keychain)
        #[cfg(target_os = "windows")]
        {
            // 通过 DPAPI 或 Credential Manager 读取
            crate::platform::windows_vault::get_secret(key_id)
                .map(SecretString::new)
                .map_err(|e| CredentialError::VaultError(e.to_string()))
        }
        #[cfg(target_os = "macos")]
        {
            crate::platform::macos_keychain::get_secret(key_id)
                .map(SecretString::new)
                .map_err(|e| CredentialError::VaultError(e.to_string()))
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            crate::platform::linux_secret::get_secret(key_id)
                .map(SecretString::new)
                .map_err(|e| CredentialError::VaultError(e.to_string()))
        }
    }

    fn resolve_from_command(cmd_str: &str) -> Result<SecretString, CredentialError> {
        let trimmed_cmd = cmd_str.trim();
        #[cfg(target_os = "windows")]
        let output = Command::new("pwsh")
            .args(&["-NoProfile", "-NonInteractive", "-Command", trimmed_cmd])
            .output();

        #[cfg(not(target_os = "windows"))]
        let output = Command::new("sh")
            .args(&["-c", trimmed_cmd])
            .output();

        match output {
            Ok(out) => {
                if out.status.success() {
                    let stdout_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    Ok(SecretString::new(stdout_str))
                } else {
                    let stderr_str = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    Err(CredentialError::CommandExecutionFailed {
                        cmd: trimmed_cmd.to_string(),
                        reason: stderr_str,
                    })
                }
            }
            Err(e) => Err(CredentialError::CommandExecutionFailed {
                cmd: trimmed_cmd.to_string(),
                reason: e.to_string(),
            }),
        }
    }

    fn resolve_from_env(template: &str) -> Result<SecretString, CredentialError> {
        let var_name = if template.starts_with("${") && template.ends_with('}') {
            &template[2..template.len() - 1]
        } else {
            &template[1..]
        };

        match std::env::var(var_name) {
            Ok(val) => Ok(SecretString::new(val)),
            Err(_) => Err(CredentialError::EnvVarNotFound(var_name.to_string())),
        }
    }
}
```

### 5.3 模型动态探测与智能自愈合流算法（Probe Scan & Three-Way Merge）

当用户触发“在线探测服务商模型（Probe Scan）”时，执行不丢配置的智能三向合并：

```rust
//! crates/conex-providers/src/merge.rs

use crate::models::{ModelSpec, ProviderSpec, ThinkingSpec, ModalityMatrix};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct ProbedModelRaw {
    pub id: String,
    pub display_name: Option<String>,
    pub context_window: Option<u64>,
    pub max_output_tokens: Option<u64>,
}

/// 执行探测结果与现有模型的智能合流算法
pub fn merge_probed_models(
    provider: &mut ProviderSpec,
    probed_list: Vec<ProbedModelRaw>,
) -> MergeReport {
    let mut current_map: BTreeMap<String, ModelSpec> = provider
        .models
        .drain(..)
        .map(|m| (m.id.clone(), m))
        .collect();

    let mut added_count = 0;
    let mut updated_count = 0;
    let mut preserved_count = 0;

    for probed in probed_list {
        if let Some(existing) = current_map.get_mut(&probed.id) {
            // 已存在模型：保护用户自定义资产！
            // 绝不覆盖：displayName (若用户已改名)、pricing、thinking、compat、headers
            // 仅当用户未自定义 contextWindow 且上游返回更准确值时做安全更新
            if existing.context_window == 0 {
                if let Some(cw) = probed.context_window {
                    existing.context_window = cw;
                    updated_count += 1;
                }
            }
            if existing.max_output_tokens == 0 {
                if let Some(mo) = probed.max_output_tokens {
                    existing.max_output_tokens = mo;
                }
            }
            existing.is_probed = true;
            preserved_count += 1;
        } else {
            // 新发现模型：以安全默认规格追加加入
            let new_model = ModelSpec {
                id: probed.id.clone(),
                display_name: probed.display_name.unwrap_or_else(|| probed.id.clone()),
                protocol: None, // 默认继承 Provider 协议
                context_window: probed.context_window.unwrap_or(128_000),
                max_output_tokens: probed.max_output_tokens.unwrap_or(16_384),
                thinking: ThinkingSpec::default(),
                modalities: ModalityMatrix::default(),
                pricing: None, // 选填，不瞎填假数据
                sampling_params: BTreeMap::new(),
                headers: BTreeMap::new(),
                compat: None,
                enabled: true,
                is_probed: true,
            };
            current_map.insert(probed.id, new_model);
            added_count += 1;
        }
    }

    // 重构排序写回 provider.models
    provider.models = current_map.into_values().collect();

    MergeReport {
        added: added_count,
        updated: updated_count,
        preserved: preserved_count,
    }
}

pub struct MergeReport {
    pub added: usize,
    pub updated: usize,
    pub preserved: usize,
}
```

### 5.4 内核零中断无锁热重载状态机（RCU / ArcSwap Hot-Reload Engine）

构建基于 `arc-swap` 与 `notify` 的零中断全局目录管理器：

```rust
//! crates/conex-providers/src/catalog_manager.rs

use crate::models::UnifiedModelsConfig;
use arc_swap::ArcSwap;
use notify::{RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::channel;
use std::time::Duration;
use tracing::{info, warn, error};

pub struct RuntimeCatalog {
    pub config: UnifiedModelsConfig,
    pub load_timestamp_ms: u64,
}

pub struct CatalogManager {
    current: ArcSwap<RuntimeCatalog>,
    config_path: PathBuf,
}

impl CatalogManager {
    pub fn new(config_path: PathBuf) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let initial_config = Self::load_from_disk(&config_path)?;
        let catalog = RuntimeCatalog {
            config: initial_config,
            load_timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as u64,
        };

        let manager = Arc::new(Self {
            current: ArcSwap::from_pointee(catalog),
            config_path,
        });

        // 启动后台文件监听线程
        Self::spawn_file_watcher(Arc::clone(&manager));

        Ok(manager)
    }

    /// 获取当前最新运行时目录快照 (O(1) 极速原子克隆指针)
    pub fn get_catalog(&self) -> Arc<RuntimeCatalog> {
        self.current.load_full()
    }

    /// 从磁盘解析 YAML
    fn load_from_disk(path: &Path) -> Result<UnifiedModelsConfig, Box<dyn std::error::Error>> {
        if !path.exists() {
            info!("配置文件不存在，创建默认初始 models.yaml: {:?}", path);
            let default_cfg = Self::create_default_config();
            let yaml_text = serde_yaml::to_string(&default_cfg)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, yaml_text)?;
            return Ok(default_cfg);
        }

        let content = std::fs::read_to_string(path)?;
        let config: UnifiedModelsConfig = serde_yaml::from_str(&content)?;
        Ok(config)
    }

    /// 执行原子替换 (RCU)
    pub fn reload(&self) -> Result<(), Box<dyn std::error::Error>> {
        let new_config = Self::load_from_disk(&self.config_path)?;
        let new_catalog = RuntimeCatalog {
            config: new_config,
            load_timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as u64,
        };

        // 原子指针 CAS 替换！正在执行的会话持有旧 Arc，新会话持有新 Arc
        self.current.store(Arc::new(new_catalog));
        info!("models.yaml 热重载成功完成，全局指针已原子替换");
        Ok(())
    }

    fn spawn_file_watcher(manager: Arc<Self>) {
        std::thread::spawn(move || {
            let (tx, rx) = channel();
            let mut watcher: RecommendedWatcher = match Watcher::new(
                move |res| {
                    if let Ok(event) = res {
                        let _ = tx.send(event);
                    }
                },
                notify::Config::default().with_poll_interval(Duration::from_millis(500)),
            ) {
                Ok(w) => w,
                Err(e) => {
                    error!("无法创建文件监视器: {:?}", e);
                    return;
                }
            };

            if let Err(e) = watcher.watch(&manager.config_path, RecursiveMode::NonRecursive) {
                warn!("监控 models.yaml 失败: {:?}", e);
                return;
            }

            // 防抖时间窗口: 300ms
            let debounce_window = Duration::from_millis(300);
            while let Ok(event) = rx.recv() {
                if matches!(event.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    // 清空队列中剩余的连续修改事件 (防抖)
                    std::thread::sleep(debounce_window);
                    while rx.try_recv().is_ok() {}

                    info!("检测到 models.yaml 磁盘变动，触发无锁热重载...");
                    if let Err(e) = manager.reload() {
                        error!("热重载 models.yaml 失败: {:?}", e);
                    }
                }
            }
        });
    }

    fn create_default_config() -> UnifiedModelsConfig {
        UnifiedModelsConfig {
            schema_version: 1,
            providers: std::collections::BTreeMap::new(),
        }
    }
}
```

---

## 模块六：精确到现有代码文件与函数签名的工程改造方案

### 6.1 影响模块范围与工程改造拓扑

重构横跨 Rust 内核、Tauri IPC 桥接层与前端状态层。改造拓扑如下：

```
[crates/conex-providers]
  ├── src/models.rs            --> 完全重写为树状 UnifiedModelsConfig, ProviderSpec, ModelSpec
  ├── src/catalog.rs           --> 彻底废除 BUNDLED_CATALOG，重写为基于 CatalogManager 的动态查找
  ├── src/endpoint.rs          --> [新增] 协议端点决议与请求头组装器
  ├── src/resolution.rs        --> [新增] EffectiveProtocol 与 Compat 三层决议
  ├── src/probe.rs             --> 重构探针，接入 merge_probed_models 三向合流
  └── src/catalog_manager.rs   --> [新增] 基于 ArcSwap 的 RCU 热重载管理器

[crates/conex-storage]
  └── src/credentials.rs       --> 重构 API Key 提取为四级凭据解析流水线 (DPAPI/Command/Env/Literal)

[crates/conex-session-loop]
  ├── src/executor.rs          --> 从 CatalogManager 获取运行时 ModelSpec，废除硬编码分支
  └── src/client.rs            --> 依据 EffectiveProtocol 动态分发至对应 SSE 流适配器

[apps/agent-workbench/src-tauri]
  └── src/commands/models.rs   --> 改造 IPC 命令：models_get_tree, models_save_tree, models_probe_provider

[packages/shared]
  └── src/types/models.ts      --> 镜像对齐树状 TypeScript 接口

[apps/crish-desktop]
  └── src/stores/modelsCatalogStore.ts --> 重写为树状单轨 Store，废除 LocalStorage ProviderProfiles
```

### 6.2 具体文件改造清单、结构体变更与方法签名重构

#### 1. `crates/conex-providers/src/catalog.rs`
- **废除原代码**：
  ```rust
  // 废除！
  pub static BUNDLED_CATALOG: Lazy<Catalog> = Lazy::new(|| ... include_str!("catalog.json") ...);
  ```
- **改造后全新方法签名**：
  ```rust
  use crate::models::{ModelSpec, ProviderSpec, UnifiedModelsConfig};
  use crate::catalog_manager::CatalogManager;
  use std::sync::Arc;

  pub struct ModelCatalogService {
      manager: Arc<CatalogManager>,
  }

  impl ModelCatalogService {
      pub fn new(manager: Arc<CatalogManager>) -> Self {
          Self { manager }
      }

      /// 动态查找匹配的模型与所属供应商
      pub fn find_model(&self, model_id: &str) -> Option<(ProviderSpec, ModelSpec)> {
          let catalog = self.manager.get_catalog();
          for provider in catalog.config.providers.values() {
              if !provider.enabled {
                  continue;
              }
              for model in &provider.models {
                  if model.enabled && model.id == model_id {
                      return Some((provider.clone(), model.clone()));
                  }
              }
          }
          None
      }

      /// 获取全量树状配置快照
      pub fn get_full_config(&self) -> UnifiedModelsConfig {
          self.manager.get_catalog().config.clone()
      }
  }
  ```

#### 2. `crates/conex-session-loop/src/executor.rs`
- **改造点**：
  在发起模型流式调用前，完全由动态 `ModelCatalogService` 检索 `(ProviderSpec, ModelSpec)`，执行协议与凭据决议：
  ```rust
  pub async fn execute_turn(
      &self,
      session: &SessionContext,
      model_id: &str,
  ) -> Result<AssistantMessageStream, SessionError> {
      // 1. 动态获取模型与供应商元数据
      let (provider, model) = self.catalog_service
          .find_model(model_id)
          .ok_or_else(|| SessionError::ModelNotFound(model_id.to_string()))?;

      // 2. 决议最终调用协议与方言
      let resolved_ctx = resolve_call_context(&provider, &model);

      // 3. 动态解析凭据
      let api_key = if let Some(ref raw_key) = provider.api_key {
          Some(CredentialResolver::resolve(raw_key, &provider.display_name)?)
      } else {
          None
      };

      // 4. 解析端点与 Headers
      let endpoint = resolve_request_endpoint(&provider, &model, resolved_ctx.protocol);
      let headers = assemble_request_headers(
          &provider,
          &model,
          resolved_ctx.protocol,
          api_key.as_ref().map(|s| s.expose_secret()),
      );

      // 5. 根据 resolved_ctx.protocol 分发至真实流解析器
      self.stream_dispatch_client
          .dispatch_stream(endpoint, headers, resolved_ctx, session)
          .await
  }
  ```

#### 3. `apps/agent-workbench/src-tauri/src/commands/models.rs`
- **重构 Tauri IPC 接口**：
  ```rust
  #[tauri::command]
  pub async fn get_unified_models_config(
      state: tauri::State<'_, AppState>,
  ) -> Result<UnifiedModelsConfig, String> {
      Ok(state.catalog_service.get_full_config())
  }

  #[tauri::command]
  pub async fn save_unified_models_config(
      new_config: UnifiedModelsConfig,
      state: tauri::State<'_, AppState>,
  ) -> Result<(), String> {
      // 写入 ~/.conex/models.yaml，触发文件监控自动 RCU 重载
      state.config_writer.save_models_yaml(&new_config).map_err(|e| e.to_string())
  }

  #[tauri::command]
  pub async fn probe_provider_models(
      provider_id: String,
      state: tauri::State<'_, AppState>,
  ) -> Result<MergeReport, String> {
      state.probe_service.probe_and_merge(&provider_id).await.map_err(|e| e.to_string())
  }
  ```

---

## 模块七：存量数据迁移与向后兼容保障方案

### 7.1 存量扁平 `models.yaml` 向树状 Schema 平滑迁移器

针对老用户磁盘中可能存在的一维扁平 `models.yaml`，编写确定性的自动转换与归类迁移器：

```rust
//! crates/conex-providers/src/migration.rs

use crate::models::{
    ModelSpec, ModalityMatrix, PricingSpec, ProtocolKind, ProviderSpec, ThinkingSpec,
    UnifiedModelsConfig,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use tracing::info;

/// 历史扁平结构定义
#[derive(Debug, Deserialize)]
struct LegacyFlatConfig {
    #[serde(default)]
    models: Vec<LegacyModelItem>,
}

#[derive(Debug, Deserialize)]
struct LegacyModelItem {
    id: String,
    name: Option<String>,
    vendor: Option<String>,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    reasoning: Option<bool>,
    input_price: Option<f64>,
    output_price: Option<f64>,
}

pub struct ConfigMigration;

impl ConfigMigration {
    /// 自动检测并迁移配置文件
    pub fn migrate_if_needed(path: &Path) -> Result<UnifiedModelsConfig, Box<dyn std::error::Error>> {
        let content = std::fs::read_to_string(path)?;

        // 先尝试以全新树状结构解析
        if let Ok(modern) = serde_yaml::from_str::<UnifiedModelsConfig>(&content) {
            if modern.schema_version >= 1 && !modern.providers.is_empty() {
                return Ok(modern);
            }
        }

        info!("检测到历史扁平版本 models.yaml，开始执行树状自动化迁移...");

        // 备份原文件
        let backup_path = path.with_extension(format!("yaml.bak.{}", chrono::Utc::now().timestamp()));
        std::fs::copy(path, &backup_path)?;
        info!("原历史配置文件已备份至: {:?}", backup_path);

        // 解析历史扁平结构
        let legacy: LegacyFlatConfig = serde_yaml::from_str(&content)?;
        let mut providers_map: BTreeMap<String, ProviderSpec> = BTreeMap::new();

        for item in legacy.models {
            let provider_id = item.vendor.clone().unwrap_or_else(|| "custom".to_string());
            let provider_entry = providers_map.entry(provider_id.clone()).or_insert_with(|| {
                ProviderSpec {
                    display_name: Self::infer_provider_display_name(&provider_id),
                    base_url: Self::infer_provider_base_url(&provider_id),
                    protocol: ProtocolKind::OpenAiChat,
                    api_key: None,
                    auth_header: true,
                    headers: BTreeMap::new(),
                    compat: None,
                    proxy_url: None,
                    enabled: true,
                    sort_order: 100,
                    models: Vec::new(),
                }
            });

            let model_spec = ModelSpec {
                id: item.id.clone(),
                display_name: item.name.unwrap_or_else(|| item.id.clone()),
                protocol: None,
                context_window: item.context_window.unwrap_or(128_000),
                max_output_tokens: item.max_tokens.unwrap_or(16_384),
                thinking: ThinkingSpec {
                    enabled: item.reasoning.unwrap_or(false),
                    mandatory: false,
                    default_level: "medium".to_string(),
                    levels: BTreeMap::new(),
                    token_budget: None,
                },
                modalities: ModalityMatrix::default(),
                pricing: if item.input_price.is_some() || item.output_price.is_some() {
                    Some(PricingSpec {
                        currency: "USD".to_string(),
                        unit: "per_1m_tokens".to_string(),
                        input: item.input_price.unwrap_or(0.0),
                        output: item.output_price.unwrap_or(0.0),
                        cache_read: None,
                        cache_write: None,
                    })
                } else {
                    None
                },
                sampling_params: BTreeMap::new(),
                headers: BTreeMap::new(),
                compat: None,
                enabled: true,
                is_probed: false,
            };

            provider_entry.models.push(model_spec);
        }

        let modern_config = UnifiedModelsConfig {
            schema_version: 1,
            providers: providers_map,
        };

        // 将新版本直接写回磁盘
        let migrated_yaml = serde_yaml::to_string(&modern_config)?;
        std::fs::write(path, migrated_yaml)?;
        info!("树状新版本 models.yaml 迁移并落盘成功！");

        Ok(modern_config)
    }

    fn infer_provider_display_name(vendor: &str) -> String {
        match vendor.to_lowercase().as_str() {
            "deepseek" => "DeepSeek 官方".to_string(),
            "openai" => "OpenAI 官方".to_string(),
            "anthropic" => "Anthropic Claude".to_string(),
            "qwen" | "aliyun" => "阿里云百炼 (Qwen)".to_string(),
            "zhipu" | "z-ai" => "智谱清言 (Z.AI)".to_string(),
            "google" => "Google AI Studio".to_string(),
            _ => format!("供应商 ({})", vendor),
        }
    }

    fn infer_provider_base_url(vendor: &str) -> String {
        match vendor.to_lowercase().as_str() {
            "deepseek" => "https://api.deepseek.com".to_string(),
            "openai" => "https://api.openai.com/v1".to_string(),
            "anthropic" => "https://api.anthropic.com".to_string(),
            "qwen" | "aliyun" => "https://dashscope.aliyuncs.com/compatible-mode/v1".to_string(),
            "zhipu" | "z-ai" => "https://open.bigmodel.cn/api/paas/v4".to_string(),
            "google" => "https://generativelanguage.googleapis.com/v1beta".to_string(),
            _ => "https://api.openai.com/v1".to_string(),
        }
    }
}
```

### 7.2 前端 LocalStorage / ProviderProfiles 凭据收口归一

在前端初始化脚本中，实现一次性的 LocalStorage 凭据收敛迁移：

```typescript
// apps/crish-desktop/src/migrations/migrateLegacyStorage.ts

import { invoke } from '@tauri-apps/api/core';
import type { UnifiedModelsConfig } from '@conex/shared/types/models';

export async function migrateLegacyLocalStorage(): Promise<void> {
  const LEGACY_STORAGE_KEY = 'crish_provider_profiles';
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return;

  try {
    const legacyProfiles = JSON.parse(raw);
    if (!Array.isArray(legacyProfiles) || legacyProfiles.length === 0) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      return;
    }

    console.info('[Migration] 检测到存量 LocalStorage ProviderProfiles，开始合并入后端真源...');
    const currentConfig = await invoke<UnifiedModelsConfig>('get_unified_models_config');

    let modified = false;
    for (const profile of legacyProfiles) {
      const pid = profile.id || profile.vendor;
      if (pid && currentConfig.providers[pid]) {
        // 将前端孤岛中的 apiKey 与 baseUrl 同步合并入 SSOT
        if (profile.apiKey && !currentConfig.providers[pid].apiKey) {
          currentConfig.providers[pid].apiKey = profile.apiKey;
          modified = true;
        }
        if (profile.baseUrl && currentConfig.providers[pid].baseUrl !== profile.baseUrl) {
          currentConfig.providers[pid].baseUrl = profile.baseUrl;
          modified = true;
        }
      }
    }

    if (modified) {
      await invoke('save_unified_models_config', { newConfig: currentConfig });
      console.info('[Migration] 存量凭据成功合并入 models.yaml 绝对真源！');
    }

    // 彻底清除历史孤岛键，消灭双轨存储！
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (err) {
    console.error('[Migration] 本地存储迁移失败，保留原数据以便排查:', err);
  }
}
```

### 7.3 双向版本兼容、自动备份与灾难恢复流程

1. **写前强制原子备份**：每次前端调用 `save_unified_models_config` 或探针合流前，系统自动在 `~/.conex/backups/` 下建立带毫秒时间戳的备份副本（保留最近 20 份），保证数据零丢失风险。
2. **格式损坏自动隔离（Safe Quarantine）**：若用户手动编辑 YAML 引入致命语法错误，内核在反序列化失败时**禁止覆写原文件**，而是输出详细的语法行号诊断信息，并在内存中继续维持上一次校验通过的 `RuntimeCatalog` 副本，前台弹出警告提示，阻止配置雪崩。

---

## 模块八：穷举式自动化测试用例集、魔鬼边界用例与验收断言矩阵

### 8.1 树状 Schema 往返序列化与反序列化测试集

```rust
//! crates/conex-providers/tests/schema_roundtrip_tests.rs

use conex_providers::models::{
    UnifiedModelsConfig, ProviderSpec, ModelSpec, ProtocolKind, ThinkingSpec, ModalityMatrix,
    PricingSpec, CompatConfig,
};
use std::collections::BTreeMap;

#[test]
fn test_full_schema_roundtrip_yaml_integrity() {
    let mut levels = BTreeMap::new();
    levels.insert("minimal".to_string(), Some("minimal".to_string()));
    levels.insert("medium".to_string(), Some("medium".to_string()));
    levels.insert("high".to_string(), Some("high".to_string()));
    levels.insert("off".to_string(), None); // 强制思考

    let mut sampling = BTreeMap::new();
    sampling.insert("temperature".to_string(), serde_json::json!(0.7));
    sampling.insert("top_p".to_string(), serde_json::json!(0.95));

    let model = ModelSpec {
        id: "deepseek-v4-flash".to_string(),
        display_name: "DeepSeek V4 Flash".to_string(),
        protocol: None, // 继承 Provider
        context_window: 1_048_576,
        max_output_tokens: 384_000,
        thinking: ThinkingSpec {
            enabled: true,
            mandatory: true,
            default_level: "medium".to_string(),
            levels,
            token_budget: None,
        },
        modalities: ModalityMatrix {
            input: vec!["text".to_string(), "image".to_string()],
            output: vec!["text".to_string()],
        },
        pricing: Some(PricingSpec {
            currency: "USD".to_string(),
            unit: "per_1m_tokens".to_string(),
            input: 0.44,
            output: 1.32,
            cache_read: Some(0.014),
            cache_write: None,
        }),
        sampling_params: sampling,
        headers: BTreeMap::new(),
        compat: Some(CompatConfig {
            thinking_format: Some("deepseek".to_string()),
            supports_developer_role: Some(false),
            max_tokens_field: Some("max_tokens".to_string()),
            ..Default::default()
        }),
        enabled: true,
        is_probed: false,
    };

    let mut providers = BTreeMap::new();
    providers.insert("deepseek".to_string(), ProviderSpec {
        display_name: "DeepSeek 官方".to_string(),
        base_url: "https://api.deepseek.com".to_string(),
        protocol: ProtocolKind::OpenAiChat,
        api_key: Some("vault://deepseek-master-key".to_string()),
        auth_header: true,
        headers: BTreeMap::new(),
        compat: None,
        proxy_url: None,
        enabled: true,
        sort_order: 1,
        models: vec![model],
    });

    let original = UnifiedModelsConfig {
        schema_version: 1,
        providers,
    };

    // 执行序列化与反序列化双向往返 (Round-trip)
    let yaml_str = serde_yaml::to_string(&original).expect("YAML 序列化必须成功");
    let deserialized: UnifiedModelsConfig = serde_yaml::from_str(&yaml_str).expect("YAML 反序列化必须成功");

    assert_eq!(original, deserialized, "反序列化对象必须与原结构 100% 深度等价");
    assert!(yaml_str.contains("deepseek-v4-flash"));
    assert!(yaml_str.contains("vault://deepseek-master-key"));
    assert!(yaml_str.contains("schemaVersion: 1"));
}
```

### 8.2 协议决议与方言路由边界用例集

```rust
//! crates/conex-providers/tests/protocol_resolution_tests.rs

use conex_providers::models::{ModelSpec, ProviderSpec, ProtocolKind, CompatConfig, ThinkingSpec, ModalityMatrix};
use conex_providers::resolution::resolve_call_context;
use std::collections::BTreeMap;

#[test]
fn test_protocol_inheritance_and_override() {
    let base_provider = ProviderSpec {
        display_name: "OpenAI 官方".to_string(),
        base_url: "https://api.openai.com/v1".to_string(),
        protocol: ProtocolKind::OpenAiChat, // 供应商默认 Chat
        api_key: None,
        auth_header: true,
        headers: BTreeMap::new(),
        compat: Some(CompatConfig {
            supports_developer_role: Some(true),
            max_tokens_field: Some("max_completion_tokens".to_string()),
            ..Default::default()
        }),
        proxy_url: None,
        enabled: true,
        sort_order: 1,
        models: vec![],
    };

    // 模型 1：未指定 protocol ➔ 必须继承 Provider 的 OpenAiChat
    let model_inherit = ModelSpec {
        id: "gpt-4o".to_string(),
        display_name: "GPT-4o".to_string(),
        protocol: None,
        context_window: 128000,
        max_output_tokens: 4096,
        thinking: ThinkingSpec::default(),
        modalities: ModalityMatrix::default(),
        pricing: None,
        sampling_params: BTreeMap::new(),
        headers: BTreeMap::new(),
        compat: None,
        enabled: true,
        is_probed: false,
    };

    let ctx1 = resolve_call_context(&base_provider, &model_inherit);
    assert_eq!(ctx1.protocol, ProtocolKind::OpenAiChat);
    assert_eq!(ctx1.compat.supports_developer_role, Some(true));

    // 模型 2：显式指定 OpenAiResponses ➔ 必须成功覆盖！
    let model_override = ModelSpec {
        id: "gpt-5.6-sol".to_string(),
        display_name: "GPT-5.6 Sol".to_string(),
        protocol: Some(ProtocolKind::OpenAiResponses), // 显式覆盖
        context_window: 1050000,
        max_output_tokens: 128000,
        thinking: ThinkingSpec::default(),
        modalities: ModalityMatrix::default(),
        pricing: None,
        sampling_params: BTreeMap::new(),
        headers: BTreeMap::new(),
        compat: Some(CompatConfig {
            supports_strict_mode: Some(true),
            ..Default::default()
        }),
        enabled: true,
        is_probed: false,
    };

    let ctx2 = resolve_call_context(&base_provider, &model_override);
    assert_eq!(ctx2.protocol, ProtocolKind::OpenAiResponses);
    assert_eq!(ctx2.compat.supports_developer_role, Some(true)); // 继承 Provider
    assert_eq!(ctx2.compat.supports_strict_mode, Some(true));    // 模型自增字段
}
```

### 8.3 凭据解析四级状态机与安全擦除用例集

```rust
//! crates/conex-storage/tests/credential_resolver_tests.rs

use conex_storage::credentials::{CredentialResolver, SecretString};

#[test]
fn test_credential_resolution_pipeline() {
    // 1. 测试明文字面量
    let lit = CredentialResolver::resolve("sk-literal-plain-key-12345", "test")
        .expect("字面量应当成功解析");
    assert_eq!(lit.expose_secret(), "sk-literal-plain-key-12345");

    // 2. 测试环境变量插值
    std::env::set_var("CONEX_TEST_API_KEY", "env-secret-8888");
    let env1 = CredentialResolver::resolve("$CONEX_TEST_API_KEY", "test")
        .expect("环境变量应当成功提取");
    assert_eq!(env1.expose_secret(), "env-secret-8888");

    let env2 = CredentialResolver::resolve("${CONEX_TEST_API_KEY}", "test")
        .expect("大括号环境变量应当成功提取");
    assert_eq!(env2.expose_secret(), "env-secret-8888");

    // 3. 测试转义字符
    let esc1 = CredentialResolver::resolve("$$literal-with-dollar", "test")
        .expect("$$ 必须转义为单一 $");
    assert_eq!(esc1.expose_secret(), "$literal-with-dollar");

    let esc2 = CredentialResolver::resolve("$!literal-with-bang", "test")
        .expect("$! 必须转义为单一 !");
    assert_eq!(esc2.expose_secret(), "!literal-with-bang");

    // 4. 测试外部脚本输出 (!echo ...)
    #[cfg(target_os = "windows")]
    let cmd_key = CredentialResolver::resolve("!Write-Output 'cli-secret-output'", "test")
        .expect("命令行执行提取成功");
    #[cfg(not(target_os = "windows"))]
    let cmd_key = CredentialResolver::resolve("!echo 'cli-secret-output'", "test")
        .expect("命令行执行提取成功");

    assert_eq!(cmd_key.expose_secret(), "cli-secret-output");
}
```

### 8.4 高频热重载并发无锁替换与会话保活断言集

```rust
//! crates/conex-providers/tests/hot_reload_concurrency_tests.rs

use conex_providers::catalog_manager::CatalogManager;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

#[test]
fn test_catalog_rcu_concurrency_and_session_pinning() {
    let temp_dir = tempfile::tempdir().expect("创建临时测试目录");
    let config_path = temp_dir.path().join("models.yaml");

    let manager = CatalogManager::new(config_path.clone())
        .expect("CatalogManager 初始化必须成功");

    // 模拟会话持有长周期旧快照引用
    let session_pinned_catalog = manager.get_catalog();
    let initial_ts = session_pinned_catalog.load_timestamp_ms;

    // 并发启动 10 个线程执行高频读取
    let mut read_handles = vec![];
    for _ in 0..10 {
        let m = Arc::clone(&manager);
        read_handles.push(thread::spawn(move || {
            for _ in 0..100 {
                let cat = m.get_catalog();
                assert!(cat.load_timestamp_ms >= initial_ts);
                thread::sleep(Duration::from_millis(1));
            }
        }));
    }

    // 主线程执行原子重新加载
    thread::sleep(Duration::from_millis(10));
    manager.reload().expect("强制重载应当成功");

    let updated_catalog = manager.get_catalog();
    assert!(
        updated_catalog.load_timestamp_ms > initial_ts,
        "重载后快照时间戳必须单调递增"
    );

    // 关键断言：会话先前持有的旧快照对象内容不可变，无野指针与数据竞争
    assert_eq!(
        session_pinned_catalog.load_timestamp_ms, initial_ts,
        "旧会话持有的快照必须保持生命周期隔离"
    );

    for h in read_handles {
        h.join().expect("读取线程不得崩溃");
    }
}
```

### 8.5 验收测试断言全景矩阵

| 测试维度 | 测试用例标识 (Test ID) | 关键断言条件 (Assertion) | 失败判定阈值 (Failure Criteria) |
| :--- | :--- | :--- | :--- |
| **拓扑结构** | `TC-TOPO-01` 树状序列化往返 | `UnifiedModelsConfig` 反序列化与原对象全等 | 任何字段在 round-trip 中发生丢失或类型漂移 |
| **协议决议** | `TC-PROT-01` 协议三层继承 | `Model.protocol` 未定义时 100% 继承 `Provider.protocol` | 回退至硬编码默认值而非 Provider 设定值 |
| **协议覆盖** | `TC-PROT-02` 模型级显式覆盖 | 模型声明 `openai/responses` 必须覆盖 Provider 的 `openai/chat` | 依旧发送 `/v1/chat/completions` 请求 |
| **方言适配** | `TC-DIAL-01` Developer 角色转换 | `supportsDeveloperRole: false` 时请求体无 `developer` 角色 | 发送 `developer` 角色被 DeepSeek 等网关报 400 |
| **思考方言** | `TC-DIAL-02` Qwen 布尔思考 | 百炼模型请求体顶层包含 `enable_thinking: true` | 错误发送 `reasoning_effort` 导致百炼拒绝请求 |
| **凭据求值** | `TC-CRED-01` DPAPI / Vault 读取 | `vault://key` 返回解密后的 `SecretString` | 读取失败或将 `vault://` 字面量裸传给服务端 |
| **凭据求值** | `TC-CRED-02` 脚本动态执行 | `!command` 正确捕获 stdout 并去除尾随换行 | 阻塞挂起或未捕获 stderr 报错 |
| **热重载** | `TC-RELOAD-01` 原子 RCU 指针替换 | 并发 10 线程高频读取下 CAS 替换，零崩溃零 Panic | 产生野指针、内存悬挂或读到半初始化的配置 |
| **探针合流** | `TC-MERGE-01` 三向合并元数据保护 | 用户手动修改的 `displayName`/`pricing` 在探针扫描后原封不动 | 探针扫描后用户自定义展示名或费率被覆写 |
| **存量迁移** | `TC-MIGR-01` 一维扁平平滑迁移 | 历史 `models.yaml` 自动重构为树状，备份 `yaml.bak.*` 落盘 | 迁移损坏原文件或直接报错拒绝启动 |

---

## 结论与交付总结

本方案作为 **【议题 A】Provider 拓扑结构、凭据生命周期与动态发现体系** 与 **【议题 B】AI 通信协议路由、请求方言与内核执行链条全线打通** 的核心架构详案，彻底穿透了当前 Conex 的四大架构毒点：
1. 以 **树状 `models.yaml`** 确立了跨系统、跨进程的唯一真源（SSOT），消灭了一维扁平倒置与前端双轨割裂；
2. 实现了 **四级凭据生命周期解析管道**，打通 OS 原生安全保管库（DPAPI / Keychain）与动态 CLI 脚本；
3. 彻底废除了编译期静态单例 `BUNDLED_CATALOG`，构建了纯配置驱动的 **多层协议决议与 11 大类方言矩阵**；
4. 依托 Rust 内核的 **ArcSwap 无锁 RCU 热重载引擎** 与 **探针三向智能合流算法**，保障了企业级 Agent 会话的高可用性与平滑演进。
