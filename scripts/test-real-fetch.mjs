const apiKey = process.env.OPENCODE_TEST_API_KEY ?? '';
const baseUrl = 'https://opencode.ai/zen/go/v1';
const model = 'deepseek-v4-flash';

console.log(`\n=======================================================`);
console.log(`📡 发起真实 HTTP POST 请求至: ${baseUrl}/chat/completions`);
console.log(`   - Model: ${model}`);
console.log(`=======================================================\n`);

const res = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: model,
    messages: [
      { role: 'system', content: 'You are a helpful coding assistant.' },
      { role: 'user', content: 'Say "Conex Real API Connected!" in 5 words.' }
    ],
    stream: false,
  }),
});

console.log(`HTTP 状态码: ${res.status} ${res.statusText}`);
const body = await res.json();
console.log(`响应内容:`, JSON.stringify(body, null, 2));
