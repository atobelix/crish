# tests/e2e —— 前端 e2e（PE-11 T11.1 唯一 owner）

本目录为前端 e2e 全旅程的唯一归属（Playwright 根 config `playwright.config.ts`）。
视觉回归见 `apps/crish-desktop/tests/visual/`（T11.2）。

---

## 1. 框架与分层（T11.1 方案评估结论）

| 项             | 结论                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 框架           | **沿用 Playwright**（`@playwright/test` 已在 devDependencies），不引入新框架                                                                                                                                                  |
| 双 config 归一 | 根 `playwright.config.ts` = e2e 唯一入口（projects `e2e-l2` 默认 / `e2e-l3` 占位）；`apps/crish-desktop/playwright.config.ts` 收敛为 **visual 专用**（testDir 限 `tests/visual`），不再误扫 F3 层                             |
| L2 mock 引擎   | 浏览器环境 + `addInitScript` 注入 `window.__TAURI_INTERNALS__`（invoke/transformCallback）与 `__TAURI_EVENT_PLUGIN_INTERNALS__`（事件监听），模拟 `workbench-run-event` 事件通道。**不依赖真实后端**，确定性、CI 稳定、全量跑 |
| L3 真壳        | `tauri-driver` 驱动真二进制（发布前/nightly）。当前以 `tauri-native-smoke.spec.ts`（vitest 进程级冒烟）占位                                                                                                                   |
| live model     | 不进门禁（模型不稳），维持切换轮手工冒烟                                                                                                                                                                                      |

### CI 分层归属

- **中层（PR）**：`npx playwright test tests/e2e`（本目录全部 L2 spec）
- **慢层（nightly / 发布前）**：`npm run test:e2e:native`（native-smoke）+ `test:visual`

---

## 2. 运行方式

```bash
# 全量 L2 e2e（自动拉起 vite dev server :5174）
npx playwright test tests/e2e

# 单个 spec
npx playwright test tests/e2e/full-journey.spec.ts

# 进程级原生冒烟（需先 cargo build 出二进制；无二进制自动 skip）
npm run test:e2e:native
```

前置：`npm install`（Playwright 浏览器已随 devDependencies 安装）；dev server 由 config `webServer` 自动管理（`reuseExistingServer: true`）。

---

## 3. L2 mock 引擎（mock-engine.ts）

| 能力     | 说明                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注入     | `installMockEngine(page, config)`：两层 addInitScript（config → 引擎），reload 自动重装                                                               |
| 命令面   | 内置快照镜像 `BUILTIN_COMMAND_MANIFEST`（registered 子集）；已知命令走处理器；registered 命令默认 null（ok）；未知命令抛 missing                      |
| 事件通道 | `core_run_task` 命中后按 `config.runStream.events` 逐条推送（`delayMs` 可调，runId/sessionId/sequence 自动补齐）；测试可经 `emitEngineEvent` 手动推送 |
| 有状态   | `config_*` / `save_session_body` 持久化到 localStorage `__crish_mock_store_v1`，`page.reload()` 保留                                                  |
| 会话恢复 | `config.sessions[].events` 作为 `core_read_session_events` 回放源                                                                                     |
| 错误注入 | `config.runStream.error = { kind, message }` → `core_run_task` 抛 CoreError                                                                           |
| 测试句柄 | `window.__CRISH_E2E__`：`getState()`（lastRun/runCount）、`emit()`、`setConfig()`                                                                     |
| markdown | `md_render`/`core_md_render(_batch)` 内建确定性 HTML（fence/表格/列表/标题），完成态收敛用                                                            |
| 种子化   | `config.localStorage` 经 sessionStorage 门控仅种子一次（reload 不覆盖用户写入）                                                                       |

---

## 4. 必覆盖场景（4+1 个 spec）

| spec                       | 场景                                  | 断言要点                                                                                                       |
| -------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `full-journey.spec.ts`     | 启动→新建会话→发送→流式→工具调用→收口 | 输入清空、消息入列、delta 累积、工具卡、终态 completed、`core_run_task` 参数（runId/sessionId/permissionMode） |
| `session-restore.spec.ts`  | 会话恢复（hydrate）                   | 侧栏 3 会话、点击回灌消息/工具卡、in-flight 中断标注（PE-08 T08.6）、懒水合标记                                |
| `settings-persist.spec.ts` | 设置保存→重启→一致                    | 主题改 dark → reload 回显、无「待同步」、LS 无明文 apiKey（PE-07 T07.4）                                       |
| `streaming-render.spec.ts` | 流式渲染专项                          | 流式期 delta 累积（收敛性）、未闭合 fence 软渲染、完成态收敛 `pre/code`、表格结构                              |
| `error-path.spec.ts`       | 错误路径                              | `core_run_task` 拒绝 → run-notice 提示、无 assistant 空气泡、可重试                                            |

> 说明：任务书原 4 场景（full-journey / settings-persist / session-restore / streaming-render）外，按任务描述补充错误路径场景，共 5 个 spec。

---

## 5. data-testid 契约（本任务 owner 登记）

| testid                                                                                                   | 位置                                 | 场景     |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------- |
| `sidebar` / `new-session-button` / `sidebar-nav-scheduled`                                               | SidebarNav                           | 通用     |
| `sidebar-session-item`（+`data-testid-session-id`）                                                      | session-list/SessionRow              | 会话树   |
| `settings-button` / `quick-settings-all` / `settings-panel` / `settings-tab-*` / `settings-close-button` | settings                             | 设置     |
| `model-selector-button` / `model-picker-menu`                                                            | provider                             | 模型     |
| `chat-input` / `composer-stop`                                                                           | chat-composer/ComposerField          | 聊天     |
| `run-notice` / `run-notice-text`                                                                         | chat-card/RunNoticeBar（T11.1 补充） | 错误提示 |
| `tab-chat` / `add-panel-button` / `add-panel-item-terminal`                                              | 工作区                               | 通用     |

CSS 契约（非 testid，稳定 class）：`.msg-row` / `.msg-row-user` / `.msg-row-assistant` /
`.md-rendered`（+`.is-streaming` 流式标记）/ `.tool-stack .tool-row[data-tool-id]`。

新增场景缺 testid 时，补 testid 属测试基建改动（不动业务逻辑），以本任务为 owner。

---

## 6. 陈旧资产处置（T11.1-4）

- `tauri-native-smoke.spec.ts`：已重写为 **进程级冒烟**（去掉全部 WS daemon 断言：
  `rg "ws://127.0.0.1|daemon|WebSocket" tests/e2e` 应为零命中）。
  断言：二进制拉起 + 日志含引擎初始化标记（「setup 完成（IPC 模式）」）+
  干净退出 + 无残存进程；二进制不存在自动 skip（vitest `describe.skipIf`）。
- `apps/crish-desktop/tests/e2e/` 重复拷贝已删除（遗留 #3）。
- `npx playwright test tests/e2e` 不会误扫 vitest spec（根 config `testIgnore`）。
