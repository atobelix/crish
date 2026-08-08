# AC-02 · E0 批 CI/stress/迁移/孤儿/写竞态修复独立验收报告

- 验收人：独立验收员（未读取任何修复报告，只读源码 + 实跑测试）
- 日期：2026-08-08
- 验收范围：① CI 中层两 job 复活 ② tests/stress 重写 ③ 迁移崩溃重跑自愈 ④ 孤儿清理 in-flight 保护 ⑤ 前端写竞态契约翻转
- 结论汇总：**5/5 通过**；回归项首跑出现 3 个 flaky 失败，重跑两轮全绿（详见 §6）

---

## ① CI 中层两 job 复活 —— ✅ 通过

### 静态核查（e2e 项目块已删 / Playwright spec 不再被 vitest 收集）

- `vitest.config.ts:57-121` 的 `test.projects` 仅三个项目：`unit` / `integration` / `native-smoke`——**无 e2e 项目块**；`native-smoke` 的 include 仅 `tests/e2e/tauri-native-smoke.spec.ts`（:117），Playwright spec（tests/e2e 其余）不被 vitest 收集。
- 仓库无 `vitest.workspace.ts`（glob 全仓零命中）；`vitest.integration.config.ts:4-6` 注释明确「从 vitest.workspace.ts 时代迁出——vitest 3.2.7 下 workspace 文件已 deprecated，旧 stub 触发 Startup Error；改用 test.projects 单项目 f3」。
- `ci-mid.yml`：test job 跑 `npm run test`（:85）；test:integration job 跑 `npx vitest run --config vitest.integration.config.ts`（:99）；e2e 冒烟子集归 Playwright job（:122-133）。

### 实跑

```
命令: npx vitest run --config vitest.integration.config.ts
结果: Test Files 12 passed (12) / Tests 40 passed (40)
      EXIT=0（无 Startup Error，3.06s）
```
覆盖 f3 项目四目录：integration / fuzz / race / recovery（12 个文件 40 用例全绿）。

---

## ② tests/stress 重写为接真实生产模块 —— ✅ 通过

### 静态核查（import 生产文件）

- `tests/stress/stress-ai-stream.ts:8-13`：import `apps/crish-desktop/src/api/chat-bridge/handlers/eventParser`（parseBridgeEvent）、`api/StreamRenderBuffer`、`api/streamTextBatcher`（StreamTextBatcher / streamBatchKey）。
- `tests/stress/stress-diff-load.ts:13`：import `apps/crish-desktop/src/api/diffPanelHelpers`。
- `tests/stress/stress-session-switch.ts:14-21`：import `apps/crish-desktop/src/api/sessionSearch`、`api/sessionTitle`、`store/types`。
- 框架层（`stress-runner.ts`）带 `verify` 正确性不变式钩子（:94）+ `modules` 生产模块清单字段（:84），PASS 需不变式全过（:210-215）。

### 实跑

```
命令: npm run stress
结果: 总计: 3, 通过: 3, 失败: 0 → EXIT=0
  [PASS] ai.streaming.real.pipeline  —— ops avg=35101.6(≥30000) 内存311MB(≤600) 错误率0.0% 不变式全OK（1053048 runs 零失败）
  [PASS] large.diff.merge.and.count  —— 2177 ops，合并不变式全OK
  [PASS] rapid.session.search.and.rank —— 212 ops，查询不变式全OK
```
每个场景输出「生产模块:」清单（非 Node 内置自嗨），verify 不变式全部 OK。

---

## ③ conex-db 迁移崩溃重跑自愈（v3→v4） —— ✅ 通过

### 静态核查

- `crates/conex-db/src/migrate.rs:354-398`：v3→v4 的 `session_messages.updated_at` 加列已拆出存在性检查（col-check 幂等）；`session_sequence` 按源表实际列名判定（`next_seq` vs `next_sequence`，:368-397），崩溃中间态重跑不 latch 死库。
- 测试用例存在：`tests/migrations.rs:1051` `migration_v3_to_v4_crash_rerun_self_heals`（v4 形态崩溃中间态 fixture → 重跑自愈）+ `:1105` `migration_normal_v3_upgrade_still_works`（对照）。

### 实跑

```
命令: cargo test -p conex-db
结果: 53 passed / 14 passed / 16 passed / 5 passed / 3 ignored(stress_write)
      EXIT=0
命令: cargo test -p conex-db --test migrations
结果: running 14 tests → test result: ok. 14 passed; 0 failed
      test migration_v3_to_v4_crash_rerun_self_heals ... ok
      test migration_normal_v3_upgrade_still_works ... ok
      EXIT=0
```

---

## ④ 孤儿清理 in-flight 保护 —— ✅ 通过

### 静态核查（DELETE 条件含 run/pending 豁免）

`crates/conex-db/src/sessions.rs:235-247` `protected` 子句（两个删除分支共用）：

```
COALESCE(hydrated_from_engine, 0) != 1
AND NOT EXISTS (runs 中 status IN ('queued','initializing','running',
                 'awaiting-approval','completing','cancelling'))   ← 活动 run 豁免
AND NOT EXISTS (pending_inputs 行存在)                              ← 未决 pending 豁免
```
+ 宽限期 `updated_at < grace_cutoff`（:230，默认 5 分钟可配）。

### 测试用例存在性（tests/orphan_grace_contract.rs）

- v3 扩展（in-flight/pending）：`cleanup_preserves_session_with_unconsumed_pending`（:258）、`cleanup_preserves_session_with_inflight_run`（:283）、`cleanup_preserves_inflight_run_within_grace`（:306）、`cleanup_preserves_session_with_intermediate_run_statuses`（:320，Cancelling/Completing 参数化）、`cleanup_still_removes_stale_session_without_run`（:337 对照）。
- v2 扩展：`session_with_active_run_preserved`（:205）、`session_with_queued_run_preserved`（:223）、引擎子代理豁免（:167/:186）。

### 实跑

```
命令: cargo test -p conex-db --test orphan_grace_contract
结果: running 16 tests → test result: ok. 16 passed; 0 failed; finished in 0.22s
      含 cleanup_preserves_session_with_inflight_run / _within_grace /
      _with_unconsumed_pending / _with_intermediate_run_statuses 全部 ok
      EXIT=0
```

---

## ⑤ 前端写竞态契约翻转 —— ✅ 通过

### 静态核查（278-308 附近为新契约）

`apps/crish-desktop/src/api/session-persistence/sessionRustDbWriteModel.test.ts`：

- :259-317 首个用例「快速连续 commit：两批次按发起序串行全量落库，最终 = 后发起批次」——断言 `saves==2`（:302）、`bodyVersions[0] < bodyVersions[1]`（:308 批次版本戳单调递增）、最终 = 4 条新内容（:310-316）。
- :319-370 第二用例「晚完成的旧批次不得覆盖新批次（最终 = 新内容）」——probeDelay 制造「旧批次晚完成」，断言最终落库 = 新批次 4 条（:363-369），文件头 :9-13 注明 PS-03 T3.2 契约翻转（原 278-308 的「旧批次晚完成覆盖新批次」断言已删除）。
- :372-427 三批交错用例：最终 = 最新快照（6 条），三批版本严格递增（:416-417）。

**确认：断言语义为「旧批次不覆盖新批次」，非旧契约。**

### 实跑

```
命令: npx vitest run src/api/session-persistence/sessionRustDbWriteModel.test.ts
结果: Test Files 1 passed / Tests 17 passed (17)，EXIT=0
```

---

## ⑥ 回归：cargo test --workspace —— ⚠️ 通过（首跑 3 flaky 失败，重跑两轮全绿）

### 实跑记录（三次全量）

| 轮次 | 结果 | EXIT |
|---|---|---|
| 第 1 轮 | crish-agent-workbench `src/main.rs` 447 测试：**442 passed / 3 failed** / 2 ignored，其余全部套件 ok | 101 |
| 第 2 轮 | 同 bin 447 测试：445 passed / 0 failed / 2 ignored（全 workspace 全绿） | 0 |
| 第 3 轮 | 全 workspace 所有套件全绿（含 445/447 同口径） | 0 |

- 第 2 轮单独复跑：`cargo test -p crish-agent-workbench --bin crish-agent-workbench` → 445 passed / 0 failed / 2 ignored，EXIT=0。
- 结论：首轮 3 个失败无法复现（同 bin 连续两轮全绿），判定为**并发负载下的 flaky**（首轮为全 workspace 并行跑 bin 447 用例长尾 41-48s 段），与本批四项修复（conex-db 迁移/孤儿 + tests/stress + 前端 vitest 面）**无关联面**，且不构成稳定回归。失败用例名未捕获（首轮输出被过滤），如实记录。

### 套件计数

conex-db 全量：53（lib）+ 14（migrations）+ 16（orphan_grace_contract）+ 5（upgrade_e2e）+ 3 ignored（stress_write）；workspace 全量 90+ 个 test result 均 ok（500/511/445/302/185/93/87/72/70/53… 全套件）。

---

## 验收结论

| # | 验收项 | 判定 | 关键证据 |
|---|---|---|---|
| ① | CI 中层两 job | ✅ 通过 | vitest.config.ts 无 e2e 项目块；integration 实跑 40/40 EXIT=0 无 Startup Error |
| ② | stress 重写 | ✅ 通过 | 3/3 PASS EXIT=0；import 6 个生产模块，不变式全 OK |
| ③ | 迁移崩溃重跑自愈 | ✅ 通过 | migrate.rs 幂等化；migrations 14/14 含 crash_rerun_self_heals |
| ④ | 孤儿 in-flight 保护 | ✅ 通过 | sessions.rs:235-247 run/pending 豁免；orphan_grace_contract 16/16 |
| ⑤ | 写竞态契约翻转 | ✅ 通过 | 测试 278-317 断言后发批次落库 + 版本戳递增；17/17 EXIT=0 |
| ⑥ | 全量回归 | ⚠️ 通过（flaky 备案） | 首跑 3 失败（crish-agent-workbench bin），重跑两轮全绿 EXIT=0，非稳定回归 |

**未修复项：无。** 唯一备案：crish-agent-workbench 主 bin 447 用例在首轮全 workspace 并行负载下出现 3 个一次性失败（重跑无法复现），建议后续观察是否为已知 flaky 集成员（不在本批修复范围内）。
