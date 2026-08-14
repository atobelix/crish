# 轮 6 汇总 · 2026-08-13-wave 修复战役（结构链 + 可观测面）

| 元数据       | 值                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| **轮次**     | 执行轮 6（R3-6）· 按定稿 §四 轮 6 调整（并行域收口后 SR-01/G-03c/SR-06f/B2 窗口开启）                         |
| **派单**     | 9 单元 · 全部完成（S2/S3 多次接续完成；SR-05 补债）                                                           |
| **提交**     | 7 个提交 · 主控统一 `git commit --only`                                                                       |
| **HEAD**     | （轮 6 最后一提交）                                                                                           |
| **关键事件** | 并行域收口（48c63292/e85073a0 等提交）→ core_run/useStreamCallbacks/note_commands 全 clean → 冻结窗口正式开启 |

---

## 一、单元完成状态

| 单元            | 内容                                                                                                                                                   | 验证结果                                                                                        | 结果          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------- |
| **SR-01**       | core_run 测试外置：17510→**8057** + 旁挂 9467（含 11 散落 cfg(test) 块重建，零删除零语义改动）                                                         | 5 锚点名；cfg(test) 12→2 处接线；编译被并行域 restore 阻断待收口复验                            | ✅ `3fd5bbbd` |
| **G-03c**       | useStreamCallbacks HARD 拆分：1089→**169** + events/internals/surfaces/usage 4 子模块 + **B6 find O(1)化 + DELAY_AFTER_STOP_MS 常量**                  | HARD 1→**0**（VIOL 也 0）；测试绿                                                               | ✅            |
| **SR-06f 批⑥**  | note_commands 拆分：1010→**96** 门面 + apply/hydrate/mirror 3 模 + 测试旁挂                                                                            | 命令注册不 break；B2/CT-01b 后续                                                                | ✅            |
| **B1-5**        | engine 家族 21 处毒丸观测化（SR-04 拆分后实测分布，生产段全成对）+ 4 毒化测                                                                            | engine 78 测全绿（沙盒验证）；EmitReport 语义不动                                               | ✅            |
| **S2**          | trace_id 最小面：AgentEventEnvelope 可选字段（wire `traceId`，3 处同步）+ 桥注入面就绪 + **tool.ts 死字段删除** + engineStatus 投影                    | conex-types 31/31 + vitest 29/29 全绿；Cargo.lock 零 diff；core_run 注入面**顺延**待 SR-02 收口 | ✅            |
| **S3**          | 三热点埋点：事件序列化告警（10ms）+ 全文序列化（100ms）+ **10 处锁点计时**（SlowPathProbe 锁外计时锁内零新增）+ StreamRenderBuffer 帧预算超限计数      | conex-note-runtime 44 测全绿 + vitest 20 全绿；人工核对清单落盘                                 | ✅            |
| **G-02 收尾批** | 登记 5 测试旁挂（chat_tests 709/executor_tests 1020/wait_subagents_tests 1098/tool_exec_tests 3233/engine_tests 3328）+ 清理 13 条回落 + 收紧 3 条回涨 | FAIL 18→**11**（剩并行域在途）；check-format exit 0（142 条）                                   | ✅            |
| **SR-05 补债**  | **恢复丢失的 background 测试**（轮 3 SR-05 声称 46 用例零删除但实际只落 8 个）——从 fdb512d4^ 逐字恢复 log/kill/resource/events 域 38 用例              | 46 用例齐（8 已有 + 38 重建）；接线核对；编译待并行域收口                                       | ✅            |
| **CONN-03/04**  | 真 WebView 用例：conn-b3-e2e（slash 一点通 + 无 Tauri readonly）+ conn-g2-e2e（写后读回三态）                                                          | 用例骨架完整；**未真跑**（dev:workbench 环境待收口轮）；诚实边界句在                            | ✅            |

## 二、门禁状态 Δ（轮 5 → 轮 6 收口）——**全绿达成**

| 门禁            | 轮 5            | 轮 6 收口                                                                   | 说明                                                                                      |
| --------------- | --------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| crate-size FAIL | 16              | **11**（全并行域在途：conex-browser M 5 / subagent_spawner / restore 域等） | 我方 5 登记 + 13 清理 + 3 收紧                                                            |
| line-counts     | HARD 1 / VIOL 0 | **HARD 0 / VIOL 0** 🎉                                                      | useStreamCallbacks 已拆——**前端行数门禁全绿达成**（G-03a/b/c/d + sessionRustDb 全部落地） |
| depcruise       | 0               | **0**                                                                       | 保持（2034 modules）                                                                      |
| 结构债          | 红级仅 core_run | **红级仅 core_run（8057 实现段，SR-02 域切分后归零）**                      | 29 红级 → 仅剩 1 个在途拆分                                                               |

## 三、主控修复记录

1. **useStreamCallbacks.ts:52** `dismissTransientRunNotice` 未使用（G-03c 拆分遗留）→ 移除
2. **tauriTransport.test.ts:67** `args` 未使用参数（S2 测试）→ 移除
3. **SR-05 补债**：background 测试 32+6 用例恢复（轮 3 声称零删除但实际丢失——**审计 Agent 补验发现的真实缺口**，已修复）

## 四、顺延与待处理（收口轮输入）

1. **并行域 restore.rs 半拆编译红**（E0583×2 + E0425）：持续阻塞 workbench 编译（SR-01/05/B1-5/S3 的真跑复验都等它）——**收口轮首要协调项**（并行域修复 or 主控修）
2. **SR-02 core_run 域切分**（8057 实现段 → run/ 目录）：S2 注入面、SR-01 真跑复验都依赖它
3. **B2 spawn_blocking**（note_commands 已拆完 → 可派）
4. **CONN-01/03/04 真跑**（dev:workbench 环境）
5. **SR-01 cfg(test) 验收口径**：主文件 2 处结构性接线（#[path] + re-export）无法物理归零——收口轮定夺口径（建议「散落块清零 + 仅接线」为验收）
6. **SR-05/01/B1-5/S3 的 workbench cargo test 真跑复验**（MSVC 就绪，待 restore.rs 修复）
7. **SR-06h 复核表余项**：11 条存量过期登记（error/parse 五件/build/vendor/retry/executor/bridge/write_paths 均已 ≤600 可清理）

## 五、下一轮（轮 7 · 链尾 + 收口准备）

按定稿 §四 轮 7：SR-02b/c（core_run 域切分，若 restore 修复）/ B2（spawn_blocking）/ S2 注入面接线（SR-02 后）/ CONN-06 清单 / **收口轮**（restore.rs 协调修复 + workbench 全量真跑 + 门禁复拍 + EL/19/00 同步 + 基线清理）。
**收口轮允许 <5 Agent**（附录 B §2）——剩余工作：restore.rs 修复（1）、workbench 真跑复验（1）、SR-02（1-2）、B2（1）、CONN 真跑（1）、主控收口（自身）。

_2026-08-13 · 主 Agent · 轮 6 收口 · 前端行数门禁全绿达成 · 结构债红级仅剩 core_run_
