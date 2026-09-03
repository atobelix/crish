const fs = require('fs');
const path = require('path');

const surveyPath = path.resolve('c:/Software/conex/docs/model-capability/surveys/01-主流模型多源权威数据全景调研.md');
let content = fs.readFileSync(surveyPath, 'utf8');

// 构造双币版 DeepSeek 表格 3
let newPricingTable = `### 3. 标准四价计费体系 (国内人民币 ¥ vs 国际美元 $ 双轨标准) 与权威基准评分

> **双轨定价说明**：根据 DeepSeek 官方中英文双站核对，国内站与国际站实行独立定价政策（非简单浮动汇率折算）。以下价格均为官方高峰时段 (Peak) 标准全价：

| 模型 ID | 国内站人民币体系 (¥/1M Tokens)<br>[ 输入 / 输出 / 缓读 / 缓写 ] | 国际站美元体系 ($/1M Tokens)<br>[ 输入 / 输出 / 缓读 / 缓写 ] | AA 智力指数 | 吞吐速率 | Arena 综合排名 | Arena 代码排名 |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| \`deepseek/deepseek-v4-flash\` | **¥3.00 / ¥9.00 / ¥0.10 / 免费** | **$0.44 / $1.32 / $0.014 / null** | **-** | - | **#12** | **#8** |
| \`deepseek/deepseek-v4-pro\` | **¥9.00 / ¥27.00 / ¥0.30 / 免费** | **$1.32 / $3.96 / $0.044 / null** | **-** | - | **#3** | **#4** |
| \`deepseek/deepseek-v4-flash-vision-exp\` | **¥3.00 / ¥9.00 / ¥0.10 / 免费** | **$0.44 / $1.32 / $0.014 / null** | **-** | - | **#16** | **#14** |
| \`deepseek/deepseek-v4-flash-0731\` | **¥3.00 / ¥9.00 / ¥0.10 / 免费** | **$0.44 / $1.32 / $0.014 / null** | **-** | - | **#12** | **#8** |
| \`deepseek/deepseek-v4-pro-0813\` | **¥9.00 / ¥27.00 / ¥0.30 / 免费** | **$1.32 / $3.96 / $0.044 / null** | **-** | - | **#3** | **#4** |
| \`~deepseek/deepseek-v4-flash-latest\` | **¥3.00 / ¥9.00 / ¥0.10 / 免费** | **$0.44 / $1.32 / $0.014 / null** | **-** | - | - | - |
| \`deepseek/deepseek-v3.2\` | ¥2.00 / ¥8.00 / ¥0.50 / 免费 | $0.27 / $0.40 / $0.070 / null | **-** | - | - | - |
| \`deepseek/deepseek-v3.2-exp\` | ¥2.00 / ¥8.00 / ¥0.50 / 免费 | $0.27 / $0.41 / $0.070 / null | **-** | - | - | - |
| \`deepseek/deepseek-v3.1-terminus\` | ¥2.00 / ¥8.00 / ¥0.50 / 免费 | $0.27 / $1.00 / $0.070 / null | **-** | - | - | - |
| \`deepseek/deepseek-chat-v3.1\` | ¥2.00 / ¥8.00 / ¥0.50 / 免费 | $0.25 / $0.95 / $0.070 / null | **-** | - | - | - |
`;

const reg = /### 3\. 标准四价计费体系 \(\$\/1M Tokens[\s\S]*?(?=---\n\n## 厂商：Bytedance-Seed|---\n\n## 厂商：ByteDance)/;
if (reg.test(content)) {
  content = content.replace(reg, newPricingTable);
  fs.writeFileSync(surveyPath, content, 'utf8');
  console.log('Successfully updated DeepSeek to dual-currency pricing!');
} else {
  console.log('Error: Could not find pricing table regex.');
}
