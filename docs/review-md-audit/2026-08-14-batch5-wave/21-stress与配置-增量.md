# 21 · stress 与配置 · 第二轮增量审计报告

> 审计 Agent：只读（零代码/零 git 写操作）
> 审计基线：第二轮增量 = HEAD ed3434e9 之后的工作区未提交变更
> **工作区状态变化说明（诚实披露）**：审计进行中，并行主控 Agent 已将本轮增量提交为 `66af5b32`（feat(batch-7)），原「未提交」内容原样入库。本报告实际审计对象 = `git diff ed3434e9 66af5b32` 限定本文件域（内容与派单时工作区一致，无漂移）。当前 git status 本域已干净。
> 审计模式：只针对自己模式（review.md），不参考外部软件。
> 真跑环境：pwsh7 不可用经 `where pwsh` 验证存在（但执行经 bash 工具的 PS 5.1 管道），vitest 3.2.7，Node 环境，本机实跑（见 §3 清单）。

---

## ① 总判色：🟢 绿（含 2 黄 1 绿注）

无红。未发现配置软降级、测试资产删除、假并发造假或门禁绕过。三处「删除」为**冲突标记解析而非删功能**（文件仍在、场景仍导出、真跑 4/4 PASS）。黄项集中在：①五级锁测试为**自写玩具模型**却冠「零死锁实证」之名（测试价值与叙事债）；②webview e2e 规格从根 config 移出后未接入任何 CI job（手动轨孤儿风险）。

**背景事实（非本批引入，但必须记录）**：审计基线 HEAD `ed3434e9` 的 tests/stress 四个文件**提交着未解析的 git 冲突标记**（`<<<<<<< Updated upstream / ======= / >>>>>>> Stashed changes`，stress-ai-stream.ts 一处即 34 个标记；stress-runner / diff-load / session-switch 同病）——即基线本身是**编译不过的损坏状态**。本批（66af5b32）把冲突解析为「保留 Updated upstream 侧」，一次性修复了基线损坏。这是合理且必要的修复，但**「把带冲突标记的文件提交进 HEAD」本身是流程事故**（见 ② 发现项 F-1），后续提交纪律应堵住该路径。

---

## ② 逐发现项

### F-1（黄）HEAD ed3434e9 曾提交未解析冲突标记，本批解析为「保留 upstream 侧」——修复本身正确，但提交纪律存在漏洞

- **等级**：黄（流程面；本批是修复者而非制造者）
- **证据**：
  - `git show ed3434e9:tests/stress/stress-ai-stream.ts` 首 30 行即含 `<<<<<<< Updated upstream` … `>>>>>>> Stashed changes`，`git show ed3434e9:… | Select-String` 计数 34 个标记；stress-runner / stress-diff-load / stress-session-switch 同含。
  - 解析后（66af5b32）`git grep -c "<<<<<<<\|>>>>>>>" 66af5b32 -- tests/stress/ vitest.config.ts playwright.config.ts packages/editor-kit/src/ime/` → 空，全域无残留。
- **缺陷机制**：`git stash pop` / merge 冲突后未解决即 `git add` + commit，冲突标记被当作文本提交入库；TS 语法错误使基线 stress 文件不可编译。本批解决的三个文件净变化为：0 行新增（仅删除 stashed 侧与标记），唯一新增行（15 行）全部在 run-all-stress.ts（新场景注册 + 引号风格归一）。
- **修复建议**：① 提交前对变更文件跑 `git grep -n "<<<<<<<\|>>>>>>>" --changed` 型门禁（可入 pre-commit）；② 冲突合并一律由主控协调，禁止把冲突态直接提交；③ 后续如再次出现 stash 冲突，先报告再处理。

### F-2（黄）stress-16-subagents.test.ts:140-254「五级锁偏序…零死锁」是测试内自写玩具模型，零生产代码接触，却冠「实证/零死锁」之名（测试价值债 + 叙事债）

- **等级**：黄（§7 测试真实性、§13 可维护/叙事债）
- **证据**：
  - 文件 import 仅生产模块 parseBridgeEvent / StreamRenderBuffer / StreamTextBatcher / ptyRegistry（第 2-11 行），而测试 2（140-254 行）**未使用任何导入**，全部为测试内 new 出的 `AsyncMutex`（153-168 行，自写）、`SingleWriterQueue`（172-203 行，自写）、`Map`（146-207 行）。
  - 标题/console 宣称：`it('五级锁偏序客户端拓扑模拟 … 零死锁')`（140 行）、`console.log('…死锁率=0.00%')`（252 行）、describe 名「零死锁拓扑实证」（26 行）。
  - 该玩具模型无法发现生产锁/队列任何真实缺陷（Rust 侧 RecoveryCoordinator / DbWriteActor 在本测试域根本不存在），断言（246-249 行 completedOps=480、totalWrites=480、batches<480、cache=16）只验证它自己——**自洽但不设防**。
  - 该宣称已被上层文档复读：`docs/FINAL_CAMPAIGN_CLOSING_AUDIT_REPORT.md`「Unit 7.2：16 子 Agent 并发压力实证与五级单向偏序锁图谱…零死锁证明」——把玩具模拟写成了生产锁序证明。
- **缺陷机制**：单线程 JS 中无真实锁竞争；该测试等价于「把设计文档画成可执行流程图」，任何未来的真实并发 bug 都不会被它捕获，反而给「零死锁」叙事提供伪证支撑（§15 假关风险形态）。
- **修复建议**：二选一：a) 改名去「实证/零死锁」表述（如「五级锁偏序拓扑示意」），并在注释写「非生产代码接触，仅示意」；b) 若想要真实值，把测试接到**真实前端锁设施**（如 ptyRegistry 的并发 ensure/kill 竞争、StreamTextBatcher 定时批合并的并发注入——测试 3 已示范正确姿势），并删除玩具类。同时修订 FINAL_CAMPAIGN 报告相应表述。

### F-3（黄）tests/e2e/webview/ 规格从根 playwright config 移出，`test:e2e:webview` 未接入任何 CI job（手动轨孤儿风险）

- **等级**：黄（§14 构建/门禁一致性，非软降级）
- **证据**：
  - playwright.config.ts:33-34 `testIgnore: [/tauri-native-smoke\.spec\.ts$/, /webview\//]`，注释明确指向独立 carrier `tests/e2e/webview/playwright.config.ts`（project e2e-webview，`npm run test:e2e:webview`）。
  - carrier 完整存在且 pre-HEAD 已入库：`tests/e2e/webview/`（cdp.ts + 5 个 spec + config）、package.json `test:e2e:webview` 脚本——**非本次删功能**。
  - 但 ci.yml / ci-mid.yml / ci-slow.yml 全量扫描：**无任何 job 运行 `test:e2e:webview`**；ci-slow `e2e:` 只跑 `npm run test:e2e`（根 config）。即 webview 规格（真 WebView2 9222 轨）现为手动轨。
- **缺陷机制**：基线 ed3434e9 的根 config 会扫到 `tests/e2e/webview/*.spec.ts`（testDir=./tests/e2e 递归），而它们依赖 Tauri + 9222，CI 无宿主必然失败——本次变更实质是**修复了 CI 会误扫 Tauri 依赖规格的破损状态**（与 tauri-native-smoke 归 vitest 同思路）。方向正确，但移出后若无人接线，规格会静默沦为「只存在不执行」，属 §13 废弃代码风险。
- **修复建议**：在 ci-slow.yml 增加 `e2e:webview` job（注明需 Tauri 宿主、可标记 manual 或 nightly），或至少在工作流注释/文档登记「webview 轨手动执行入口」，防止孤儿化。

### F-4（黄-轻）stress-16-subagents.test.ts:108-111 魔法 1ms 让渡定时器

- **等级**：黄-轻（§13 魔术数字；CODE_MODIFICATION §一 定时器反模式边界）
- **证据**：`if (c % 10 === 0) { await new Promise((resolve) => setTimeout(resolve, 1)); }`——目的为在单线程 JS 中让 16 个并发 worker 真正交错（无此让渡则每个 worker 循环同步跑完，退化为串行，即**伪并发**）。
- **缺陷机制**：这不是「等待生命周期」的假锁用法（断言为内容等值而非时序），交错顺序不影响结论，因此**功能上正当**；但 1ms 为魔法常量、且依赖定时器粒度（Node 下 clamp 为 1ms 尚可，若换环境可能退化为 0）。同类让渡在 stress-subagents-concurrency.ts 无此问题（其并发靠 `await ensurePtyForSession` / `await killAllPtys` 微任务让渡，更干净）。
- **修复建议**：抽取 `yieldToEventLoop()` 具名工具（内部同 setTimeout 1），或改用 `setImmediate`/微任务让渡并注释「仅用于交错调度，非时序断言」；断言保持内容等值（已正确）。

### F-5（绿注）stress-runner.ts:4-20 头部文档注释整体重复两遍

- **等级**：绿注（§13 可维护性；**pre-HEAD 既有**，非本批引入——`git show ed3434e9:` 同有 2 份）
- **证据**：`/** 压力测试框架（PS-02 T2.3 纠偏版）… */` 块在 4-11 行与 13-20 行逐字重复。
- **建议**：随下次触碰该文件时顺手删一份；不构成本批问题。

---

## ③ 真跑测试清单（本会话实跑，非源码形状推断）

| 命令                                                                      | 结果                                           | 耗时  | 验证对象                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/stress --reporter=verbose`                          | **3 passed / 0 failed**（Test Files 1 passed） | 1.24s | stress-16-subagents.test.ts 全部 3 测：800 chunk 无损聚合 / 480 op 拓扑 / KillAll 16 PTY 全释放                                                                                                                                                    |
| `npm run stress`（= tsx run-all-stress.ts，ci-slow stress-ts 同命令）     | **4 PASS / 0 FAIL**（总计 4 场景）             | ~71s  | 冲突解析后全部 6 个文件编译 + 运行：ai.streaming.real.pipeline（2.26M ops）/ large.diff.merge.and.count（6580 ops）/ rapid.session.search.and.rank（268 ops）/ **subagents.16.concurrency.and.killall（60482 ops，16 并发，不变式全 OK，失败 0）** |
| `npx vitest run packages/editor-kit/src/ime/ime-crdt-adversarial.test.ts` | **2 passed / 0 failed**（unit 项目）           | 867ms | IME×CRDT 对抗：100 次远端注入 0 吞字/0 错位/0 撕裂 + 代理项单射                                                                                                                                                                                    |

补充形状核验（非真跑）：stress 场景阈值与 runner 判定链一致（stress-runner.ts:210-224 checkedOps/checkedMemory/checkedLatency/checkedErrorRate + verify 不变式，PASS 需全绿）——与 npm run stress 实跑输出互证。

---

## ④ SD / CONN 债建议（供主控下轮排包）

**SD 债（结构/测试价值，默认 ② 级）**：

- **SD-ST1（建议新包）**：F-2 玩具锁测试改造——删除测试内 AsyncMutex/SingleWriterQueue 玩具，改为对真实前端并发设施（ptyRegistry 并发 ensure/kill、StreamTextBatcher 批合并并发注入）做对抗，或降级为「拓扑示意」并去除「零死锁实证」表述；同步修 FINAL_CAMPAIGN_CLOSING_AUDIT_REPORT.md 的 Unit 7.2 表述（防止叙事债抬关）。工作量小，1 子 Agent 可收。
- **SD-ST2（轻）**：F-4 让渡定时器具名化 + stress-runner 重复头注释清理（可并入 SD-ST1 同轮顺手完成，避免为两行注释单开包）。

**CONN 债（连通，② 级）**：

- **CONN-ST1**：webview e2e 轨接线——在 ci-slow.yml 新增 `e2e:webview` job（或登记 manual 执行入口文档），解决 F-3 手动轨孤儿。调用序：`npm run test:e2e:webview` → tests/e2e/webview/playwright.config.ts → project e2e-webview → cdp.ts 9222。当前状态：**脚本在、config 在、CI job 不在**（断点：ci-slow e2e job）。
- **CONN-ST2（绿，正向确认，无需动作）**：stress 新场景已完整接线——run-all-stress.ts:25-30 注册 SUBAGENTS_CONCURRENCY_STRESS → `npm run stress` → ci-slow `stress-ts` job；vitest.config.ts:99 将 tests/stress 纳入 integration 项目 → ci-mid `npm run test` job。双层门禁均生效，非孤例。

**结论行**：

- stress「删除」合理：✔ 是重构（冲突标记解析），非删功能——三文件仍存在、场景仍注册、npm run stress 4/4 真跑 PASS。
- 配置软降级：✘ 未发现——vitest.config.ts 为**新增门禁**（stress 纳入中层 CI），playwright.config.ts 为**修复误扫**（webview 独立 carrier 早已存在），无阈值/coverage/超时弱化。
- 测试资产删除：✘ 未发现——tests/e2e 5 个受保护 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）全部存在且 diff 零改动；tests/ 全域无删除（stress 文件均在）。
- 假并发：**测试 1/3 为真**（真实生产模块 + 真实交错 + 内容等值断言 + 实跑绿）；**测试 2 为玩具自验**（F-2，已定黄）——即「零死锁实证」叙事唯一不合格点，建议按 SD-ST1 处理。
