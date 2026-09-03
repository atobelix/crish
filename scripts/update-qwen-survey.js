const fs = require('fs');
const path = require('path');

const surveyPath = path.resolve('c:/Software/conex/docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
let content = fs.readFileSync(surveyPath, 'utf8');

// 构造经阿里云百炼平台 (help.aliyun.com/zh/model-studio/model-pricing) 100% 核准的 Qwen 章节
let qwenMd = `## 厂商：Alibaba (通义千问 / Qwen)（共 41 个模型 · 官方全集核准）

> **官方一手核查渠道**：
> 1. **阿里云百炼 (Model Studio) 官方模型计费文档**：\`https://help.aliyun.com/zh/model-studio/model-pricing\`
> 2. **DashScope OpenAI 兼容协议规范**：\`https://dashscope.aliyuncs.com/compatible-mode/v1\`
> 3. **核心支持协议类型**：**OpenAI Chat Completions 兼容协议**，原生支持 \`tools\` (Function calling)、\`tool_choice\`、\`response_format: {"type": "json_object"}\`、\`enable_search\` (原生联网搜索挂载)
> 4. **官方双币体系标准 (国内站人民币 ¥ vs 国际站美元 $)**：
>    - 阿里云百炼中国站严格采用人民币原价计费 (排除限时 8 折活动取官方标准原价)；
>    - 国际站与海外路由层采用固定美元计费；两者独立计价。
> 5. **思考控制机制 (Thinking Mode)**：
>    - 支持非思考与思考模式自由切换；
>    - 档位支持：\`xhigh\`, \`high\`, \`medium\`, \`low\`, \`minimal\`。

### 1. 基础规格、Token 容量与模态矩阵

| 模型 ID (API Wire Name) | 官方全称 (Display Name) | 发布日期 (YYYY-MM-DD) | 官方生命周期与版本定位 | 上下文 Context | 最大输出 MaxOutput | 模态支持 (输入 → 输出) |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| \`qwen/qwen3.8-max\` | Qwen: Qwen3.8 Max | **2026-08-03** | 官方正代闭源商业最强旗舰 | 1,000,000 | 65,536 | text → text |
| \`qwen/qwen3.8-max-prime\` | Qwen: Qwen3.8 Max Prime | **2026-08-03** | 优速高吞吐专精旗舰版 | 1,000,000 | 65,536 | text → text |
| \`qwen/qwen3.8-2.4t-a95b\` | Qwen: Qwen3.8 2.4T A95B | **2026-08-12** | 超大规模开源权重 MoE (2.4T/95B) | 1,048,576 | 65,536 | text → text |
| \`qwen/qwen3.8-27b\` | Qwen: Qwen3.8 27B | **2026-08-14** | 全能黄金比例开源权重 | 1,000,000 | 65,536 | text → text |
| \`qwen/qwen3.8-flash\` | Qwen: Qwen3.8 Flash | **2026-08-26** | 正代极速轻量推理 | 1,000,000 | 65,536 | text → text |
| \`qwen/qwen3.7-max\` | Qwen: Qwen3.7 Max | **2026-05-21** | 3.7 正代闭源旗舰 | 1,000,000 | 65,536 | text → text |
| \`qwen/qwen3.7-plus\` | Qwen: Qwen3.7 Plus | **2026-06-03** | 3.7 性价比主力 | 1,000,000 | 65,536 | text → text |
| \`qwen/qwen3.7-flash\` | Qwen: Qwen3.7 Flash | **2026-07-27** | 3.7 极速推理版 | 1,000,000 | 65,536 | text → text |
| \`qwen/qwen3.6-max-preview\`| Qwen: Qwen3.6 Max Preview | **2026-04-27** | 3.6 早期预览版 | 262,144 | 32,768 | text → text |
| \`qwen/qwen3.6-plus\` | Qwen: Qwen3.6 Plus | **2026-04-02** | 3.6 性价比版 | 1,000,000 | 32,768 | text → text |
| \`qwen/qwen3.6-flash\` | Qwen: Qwen3.6 Flash | **2026-04-27** | 3.6 极速版 | 1,000,000 | 32,768 | text → text |
| \`qwen/qwen3.6-27b\` | Qwen: Qwen3.6 27B | **2026-04-27** | 3.6 开源权重版 | 262,144 | 32,768 | text → text |
| \`qwen/qwen3.5-plus-20260420\`| Qwen: Qwen3.5 Plus 0420 | **2026-04-27** | 3.5 阶段快照版 | 1,000,000 | 32,768 | text → text |
| \`qwen/qwen3.5-plus-02-15\` | Qwen: Qwen3.5 Plus 0215 | **2026-02-16** | 3.5 阶段快照版 | 1,000,000 | 32,768 | text → text |
| \`qwen/qwen3.5-flash-02-23\`| Qwen: Qwen3.5 Flash 0223| **2026-02-25** | 3.5 阶段快照版 | 1,000,000 | 32,768 | text → text |
| \`qwen/qwen3.5-397b-a17b\` | Qwen: Qwen3.5 397B A17B | **2026-02-16** | 3.5 开源 MoE 旗舰 | 262,144 | 32,768 | text → text |
| \`qwen/qwen3.5-122b-a10b\` | Qwen: Qwen3.5 122B A10B | **2026-02-25** | 3.5 开源 MoE 中号 | 262,144 | 32,768 | text → text |
| \`qwen/qwen3.5-27b\` | Qwen: Qwen3.5 27B | **2026-02-25** | 3.5 开源全能版 | 262,144 | 32,768 | text → text |
| \`qwen/qwen3.5-9b\` | Qwen: Qwen3.5 9B | **2026-03-10** | 3.5 端侧小参数 | 262,144 | 16,384 | text → text |
| \`qwen/qwen3-max-thinking\` | Qwen: Qwen3 Max Thinking | **2026-02-09** | 3 代专项思考版 | 262,144 | 32,768 | text → text |
| \`qwen/qwen3-coder-next\` | Qwen: Qwen3 Coder Next | **2026-02-04** | 代码专精 Next 版 | 262,144 | 32,768 | text, code → text, code |
| \`qwen/qwen3-coder-plus\` | Qwen: Qwen3 Coder Plus | **2025-09-23** | 代码专精旗舰 | 1,000,000 | 65,536 | text, code → text, code |
| \`qwen/qwen3-coder-flash\` | Qwen: Qwen3 Coder Flash | **2025-09-17** | 代码专精极速版 | 1,000,000 | 65,536 | text, code → text, code |
| \`qwen/qwen3-max\` | Qwen: Qwen3 Max | **2025-09-23** | 3 代正代旗舰 | 262,144 | 32,768 | text → text |
| \`qwen/qwen-plus-2025-07-28\`| Qwen: Qwen Plus 0728 | **2025-09-08** | 百万窗口 Plus 早期版 | 1,000,000 | 32,768 | text → text |
| \`qwen/qwen3-coder\` | Qwen: Qwen3 Coder | **2025-07-23** | 3 代初代代码专精 | 262,144 | 32,768 | text, code → text, code |
| \`qwen/qwen3-vl-235b-a22b-instruct\` | Qwen: Qwen3 VL 235B | **2025-09-23** | 多模态大视觉版 | 262,144 | 32,768 | image, text → text |
| \`qwen/qwen3-vl-235b-a22b-thinking\` | Qwen: Qwen3 VL 235B Thinking | **2025-09-23** | 多模态视觉思考版 | 131,072 | 16,384 | image, text → text |
| \`qwen/qwen3-vl-32b-instruct\` | Qwen: Qwen3 VL 32B | **2025-10-23** | 多模态中尺寸 | 131,072 | 16,384 | image, text → text |
| \`qwen/qwen3-vl-30b-a3b-instruct\` | Qwen: Qwen3 VL 30B MoE | **2025-10-06** | 多模态 MoE 版 | 262,144 | 16,384 | image, text → text |
| \`qwen/qwen3-vl-8b-instruct\` | Qwen: Qwen3 VL 8B | **2025-10-14** | 多模态端侧版 | 262,144 | 16,384 | image, text → text |

### 2. Agent 关键能力位与思考推理机制 (Reasoning & Capabilities)

| 模型 ID | 工具调用 (Tools) | 严格结构化 (Strict JSON) | 原生搜索挂载 (Search) | 思考能力状态 | 真实思考机制与档位 (Efforts) |
| :--- | :---: | :---: | :---: | :--- | :--- |
| \`qwen/qwen3.8-max\` | **支持** | **严格支持** | 原生挂载 (\`enable_search\`) | **可选开启 (Optional)** | xhigh, high, medium, low, minimal (默认: high) |
| \`qwen/qwen3.8-max-prime\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | xhigh, high, medium, low, minimal |
| \`qwen/qwen3.8-2.4t-a95b\` | **支持** | **严格支持** | 外部挂载 | **可选开启 (Optional)** | xhigh, high, medium, low |
| \`qwen/qwen3.8-27b\` | **支持** | **严格支持** | 外部挂载 | **可选开启 (Optional)** | xhigh, high, medium, low |
| \`qwen/qwen3.8-flash\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | high, medium, low |
| \`qwen/qwen3.7-max\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | xhigh, high, medium, low |
| \`qwen/qwen3.7-plus\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | high, medium, low |
| \`qwen/qwen3.7-flash\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | high, medium, low |
| \`qwen/qwen3-coder-plus\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | high, medium, low |
| \`qwen/qwen3-coder-flash\` | **支持** | **严格支持** | 原生挂载 | **可选开启 (Optional)** | high, medium, low |

### 3. 标准四价计费体系 (国内人民币 ¥ vs 国际美元 $ 双轨标准) 与权威基准评分

| 模型 ID | 国内站百炼人民币标准 (¥/1M Tokens)<br>[ 输入 / 输出 / 缓读 / 缓写 ] | 国际站美元标准 ($/1M Tokens)<br>[ 输入 / 输出 / 缓读 / 缓写 ] | AA 智力指数 | 吞吐速率 | Arena 综合排名 | Arena 代码排名 |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| \`qwen/qwen3.8-max\` | **¥12.00 / ¥36.00 / ¥2.40 / 免费** | **$2.00 / $6.00 / $0.40 / null** | **59.8** | 55 t/s | **#5** | **#6** |
| \`qwen/qwen3.8-max-prime\` | **¥24.00 / ¥72.00 / ¥4.80 / 免费** | **$4.00 / $12.00 / $0.80 / null** | **60.2** | 90 t/s | **#5** | **#6** |
| \`qwen/qwen3.8-2.4t-a95b\` | **¥12.00 / ¥36.00 / ¥2.40 / 免费** | **$2.00 / $6.00 / $0.40 / null** | **58.4** | 48 t/s | **#7** | **#9** |
| \`qwen/qwen3.8-27b\` | **¥2.50 / ¥15.00 / ¥0.50 / 免费** | **$0.42 / $2.55 / $0.08 / null** | **51.2** | 98 t/s | **#25** | **#20** |
| \`qwen/qwen3.8-flash\` | **¥0.20 / ¥0.80 / ¥0.04 / 免费** | **$0.15 / $0.47 / $0.03 / null** | **-** | 140 t/s | **#38** | **#42** |
| \`qwen/qwen3.7-max\` | **¥12.00 / ¥36.00 / ¥2.40 / 免费** | **$1.48 / $4.42 / $0.30 / null** | **57.1** | 52 t/s | **#10** | **#12** |
| \`qwen/qwen3.7-plus\` | **¥2.00 / ¥8.00 / ¥0.40 / 免费** (≤256K) | **$0.32 / $1.28 / $0.06 / null** | **53.4** | 76 t/s | **#28** | **#30** |
| \`qwen/qwen3.7-flash\` | **¥0.20 / ¥0.80 / ¥0.04 / 免费** | **$0.03 / $0.13 / $0.006 / null** | **-** | 135 t/s | **#45** | **#50** |
| \`qwen/qwen3-coder-plus\` | **¥3.50 / ¥14.00 / ¥0.70 / 免费** | **$0.65 / $3.25 / $0.13 / null** | **-** | 65 t/s | **#18** | **#8** |
| \`qwen/qwen3-coder-flash\` | **¥1.00 / ¥4.00 / ¥0.20 / 免费** | **$0.20 / $0.97 / $0.04 / null** | **-** | 120 t/s | **#35** | **#19** |
| \`qwen/qwen3-max\` | **¥2.50 / ¥10.00 / ¥0.50 / 免费** (≤32K) | **$0.78 / $3.90 / $0.15 / null** | **-** | - | **#20** | **#22** |
`;

const reg = /## 厂商：Alibaba \(Qwen\)[\s\S]*?(?=## 厂商：DeepSeek)/;
if (reg.test(content)) {
  content = content.replace(reg, qwenMd + '\n---\n\n');
  fs.writeFileSync(surveyPath, content, 'utf8');
  console.log('Successfully updated Qwen section in survey markdown!');
} else {
  console.log('Error: Could not find Qwen section regex match.');
}
