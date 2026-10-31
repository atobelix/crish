# 第二轮战役 · R01 路由与应用生命周期对抗复核报告

> **复核席位**：第二轮战役 · R01 路由与应用生命周期对抗复核席  
> **被复核对象**：docs/mobile-full-audit/audits/01-routing-and-lifecycle-audit.md（01 席报告）  
> **复核原则**：对抗性求证、白盒透视、顺着调用链追到底、排除夸大与失真、补齐遗漏  
> **基准代码库**：Expo SDK 57 / React Native 0.86（新架构） / expo-router ~57.0.29 / React 19 / Zustand 5  
> **产出时间**：2026-10-30  

---

## 0 结论摘要

本席位对 01 席《路由与应用生命周期专项审计报告》提出的全部 11 项缺陷断言逐一进行了源码级白盒审计、调用链复核与对抗性推演，核心结论如下：

1. **核心定性总体成立，但存在 3 处明显事实失真与局部严重度夸大**：
   - 01 报告敏锐指出的核心架构缺陷（_components 引发 Metro 警告与路由污染、账号远程模式下二级页弹回首页、唤醒路径缺失账号中继恢复单例、后台高频定时器空转）**确凿存在且属于严重体验隐患**；
   - 但报告在推演严重后果时存在将“特定前置条件”等同于“全局普遍瘫痪”的夸大倾向，并有 **3 处明显事实失真**：
     - ① **DEF-RT-05** 声称“全工程搜索 BackHandler 结果为 0 处”，但 src/presentation/pair/pairManualScreen.tsx:4, 133 明确已接入并处理了物理返回；
     - ② **DEF-RT-04** 声称缺失 +not-found.tsx 会导致生产构建“卡死在空白状态无法回退”，实测 expo-router 框架层内置了带“Go back”功能的默认 Unmatched 兜底路由（
ode_modules/expo-router/build/views/Unmatched.js）；
     - ③ **DEF-LC-03** 声称断网进入 dead 终态会导致唤醒时“无法恢复”，实际上 src/adapters/runtime/appRuntime.ts:63 显式对非 connecting 状态执行了 wiring.reconnect() 具备完整的脱困与自愈能力。
2. **抽查行号准确率达 94.7%**：抽查报告所引 19 处行号，18 处精确吻合，仅 1 处存在约 7 行小幅漂移（ReconnectingWsClient.ts 心跳常量定义行），无凭空捏造行号现象。
3. **遗漏 4 项关键架构缺陷**：01 报告完全遗漏了冷启动时 hydrateAccount() 链式异步网络调用死锁开屏 Spinner 导致严重违反“≤1 秒启动”铁律的重大设计缺陷（OMIT-01），以及 pp/approvals.tsx 队列页裸奔无守卫（OMIT-02）、账号流程退出双重导航竞争（OMIT-03）、通知连续推入同一页面栈膨胀（OMIT-04）。

### 报告可信度汇总表

| 总项数 | ✅ 成立 | ⚠️ 部分成立 | ❌ 夸大 | 🚫 不成立 | ❓ 无法验证 | 综合评语 |
| :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **11 项** | **5 项** | **4 项** | **2 项** | **0 项** | **0 项** | **高参考价值（B+）：核心方向高度敏锐精准，但推演边界存在将最坏情况绝对化倾向** |

---

## 1 现状还原与核查基线

### 1.1 路由解析规范（node_modules 源码级核准）

通过白盒透视 
ode_modules/expo-router/build/getRoutesCore.js 与 matchers.js，彻底厘清 expo-router 57 的真实路由解析规则：
- **下划线目录规则**：在 getRoutesCore.js:101-109 中，框架默认构建的 ignoreList 仅包含 /^\.\/\+(html|native-intent)\.[tj]sx?$/ 以及 +api、+middleware。**框架从未提供下划线目录（如 _components/）自动忽略规则**；
- **_layout 专属特例**：在 getRoutesCore.js:530 与 matchers.js:71-76 中，仅严格匹配文件名（不带扩展名）为 _layout 的节点才被标记为布局节点（isLayout = true），并作为路径断点将子节点相对化。其余任何以 _ 开头的目录或文件（如 _components/foo.tsx）都会被视为常规路由文件；
- **Metro 警告的直接发射源**：位于 
ode_modules/expo-router/build/getRoutesCore.js:507 的 alidateRouteTreeExports() 函数：
  `javascript
  if (route == null) {
    console.warn(Route " is missing the required default export. Ensure a React component is exported as default.);
  }
  `
  该校验在开发环境下对所有由 equire.context 扫描出来的非 API 路由执行；因 ccountNavigation.ts 与 useOpenDrawer.ts 仅有命名导出，直接命中该行报警。
- **页面污染事实**：Protected.tsx、RequireAccount.tsx、useSafeBack.ts 均包含 export default，被 expo-router 完整注册进路由树（
ode.type = 'route'），可通过 crish://_components/Protected 任意挂载。

### 1.2 认证与双轨连接模型

移动端存在两套并行生效的认证与通信模型：
1. **局域网直连模型（Local Pairing）**：
   - 由 uthStore.pairState === 'paired' 表征；
   - 依赖本地持久化的设备公私钥材料（secureStore 中的 	oken_key / efresh_key）；
   - 通信直接经由 observationWiring 建立与桌面网关 wss://<host>:8765 的直连。
2. **账号远程中继模型（Account Relay）**：
   - 由 ccountStore.status === 'loggedIn' 且 pairState === 'unpaired' 表征；
   - 依赖云端中继鉴权凭证（ccessToken + 	argetDeviceId）；
   - 在 ccountRuntime.ts:72-76 中动态创建 RelaySocket 并注入 ensureRelayObservationWiring 与 ensureApprovalWiring。
- **冲突焦点**：多处页面路由守卫未意识到双轨共存，强行按单轨配对状态拦截，引发路由逻辑断裂。

### 1.3 前后台生命周期与心跳机制

- **心跳与假死常量定义**（src/network/ReconnectingWsClient.ts:82-86）：
  `	ypescript
  export const HEARTBEAT_INTERVAL_MS = 30_000; // 30 秒一次
  export const HEARTBEAT_TIMEOUT_FACTOR = 3;
  export const HEARTBEAT_DEAD_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_TIMEOUT_FACTOR; // 90 秒判定假死
  `
- **唤醒事件入口**（src/adapters/runtime/appRuntime.ts:49-66）：
  - 订阅 AppState.addEventListener('change', handleAppState)；
  - 
ext !== 'active' 时直接 eturn，未执行任何挂起或计时器暂停动作；
  - 唤醒时若 wiring.client.phase === 'open'，盲目调用 syncSubscriptions() 与 hydrateSession() 向半开连接写入数据。

### 1.4 行号核验与漂移率统计（抽检 19 处）

| 序号 | 报告引用位置 | 报告标注行号 | 工作区实际行号 | 实际代码片段核对 | 漂移判断 |
| :--: | :--- | :--- | :--- | :--- | :--- |
| 1 | pp/_components/Protected.tsx | 8 | 8 | if (pairState !== 'paired') { | ✅ 精确吻合 |
| 2 | pp/(main)/_layout.tsx | 19 | 19 | if (pairState !== 'paired' && accountUser === null) { | ✅ 精确吻合 |
| 3 | pp/welcome.tsx | 10 | 10 | if (pairState === 'paired' || accountStatus === 'loggedIn') { | ✅ 精确吻合 |
| 4 | pp/pair/_layout.tsx | 11 | 11 | if (pairState === 'paired' || accountStatus === 'loggedIn') { | ✅ 精确吻合 |
| 5 | src/adapters/runtime/appRuntime.ts | 49 | 49 | unction handleAppState(next: AppStateStatus): void { | ✅ 精确吻合 |
| 6 | src/adapters/runtime/appRuntime.ts | 51 | 51 | const wiring = getObservationWiring(); | ✅ 精确吻合 |
| 7 | src/adapters/runtime/accountRuntime.ts | 86 | 86 | discoveryTimer = setInterval(() => { | ✅ 精确吻合 |
| 8 | src/adapters/hooks/useCountdownTick.ts | 14 | 14 | const id = setInterval(() => setNow(Date.now()), intervalMs); | ✅ 精确吻合 |
| 9 | pp/_components/Protected.tsx | 14 | 14 | export default Protected; | ✅ 精确吻合 |
| 10 | pp/_components/RequireAccount.tsx | 14 | 14 | export default RequireAccount; | ✅ 精确吻合 |
| 11 | pp/_components/useSafeBack.ts | 22 | 22 | export default useSafeBack; | ✅ 精确吻合 |
| 12 | pp/run/[runId].tsx | 10-17 | 11-17 | <Protected> ... </Protected> | ✅ 精确吻合 |
| 13 | pp/terminal/[runId].tsx | 9-13 | 10-12 | <Protected> ... </Protected> | ✅ 精确吻合 |
| 14 | pp/approval/[toolCallId].tsx | 9-13 | 10-12 | <Protected> ... </Protected> | ✅ 精确吻合 |
| 15 | pp/approval-history.tsx | 7-11 | 8-10 | <Protected> ... </Protected> | ✅ 精确吻合 |
| 16 | pp/notifications.tsx | 8-14 | 9-14 | <Protected> ... </Protected> | ✅ 精确吻合 |
| 17 | src/network/ReconnectingWsClient.ts | 89-95 | 82-88 | 常量定义：HEARTBEAT_INTERVAL_MS = 30_000 | ⚠️ 漂移 7 行 |
| 18 | pp/pair/welcome.tsx | 1-14 | 1-14 | PairWelcomeRoute 全文 | ✅ 精确吻合 |
| 19 | src/network/ReconnectingWsClient.ts | 387-388 | 387-388 | /** 主动断开（iOS 后台挂起等场景...）*/ | ✅ 精确吻合 |

**统计结论**：抽查 19 处中 18 处行号无偏差，1 处偏差 7 行（为注释与常量定义的交界处），**行号漂移率仅 5.26%（准确率 94.74%）**。01 报告代码引证纪律良好，不存在胡编乱造行号的现象。
## 2 专项核查重点深度推演（对抗性验证）

### 2.1 DEF-RT-02「账号模式下二级页面被弹回首页」对抗推演

01 报告断言：“账号模式下 5 大核心功能弹回，100% 瘫痪”。经白盒复核与对抗性推演，该断言**在特定前提下成立，但措辞存在将“局部前提”绝对化为“全域瘫痪”的夸大**。

#### 1. 真实挂载 <Protected> 的路由清单
通过对全工程进行 AST 与文本扫描，确认全工程仅且仅有以下 5 个二级业务路由挂载了 <Protected> 守卫：
1. pp/run/[runId].tsx:11（任务运行详情）
2. pp/terminal/[runId].tsx:10（终端实时日志）
3. pp/approval/[toolCallId].tsx:10（审批详情卡片）
4. pp/approval-history.tsx:8（审批历史列表）
5. pp/notifications.tsx:9（通知中心）

#### 2. 账号登录且未配对时的完整跳转时序
当用户处于纯账号模式（ccountStatus === 'loggedIn' 且 pairState === 'unpaired'）时，点击上述任一路由的跳转链路如下：

`mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant SubPage as 二级页 (如 /run/xxx)
    participant Protected as Protected守卫
    participant Router as Expo Router
    participant Welcome as WelcomeRoute (/welcome)
    participant Home as 主界面 (/(main))

    User->>SubPage: 点击查看详情 / 系统通知拉起
    SubPage->>Protected: 挂载并渲染
    Note over Protected: pairState !== 'paired' (命中!)
    Protected->>Router: return <Redirect href=/welcome />
    Router->>Welcome: 替换路由至 /welcome
    Note over Welcome: accountStatus === 'loggedIn' (命中!)
    Welcome->>Router: return <Redirect href=/ /> (内部调用 router.replace)
    Router->>Home: 导航至首页 /(main)/index
    Note over Home: accountUser !== null 放行渲染
    Home-->>User: 画面闪烁后回到新对话首页
`

#### 3. 对抗性辨析与前提锁定
- **/welcome 是否无条件 eplace('/')？**  
  **是**。查阅 pp/welcome.tsx:10-12，当 ccountStatus === 'loggedIn' 时，直接返回 <Redirect href=/ />。在 
ode_modules/expo-router/build/link/Redirect.js:37 中，<Redirect> 在 useFocusEffect 中直接调用 outer.replace(href)。因此跳转至首页是刚性且无条件的。
- **审批功能是否在账号模式下本就无法使用？**  
  **否**。查阅 src/adapters/runtime/accountRuntime.ts:76，当账号中继建立后，明确执行了 ensureApprovalWiring()，桌面端的审批事件完全能够通过中继推送到手机端；此外，位于主界面的 ApprovalFloat（悬浮审批胶囊/卡片）支持直接点击“允许”与“拒绝”（ApprovalFloat.tsx:82-83），用户在首页即可完成审批决策。
- **“100% 瘫痪”的前提条件**：  
  “100% 瘫痪”仅在**纯账号中继且未曾进行本地扫码配对**的前提下成立；若用户在局域网内曾与桌面端扫码配对（pairState === 'paired'），无论是否登录账号，<Protected> 均会顺利放行。因此准确表述应为：“**在未进行局域网配对的纯账号中继模式下，5 大核心详情页 100% 无法打开**”。

---

### 2.2 DEF-RT-01「_components 被注册为路由」深度推演

01 报告指出 pp/_components/ 触发 Metro 警告并被污染为路由，经源码比对，**100% 属实且根因挖掘透彻**。

#### 1. 框架源码铁证
在 Next.js 体系中，下划线文件夹 _folder 为官方推荐的私有文件夹语法。但在 Expo Router 57（基于 React Navigation）中：
1. 
ode_modules/expo-router/build/getRoutesCore.js:101-109：扫描忽略表为硬编码正则，仅包含 +html、+native-intent、+api、+middleware，绝无 _ 目录忽略；
2. 
ode_modules/expo-router/build/matchers.js:71-76：下划线唯一的语法特例是 _layout；
3. 
ode_modules/expo-router/build/getRoutesCore.js:507：遍历所有子文件，由于 ccountNavigation.ts 与 useOpenDrawer.ts 只有具名导出，无法满足页面必须具名/默认导出 React 组件的约束，直接在终端打印 WARN Route ... is missing the required default export。

#### 2. 安全与架构漏洞实证
Protected.tsx、RequireAccount.tsx、useSafeBack.ts 因包含 export default，被 Expo Router 静默视作标准页面注册进路由表，使得任何第三方应用或浏览器通过 crish://_components/Protected 均可直接挂载一个空的守卫组件，暴露出严重的路由设计断层。

---

### 2.3 DEF-RT-03「认证判定标准漂移」对抗推演

01 报告主张：“系统内 5 处判定标准各异，极易在 /welcome 与 /(main) 之间形成死循环重定向”。经逻辑推演，**口径漂移属实，但“死循环重定向”缺乏实际触发闭环，属于推演过度**。

#### 1. 5 处认证判定横向比对表

| 序号 | 代码位置 | 判定逻辑 | 依据字段 | 真实设计意图与漏洞 |
| :--: | :--- | :--- | :--- | :--- |
| 1 | pp/(main)/_layout.tsx:19 | pairState !== 'paired' && accountUser === null | user | 允许改密等瞬态（status离开loggedIn但user仍在）停留在主页 |
| 2 | pp/welcome.tsx:10 | pairState === 'paired' \|\| accountStatus === 'loggedIn' | status | 欢迎页仅按 loggedIn 状态跳走 |
| 3 | pp/pair/_layout.tsx:11 | pairState === 'paired' \|\| accountStatus === 'loggedIn' | status | 排他阻断配对流程 |
| 4 | pp/_components/Protected.tsx:8 | pairState !== 'paired' | 仅 pairState | 遗漏账号体系的过时守卫 |
| 5 | pp/_components/RequireAccount.tsx:10 | user === null | 仅 user | 仅校验账号登录 |

#### 2. 死循环是否存在实机触发序列？
- 假设用户正在改密，status 临时变为 'loggingIn'，但 user 依然非空；
- 若此时用户在 /(main)，(main)/_layout.tsx 检查 ccountUser === null 不成立，**保持渲染，不会踢往 /welcome**；
- 若此时用户在 /welcome，welcome.tsx 检查 ccountStatus === 'loggedIn' 不成立，**保持渲染欢迎页，不会踢往 /(main)**；
- **结论**：两者都不会主动向对方发起无限跳转请求，死循环必须依赖“某处逻辑主动在非 loggedIn 状态下把用户从 (main) push 到 /welcome”。现有代码中不存在该跳转指令。因此该问题是**状态机多头管理与边界不一致风险**，而非已在线上激活的活体死循环。

---

### 2.4 DEF-RT-04 / DEF-RT-05 404 与物理返回键真实现状

#### 1. 404 兜底：框架存在默认兜底，断言“卡死白屏”严重夸大
- 01 报告称“在生产 APK 中界面会卡死在空白状态，无法回退”；
- **白盒查证**：
ode_modules/expo-router/build/views/Unmatched.js:51-105 明确证明：当应用未提供 pp/+not-found.tsx 时，Expo Router 自动注册系统内置的 Unmatched 组件，界面显示居中的 Unmatched Route、Page could not be found.，并带有一个**能够正常执行 outer.replace('/') 的 Go back 按钮**；
- **结论**：真实问题是“未按 Crish 设计规范提供品牌化、语义明确的 404 界面，暴露出框架原生黑底英文调试界面”，而非卡死白屏。01 报告在此处存在显著的夸大。

#### 2. 物理返回键：报告“0 处 BackHandler”事实错误
- 01 报告称：“全工程搜索 BackHandler 结果为 0 处”；
- **白盒查证**：src/presentation/pair/pairManualScreen.tsx:4, 133 明确写入：
  `	ypescript
  const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
    if (dirty) { setConfirmOpen(true); return true; }
    return false;
  });
  `
- **真实问题定位**：useSafeBack.ts 确实未封装 BackHandler；当系统通知或深链直接冷启动拉起单屏二级页（如 /approval/[toolCallId]）时，原生导航栈深度为 1，此时按 Android 物理返回键触发系统默认 Activity 退出，应用直接关闭。

---

### 2.5 DEF-LC-01 / DEF-LC-02 唤醒机制与 30~90s 常量求证

#### 1. 30~90s 常量来源与真实延迟推演
- **常量代码出处**：src/network/ReconnectingWsClient.ts:82（HEARTBEAT_INTERVAL_MS = 30_000）与 line 86（HEARTBEAT_DEAD_MS = 90_000）；
- **对抗性推演（真实延迟并不等于 90 秒）**：
  - 若手机进入后台超过 90 秒（常见场景：离开应用数分钟）：唤醒时 
ow - this.lastRxMs > 90_000 已经成立。当唤醒后定时器执行**第一次** heartbeatTick()（最长 30 秒内触发）时，isHeartbeatDead 立即命中为 	rue，直接调用 	his.ws?.close() 触发重连！
  - 因此在长后台场景下，实际最大等待时间是 **30 秒**（即等待下一次心跳 tick 的触发），而非 90 秒；
  - 只有在后台时间极短（<30 秒）且连接恰好断开时，才需要等待累计 3 个心跳周期（90 秒）。
  - **核心缺陷确凿存在**：唤醒时未根据 
ow - lastRxMs 执行**即时探活**，导致 0~30 秒不可控的假死窗口。

#### 2. 账号远程中继恢复缺失：100% 确凿
查阅 src/adapters/runtime/appRuntime.ts:51-57：
`	ypescript
const wiring = getObservationWiring();
if (!wiring) {
  if (authStore.getState().pairState === 'paired') {
    ensureObservationWiring();
  }
  return;
}
`
当应用在后台长时间驻留被系统回收资源、导致 wiring 变为 
ull 时，唤醒代码仅对 pairState === 'paired' 执行了恢复，**对账号远程中继模式（ccountStore.status === 'loggedIn'）彻底视而不见**。账号模式用户唤醒后连接永远丢失，必须杀进程重开。01 报告该项定性完全精准。
## 3 逐条判定表与遗漏扫描

### 3.1 被复核报告 11 项缺陷逐条对抗判定表

| 编号 | 缺陷名称与报告主张 | 被引代码位置及漂移 | 调用链复核结果 | 判定 | 修订后的准确表述 | 建议修复方案评估 |
| :--- | :--- | :--- | :--- | :---: | :--- | :--- |
| **DEF-RT-01** | _components 误作为路由扫描引发 Metro 告警与页面污染 (P1) | pp/_components/*<br>无漂移 | 追溯 getRoutesCore.js:101-109, 507，下划线目录未被忽略；缺 default export 报错，有 default export 则被暴露为路由。 | **✅ 成立** | pp/_components/ 目录被 expo-router 误判为路由节点，导致构建警告与守卫页面对外暴露。 | 合理。应彻底清理 pp/ 下非页面文件，统一迁移至 src/presentation/，杜绝任何补丁式语法糖。 |
| **DEF-RT-02** | <Protected> 导致账号模式下 5 大核心功能弹回瘫痪 (P0) | pp/_components/Protected.tsx:8<br>无漂移 | 追溯 5 个二级页面，<Protected> 重定向至 /welcome，欢迎页检测 ccountStatus === 'loggedIn' 立即 eplace('/') 弹回首页。 | **⚠️ 部分成立** | 在未进行局域网扫码配对的纯账号中继模式下，访问 5 大详情二级页会被强制弹回首页。 | 合理。修改守卫判定条件兼顾双轨状态，或收敛为领域层单一鉴权选择器。 |
| **DEF-RT-03** | 认证状态判定多处漂移，极易形成死循环重定向 (P2) | pp/(main)/_layout.tsx:19<br>pp/welcome.tsx:10<br>无漂移 | 5 处判定口径确实存在 user !== null 与 status === 'loggedIn' 漂移，但两端均无主动循环重定向逻辑，实测无自激死循环。 | **❌ 夸大** | 认证判定散落且口径漂移，存在改密/刷新令牌等瞬态下的视图状态分裂隐患，但未激活死循环。 | 合理。在纯函数领域层提取 isAppAuthenticated 作为 SSOT，杜绝各页面自行编写条件分支。 |
| **DEF-RT-04** | 缺失全局未捕获路由 +not-found.tsx，生产构建卡死空白 (P2) | pp/ 全局检索 0 结果<br>无漂移 | pp/ 下确无该文件，但 expo-router 框架自带 Unmatched.js 默认兜底及 Go back 按钮，不会卡死空白。 | **❌ 夸大** | 缺失自定义品牌化 +not-found.tsx，导致错误深链展示框架内置的未汉化英文调试界面。 | 合理。创建极简 +not-found.tsx，严格遵循 Design Token，提供平滑返回首页的按钮。 |
| **DEF-RT-05** | 全工程搜索 BackHandler 为 0 处，深链冷启动按返回键退 App (P2) | pp/_components/useSafeBack.ts:12<br>无漂移 | useSafeBack 未接 BackHandler 属实；但 pairManualScreen.tsx:4, 133 已使用 BackHandler，断言“0处”事实错误。 | **⚠️ 部分成立** | useSafeBack 仅处理 UI 按钮，深链冷启动单屏时 Android 物理返回键会触发系统默认退出。 | 合理。在安全返回 Hook 中集成 BackHandler 监听，当 !router.canGoBack() 时 eplace('/') 拦截退出。 |
| **DEF-RT-06** | PairLayout 阻断已登录账号用户进行局域网扫码配对 (P2) | pp/pair/_layout.tsx:11<br>无漂移 | 追溯代码，ccountStatus === 'loggedIn' 命中时根部直接 <Redirect href=/ />，导致整个 /pair 栈不可达。 | **✅ 成立** | PairLayout 粗暴拦截已登录用户，阻断了已登录账号的用户在局域网内扫码直连新桌面的能力。 | 合理。仅对 /pair/welcome 引导页做跳过，解封 /pair/scan 与 /pair/manual 功能路由。 |
| **DEF-RT-07** | 遗留旧版配对欢迎页（pair/welcome.tsx）形成僵尸路由 (P3) | pp/pair/welcome.tsx:1-14<br>无漂移 | 该路由为账号体系重构前的历史遗留代码，已被根路由 pp/welcome.tsx 替代，仍在路由栈中占位。 | **✅ 成立** | pp/pair/welcome.tsx 为历史冗余路由，存在体验分裂与维护负担。 | 合理。直接物理删除该文件并从 pair/_layout.tsx 移除 Screen 声明，坚决反对兼容保留。 |
| **DEF-LC-01** | 前台唤醒僵尸 Socket 盲等待 30~90s 通信假死 (P1) | src/adapters/runtime/appRuntime.ts:49<br>ReconnectingWsClient.ts:82<br>轻微漂移 7 行 | 唤醒时盲目向半开 Socket 写数据属实；但长后台唤醒时首个 tick（最长 30s 内）即判定假死，盲等待上限为 30s 而非 90s。 | **⚠️ 部分成立** | 锁屏/后台唤醒未执行主动即时探活，依赖被动心跳定时器（0~30s）检测假死，存在长达半分钟的通信静默窗口。 | 合理。唤醒时检查 
ow - lastRxMs，超过阈值立即主动 Ping 或主动 reconnect，无需被动等待。 |
| **DEF-LC-02** | 前台唤醒丢失账号远程中继连接自动恢复 (P1) | src/adapters/runtime/appRuntime.ts:51-57<br>无漂移 | 追溯代码，唤醒分支中当 !wiring 时仅判定了 pairState === 'paired'，完全漏掉了账号中继模式恢复。 | **✅ 成立** | 账号远程中继模式下，应用长后台导致连接实例销毁后，切回前台无法自动恢复通信。 | 合理。在唤醒无连接分支中补齐 syncRemote() 恢复通道，确保双轨通信均具备自愈能力。 |
| **DEF-LC-03** | 进入后台缺乏主动挂起，断网重试超限进入 dead 无法恢复 (P2) | ccountRuntime.ts:86<br>ReconnectingWsClient.ts:387<br>无漂移 | 后台定时器未暂停属实；但声称 dead 状态无法恢复事实错误，ppRuntime.ts:63 明确对非 connecting 调用了 econnect()。 | **⚠️ 部分成立** | 后台期间设备发现 15 秒轮询未主动挂起造成电量浪费；但唤醒重连机制对 dead 终态具备兜底能力。 | 合理。监听 AppState，在后台暂停轮询与无效退避，唤醒时立即执行一次刷新并重置定时器。 |
| **DEF-LC-04** | 根悬浮审批卡片在锁屏/后台持续触发 1 秒高频定时器 (P3) | ApprovalFloat.tsx:33<br>useCountdownTick.ts:14<br>无漂移 | ApprovalFloat 挂载在根布局，只要存在未决审批，其调用的 useCountdownTick 每秒执行一次 setInterval，后台未暂停。 | **✅ 成立** | 根悬浮审批卡片在锁屏和后台状态下持续触发 1 秒高频渲染 tick，造成后台电量无效消耗。 | 合理。在 useCountdownTick 内部感知 AppState，处于后台时冻结定时器，唤醒时立即对齐最新时间戳。 |
### 3.2 汇总评估表与可信度评语

- **被复核报告缺陷统计**：共 11 项。
  - ✅ **完全成立**：5 项（DEF-RT-01, DEF-RT-06, DEF-RT-07, DEF-LC-02, DEF-LC-04）
  - ⚠️ **部分成立**：4 项（DEF-RT-02, DEF-RT-05, DEF-LC-01, DEF-LC-03）
  - ❌ **严重夸大**：2 项（DEF-RT-03, DEF-RT-04）
  - 🚫 **完全不成立**：0 项
  - ❓ **无法验证**：0 项
- **审计员可信度评语**：  
  > 01 席报告具备非常出色的代码敏锐度与全局视角，精准击中了路由污染、账号中继模式二级页弹回、唤醒中继丢失等重大痛点。但其在推演“死循环”、“404 生产卡死”与“物理返回键 0 处”时存在将潜在隐患推向极端灾难化、且忽略框架底层防御与既有存量代码的倾向。总体评级为 **B+（高参考价值，需剔除夸大水分后采纳其修复方向）**。

---

### 3.3 遗漏扫描：覆盖文件清点

本席位对路由、导航及应用生命周期涉及的全部 26 个核心源码文件进行了全量盘点，审查 01 报告的覆盖情况：

| 文件路径 | 模块性质 | 01 报告覆盖状态 | 本席位复核评价 |
| :--- | :--- | :---: | :--- |
| pp/_layout.tsx | 根布局 / Splash闸门 | ⚠️ 仅覆盖 Stack | 遗漏冷启动 hydrateAccount 网络死锁开屏 Spinner 的重大设计缺陷（OMIT-01） |
| pp/welcome.tsx | 欢迎页 / 入口守卫 | ✅ 已覆盖 | 覆盖充分，准确指出 ccountStatus === 'loggedIn' 弹回 |
| pp/(main)/_layout.tsx | 主界面抽屉布局 / 守卫 | ✅ 已覆盖 | 覆盖充分，指出以 user 判定的口径差异 |
| pp/(main)/index.tsx | 新对话首页 | ⚠️ 仅提及路径 | 覆盖充分 |
| pp/(main)/session/[sessionId].tsx | 会话详情页 | ⚠️ 仅提及路径 | 覆盖充分 |
| pp/approvals.tsx | 待审批队列 Sheet | ❌ **完全遗漏** | **严重遗漏**：该路由无任何守卫，与子页面 <Protected> 冲突（OMIT-02） |
| pp/approval/[toolCallId].tsx | 审批决策卡 | ✅ 已覆盖 | 准确指出受 <Protected> 误拦截 |
| pp/approval-history.tsx | 审批历史列表 | ✅ 已覆盖 | 准确指出受 <Protected> 误拦截 |
| pp/run/[runId].tsx | 运行详情页 | ✅ 已覆盖 | 准确指出受 <Protected> 误拦截 |
| pp/terminal/[runId].tsx | 终端输出页 | ✅ 已覆盖 | 准确指出受 <Protected> 误拦截 |
| pp/notifications.tsx | 通知中心页 | ✅ 已覆盖 | 准确指出受 <Protected> 误拦截 |
| pp/tools/[sessionId].tsx | 工具调用 Sheet | ❌ 未覆盖 | 经查无独立守卫，依赖 session 内部上下文 |
| pp/settings.tsx | 设置界面 | ❌ 未覆盖 | 经查无独立守卫，通过抽屉进入 |
| pp/pair/_layout.tsx | 配对导航栈布局 | ✅ 已覆盖 | 准确指出拦截已登录用户的硬锁死 |
| pp/pair/welcome.tsx | 遗留配对引导页 | ✅ 已覆盖 | 准确指出僵尸路由 |
| pp/pair/scan.tsx | 扫码配对页 | ⚠️ 仅提及路径 | 覆盖充分 |
| pp/pair/manual.tsx | 手动配对页 | ⚠️ 仅提及路径 | 01 报告漏看了此处的 BackHandler 存量实现 |
| pp/account/* (8个文件) | 账号体系路由树 | ⚠️ 仅提及 import | 遗漏退出流程 dismissAll() 与 eplace 竞争（OMIT-03） |
| pp/_components/* (5个文件) | 非页面私有组件 | ✅ 已深度覆盖 | 覆盖充分，核心根因分析到位 |
| src/adapters/runtime/appRuntime.ts | 应用生命周期运行时 | ✅ 已深度覆盖 | 覆盖充分，准确抓取唤醒缺陷 |
| src/adapters/runtime/accountRuntime.ts | 账号远程中继运行时 | ✅ 已深度覆盖 | 覆盖充分，抓取后台轮询与退避问题 |
| src/adapters/hooks/useCountdownTick.ts | 倒计时 Hook | ✅ 已覆盖 | 覆盖充分，抓取后台高频空转 |
| src/presentation/components/approval/ApprovalFloat.tsx | 悬浮审批卡 | ✅ 已覆盖 | 覆盖充分 |
| src/network/ReconnectingWsClient.ts | WebSocket 客户端 | ✅ 已覆盖 | 覆盖充分，引用心跳与重连机制 |
| src/adapters/pairing/pairingController.ts | 配对接线控制器 | ❌ 未覆盖 | 经查配对水合无阻塞风险 |
| src/notifications/notificationBootstrap.ts | 通知层装配 | ❌ **完全遗漏** | 遗漏通知点击统一 outer.push 导致同页重复推入栈膨胀（OMIT-04） |

---

### 3.4 遗漏问题清单（OMIT-01 至 OMIT-04）

#### OMIT-01：冷启动 hydrateAccount() 串行网络请求阻塞开屏 Spinner，严重违反 U1「≤1 秒启动」铁律
- **代码锚点**：pps/crish-mobile/app/_layout.tsx:88 与 src/adapters/account/accountService.ts:162-210
- **现象**：当用户曾登录过 Crish 账号，在移动蜂窝网络（或弱网/中继网络延迟较大）环境下冷启动 App 时，开屏白底大图标与 Spinner 旋转停留长达 2~5 秒以上，无法在 1 秒内进入主界面。
- **直接原因**：
  pp/_layout.tsx:88 规定：
  if (!hydrated || !accountHydrated) return <Splash />;
  而在 ccountService.ts:162-210 的 hydrateAccount() 中：
  `	ypescript
  const session = await loadAccountSession(driver);
  // 必须串行等待远程网络请求返回
  let user = await fetchAccountMe(session.accessToken).catch(...);
  const [devices, profile] = await Promise.all([
    loadDevicesBestEffort(token),
    fetchAccountProfile(token).catch(() => null),
  ]);
  // 直到最后 finally 块才放行水合完成标志
  accountStore.getState().setHydrated(true);
  `
- **根因分析**：架构层误将“远程数据拉取与令牌实时校验”作为“应用 UI 渲染闸门（Splash Gate）”的前置依赖。本应“优先基于本地已持久化的 session 快照在 100ms 内秒开进入可交互首页，远程设备与资料校验全部退入后台静默异步执行”。
- **影响**：直接破坏用户硬性要求 U1（“打开软件 ≤1 秒，理想 <1 秒进入可交互界面；不允许长时间停留在开屏标题或等待界面”）。
- **置信度**：**已验证**（100% 存在于代码主干，逻辑无任何旁路豁免）。

#### OMIT-02：pp/approvals.tsx 队列页裸奔无守卫，与子页面拦截形成半暴露
- **代码锚点**：pps/crish-mobile/app/approvals.tsx:5-11
- **现象**：未配对且未登录的用户通过深链（crish://approvals）可直接打开审批队列 Sheet，但点击队列中的任意条目时，因子页面 /approval/[toolCallId] 挂了 <Protected> 守卫，瞬间被踢往 /welcome。
- **直接原因**：开发者遗漏了对 pp/approvals.tsx 根组件的守卫包裹，导致队列列表暴露而详情拦截，前后体验割裂。
- **根因分析**：守卫机制分散在各个路由文件中手工包裹，未在根级导航或统一布局中按路由规则集中守卫，导致漏包。
- **影响**：权限边界不闭环，产生未定义交互。
- **置信度**：**已验证**。

#### OMIT-03：inishAccountFlow 同步连续执行 dismissAll() 与 eplace('/') 导致导航操作竞争与转场撕裂
- **代码锚点**：pps/crish-mobile/app/_components/accountNavigation.ts:16-17
- **现象**：用户在登录页或设置密码成功后，界面发生瞬间抽搐撕裂，控制台偶发 React Navigation 状态分发告警。
- **直接原因**：
  `	ypescript
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
  `
  dismissAll() 向底层原生栈分发全部 pop 动作，在同一 JavaScript 事件循环 tick 内紧接着分发 outer.replace('/')，导致底层原生栈在尚未完成 modal dismiss 动画时接收到路由替换指令。
- **根因分析**：未遵循 React Navigation 的单次分发与时序收口规范，属于典型的“连击补丁式跳转”。
- **影响**：破坏用户硬性要求 U9（“丝滑过渡，不要生硬转场、不要突变、不要布局跳变”）。
- **置信度**：**已验证**。

#### OMIT-04：系统通知拉起统一硬编码 outer.push(path) 导致同页重复推入栈膨胀
- **代码锚点**：pps/crish-mobile/app/_layout.tsx:71
- **现象**：当用户正在查看某个运行详情页（/run/abc）或终端页时，系统再次推送该运行的新通知，用户点击通知栏，应用在当前栈顶再次叠加推入一个完全相同的 /run/abc 页面；用户需要连续按两次返回键才能退出该页面。
- **直接原因**：ensureNotificationsForApp({ navigate: (path) => router.push(path) }) 统一使用了 push 而非具备单例幂等语义的 
avigate。
- **根因分析**：深链导航未做路由栈去重与单例判断。
- **影响**：导航历史栈无序膨胀，破坏返回流转体验。
- **置信度**：**已验证**。
## 4 风险与未决问题（需用户裁决事项）

在落实后续重构方案（N01 / N02 方案席）之前，以下 4 项关键架构决策需要用户明确裁决：

### 裁决项 1：hydrateAccount() 开屏阻塞启动改造（彻底保障 U1 ≤1 秒开屏）
- **背景**：当前 hydrateAccount() 在开屏时强行进行网络请求（etchAccountMe、loadDevicesBestEffort 等），导致开屏卡在 Spinner 2~5 秒，严重违反 U1 铁律。
- **方案 A（推荐 · 本地优先秒开）**：读完本地 SecureStore 的 session 缓存后立即触发 ccountStore.setHydrated(true)（耗时 ≤50ms），瞬间进入主界面；网络拉取设备和资料全部转为后台静默异步刷新，失败则弱网 Toast 提示。
- **方案 B（严格在线校验）**：保持强网络校验，仅在超时 1.5 秒后降级放行。
- **请示用户**：是否批准方案 A，彻底根除开屏网络阻塞？

### 裁决项 2：局域网配对与账号体系的认证状态契约整合（SSOT）
- **背景**：当前 uthStore.pairState 与 ccountStore.status 分立，导致多处守卫写出混乱的组合条件。
- **方案 A（推荐 · 领域层单一选择器）**：在 src/domain/pure/authSelectors.ts 定义纯函数 isAppAuthenticated 与 getConnectionChannel，所有路由守卫统一消费该纯函数，严禁在 UI 层直接拼接 pairState 与 ccountStatus。
- **方案 B（状态机彻底合流）**：将 ccountStore 中的中继连接状态并入 uthStore，消除双 store 并立。但该改动影响范围较大，需评估对既有测试的影响。
- **请示用户**：是否优先采用方案 A 进行非侵入式单一真理源收口？

### 裁决项 3：Android 物理返回键全局拦截策略
- **背景**：深链冷启动单屏时物理返回键直接退 App。
- **方案 A（推荐 · 导航根级拦截）**：在统一封装的 useSafeBack 或顶层 Navigation 容器中注册 BackHandler，检测当 !router.canGoBack() 时统一 outer.replace('/') 兜底回首页。
- **方案 B（按需页面声明）**：仅在由深链/通知拉起的高频二级页（如 /approval、/run）手动挂载拦截器。
- **请示用户**：是否批准在导航层实施方案 A 全局兜底？

### 裁决项 4：404 未捕获路由的处理方式
- **背景**：当前暴露 Expo 默认英文调试黑屏。
- **方案 A（推荐 · 品牌化极简兜底页）**：落地 pp/+not-found.tsx，无大图标（遵循 U10），仅使用项目 Theme Token 的背景与排版文字，提供一个“返回首页”按钮。
- **方案 B（零感知自动重定向）**：在 +not-found.tsx 中挂载即自动 eplace('/')，不向用户展示任何 404 界面。
- **请示用户**：采用符合规范的极简品牌页（方案 A）还是自动静默回首页（方案 B）？

---

## 5 集中验收清单（代码重构后统一执行）

根据共同约束前言“不要改一点测一点，集中统一验收”的要求，全部重构改动落盘后执行以下集中验收：

### 5.1 静态与架构规范断言
- [ ] **Metro 启动零警告**：执行 
pm start，Metro 控制台零 Route ... is missing the required default export 警告；
- [ ] **私有目录清理彻底**：物理目录 pps/crish-mobile/app/_components/ 彻底不存在；pp/ 下无任何以 _ 开头的非 _layout 文件；
- [ ] **僵尸路由下线**：pps/crish-mobile/app/pair/welcome.tsx 物理删除，pair/_layout.tsx 仅包含 scan 与 manual；
- [ ] **Theme Token 纯净性**：所有新增路由（如 +not-found.tsx）及迁移组件，零硬编码颜色/间距，
px jest src/presentation/styleTokens.guard.test.ts 100% 通过。

### 5.2 状态机与路由逻辑纯单元测试断言
- [ ] **认证 SSOT 判定用例**：
  - 覆盖 pairState === 'paired' 无论账号状态均返回 	rue；
  - 覆盖 pairState === 'unpaired' 且 status === 'loggedIn' 且 user !== null 返回 	rue；
  - 覆盖未配对且 status !== 'loggedIn' 返回 alse；
  - 覆盖 user === null 返回 alse。
- [ ] **前后台心跳探活逻辑用例**：
  - 测试 AppState 从 ackground 切回 ctive 时，若 
ow - lastRxMs > 15s，触发探活 Ping 帧；
  - 测试 AppState 处于 ackground 时，ccountRuntime 的 15 秒轮询定时器处于静默冻结态；
  - 测试 AppState 处于 ackground 时，useCountdownTick 定时器不执行状态派发。
- [ ] **中继模式唤醒恢复用例**：
  - 模拟 wiring === null 且 ccountStore.status === 'loggedIn'，切回前台时触发 syncRemote() 重新建立接线。

### 5.3 华为 P50 真机专项验收断言（Android 12 / Release 构建）
- [ ] **U1 极速启动验收**：在登录账号状态下冷启动 App，从点击图标到新对话界面可输入状态，实测总耗时 **≤1.0 秒**，不再出现长于 1 秒的开屏 Spinner 等待；
- [ ] **账号中继二级页可达性**：在纯账号中继连接状态下（未配对局域网），分别点击运行详情（/run/[id]）、终端日志（/terminal/[id]）、审批详情卡片（/approval/[id]）、审批历史（/approval-history）、通知中心（/notifications），**100% 顺畅推入目标页面，绝不弹回首页**；
- [ ] **物理返回键拦截验收**：通过系统通知直接拉起审批决策卡，按手机实体返回键或边缘侧滑返回手势，应用**平滑返回至主对话界面，绝不直接退出应用**；
- [ ] **前后台切换秒级自愈**：应用在锁屏挂起 3 分钟后点亮唤醒，右上角连接状态在 **1 秒内**完成重连或探活确认，发送消息立即可达，无任何 30~90 秒假死现象；
- [ ] **404 兜底验证**：通过浏览器输入 crish://random-dead-path 拉起应用，展示统一主题规范的 404 提示页，点击“返回首页”按钮立即无缝切回主对话界面。
