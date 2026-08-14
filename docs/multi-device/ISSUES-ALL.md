# 多端互通问题总清单（阻断级/重要级/一般级）

> 文档编号：ISSUES-ALL
> 定位：多端互通（R1 桌面服务端 / R2 移动端 / R3 推送）全部已知问题点的**系统性登记**——供系统性修复轮引用。
> 日期：2026-08-14
> 编码：UTF-8 无 BOM，中文。
> 优先级：P0=阻断（必须修，阻塞验收/功能可用）；P1=重要（影响质量/体验，应修）；P2=一般（可排期）。

---

## 1. P0 阻断级问题

### P0-1 DEF-5：expo-notifications 在 Expo Go 环境导致 app 启动即崩

- **状态**：待修（并行阵营 + 我们域交织）
- **背景**：E2E 第 14 次复测发现（R2-16-acceptance-execution.md §9-14）：R3 通知层接线（`observationWiring.ts:18` → pushConsumer → expo-notifications，**全部未提交 A/M 状态**）→ Expo Go（SDK 53+ 移除 push 模块支持）模块加载抛错 → 12 个路由全部 `missing default export` → `SceneView ErrorBoundary TypeError` → **app 启动即崩**（欢迎页都出不来，两次复现一致）
- **根因**：expo-notifications 在 Expo Go（非 dev build）环境的模块不兼容——`import 'expo-notifications'` 在 Expo Go 加载失败（SDK 53+ Expo Go 不含 push 原生模块）
- **影响**：E2E-1~6 全部 BLOCKED（级联）+ 移动端 app 模拟器不可用（含走查后续屏）
- **修复方向**：
  1. **惰性 import 降级**（推荐）：expo-notifications 的引用改为运行时动态 import + 能力探测（`expo-notifications` 不可用 → 通知层降级为应用内通知 only，不崩溃）——移动端域，文件域 src/notifications/ + observationWiring
  2. 并行阵营收口（其未提交改动先入库——A/M 状态堆积是根因之一）
  3. 长期：dev build（expo-dev-client）替代 Expo Go——联调流程变更
- **归属**：我们域（R3-04a/b/c 通知层）+ 并行阵营（未提交接线）
- **前置**：无（可立即修）

### P0-2 DEF-1/DEF-2：pairManualScreen 受控组件输入污染

- **状态**：待修（产品缺陷，E2E 第 13 次实证）
- **背景**：R2-16-acceptance-execution.md §3：`value={formatPairCodeDraft(codeRaw)}` 受控组件——每次输入基于当前显示值（含 CXN- 前缀）回传 onChangeText → codeRaw 被污染（'CXN-C7' → 清理 'CXNC7' → 分组错乱）——**真实用户逐字符输入同样受影响**（非仅 adb 注入）
- **根因**：受控组件 value=格式化显示值 + onChangeText 直接 setCodeRaw（显示值与原始码的映射断裂）
- **影响**：E2E-1 配对 UI 输入不可靠（8+4 分段 workaround 可用但真实用户受影响）；配对体验缺陷
- **修复方向**：pairManualScreen 输入处理重构——onChangeText 收到显示值 → 反向提取原始码（剥离 CXN- 前缀/分隔符）再 setCodeRaw；或非受控组件 + 格式化显示分离；或光标管理（格式化时保持光标位置）。文件域 app/pair/manual.tsx + 测试
- **归属**：我们域（R2-03c 配对 UI）
- **前置**：无

### P0-3 R1 测试面阻塞：R1 全链测试无法运行（session-loop 契约扩展在途）

- **状态**：待并行阵营收口（我们域 R1 server 已清零 7/7——d7eb5d52）
- **背景**：R3-00-desktop-verification.md v2：lib/bin 被上游 `session-loop` 依赖失败拦死（8 错：`ClassifiedToolResult::error` 缺第 5 参 `duration_ms` E0061×4、`ToolEvent::ToolStart/ToolEnd` 新字段未跟随 E0027×2 + E0063×2——并行阵营契约窗口扩展在途）
- **影响**：R1 server 59 内联测试 + server_integration 11 测试无法跑（R1 验收的测试面证据缺失——代码面已交付）
- **修复方向**：并行阵营收口（其域）；收口后补跑 `cargo test -p crish-agent-workbench --bin` + `--test server_integration`（R3-00 文档 v2.4 补跑清单）
- **归属**：并行阵营（session-loop）→ 我们域收口验证
- **前置**：并行阵营收口

### P0-4 E2E 真机联调未闭环（R2 验收关键项）

- **状态**：阻塞中（依赖 P0-1/P0-2 修复）
- **背景**：E2E 已派发 14 次：输入路径 b（8+4 分段）已打通 → DEF-3 crypto 已修（ladder x25519）→ DEF-5 新阻断（app 启动崩）。E2E-1~6 全部 BLOCKED
- **影响**：R2-16 验收未达成（R2 完成度 ~90%——R2-16-acceptance-check.md）；R2 出口判定悬置
- **修复方向**：P0-1（DEF-5）+ P0-2（输入污染）修复后重跑 E2E-1~6（重启 Metro/harness 拿新 bundle/新码）
- **归属**：我们域（执行）
- **前置**：P0-1、P0-2

---

## 2. P1 重要级问题

### P1-1 themeProjection.test.ts:76 红测（useAppTheme ≡ useTheme 恒等断言）

- **状态**：待修（我们域 R2-05j 兼容层遗留）
- **背景**：多轮验证均见 `themeProjection.test.ts:76` 失败（唯一稳定红测）——`useAppTheme 与 useTheme 同源（函数恒等）`断言——R2-05j 的 themeProjection 兼容层（19 行 re-export）后 useAppTheme 转发 useTheme——恒等断言失败说明实现与断言语义不符（可能 useAppTheme 是函数引用而断言期望同一引用？或兼容层导出形态问题）
- **影响**：移动端 jest 恒 1 红（掩盖其他真实红测的注意力）；R2UX-06-05 完整性测试面
- **修复方向**：读 themeProjection.ts（R2-05j 兼容层）+ 断言——对齐（useAppTheme 导出为 useTheme 同一引用 或 断言改为行为等价）；文件域 src/adapters/settings/themeProjection.ts + themeProjection.test.ts
- **归属**：我们域（R2-05j）
- **前置**：无

### P1-2 并行阵营未提交改动堆积（编译面不稳定 + 事故源头）

- **状态**：持续（并行阵营流程问题）
- **背景**：多次外部 git 操作（restore/清除/stash 误弹）抹掉未提交文件（hitTargets/theme.contrast/SettingsAboutCard.test/files.test 等已重建/补建）；编译面频繁被并行阵营 in-progress 状态阻塞（orchestrator 恢复域/computer 模块/session-loop 契约）
- **影响**：① 工作区未提交改动反复丢失（含我们的产出——多轮重做成本）② 编译面不稳定（验证窗口化）③ DEF-5 的 A/M 堆积源头
- **修复方向**：主控与并行阵营协调：① 约定「未提交改动及时入库」（尤其共享文件）② 破坏性 git 操作（restore/checkout .）禁止 ③ stash 操作纪律（子 agent 不碰 stash——R3-04c 事故教训）
- **归属**：全仓协作纪律
- **前置**：无（持续执行）

### P1-3 R2UX 剩余条款（14/28 已落地、13/28 部分、1/28 未落地）

- **状态**：部分排期（R2UX v4——AU5 §13）
- **背景**：R2UX-04-08 批量模式（排期 R3-06）；R2UX-06-04 剩余面（S3-S12 + 三选强制档 + R-D1/2/5 固定行高×200% 张力区裁决）；真机验证类（TalkBack 走查/E2E-3 滑轨 50%/75%/帧率断言/万项真机）
- **影响**：R2UX 条款完整性（体验目标）；固定行高×200% 张力区需**主控裁决**（R-D1/2/5：终端 24dp/文件行 44-56/事件行 56 vs 200% 字体——冲突语义）
- **修复方向**：批量模式随 R3-06；三选强制档/剩余屏走查在 P0-1 修复后（配对可进设置）；固定行高张力区裁决归档（主控）
- **归属**：我们域
- **前置**：P0-1（三选/TalkBack 走查）

### P1-4 R1-11 验收文档滞后于执行（小项）

- **状态**：已基本闭环（v1.4 勾销 + 执行记录）——剩余：红线 2/3 服务面端到端（依赖真实引擎——harness mock 后端）标注「自动化覆盖，端到端留 R2」
- **影响**：低（验收口径已记录）
- **修复方向**：随 R2 引擎装配（桌面增强）后补端到端——排期
- **归属**：我们域

---

## 3. P2 一般级问题

### P2-1 走查 R-D 项（动态字体风险组件标注）

- 走查清单 §1.4 标注 16 处风险组件（R-D1~16）——S1/S2 已实证（R-D4 未实证化——输入框 126px 固定高在 2.0× 正常）；S3-S12 待配对轮
- 修复方向：配对后逐屏走查 + 风险组件实测

### P2-2 R3-04c stash 误操作事故（已恢复无损失）

- agent 误 `git stash pop` 弹了并行 stash → 4 文件冲突 → 已恢复（stash 条目完整）——流程教训：子 agent 禁止操作 stash（P1-2 纪律并入）

### P2-3 对比度「边界」项（已修——30% 余量安全）

- R2-05l 重做时 colorWarning 用 30%（31% 压线 4.5047:1 余量 0.005）——已达标（4.75）——closed

### P2-4 DEF-4 hitTargets 丢失（已修）

- hitTargets.ts 重建 + 11 测试 + 10 套件恢复——closed（提交 2ec38735）

### P2-5 R3-02b 注册表双实例裁决项

- ServerState 路由层注册表 vs 装配面注册表双实例（既有口径）——push presence/直投观察不到真实连接——「连接面共享接线（server/mod.rs 增 with_ws_registry 注入）待主控裁决」——**裁决：接受共享接线，排 R3 后续小任务**（连接面统一）
- 状态：裁决已定，排期

### P2-6 R3-01/02 持久化接线（push_pending_approvals SQLite + copy.rs 文案渲染）

- R3-01b/02b 注记：SQLite pending 持久化（R3-03 消费——DedupeBackend 已就绪）、copy.rs 文案渲染（title/body 置 None——with_copy 入口已备）——排期 R3 接线轮

### P2-7 移动端 expo-sqlite/expo-secure-store 真实驱动安装（lock 共享）

- R-3 已实现驱动 + 注入（pairingBootstrap 默认真实驱动）——但 **npm install 未执行**（lock 与并行共享——避免冲突）——node_modules 缺 expo-secure-store/expo-sqlite 真实包——模拟器运行期才需要（jest 用 mock）——E2E 前需安装（P0-1 修复时一并）

---

## 4. 修复轮建议顺序

| 轮次     | 内容                                                                                                                                                             | 依赖         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 修复轮 1 | P0-1 DEF-5（惰性 import 降级 + 通知层 Expo Go 兼容）→ P0-2 输入污染 → P1-1 themeProjection:76 → P2-7 依赖安装（npm install expo-sqlite/secure-store——lock 协调） | 无           |
| 修复轮 2 | P0-4 E2E 重跑（DEF-5/输入污染修复后）→ 三选强制档/剩余屏走查 → R2-16 验收闭环                                                                                    | 修复轮 1     |
| 修复轮 3 | P1-3 剩余（批量模式 R3-06 排期）→ P2-5/P2-6 接线（随 R3）→ R1 测试面补跑（并行收口后）                                                                           | 并行阵营收口 |
| 持续     | P1-2 协作纪律（入库及时/禁破坏性操作/禁 stash）                                                                                                                  | —            |

---

## 5. 变更记录

| 版本 | 日期       | 变更                                                 |
| ---- | ---------- | ---------------------------------------------------- |
| v1.0 | 2026-08-14 | 初稿：全量问题登记（P0×4 / P1×4 / P2×7）+ 修复轮建议 |
