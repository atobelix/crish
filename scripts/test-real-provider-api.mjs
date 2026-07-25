import { OpenAICompatibleProvider } from '../packages/agent-runtime/dist/index.js';

console.log(`\n=======================================================`);
console.log(`🚀 Conex 真实 LLM API 出站请求测试工具`);
console.log(`=======================================================\n`);

const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
const baseUrl = process.env.BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const model = process.env.MODEL || 'gpt-3.5-turbo';

if (!apiKey) {
  console.log(`⚠️ 未检测到真实 API_KEY 环境变量！`);
  console.log(`💡 使用方法：`);
  console.log(`   Windows (PowerShell):`);
  console.log(`     $env:API_KEY="sk-your-real-key"; $env:BASE_URL="https://api.deepseek.com/v1"; $env:MODEL="deepseek-chat"; node scripts/test-real-provider-api.mjs\n`);
  console.log(`   Linux/macOS:`);
  console.log(`     API_KEY="sk-your-real-key" BASE_URL="https://api.deepseek.com/v1" MODEL="deepseek-chat" node scripts/test-real-provider-api.mjs\n`);
  process.exit(0);
}

console.log(`📡 正在向真实 API 后端发起出站请求...`);
console.log(`   - BaseURL: ${baseUrl}`);
console.log(`   - Model:   ${model}`);
console.log(`   - Key:     ${apiKey.slice(0, 7)}***\n`);

async function testRealApi() {
  try {
    const provider = new OpenAICompatibleProvider({
      id: 'test-real-provider',
      name: 'Test Real Provider',
      baseUrl,
      apiKey,
    });

    const startTime = Date.now();
    const stream = await provider.chatStream({
      model,
      messages: [{ role: 'user', content: 'Say "API Test Success" in 5 words.' }],
    });

    console.log(`✅ 成功建立 HTTP Stream 连接，收到响应 chunk:`);
    let fullText = '';
    for await (const chunk of stream) {
      if (chunk.type === 'content_delta') {
        process.stdout.write(chunk.delta);
        fullText += chunk.delta;
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(`\n\n🎉 真实 API 测试成功！总耗时: ${(durationMs / 1000).toFixed(2)}s`);
    console.log(`请检查您的供应商后台 Dashboard，此时应当已经产生了 1 次真实请求记录！\n`);
  } catch (err) {
    console.error(`❌ 真实 API 请求失败:`, err);
  }
}

testRealApi();
