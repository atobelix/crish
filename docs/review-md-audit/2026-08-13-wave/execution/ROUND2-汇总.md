# 轮 2 汇总 · 2026-08-13-wave 修复战役（门禁根因 + 结构首刀）

| 元数据            | 值                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------ |
| **轮次**          | 执行轮 2（R3-2）· 按 `plans/00-执行方案定稿.md` §四 轮 2                                   |
| **派单**          | 9 单元 · 全部完成                                                                          |
| **提交**          | 9 个提交 · 主控统一 `git commit --only`                                                    |
| **HEAD**          | （轮 2 最后一提交）                                                                        |
| **子 Agent 异常** | CONN-01 返回缺最终消息（产出已落盘）→ 主控核查确认完整（cdp.ts/config/spec/script 四件套） |

---

## 一、单元完成状态

| 单元         | 内容                                                                                                                                                 | 验证结果（真跑）                                                                                                  | 结果          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------- |
| **G-01**     | crate-size 语义硬化：登记带行数 + **已登记回涨即 FAIL**（根因闭合 core_run_commands 2524→17510 盲区）+ `--migrate` 独立迁移 66 条 + `--check-format` | 迁移 exit 0（66 条全含行数）；回涨回归测 exit 1（1107→1108 被拦）；check-format 双态；--update/--migrate 互斥守卫 | ✅ `dcb424c1` |
| **G-03a**    | noteApi.ts HARD 拆分：704→**187** barrel + contracts/wire/memory 3 子模块（依赖单向无环）                                                            | typecheck 零错 + vitest 240 全绿；HARD 4→3                                                                        | ✅            |
| **G-03b**    | BrowserImportSection HARD 拆分：751→**471** + 4 hooks + ExportAuthDialogs 子组件                                                                     | typecheck exit 0 + vitest 21/21                                                                                   | ✅            |
| **G-03d**    | VIOL 收敛 9→2：messageWindow 558→111（拆 5 叶）+ McpServerList 572→453（拆 2 组件）+ 5 文件登记基线；并行域 2 文件跳过                               | 97 用例全绿 + typecheck 绿；HARD 5→3（sessionRustDb 新 HARD 记录上报）                                            | ✅            |
| **G-05A**    | 首屏内联 style/script 外链化：index.html 203→46 行 + public/loader.css/js 逐字搬移                                                                   | dev server HTTP 实测（/ 无内联 + 资产 200）；build dist 资产落盘验证；**未跑真 Tauri 窗口**                       | ✅            |
| **SR-06a-1** | subagent.rs 拆分：3305→**70** 门面 + defs/guard/contract/tool 4 模 + 测试旁挂 6 文件                                                                 | cargo test 735 全绿（subagent 系 124）；公开 API 零 break；守卫/配额/嵌套拒绝语义零变更                           | ✅            |
| **SR-06a-2** | shell.rs 拆分：3251→**418** 门面 + invoke/redirect/exec/output 4 模 + 测试外置                                                                       | cargo test 721+14 全绿；52 测零删除；**安全校验锚点逐字保留**（CommandGatekeeper/写路径互斥等）                   | ✅            |
| **SR-06c-1** | stream_error 1938→**94** + loop/mod 1870→**157** 拆分（恢复面/降级面/配置/装配/控制面分模）                                                          | lib 失败面与开工基线**同集合**（12 并行域 compaction 中间态）；run_loop 32/32；484 用例零丢失                     | ✅            |
| **CONN-01**  | 真 WebView e2e 载体基建：tests/e2e/webview/（cdp.ts CDP9222 + 冒烟 2 测 + 独立 config）+ test:e2e:webview script                                     | **未真跑**（并行域编译损坏：agent-tools E0425 + 运行时 tokio panic，非本单元域）；代码完整 + 诚实边界句在         | ✅            |

## 二、门禁状态 Δ（轮 1 → 轮 2 收口）

| 门禁             | 轮 1 基线            | 轮 2 收口                                                                                                           | Δ       |
| ---------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| line-counts HARD | 4                    | **3**（eventParser 并行域 / noteApi ✅拆 / BrowserImportSection ✅拆 / useStreamCallbacks 待拆 + sessionRustDb 新） | ↓       |
| line-counts VIOL | 9                    | **2**（goalModeController/sessionSharedHelpers 并行域跳过）                                                         | ↓↓      |
| depcruise        | 0（轮 1 CT-03 已修） | **0**                                                                                                               | =       |
| crate-size FAIL  | 88                   | 88 存量 + 并行域新增（shell_tests/subagent_tests 等未登记超限被新语义正确拦截）                                     | 待 G-02 |

## 三、上报问题（主控裁决登记）

1. **check-dist.mjs:137-139 `--csp-enforce` 断言**（G-05A 上报）：强制 prod CSP script-src 必须含 sha256- 条目——阶段 A 后内联归零，断言将 FAIL → 需 G-05B 或 G-06 同步修订（改为「内联 script 为零时允许无 hash」）。
2. **新 HARD #5 sessionRustDb.ts 1087 > 基线 1068**（G-03d 上报）：回涨 + clean 态，不在 G-03a/b/c 分工 → 结构轮或新任务拆分。
3. **shell_tests.rs 1462 行 + subagent_tests\_*.rs**（SR-06a-2 上报）：测试外置文件触 crate-size mod 门禁（≤600 未登记）→ G-02 登记（测试旁挂豁免面，需与 G-01 语义协调——测试文件是否应豁免或登记）。
4. **browser-panel 其余 7 测试套件环境性失败**（G-03b 上报）：`document is not defined`（无 @vitest-environment jsdom 指令，PS-02 配置遗留）→ 需补 jsdom 指令（小修，可入收口轮）。

## 四、下一轮（轮 3 · G-02 登记 + 结构大件）

按定稿 §四 轮 3：G-02 槽 1–4（crate-size 88 项登记收敛）+ G-05B（CSP 声明）+ SR-03（tool_exec）+ SR-04（engine）+ SR-05（background）+ SR-06d（orchestrator）+ SR-06e（agent-provider）。
**轮 3 末：主控执行「冻结+收口」统一动作**（core_run_commands 功能写入停止 + 工作区提交完成）→ 轮 4 起 SR-01/02 可开工。

_2026-08-13 · 主 Agent · 轮 2 收口 · 全部单元完成并提交_
