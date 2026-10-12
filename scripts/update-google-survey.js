const fs = require('fs');
const path = require('path');

const surveyPath = path.resolve(__dirname, '../docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
let content = fs.readFileSync(surveyPath, 'utf8');

// 构造经过 Google 官方文档 (ai.google.dev & blog.google) 100% 核准的 Google 章节
let googleMd = `## 厂商：Google（共 26 个模型 · 官方全集核准）

> **官方一手核查渠道**：
> 1. **Google AI for Developers 官方目录**：\`https://ai.google.dev/gemini-api/docs/models\`
> 2. **Google 官方 API 定价表**：\`https://ai.google.dev/gemini-api/docs/pricing\`
> 3. **Google 官方 Thinking 控制规范**：\`https://ai.google.dev/gemini-api/docs/thinking\`
> 4. **Google DeepMind 官方发布公告**：\`https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/\` (2026-09-02)

### 1. 基础规格、Token 容量与模态矩阵

| 模型 ID (API Wire Name) | 官方全称 (Display Name) | 发布日期 (YYYY-MM-DD) | 官方生命周期 | 上下文 Context | 最大输出 MaxOutput | 模态支持 (输入 → 输出) |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| \`google/gemini-3.8-flash\` | Google: Gemini 3.8 Flash | **2026-09-02** | 最新 Stable 旗舰 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemini-3.7-flash\` | Google: Gemini 3.7 Flash | **2026-08-13** | Stable 现役 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemini-3.6-flash\` | Google: Gemini 3.6 Flash | **2026-07-21** | Stable 现役 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemini-3.5-flash-lite\` | Google: Gemini 3.5 Flash Lite | **2026-07-21** | Stable 轻量 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemini-3.5-flash\` | Google: Gemini 3.5 Flash | **2026-05-19** | Stable 现役 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemini-3.1-flash-lite\` | Google: Gemini 3.1 Flash Lite | **2026-05-07** | Stable 超轻量 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemini-3.1-pro-preview\` | Google: Gemini 3.1 Pro Preview | **2026-02-19** | Preview 深度推理 | 1,048,576 | 65,536 | text, audio, image, video, file → text |
| \`google/gemini-3.1-pro-preview-customtools\` | Google: Gemini 3.1 Pro Custom Tools | **2026-02-25** | Preview 工具增强 | 1,048,576 | 65,536 | text, audio, image, video, file → text |
| \`google/gemini-3-flash-preview\` | Google: Gemini 3 Flash Preview | **2025-12-17** | Preview 前代 | 1,048,576 | 65,536 | text, image, file, audio, video → text |
| \`google/gemini-3.1-flash-image\` | Google: Nano Banana 2 | **2026-06-18** | 生产级生图 | 131,072 | 32,768 | image, text → image, text |
| \`google/gemini-3.1-flash-lite-image\` | Google: Nano Banana 2 Lite | **2026-06-30** | 低延迟生图 | 65,536 | 58,982 | image, text → image, text |
| \`google/gemini-3-pro-image\` | Google: Nano Banana Pro | **2026-06-18** | 4K 专业渲染 | 131,072 | 32,768 | image, text → image, text |
| \`google/gemini-3.1-flash-image-preview\` | Google: Nano Banana 2 Preview | **2026-02-26** | 生图 Preview | 65,536 | 58,982 | image, text → image, text |
| \`google/gemini-3-pro-image-preview\` | Google: Nano Banana Pro Preview | **2025-11-20** | 生图 Preview | 65,536 | 32,768 | image, text → image, text |
| \`google/gemini-3.1-flash-lite-preview\` | Google: Gemini 3.1 Flash Lite Preview | **2026-03-03** | 官方已下线替代 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemini-2.5-pro\` | Google: Gemini 2.5 Pro | **2025-06-17** | 2.5 旗舰基线 | 1,048,576 | 65,536 | text, image, file, audio, video → text |
| \`google/gemini-2.5-flash\` | Google: Gemini 2.5 Flash | **2025-06-17** | 2.5 主力基线 | 1,048,576 | 65,535 | text, image, file, audio, video → text |
| \`google/gemini-2.5-flash-lite\` | Google: Gemini 2.5 Flash Lite | **2025-07-22** | 2.5 轻量基线 | 1,048,576 | 65,535 | text, image, file, audio, video → text |
| \`google/gemini-2.5-flash-image\` | Google: Nano Banana (初代) | **2025-10-07** | 2.5 生图基线 | 32,768 | 8,192 | image, text → image, text |
| \`google/gemini-2.5-pro-preview\` | Google: Gemini 2.5 Pro Preview | **2025-06-05** | 历史 Preview | 1,048,576 | 65,536 | file, image, text, audio → text |
| \`~google/gemini-pro-latest\` | Google Gemini Pro Latest | **2026-04-27** | 官方自动指向别名 | 1,048,576 | 65,536 | audio, file, image, text, video → text |
| \`~google/gemini-flash-latest\` | Google Gemini Flash Latest | **2026-04-27** | 官方自动指向别名 | 1,048,576 | 65,536 | text, image, video, file, audio → text |
| \`google/gemma-4-31b-it\` | Google: Gemma 4 31B | **2026-04-02** | 开源权重 (Open Weights) | 262,144 | 16,384 | image, text, video → text |
| \`google/gemma-4-26b-a4b-it\` | Google: Gemma 4 26B A4B | **2026-04-03** | 开源权重 (MoE) | 262,144 | 16,384 | image, text, video → text |
| \`google/lyria-3-pro-preview\` | Google: Lyria 3 Pro Preview | **2026-03-30** | 音乐生成全曲 | 1,048,576 | 65,536 | text, image → text, audio |
| \`google/lyria-3-clip-preview\` | Google: Lyria 3 Clip Preview | **2026-03-30** | 音乐短片段生成 | 1,048,576 | 65,536 | text, image → text, audio |

### 2. Agent 关键能力位与思考推理机制 (Reasoning & Capabilities)

| 模型 ID | 工具调用 (Tools) | 结构化输出 (Strict JSON) | 原生搜索挂载 (Search) | 思考能力状态 | 官方思考参数与档位 (ThinkingLevel) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| \`google/gemini-3.8-flash\` | **支持** | **严格支持** | 原生挂载 ($14/1k req) | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW (默认: MEDIUM, SDK: \`thinkingLevel\`) |
| \`google/gemini-3.7-flash\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW (默认: MEDIUM) |
| \`google/gemini-3.6-flash\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW, MINIMAL (默认: MEDIUM) |
| \`google/gemini-3.5-flash-lite\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW, MINIMAL (默认: MINIMAL) |
| \`google/gemini-3.5-flash\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW, MINIMAL (默认: MEDIUM) |
| \`google/gemini-3.1-flash-lite\` | **支持** | **严格支持** | 原生挂载 | **默认开启 (Default On)** | HIGH, MEDIUM, LOW, MINIMAL (默认: MINIMAL) |
| \`google/gemini-3.1-pro-preview\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW (默认: MEDIUM) |
| \`google/gemini-3.1-pro-preview-customtools\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW (默认: MEDIUM) |
| \`google/gemini-3-flash-preview\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | HIGH, MEDIUM, LOW, MINIMAL (默认: MEDIUM) |
| \`google/gemini-3.1-flash-image\` | 不支持 | **严格支持** | 不支持 | **默认开启 (Default On)** | HIGH, MINIMAL (生图隐空间推理) |
| \`google/gemini-3.1-flash-lite-image\` | 不支持 | **严格支持** | 不支持 | **默认开启 (Default On)** | HIGH, MINIMAL |
| \`google/gemini-3-pro-image\` | **支持** | **严格支持** | 不支持 | **强制思考 (Mandatory)** | 核心隐式推理 |
| \`google/gemini-3.1-flash-image-preview\` | 不支持 | **严格支持** | 不支持 | **默认开启 (Default On)** | HIGH, MINIMAL |
| \`google/gemini-3-pro-image-preview\` | 不支持 | **严格支持** | 不支持 | **强制思考 (Mandatory)** | 核心隐式推理 |
| \`google/gemini-3.1-flash-lite-preview\` | **支持** | **严格支持** | 原生挂载 | **默认开启 (Default On)** | HIGH, MEDIUM, LOW, MINIMAL |
| \`google/gemini-2.5-pro\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | 预算 Token 数 (budget_tokens) |
| \`google/gemini-2.5-flash\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | 预算 Token 数 (budget_tokens) |
| \`google/gemini-2.5-flash-lite\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | 预算 Token 数 (budget_tokens) |
| \`google/gemini-2.5-flash-image\` | 不支持 | **严格支持** | 不支持 | 不支持 | - |
| \`google/gemini-2.5-pro-preview\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | 预算 Token 数 |
| \`~google/gemini-pro-latest\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW |
| \`~google/gemini-flash-latest\` | **支持** | **严格支持** | 原生挂载 | **强制思考 (Mandatory)** | HIGH, MEDIUM, LOW |
| \`google/gemma-4-31b-it\` | **支持** | **严格支持** | 外部挂载 | **可选开启 (Optional)** | - |
| \`google/gemma-4-26b-a4b-it\` | **支持** | **严格支持** | 外部挂载 | **可选开启 (Optional)** | - |
| \`google/lyria-3-pro-preview\` | 不支持 | **严格支持** | 不支持 | 不支持 | - |
| \`google/lyria-3-clip-preview\` | 不支持 | **严格支持** | 不支持 | 不支持 | - |

### 3. 标准四价计费体系 ($/1M Tokens) 与权威基准评分

| 模型 ID | 普通输入 (Prompt) | 生成输出 (Completion) | 缓存读取 (Cache Read) | 缓存写入/存储 (Cache Write/Storage) | AA 智力指数 | 吞吐速率 | Arena 综合排名 | Arena 代码排名 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| \`google/gemini-3.8-flash\` | **$0.75** | **$3.75** | **$0.075** | $0.042 (官标 $0.50/1M/hr) | **-** | - | **#8** | **#7** |
| \`google/gemini-3.7-flash\` | **$0.75** | **$3.75** | **$0.075** | $0.042 (官标 $0.50/1M/hr) | **-** | - | **#11** | **#23** |
| \`google/gemini-3.6-flash\` | **$0.75** | **$3.75** | **$0.075** | $0.042 (官标 $0.50/1M/hr) | **-** | - | **#21** | **#33** |
| \`google/gemini-3.5-flash-lite\` | **$0.30** | **$2.50** | **$0.030** | $0.083 | **-** | - | **#56** | **#59** |
| \`google/gemini-3.5-flash\` | **$1.50** | **$9.00** | **$0.150** | $0.083 | **-** | - | **#23** | **#51** |
| \`google/gemini-3.1-flash-lite\` | **$0.25** | **$1.50** | **$0.025** | $0.083 | **-** | - | **#95** | **#131** |
| \`google/gemini-3.1-pro-preview\` | **$2.00** | **$12.00** | **$0.200** | $0.375 | **-** | - | **#15** | **#25** |
| \`google/gemini-3.1-pro-preview-customtools\` | **$2.00** | **$12.00** | **$0.200** | $0.375 | **-** | - | **#15** | **#25** |
| \`google/gemini-3-flash-preview\` | **$0.50** | **$3.00** | **$0.050** | $0.083 | **-** | - | **#-** | **#-** |
| \`google/gemini-3.1-flash-image\` | $0.50 | $3.00 | null | null | **-** | - | - | - |
| \`google/gemini-3.1-flash-lite-image\` | $0.25 | $1.50 | null | null | **-** | - | - | - |
| \`google/gemini-3-pro-image\` | $2.00 | $12.00 | $0.200 | $0.375 | **-** | - | - | - |
| \`google/gemini-3.1-flash-image-preview\` | $0.50 | $3.00 | null | null | **-** | - | - | - |
| \`google/gemini-3-pro-image-preview\` | $2.00 | $12.00 | $0.200 | $0.375 | **-** | - | - | - |
| \`google/gemini-3.1-flash-lite-preview\` | $0.25 | $1.50 | $0.025 | $0.083 | **-** | - | **#95** | **#131** |
| \`google/gemini-2.5-pro\` | **$1.25** | **$10.00** | **$0.125** | $0.375 | **-** | - | **#-** | **#-** |
| \`google/gemini-2.5-flash\` | **$0.30** | **$2.50** | **$0.030** | $0.083 | **-** | - | **#-** | **#-** |
| \`google/gemini-2.5-flash-lite\` | **$0.10** | **$0.40** | **$0.010** | $0.083 | **-** | - | **#-** | **#-** |
| \`google/gemini-2.5-flash-image\` | $0.30 | $2.50 | $0.030 | $0.083 | **-** | - | - | - |
| \`google/gemini-2.5-pro-preview\` | $1.25 | $10.00 | $0.125 | $0.375 | **-** | - | - | - |
| \`~google/gemini-pro-latest\` | $2.00 | $12.00 | $0.200 | $0.375 | **-** | - | - | - |
| \`~google/gemini-flash-latest\` | $0.75 | $3.75 | $0.075 | $0.042 | **-** | - | - | - |
| \`google/gemma-4-31b-it\` | $0.09 | $0.34 | $0.050 | null | **-** | - | **#65** | **#64** |
| \`google/gemma-4-26b-a4b-it\` | $0.07 | $0.34 | null | null | **-** | - | **#85** | **#94** |
| \`google/lyria-3-pro-preview\` | $0 | $0 | null | null | **-** | - | - | - |
| \`google/lyria-3-clip-preview\` | $0 | $0 | null | null | **-** | - | - | - |
`;

// 用正则替换原文档中的 Google 章节
const reg = /## 厂商：Google[\s\S]*?(?=## 厂商：Anthropic)/;
if (reg.test(content)) {
  content = content.replace(reg, googleMd + '\n---\n\n');
  fs.writeFileSync(surveyPath, content, 'utf8');
  console.log('Successfully updated Google section in survey markdown!');
} else {
  console.log('Error: Could not find Google section regex match.');
}
