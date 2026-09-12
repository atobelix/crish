#!/usr/bin/env node
/**
 * scripts/ensure-dev-ports.mjs
 * 
 * 自动检测并清理开发端口（5174 Vite / 4000 Tauri MCP）上的残留僵尸进程。
 * 在 Windows / macOS / Linux 上，若前次开发进程非正常退出导致端口被孤儿 node/crish 进程占用，
 * 本脚本自动识别并杀死孤儿进程，确保 npm run dev:workbench / npm run dev 100% 成功启动。
 */

import { createServer } from 'node:net';
import { execSync } from 'node:child_process';

const TARGET_PORTS = [5174, 4000];
const SAFE_PROCESS_NAMES = ['node', 'node.exe', 'crish-agent-workbench', 'crish-agent-workbench.exe', 'vite'];

async function isPortInUse(port) {
  const checkHost = (host) =>
    new Promise((resolve) => {
      const server = createServer();
      server.once('error', (err) => {
        resolve(err.code === 'EADDRINUSE');
      });
      server.once('listening', () => {
        server.close(() => resolve(false));
      });
      try {
        server.listen(port, host);
      } catch {
        resolve(false);
      }
    });

  const inUse4 = await checkHost('127.0.0.1');
  if (inUse4) return true;
  const inUse6 = await checkHost('::1').catch(() => false);
  return inUse6;
}

function getPidsOnPortWindows(port) {
  try {
    const output = execSync(`netstat -ano`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = output.split('\n');
    const pids = new Set();
    for (const line of lines) {
      if (!line.includes(`:${port}`) || !line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const pidStr = parts[parts.length - 1];
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }
    return Array.from(pids);
  } catch {
    return [];
  }
}

function getPidsOnPortUnix(port) {
  try {
    const output = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return output
      .split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .filter((pid) => !isNaN(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function getProcessNameWindows(pid) {
  try {
    const output = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const firstLine = output.trim().split('\n')[0];
    if (firstLine) {
      const match = firstLine.match(/^"([^"]+)"/);
      if (match) return match[1].toLowerCase();
    }
  } catch {
    // ignore
  }
  return '';
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const isWin = process.platform === 'win32';

  for (const port of TARGET_PORTS) {
    const inUse = await isPortInUse(port);
    const pids = isWin ? getPidsOnPortWindows(port) : getPidsOnPortUnix(port);
    if (!inUse && pids.length === 0) continue;

    let killed = false;
    for (const pid of pids) {
      const procName = isWin ? getProcessNameWindows(pid) : '';
      const isKillable = !procName || SAFE_PROCESS_NAMES.some((name) => procName.includes(name.toLowerCase()));

      if (isKillable) {
        console.log(`[ensure-dev-ports] 端口 ${port} 被残留进程 PID ${pid} (${procName || 'unknown'}) 占用，正在自动清理...`);
        killPid(pid);
        killed = true;
      } else {
        console.warn(`[ensure-dev-ports] 警告: 端口 ${port} 被非开发进程 PID ${pid} (${procName}) 占用，请手动检查。`);
      }
    }
    if (killed) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

main().catch((err) => {
  console.error('[ensure-dev-ports] 错误:', err);
  process.exit(0); // 宽松退出，不阻断正常流程
});
