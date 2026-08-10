// =======================================================================
// mock daemon v0（R0-06）——CLI 参数解析与启动装配
//
// 启动示例：
//   npm run start -- --pair --scenario approval --port 8765 --host 0.0.0.0
// 参数一览：
//   --port <n>           监听端口（默认 8765，对齐网关端口裁决 P-1）
//   --host <addr>        监听地址（默认 127.0.0.1；真机联调用 0.0.0.0）
//   --pair / --no-pair   配对模式开关（默认开；关闭时跳过配对直接握手）
//   --pair-code <码>     配对码（默认 CXN-7K4P-Q2MB-9XRT，格式 CXN-XXXX-XXXX-XXXX）
//   --scenario <id>      夹具场景（idle/approval/run/cache，默认 idle）
//   --loop               场景循环播放（仅 run/cache 可循环；交互式审批不循环）
//   --scenario-speed <倍率>  时间线速度倍率（≤1 加速，0 = 立即发射；测试用）
//   --list               列出可用场景与参数后退出
//   -v / --verbose       调试日志
//   -q / --quiet         只输出错误
//   -h / --help          用法说明
// =======================================================================

import { MockDaemonServer } from './server.js';
import { SCENARIOS, scenarioIds } from './fixtures/index.js';
import { setLogLevel, info, err } from './util.js';

export interface CliOptions {
  host: string;
  port: number;
  pairMode: boolean;
  pairCode: string;
  scenario: 'idle' | 'approval' | 'run' | 'cache';
  loop: boolean;
  scenarioSpeed: number;
  listOnly: boolean;
  help: boolean;
}

/** 从 process.argv 解析（argv[0]=node, argv[1]=脚本；支持 --k v 与 --k=v 两种写法） */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    host: '127.0.0.1',
    port: 8765,
    pairMode: true,
    pairCode: 'CXN-7K4P-Q2MB-9XRT',
    scenario: 'idle',
    loop: false,
    scenarioSpeed: 1,
    listOnly: false,
    help: false,
  };
  const args = argv.slice(2);
  const knownIds = scenarioIds();

  // 取值辅助：读取下一个参数作为值，并消费该 token（调用方必须同时 i += 1）
  const valueOf = (i: number, inline: string | undefined, name: string): string => {
    if (inline !== undefined && inline !== '') return inline;
    const next = args[i + 1];
    if (next === undefined) throw new Error(`参数 ${name} 缺少值`);
    return next;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    switch (name) {
      case '--host':
        opts.host = valueOf(i, inline, name);
        if (inline === undefined) i += 1;
        break;
      case '--port': {
        const raw = valueOf(i, inline, name);
        if (inline === undefined) i += 1;
        opts.port = Number(raw);
        if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
          throw new Error(`--port 非法：${raw}`);
        }
        break;
      }
      case '--pair':
        opts.pairMode = true;
        break;
      case '--no-pair':
        opts.pairMode = false;
        break;
      case '--pair-code':
        opts.pairCode = valueOf(i, inline, name);
        if (inline === undefined) i += 1;
        break;
      case '--scenario': {
        const v = valueOf(i, inline, name);
        if (inline === undefined) i += 1;
        if (!knownIds.includes(v as (typeof knownIds)[number])) {
          throw new Error(`--scenario 非法：${v}（可选 ${knownIds.join('/')}）`);
        }
        opts.scenario = v as CliOptions['scenario'];
        break;
      }
      case '--loop':
        opts.loop = true;
        break;
      case '--scenario-speed': {
        const raw = valueOf(i, inline, name);
        if (inline === undefined) i += 1;
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) throw new Error(`--scenario-speed 非法：${raw}（须 ≥0）`);
        opts.scenarioSpeed = v;
        break;
      }
      case '--list':
        opts.listOnly = true;
        break;
      case '-v':
      case '--verbose':
        setLogLevel('debug');
        break;
      case '-q':
      case '--quiet':
        setLogLevel('error');
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}（--help 查看用法）`);
    }
  }
  return opts;
}

export function helpText(): string {
  const lines = [
    'mock daemon v0（R0-06）——多端互通联调夹具服务器',
    '',
    '用法：npm run start -- [参数]',
    '',
    '参数：',
    '  --host <addr>            监听地址（默认 127.0.0.1；真机联调用 0.0.0.0）',
    '  --port <n>               监听端口（默认 8765）',
    '  --pair / --no-pair       配对模式开关（默认开）',
    '  --pair-code <码>         配对码（默认 CXN-7K4P-Q2MB-9XRT）',
    '  --scenario <id>          夹具场景：idle / approval / run / cache（默认 idle）',
    '  --loop                   场景循环播放（仅 run/cache 可循环）',
    '  --scenario-speed <倍率>  时间线速度倍率（≤1 加速，0 立即发射）',
    '  --list                   列出可用场景',
    '  -v / --verbose           调试日志',
    '  -q / --quiet             只输出错误',
    '  -h / --help              本帮助',
    '',
    '可用场景：',
  ];
  for (const id of scenarioIds()) {
    lines.push(`  ${id.padEnd(10)} ${SCENARIOS[id].description}`);
  }
  return lines.join('\n');
}

export function listText(): string {
  const lines = ['可用场景：'];
  for (const id of scenarioIds()) {
    lines.push(`  ${id.padEnd(10)} ${SCENARIOS[id].description}`);
  }
  return lines.join('\n');
}

/**
 * CLI 入口装配：解析 → 校验 → 启动 → 优雅退出（SIGINT/SIGTERM）。
 * 返回退出码（0 = 正常；1 = 参数错误/启动失败）。
 */
export async function main(): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    err(String((e as Error).message));
    console.log(helpText());
    return 1;
  }
  if (opts.help) {
    console.log(helpText());
    return 0;
  }
  if (opts.listOnly) {
    console.log(listText());
    return 0;
  }

  const server = new MockDaemonServer({
    host: opts.host,
    port: opts.port,
    pairMode: opts.pairMode,
    pairCode: opts.pairCode,
    scenario: opts.scenario,
    loop: opts.loop,
    scenarioSpeed: opts.scenarioSpeed,
  });

  try {
    const info0 = await server.listen();
    console.log('────────────────────────────────────────────────────');
    console.log('  mock daemon v0 已就绪');
    console.log(`  连接地址：  ws://${opts.host}:${info0.port}`);
    console.log(`  配对模式：  ${opts.pairMode ? '开（配对码 ' + opts.pairCode + '）' : '关（跳过配对）'}`);
    console.log(`  夹具场景：  ${opts.scenario}${opts.loop ? '（循环）' : ''}`);
    console.log('  停止服务：  Ctrl+C');
    console.log('────────────────────────────────────────────────────');
    info(`建议联调：npm run smoke -- --port ${info0.port}${opts.pairMode ? '' : ' --no-pair'}`);
    if (opts.scenario !== 'idle' && !opts.loop) {
      info(`场景 ${opts.scenario} 将在首个客户端订阅 ${SCENARIOS[opts.scenario].sessionId} 时启动`);
    }
  } catch (e) {
    err(`启动失败：${String((e as Error).message)}`);
    return 1;
  }

  // 优雅退出：SIGINT（Ctrl+C）/ SIGTERM
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    info(`收到 ${signal}，正在关闭…`);
    void server
      .close()
      .then(() => process.exit(0))
      .catch((e) => {
        err(`关闭异常：${String(e)}`);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return 0;
}
