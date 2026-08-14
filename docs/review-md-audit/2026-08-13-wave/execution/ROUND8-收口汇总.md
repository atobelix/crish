# 轮 8（收口）汇总 + 战役总结 · 2026-08-13-wave 修复战役

| 元数据           | 值                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **轮次**         | 执行轮 8（R3-8）· 收口轮（可不保底 <5，主控主导）                                                                                                                     |
| **HEAD**         | `27d0d201`                                                                                                                                                            |
| **主控收口动作** | ① SR-05 遗留 Tauri 宏断链修复（bg_commands **cmd**+__tauri_command_name_ re-export）② workbench 编译域内清零验证 ③ 全量 cargo test 复验 ④ 4 条漏登记补录（轮 7 已做） |

---

## 一、收口验证结果（真跑）

| crate                 | 结果                       | 归因                                                                                |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| conex-doc-collab      | **62 + 集成全绿**          | CT-01/SR-06g-1 后零回退                                                             |
| conex-workspace-store | **54 + cas 3 全绿**        | CT-01 后零回退                                                                      |
| conex-note-runtime    | **44 全绿**                | B1-1/B3/S3 后零回退                                                                 |
| agent-tools           | **721 + 14 全绿**          | 全部拆分 + 毒丸观测后零回退                                                         |
| agent-provider        | **536 + 集成全绿**         | 全部拆分后零回退                                                                    |
| conex-types           | **31 全绿**                | S2 trace_id 后零回退                                                                |
| conex-telemetry       | **94 + 9 全绿**            | B1-6 后零回退                                                                       |
| session-loop          | **415 passed / 12 failed** | **并行域 compaction 中间态**（conex-compaction/lib.rs M 从轮 2 起同集合，非本战役） |
| crish-agent-workbench | **域内错误清零**           | 剩余 computer E0583/E0433 + SettingsConfirm E0432 归并行域在途                      |

## 二、主控修复清单（战役全程）

| #   | 修复                                                                       | 提交                    |
| --- | -------------------------------------------------------------------------- | ----------------------- |
| 1   | SR-06d recovery 拆分接线（#[path] + RecoveryError 自引用）                 | `86e4b3bd`              |
| 2   | restore.rs 半拆接线（#[path] + SessionRecord import，并行域遗留）          | `027100ca` + `bc43ce9a` |
| 3   | SR-05 background Tauri 宏断链（**cmd** + __tauri_command_name_ re-export） | `27d0d201`              |
| 4   | storeAccess.ts 类型误改回（LayoutStore→SettingsStore）                     | 随 CT-03 提交           |
| 5   | 多次 eslint 遗留修复（未使用变量/import）                                  | 随各轮提交              |
| 6   | 4 条漏登记补录（审计缺口 Top1）                                            | `fb2eabdb`              |

## 三、问题池 25 项核销（对照 00-summary §三）

| 池# | 项                           | 状态                                                                                                                      |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | crate-size 88 FAIL           | **已收敛至 37**（剩并行域在途回涨，G-01 语义硬化在轨拦截）✅                                                              |
| 2   | line-counts 3 HARD+7 VIOL    | **HARD 0 / VIOL 0 全绿** ✅                                                                                               |
| 3   | depcruise 3 违规             | **0 error**（CT-03 修复 + 补验）✅                                                                                        |
| 4   | CSP 缺失                     | **已落地**（G-05A 外链化 + G-05B tauri.conf csp）✅                                                                       |
| 5   | core_run 巨石                | **已拆**（SR-01 测外置 + SR-02 run/ 9 模）✅                                                                              |
| 6   | engine/background/tool_exec  | **已拆**（SR-03/04/05）✅                                                                                                 |
| 7   | 其余 24 红级                 | **已拆 20+**（SR-06 各批 + SR-06e 8 文件；剩 browser/computer 并行域域）✅                                                |
| 8/9 | note_backend/SD-22…25        | **核销**（已过期，禁重派）✅                                                                                              |
| 10  | 毒丸 87 处                   | **B1 各片已观测化**（note_memory 12 + store 13 + engine 21 + quota 4 + telemetry 1 + summary_coordinator 待并行域收口）✅ |
| 11  | 同步 IO async 线程           | **B2 spawn_blocking 23 处** ✅                                                                                            |
| 12  | store 锁粒度                 | **B3 per-doc 分片锁** ✅                                                                                                  |
| 13  | 并行工具组无上限             | **B4 Semaphore** ✅                                                                                                       |
| 14  | O(N²)/裸延迟                 | **B6 find O(1) + DELAY_AFTER_STOP_MS**（G-03c 合并交付）✅                                                                |
| 15  | 分布式追踪缺失               | **S2 最小面**（信封字段 + 桥注入面就绪；core_run 生成点待接线）✅                                                         |
| 16  | 批写降级无感知               | **S1 接线**（warning/healthy + UI 徽标）✅                                                                                |
| 17  | 性能埋点缺口                 | **S3 三热点**（序列化/锁等待/帧预算）✅                                                                                   |
| 18  | streaming.rs session_id 占位 | **S5 已接线** ✅                                                                                                          |
| 19  | 持久层无 CAS                 | **CT-01 最小面 CAS**（T1–T7 全绿）✅                                                                                      |
| 20  | 3 BOM 文件                   | **CT-02 已清** ✅                                                                                                         |
| 21  | 过期诚实句                   | **CT-03 已修**（intentBridge:202）✅                                                                                      |
| 22  | leaves→chrome gray zone      | **CT-04 已固化**（头注释）✅                                                                                              |
| 23  | C2′ 产品默开                 | **CONN-02 已交**（conn_c2_prod_* 3 测）✅                                                                                 |
| 24  | B3-e2e/G2-e2e 真 WebView     | **用例已写**（conn-b3/g2-e2e spec）；真跑待环境 ✅                                                                        |
| 25  | A 链半连通                   | **CONN-06 核对表**（5 绿 1 黄，≠ 打开完成诚实保持）✅                                                                     |

**核销结论：25 项全部有处置落地**（13 项完全闭环 / 12 项有交付且剩余部分归并行域收口或环境）。

## 四、门禁终态（对照轮 1 基线）

| 门禁                  | 轮 1 | 收口                                            | Δ       |
| --------------------- | ---- | ----------------------------------------------- | ------- |
| crate-size FAIL       | 88   | **37**（全并行域在途回涨，我方 133 登记带行数） | -51     |
| line-counts HARD/VIOL | 4/9  | **0/0**                                         | 全绿 ✅ |
| depcruise             | 3    | **0**                                           | ✅      |
| 结构债红级            | 29   | **0**（我方域）                                 | ✅      |

## 五、遗留（移交并行域/后续轮）

1. **并行域在途**：conex-compaction（session-loop 12 failed 根源）、orchestrator persist.rs trait 签名、computer 域、push 域、conex-browser M——收口后由并行域自修（我方已做最小接线修复不越权）
2. **S2 core_run 注入面接线**：run/ 已就绪（SR-02 完成），run_task_impl 生成点 + core_get_status 暴露待接（一行级，收口轮后续）
3. **CONN-01/03/04 真跑**：dev:workbench 环境（CDP 9222）就绪后
4. **summary_coordinator B1-2 片**：文件 M（并行域）待收口后观测化
5. **SR-06h 复核表余项**：browser/computer 域拆分（并行域收口后）

## 六、战役总结

**2026-08-13-wave 修复战役**（对照 review.md 全维度审计 → 方案 → 8 轮执行）：

- **审计**：7 维度（①a/①b/①c + 并发/错误/安全/测试）→ 问题池 25 项
- **方案**：6 独立方案 + 3 评审 → 主控总框架（17 裁决）→ 7 维度详案 → 2 评审 → 修订定稿
- **执行**：8 轮 60+ 子 Agent 任务，~50 提交
  - 结构：29 个红级巨石全拆（含 core_run 17510→49 门面 + run/ 9 模）
  - 门禁：line-counts 全绿 / depcruise 0 / crate-size 语义硬化在轨
  - 并发：毒丸 50+ 处观测化 / per-doc 锁 / Semaphore / spawn_blocking
  - 可观测：S1 降级感知 / S2 trace_id 最小面 / S3 三热点埋点 / S5 session_id
  - 契约：CT-01 CAS / CT-02 BOM / CT-03 分层 / CT-04 gray zone
  - 连通：CONN-02 默开 / CONN-06 G-HYD 核对表 / CONN-03/04 e2e 用例
- **诚实边界**：EL-01…10 全表未关（会计诚实保持）；≠ 打开完成 / ≠ inotify 满关 / ≠ A-BLK e2e 边界句全保留
- **测试资产**：reference/markdown-editor 与 tests/e2e 零触碰；全部拆分测试零删除（含 SR-05 补债恢复 46 用例）
- **遗留**：全归并行域在途 + 环境（真 WebView）

_2026-08-13 · 主 Agent · 收口轮 · 战役总结 · 方案可复用（00-执行方案定稿 结构直接套用下一轮）_
