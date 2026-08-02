# Daemon 运行时与打包技术选型

> **【已废弃】** 本文档描述的是已被删除的旧 Node.js daemon 运行时选型（sidecar / WS 传输），
> 仅供历史参考，不再代表当前架构。当前架构：Rust 引擎同进程内嵌于 Tauri 壳，无独立后端进程；
> 详见根 [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 与引擎事件契约
> `crates/conex-types/contracts/engine-events.json`。

日期：2026-06-09  
范围：Workbench/Tauri -> agent-daemon -> AgentOrchestrator -> AgentRuntime 的 daemon sidecar 启动、流式传输、打包与 smoke/benchmark 策略。

## 结论

当前推荐不要把 daemon sidecar 主线从 Node.js/tsx 直接迁到 Bun。更稳妥的分层是：

| 层级 | 推荐 | 理由 |
| --- | --- | --- |
| 开发态 | 继续使用 `tsx --conditions development packages/agent-daemon/src/index.ts` | 当前 workspace 的 package exports 已经区分 `development` 源码入口和 `dist` 入口；tsx 对 Node ESM、TypeScript、tsconfig 生态更贴近现状。 |
| 生产态 | 继续以 Node 兼容产物为主：`esbuild --platform=node --format=esm --packages=external` 后运行 `node dist/index.js`，正式分发时再包装成自包含 sidecar 二进制 | Tauri sidecar 面向终端用户应是独立可执行文件，不应依赖用户机器已有 Node/npm/npx；Node 兼容路径对 `ws`、`fs`、`child_process`、AbortSignal 和现有测试最保守。 |
| 长期可选项 | 保留 Bun smoke/benchmark 通道，但先作为实验性 runtime，不作为默认生产 sidecar | Bun 的原生 TypeScript、快速启动和 `bun build --compile` 对冷启动和单文件分发有吸引力；但本项目依赖 Node API、`ws`、文件持久化、子进程/MCP 与 SSE 细节，必须用项目 benchmark 验证，而不能只看通用宣传数据。 |

对性能目标的判断：Bun 最可能改善 daemon cold start 和 ready time；first-token latency 多半受 provider 网络、鉴权、首包返回与 runtime 初始化影响，不能假设会线性受益。event throughput、断线恢复和内存曲线也要按本项目协议测。

## 当前项目事实

- 根脚本当前为 `daemon = tsx --conditions development packages/agent-daemon/src/index.ts`，`daemon:dist = node packages/agent-daemon/dist/index.js`。
- `@crish/agent-daemon` 的生产入口是 `dist/index.js`，开发条件入口是 `src/index.ts`。
- daemon 入口会在 stdout 输出 `daemon-ready` JSON，Tauri/Rust 端依赖该 ready 边界读取端口。
- daemon WebSocket 服务端使用 `ws` 的 `WebSocketServer`，不是 Bun 原生 `Bun.serve` WebSocket API。
- streaming provider 路径依赖 `fetch`、`ReadableStream`、SSE 解析、`TextDecoder` 和 `AbortSignal`；runtime 路径依赖 `fs`、`fs/promises`、原子写入/rename、`child_process`/spawn、进程 kill 与 MCP/后台命令生命周期。
- 本机检查结果：Node `v24.11.0`、npm `11.6.2`、tsx `4.22.4` 可用；`bun` 当前不在 PATH，因此这次没有运行 Bun smoke。

## 兼容性评估

| 维度 | Node.js/tsx/npx | Bun 影响 |
| --- | --- | --- |
| TypeScript 源码运行 | Node 本身已有 TypeScript type stripping 能力，但它不等价于项目级 TS 构建链；开发态继续用 tsx 更贴近现有 `--conditions development` 和 workspace 源码入口。 | Bun 可直接运行 TS，适合 smoke；但要验证 package exports 条件、workspace `file:` 依赖、`.js` 扩展指向 TS 源文件、tsconfig 路径与 ESM 行为。 |
| WebSocket | Node + `ws` 是当前实现和测试基础。生产态无需改 daemon 协议。 | Bun 有高性能原生 WebSocket API，但它不是 `ws.WebSocketServer` 的透明替换；若仍用 `ws`，需验证兼容性和背压行为；若改用 Bun 原生 API，就是后续重构，不是 runtime 替换。 |
| SSE / streaming | 当前可依赖 Node 的 fetch、WHATWG Streams、AbortSignal；SSE 是项目自有解析逻辑，不依赖 EventSource。 | Bun 也实现 Web 标准 API，但官方兼容表仍标注部分 HTTP/stream 行为差异，例如出站请求体流式细节；本项目主要读 provider 响应流，仍要测 first-token、chunk cadence、abort 后 reader 释放。 |
| AbortSignal | Node 支持 AbortController/AbortSignal，并支持 timeout/any 等常用模式；现有 runtime 已大量使用。 | Bun 支持 AbortController/AbortSignal；必须验证 fetch abort、tool timeout、child process kill、复合 signal 的错误形态是否与现有 catch/diagnostic 匹配。 |
| fs / 持久化 | Node `fs`、`fs/promises`、`fsyncSync`、rename 行为是当前 daemon JSONL/store 可靠性基础。 | Bun 支持大量 Node `fs` API，但持久化路径需要在 Windows/macOS/Linux 上验证 rename 原子性、fsync、并发读写、中文路径和长路径。 |
| child_process / MCP | Node 的 spawn/kill/stdio 行为是后台命令、MCP 生命周期和工具执行的基线。 | Bun 支持 `child_process` 的核心能力，但官方兼容表仍有缺口。要重点测 stdio drain、kill tree、Windows shell、长输出背压、退出码和 abort race。 |
| 打包 | 当前 `esbuild --platform=node --format=esm --packages=external` 适合 Node dist；真正上架 Tauri 时还要把 runtime 包成 sidecar 二进制或随安装包携带 runtime。 | `bun build --compile` 可生成独立可执行文件，是长期候选；但必须验证外部依赖、源码映射、动态 import、workspace 包、`ws`、证书/代理环境变量和 Windows 签名/杀软误报。 |
| npx | `npx` 适合临时 CLI，不适合 sidecar 启动链路。它可能解析/下载包、受 npm cache 和交互策略影响，冷启动和可重复性都差。 | 与 Bun 无直接关系；无论选哪个 runtime，生产 sidecar 都不应通过 `npx` 启动。 |

## 推荐分层

### 开发态

保留当前 Node + tsx 路径：

```powershell
npm run daemon
```

可在安装 Bun 后临时 smoke：

```powershell
bun --conditions development packages/agent-daemon/src/index.ts
```

如果后续要把 Bun smoke 固化为 npm script，建议只新增实验性脚本名，例如 `daemon:bun:smoke`，不要替换 `daemon`。这次没有改 package scripts，原因是本机没有 Bun，无法验证脚本可执行性。

### 生产态

短期继续使用 Node 兼容构建：

```powershell
npm run build:daemon
npm run daemon:dist
```

但产品分发不应要求用户安装 Node。Tauri sidecar 应落成自包含可执行文件，并把 `daemon-ready` stdout 协议作为不变契约。候选路线：

1. Node dist + Node runtime/SEA/pkg 类包装，优先保证与 `ws`、`fs`、`child_process` 的现状一致。
2. Bun compile 作为对照样本，只在 benchmark 和兼容 smoke 全部通过后进入生产候选。

### 长期可选项

Bun 值得保留为长期候选，尤其用于降低 cold start 和简化单文件分发。但它应满足以下准入条件：

- `bun --conditions development packages/agent-daemon/src/index.ts` 能稳定输出 `daemon-ready`。
- Bun 运行完整 daemon smoke：WebSocket connect、run task、SSE first token、cancel、断线重连、read-run-events。
- Bun compiled binary 能在 Windows/macOS/Linux 通过同样 smoke。
- 与 Node dist 对比的 p50/p95/p99 指标显著改善，且没有内存、背压、abort、文件持久化回归。

## 必须 benchmark 的指标

| 指标 | 定义 | 建议采样 |
| --- | --- | --- |
| daemon cold start | 从 Tauri/Rust spawn 或 shell spawn 到进程第一字节 stdout 的时间 | Node+tsx、Node dist、Bun TS、Bun compiled，各 30 次以上，记录 p50/p95/p99。 |
| ready time | 从 spawn 到解析到 `{"type":"daemon-ready"}` 的时间 | 与 cold start 分开，能发现 import/初始化/端口绑定成本。 |
| first-token latency | WebSocket 发送 run 命令到第一条 assistant/content delta 或等价流式 token 的时间 | 固定 provider、模型、prompt、网络环境；同时记录 provider 首包时间。 |
| event throughput | daemon 向 WebSocket client 推送事件的吞吐和 p99 send 延迟 | 使用可重复 fake provider 或 replay store，测 1/5/20 client、长输出和背压。 |
| memory | ready 后 RSS/heap、单次 run 后、连续 30 分钟 idle、长会话后 RSS/heap | 记录峰值、回落、GC 后曲线，关注 Bun compiled 与 Node dist 差异。 |
| 断线恢复时间 | client 断开后重新连接、get-status/read-run-events 恢复到最新 run snapshot 的时间 | 覆盖 run 仍在执行、run 已完成、event store 边写边读三种情况。 |

最低 smoke 命令建议：

```powershell
node --version
npx tsx --version
npm run check:daemon
npm run build:daemon
npm run daemon:dist
bun --version
bun --conditions development packages/agent-daemon/src/index.ts
```

生产候选还应增加：

```powershell
bun build --compile packages/agent-daemon/src/index.ts --outfile dist-bin/agent-daemon-bun
```

该命令只是候选形态，真正落地前要补齐 external package、workspace resolution、平台 target、签名和安装包路径验证。

## 启动基准运行方式

当前启动基准脚本用于对比 dev tsx、Node dist、未来 Bun TS 和 Bun compiled 的 cold start/ready/connect/status 路径。先构建 Node dist，再分别运行：

```powershell
npm run build:daemon
npm run bench:daemon -- --runtime tsx --iterations 30
npm run bench:daemon -- --runtime node-dist --iterations 30
npm run bench:daemon -- --runtime bun-ts --iterations 30
npm run bench:daemon -- --runtime bun-compiled --binary packages/agent-daemon/dist-bin/agent-daemon-bun.exe --iterations 30
```

输出会记录 `runtime`、实际 `command`、每次 `samples`、成功/失败计数，以及 ready、WebSocket connect、get-status round trip 和 total 的 p50/p95/p99。若 sample 失败，结果中会带 `stdoutTail` 和 `stderrTail`，命令也会以非零状态退出，避免基准静默吞错。

2026-06-09 本机 `bun` 不在 PATH，因此 Bun TS 与 Bun compiled 只记录为待测；不要把未运行的 Bun 候选写成性能结论。

## 资料来源

- Bun Node.js compatibility：https://bun.sh/docs/runtime/nodejs-apis
- Bun WebSocket API：https://bun.sh/docs/api/websockets
- Bun standalone executable：https://bun.sh/docs/bundler/executables
- Node.js TypeScript：https://nodejs.org/api/typescript.html
- Node.js globals：https://nodejs.org/api/globals.html
- Node.js `child_process`：https://nodejs.org/api/child_process.html
- Node.js `fs`：https://nodejs.org/api/fs.html
- Node.js single executable applications：https://nodejs.org/api/single-executable-applications.html
- npm `npx`：https://docs.npmjs.com/cli/v11/commands/npx
- tsx：https://tsx.is/
- Tauri Node.js sidecar：https://v2.tauri.app/learn/sidecar-nodejs/
