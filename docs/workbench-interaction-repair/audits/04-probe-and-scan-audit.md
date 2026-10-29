# 服务商连通性探活、自动获取模型扫描与免密端点支持源码级审计报告

> **审计专家**：服务商探针与网络扫描审计专家（Probe & Network Reviewer）  
> **审计提交**：`commit f6ae63f5ff5431128c31202eeadfccfb42f8e17f`（对比上一版本及工作区当前状态）  
> **战役工作区**：`docs/workbench-interaction-repair/`  
> **关联详案**：[`04-connectivity-probe-and-model-scan-plan.md`](../04-connectivity-probe-and-model-scan-plan.md) 与 [`00-workbench-interaction-repair-master-plan.md`](../00-workbench-interaction-repair-master-plan.md)  
> **审计日期**：2026-10-29  
> **审计结论**：**【不通过：存在致命免密执行断裂、i18n 全量脱靶与跨供应商数据污染（FAIL / REVISE REQUIRED）】**

---

## 一、审查目标与改动范围

本次审计严格针对桌面端工作台在模型供应商设置交互修复战役中的核心模块「WiFi 连通性测试（`runCheck`）、自动获取模型扫描（`runScan` / `ScanResultsModal`）以及免密端点（Ollama / vLLM / LocalAI）支持」进行深度源码级核查。

### 涉及审查的核心文件清单
1. **`apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts`**：连通测试（`runTest`）、扫描发现（`runScan`）、握手连通检查（`runCheck`）及结果确认同步（`confirmScannedModels`）动作状态机。
2. **`apps/crish-desktop/src/components/settings-models/useModelProfilesState.ts`**：供应商设置主 Hub 状态机，包含操作结果反馈管道 `notify`、失效订阅与本地变更标记。
3. **`apps/crish-desktop/src/components/settings-models/useModelProfilesState.test.tsx`**：前端 Toast 通知双向回执单元测试。
4. **`apps/agent-workbench/src-tauri/src/probe.rs`**：Rust 原生探针实现，包含模型对话探活 `probe_ping_core` 与端点扫描 `probe_scan_models_core`。
5. **`crates/agent-provider/src/model_store.rs`**：Rust 内核供应商配置解析引擎，负责快照锁定、`resolve_provider`、`resolve_model`（`resolve_in`）以及 DPAPI / 环境变量凭据检索。
6. **`crates/conex-run/src/engine_provider/headers.rs`**：运行时实际发起 HTTP 对话/流式请求时的请求头组装引擎。
7. **`apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx`**：厂商名称校验、Base URL 与协议表单变更落盘。
8. **`apps/crish-desktop/src/components/settings-models/ScanResultsModal.tsx`** 与 **`ModelConfigEditor.tsx`**：模型多选同步浮层联动及其生命周期控制。
9. **`apps/crish-desktop/src/i18n/locales/{zh-CN,en-US}/settingsModels.ts`** 与 **`apps/crish-desktop/src/i18n/`**：中英文国际化词典注册与键值解析机制。
10. **`docs/workbench-interaction-repair/04-connectivity-probe-and-model-scan-plan.md`**：本次改动的设计详案与验收基准。

---

## 二、核心审查结论总表（Scorecard & Executive Summary）

### 1. 核心维度评审概览

| 审查维度 | 评级 | 结论核心摘要 |
| :--- | :---: | :--- |
| **1. 探活分级降级逻辑** | **MAJOR DEFECT** | `runCheck` 在无模型时降级为 `providerProbeScanModels` 探测 `/models`，确实打破了无模型时的“首项强绑死锁”；但**对于不提供 `/models` 端点的非标代理（如仅中转 `/chat/completions` 的私有网关或 Azure OpenAI 部署），握手必然 404/405 报死**，且空模型返回时误报“连通检查失败”，缺乏对非标代理的指引与容错。 |
| **2. 免密请求头与凭据链** | **CRITICAL BLOCKER** | **【致命伪通】** 虽然 `probe.rs:probe_scan_models_core` 和 `model_store.rs:resolve_provider` 支持了无密请求，但 **`model_store.rs:resolve_in`（`resolve_model`）依然硬编码校验凭据必填**！一旦用户通过扫描添加了本地免密模型，再次点击 WiFi 或进入会话对话时，系统立即以 `CREDENTIAL_MISSING` 阻断崩溃；同时 `conex-run/headers.rs` 依然硬编码发出畸形 `Authorization: Bearer ` 头。 |
| **3. 反馈与通知及 i18n 机制** | **CRITICAL BLOCKER** | **【严重破损】** `notify` 解除 `if (ok) return;` 虽恢复了显式反馈，但 **commit 中新增的所有 i18n key 全部丢弃了 `settings.` 顶级命名空间**（误写为 `t('models.probe.*')`），在 `I18nContext` 中 100% 无法命中词典，导致生产环境下向用户裸露 `"Handshake Ok"`、`"Check Failed"` 等回退畸形文案，参数 `{error}` 插值彻底丢失；高频点击时因动态毫秒数绕过去重引发 Toast 堆叠。 |
| **4. 模型扫描弹窗联动与生命周期** | **MAJOR DEFECT** | **【数据越界污染】** `scannedModelsList` 与 `confirmScannedModels` 未锁定扫描源的 `providerId`，当扫描在后台进行时若用户在左侧切换了服务商，弹窗确认后会将服务商 A 的模型**错误追加写入服务商 B**；异步 IPC 缺乏组件挂载标志（`isMountedRef`），在设置 Tab 切换卸载后引发无主状态更新与全局 Toast 幽灵弹出。 |

### 2. 缺陷分级统计

- **【Critical 致命阻断】**：2 项
  1. `model_store.rs:resolve_in`（`resolve_model`）残留 `CREDENTIAL_MISSING` 硬拦截，导致免密服务商添加模型后对话探活与会话对话 100% 崩溃（§三.2.1）
  2. i18n 顶层 `settings.` 命名空间前缀在调用方全量脱靶，导致生产环境界面文案畸形回退、中文丢失与插值损坏（§三.3.1）
- **【Major 架构/功能缺陷】**：3 项
  1. 探活降级强绑定 `/models`，导致不支持该端点的非标代理网关连通性检查误报失败（§三.1.1）
  2. 扫描确认未捕获快照供应商 ID，导致并发切换服务商时发生跨供应商模型数据污染（§三.4.1）
  3. 运行时实际请求头与探活逻辑割裂，`HttpProviderCall` 仍向免密服务商发送 `Authorization: Bearer ` 畸形头（§三.2.2）
- **【Minor 边界/体验隐患】**：3 项
  1. 异步探针缺乏组件卸载保护与取消机制，导致卸载后后台静默触发全局 Toast 泄露（§三.4.2）
  2. `runCheck` 缺乏状态锁与入参重入防御，高频双击 WiFi 图标因延迟文案差异绕过去重造成 Toast 连续推入（§三.3.2）
  3. Ollama 默认根 URL `http://127.0.0.1:11434` 缺乏自动 `/v1` 适配，直接触发 404 导致扫描探活失败（§三.1.2）
- **【Suggestion 优化建议】**：1 项
  1. Plan 04 规划的 `useModelProviderActions.test.ts` 契约单测未实际落地，导致 i18n 键名错误逃逸至主分支（§三.3.3）
- **【Positive 架构肯定项】**：2 项
  1. 移除 `useModelProfilesState.ts` 中的 `if (ok) return;` 阻断，成功与失败双轨接入 Toast 系统，打通了正向回执（§三.3.4）
  2. `probe.rs:parse_scanned_models` 兼容 OpenAI、Gemini、Anthropic 及裸数组四种模型数据结构，鲁棒性良好（§三.1.3）

---

## 三、四大核心审查维度源码级深度实证分析

### 维度 1：探活分级降级逻辑与非标 OpenAI 网关适配

#### 1.1 降级依赖 `/models` 引发非标网关误报失败【Major】
- **源码定位**：
  - 前端调度：[`apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts:117-137`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts#L117-L137)
  - 后端端点：[`apps/agent-workbench/src-tauri/src/probe.rs:319-335, 381-395, 408-415`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/probe.rs#L319-L335)
- **代码实证**：
  在 `useModelProviderActions.ts` 中：
  ```ts
  // useModelProviderActions.ts:117-137
  if (firstModel) {
    const r = await testProviderModel(fresh, firstModel);
    ...
  } else {
    // 无模型：自动降级为调用 /models 握手探活端点（验证 Base URL 与 Key 有效性），打破死锁
    const r = await providerProbeScanModels(fresh.id);
    if (r.status === 'ok' && r.data.ok) {
      notify(true, t('models.probe.handshakeOk'));
    } else {
      const err =
        r.status === 'error'
          ? r.message
          : (r.status === 'ok' && r.data.error) || 'Failed';
      notify(false, t('models.probe.checkFailed', { error: err }));
    }
  }
  ```
  在 `probe.rs:408-415` 中：
  ```rust
  let scanned_entries = parse_scanned_models(&body, profile_id);
  if scanned_entries.is_empty() {
      return ProbeScanResult {
          ok: false,
          models: vec![],
          error: Some("未从服务端发现任何可用模型".to_string()),
      };
  }
  ```
- **真实场景逻辑穿透**：
  1. **私有转发网关场景**：业界大量反向代理、云函数（Cloudflare Worker）、公司内部网关仅转发核心的 `POST /chat/completions` 请求，并没有实现 `GET /models` 端点，对该端点返回 `HTTP 404 Not Found`、`405 Method Not Allowed` 或 `501 Not Implemented`。
  2. 当用户新增此类供应商且尚未添加模型时，点击 WiFi 图标，`runCheck` 自动调用 `providerProbeScanModels`。
  3. 后端 `probe.rs:390` 捕获到 404 状态码，直接包装为 `ProbeScanResult { ok: false, error: Some("扫描接口返回错误 HTTP 404: ...") }`。
  4. 前端直接向用户弹窗报错：`连通检查失败：扫描接口返回错误 HTTP 404`。
  5. **空模型合法响应误判**：若网关返回合法的空模型列表（如 `{"data": []}`），`probe.rs:409` 判定 `scanned_entries.is_empty()`，直接宣判 `ok: false, error: "未从服务端发现任何可用模型"`。
  6. **用户体验断裂**：用户检查的是“服务商网络与密钥是否连通”，结果因为服务商不提供模型扫描接口，被系统判定为“连通失败”，产生严重的误导。
- **改进建议**：
  在 `runCheck` 的无模型降级分支中，若 `providerProbeScanModels` 报错为 404/405 或“未发现可用模型”，UI 应在错误提示中进行友好引导，明确提示：“端点不支持自动模型发现，请点击下方手动添加模型后再次测试”。

#### 1.2 本地 Ollama 根路径 `http://127.0.0.1:11434` 缺乏规范化导致 404【Minor】
- **源码定位**：
  - URL 拼装纯函数：[`crates/agent-provider/src/request/wire_protocol.rs:188-199`](file:///c:/Software/conex/crates/agent-provider/src/request/wire_protocol.rs#L188-L199)
  - 探针端点解析：[`apps/agent-workbench/src-tauri/src/probe.rs:320-325`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/probe.rs#L320-L325)
- **代码实证**：
  在 `wire_protocol.rs` 中：
  ```rust
  ProtocolKind::OpenAiChat => {
      if trimmed_base.ends_with("/chat/completions") {
          trimmed_base.to_string()
      } else if trimmed_base.ends_with("/v1") {
          format!("{trimmed_base}/chat/completions")
      } else if trimmed_base.contains("sensenova.cn") || trimmed_base.ends_with("openai.com") {
          format!("{trimmed_base}/v1/chat/completions")
      } else {
          format!("{trimmed_base}/chat/completions")
      }
  }
  ```
  在 `probe.rs` 中：
  ```rust
  let url = match config.provider.protocol {
      ProtocolKind::OpenAiChat => format!(
          "{}/models",
          endpoint.strip_suffix("/chat/completions").unwrap_or(&endpoint)
      ),
      ...
  };
  ```
- **逻辑穿透**：
  Plan 04 文档 §一.2 与 §二.3 明确声称要支持 `http://localhost:11434` 本地 Ollama。但当用户输入 `http://127.0.0.1:11434`（未带 `/v1`）时：
  1. `build_endpoint_url` 走入 `else` 分支，生成 `http://127.0.0.1:11434/chat/completions`。
  2. `probe.rs` 去除后缀拼装 `/models`，生成 `http://127.0.0.1:11434/models`。
  3. **实际网络表现**：Ollama 官方服务器中，原生 API 位于 `/api/tags`，OpenAI 兼容层**严格前缀在 `/v1`**（即 `/v1/models` 和 `/v1/chat/completions`）。请求 `http://127.0.0.1:11434/models` 将直接返回 `404 page not found`！
  4. 导致用户按照常规理解填写 Ollama 默认地址时，探活扫描 100% 报错 404。用户必须手动输入 `http://127.0.0.1:11434/v1` 才能跑通。

---

### 维度 2：免密请求头适配与内核凭据链一致性

#### 2.1 `resolve_in` 硬校验凭据必填导致免密服务商添加模型后全链路死锁【Critical Blocker】
- **源码定位**：
  - 免密放行修改（供应商解析）：[`crates/agent-provider/src/model_store.rs:382-385`](file:///c:/Software/conex/crates/agent-provider/src/model_store.rs#L382-L385)
  - 遗留致命断层（模型解析）：[`crates/agent-provider/src/model_store.rs:421-423`](file:///c:/Software/conex/crates/agent-provider/src/model_store.rs#L421-L423)
  - 探活入口：[`apps/agent-workbench/src-tauri/src/probe.rs:180-184`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/probe.rs#L180-L184)
  - 引擎会话入口：[`crates/conex-run/src/engine_handle.rs:248-255`](file:///c:/Software/conex/crates/conex-run/src/engine_handle.rs#L248-L255)
- **代码实证与对比**：
  在 commit `f6ae63f5f` 中，开发者修改了 `model_store.rs` 的 `resolve_provider`：
  ```rust
  // model_store.rs:382-385（已修改）
  let key = self
      .key_for(provider)?
      .unwrap_or_default(); // <-- 这里放宽了免密供应商，允许空凭据
  Ok(ResolvedProviderConfig { ... })
  ```
  **但是，在同一个文件中，负责模型级解析的 `resolve_in` 却完全被遗漏了**：
  ```rust
  // model_store.rs:421-423（未修改！致命断层！）
  let key = self.key_for(provider)?.ok_or_else(|| {
      ModelsStoreError::new("CREDENTIAL_MISSING", "供应商尚未配置有效凭据引用")
  })?;
  Ok(ResolvedModelConfig {
      revision: snapshot.revision.clone(),
      model_ref: reference,
      provider: provider.clone(),
      model: model.clone(),
      api_key: Arc::new(key),
  })
  ```
- **复现与破坏链条**：
  1. 用户配置本地免密服务商（例如 Ollama，未填写 API Key，`provider.api_key_ref` 为 `None`）。
  2. **第一步（无模型时）**：点击 WiFi 检查，走 `runCheck` 的无模型分支，调用 `providerProbeScanModels` -> `store.resolve_provider(&id)`。因为第 384 行用了 `.unwrap_or_default()`，返回空密钥，成功连接 Ollama，提示握手正常。
  3. **第二步**：用户点击“自动获取”添加了模型（例如 `llama3:latest`）。
  4. **第三步（有模型时再次检查）**：用户再次点击 WiFi 检查。此时 `firstModel = 'llama3:latest'`，走 `runCheck` 的 `if (firstModel)` 分支，调用 `testProviderModel(fresh, 'llama3:latest')`。
  5. 前端发起 Tauri 命令 `provider_probe_ping`，后端调用 `probe.rs:probe_ping_core`（第 180 行）：
     `store.resolve_model(&reference)` -> 进入 `resolve_in`。
  6. 执行到 `model_store.rs:421`：
     `self.key_for(provider)?` 返回 `Ok(None)`，命中 `.ok_or_else(...)`，**直接抛出 `CREDENTIAL_MISSING: 供应商尚未配置有效凭据引用`**！
  7. 前端 WiFi 按钮瞬间变成红字报错：`连通检查失败：供应商尚未配置有效凭据引用`！
  8. **会话对话崩溃**：用户前往聊天界面，选择该本地模型发送消息，`engine_handle.rs:250` 调用 `store.resolve_model`，同样抛出 `CREDENTIAL_MISSING`，用户完全无法向本地免密模型发送任何消息！
- **定级理由**：**【Critical 致命阻断】**。免密支持只做了半截（只修改了扫描服务商的 `resolve_provider`，遗漏了核心的 `resolve_model` / `resolve_in`），导致免密服务商“只能看模型列表，一旦选定模型，探活和对话全部报错死锁”，属于致命架构缺陷。

#### 2.2 运行时请求头未对齐免密策略，盲目附带 `Authorization: Bearer `【Major】
- **源码定位**：
  - 扫描探针（已适配）：[`apps/agent-workbench/src-tauri/src/probe.rs:354-360`](file:///c:/Software/conex/apps/agent-workbench/src-tauri/src/probe.rs#L354-L360)
  - 运行时请求头（未适配）：[`crates/conex-run/src/engine_provider/headers.rs:61-65`](file:///c:/Software/conex/crates/conex-run/src/engine_provider/headers.rs#L61-L65)
- **代码实证**：
  在 `probe.rs` 的模型扫描中，代码做了安全检查：
  ```rust
  // probe.rs:354-360
  ProtocolKind::OpenAiChat | ProtocolKind::OpenAiResponses => {
      let mut b = client.get(url);
      if !api_key.trim().is_empty() {
          b = b.header(AUTHORIZATION, format!("Bearer {api_key}"));
      }
      b
  }
  ```
  但在实际进行流式推理与探活对话的 `conex-run/headers.rs` 中：
  ```rust
  // crates/conex-run/src/engine_provider/headers.rs:61-65
  WireProtocol::Chat | WireProtocol::Responses => {
      let mut headers = vec![(
          "Authorization".to_string(),
          format!("Bearer {}", config.api_key), // 未判空！无密时发出 "Bearer "
      )];
  ```
- **逻辑穿透**：
  当 `config.api_key` 为空字符串时，`headers.rs` 向服务端发送了带有空 Token 的畸形头部 `Authorization: Bearer `。
  对于部分严格遵循 RFC 6750 规范的本地网关、反向代理（如 Nginx、Traefik、Envoy 或配备鉴权插件的 vLLM），携带无有效 Token 的 Bearer 头部会直接被反向代理拦截并返回 `400 Bad Request` 或 `401 Unauthorized`，破坏了免密请求的纯净性。

---

### 维度 3：反馈与通知机制及 i18n 命名空间脱节

#### 3.1 i18n 调用全量缺失 `settings.` 顶级命名空间导致文案脱靶【Critical Blocker】
- **源码定位**：
  - 调用点：[`apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts:129, 135`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts#L129-L135)
  - 调用点：[`apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx:97, 109`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx#L97-L109)
  - 字典定义：[`apps/crish-desktop/src/i18n/locales/zh-CN/settingsModels.ts:61-67`](file:///c:/Software/conex/apps/crish-desktop/src/i18n/locales/zh-CN/settingsModels.ts#L61-L67)
  - 字典聚合：[`apps/crish-desktop/src/i18n/locales/zh-CN/settings.ts:318`](file:///c:/Software/conex/apps/crish-desktop/src/i18n/locales/zh-CN/settings.ts#L318)
  - 字典导出：[`apps/crish-desktop/src/i18n/locales/zh-CN/index.ts:15-29`](file:///c:/Software/conex/apps/crish-desktop/src/i18n/locales/zh-CN/index.ts#L15-L29)
  - 键值解析器：[`apps/crish-desktop/src/i18n/I18nContext.tsx:86-121, 280-318`](file:///c:/Software/conex/apps/crish-desktop/src/i18n/I18nContext.tsx#L86-L121)
- **代码实证与调用链穿透**：
  1. 在 `apps/crish-desktop/src/i18n/locales/zh-CN/index.ts` 中，顶层字典挂载的命名空间仅包含：
     ```ts
     export const zhCN: I18nDictionary = {
       common, nav, chat, workspace, settings, about, error, action, sidebar, tool, cluster, units, extensions
     };
     ```
     **根本没有名为 `models` 的顶级命名空间**！
  2. `settingsModels.ts` 中的词条是通过 spread 操作符展开并入 `settings` 命名空间中的（[`settings.ts:318`](file:///c:/Software/conex/apps/crish-desktop/src/i18n/locales/zh-CN/settings.ts#L318)：`...settingsPartModels`）。
  3. 因此，在字典内部，该词条的完整访问路径为：
     `dict['settings']['models.probe.handshakeOk']`。
  4. 其他正常调用的组件均规范地携带 `settings.` 前缀（例如 [`ModelsYamlConfigMenu.tsx:123`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsYamlConfigMenu.tsx#L123)：`t('settings.models.yaml.pathCopied')`）。
  5. 然而，在 commit `f6ae63f5f` 中，开发者在 `useModelProviderActions.ts` 与 `ProviderProfileForm.tsx` 中直接调用了：
     - `t('models.probe.handshakeOk')`
     - `t('models.probe.checkFailed', { error: err })`
     - `t('models.probe.vendorNameEmpty')`
     - `t('models.probe.vendorNameSaveFailed')`
  6. **I18nContext 解析过程穿透**（[`I18nContext.tsx:105-121`](file:///c:/Software/conex/apps/crish-desktop/src/i18n/I18nContext.tsx#L105-L121)）：
     - 解析器以首个点号分割：`ns = 'models'`, `subKey = 'probe.handshakeOk'`。
     - 检查 `rawDict['models']`：由于字典根上只有 `settings` 没有 `models`，查找直接失败，返回 `undefined`！
     - 触发 Level 4 降级（生产环境）：执行 `humanizeKeyFallback('models.probe.handshakeOk')`，将键名格式化为英文单词：
       `"Handshake Ok"`！
- **实际破坏后果**：
  - 用户界面无论在中文还是英文环境下，**永远无法展示中文文案**“服务商握手正常（已验证服务地址与凭据有效...）”。
  - 用户看到的不是国际化文本，而是畸形的 `"Handshake Ok"` 或 `"models.probe.handshakeOk"`！
  - 失败时调用 `t('models.probe.checkFailed', { error: err })`，因为没有匹配到模板，参数 `{error}` 被直接丢弃，向用户显示的居然是 `"Check Failed"`，**网络失败的具体错误信息被完全吃掉**！
- **定级理由**：**【Critical 致命阻断】**。直接破坏了本次改动主打的“中英双语 Toast 回执”功能，导致生产环境向用户显示畸形英文字符串且丢失错误细节。

#### 3.2 缺乏并发互斥锁导致高频点击 WiFi 产生 Toast 堆叠【Minor】
- **源码定位**：
  - 前端调度：[`apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts:109-114`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts#L109-L114)
  - 队列去重：[`apps/crish-desktop/src/hooks/toastQueueLogic.ts:423-446`](file:///c:/Software/conex/apps/crish-desktop/src/hooks/toastQueueLogic.ts#L423-L446)
- **代码实证**：
  在 `useModelProviderActions.ts` 中：
  ```ts
  const runCheck = useCallback(async () => {
    if (!selected) return;
    setCheckBusy(true); // 仅在 React 状态中置位，未在函数入口做 checkBusy 防御
    try { ... }
  ```
- **逻辑穿透**：
  1. `runCheck` 回调未将 `checkBusy` 放入依赖项，也未在入口检查 `if (checkBusy) return;` 或使用 `checkBusyRef`。
  2. 虽然 UI 上按钮设置了 `disabled={checkBusy}`，但 React 状态更新是异步的，用户在毫秒级快速双击或通过键盘 Space/Enter 连续触发时，两个 `runCheck` 异步任务并发发出。
  3. 两次探活请求先后返回，由于网络往返延迟具有随机性（例如第一次返回 `112ms`，第二次返回 `135ms`）。
  4. 产生的 Toast 文案为 `服务商连通正常 (112ms)` 与 `服务商连通正常 (135ms)`。
  5. 因为文案字符串不完全相同，`toastQueueLogic.ts` 的 `dupeIdx` 去重失效，两次通知全部入队并推向屏幕，产生视觉上的 Toast 连续堆叠闪烁。

#### 3.3 Plan 04 规划的单元测试缺失【Suggestion】
- **实证对比**：
  在详案 [`docs/workbench-interaction-repair/04-connectivity-probe-and-model-scan-plan.md:454-525`](file:///c:/Software/conex/docs/workbench-interaction-repair/04-connectivity-probe-and-model-scan-plan.md#L454-L525) 中，清晰规划了针对 `useModelProviderActions.ts` 的双分支测试用例（有模型调用 `testProviderModel`，无模型降级调用 `providerProbeScanModels`）。
  但检索代码仓库发现，**该单测文件根本未提交**（仅在 `useModelProfilesState.test.tsx` 中简单断言了 raw string 的 `notify`）。如果当时按计划落地了该单测，`t('models.probe.handshakeOk')` 必然无法匹配到预期文案，上述 i18n 致命缺陷即可在提交前被即刻拦截。

#### 3.4 架构肯定项：成功态显式 Toast 回执通道打通【Positive】
- 过去在 `useModelProfilesState.ts:156` 中存在 `if (ok) return;`，导致密钥保存成功、模型扫描同步成功等所有正常交互均无任何视觉反馈，用户误以为程序假死。
- 本次改动彻底废除 `if (ok) return;`，将 `notify` 改造为 `toast.show(msg, undefined, { type: ok ? 'success' : 'error' })`，且在 `toastQueueLogic.ts:411` 中放行显式带有 `{ type: 'success' }` 的通知，打通了正向回执通路。

---

### 维度 4：模型扫描弹窗联动与生命周期安全

#### 4.1 扫描确认未捕获快照供应商 ID，导致跨服务商模型数据污染【Major】
- **源码定位**：
  - 扫描触发与确认：[`apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts:58-107`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts#L58-L107)
  - 选中项切换清理：[`apps/crish-desktop/src/components/settings-models/useModelProfilesState.ts:216-227`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/useModelProfilesState.ts#L216-L227)
  - 弹窗绑定：[`apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx:224-231`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx#L224-L231)
- **代码实证**：
  在 `useModelProviderActions.ts` 中：
  ```ts
  // useModelProviderActions.ts:78-107
  const confirmScannedModels = useCallback(
    (selectedModels: string[]) => {
      if (!selected) return;
      void runAsLocalMutation(async () => {
        try {
          const shell = await ensureProviderShell({
            providerId: selected.id, // <-- 直接读取当前闭包内最新选中的 selected.id！
            ...
          });
          const result = await modelsCatalogStore.probeAndAppendModels(
            selected.id,            // <-- 写入当前 selected.id！
            selectedModels
          );
  ```
  在 `useModelProfilesState.ts:216-227` 中：
  ```ts
  if (selectedIdentity) {
    setKeyDraft('');
    setModelFilter('');
    setConfigOpenId(null);
    setCfgDraft(null);
    setManualOpen(false);
    setAddDraft(emptyAddDraft());
    setEditingName(false);
    setNameDraft('');
    setConfirmDeleteId(null);
    // 遗漏：完全没有重置 scanModalOpen(false) 和 setScannedModelsList([])！
  }
  ```
- **复现与破坏链条**：
  1. 用户在“服务商 A”（例如 OpenAI）点击“自动获取”。
  2. 后端执行扫描需要 1~3 秒网络 I/O。
  3. 在等待期间，用户在左侧切换到了“服务商 B”（例如 Anthropic 或 Ollama），`selected` 切换为服务商 B。
  4. 服务商 A 的扫描完成，`setScannedModelsList` 存入 OpenAI 的模型列表（`gpt-4o`, `o1` 等），并触发 `setScanModalOpen(true)`。
  5. 弹窗弹出，用户勾选了 `gpt-4o` 并点击“同步所选”。
  6. `confirmScannedModels` 执行，读取当前的 `selected.id`（此时已经是服务商 B！）。
  7. **数据污染发生**：系统将服务商 A 的模型追加写进了服务商 B 的 `models.yaml` 配置中！
  8. 导致服务商 B 混入无法使用的异构模型，造成模型配置混乱。

#### 4.2 异步探针缺乏组件卸载保护与取消机制【Minor】
- **源码定位**：
  [`apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts:36-76, 109-143`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts#L36-L76)
- **代码实证**：
  `runTest`、`runScan` 和 `runCheck` 均为带有长网络超时的异步函数（超时最高 15 秒）。
  函数内部未持存 `isMountedRef`，也未接入 `AbortController`。
- **逻辑穿透**：
  1. 用户点击“检查连通性”或“自动获取”。
  2. 用户随后切换了设置界面的左侧主导航（例如从“模型”切换到“外观”或“通用”），`ModelsSettingsTab` 组件随之卸载。
  3. 几秒后后台网络请求完成，已卸载组件的 Hook 闭包仍然调用：
     `setCheckBusy(false)`、`setScanModalOpen(true)` 以及 `notify(...)`。
  4. 虽然 React 18 移除了针对卸载组件 `setState` 的控制台警告，但全局单例的 `toast.show` 会被无条件触发。
  5. 用户在“外观设置”界面突然被弹出一个“服务商握手正常”或“未发现可用模型”的红绿色浮层，严重干扰交互连续性。

---

## 四、边界用例与非标环境魔鬼测试矩阵

为确保后续整改不留死角，针对本次审查的 4 个核心维度，梳理如下非标环境魔鬼测试矩阵：

| 用例编号 | 边界与极端场景描述 | 输入条件 / 模拟配置 | 当前版本物理表现 | 架构合规预期目标 |
| :---: | :--- | :--- | :--- | :--- |
| **TC-01** | **本地免密服务商添加模型后对话** | Ollama 本地运行，未配 API Key，已扫描添加 `llama3` | 再次点 WiFi 报 `CREDENTIAL_MISSING`，聊天发送消息 100% 崩溃 | `resolve_in` 优雅放行，无密对话探活与推理正常执行 |
| **TC-02** | **非标代理网关（无 `/models`）** | 自定义 Base URL，仅支持 `/chat/completions`，`/models` 返 404 | 点 WiFi 弹红字 `连通检查失败：HTTP 404` | 识别 404 并提示引导：“端点未支持模型发现，请手动添加模型测试” |
| **TC-03** | **Ollama 根地址直连** | Base URL 填写 `http://127.0.0.1:11434`（未带 `/v1`） | 扫描直接命中 `404 page not found` | 端点拼装识别 Ollama 模式自动追加 `/v1`，或前端校验自动纠错补全 |
| **TC-04** | **i18n 生产环境文案完整性** | 任意无模型供应商，点击 WiFi 探活成功 | 弹出英文回退文案 `"Handshake Ok"` | 弹出完整中文文案：“服务商握手正常（已验证服务地址与凭据有效...）” |
| **TC-05** | **i18n 失败错误插值完整性** | 填写错误 Base URL，点击 WiFi 探活失败 | 弹出英文回退 `"Check Failed"`，错误详情丢失 | 弹出中文并插值错误原因：“连通检查失败：无法连接到服务端...” |
| **TC-06** | **后台扫描中切换供应商** | 供应商 A 点击自动获取，网络延迟 2 秒内切换至供应商 B | 弹窗展示 A 模型，点击确认后模型写入了供应商 B | 切换供应商时强行关闭弹窗并废弃旧请求，或锁定扫描来源 ID 写入原供应商 |
| **TC-07** | **WiFi 按钮高频双击** | 100ms 内对 WiFi 图标连续点击两次 | 发起两个网络请求，返回两次不同延迟，产生两个叠层 Toast | 入口加状态锁或防抖，第二次点击被静默拦截，单次回执 |
| **TC-08** | **发起探活后切 Tab 卸载** | 点击 WiFi 探活后立即切换至“通用设置” Tab | 探针返回后在通用设置页突然弹出连通性 Toast | 组件卸载时标记失效，已卸载组件的异步回调不再触发全局通知 |

---

## 五、整改行动指南与代码级修复方案（Remediation Roadmap）

针对本次审计揭露的 2 项致命阻断与 3 项主要缺陷，提出如下精准修复实施步骤：

### 1. 修复内核模型凭据解析：彻底打通免密模型探活与运行时（修复 §三.2.1）
在 `crates/agent-provider/src/model_store.rs:421-423` 的 `resolve_in` 中，同步解除凭据强校验：
```rust
// 修改 crates/agent-provider/src/model_store.rs
-        let key = self.key_for(provider)?.ok_or_else(|| {
-            ModelsStoreError::new("CREDENTIAL_MISSING", "供应商尚未配置有效凭据引用")
-        })?;
+        let key = self
+            .key_for(provider)?
+            .unwrap_or_default();
```

### 2. 补全 i18n 顶层 `settings.` 命名空间前缀（修复 §三.3.1）
在前端调用点增加 `settings.` 命名空间：
```typescript
// 1. 修改 apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts
-        notify(true, t('models.probe.handshakeOk'));
+        notify(true, t('settings.models.probe.handshakeOk'));
...
-        notify(false, t('models.probe.checkFailed', { error: err }));
+        notify(false, t('settings.models.probe.checkFailed', { error: err }));

// 2. 修改 apps/crish-desktop/src/components/settings-models/ProviderProfileForm.tsx
-      notify(false, t('models.probe.vendorNameEmpty'));
+      notify(false, t('settings.models.probe.vendorNameEmpty'));
...
-            notify(false, res.error || t('models.probe.vendorNameSaveFailed'));
+            notify(false, res.error || t('settings.models.probe.vendorNameSaveFailed'));
```

### 3. 锁定扫描结果所属供应商 ID，阻断跨供应商模型污染（修复 §三.4.1）
在 `useModelProviderActions.ts` 中维护 `scannedProviderId` 状态：
```typescript
// 修改 apps/crish-desktop/src/components/settings-models/useModelProviderActions.ts
  const [scannedProviderId, setScannedProviderId] = useState<string | null>(null);

  const runScan = useCallback(async () => {
    if (!selected) return;
    const targetProviderId = selected.id;
    setScanBusy(true);
    try {
      const fresh = loadProfiles().find((p) => p.id === targetProviderId) || selected;
      const r = await scanProviderModels(fresh);
      if (r.ok && r.models?.length) {
        setScannedProviderId(targetProviderId);
        setScannedModelsList(r.models);
        setScanModalOpen(true);
      } else {
        notify(false, r.error || '未能检测到服务器可用模型');
      }
    } finally {
      setScanBusy(false);
    }
  }, [selected, notify]);

  const confirmScannedModels = useCallback(
    (selectedModels: string[]) => {
      const targetId = scannedProviderId;
      if (!targetId) return;
      void runAsLocalMutation(async () => {
        ...
        await modelsCatalogStore.probeAndAppendModels(targetId, selectedModels);
      });
    },
    [scannedProviderId, runAsLocalMutation, notify]
  );
```
并在 `useModelProfilesState.ts:216` 切换 `selectedIdentity` 时显式调用 `setScanModalOpen(false)`。

### 4. 运行时请求头判空免密保护（修复 §三.2.2）
在 `crates/conex-run/src/engine_provider/headers.rs:61-65` 中判断 `config.api_key`：
```rust
// 修改 crates/conex-run/src/engine_provider/headers.rs
WireProtocol::Chat | WireProtocol::Responses => {
    let mut headers = Vec::new();
    if !config.api_key.trim().is_empty() {
        headers.push((
            "Authorization".to_string(),
            format!("Bearer {}", config.api_key),
        ));
    }
```

### 5. 补充单测用例守护（修复 §三.3.3）
新建 `apps/crish-desktop/src/components/settings-models/useModelProviderActions.test.ts`，落地 Plan 04 规划的有模型/无模型/免密降级完整测试，重点断言 i18n 生成的真实文案字符串。

---

## 六、审计结论总结

综上所述，commit `f6ae63f5f` 虽然成功消除了“无模型时 WiFi 检查强绑首项模型报错”的初级死锁，并恢复了操作成功的 Toast 回执显示，但在底层实现上留下了**两大致命阻断隐患（内核模型解析断绝免密对话、i18n 顶层命名空间丢失导致全量文案脱靶）**与**一大严重数据污染漏洞（异步扫描弹窗串台污染）**。

必须立即按照第五章的整改方案实施闭环修复，并在真实免密与非标代理环境下完成立体验证后，方可宣称该战役维度真正收官交付。
