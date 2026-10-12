const fs = require('fs');
const path = require('path');

const surveyPath = path.resolve(__dirname, '../docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
let content = fs.readFileSync(surveyPath, 'utf8');

// 构造经 Anthropic 官方平台 (platform.claude.com) 100% 核准的 Anthropic 章节
let anthropicMd = `## 厂商：Anthropic（共 16 个模型 · 官方全集核准）

> **官方一手核查渠道**：
> 1. **Anthropic Claude 官方控制台与模型全景**：\`https://platform.claude.com/docs/en/models/overview\`
> 2. **Anthropic 官方 Messages API 参考规范**：\`https://platform.claude.com/docs/en/api/messages\`
> 3. **核心协议类型**：**Anthropic Messages Protocol**（端点: \`POST /v1/messages\`）
> 4. **官方专有特性**：
>    - 原生前缀缓存标记：\`cache_control: {"type": "ephemeral"}\`（触发门槛: 1024 tokens）
>    - 官方四价体系标准：标准输入 (Prompt), 生成输出 (Completion), 缓存写入 (Cache Write = 1.25x Prompt), 缓存读取 (Cache Read = 0.1x ~ 0.025x Prompt)
>    - 官方思考协议：自适应思考 (\`Adaptive (always on)\` / \`Adaptive\`)，支持档位 (\`high\`, \`medium\`, \`low\`) 或数值预算 (\`budget_tokens\`)

### 1. 基础规格、Token 容量与模态矩阵

| 模型 ID (API Wire Name) | 官方全称 (Display Name) | 确切发布日期 (YYYY-MM-DD) | 官方生命周期 | 上下文 Context | 最大输出 MaxOutput | 知识库截止 Cutoff | 模态支持 (输入 → 输出) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| \`anthropic/claude-fable-5.1\` | Anthropic: Claude Fable 5.1 | **2026-09-01** | 最新正代超强推理旗舰 | 1,000,000 | 128,000 | Jun 2026 | text, image, file, pdf → text |
| \`anthropic/claude-opus-5\` | Claude Opus 5 | **2026-07-24** | 正代主力编码/企业旗舰 | 1,000,000 | 128,000 | May 2026 | text, image, file, pdf → text |
| \`anthropic/claude-sonnet-5\` | Anthropic: Claude Sonnet 5 | **2026-06-30** | 正代高性价比主力 | 1,000,000 | 128,000 | Jan 2026 | text, image, file, pdf → text |
| \`anthropic/claude-fable-5\` | Anthropic: Claude Fable 5 | **2026-06-09** | Fable 架构初代 | 1,000,000 | 128,000 | Jun 2026 | text, image, file, pdf → text |
| \`anthropic/claude-haiku-4.5\` | Anthropic: Claude Haiku 4.5 | **2025-10-15** | 轻量极速现役 | 200,000 | 64,000 | Feb 2025 | text, image, file, pdf → text |
| \`anthropic/claude-opus-4.8\` | Anthropic: Claude Opus 4.8 | **2026-05-27** | 4 代最终稳定版 | 1,000,000 | 128,000 | Apr 2026 | text, image, file, pdf → text |
| \`anthropic/claude-opus-4.7\` | Anthropic: Claude Opus 4.7 | **2026-04-16** | 4 代深度推理版 | 1,000,000 | 128,000 | Mar 2026 | text, image, file, pdf → text |
| \`anthropic/claude-sonnet-4.6\` | Anthropic: Claude Sonnet 4.6 | **2026-02-17** | 4 代高性价比版 | 1,000,000 | 128,000 | Jan 2026 | text, image, file, pdf → text |
| \`anthropic/claude-opus-4.6\` | Anthropic: Claude Opus 4.6 | **2026-02-04** | 4 代深度推理版 | 1,000,000 | 128,000 | Dec 2025 | text, image, file, pdf → text |
| \`anthropic/claude-opus-4.5\` | Anthropic: Claude Opus 4.5 | **2025-11-24** | 4 代早期旗舰 | 200,000 | 64,000 | Oct 2025 | text, image, file, pdf → text |
| \`anthropic/claude-sonnet-4.5\` | Anthropic: Claude Sonnet 4.5 | **2025-09-29** | 首次进入 1M 窗口 | 1,000,000 | 64,000 | Jan 2025 | text, image, file, pdf → text |
| \`anthropic/claude-opus-4.1\` | Anthropic: Claude Opus 4.1 | **2025-08-05** | 4 代初代过渡版 | 200,000 | 32,000 | Jan 2025 | text, image, file, pdf → text |
| \`~anthropic/claude-fable-latest\` | Anthropic: Claude Fable Latest | **2026-06-09** | 官方动态别名 | 1,000,000 | 128,000 | Jun 2026 | text, image, file, pdf → text |
| \`~anthropic/claude-opus-latest\` | Anthropic: Claude Opus Latest | **2026-04-21** | 官方动态别名 | 1,000,000 | 128,000 | May 2026 | text, image, file, pdf → text |
| \`~anthropic/claude-sonnet-latest\`| Anthropic: Claude Sonnet Latest | **2026-04-27** | 官方动态别名 | 1,000,000 | 128,000 | Jan 2026 | text, image, file, pdf → text |
| \`~anthropic/claude-haiku-latest\` | Anthropic: Claude Haiku Latest | **2026-04-27** | 官方动态别名 | 200,000 | 64,000 | Feb 2025 | text, image, file, pdf → text |

### 2. Agent 关键能力位与思考推理机制 (Reasoning & Capabilities)

| 模型 ID | 工具调用 (Tools) | 严格结构化 (Strict JSON) | 前缀缓存 (Prompt Caching) | 思考能力状态 | 真实思考机制与档位 (Adaptive / Efforts) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| \`anthropic/claude-fable-5.1\` | **支持** | **严格支持** | 原生支持 (1024 门槛) | **强制思考 (Adaptive always on)** | max, xhigh, high, medium, low (默认: high, 官方 Adaptive) |
| \`anthropic/claude-opus-5\` | **支持** | **严格支持** | 原生支持 | **默认开启 (Adaptive)** | max, xhigh, high, medium, low (默认: high) |
| \`anthropic/claude-sonnet-5\` | **支持** | **严格支持** | 原生支持 | **默认开启 (Adaptive)** | max, xhigh, high, medium, low (默认: high) |
| \`anthropic/claude-fable-5\` | **支持** | **严格支持** | 原生支持 | **强制思考 (Adaptive always on)** | max, xhigh, high, medium, low (默认: high) |
| \`anthropic/claude-haiku-4.5\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Extended Thinking)** | 预算 Token 数 (budget_tokens) |
| \`anthropic/claude-opus-4.8\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Optional)** | max, xhigh, high, medium, low (默认: high) |
| \`anthropic/claude-opus-4.7\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Optional)** | max, xhigh, high, medium, low (默认: high) |
| \`anthropic/claude-sonnet-4.6\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Optional)** | max, high, medium, low (默认: medium) |
| \`anthropic/claude-opus-4.6\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Optional)** | max, high, medium, low (默认: high) |
| \`anthropic/claude-opus-4.5\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Extended Thinking)** | 预算 Token 数 (budget_tokens) |
| \`anthropic/claude-sonnet-4.5\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Extended Thinking)** | 预算 Token 数 (budget_tokens) |
| \`anthropic/claude-opus-4.1\` | **支持** | **严格支持** | 原生支持 | 不支持 | - |
| \`~anthropic/claude-fable-latest\` | **支持** | **严格支持** | 原生支持 | **强制思考 (Adaptive always on)** | max, xhigh, high, medium, low |
| \`~anthropic/claude-opus-latest\` | **支持** | **严格支持** | 原生支持 | **默认开启 (Adaptive)** | max, xhigh, high, medium, low |
| \`~anthropic/claude-sonnet-latest\`| **支持** | **严格支持** | 原生支持 | **默认开启 (Adaptive)** | max, xhigh, high, medium, low |
| \`~anthropic/claude-haiku-latest\` | **支持** | **严格支持** | 原生支持 | **可选开启 (Extended Thinking)** | 预算 Token 数 |

### 3. 标准四价计费体系 ($/1M Tokens · 官方标准原价) 与权威基准评分

| 模型 ID | 普通输入 (Prompt) | 生成输出 (Completion) | 缓存读取 (Cache Read) | 缓存写入 (Cache Write) | AA 智力指数 | 吞吐速率 | Arena 综合排名 | Arena 代码排名 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| \`anthropic/claude-fable-5.1\` | **$10.00** | **$50.00** | **$0.25** (1/40) | **$12.50** (1.25x) | **65.7** (#1) | - | **#1** | **#3** |
| \`anthropic/claude-opus-5\` | **$5.00** | **$25.00** | **$0.50** (0.1x) | **$6.25** (1.25x) | **63.1** (#2) | 57 t/s | **#9** | **#11** |
| \`anthropic/claude-sonnet-5\` | **$2.00** | **$10.00** | **$0.20** (0.1x) | **$2.50** (1.25x) | **-** | - | **#48** | **#24** |
| \`anthropic/claude-fable-5\` | **$10.00** | **$50.00** | **$1.00** | **$12.50** (1.25x) | **-** | - | **#1** | **#3** |
| \`anthropic/claude-haiku-4.5\` | **$1.00** | **$5.00** | **$0.10** (0.1x) | **$1.25** (1.25x) | **-** | - | **#-** | **#-** |
| \`anthropic/claude-opus-4.8\` | **$5.00** | **$25.00** | **$0.50** | **$6.25** | **-** | - | **-** | **-** |
| \`anthropic/claude-opus-4.7\` | **$5.00** | **$25.00** | **$0.50** | **$6.25** | **-** | - | **-** | **-** |
| \`anthropic/claude-sonnet-4.6\` | **$3.00** | **$15.00** | **$0.30** | **$3.75** | **-** | - | **-** | **-** |
| \`anthropic/claude-opus-4.6\` | **$5.00** | **$25.00** | **$0.50** | **$6.25** | **-** | - | **-** | **-** |
| \`anthropic/claude-opus-4.5\` | **$5.00** | **$25.00** | **$0.50** | **$6.25** | **-** | - | **-** | **-** |
| \`anthropic/claude-sonnet-4.5\` | **$3.00** | **$15.00** | **$0.30** | **$3.75** | **-** | - | **-** | **-** |
| \`anthropic/claude-opus-4.1\` | **$15.00** | **$75.00** | **$1.50** | **$18.75** | **-** | - | **-** | **-** |
| \`~anthropic/claude-fable-latest\` | **$10.00** | **$50.00** | **$0.25** | **$12.50** | **-** | - | **-** | **-** |
| \`~anthropic/claude-opus-latest\` | **$5.00** | **$25.00** | **$0.50** | **$6.25** | **-** | - | **-** | **-** |
| \`~anthropic/claude-sonnet-latest\`| **$2.00** | **$10.00** | **$0.20** | **$2.50** | **-** | - | **-** | **-** |
| \`~anthropic/claude-haiku-latest\` | **$1.00** | **$5.00** | **$0.10** | **$1.25** | **-** | - | **-** | **-** |
`;

const reg = /## 厂商：Anthropic[\s\S]*?(?=## 厂商：Tencent)/;
if (reg.test(content)) {
  content = content.replace(reg, anthropicMd + '\n---\n\n');
  fs.writeFileSync(surveyPath, content, 'utf8');
  console.log('Successfully updated Anthropic section in survey markdown!');
} else {
  console.log('Error: Could not find Anthropic section regex match.');
}
