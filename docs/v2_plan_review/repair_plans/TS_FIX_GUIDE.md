# Conex TS 编译修复：风险目录与 Agent 指令模版

> 本文档汇编了项目 TypeScript 修复中遇到的全部风险类别和修复原则。
> 用作 Agent 分配时的提示词参考源，确保每个修复 Agent 行为一致。

---

## 目录

- [第一部分：Agent 指令模版（硬性约束）](#第一部分agent-指令模版硬性约束)
- [第二部分：39 项风险类别与治理防线](#第二部分39-项风险类别与治理防线)
  - [类型系统类 (1-3)](#类型系统类-1-3)
  - [生命周期与资源类 (4-5)](#生命周期与资源类-4-5)
  - [数据与状态类 (6-8)](#数据与状态类-6-8)
  - [后端契约类 (9-10)](#后端契约类-9-10)
  - [DOM 与渲染类 (11)](#dom-与渲染类-11)
  - [Hook 与模块类 (12-13)](#hook-与模块类-12-13)
  - [异步与事务类 (14-15)](#异步与事务类-14-15)
  - [Worker 生命周期类 (16)](#worker-生命周期类-16)
  - [Immutability 与 Selector 类 (17-18)](#immutability-与-selector-类-17-18)
  - [Store 架构类 (19-20)](#store-架构类-19-20)
  - [安全与渲染类 (21-22)](#安全与渲染类-21-22)
  - [契约与持久化类 (23-25)](#契约与持久化类-23-25)
  - [环境与构建类 (26-27)](#环境与构建类-26-27)
  - [测试与 i18n 类 (28-29)](#测试与-i18n-类-28-29)
  - [性能类 (30-31)](#性能类-30-31)
  - [控制流类 (32-33)](#控制流类-32-33)
  - [Store 架构违规类 (34-39)](#store-架构违规类-34-39)
- [第三部分：按包分配参考](#第三部分按包分配参考)
- [第四部分：验收命令全集](#第四部分验收命令全集)

---

## 第一部分：Agent 指令模版（硬性约束）

### §0 硬性红线

| # | 红线 | 后果 |
|---|------|------|
| R1 | **禁止 `as any`** — 任何文件中出现 `as any`、`as unknown as any`、`as never` | 本轮全部作废 |
| R2 | **禁止空桩方法** — 方法体只有 `return` / `void` / `{}` / `// TODO` 而无实际逻辑 | 本轮全部作废 |
| R3 | **禁止随意互换 `?:` 与 `: Type \| undefined`** — 必须理解 exactOptionalPropertyTypes 语义 | 本轮全部作废 |
| R4 | **禁止在 `?.` 可安全使用的场景用 `!`** — `!` 仅在 guard clause 或算法保证后可用 | 本轮全部作废 |
| R5 | **禁止不加校验地断言后端 JSON 为枚举** — 必须使用白名单守卫函数 | 本轮全部作废 |

### §1 修复前准备

每个 Agent 在执行修复前必须完成：

```powershell
# 1. 记录当前错误基线
npx tsc --noEmit -p <target>/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line

# 2. 保存完整错误清单
npx tsc --noEmit -p <target>/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" > current_errors.txt

# 3. 对每个要修的文件，Read 完整内容并理解错误根因
```

### §2 修复优先级

```
1️⃣ 接口契约同步（TS2345/TS2322/TS2339/TS2305）
    ↓
2️⃣ 类型防腐 + 空值防护（TS2532/TS2375/TS2379/TS2412）
    ↓
3️⃣ 模块导出与 Barrel 修复（TS2305/TS2459）
    ↓
4️⃣ 工程自动化清洗（TS6133/TS6196/TS7006/TS2588）
```

### §3 验收规范

每修完一个文件：
```powershell
npx tsc --noEmit -p <target>/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Select-String "<文件名>" | Measure-Object -Line
# 预期: 0
```

每修完 3-5 个文件：
```powershell
npx tsc --noEmit -p <target>/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 必须下降，不能上升
```

### §4 输出格式

每个 Agent 必须按此格式报告：

```
## 修复清单
| 文件 | 错误码 | 修复模式 | Δerr |
|------|--------|----------|:----:|

## 当前状态
- 包: xxx | 当前错误: NN | 本次减少: NN

## 违规自查
- as any: ❌ 无
- 空桩: ❌ 无
- exactOptional 误用: ❌ 无
- 滥用 !: ❌ 无

## 剩余问题简析
（简述剩余错误的分布和根因）
```

---

## 第二部分：39 项风险类别与治理防线

### 类型系统类 (1-3)

#### 🔴 R01: 类型逃逸与弱类型断言 (`as any`)

| 维度 | 说明 |
|------|------|
| **典型表现** | `as any`、`as unknown as T`、对未知 JSON 不做结构校验直接 `as Record` |
| **危害** | 破坏 TS 编译期安全，将错误隐藏至运行时崩溃，eslint `no-as-any` 基线将失败 |
| **治理防线** | 100% 消除 `as any`；用 `typeof` / `Array.isArray()` / 属性收窄等 Guard 卫语句校验 |
| **修复模式** | `as any` → 类型守卫 + 条件断言；`as Record` → `zod.parse()` 或逐字段收窄 |

#### 🔴 R02: `exactOptionalPropertyTypes` 语义漂移

| 维度 | 说明 |
|------|------|
| **核心语义** | `field?: T` ≠ `field: T \| undefined`。前者不接受显式 `= undefined`，后者不接受字段缺失 |
| **典型表现** | 接口定义 `?:` 时字面量直接 `{ field: maybeUndefined }` → TS2375/TS2379/TS2412 |
| **治理防线** | 本地类型：`field?: T \| undefined`；共享类型：条件展开 `...(val !== undefined && { field: val })` |
| **修复模式** | 见 §2.2 |

#### 🔴 R03: 数组索引未检查越界 (`noUncheckedIndexedAccess`)

| 维度 | 说明 |
|------|------|
| **典型表现** | `arr[idx]`、`cards[0]` 直接解构或调用成员方法 |
| **危害** | 数组为空或索引越界时返回 `undefined` 透传 → `TypeError: Cannot read properties of undefined` |
| **治理防线** | 所有索引提取补 `!` 断言 `arr[idx]!` 或 Guard `if (!item) return;` |
| **修复模式** | 算法保证非空 → `!`；不确定 → `?.prop ?? default` |

---

### 生命周期与资源类 (4-5)

#### 🟡 R04: 全局事件与资源缺少生命周期卸载闭环

| 维度 | 说明 |
|------|------|
| **典型表现** | `addEventListener` / `setInterval` 缺少 `removeEventListener` / `clearInterval` |
| **危害** | 内存泄漏，HMR 或窗口切换时重复触发监听器 |
| **治理防线** | 每处 `addEventListener` / `setInterval` 匹配对应的 destroy 闭环 |

#### 🟡 R05: 定时器 ID 类型混用 (`Timeout Type Conflict`)

| 维度 | 说明 |
|------|------|
| **典型表现** | Web 环境 `number` vs Node/Vitest 环境 `Timeout` 对象冲突 |
| **治理防线** | 统一 `ReturnType<typeof setTimeout>` 声明，清除时显式转换 |

---

### 数据与状态类 (6-8)

#### 🟡 R06: 数据水合与类型漂移

| 维度 | 说明 |
|------|------|
| **典型表现** | 时间戳混用 `number \| string`（`"刚刚"` / ISO 字符串）；后端字段未做运行时校验 |
| **治理防线** | 建立 `toTimestampMs(val)` 统一转换；hydration 入口用 zod schema 校验 |

#### 🔴 R07: 死代码与重构残留

| 维度 | 说明 |
|------|------|
| **典型表现** | `TS6133` 未读取变量、`TS6196` 未读取 import、空桩方法 |
| **危害** | 增加打包体积，干扰 Tree-shaking |
| **治理防线** | 清理全部未使用引入与变量，严禁保留空桩 |

#### 🔴 R08: 闭包捕获过时状态

| 维度 | 说明 |
|------|------|
| **典型表现** | `useCallback` / `useEffect` 中事件监听闭包捕获初始渲染时的局部变量 |
| **危害** | 连续快速点击时闭包使用过时状态，状态覆盖到错误会话 |
| **治理防线** | 高频/动态状态通过 `useRef.current` 保持最新引用 |

---

### 后端契约类 (9-10)

#### 🟡 R09: 后端 JSON 枚举硬断言

| 维度 | 说明 |
|------|------|
| **典型表现** | `status = o.status as 'running' \| 'completed'` 不做运行时期校验 |
| **危害** | 后端扩展新枚举后前端静默降级失败 |
| **治理防线** | 白名单守卫 `isValidStatus(val)` + 枚举收窄 |

#### 🟡 R10: NodeJS / Browser 环境 API 混用

见 R05。

---

### DOM 与渲染类 (11)

#### 🟡 R11: DOM 属性直接修改与 React 状态脱节

| 维度 | 说明 |
|------|------|
| **典型表现** | `document.body.setAttribute('data-theme', ...)` 后未触发 React 重新渲染 |
| **治理防线** | DOM 直接修改必须伴随 `CustomEvent` 通知或 React 订阅响应 |

---

### Hook 与模块类 (12-13)

#### 🟡 R12: Hook 控制流不规范 (隐式 undefined return)

| 维度 | 说明 |
|------|------|
| **典型表现** | `useEffect` 中 `if (cond) { ...; return () => cleanup; }` 无 `else return` |
| **危害** | `TS7030`，解绑函数在某些分支未注册 |
| **治理防线** | Hook 首行 Guard：`if (!cond) return;` |

#### 🟡 R13: 动态模块导入强转

| 维度 | 说明 |
|------|------|
| **典型表现** | `import(...).then(mod => (mod as any)[fn]())` |
| **危害** | Tree-shaking 重命名后运行时崩溃 |
| **治理防线** | 显式类型分支或匹配表，禁止 `as any` 动态索引 |

---

### 异步与事务类 (14-15)

#### 🔴 R14: 异步竞态与取消语义缺失

| 维度 | 说明 |
|------|------|
| **典型表现** | 流式聊天中旧流未取消；fetch/IPC 无 `AbortController`；异步写 store 无 requestId 比对 |
| **危害** | Last-write-wins 数据丢失；消息错位写入切后会话；UI 卡死 |
| **治理防线** | 所有异步写 store 携带 runId/requestId 比对；长流程强制 `AbortController`；切会话时主动 abort 旧流 |

#### 🔴 R15: 事务性与原子性缺失

| 维度 | 说明 |
|------|------|
| **典型表现** | 跨多个 store slice 的写操作分多次 `set`；session 数组与 `sessionsById` 在不同 set 中更新 |
| **危害** | 订阅者拿到中间态；索引与数组脱节；崩溃后持久化半成品 |
| **治理防线** | 跨字段变更合并到单次 immer recipe；提供 `StoreTransaction` 包装器 |

---

### Worker 生命周期类 (16)

#### 🟡 R16: Worker 生命周期与消息端口泄漏

| 维度 | 说明 |
|------|------|
| **典型表现** | worker 创建后无终止路径；`MessageChannel` port 未 close；worker error 未监听 |
| **治理防线** | 每个 worker 需有 `terminate()` 与引用计数；`MessageChannel` 用完即 `port.close()` |

---

### Immutability 与 Selector 类 (17-18)

#### 🔴 R17: Immutability 违反与 draft 误用

| 维度 | 说明 |
|------|------|
| **典型表现** | 非 immer 上下文中 `state.x.y = z`；`ReadonlyArray.push`；selector 返回引用相同对象 |
| **治理防线** | 所有 `set` 必须经过 immer recipe；selector 返回值若对象必须深拷贝或拆解为原始值 |

#### 🟡 R18: Selector 粒度失控与重绘级联

| 维度 | 说明 |
|------|------|
| **典型表现** | `useStore(s => s)` 整体订阅；selector 返回新对象字面量每次都不等 |
| **治理防线** | 返回对象时用 `useShallow` 或拆分为多个 selector |

---

### Store 架构类 (19-20)

#### 🟡 R19: 跨域 Store 引用循环与初始化顺序耦合

| 维度 | 说明 |
|------|------|
| **典型表现** | `storeAccess` 持有三个 store hook；`bootstrapStores` 注入晚于首次渲染 |
| **治理防线** | store 在 React 首次渲染前完成注入；删除降级路径或注入后广播 invalidate |

#### 🔴 R20: 状态枚举语义重载

| 维度 | 说明 |
|------|------|
| **典型表现** | `status: 'success' | 'error'` 中 `'error'` 既表示"执行失败"也表示"用户拒绝审批" |
| **治理防线** | 枚举值必须语义单一，禁止复用；审批拒绝应独立 `'rejected'` 状态 |

---

### 安全与渲染类 (21-22)

#### 🔴 R21: XSS 与不安全 HTML 注入

| 维度 | 说明 |
|------|------|
| **典型表现** | Markdown 渲染 `dangerouslySetInnerHTML`；用户输入未 sanitize |
| **治理防线** | 所有 HTML 注入经 `DOMPurify`；Markdown 走白名单标签 |

#### 🟡 R22: 错误吞噬与 ErrorBoundary 盲区

| 维度 | 说明 |
|------|------|
| **典型表现** | `catch {}` 空体；`catch (e) { console.warn(e) }` 后返回 `undefined` |
| **治理防线** | 禁止空 catch；catch 块必须上报 ErrorStore 或 ToastBus |

---

### 契约与持久化类 (23-25)

#### 🟡 R23: 前后端 / 引擎契约漂移

| 维度 | 说明 |
|------|------|
| **典型表现** | 前端类型与引擎 JSON 字段无运行时校验；新增字段无迁移 |
| **治理防线** | `SessionStateSchema`（zod）在 hydration 入口校验；版本化迁移函数 |

#### 🟡 R24: 持久化版本迁移缺失

| 维度 | 说明 |
|------|------|
| **典型表现** | `withPersist` 设 `version: 1` 但无 `migrate` 函数 |
| **治理防线** | 每次 version 自增配套 migrate；migrate 有回退路径 |

#### 🟡 R25: 大整数 ID 精度丢失

| 维度 | 说明 |
|------|------|
| **典型表现** | 引擎返回大数字 runId 用 `number` 接收 |
| **治理防线** | 外部 ID 强制 `string`；统计累加用 `BigInt` |

---

### 环境与构建类 (26-27)

#### 🟡 R26: 环境耦合与上下文越界

| 维度 | 说明 |
|------|------|
| **典型表现** | 浏览器 bundle 中 `process.env.XXX` 未做 define 替换；Electron API 无 guard |
| **治理防线** | Node 模块走 preload；`process.env` 通过构建时 define 替换 |

#### 🟡 R27: Store Action 内嵌异步副作用

| 维度 | 说明 |
|------|------|
| **典型表现** | action 内 `void import(...).then(...)` 异步写 store 无 requestId 比对 |
| **治理防线** | store action 必须是同步纯函数；异步由调用方发起 |

---

### 测试与 i18n 类 (28-29)

#### 🟡 R28: 测试隔离与 Flakiness

| 维度 | 说明 |
|------|------|
| **典型表现** | 测试共享 zustand store 未重置；fake timers 未 clear |
| **治理防线** | 每个 `beforeEach` 重置 store；fake timers 用 `afterEach clearAll` |

#### 🟡 R29: i18n 与本地化漂移

| 维度 | 说明 |
|------|------|
| **典型表现** | 硬编码中文与 i18n key 混用；相对时间字面量散落 |
| **治理防线** | 用户可见文案走 i18n key；时间格式经 `Intl.RelativeTimeFormat` |

---

### 性能类 (30-31)

#### 🟡 R30: 大对象深拷贝与序列化开销

| 维度 | 说明 |
|------|------|
| **典型表现** | selector 中 `JSON.parse(JSON.stringify(state))`；worker 传整个 sessions 数组 |
| **治理防线** | 禁止 selector 中深拷贝；worker 通信只传必要字段 |

#### 🟡 R31: 热路径数据结构选择不当

| 维度 | 说明 |
|------|------|
| **典型表现** | `sessions.unshift()` O(n)；`filter().map()` 计算 existingTitles O(n) |
| **治理防线** | 热路径禁止 O(n)；标题去重 Set 缓存到 state |

---

### 控制流类 (32-33)

#### 🟡 R32: 判别联合未穷尽检查

| 维度 | 说明 |
|------|------|
| **典型表现** | `switch(event.type)` 无 `default`；新增枚举值后静默跳过 |
| **治理防线** | switch 必须有 `default: never` 穷尽检查 |

#### 🟡 R33: 副作用时序与 Effect 依赖错配

| 维度 | 说明 |
|------|------|
| **典型表现** | useEffect 依赖数组缺项；effect 内 setState 循环 |
| **治理防线** | ESLint `exhaustive-deps` 严格模式 |

---

### Store 架构违规类 (34-39)

#### 🔴 R34: Store / View 职责越界

| 维度 | 说明 |
|------|------|
| **典型表现** | store action 内写业务文案、调用 toast/notification、import UI 组件 |
| **治理防线** | store 只更新状态字段，文案由 view 渲染；store 禁止 import components/ 或 i18n |

#### 🔴 R35: 业务逻辑重复实现

| 维度 | 说明 |
|------|------|
| **典型表现** | 截断逻辑在主会话与子 agent 各实现一份且不一致；`as unknown as Record` 三处复制 |
| **治理防线** | 跨切片同类操作抽到 `_shared.ts` 纯函数；CI 加重复代码检测 |

#### 🔴 R36: 派生标记与主数据一致性漂移

| 维度 | 说明 |
|------|------|
| **典型表现** | `truncatedToolChainIds` 永久保留已删 id；`pinnedMessageIds` 引用已撤回消息 |
| **治理防线** | 派生标记与主数据原子变更；dev 模式每次 set 后一致性校验 |

#### 🔴 R37: Store Action 内嵌异步副作用（见 R27）

#### 🟡 R38: 魔数与常量治理缺失

| 维度 | 说明 |
|------|------|
| **典型表现** | `40` 直接写代码中；`pinnedMessageIds.length < MAX_MESSAGES_PER_SESSION` 语义不符 |
| **治理防线** | 数值阈值集中到 `constants.ts`；常量语义化命名；CI 扫描裸数字 |

#### 🟡 R39: 函数命名与实际行为不符

| 维度 | 说明 |
|------|------|
| **典型表现** | `applyTitleIfDefault` 命名像纯函数实际 mutate；`normalizeWritableSessionTitle` 返回 `string \| null` |
| **治理防线** | mutate 函数加 `InPlace` 后缀或 `@mutates` JSDoc；纯函数用 `compute`/`derive` 前缀 |

---

## 第三部分：按包分配参考

| 包 | tsconfig | 检查命令 | 当前错误 | 主要风险 |
|----|----------|----------|:--------:|----------|
| shared-types | `-p packages/shared-types/tsconfig.json` | `check:store-types` | 0 | R02 |
| shared-utils | `-p packages/shared-utils/tsconfig.json` | — | 0 | R02, R03, R07 |
| agent-runtime | `-p packages/agent-runtime/tsconfig.json` | `check:runtime` | 0 | R02, R09 |
| agent-daemon | `-p packages/agent-daemon/tsconfig.json` | `check:daemon` | 0 | R02, R09 |
| agent-orchestrator | `-p packages/agent-orchestrator/tsconfig.json` | `check:orchestrator` | 0 | R02 |
| agent-workbench | `-p apps/agent-workbench/tsconfig.json` | `check:workbench` | 0 | R02, R07 |
| crish-desktop | `-p apps/crish-desktop/tsconfig.app.json` | `check:desktop` | ~130 | 全类别 |

---

## 第四部分：验收命令全集

### 编译检查
```powershell
# 全量 turbo
npm run typecheck

# 分包
npm run check:runtime
npm run check:daemon
npm run check:orchestrator
npm run check:workbench
npm run check:desktop
npm run check:store-types

# Rust
cargo check --workspace
cargo test --workspace --lib
```

### 零错误断言
```powershell
# 断言：每个包的 tsc 输出为 0
npx tsc --noEmit -p packages/agent-runtime/tsconfig.json 2>&1 | Out-String -Stream | Select-String "error TS" | Measure-Object -Line
# 预期: 0

# 断言：cargo check 无 error
cargo check --workspace 2>&1; $LASTEXITCODE -eq 0
```

### 测试
```powershell
npx vitest run --reporter=basic apps/crish-desktop/src/api/StreamRenderBuffer.test.ts
npx vitest run --reporter=basic packages/agent-runtime/src/provider-stream-contract/
cargo test -p conex-sandbox
cargo test -p conex-stream
cargo test -p conex-db
```
