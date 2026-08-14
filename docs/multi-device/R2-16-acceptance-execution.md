# R2-16 验收执行记录（真机联调——E2E-1 配对 + E2E-2 事件流核心闭环）

> 文档编号：R2-16-acceptance-execution
> 角色：R2-16 验收执行（运行 + 记录 + 产出文档；未编译任何 Rust 代码）
> 日期：2026-08-14（第 13 次派发；**第 14 次派发追加见 §9~§14**）
> 定位：R2-16-e2e-plan.md（场景步骤 + 主控裁决 1/2）的**执行侧记录**——E2E-1~6
> 场景核对表 + 输入路径尝试记录 + 失败根因 + 环境记录 + 产品缺陷清单 + 遗留清单。
> 编码：UTF-8 无 BOM，中文。

---

## 1. 结论速览

| 项           | 结论                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E-1 配对   | **BLOCKED**（输入路径 b 成功完成 UI 输入并点击「连接」，但配对流程在密钥协商阶段崩溃——Hermes 运行时缺 `crypto.getRandomValues` polyfill，RedBox 报错阻断；见 §3 缺陷 DEF-3）                                                                                                                                                                              |
| E2E-2 事件流 | **BLOCKED**（依赖 E2E-1 配对成功；未达会话连接阶段）                                                                                                                                                                                                                                                                                                      |
| E2E-3~6      | **BLOCKED**（级联：全部依赖配对成功前置）                                                                                                                                                                                                                                                                                                                 |
| 输入路径 a   | **失败**：模拟器镜像 `cmd clipboard` 未实现（`No shell command implementation`，API 35 AOSP 镜像缺该命令）                                                                                                                                                                                                                                                |
| 输入路径 b   | **成功**：8+4 分段 `input text`（`KC5QBNTV` 单帧 → `CXN-KC5Q-BNTV` → `WH9L` → `CXN-KC5Q-BNTV-WH9L`），连接按钮 enabled=true，点击后进入配对流程（随后被 DEF-3 阻断）                                                                                                                                                                                      |
| 输入污染复现 | **实证复现**：单帧输入完整码 `CXN-KC5Q-BNTV-WH9L` → 显示被污染为 `CXN-CXNC-XNCX-NCXC`（受控组件 value=formatPairCodeDraft(codeRaw) 所致；真实用户粘贴/输入同样受影响，产品缺陷 DEF-2）                                                                                                                                                                    |
| 关键新发现   | **并行阵营回归**：f5e044ee（12:03）提交 7 文件 `import { dualHitSlop } from '@/presentation/components/ui/hitTargets'` 但**漏提交 hitTargets.ts 本体**（从未入库，且工作区文件一度消失）→ Metro bundle 失败 → app 无法加载；本次执行轮发现时已被并行 Agent 恢复（13:14 staged），Metro 重新 Bundled 1641 modules 后 app 可加载（§5.2 时间线；遗留清单项） |
| 验收口径     | E2E-1/2 **无 PASS 证据**；输入路径 a/b/c 各结果已如实记录（a 失败 / b 成功至流程入口 / c 未达——因 b 已打通 UI 输入，后续被产品缺陷阻断而非输入不可达）                                                                                                                                                                                                    |

**一句话**：本轮打通了「app 加载 → manual 页 → 8+4 分段输入成功 → 连接按钮可点」的最小可完成闭环，
但配对流程在**客户端密钥协商**（X25519 keygen）崩溃——这是**产品缺陷**（Hermes 缺 Web Crypto polyfill），
不是环境阻塞；需补 polyfill（或换随机源注入面）后复测 E2E-1。

---

## 2. E2E 场景核对表

| 场景             | 结果        | 证据（时间/文件/日志）                                                                                                                                                                                                                                                                                | 耗时    | 备注                                                  |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------- |
| E2E-1 配对       | **BLOCKED** | manual 页输入完成（ui-c2.xml：`CXN-KC5Q-BNTV-WH9L`，connect enabled=true）→ 点击连接 → RedBox `crypto.getRandomValues must be defined`（noblePrimitives.ts:27:58；Metro 日志 `ERROR [Error: crypto.getRandomValues must be defined]`）→ 配对码未消费（pairing.json 不存在，服务端无 pair.hello 到达） | ~15 min | 阻断点=产品缺陷 DEF-3（密钥协商崩溃于网络帧发出之前） |
| E2E-2 事件流     | **BLOCKED** | 依赖 E2E-1 配对成功（会话连接 ensureObservationWiring 未建立）；未达订阅/推送观察阶段                                                                                                                                                                                                                 | —       | 级联                                                  |
| E2E-3 审批闭环   | **BLOCKED** | 依赖 E2E-1；approvalWiring 的 `getObservationWiring()?.client.gateway` 无会话可用                                                                                                                                                                                                                     | —       | 级联                                                  |
| E2E-4 断线续传   | **BLOCKED** | 依赖 E2E-1（在线态/会话游标均不存在）                                                                                                                                                                                                                                                                 | —       | 级联                                                  |
| E2E-5 撤销即时性 | **BLOCKED** | 依赖 E2E-1（桌面设备列表无该 deviceId——从未配对）                                                                                                                                                                                                                                                     | —       | 级联                                                  |
| E2E-6 移除本机   | **BLOCKED** | 依赖 E2E-1（从未配对，无凭据可清）                                                                                                                                                                                                                                                                    | —       | 级联                                                  |

---

## 3. 产品缺陷清单

### DEF-1（前序已定性，本轮确认）manual 页 host 输入无污染、code 输入受控组件污染——pairManualScreen.tsx:297-298

| 项   | 内容                                                                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置 | `apps/crish-mobile/src/presentation/pair/pairManualScreen.tsx:297-298`（`value={formatPairCodeDraft(codeRaw)}` + `onChangeText={setCodeRaw}`），格式化函数 `formatPairCodeDraft` :113-127                                                |
| 复现 | manual 页 code 框**单帧输入完整码** `CXN-KC5Q-BNTV-WH9L`（adb `input text` 一次注入）→ 显示被污染为 `CXN-CXNC-XNCX-NCXC`（ui-pol.xml 实证；截图 e2e1-input-pollution.png）；8+4 分段输入可正常（路径 b 成功）                            |
| 影响 | **真实用户同样受影响**（受控组件 value 与原生输入光标错位——React 每次渲染用格式化值重写原生框，IME/粘贴/快速输入时后续字符被插入错误位置）；单次粘贴完整码必乱码，用户只能碰运气分段输入                                                 |
| 根因 | 受控组件 value 派生自 raw state，且格式化会**改变字符串内容**（补前缀/过滤/分组加分隔符）；原生输入事件与受控重渲染互相干扰，产生字符错位/重复                                                                                           |
| 建议 | ① 输入框改非受控（defaultValue + onChange 收集 raw，展示格式仅作 hint 文案）；或 ② 格式化仅「失焦后回填」；或 ③ 若保留受控，用 selection 同步 + 只在末尾追加模式下格式化；配套补输入污染回归测试（模拟单帧完整码输入断言显示 == 期望码） |

### DEF-2（本轮实证复现）配对码单帧完整输入被污染——同 DEF-1 的 UI 侧表现（独立记录路径 a 失败证据）

| 项   | 内容                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 复现 | manual 页 code 框一次注入完整 19 字符码 → `CXN-CXNC-XNCX-NCXC`（与 DEF-1 同根因，行为面独立记录）         |
| 影响 | 路径 a（剪贴板粘贴）即使剪贴板可用也会因 DEF-1 污染失败——**用户粘贴完整码是主路径**，当前产品无法稳定完成 |

### DEF-3（本轮新发现 · 阻断 E2E-1）配对密钥协商在 Hermes 运行时崩溃：crypto.getRandomValues 缺失

| 项   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置 | `apps/crish-mobile/src/pairing/crypto/noblePrimitives.ts:26-27`（`x25519.keygen()` 内部需要 `crypto.getRandomValues`）；调用链 `pairingWiring.ts:355`（beginPairing → generateKeyPair）→ `pairMachine.ts:183`（reducePairState）→ manual.tsx onSubmit                                                                                                                                                                                                                            |
| 复现 | manual 页填 host=localhost + 码 CXN-KC5Q-BNTV-WH9L → 点击「连接」→ RedBox `Uncaught Error: crypto.getRandomValues must be defined`（截图 e2e1-redbox-crypto.png；Metro 日志 13:40 `ERROR [Error: crypto.getRandomValues must be defined]`）→ 配对码未消费（work\config\pairing.json 不存在；服务端日志无 pair.hello）                                                                                                                                                            |
| 影响 | **阻断 E2E-1 起全部场景**——配对流程在客户端密钥协商（X25519 keygen，网络帧发出前）崩溃；jest 全绿（Node 有全局 crypto）但 Hermes 无 Web Crypto——**运行时与测试环境差异的典型漏检**                                                                                                                                                                                                                                                                                               |
| 根因 | @noble/curves 的 `x25519.keygen()` 依赖全局 `crypto.getRandomValues`；RN Hermes（Expo Go / 真机均同）不提供该全局；package.json 无 `react-native-get-random-values` / `expo-crypto` 依赖；入口（app/_layout.tsx / expo-router entry）无 polyfill import                                                                                                                                                                                                                          |
| 建议 | ① 入口首行 `import 'react-native-get-random-values'`（加依赖 `react-native-get-random-values`，Expo SDK 57 兼容），或 ② noblePrimitives 的 generateKeyPair 改自备 CSPRNG（如 expo-crypto `getRandomBytesAsync`，SDK 57 已装 expo 全家桶含 expo-crypto 能力）注入随机源——KeyPrimitives 接口无随机源注入面（primitives.ts:46-50 注释「随机源只在 generateKeyPair 内使用」），扩展接口或实现内部换源均可；③ 补 Hermes 环境冒烟（Expo Go 真机加载即测，防再犯测试/运行环境差异漏检） |

### DEF-4（本轮确认 · 并行回归已恢复，仍须登记）f5e044ee 漏提交 hitTargets.ts 导致 Metro bundle 失败

| 项   | 内容                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 位置 | 提交 `f5e044ee`（2026-08-14 12:03:23，R2 round11「touch targets 11/11」）：7 个 tsx 文件新增 `import { dualHitSlop } from '@/presentation/components/ui/hitTargets'`（git show --stat 13 文件均非 hitTargets）；`git log --all -- hitTargets*` **零命中**（文件从未入库）；工作区文件 13:14 前一度不存在（Test-Path False + ui/ 目录仅 Button/Dialog/index） |
| 复现 | Metro（12:19 重启）bundle 持续失败 `Unable to resolve "@/presentation/components/ui/hitTargets"`（1626/1527/1442 modules 三次失败，r2-16-e12\metro.log 12:19-13:03）→ Expo Go 卡 splash；**13:14 并行 Agent 恢复文件（git staged `A`）→ 13:15 后 Metro Bundled 1641 modules 成功**（同日 13:15:13 hitTargets.test.ts / 13:14:48 hitTargets.ts）              |
| 影响 | 若未并行恢复，app 无法加载→E2E 全阻；当前已恢复但**未提交**（git status 显示 staged）——提交面仍有缺口（遗留清单 L-1）                                                                                                                                                                                                                                        |
| 根因 | 提交方在 commit --only 限定路径时漏含新文件（并行提交纪律 §3.3 风险实例：新文件需显式 add）；测试面 jest 在文件存在时全绿，未暴露提交缺口                                                                                                                                                                                                                    |
| 建议 | ① 提交 hitTargets.ts + hitTargets.test.ts（已 staged，随并行阵营收口）；② 提交流程补「新文件清单核对」（git status 未跟踪 → 确认入库）；③ 本缺陷与 9:14 成功 bundle（bundle-correct.js 含 dualHitSlop 模块）对照确认是「提交缺口」而非「实现缺失」——恢复内容与 3:48 沙箱副本（conex-verify）一致，1412B vs 1545B 略有差异需人工核对语义后提交                |

---

## 4. 输入路径尝试记录（E2E-1 前置输入链）

| 路径 | 结果     | 证据                                                                                                                                                                                                                                       | 备注                                                                              |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| a    | **失败** | `adb shell cmd clipboard set text 'CXN-KC5Q-BNTV-WH9L'` → `No shell command implementation`（API 35 模拟器镜像 sdk_gphone64_x86_64 的 shell cmd 无 clipboard 子命令实现；clip-set.txt 留档）；无剪贴板可用 → 长按粘贴无从触发              | 环境性失败（镜像缺命令），非产品缺陷；真机（API 33+ 有该命令）路径留真机轮        |
| b    | **成功** | 8+4 分段：tap code 框 → `input text 'KC5QBNTV'` → 显示 `CXN-KC5Q-BNTV`（ui-c1.xml，格式器自动补前缀+分隔符）→ `input text 'WH9L'` → 显示 `CXN-KC5Q-BNTV-WH9L`（ui-c2.xml）→ 连接按钮 enabled=true → 点击 → 进入配对流程（后被 DEF-3 阻断） | 与任务注记口径一致：8 字符单帧合并 → 4 字符 → 剥前缀正确；**UI 输入链路完全打通** |
| c    | 未达     | 无需触发——路径 b 已打通 UI 输入并点击连接，后续阻塞为产品缺陷 DEF-3（非输入不可达）；不重复第三路径                                                                                                                                        | —                                                                                 |

> 说明：路径 b 的成功证明「输入」环节本身可完成（8+4 分段可稳定输入），E2E-1 的 BLOCKED 判定归因于
> DEF-3（配对密钥协商崩溃）而非输入污染；但单帧完整码输入（用户粘贴主路径）仍受 DEF-1/2 污染。

---

## 5. 失败根因链与时间线

### 5.1 E2E-1 阻断根因链（本次执行轮）

```
manual 页输入完成（路径 b：localhost + CXN-KC5Q-BNTV-WH9L）
  → 点击「连接」→ onSubmit（pairManualScreen.tsx:186）→ controller.beginPairing（pairingWiring.ts:355）
  → reducePairState → generateKeyPair（pairMachine.ts:183 → noblePrimitives.ts:26 x25519.keygen()）
  → @noble/curves 内部需 crypto.getRandomValues → Hermes 无该全局 → RedBox 崩溃（DEF-3）
  → 配对码未消费（pairing.json 不存在；服务端无 pair.hello 到达）
```

### 5.2 环境时间线（本派发上下文，含并行阵营事件）

| 时间（08-14） | 事件                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 03:48-03:49   | hitTargets.ts + hitTargets.test.ts 在工作区创建（未跟踪；conex-verify 沙箱副本留档 1545B/2468B） |
| 09:14-09:34   | bundle-correct.js 导出成功（1611 modules，含 dualHitSlop 模块）——文件当时存在                    |
| 12:03:23      | 提交 f5e044ee：7 文件加 dualHitSlop import，**漏提交 hitTargets.ts**（DEF-4）                    |
| 12:14-12:19   | 第 12 次派发启动 Metro（12:19:20，PID 19676 现役）                                               |
| 12:19-13:03   | Metro bundle 连续失败（hitTargets 无法解析）→ Expo Go 卡 splash                                  |
| 13:09+        | 本派发开始：确认环境（harness 9248 e2e-1 已并行重启，配对码 CXN-KC5Q-BNTV-WH9L）                 |
| 13:14-13:15   | **并行 Agent 恢复 hitTargets.ts/.test.ts 并 staged**（DEF-4 工作区面已修复，提交面仍缺）         |
| 13:15+        | Metro `Android Bundled 1065ms (1641 modules)` 成功 → app 加载到欢迎页                            |
| 13:20-13:40   | 本派发 E2E-1 执行：欢迎页 → manual → 路径 a 失败 → 路径 b 成功 → 点连接 → DEF-3 RedBox           |

---

## 6. 环境记录

| 项         | 值                                                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模拟器     | AVD `crish-pixel`，Android 15（API 35），x86_64，google_apis；`emulator-5554` boot 完成；`adb reverse tcp:8765 tcp:8765` + `tcp:8081 tcp:8081` 已配                                                                                |
| adb        | `C:\Users\orange\AppData\Local\Android\Sdk\platform-tools\adb.exe`；输出一律 cmd /c 字节级重定向（禁 PS 5.1 管道）                                                                                                                 |
| 桌面服务   | 预构建 `Temp\opencode\r1-11-harness\target\debug\r1-11-harness.exe`（未编译任何 Rust）；PID 9248 `--workdir r2-16-accept\work --port 8765 --seed 40 --run e2e-1`，TLS=true；配对码 `CXN-KC5Q-BNTV-WH9L`（state.json），TTL 10 分钟 |
| /v1/info   | `{"service":"crish-agent-workbench","port":8765,"bindMode":"loopback","pairingActive":false,...}`（pairingActive 为静态 config 标志，与 R1-11 同款；协调器运行时接受配对码）                                                       |
| Metro      | PID 19676（node expo cli，12:19:20 启动，:8081）；日志 `Temp\opencode\r2-16-e12\metro.log`；最终 Bundled 1641 modules 成功                                                                                                         |
| 移动端 app | Expo Go（host.exp.exponent）深链 `exp://10.0.2.2:8081`；运行时无 `EXPO_PUBLIC_ENGINE_URL`（默认 10.0.2.2/localhost + wss）                                                                                                         |
| 系统 CA    | 模拟器信任 crish-remote-ca（wss 合法）——本轮未达 TLS 握手验证阶段（DEF-3 在更早崩溃）                                                                                                                                              |
| 日志位置   | 桌面：harness 控制台 + `work\logs\`；移动端：Metro 日志 + `adb logcat -s ReactNativeJS:*`（本轮 RedBox 经 Metro 转发记录）                                                                                                         |
| 证据目录   | `C:\Users\orange\AppData\Local\Temp\opencode\r2-16\`：ui-_.xml / ui-_.b64 / clip-set.txt / e2e1-*.png 4 张截图（00-welcome / manual-filled / redbox-crypto / input-pollution）                                                     |

---

## 7. 遗留清单

| #   | 项                                                                                                 | 状态/建议                                                                                    |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| L-1 | **提交 hitTargets.ts + hitTargets.test.ts**（已 staged 未提交；DEF-4 提交面缺口）                  | 并行阵营收口时提交（commit --only 限定该两文件）；提交前与 conex-verify 沙箱副本核对语义差异 |
| L-2 | **DEF-3 修复**：Hermes crypto polyfill（react-native-get-random-values 或 expo-crypto 随机源注入） | E2E-1 复测硬前置；修复后按路径 b 重跑：连接 → 断言 pair.ok + pairing.json + 进入 tab 页      |
| L-3 | **DEF-1/2 修复**：受控组件输入污染（单帧完整码输入乱码）                                           | 修复后补回归：单帧完整码输入断言显示正确；粘贴主路径可用                                     |
| L-4 | 路径 a（剪贴板）真机验证（模拟器镜像无 cmd clipboard 命令）                                        | 真机轮（API 33+）验证 `cmd clipboard set text` + 长按粘贴路径                                |
| L-5 | 配对码 TTL 已过的残余状态：harness 9248 码 CXN-KC5Q-BNTV-WH9L 未消费即失效（10 分钟）              | 复测前重启 harness 拿新码（restart-harness2.ps1 先例）                                       |
| L-6 | E2E-2~6 级联未执行（依赖 E2E-1 配对成功）                                                          | DEF-3 修复后按 e2e-plan §4 顺序执行（E2E-2 事件流可复用 R1-11 L4-4 harness fanout 注入先例） |
| L-7 | 输入污染与 crypto 缺陷的「运行时 vs 测试环境差异」未纳入测试纪律                                   | 建议 R3 轮增加 Expo Go/Hermes 真机冒烟门禁（jest 全绿≠运行时可用）                           |

---

## 8. 变更记录

| 版本 | 日期       | 变更                                                                                                                                                                                            |
| ---- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v1.0 | 2026-08-14 | 初稿（第 13 次派发）：E2E-1 BLOCKED（DEF-3 crypto polyfill 缺失）；输入路径 a 失败 / b 成功 / c 未达；输入污染实证复现（DEF-1/2）；DEF-4 并行回归记录；环境时间线 + 遗留清单                    |
| v2.0 | 2026-08-14 | **第 14 次派发追加**：DEF-3 修复验证（d7eb5d52 ladder x25519 已在 bundle）+ **新阻塞 DEF-5**（R3 通知层接线 × Expo Go 不兼容 → 路由树构建崩溃，app 无法加载）；E2E-1~6 全部 BLOCKED（非 DEF-3） |

---

# 第二部分 · 第 14 次派发（DEF-3 修复后重跑）执行记录

> 派发：2026-08-14 第 14 次（E2E-1 配对 + E2E-2 事件流核心闭环重跑——DEF-3 已修复 d7eb5d52）
> 结论速览：**DEF-3 修复确认有效（bundle 级验证 ladder x25519 零 RNG）**；但本派发发现**新阻塞 DEF-5**：
> 并行阵营 R3 通知层接线（工作区未提交改动）把 expo-notifications 引入路由可达链，
> 在 Expo Go（SDK 53+ 移除 push 支持）模块加载即抛错 → expo-router 全部路由 missing default export
> → SceneView ErrorBoundary TypeError → **app 无法加载（欢迎页都出不来）** → E2E-1~6 全部 BLOCKED（级联）。

---

## 9. 第 14 次派发结论速览

| 项             | 结论                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境重启       | Metro **run4 重启完成**（PID 47656，kill 旧 19676；`Android Bundled 1071ms (1635 modules)` 成功）；harness **run4 重启完成**（PID 33188，新配对码 **CXN-DAYJ-Y45Y-HTXL**，TLS=true，8765 监听）；**模拟器进程中途消失**（qemu 无进程）→ 重启模拟器（PID 17084）+ adb reverse 8765/8081 + spell_checker=0 重配；Expo Go 重新加载 exp://10.0.2.2:8081                                          |
| DEF-3 修复验证 | **PASS（bundle 级）**：`bundle-check-r14.js` grep 证实 noblePrimitives 已为 **RFC7748 x-only ladder 版 x25519**（`X25519_P = 2n**255n-19n`、modP、全确定性零 RNG、注释明言「去掉盲化随机源」「全确定性」）+ ExpoCrypto 探测（probeExpoCrypto）——d7eb5d52 修复内容已在 bundle（§12.1）                                                                                                        |
| E2E-1 配对     | **BLOCKED（新缺陷 DEF-5，非 DEF-3）**：app 在**欢迎页渲染之前**即崩——expo-notifications 模块级抛错 → expo-router 路由验证全部报 "missing the required default export"（12 个路由）→ SceneView `TypeError: Cannot read property 'ErrorBoundary' of undefined` → Expo Go 回退 dev launcher（截图 e2e1-r14-blocked.png；run 1 / run 2 两次复现一致）                                            |
| E2E-2~6        | **BLOCKED**（级联：app 无法加载 → 配对/会话/审批/断线/撤销/移除全部不可达）                                                                                                                                                                                                                                                                                                                  |
| 输入路径       | 未达输入阶段（app 未加载）；路径 b 沿用第 13 次结论（8+4 分段可用）                                                                                                                                                                                                                                                                                                                          |
| 根因           | 并行阵营 R3 通知层接线（`observationWiring.ts:18` import `@/notifications/pushConsumer`，**全部未提交**——git status 显示 `A/M`）→ pushConsumer import expo-notifications → `warnOfExpoGoPushUsage()`（Android + Expo Go 时 **throw**，expo-notifications/src/warnOfExpoGoPushUsage.ts:8-11）+ `requireNativeModule('ExpoPushTokenManager')`（SDK 53+ 已移除）→ 模块加载失败 → 路由树构建崩溃 |
| 验收口径       | E2E-1/2 无 PASS 证据；DEF-3 修复以 bundle 级静态证据确认（运行时被 DEF-5 阻断无法端到端验证）；run 次数如实记录（run 1 + run 2）                                                                                                                                                                                                                                                             |

**一句话**：DEF-3（crypto 崩溃）**已修复**，但本派发被**新的并行阵营回归 DEF-5** 阻断——R3 通知层接线把
expo-notifications 拉进路由可达链，在 Expo Go 环境**启动即崩**；需通知层对 Expo Go 降级/惰性加载
（或改用 dev build 联调）后才能重跑 E2E-1。

---

## 10. 第 14 次派发 E2E 场景核对表

| 场景             | 结果        | 证据（时间/文件/日志）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 耗时    | 备注                                                                                                                   |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| E2E-1 配对       | **BLOCKED** | Metro run4 `Android Bundled 1071ms (1635 modules)`（17:0x）→ Expo Go 加载新 bundle → `E ReactNativeJS: [Error: expo-notifications: Android Push notifications ... removed from Expo Go ...]` ×N（logcat-r14-all.txt 8:53:43）→ `W Route "./pair/manual.tsx" is missing the required default export` ×12（含 (tabs)/×4、详情页×4、pair/_layout、pair/manual、run/session/terminal、notifications；**welcome 幸免**——不引用 wiring 链）→ `E { [TypeError: Cannot read property 'ErrorBoundary' of undefined] componentStack: SceneView → NavigationProvider → Screen → ... }`（8:53:45）→ Expo Go 回 dev launcher（ui-r14-11.xml 仅 "crish-mobile"） | ~35 min | 阻断点 = **DEF-5**（app 加载即崩，未达 manual 页/输入/连接）；run 1（8:53）+ run 2（8:59 force-stop 重载）两次复现一致 |
| E2E-2 事件流     | **BLOCKED** | 依赖 E2E-1（app 未加载，无配对/会话）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —       | 级联                                                                                                                   |
| E2E-3 审批闭环   | **BLOCKED** | 依赖 E2E-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —       | 级联                                                                                                                   |
| E2E-4 断线续传   | **BLOCKED** | 依赖 E2E-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —       | 级联                                                                                                                   |
| E2E-5 撤销即时性 | **BLOCKED** | 依赖 E2E-1（桌面设备列表无 deviceId）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —       | 级联                                                                                                                   |
| E2E-6 移除本机   | **BLOCKED** | 依赖 E2E-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —       | 级联                                                                                                                   |

---

## 11. 产品缺陷清单更新（第 14 次派发）

### DEF-3（更新为 **已修复 · 待运行时复测**）Hermes 缺 crypto.getRandomValues → 密钥协商崩溃

| 项         | 内容                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态       | **已修复（d7eb5d52，2026-08-14 16:16）**：noblePrimitives 改为 **RFC7748 x-only ladder 版 x25519**（scalarMultBase/getSharedSecret 全确定性、零 RNG——不再需要 crypto.getRandomValues）+ probeExpoCrypto 双保险（有 Web Crypto 走 Web；Hermes 走 expo.modules.ExpoCrypto；双缺抛明确错误）；37 测试 + RFC7748 6.1 向量钉住                                                      |
| 本派发验证 | **PASS（bundle 级）**：`bundle-check-r14.js`（8.2MB，Metro run4 产物）grep `ladder` 命中 noblePrimitives 注释「ladder 版 x25519 / 全确定性 / 去掉盲化随机源」+ `X25519_P = 2n**255n-19n` + `modP` 实现（§12.1 摘录）；bundle 顶部另有并行阵营注入的全局 polyfill（`globalThis.crypto.getRandomValues ← expo.modules.ExpoCrypto`，注释「联调临时 polyfill」）——双保险冗余但无害 |
| 遗留       | **运行时端到端复测未完成**（被 DEF-5 阻断）：DEF-5 修复后重跑 E2E-1 路径 b → 连接 → 断言 pair.ok/pairing.json/进 tab 页，才算 DEF-3 运行时闭环 PASS；jest 侧 37 测试已绿（提交信息口径）                                                                                                                                                                                       |

### DEF-5（本派发新发现 · **阻断 E2E-1 起全部场景**）R3 通知层接线 × Expo Go 不兼容 → app 启动即崩

| 项   | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置 | `apps/crish-mobile/src/adapters/wiring/observationWiring.ts:18` `import { PushWiring } from '@/notifications/pushConsumer'` → `pushConsumer.ts:19` `import { scheduleNotificationAsync } from 'expo-notifications'`；**全部未提交**（git status：`src/notifications/pushConsumer.ts` 等 = A（staged）、`observationWiring.ts`/`wiring/index.ts` = M——并行阵营工作区在途改动）                                                                                                                                                                                                                                                                                                                                                                      |
| 复现 | Expo Go 加载新 bundle（Metro run4 1635 modules）→ expo-notifications 模块初始化抛错 `[Error: expo-notifications: Android Push notifications (remote notifications) functionality provided by expo-notifications was removed from Expo Go with the release of SDK 53...]`（logcat 8:53:43 E ReactNativeJS ×10+）→ expo-router 路由验证 12 个路由报 `missing the required default export`（**pair/welcome 未报**——不引用 wiring 链，反证根因）→ SceneView 渲染 undefined 组件 → `TypeError: Cannot read property 'ErrorBoundary' of undefined`（componentStack 含 SceneView/NavigationProvider/Screen，8:53:45）→ **app 无法渲染**，Expo Go 回 dev launcher（ui-r14-11.xml 仅 "crish-mobile"）；run 1（8:53）+ run 2（8:59 force-stop 重载）两次一致 |
| 影响 | **阻断 E2E-1~6 全部场景**（app 在欢迎页渲染之前崩）；且第 13 次派发 bundle（1641 modules，12:19-13:40）**无此错误**——证明是**本轮并行阵营新引入**（通知层接线进入路由可达链的时间窗口 = 第 13 次派发之后）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 根因 | ① Expo Go（SDK 53+）**移除 expo-notifications 远程推送**：`warnOfExpoGoPushUsage()` 在 Android + `isRunningInExpoGo()` 时 **throw**（expo-notifications/src/warnOfExpoGoPushUsage.ts:6-14），且 `requireNativeModule('ExpoPushTokenManager')` 无原生模块（PushTokenManager.native.ts:5）；② 通知层经 observationWiring 被**全部路由可达**（approvals→useApprovalListVm→ensureApprovalWiring→observationWiring；manual→pairingBootstrap→pairingWiring→observationWiring；notifications.tsx→NotificationCenterScreen→通知层）→ 任一路由加载即触发 → 路由树构建级失败（expo-router dev 模式 validateRouteTreeExports 全量验证）                                                                                                                       |
| 建议 | ① **通知层对 Expo Go 降级**：`pushConsumer.ts` 顶层 import 改惰性（动态 `require`/`import()` 在函数内、try-catch 容错），或 wiring 层对 PushWiring 做可选装配（Expo Go 跳过）；② **联调载体升级 dev build**（`expo run:android`，Expo Go 不支持 push——Expo 官方说明）；③ 若本轮继续 Expo Go：需并行阵营**先回退/收口通知层接线**（stash 或完成兼容修复）再重跑；④ 补「Expo Go 冒烟门禁」（jest 全绿 ≠ 运行时可用，与 L-7 同向）；⑤ **提交纪律**：未提交工作区改动（A/M 状态）影响联调环境，建议并行阵营收口时一并提交（含 notification 层）                                                                                                                                                                                                        |

### DEF-4（更新注记）hitTargets 提交缺口——本派发确认已入库？

| 项   | 内容                                                                                                                                                                                                                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注记 | 第 13 次派发时 hitTargets.ts/.test.ts 为 staged 未提交（L-1）；本派发 `git status` 未再出现 `hitTargets*` 未跟踪项——**疑似已由并行阵营收口提交**（git log 头部提交链 2ec38735 含 "hitTargets rebuilt"）；本派发未重新核验 git show（以 git status 无遗留为准） |

---

## 12. 第 14 次派发关键证据

### 12.1 DEF-3 修复 bundle 级验证（bundle-check-r14.js）

```
grep "ladder" → 命中 noblePrimitives 编译产物：
- 注释「**ladder 版 x25519**：scalarMultBase 与 RFC 7748 x-only ladder，
  固定 255 轮 cswap+双倍+加法，全确定性、零随机源」
- `var X25519_P = 2n ** 255n - 19n;`（RFC 7748 §5 p = 2^255-19）
- `var modP = n => (0, _nobleCurvesAbstractModularJs.mod)(n, X25519_P);`
→ DEF-3 修复（d7eb5d52）确已在 bundle；Metro run4 重启拿到的正是新代码
```

### 12.2 DEF-5 错误链（adb logcat -d，logcat-r14-all.txt 摘录）

```
08-14 08:53:42.169 E ReactNativeJS: Running "main" ... "runtimeVersion":"exposdk:57.0.0" ...
08-14 08:53:43.155 E ReactNativeJS: [Error: expo-notifications: Android Push notifications (remote
    notifications) functionality provided by expo-notifications was removed from Expo Go with the
    release of SDK 53. Use a development build instead of Expo Go. ...]
08-14 08:53:43.208 W ReactNativeJS: Route "./notifications.tsx" is missing the required default
    export. Ensure a React component is exported as default.
08-14 08:53:43.227 W ReactNativeJS: Route "./(tabs)/approvals.tsx" is missing ...（×12 路由同型）
08-14 08:53:43.341 W ReactNativeJS: Route "./pair/manual.tsx" is missing ...
08-14 08:53:45.110 E ReactNativeJS: { [TypeError: Cannot read property 'ErrorBoundary' of undefined]
    componentStack: '\n    at SceneView ... at NavigationProvider ... at Screen ...'
    isComponentError: true }
```

### 12.3 环境状态（派发结束时）

| 项       | 值                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模拟器   | emulator-5554（qemu PID 17084，本派发重启）；boot_completed=1；reverse 8765+8081；spell_checker=0                                                                     |
| Metro    | PID 47656（run4，17:0x 启动，:8081）；日志 `r2-16-accept\metro-run4.log`；Bundled 1635 modules                                                                        |
| harness  | PID 33188（run4）；配对码 **CXN-DAYJ-Y45Y-HTXL**（state.json，TTL 10 分钟）；TLS=true；8765 监听；`/v1/info` 200 正常                                                 |
| Expo Go  | 深链 exp://10.0.2.2:8081；加载新 bundle 后 DEF-5 崩 → dev launcher                                                                                                    |
| 证据文件 | `Temp\opencode\r2-16\`：e2e1-r14-blocked.png（阻塞态截图）、bundle-check-r14.js（8.2MB bundle 产物）、logcat-r14-all.txt、metro-run4.log、ui-r14-*.xml、info-r14.json |

---

## 13. 第 14 次派发时间线

| 时间（08-14） | 事件                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~17:00        | 派发开始：确认模拟器在跑 / Metro 19676（旧 bundle）/ harness 9248（旧码）均需重启                                                                                       |
| 17:0x         | harness run4 重启 → 新码 CXN-DAYJ-Y45Y-HTXL（PID 33188）；Metro run4 重启（PID 47656）                                                                                  |
| 17:0x         | adb reverse 8765+8081；spell_checker=0；Expo Go 深链加载 → Bundled 1635 modules 成功                                                                                    |
| ~17:0x        | **模拟器进程消失**（qemu 无）→ 重启模拟器（PID 17084）+ boot + reverse 重配                                                                                             |
| ~17:0x        | Expo Go 重开深链 → 8:53 logcat 错误链（expo-notifications ×10+ → 12 路由 missing default → ErrorBoundary TypeError）→ dev launcher；run 2（8:59 force-stop 重载）同复现 |
| ~17:4x        | 根因排查：grep 工作区 → observationWiring.ts:18 → pushConsumer → expo-notifications；git status 证实全部未提交（A/M）→ DEF-5 定性                                       |
| ~18:0x        | bundle 级验证 DEF-3 ladder 修复；截图/日志归档；文档追加（§9~§14）                                                                                                      |

---

## 14. 遗留清单更新（第 14 次派发）

| #       | 项                                                                                         | 状态/建议                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| L-1     | ~~提交 hitTargets.ts + hitTargets.test.ts~~（DEF-4）                                       | **本派发 git status 无遗留**——疑似并行阵营收口已提交（2ec38735），以 git log 复核为准                          |
| L-2     | ~~DEF-3 修复~~（d7eb5d52 ladder x25519）                                                   | **已修复**：bundle 级验证 PASS；运行时复测待 DEF-5 解除                                                        |
| L-3     | DEF-1/2 输入污染修复                                                                       | 不变（未达输入阶段）                                                                                           |
| L-4     | 路径 a 剪贴板真机验证                                                                      | 不变                                                                                                           |
| L-5     | 配对码 TTL 残余：**CXN-DAYJ-Y45Y-HTXL（run4）未消费即失效**                                | 复测前重启 harness 拿新码（restart-harness-run4.ps1 先例）                                                     |
| L-6     | E2E-2~6 级联未执行                                                                         | 依赖 E2E-1（DEF-5 解除后）                                                                                     |
| L-7     | 「运行时 vs 测试环境」差异未纳入测试纪律                                                   | 本派发新增实锤：**Expo Go 冒烟门禁必须上**（expo-notifications 这种「jest 全绿、Expo Go 启动即崩」的漏洞类型） |
| **L-8** | **DEF-5 修复**（新）：通知层 Expo Go 降级（惰性 import/try-catch 容错）或改 dev build 联调 | E2E-1 重跑硬前置；需并行阵营配合（通知层接线为未提交工作区改动）；修复方向见 §11 DEF-5 建议                    |
| L-9     | 并行阵营未提交工作区改动（notification 层 + wiring 层 A/M 状态）影响联调环境可复现性       | 建议收口提交（commit --only 限定移动端文件域）；提交前确认 expo-notifications 兼容策略                         |

---

_文档结束（第二部分）。本记录由 R2-16 验收执行子代理产出（唯一入库文件 docs/multi-device/R2-16-acceptance-execution.md；
未修改任何源文件/测试文件；未运行任何 cargo 命令；本次追加未删改第一部分内容）。_
