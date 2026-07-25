# Conex Provider 贡献指南

**预期耗时**: 30 分钟（仅需写一个 JSON 文件）

---

## 目录

1. [快速开始](#1-快速开始)
2. [Provider JSON Schema](#2-provider-json-schema)
3. [引擎配置示例](#3-引擎配置示例)
4. [认证配置指南](#4-认证配置指南)
5. [模型列表与能力声明](#5-模型列表与能力声明)
6. [测试指南](#6-测试指南)
7. [提交流程](#7-提交流程)

---

## 1. 快速开始

### 方式 A: CLI 向导（推荐）

```bash
npx crish add-provider
```

按照交互式提示依次填写：名称 → 引擎 → baseUrl → 认证 → 默认模型。CLI 会自动测试连接并生成 JSON 文件。

### 方式 B: 手动创建

1. 复制模板：
   ```bash
   cp templates/provider.openai-compatible.json providers/my-provider.json
   ```
2. 编辑 JSON 文件，填写你的 Provider 信息
3. 验证配置：
   ```bash
   npx crish provider validate providers/my-provider.json
   ```
4. 测试连接：
   ```bash
   npx crish provider test providers/my-provider.json
   ```

---

## 2. Provider JSON Schema

### Schema 版本

当前 `version: "1.0"`。

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | **是** | 唯一标识，全小写字母+连字符，如 `"groq"`、`"deepseek"` |
| `name` | `string` | **是** | 显示名称，如 `"Groq Cloud"` |
| `version` | `string` | **是** | Schema 版本，当前 `"1.0"` |
| `engine` | `enum` | **是** | 驱动引擎：`"openai-compatible"` / `"anthropic"` / `"gemini"` |
| `description` | `string` | 否 | 简要描述（1-2 句话） |
| `tags` | `string[]` | 否 | 分类标签，如 `["fast", "low-cost", "open-source"]` |
| `baseUrl` | `string` | **是** | API 基础 URL，**不含** `/v1` 路径 |
| `pathPrefix` | `string` | 否 | API 路径前缀，默认 `"/v1"` |
| `auth` | `object` | **是** | 认证配置（见 §4） |
| `defaultModel` | `string` | **是** | 默认模型 ID |
| `models` | `array` | 否 | 预配置模型列表（见 §5） |
| `modelListEndpoint` | `string` | 否 | 模型列表 API 路径，默认 `/models` |
| `endpoint` | `enum` | 否 | OpenAI-compatible 用：`"auto"` / `"chat-completions"` / `"responses"` |
| `stream` | `boolean` | 否 | 是否支持流式，默认 `true` |
| `maxTokens` | `number` | 否 | 默认最大输出 tokens |
| `temperature` | `number` | 否 | 默认温度参数 |
| `topP` | `number` | 否 | 默认 top_p 参数 |
| `timeout` | `number` | 否 | 请求超时（ms），默认 `120000` |
| `headers` | `object` | 否 | 自定义请求头 |
| `retry` | `object` | 否 | 重试策略（见下方） |
| `transport` | `enum` | 否 | 传输层：`"fetch"` / `"rust-reqwest"` / `"auto"` |
| `features` | `object` | 否 | 能力声明 |
| `limitations` | `string[]` | 否 | 已知限制列表 |
| `docsUrl` | `string` | 否 | 官方文档链接 |

### Retry 配置

```json
{
  "retry": {
    "maxAttempts": 3,
    "totalBudgetMs": 30000,
    "baseDelayMs": 1000,
    "maxDelayMs": 10000
  }
}
```

### Features 配置

```json
{
  "features": {
    "supportsToolCalls": true,
    "supportsParallelToolCalls": true,
    "supportsVision": false,
    "supportsStreaming": true,
    "supportsPromptCaching": false,
    "supportsReasoning": false,
    "supportsAudioInput": false,
    "supportsComputerUse": false,
    "supportsWebSearch": false
  }
}
```

---

## 3. 引擎配置示例

### 3.1 OpenAI-Compatible 引擎

**适用**：Groq、DeepSeek、Together AI、Fireworks AI、OpenRouter、Mistral、Perplexity 等绝大多数第三方 API。

```json
{
  "id": "together",
  "name": "Together AI",
  "version": "1.0",
  "engine": "openai-compatible",
  "description": "Together AI 推理平台，提供多种开源模型",
  "tags": ["open-source", "many-models"],
  "baseUrl": "https://api.together.xyz",
  "pathPrefix": "/v1",
  "auth": {
    "method": "bearer",
    "apiKeyEnv": "TOGETHER_API_KEY"
  },
  "defaultModel": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "endpoint": "chat-completions",
  "stream": true,
  "timeout": 120000,
  "headers": {
    "X-Title": "Conex"
  },
  "features": {
    "supportsToolCalls": true,
    "supportsStreaming": true
  }
}
```

### 3.2 Anthropic 引擎

**适用**：Anthropic Claude 官方 API、AWS Bedrock（Anthropic 模型）。

```json
{
  "id": "anthropic",
  "name": "Anthropic Claude",
  "version": "1.0",
  "engine": "anthropic",
  "description": "Anthropic 官方 Claude API",
  "tags": ["powerful", "safe"],
  "baseUrl": "https://api.anthropic.com",
  "auth": {
    "method": "api-key",
    "keyHeader": "x-api-key",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "defaultModel": "claude-sonnet-4-20250514",
  "anthropicVersion": "2023-06-01",
  "stream": true,
  "timeout": 180000,
  "features": {
    "supportsToolCalls": true,
    "supportsVision": true,
    "supportsComputerUse": true,
    "supportsPromptCaching": true
  },
  "limitations": [
    "不支持 /v1/models 端点",
    "max_tokens 是必填字段"
  ],
  "docsUrl": "https://docs.anthropic.com/en/api"
}
```

### 3.3 Gemini 引擎

**适用**：Google Gemini 官方 API、GCP Vertex AI。

```json
{
  "id": "gemini",
  "name": "Google Gemini",
  "version": "1.0",
  "engine": "gemini",
  "description": "Google Gemini 官方 API",
  "tags": ["multimodal", "google"],
  "baseUrl": "https://generativelanguage.googleapis.com",
  "auth": {
    "method": "bearer",
    "apiKeyEnv": "GEMINI_API_KEY"
  },
  "defaultModel": "gemini-2.0-flash",
  "authViaQuery": false,
  "stream": true,
  "timeout": 120000,
  "features": {
    "supportsToolCalls": true,
    "supportsVision": true,
    "supportsAudioInput": true
  },
  "limitations": [
    "函数调用参数限制在 1024 字节内",
    "不支持 system 角色（使用 user prefix 回退）"
  ],
  "docsUrl": "https://ai.google.dev/gemini-api/docs"
}
```

---

## 4. 认证配置指南

### 4.1 Bearer Token（最常用）

```json
{
  "auth": {
    "method": "bearer",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```
- 发送 `Authorization: Bearer <token>` 头
- **推荐**使用 `apiKeyEnv` 引用环境变量
- 避免在 JSON 中直接写 `apiKey`

### 4.2 API Key Header

```json
{
  "auth": {
    "method": "api-key",
    "keyHeader": "x-api-key",
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  }
}
```
- 发送 `x-api-key: <key>` 头（header 名可自定义）
- 与 bearer 的区别：header 名称不同

### 4.3 Basic Auth

```json
{
  "auth": {
    "method": "basic",
    "username": "my-org",
    "usernameEnv": "MY_ORG_USERNAME",
    "apiKey": "sk-...",
    "apiKeyEnv": "MY_ORG_API_KEY"
  }
}
```
- 发送 `Authorization: Basic base64(username:password)` 头
- 支持 `usernameEnv` 从环境变量读取用户名
- `password` 复用 `apiKey` / `apiKeyEnv` 字段

### 4.4 AWS Signature V4

```json
{
  "auth": {
    "method": "aws-sig-v4",
    "awsRegion": "us-west-2",
    "awsService": "bedrock",
    "awsAccessKeyIdEnv": "AWS_ACCESS_KEY_ID",
    "awsSecretAccessKeyEnv": "AWS_SECRET_ACCESS_KEY"
  }
}
```
- 自动计算 AWS SigV4 签名并附加到请求头
- 需要 `AWS_ACCESS_KEY_ID` 和 `AWS_SECRET_ACCESS_KEY` 环境变量

### 4.5 Azure API Key

```json
{
  "auth": {
    "method": "azure-api-key",
    "azureHeader": "x-api-key",
    "apiKeyEnv": "AZURE_OPENAI_API_KEY"
  }
}
```
- 发送 `x-api-key: <key>` 头（Azure 风格）

### 4.6 OAuth2

```json
{
  "auth": {
    "method": "oauth2",
    "apiKeyEnv": "OAUTH_TOKEN",
    "oauth": {
      "flow": "client-credentials",
      "tokenUrl": "https://auth.example.com/oauth/token",
      "clientIdEnv": "OAUTH_CLIENT_ID",
      "clientSecretEnv": "OAUTH_CLIENT_SECRET",
      "scopes": ["https://api.example.com/.default"]
    }
  }
}
```
- 支持的流程：`pkce` / `device-code` / `client-credentials`
- 自动刷新 token（当 401 时尝试刷新）

### 4.7 No Auth

```json
{
  "auth": {
    "method": "none"
  }
}
```
- 适用于本地服务（如 Ollama、vLLM）

### 4.8 认证方式速查表

| 方法 | Header 格式 | 适用场景 |
|------|-------------|----------|
| `bearer` | `Authorization: Bearer <token>` | OpenAI、Groq、DeepSeek、OpenRouter |
| `api-key` | `x-api-key: <key>` | Anthropic |
| `basic` | `Authorization: Basic <base64>` | 遗留系统 |
| `aws-sig-v4` | 动态签名 | AWS Bedrock |
| `azure-api-key` | `x-api-key: <key>` | Azure OpenAI |
| `oauth2` | `Authorization: Bearer <token>` + 自动刷新 | 企业 API |
| `custom` | 用户定义 | 特殊签名算法 |
| `chain` | 多方法组合 | 多层认证 |
| `none` | 无 | 本地服务 |

---

## 5. 模型列表与能力声明

### 5.1 预配置模型

```json
{
  "models": [
    {
      "id": "llama3-8b-8192",
      "name": "Llama 3 8B",
      "contextWindow": 8192,
      "maxOutputTokens": 4096,
      "features": {
        "supportsFunctionCalling": true,
        "supportsParallelFunctionCalling": false,
        "supportsVision": false
      },
      "pricing": {
        "inputPer1K": 0.0002,
        "outputPer1K": 0.0002,
        "currency": "USD"
      }
    },
    {
      "id": "llama3-70b-8192",
      "name": "Llama 3 70B",
      "contextWindow": 8192,
      "maxOutputTokens": 4096,
      "features": {
        "supportsFunctionCalling": true,
        "supportsParallelFunctionCalling": true,
        "supportsVision": false
      },
      "pricing": {
        "inputPer1K": 0.00059,
        "outputPer1K": 0.00079,
        "currency": "USD"
      }
    }
  ]
}
```

### 5.2 自动模型发现

如果不提供 `models` 列表，系统会自动调用 `GET {baseUrl}/v1/models` 拉取模型列表。

```json
{
  "modelListEndpoint": "/v1/models"
}
```

### 5.3 模型 ID 命名约定

- 使用 Provider 返回的原始模型 ID
- 不需要加 Provider 前缀（系统会自动关联）
- 示例：`"gpt-4o"`（而不是 `"openai/gpt-4o"`）

---

## 6. 测试指南

### 6.1 使用 CLI 测试

```bash
# 验证 JSON 合法性
npx crish provider validate my-provider.json

# 基础测试（模型列表、流式、工具调用）
npx crish provider test my-provider.json

# 压力测试（并发请求）
npx crish provider test my-provider.json --stress

# 错误测试（无效 auth、错误模型、超时）
npx crish provider test my-provider.json --errors
```

### 6.2 使用 Mock Server 测试

在本地运行 mock server 模拟 Provider API：

```bash
# 使用内置 mock server
npx crish provider test --mock my-provider.json

# 自定义 mock
npx crish provider test --mock-url http://localhost:8080 my-provider.json
```

Mock server 支持模拟：
- 模型列表返回
- 流式/非流式响应
- 各类错误状态码
- 网络延迟/超时
- 速率限制

```typescript
// tests/provider-mock-server.ts
import { createMockProviderServer } from "@crish/testing";

const server = createMockProviderServer({
  engine: "openai-compatible",
  models: ["model-a", "model-b"],
  latencyMs: 100,
  errorRate: 0.1,      // 10% 请求返回错误
  rateLimit: 100,       // 每分钟 100 请求
});
await server.start(8080);
// 运行测试...
await server.stop();
```

### 6.3 手动测试

```bash
# 使用开发者模式快速测试
npx crish dev --provider ./my-provider.json "Hello, what model are you?"

# 查看诊断信息
npx crish dev --provider ./my-provider.json --diagnostics
```

### 6.4 测试清单

- [ ] `baseUrl` 可访问
- [ ] 认证成功（非 401/403）
- [ ] 模型列表 API 正常返回
- [ ] 默认模型可调用
- [ ] 流式响应正常（SSE 格式正确）
- [ ] 非流式响应正常
- [ ] 工具调用正常（如支持）
- [ ] 错误处理正常（无效模型名返回 4xx）
- [ ] 认证失败返回 401（安全）
- [ ] 超时设置生效

---

## 7. 提交流程

### PR Checklist

- [ ] JSON 文件放在 `providers/<id>.json`
- [ ] 运行 `npx crish provider validate --strict <file>` 通过
- [ ] 运行 `npx crish provider test <file>` 全部测试通过
- [ ] 已检查已知限制并填写 `limitations` 字段
- [ ] 已填写 `tags` 便于分类搜索
- [ ] 优先使用 `apiKeyEnv` 而非 `apiKey`（安全最佳实践）
- [ ] `baseUrl` 不含尾部 `/`
- [ ] 已添加官方 `docsUrl`

### PR 类型

- **新 Provider**: 新增 `providers/<id>.json` 文件
- **更新 Provider**: 修改已有 JSON（更新模型、修复 baseUrl 等）
- **社区 Provider**: 放在 `providers/community/` 目录下

### 审核标准

1. **安全性**: 不存储明文 API Key
2. **兼容性**: JSON schema 验证通过
3. **可测试性**: 测试结果附在 PR 中
4. **完整性**: 必填字段齐全，文档链接有效
5. **正确性**: baseUrl 和 auth 配置与官方文档一致

### 提交示例

```
feat(providers): add Groq Cloud provider

- engine: openai-compatible
- baseUrl: https://api.groq.com/openai
- auth: bearer (GROQ_API_KEY env)
- models: llama3-8b-8192, llama3-70b-8192, mixtral-8x7b-32768
- features: tool calls, streaming
- known limitations: vision not supported

Test results:
  crish provider validate: ✓
  crish provider test: 14/15 passed
```

---

## 附录 A: Provider 引擎选择决策树

```
你的 API 兼容 OpenAI 格式吗？
├── 是 → engine: "openai-compatible"
│   ├── 支持 responses API → endpoint: "auto" (推荐)
│   ├── 仅支持 chat completions → endpoint: "chat-completions"
│   └── 本地推理 (Ollama/vLLM) → transport: "fetch", timeout 加大
│
├── 是 Anthropic Messages API？ → engine: "anthropic"
│   └── 需要 x-api-key header + anthropic-version
│
├── 是 Google Gemini API？ → engine: "gemini"
│   └── 需要 x-goog-api-key header 或 ?key= query
│
└── 以上都不是？→ 可能需要新增引擎
    联系核心团队讨论
```

## 附录 B: 已知 Provider 常见问题

| Provider | 常见问题 | 解决方案 |
|----------|----------|----------|
| Groq | 速率限制严格 (30 req/min) | 设置 `retry` 配置 + 启用回退链 |
| DeepSeek | 高峰期不稳定 | 启用重试 + 备用 Provider |
| OpenRouter | 可能返回 Cloudflare 验证 | 设置 `transport: "rust-reqwest"` |
| Ollama | 本地端口可能变化 | 使用 `localhost:11434`（默认） |
| Gemini | 函数调用参数 1024 字节限制 | 简化 tool schema |
| Anthropic | max_tokens 是必填字段 | 始终在 JSON 中设置 `maxTokens` |
| Together AI | 部分模型不支持 streaming | 设置 `stream: false` 或增加超时 |
