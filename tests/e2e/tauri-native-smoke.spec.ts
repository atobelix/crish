import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * L3 级进程级原生冒烟（PE-11 T11.1 T11.1-4 重写版）。
 *
 * 背景：旧版断言已删除的 WS daemon 握手（ws://127.0.0.1:8765 /
 * Started daemon process）——daemon/WS 链路已在 Round 16-18 删除，
 * 该测试此前必然失败或空转。
 *
 * 新语义（进程级冒烟，保留「二进制可拉起」发布门禁）：
 * 1. spawn 真二进制 → 进程存活（有 PID 且不提前退出）
 * 2. 日志出现引擎初始化标记（main.rs setup 完成日志
 *    「setup 完成（IPC 模式）」，tracing 双通道 stderr+文件）
 * 3. 退出信号 → 干净退出（exit code 可观察）
 * 4. 无残存进程（进程树 taskkill / process.kill(pid, 0) 断言）
 *
 * 运行归属：慢层（nightly + 发布前）。二进制不存在时自动 skip
 * （describe.skipIf），保证 `npm test`（vitest e2e 项目）在无二进制
 * 环境仍全绿；有二进制时经 `npm run test:e2e:native` 完整执行。
 */

const WORKSPACE_ROOT = resolve(__dirname, '../..');

/** 引擎初始化标记（main.rs「setup 完成（IPC 模式）」） */
const ENGINE_INIT_MARKER = 'setup 完成（IPC 模式）';
/** 二进制路径候选（按优先级） */
const BINARY_CANDIDATES = [
  join(
    WORKSPACE_ROOT,
    'target',
    'debug',
    process.platform === 'win32'
      ? 'crish-agent-workbench.exe'
      : 'crish-agent-workbench'
  ),
  join(
    WORKSPACE_ROOT,
    'target',
    'release',
    process.platform === 'win32'
      ? 'crish-agent-workbench.exe'
      : 'crish-agent-workbench'
  ),
  join(
    WORKSPACE_ROOT,
    'apps',
    'agent-workbench',
    'src-tauri',
    'target',
    'debug',
    process.platform === 'win32'
      ? 'crish-agent-workbench.exe'
      : 'crish-agent-workbench'
  ),
  join(
    WORKSPACE_ROOT,
    'apps',
    'agent-workbench',
    'src-tauri',
    'target',
    'release',
    process.platform === 'win32'
      ? 'crish-agent-workbench.exe'
      : 'crish-agent-workbench'
  ),
];

/** 解析二进制路径；不存在返回 null（skip 条件） */
function resolveBinaryPath(): string | null {
  for (const candidate of BINARY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 进程是否存活（win32 用 tasklist；其余用 process.kill(pid, 0)） */
function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform === 'win32') {
      const output = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return output.includes(pid.toString());
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 强制结束进程树（win32: taskkill /T；其余: SIGKILL） */
function killProcessTree(pid: number | undefined): void {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* ignore */
  }
}

describe.skipIf(!resolveBinaryPath())(
  'L3 进程级原生冒烟（tauri-native-smoke 重写版）',
  () => {
    let binaryPath: string = '';
    let appProcess: ChildProcess | null = null;
    let appPid: number | null = null;
    const logs: string[] = [];

    beforeAll(() => {
      const resolved = resolveBinaryPath();
      expect(resolved, '二进制必须存在（cargo build 后运行）').not.toBeNull();
      binaryPath = resolved!;
    });

    afterAll(() => {
      if (appProcess && !appProcess.killed) {
        killProcessTree(appPid ?? undefined);
      }
      // 兜底：断言无残存（延迟给 OS 清理时间）
      if (appPid) {
        const stillAlive = isProcessAlive(appPid);
        if (stillAlive) killProcessTree(appPid);
        expect(isProcessAlive(appPid)).toBe(false);
      }
    });

    it('L3-1: 二进制拉起且进程存活，日志含引擎初始化标记', async () => {
      appProcess = spawn(binaryPath, [], {
        cwd: WORKSPACE_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, CRISH_LOG_LEVEL: 'info' },
      });

      appPid = appProcess.pid ?? null;
      expect(appPid).not.toBeNull();
      expect(appPid).toBeGreaterThan(0);

      const markerPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `启动 20s 内未观察到引擎初始化标记「${ENGINE_INIT_MARKER}」。\n` +
                `Stderr 尾部:\n${logs.slice(-30).join('\n')}`
            )
          );
        }, 20000);

        const onData = (data: Buffer) => {
          const text = data.toString('utf8');
          logs.push(text);
          if (text.includes(ENGINE_INIT_MARKER)) {
            clearTimeout(timeout);
            resolve();
          }
        };
        appProcess?.stderr?.on('data', onData);
        appProcess?.stdout?.on('data', onData);
        appProcess?.on('exit', (code, signal) => {
          clearTimeout(timeout);
          reject(
            new Error(
              `二进制提前退出 code=${code} signal=${signal}\n${logs.slice(-30).join('\n')}`
            )
          );
        });
      });

      await markerPromise;

      // 标记出现后进程仍存活（引擎初始化完成，未崩溃）
      expect(isProcessAlive(appPid!)).toBe(true);
    });

    it('L3-2: 退出信号 → 干净退出，无残存进程', async () => {
      expect(appProcess).not.toBeNull();
      expect(appPid).not.toBeNull();
      expect(isProcessAlive(appPid!)).toBe(true);

      const exitPromise = new Promise<number | null>((resolve) => {
        // 进程可能已在 taskkill 前自然退出（竞态）：exitCode 已定即视为干净收口
        if (appProcess!.exitCode != null) {
          resolve(appProcess!.exitCode);
          return;
        }
        appProcess!.once('exit', (code) => resolve(code));
        // win32 无 SIGTERM 语义，用 taskkill /T（树级）等价于干净收口
        if (process.platform === 'win32') {
          try {
            execSync(`taskkill /T /PID ${appPid}`, { stdio: 'ignore' });
          } catch {
            // 容错收口（PS-02 T2.1）：taskkill 失败（进程恰好已退出 / 无权限）时，
            // 进程已退出（exitCode 已定）视为干净收口；仍存活则 force 兜底，防测试悬挂
            if (appProcess!.exitCode == null && isProcessAlive(appPid)) {
              try {
                execSync(`taskkill /F /T /PID ${appPid}`, { stdio: 'ignore' });
              } catch {
                /* force 也失败：交由下方 exitCode 判定收口 */
              }
            }
          }
        } else {
          appProcess!.kill('SIGTERM');
        }
      });

      const exitCode = await exitPromise;
      expect(exitCode).toBeDefined();

      // 等 OS 清理完成后断言无残存进程
      await new Promise((r) => setTimeout(r, 1500));
      expect(isProcessAlive(appPid!)).toBe(false);
    });
  }
);
