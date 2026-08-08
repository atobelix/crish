# AC-03 独立验收：P1 收尾批（W/F 组 7 项）——壳命令面与前端修复

- 验收人：独立验收员（未读任何修复报告，仅读代码 + 实跑测试）
- 日期：2026-08-08
- 方式：只读核读 + 实跑（cargo test / vitest / typecheck / cargo check），未改动任何文件
- 范围：W1 provider 重载、W3 错误协议、W2 search 沙箱、F1 降级日志、F2 取消竞态、F3 quota 标志、F4 菜单锚点、F5 drag 捕获、回归抽查 + 攻击性复核 ×2

---

## 总评

**7 项全部通过**。全部实跑测试绿灯（Rust 13 例 + 前端 56 例），`npm run typecheck` EXIT=0，`cargo check --workspace` EXIT=0。攻击性复核 2 项均未发现可利用缺口（详见末节）。

| # | 项 | 结论 | 实跑证据 |
|---|----|------|---------|
| 1 | W1 provider 重载 | 通过 | config_profile_apply 3 passed + reload_provider 2 passed |
| 2 | W3 错误协议 | 通过 | git_run 2 + http_request 2 + discover_skills 1 passed |
| 3 | W2 search 沙箱 | 通过 | rebuild_search_index 3 passed |
| 4 | F1 降级日志 | 通过 | sessionRustDbWriteModel 21 passed |
| 5 | F2 取消竞态 | 通过 | ConnectionLifecycle 21 passed |
| 6 | F3 quota 标志 | 通过 | sessionLocalStorage 4 passed |
| 7 | F4 菜单锚点 | 通过 | ComposePlusMenu 7 passed |
| 8 | F5 drag 捕获 | 通过 | usePointerDragBase 3 passed |
| 9 | 回归抽查 | 通过 | typecheck EXIT=0；cargo check EXIT=0 |

---

## 1. W1 provider 重载 —— 通过

**代码核读**（`apps/agent-workbench/src-tauri/src/`）：

- `engine.rs:1020-1044` `reload_provider()`：从 store `load_provider_endpoint()` 重建 `HttpProviderCall` → Mutex 短临界区**原子交换** `provider` + `provider_config` + `ready`/`ready_reason`，全程无 await（:1016-1017 注释明示模式对齐 `inject_provider_for_test`）。
- `config/provider.rs:567`：`config_profile_apply` 在 store 写入（:553-562，含密钥落 DPAPI 槽 :542）**之后**调用 `state.reload_provider()`。
- `config/provider.rs:510`：`config_update` 路径同样接线（:508-510 注释「baseUrl/model/endpoint/stream 已写入 store——重载引擎 provider」）。
- 运行时取用点：`engine.rs:1001-1006` `provider()` 返回克隆 `Arc`——run 启动时取新适配层，旧请求持旧快照（语义正确）。
- 清空 key：reload 后 `load_provider_endpoint` 返回 None → `provider=None` + `ready=false`（engine.rs:1027-1039），引擎降级未就绪而非沿用旧凭据。

**实跑**（工作区根）：

```
cargo test -p crish-agent-workbench config_profile_apply
  core_run_commands::tests::config_profile_apply_refreshes_engine_provider_config ... ok
  core_run_commands::tests::config_profile_apply_clearing_key_degrades_engine_ready ... ok
  core_run_commands::tests::config_profile_apply_swaps_next_provider_request_payload ... ok
  test result: ok. 3 passed
cargo test -p crish-agent-workbench reload_provider      （补充 engine 侧）
  engine::event_drain_tests::reload_provider_rebuilds_provider_config_from_store ... ok
  engine::event_drain_tests::reload_provider_degrades_when_key_cleared_then_recovers ... ok
  test result: ok. 2 passed
```

## 2. W3 错误协议（壳命令面） —— 通过

**代码核读**：壳 `workbench_*` 命令面错误类型全部收敛为 `Result<_, CoreError>`：

| 命令 | 签名位置 | 返回类型 |
|------|---------|---------|
| workbench_git_run | git.rs:192 | `Result<GitRunResult, CoreError>` |
| workbench_discover_skills | fs_commands/skills.rs:255 | `Result<Vec<RustSkill>, CoreError>` |
| workbench_http_request | commands.rs:25 | `Result<Value, CoreError>` |
| workbench_apply_update | commands.rs:11 | `Result<Value, CoreError>` |
| workbench_list_host_openers / open_host_target / open_path_default / list_file_openers | host_openers/mod.rs:18,31,36 | `Result<_, CoreError>` |

（注：fs_commands 的 list_directory / read_file_content / write_file_content / delete_file 为历史 `FileCommandError` 协议，不在本批 5 命令之列。）

**实跑**：

```
cargo test -p crish-agent-workbench git_run            → 2 passed（empty_cwd / outside_cwd 均 CoreError）
cargo test -p crish-agent-workbench http_request       → 2 passed（unsupported_method / non_http_url 均 CoreError::InvalidInput）
cargo test -p crish-agent-workbench discover_skills    → 1 passed（outside_root_returns_core_error）
```

## 3. W2 search 沙箱 —— 通过

**代码核读**（`core_commands.rs:173-242`）：

- `core_rebuild_search_index` 入口校验：trim / 空（:179-183）/ 长度上限（:184-188）→ 进 `resolve_index_root`（:190）。
- `resolve_index_root`（:209-242）：canonicalize（失败 → `workspace_not_granted: cannot resolve root`）→ `is_dir`（:220-224）→ `WorkspaceRegistry` 已授权根**子树前缀包含匹配**（`path_is_same_or_child`，:233-236，内置 `\\?\` 剥离与 Windows 大小写归一）→ 越界返回 `CoreError::InvalidInput("workspace_not_granted: root is outside...")`（:239-241）。
- 注册表未托管 → `CoreError::Internal` 明确报错，不静默放行（:225-230）。

**实跑**：

```
cargo test -p crish-agent-workbench rebuild_search_index
  rebuild_search_index_rejects_unapproved_root ... ok
  rebuild_search_index_allows_authorized_root ... ok
  rebuild_search_index_rejects_empty_or_oversized_root ... ok
  test result: ok. 3 passed
```

## 4. F1 降级日志（sessionRustDb） —— 通过

**代码核读**（`apps/crish-desktop/src/api/session-persistence/sessionRustDb.ts`）：

- 降级戳 API 三件套：`DEGRADED_MARKER_PREFIX='crish_degraded_'`（:597）、`markSessionDegraded`（:604-613，写失败 try/catch 不阻塞降级路径）、`hasDegradedMarker`（:615-620）、`clearDegradedMarker`（:625-632）。
- 降级触发点：`save_session_body` invoke 非 ok → `logInternalError('persist-degraded-ls')` + 打戳（:716-718；:1206-1207 boot 回灌打戳；:1138-1140 整批降级打戳）。
- **hydrate 回灌**：`hydrateSessionsFromRust` 命中降级戳 → 以 LS 正文为真源回灌展示 + 直接走 `invokeResult` 回写 SQLite（:888-930）；回写失败保持戳下次重试（:929-930），清戳后恢复 SQLite 优先（:909-911、:953）。

**实跑**（workdir: apps/crish-desktop）：

```
npx vitest run src/api/session-persistence/sessionRustDbWriteModel.test.ts
  ✓ 21 tests（含 P1-F1 降级与分叉恢复 4 用例：打戳/回灌/清戳/恢复 SQLite 优先）
  Test Files 1 passed | Tests 21 passed
```

## 5. F2 取消竞态（ConnectionLifecycle） —— 通过

**代码核读**（`apps/crish-desktop/src/api/chat-bridge/ConnectionLifecycle.ts`）：

- 共享判定：`isRunDead = finished || cancelled`（:299-301，取消与启动共享同一 `state`，取消信号自然传播）。
- **守卫①**：`waitUntilConnected(1.5s)` 恢复后（:325）立即短路——`if (isRunDead(state)) return;`（:329，注释明确不订阅/不 onChunk/不启动 run）。
- **守卫②**：参数组装（动态 import `sessionRustDb` / `getSettingsEx` 等 await 点）全部完成、`startRunTask` 派发前再次短路（:461-465）——避免 force_cancel 早于 run 到达引擎而失效。

**实跑**：

```
npx vitest run src/api/chat-bridge/ConnectionLifecycle.test.ts
  ✓ 21 tests（含「waitUntilConnected 挂起期间 cancel → startRunTask 不被调用」:448
    与「正常路径回归：startRunTask 被调用且携带正确 runId」:511）
  Test Files 1 passed | Tests 21 passed
```

## 6. F3 quota 标志（sessionLocalStorage） —— 通过

**代码核读**（`apps/crish-desktop/src/api/session-persistence/sessionLocalStorage.ts`）：

- `QUOTA_TRUNCATED_PREFIX='crish_quota_truncated_'`（:87）；置位 `markQuotaTruncation`（:89-97）/ 查询 `hasQuotaTruncation`（:100-106）/ 清除 `clearQuotaTruncation`（:111-117）；标志读写自身 try/catch（quota 耗尽不抛错）。
- 清除时机：全量写成功（quota 已释放）→ 清历史截断标志（:144）；截断路径保留最后 100 条（:147）。
- 数据面暴露：`sessionRustDb.ts:660-664` hydrate 链 `logInternalError('ls-quota-truncated', {sessionId})`。

**实跑**：

```
npx vitest run src/api/session-persistence/sessionLocalStorage.test.ts
  ✓ 4 tests（截断置标志 / 释放后清除 / hydrate 链日志 + 数据面暴露）
  Test Files 1 passed | Tests 4 passed
```

## 7. F4 菜单锚点（ComposePlusMenu） —— 通过

**代码核读**：

- `ComposePlusMenu.tsx:107`：`anchor={restoreFocusRef}` —— 以调用方注入的**真实按钮**为 Radix 浮动锚点（:103-106 注释：修复前传 display:none 空 div，rect 全 0 → 菜单落视口 (0,0)）。
- 基座接线：`components/ui/Menu/Menu.tsx:208-211` `Popover.Anchor virtualRef={anchor}` —— floating-ui 基于可见元素测量坐标；本 div 仅作 custom-anchor 注册节点。

**实跑**：

```
npx vitest run src/components/chat-composer/ComposePlusMenu.test.tsx
  ✓ 7 tests（含「不再渲染 display:none 空 div 作浮动锚点」:81、
    「真实按钮 32×32 @(100,200) → --radix-popper-anchor-width: 32px」:103、
    「锚点元素仍在文档且可见（display ≠ none）」:144）
  Test Files 1 passed | Tests 7 passed
```

## 8. F5 drag 捕获（usePointerDragBase） —— 通过

**代码核读**（`apps/crish-desktop/src/hooks/usePointerDragBase.ts`）：

- start 时 `setPointerCapture`（:181，jsdom 无实现 / 非 Element 时 try/catch 兜底，:177-178）。
- 双兜底监听：`lostpointercapture` + `window blur` 均走 `endGesture(true)`（cancelled 标记 → onDrop）（:397-398；注释 :351-356 说明 capture 失效场景与幂等守卫）；effect 清理移除监听（:413-414）。

**实跑**：

```
npx vitest run src/hooks/usePointerDragBase.test.tsx
  ✓ 3 tests（lostpointercapture 兜底 cancelled=true / window blur 兜底 cancelled=true）
  Test Files 1 passed | Tests 3 passed
```

## 9. 回归抽查 —— 通过

```
npm run typecheck            → EXIT=0（tsc 五个 project 无错误）
cargo check --workspace      → EXIT=0（唯一警告：host_openers/execute.rs:393 ShellExecuteW unsafe，
                                既有豁免面（clippy.toml 白名单 + -W unsafe-code 显示性），非本批引入）
```

---

## 攻击性复核

### ① provider 重载：构造「apply 新 key 后请求仍用旧 key」场景

**推演**（读码，未跑）：

1. **同步帧无窗口**：`config_profile_apply` 内 store 写入（provider.rs:553-562）与 `state.reload_provider()`（:567）在同一同步帧执行，reload 全程无 await（engine.rs:1016-1017）——不存在「store 已新、适配层未换」的可观察状态；apply 成功返回前重载必然完成，其后任何新 run 的 `provider()`（engine.rs:1001）取到新 Arc。
2. **旧请求语义正确**：apply 前已启动的 run 持有旧 Arc 克隆直至结束——请求级快照，非缺陷。
3. **清空 key 场景**：`load_provider_endpoint` 返回 None → `provider=None` + `ready=false`（engine.rs:1027-1039），下一次 run 被拒而非用旧凭据——比「用旧 key」更严格。实跑佐证：`config_profile_apply_clearing_key_degrades_engine_ready`（ok）、`reload_provider_degrades_when_key_cleared_then_recovers`（ok）。
4. **失败路径一致**：`config_secret_set` 失败（provider.rs:542 `?`）提前返回不重载——store 未变，重载无意义，语义一致。

**结论：攻击不成立。** 唯一注意点：apply 与请求存在**用户可见的请求级快照**语义（apply 前已发的流继续用旧 key 至结束），属预期行为而非漏洞。

### ② F4 锚点：锚点按钮 display:none 时菜单是否仍落 (0,0)

**推演**（读码 + 测试覆盖确认）：

- 修复后锚点 = `restoreFocusRef` 指向的真实按钮（ComposePlusMenu.tsx:107），菜单自身零隐藏元素；测试①已断言 `document.querySelector('[style*="display: none"]') === null`（ComposePlusMenu.test.tsx:99）。
- 测试②已覆盖「锚点可见性契约」：锚点真实按钮 32×32 @(100,200)（:134-141 断言 `--radix-popper-anchor-width: 32px` 等定位变量），并显式断言 `btn.style.display !== 'none'`（:146）。
- 若**调用方**把锚点按钮自身设为 display:none：Radix virtualRef 测 rect 全 0 → 菜单退化 (0,0)——此为 Radix 通用行为，但该场景已被测试断言为契约违反（锚点必须可见）；根因（菜单自行渲染必然隐藏的锚点 div）已移除，风险面收敛至调用方契约。

**结论：已覆盖/可接受。** 菜单自身不再存在「必然 (0,0)」的隐藏锚点路径。

---

## 附：实跑环境

- 平台：win32 / PowerShell 5.1；工作区根 `C:\Software\conex`；前端 vitest 3.2.7（workdir `apps/crish-desktop`）。
- 全部命令无 `--no-verify`、无跳过；唯一 warning 为既有 unsafe 豁免面。
- 本验收全程只读 + 跑测试，未修改任何源码/测试/配置。
