# Crish

**Crish** 是桌面 AI Agent 工作台：本地 Tauri 壳 + React UI + 长驻 `agent-daemon`，统一走 orchestrator / runtime 执行路径。

## 产品路径（唯一真相）

| 层 | 路径 | 说明 |
| --- | --- | --- |
| UI | `apps/crish-desktop` | React 19 + zustand；会话、布局、模型配置的产品前端 |
| 壳 | `apps/agent-workbench/src-tauri` | Tauri 2；加载 `crish-desktop` 产物，托管 sidecar / invoke |
| CLI 诊断 | `apps/agent-workbench/src/cli` + `src/shared` | 开发与诊断入口；`shared` 由 CLI 依赖图保留，非产品 UI |
| 引擎 | `packages/agent-daemon` | 会话 / 运行 / 审批 / 配置 / WebSocket 协议 |
| | `packages/agent-orchestrator` | 运行与会话生命周期、事件、目标续跑 |
| | `packages/agent-runtime` | 模型调用、工具、权限、上下文与检查点 |

```text
crish-desktop (React UI)
    ↕ WS / Tauri invoke
agent-workbench/src-tauri (壳) + agent-daemon (Node)
    → agent-orchestrator / agent-runtime
```

**已移除 / 勿再查找：**

- Preact legacy UI 不再作为产品路径（`apps/agent-workbench` 内旧 components/core 以代码为准清理）
- **不要再找 `apps/web-ui`** — 已不在 workspace，不是产品面

monorepo 内可能存在 `reference/` 等参考目录；它们**不参与构建**，不是产品路径。

## 开发命令

```bash
npm install

npm run dev:desktop      # 仅 React UI（Vite）
npm run dev:workbench    # Tauri 壳 + 桌面联调（加载 crish-desktop）
npm run dev:cli          # CLI 诊断路径

npm run build:product    # daemon + desktop + daemon 打包
npm run check:core       # runtime / orchestrator / daemon / workbench CLI / desktop 类型检查
npm run check:desktop    # 仅 crish-desktop typecheck
```

其它：`npm run daemon` 单独起 daemon；`npm run test:core` 跑核心包测试。

## 文档

- 架构真相：根目录 [`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 计划与专项：[`docs/plans/`](./docs/plans/)、[`docs/architecture/`](./docs/architecture/)
- 根目录与 workbench 下部分历史规划文档顶部已标 **【已废弃 / 非产品真相】**，勿当当前产品说明

## 原则（摘要）

- 一条执行链：UI → daemon → orchestrator → runtime；不并行维护第二套会话 / provider 真相
- 产品 UI 只认 `apps/crish-desktop`；Tauri `frontendDist` 指向其 `dist`
- CLI / `shared` 服务诊断与目标跑批，不定义用户向产品行为

## License

MIT
