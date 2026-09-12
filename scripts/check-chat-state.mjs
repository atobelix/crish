#!/usr/bin/env node
/**
 * 检查聊天状态和 daemon 日志
 */
import { spawn } from 'node:child_process';

const MCP_SERVER_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const MCP_SERVER_ARGS = ['-y', 'tauri-plugin-mcp-server'];
const MCP_ENV = {
  ...process.env,
  TAURI_MCP_CONNECTION_TYPE: 'tcp',
  TAURI_MCP_TCP_PORT: '4000',
};

let msgId = 0;
let buffer = '';
const pending = new Map();

function startServer() {
  const child = spawn(MCP_SERVER_CMD, MCP_SERVER_ARGS, {
    env: MCP_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  });

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      } catch {
        process.stderr.write(`[parse-error] ${line}\n`);
      }
    }
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(`[mcp-stderr] ${data}`);
  });

  return child;
}

function send(child, method, params) {
  const id = ++msgId;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(msg);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }
    }, 30000);
  });
}

async function callTool(child, name, args = {}) {
  return await send(child, 'tools/call', { name, arguments: args });
}

async function main() {
  const child = startServer();

  try {
    await send(child, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-monitor', version: '1.0' },
    });

    // Check daemon logs for errors
    const logs = await callTool(child, 'query_logs', { limit: 50, level: 'warn' });
    const logsText = logs?.result?.content?.[0]?.text || '';
    console.log('[daemon-logs]');
    console.log(logsText);

    // Check chat messages - more robust version
    const chatState = await callTool(child, 'execute_js', {
      code: `(() => {
        try {
          // Find all message rows
          const rows = document.querySelectorAll('[class*="msg-row"], [class*="message-row"], [class*="row_"]');
          const results = [];
          rows.forEach((row, i) => {
            if (i < 15) {
              const text = (row.textContent || '').slice(0, 300);
              const cls = typeof row.className === 'string' ? row.className.slice(0, 120) : '';
              const isUser = cls.includes('User') || cls.includes('user');
              const isAssistant = cls.includes('Assistant') || cls.includes('assistant') || cls.includes('ai');
              results.push({ i, isUser, isAssistant, text: text.trim() });
            }
          });
          return JSON.stringify({ count: rows.length, rows: results });
        } catch(e) {
          return JSON.stringify({ error: e.message });
        }
      })()`
    });
    console.log('\n[chat-state]');
    console.log(chatState?.result?.content?.[0]?.text);

    // Check for tool-call indicators
    const toolState = await callTool(child, 'execute_js', {
      code: `(() => {
        try {
          const allText = document.body.innerText || '';
          const toolIndicators = {
            hasToolCall: allText.includes('tool') || allText.includes('工具'),
            hasFileRead: allText.includes('read') || allText.includes('读取') || allText.includes('Read'),
            hasListFiles: allText.includes('ls') || allText.includes('目录') || allText.includes('Glob'),
            hasGitStatus: allText.includes('git') || allText.includes('commit'),
            isProcessing: allText.includes('思考') || allText.includes('处理') || allText.includes('正在') || allText.includes('thinking'),
            errors: []
          };
          if (allText.includes('asyncIterator')) toolIndicators.errors.push('asyncIterator');
          if (allText.includes('run-terminal-failed')) toolIndicators.errors.push('run-terminal-failed');
          if (allText.includes('这一轮没有顺利完成')) toolIndicators.errors.push('round-failure');
          if (allText.includes('Cannot read properties of undefined')) toolIndicators.errors.push('undefined-read');
          return JSON.stringify(toolIndicators);
        } catch(e) {
          return JSON.stringify({ error: e.message });
        }
      })()`
    });
    console.log('\n[tool-state]');
    console.log(toolState?.result?.content?.[0]?.text);

  } finally {
    child.stdin.end();
    child.kill();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
