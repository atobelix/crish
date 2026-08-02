# 集成测试套件插件 — 方向备忘（预研）

**状态**: 备忘 / 非本迭代交付  
**日期**: 2026-07  
**关联**: 性能与架构收尾（R1–10）完成后，质量体系下一阶段

---

## 1. 产品意图

Crish 后续应能 **对外提供「集成测试套件」能力**（插件/扩展形态），使：

- 应用自身 CI / 本地开发：一键跑 UI + IPC + daemon 契约
- 第三方或企业部署：可挂载自定义用例、环境矩阵、报告出口
- 与现有 monorepo 测试（vitest / cargo / native SLA）共存，而不是另起炉灶互相打架

先 **整理需求与边界**；有现成仓库且质量够好则集成，否则自建完整流程。

---

## 2. 我们现有测试资产（盘点）

| 层                   | 现状                                    | 路径/命令（示意）           |
| -------------------- | --------------------------------------- | --------------------------- |
| Desktop 单元         | vitest，~1700+ cases                    | `apps/crish-desktop`        |
| Daemon 协议/流       | vitest + stream-pause 集成              | `packages/agent-daemon`     |
| Orchestrator/runtime | vitest                                  | `packages/*`                |
| Rust 原生            | cargo test / benches / native SLA probe | `crates/*`, `examples/`     |
| 前端构建门禁         | tsc + vite build + husky lint-staged    | pre-commit                  |
| 性能报告             | scripts + perf-report                   | `scripts/*`, `perf-report/` |

**缺口（集成层）**：

- 跨进程：Desktop ↔ Tauri sidecar ↔ daemon ↔ mock provider 的 **端到端** 编排
- 可插件化的用例包（外部 repo / zip / npm plugin）
- 统一报告（JUnit/HTML/trace）与失败复现工件
- 非 flaky 的 UI 自动化（窗口拖拽、流式背压、审批流）

---

## 3. 现成方案评估清单（后续调研）

评估时用同一张表，避免「看起来酷但嵌不进 monorepo」：

| 候选方向                          | 适合                    | 关注点                             |
| --------------------------------- | ----------------------- | ---------------------------------- |
| Playwright / Cypress              | UI E2E                  | Tauri webview 注入、桌面 exclusive |
| Vitest browser / WebdriverIO      | 组件+轻 E2E             | 与现有 vitest 统一                 |
| Pact / contract testing           | daemon JSON/binary 契约 | 与 `protocol/registry` 对齐        |
| Testcontainers 类                 | 起 mock provider/daemon | Windows 开发机成本                 |
| GitHub Actions reusable workflows | CI 插件化               | 与本地 DX 双轨                     |
| 自研 `crish-testkit`              | 深度 IPC/流控           | 维护成本                           |

**决策准则**：

1. 能否覆盖 **binary frame + STREAM_PAUSE** 与 WebSocket 契约
2. 能否在 **无真实 LLM** 下稳定跑（fake provider 必备）
3. 插件 API 是否允许 **只带用例包、不 fork 主仓**
4. Windows 一等公民（本产品主战场）
5. 报告与 flaky 隔离是否够用

若调研结论为「没有足够好的一体方案」→ 启动 **自建 testkit**（见 §5）。

---

## 4. 插件形态（目标架构草图）

```
crish-testkit (核心，主仓或独立包)
  ├── runner          # 发现插件、并行、超时、重试
  ├── fixtures        # fake daemon / fake provider / session seed
  ├── drivers         # desktop (Playwright-in-Tauri?), daemon WS client
  ├── reporters       # junit / html / crish-trace
  └── plugin-api      # 用例包约定

@your-org/crish-tests-smoke   # 插件包示例
@your-org/crish-tests-stream  # 流式/背压用例
```

**插件约定（草案）**：

- 入口：`crish-test.plugin.json` + `export async function register(api)`
- 能力声明：`needs: ["daemon","ui","fs"]`
- 钩子：`beforeAll` / `test` / `afterAll` / `artifact`
- 版本：与 `DAEMON_INBOUND_MESSAGE_TYPES` 能力位对齐

---

## 5. 自建完整流程时的里程碑（若需要）

| 阶段 | 交付                  | 说明                                                    |
| ---- | --------------------- | ------------------------------------------------------- |
| M0   | 本文 + 候选库 spike   | 1–2 周调研，出 go/no-go                                 |
| M1   | `crish-testkit` MVP   | 只跑 daemon 契约 + fake provider，CLI `pnpm crish-test` |
| M2   | Desktop smoke 插件    | 启动壳、建会话、发一条 mock 流                          |
| M3   | 流控/审批插件         | STREAM_PAUSE、approval machine、断线恢复                |
| M4   | 对外插件文档 + 示例仓 | 第三方可发布用例包                                      |
| M5   | CI 模板               | monorepo workflow 一键引用                              |

---

## 6. 与当前收尾的关系

- **现在**：把 R1–10 性能/协议改动 **lint 干净并入库**，主仓可测集保持绿灯。
- **下一步（本文件）**：单独开 issue/项目跟踪「测试套件插件」；不阻塞发布性能收尾。
- **禁止**：在未调研前大面积引入第二套 E2E 框架污染 CI 时间。

---

## 7. 建议的下一句行动

1. 完成工作区 commit 与 PR
2. 开 issue：`[research] integrated test suite plugin — evaluate Playwright-Tauri vs self-hosted testkit`
3. Spike：fake provider + daemon WS 契约套件是否可独立 npm 包

---

_本文档为方向备忘，实现以后续 ADR 为准。_
