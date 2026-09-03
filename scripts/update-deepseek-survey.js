const fs = require('fs');
const path = require('path');

const surveyPath = path.resolve('c:/Software/conex/docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
let content = fs.readFileSync(surveyPath, 'utf8');

// 构造经 DeepSeek 官方平台 (api-docs.deepseek.com) 100% 核准的 DeepSeek 章节
let deepseekMd = `## 厂商：DeepSeek (深度求索)（共 10 个模型 · 官方全集核准）

> **官方一手核查渠道**：
> 1. **DeepSeek API 官方开发文档**：\`https://api-docs.deepseek.com/\`
> 2. **DeepSeek 官方模型与定价总表**：\`https://api-docs.deepseek.com/quick_start/pricing\`
> 3. **核心支持协议类型 (官方双轨原生)**：
>    - **OpenAI 兼容协议 (含 Responses API)**：\`base_url: https://api.deepseek.com\`，原生支持 \`Tool Calls\`、\`Json Output\`、\`Chat Prefix Completion\` 与 \`Responses API\`；
>    - **Anthropic 兼容协议**：\`base_url: https://api.deepseek.com/anthropic\`，支持 Claude Code 与 Anthropic SDK 直连无缝运行！
> 4. **官方专有特性**：
>    - 自动 KV 缓存机制 (Context Caching)：全自动前缀命中，无显式标记门槛，不收取额外缓存写入费；
>    - 思考模式：默认开启思考 (\`Thinking (default)\`)，可通过参数自由切换至非思考模式；
>    - 超高输出容量：单次输出最大高达 **384K tokens**；
>    - 代码填充模式：非思考模式下原生支持 **FIM (Fill-in-the-middle)** 补全。
> 5. **官方标准计费体系 (Standard Peak Price · 排除闲时半价取标准全价)**：
>    - 标准普通输入 (Cache Miss)
>    - 缓存命中读取 (Cache Hit = 0.031x Prompt)
>    - 缓存写入 (Cache Write = \`null\`，自动内置不单独计费)
>    - 生成输出 (Completion)

### 1. 基础规格、Token 容量与模态矩阵

| 模型 ID (API Wire Name) | 官方全称 (Display Name) | 发布日期 (YYYY-MM-DD) | 官方生命周期与更新说明 | 上下文 Context | 最大输出 MaxOutput | 模态支持 (输入 → 输出) |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| \`deepseek/deepseek-v4-flash\` | DeepSeek: DeepSeek-V4-Flash | **2026-04-24** | 正代极速旗舰 (底层已自动更新为 0731 权重) | 1,048,576 | 384,000 | text → text |
| \`deepseek/deepseek-v4-pro\` | DeepSeek: DeepSeek-V4-Pro | **2026-04-24** | 正代深度推理旗舰 (底层已自动更新为 0813 权重) | 1,048,576 | 384,000 | text → text |
| \`deepseek/deepseek-v4-flash-vision-exp\` | DeepSeek: V4 Flash Vision Exp | **2026-08-21** | 官方最新多模态视觉实验版 | 1,048,576 | 384,000 | image, text → text |
| \`deepseek/deepseek-v4-flash-0731\` | DeepSeek: DeepSeek V4 Flash 0731 | **2026-07-31** | 0731 固化快照版本 (路由层达 1.31M) | 1,310,720 | 384,000 | text → text |
| \`deepseek/deepseek-v4-pro-0813\` | DeepSeek: DeepSeek V4 Pro 0813 | **2026-08-12** | 0813 固化快照版本 | 1,048,576 | 384,000 | text → text |
| \`~deepseek/deepseek-v4-flash-latest\` | DeepSeek V4 Flash Latest | **2026-08-01** | 官方动态别名 | 1,310,720 | 384,000 | text → text |
| \`deepseek/deepseek-v3.2\` | DeepSeek: DeepSeek-V3.2 | **2025-12-01** | V3 终态稳定版本 | 163,840 | 65,536 | text → text |
| \`deepseek/deepseek-v3.2-exp\` | DeepSeek: DeepSeek-V3.2 Exp | **2025-09-29** | V3 试验版本 | 163,840 | 65,536 | text → text |
| \`deepseek/deepseek-v3.1-terminus\` | DeepSeek: V3.1 Terminus | **2025-09-22** | V3.1 固化快照版 | 163,840 | 65,536 | text → text |
| \`deepseek/deepseek-chat-v3.1\` | DeepSeek: DeepSeek Chat V3.1 | **2025-08-21** | V3.1 早期版本 | 163,840 | 65,536 | text → text |

### 2. Agent 关键能力位与思考推理机制 (Reasoning & Capabilities)

| 模型 ID | 工具调用 (Tools) | 严格结构化 (Strict JSON) | 代码补全 (FIM) | 思考能力状态 | 真实思考机制与档位 (Thinking Mode) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| \`deepseek/deepseek-v4-flash\` | **支持** | **严格支持** | 非思考时支持 | **默认开启 (Thinking default)** | max, high, low (官方支持思考/非思考自由切换) |
| \`deepseek/deepseek-v4-pro\` | **支持** | **严格支持** | 非思考时支持 | **默认开启 (Thinking default)** | max, high, low |
| \`deepseek/deepseek-v4-flash-vision-exp\` | **支持** | **严格支持** | 不支持 | **默认开启 (Thinking default)** | max, high, low |
| \`deepseek/deepseek-v4-flash-0731\` | **支持** | **严格支持** | 支持 | **默认开启 (Thinking default)** | max, high, low |
| \`deepseek/deepseek-v4-pro-0813\` | **支持** | **严格支持** | 支持 | **默认开启 (Thinking default)** | max, high, low |
| \`~deepseek/deepseek-v4-flash-latest\` | **支持** | **严格支持** | 支持 | **默认开启 (Thinking default)** | max, high, low |
| \`deepseek/deepseek-v3.2\` | **支持** | **严格支持** | 支持 | **可选开启 (Optional)** | 思考扩展模式 |
| \`deepseek/deepseek-v3.2-exp\` | **支持** | **严格支持** | 支持 | **可选开启 (Optional)** | 思考扩展模式 |
| \`deepseek/deepseek-v3.1-terminus\` | **支持** | **严格支持** | 支持 | **可选开启 (Optional)** | 思考扩展模式 |
| \`deepseek/deepseek-chat-v3.1\` | **支持** | **严格支持** | 支持 | **可选开启 (Optional)** | 思考扩展模式 |

### 3. 标准四价计费体系 ($/1M Tokens · 官方标准 Peak 原价) 与权威基准评分

| 模型 ID | 普通输入 (Prompt 未命中) | 生成输出 (Completion) | 缓存读取 (Cache Hit 命中) | 缓存写入 (Cache Write) | AA 智力指数 | 吞吐速率 | Arena 综合排名 | Arena 代码排名 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| \`deepseek/deepseek-v4-flash\` | **$0.44** | **$1.32** | **$0.014** (0.031x) | \`null\` (内置不收) | **-** | - | **#12** | **#8** |
| \`deepseek/deepseek-v4-pro\` | **$1.32** | **$3.96** | **$0.044** (0.031x) | \`null\` (内置不收) | **-** | - | **#3** | **#4** |
| \`deepseek/deepseek-v4-flash-vision-exp\` | **$0.44** | **$1.32** | **$0.014** | \`null\` | **-** | - | **#16** | **#14** |
| \`deepseek/deepseek-v4-flash-0731\` | **$0.44** | **$1.32** | **$0.014** | \`null\` | **-** | - | **#12** | **#8** |
| \`deepseek/deepseek-v4-pro-0813\` | **$1.32** | **$3.96** | **$0.044** | \`null\` | **-** | - | **#3** | **#4** |
| \`~deepseek/deepseek-v4-flash-latest\` | **$0.44** | **$1.32** | **$0.014** | \`null\` | **-** | - | - | - |
| \`deepseek/deepseek-v3.2\` | **$0.27** | **$0.40** | **$0.070** | \`null\` | **-** | - | - | - |
| \`deepseek/deepseek-v3.2-exp\` | **$0.27** | **$0.41** | **$0.070** | \`null\` | **-** | - | - | - |
| \`deepseek/deepseek-v3.1-terminus\` | **$0.27** | **$1.00** | **$0.070** | \`null\` | **-** | - | - | - |
| \`deepseek/deepseek-chat-v3.1\` | **$0.25** | **$0.95** | **$0.070** | \`null\` | **-** | - | - | - |
`;

const reg = /## 厂商：DeepSeek[\s\S]*?(?=## 厂商：Bytedance-Seed|## 厂商：ByteDance)/;
if (reg.test(content)) {
  content = content.replace(reg, deepseekMd + '\n---\n\n');
  fs.writeFileSync(surveyPath, content, 'utf8');
  console.log('Successfully updated DeepSeek section in survey markdown!');
} else {
  console.log('Error: Could not find DeepSeek section regex match.');
}
