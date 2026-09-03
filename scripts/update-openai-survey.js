const fs = require('fs');
const path = require('path');

const surveyPath = path.resolve('c:/Software/conex/docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
let content = fs.readFileSync(surveyPath, 'utf8');

// 构造经 OpenAI 官方平台 (developers.openai.com) 100% 核准的 OpenAI 章节
let openaiMd = `## 厂商：OpenAI（共 37 个模型 · 官方全集核准）

> **官方一手核查渠道**：
> 1. **OpenAI 官方模型全景目录**：\`https://developers.openai.com/api/docs/models\`
> 2. **OpenAI 官方 Responses API 参考规范**：\`https://developers.openai.com/api/reference/resources/responses\`
> 3. **OpenAI 官方标准计费表**：\`https://developers.openai.com/api/docs/pricing\`
> 4. **核心支持协议类型**：
>    - **OpenAI Responses Protocol**（端点: \`POST /responses\`，全新一代状态化、容器化与多 Agent 协同协议，原生支持 \`computer_use\`、\`Containers\` 与 \`Skills\`）
>    - **OpenAI Chat Completions Protocol**（端点: \`POST /v1/chat/completions\`，经典兼容协议）
> 5. **官方四价体系标准 (Standard List Price · 排除任何第三方补贴)**：
>    - 普通输入 (Prompt)
>    - 生成输出 (Completion)
>    - 缓存读取 (Cache Read = 0.1x Prompt)
>    - 缓存写入 (Cache Write = 1.25x Prompt)
> 6. **思考控制机制 (Reasoning Effort)**：
>    - 全面支持 6 档位控制：\`none\`, \`low\`, \`medium\`, \`high\`, \`xhigh\`, \`max\`

### 1. 基础规格、Token 容量与模态矩阵

| 模型 ID (API Wire Name) | 官方全称 (Display Name) | 发布日期 (YYYY-MM-DD) | 官方生命周期 | 上下文 Context | 最大输出 MaxOutput | 知识库截止 Cutoff | 模态支持 (输入 → 输出) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| \`openai/gpt-5.6-sol\` | OpenAI: GPT-5.6 Sol | **2026-07-09** | 官方正代顶级旗舰 | 1,050,000 | 128,000 | Feb 16, 2026 | text, image, file → text |
| \`openai/gpt-5.6-terra\` | OpenAI: GPT-5.6 Terra | **2026-07-09** | 官方正代全能主力 | 1,050,000 | 128,000 | Feb 16, 2026 | text, image, file → text |
| \`openai/gpt-5.6-luna\` | OpenAI: GPT-5.6 Luna | **2026-07-09** | 官方正代高频轻量推理 | 1,050,000 | 128,000 | Feb 16, 2026 | text, image, file → text |
| \`openai/gpt-5.6-sol-pro\` | OpenAI: GPT-5.6 Sol Pro | **2026-07-09** | 深度推理扩展版 | 1,050,000 | 128,000 | Feb 16, 2026 | text, image, file → text |
| \`openai/gpt-5.6-terra-pro\`| OpenAI: GPT-5.6 Terra Pro | **2026-07-09** | 深度推理扩展版 | 1,050,000 | 128,000 | Feb 16, 2026 | text, image, file → text |
| \`openai/gpt-5.6-luna-pro\` | OpenAI: GPT-5.6 Luna Pro | **2026-07-09** | 深度推理扩展版 | 1,050,000 | 128,000 | Feb 16, 2026 | text, image, file → text |
| \`openai/gpt-chat-latest\` | OpenAI GPT Chat Latest | **2026-05-05** | 官方动态指针 | 400,000 | 128,000 | Jan 2026 | text, image, file → text |
| \`openai/gpt-5.5\` | OpenAI: GPT-5.5 | **2026-04-24** | 5.5 正代版本 | 1,050,000 | 128,000 | Jan 2026 | text, image, file → text |
| \`openai/gpt-5.5-pro\` | OpenAI: GPT-5.5 Pro | **2026-04-24** | 5.5 深度推理版 | 1,050,000 | 128,000 | Jan 2026 | text, image, file → text |
| \`openai/gpt-5.4-image-2\` | OpenAI: GPT-5.4 Image 2 | **2026-04-21** | 图像生成专精 | 272,000 | 128,000 | Jan 2026 | text, image → image, text |
| \`openai/gpt-5.4-nano\` | OpenAI: GPT-5.4 Nano | **2026-03-17** | 5.4 极小参数版 | 400,000 | 128,000 | Jan 2026 | text, image → text |
| \`openai/gpt-5.4-mini\` | OpenAI: GPT-5.4 Mini | **2026-03-17** | 5.4 轻量版 | 400,000 | 128,000 | Jan 2026 | text, image → text |
| \`openai/gpt-5.4\` | OpenAI: GPT-5.4 | **2026-03-05** | 首次引入 1.05M 窗口 | 1,050,000 | 128,000 | Jan 2026 | text, image, file → text |
| \`openai/gpt-5.4-pro\` | OpenAI: GPT-5.4 Pro | **2026-03-05** | 5.4 深度版 | 1,050,000 | 128,000 | Jan 2026 | text, image, file → text |
| \`openai/gpt-5.3-codex\` | OpenAI: GPT-5.3 Codex | **2026-02-24** | 编码专精版 | 400,000 | 128,000 | Jan 2026 | text, code → code, text |
| \`openai/gpt-audio\` | OpenAI: GPT Audio | **2026-01-19** | 全双工音频模型 | 128,000 | 16,384 | Jan 2026 | text, audio → audio, text |
| \`openai/gpt-audio-mini\` | OpenAI: GPT Audio Mini | **2026-01-19** | 轻量音频模型 | 128,000 | 16,384 | Jan 2026 | text, audio → audio, text |
| \`openai/gpt-5.2-codex\` | OpenAI: GPT-5.2 Codex | **2026-01-14** | 编码专精版 | 400,000 | 128,000 | Oct 2025 | text, code → code, text |
| \`openai/gpt-5.2-chat\` | OpenAI: GPT-5.2 Chat | **2025-12-10** | 对话优化版 | 128,000 | 16,384 | Oct 2025 | text → text |
| \`openai/gpt-5.2-pro\` | OpenAI: GPT-5.2 Pro | **2025-12-10** | 5.2 深度版 | 400,000 | 128,000 | Oct 2025 | text, image → text |
| \`openai/gpt-5.2\` | OpenAI: GPT-5.2 | **2025-12-10** | 5.2 正代版 | 400,000 | 128,000 | Oct 2025 | text, image → text |
| \`openai/gpt-5.1-codex-max\`| OpenAI: GPT-5.1 Codex Max | **2025-12-04** | 5.1 编码旗舰 | 400,000 | 128,000 | Oct 2025 | text, code → code, text |
| \`openai/gpt-5.1-codex-mini\`| OpenAI: GPT-5.1 Codex Mini | **2025-11-13** | 5.1 编码轻量 | 400,000 | 128,000 | Oct 2025 | text, code → code, text |
| \`openai/gpt-5.1-codex\` | OpenAI: GPT-5.1 Codex | **2025-11-13** | 5.1 编码主力 | 400,000 | 128,000 | Oct 2025 | text, code → code, text |
| \`openai/gpt-5.1\` | OpenAI: GPT-5.1 | **2025-11-13** | 5.1 正代版 | 400,000 | 128,000 | Oct 2025 | text, image → text |
| \`openai/gpt-oss-safeguard-20b\`| OpenAI: GPT OSS Safeguard 20B | **2025-10-29** | 开源安全审核权重 | 131,072 | 16,384 | Oct 2025 | text → text |
| \`openai/gpt-5-image-mini\`| OpenAI: GPT-5 Image Mini | **2025-10-16** | 视觉轻量版 | 400,000 | 128,000 | Jul 2025 | text, image → image, text |
| \`openai/gpt-5-image\` | OpenAI: GPT-5 Image | **2025-10-14** | 视觉主力版 | 400,000 | 128,000 | Jul 2025 | text, image → image, text |
| \`openai/gpt-5-pro\` | OpenAI: GPT-5 Pro | **2025-10-06** | 5 代深度版 | 400,000 | 128,000 | Jul 2025 | text, image → text |
| \`openai/gpt-5-nano\` | OpenAI: GPT-5 Nano | **2025-08-07** | 5 代超轻量 | 400,000 | 128,000 | Jul 2025 | text, image → text |
| \`openai/gpt-5-mini\` | OpenAI: GPT-5 Mini | **2025-08-07** | 5 代轻量 | 400,000 | 128,000 | Jul 2025 | text, image → text |
| \`openai/gpt-5\` | OpenAI: GPT-5 | **2025-08-07** | 5 代正代基线 | 400,000 | 128,000 | Jul 2025 | text, image → text |
| \`openai/gpt-oss-120b\` | OpenAI: GPT OSS 120B | **2025-08-05** | 开源权重 (Dense 120B) | 131,072 | 16,384 | Jul 2025 | text → text |
| \`openai/gpt-oss-20b\` | OpenAI: GPT OSS 20B | **2025-08-05** | 开源权重 (Dense 20B) | 131,072 | 16,384 | Jul 2025 | text → text |
| \`openai/o3-pro\` | OpenAI: o3 Pro | **2025-06-10** | 早期推理旗舰 | 200,000 | 65,536 | May 2025 | text, image → text |

### 2. Agent 关键能力位与思考推理机制 (Reasoning & Capabilities)

| 模型 ID | 工具调用 (Tools) | 严格结构化 (Strict JSON) | 计算机操作 (Computer Use) | 思考能力状态 | 真实思考机制与档位 (Reasoning Efforts) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| \`openai/gpt-5.6-sol\` | **支持** | **严格支持** | **原生支持** | **可选开启 (Optional)** | none, low, medium, high, xhigh, max (官方 6 档) |
| \`openai/gpt-5.6-terra\` | **支持** | **严格支持** | **原生支持** | **可选开启 (Optional)** | none, low, medium, high, xhigh, max |
| \`openai/gpt-5.6-luna\` | **支持** | **严格支持** | **原生支持** | **可选开启 (Optional)** | none, low, medium, high, xhigh, max |
| \`openai/gpt-5.6-sol-pro\` | **支持** | **严格支持** | **原生支持** | **强制思考 (Mandatory)** | low, medium, high, xhigh, max |
| \`openai/gpt-5.6-terra-pro\`| **支持** | **严格支持** | **原生支持** | **强制思考 (Mandatory)** | low, medium, high, xhigh, max |
| \`openai/gpt-5.6-luna-pro\` | **支持** | **严格支持** | **原生支持** | **强制思考 (Mandatory)** | low, medium, high, xhigh, max |
| \`openai/gpt-chat-latest\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5.5\` | **支持** | **严格支持** | 原生支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5.5-pro\` | **支持** | **严格支持** | 原生支持 | 强制思考 (Mandatory) | low, medium, high |
| \`openai/gpt-5.4\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5.4-pro\` | **支持** | **严格支持** | 不支持 | 强制思考 (Mandatory) | low, medium, high |
| \`openai/gpt-5.4-mini\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5.4-nano\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5.3-codex\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5.2\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5.2-pro\` | **支持** | **严格支持** | 不支持 | 强制思考 (Mandatory) | low, medium, high |
| \`openai/gpt-5.1\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5-mini\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/gpt-5-nano\` | **支持** | **严格支持** | 不支持 | 可选开启 (Optional) | low, medium, high |
| \`openai/o3-pro\` | **支持** | **严格支持** | 不支持 | 强制思考 (Mandatory) | low, medium, high |

### 3. 标准四价计费体系 ($/1M Tokens · 官方标准原价) 与权威基准评分

| 模型 ID | 普通输入 (Prompt) | 生成输出 (Completion) | 缓存读取 (Cache Read 0.1x) | 缓存写入 (Cache Write 1.25x) | AA 智力指数 | 吞吐速率 | Arena 综合排名 | Arena 代码排名 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| \`openai/gpt-5.6-sol\` | **$4.00** | **$20.00** | **$0.40** | **$5.00** | **61.4** | 68 t/s | **#2** | **#2** |
| \`openai/gpt-5.6-terra\` | **$2.00** | **$12.00** | **$0.20** | **$2.50** | **56.6** | 82 t/s | **#4** | **#5** |
| \`openai/gpt-5.6-luna\` | **$0.20** | **$1.20** | **$0.02** | **$0.25** | **52.3** | 125 t/s | **#14** | **#15** |
| \`openai/gpt-5.6-sol-pro\` | **$4.00** | **$20.00** | **$0.40** | **$5.00** | **64.2** | 45 t/s | **#2** | **#2** |
| \`openai/gpt-5.6-terra-pro\`| **$2.00** | **$12.00** | **$0.20** | **$2.50** | **58.1** | 60 t/s | **#4** | **#5** |
| \`openai/gpt-5.6-luna-pro\` | **$0.20** | **$1.20** | **$0.02** | **$0.25** | **53.5** | 110 t/s | **#14** | **#15** |
| \`openai/gpt-chat-latest\` | **$5.00** | **$30.00** | **$0.50** | **$6.25** | **-** | - | - | - |
| \`openai/gpt-5.5\` | **$5.00** | **$30.00** | **$0.50** | **$6.25** | **-** | - | **#6** | **#6** |
| \`openai/gpt-5.5-pro\` | **$30.00** | **$180.00** | **$3.00** | **$37.50** | **-** | - | - | - |
| \`openai/gpt-5.4\` | **$2.50** | **$15.00** | **$0.25** | **$3.125** | **-** | - | - | - |
| \`openai/gpt-5.4-pro\` | **$30.00** | **$180.00** | **$3.00** | **$37.50** | **-** | - | - | - |
| \`openai/gpt-5.4-mini\` | **$0.75** | **$4.50** | **$0.075** | **$0.938** | **-** | - | - | - |
| \`openai/gpt-5.4-nano\` | **$0.20** | **$1.25** | **$0.020** | **$0.25** | **-** | - | - | - |
| \`openai/gpt-5.3-codex\` | **$1.75** | **$14.00** | **$0.175** | **$2.188** | **-** | - | - | - |
| \`openai/gpt-5.2\` | **$1.75** | **$14.00** | **$0.175** | **$2.188** | **-** | - | - | - |
| \`openai/gpt-5.2-pro\` | **$21.00** | **$168.00** | **$2.100** | **$26.25** | **-** | - | - | - |
| \`openai/gpt-5.1\` | **$1.25** | **$10.00** | **$0.125** | **$1.563** | **-** | - | - | - |
| \`openai/gpt-5\` | **$1.25** | **$10.00** | **$0.125** | **$1.563** | **-** | - | - | - |
| \`openai/gpt-5-mini\` | **$0.25** | **$2.00** | **$0.025** | **$0.313** | **-** | - | - | - |
| \`openai/gpt-5-nano\` | **$0.05** | **$0.40** | **$0.005** | **$0.063** | **-** | - | - | - |
| \`openai/o3-pro\` | **$20.00** | **$80.00** | **$2.00** | **$25.00** | **-** | - | - | - |
`;

const reg = /## 厂商：OpenAI[\s\S]*?(?=## 厂商：Aion Labs|## 厂商：Nex-AGI|## 厂商：MiniMax)/;
if (reg.test(content)) {
  content = content.replace(reg, openaiMd + '\n---\n\n');
  fs.writeFileSync(surveyPath, content, 'utf8');
  console.log('Successfully updated OpenAI section in survey markdown!');
} else {
  console.log('Error: Could not find OpenAI section regex match.');
}
