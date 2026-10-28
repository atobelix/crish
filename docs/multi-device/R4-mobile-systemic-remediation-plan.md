# R4 移动端系统性修复行动方案（crish-mobile）

> 文档编号：R4-mobile-systemic-remediation-plan
> 定位：移动端（apps/crish-mobile）全量勘察后的系统性改进总方案——问题登记 + 分批实施账本
> 日期：2026-10-28
> 基线：typecheck 全绿；jest 137 套件 / 2019 用例全绿；工作区干净（10df296f6）
> 裁决依据（用户，2026-10-28）：① 彻底改进、架构清晰、抽象合理；② 非必要不兼容，兼容越少越好；反对打补丁式/兼容式改进；③ 该删就删、该重构就重构、减少重复；④ 大块改完后集中测试，不逐块跑测。
> 编码：UTF-8 无 BOM，中文。

---

## 1. 现状判定（结论先行）

移动端工程质量整体良好：presentation → adapters → domain 分层执行到位、reducers/store 两件套纪律、生成面解析器唯一权威、覆盖率阈值达标。**问题集中在四类**：

1. **双轨未收口**：持久化 settingsStore 已建成但 UI 全部走旧内存 store（主题/通知偏好重启即丢——用户可感知 bug）；云账号域（cloudAuth）游离于分层纪律之外。
2. **兼容层堆积**：R2 迁移期留下 6 处「纯 re-export / 别名 / 死 scheme」兼容面，违反「非必要不兼容」裁决。
3. **设计-实现断层**：仪表盘 F1 状态卡未实现（VM 死功能）、审批历史页路由缺失（导航崩）、断网判定恒 false、8 表 schema 仅 3 表有 DAO。
4. **样板重复**：单例上下文 ×5、错误包装类 ×2、同语义动作对（clearPairing/revokeLocal、markDecisionSent/handleResolved）。

## 2. 问题清单（勘察实证）

### A. 功能性 Bug（用户可感知）

| 编号 | 问题 | 实证 |
| --- | --- | --- |
| A-1 | 设置全部不持久化：主题三选、通知开关存内存，重启即丢；持久化 settingsStore 空转（唯一消费者 dbBootstrap.hydrate，读了没人用） | `themeModeStore`（theme.ts:98）、`settingsLocalStore`、`settingsStore` 三套并存 |
| A-2 | 审批中心「已处理」入口跳不存在路由 `/approval-history`（expo-router 无该页面，导航报错） | `app/(tabs)/approvals.tsx:10` |
| A-3 | 一键免扫码直连欺骗性 UI：把桌面 id 当本机 deviceId 写入；不落任何凭据（重启即失配）；失败无提示；文案宣称「300ms E2EE 隧道」无实现；relay 票据接口服务端 404（cloudAuthClient 注释诚实标注） | `pairWelcomeScreen.tsx:68-93` |
| A-4 | 配对自定义端口丢失：`finalizePairing` 建会话连接硬编码 `DEFAULT_GATEWAY_PORT`，端口不持久化（doHydrate 无法恢复） | `pairingWiring.ts:678-683` |
| A-5 | 「缩略图仅 Wi-Fi」假开关：无任何消费方（文件预览为纯文本，无缩略图特性） | 全仓 grep 无消费 |

### B. 规范违规（项目铁律）

| 编号 | 问题 | 实证 |
| --- | --- | --- |
| B-1 | UI Emoji（§21 全系统禁 Emoji） | `fileMeta.ts`（📁📄🖼📕📊⚙ 文件图标）、`pairWelcomeScreen.tsx:139/156`（⚡💡） |
| B-2 | 组件硬编码色值（M4 §3.8 禁令） | `pairWelcomeScreen` #22c55e/#3b82f6/#ef4444；`fileMeta` 5 色；`Tooltip`/`SlideToConfirm` shadowColor #000 |
| B-3 | 深路径直插 packages 源码 ×8 | WsEnvelope/WsGateway/signer/useSettingsVm/sessionSigning（shared-types）、eventReducers（shared-utils ×3） |
| B-4 | 绕过 useAppStore 订阅唯一入口 | `pairWelcomeScreen` 直接 `useSyncExternalStore(cloudAuthStore)` |

### C. 非必要兼容层（清退对象）

| 编号 | 对象 | 形态 |
| --- | --- | --- |
| C-1 | `adapters/settings/themeProjection.ts` + `theme.ts` 内 `useAppTheme` 别名 | 纯 re-export 兼容层（R2-05j 遗留）+ 双保险别名 |
| C-2 | `presentation/components/terminal/terminalLineBuffer.ts` | 纯 re-export（防 store→presentation 反向依赖的过渡产物，方向已修好） |
| C-3 | `pairing/cxnCode.ts` | 纯 re-export 门面 |
| C-4 | `adapters/wiring/pairingWiring.ts` | 纯 re-export 门面（`export * from './pairing'`） |
| C-5 | `connectionStore.retryCount` | attemptCount 的镜像兼容别名（仅为旧测试保留） |
| C-6 | 深链 `conex://` scheme 白名单 | 全仓无生产者的死兼容（app.json scheme=crish，桌面无 conex:// 发送方） |

### D. 架构断层 / 死代码 / 重复

| 编号 | 问题 | 实证 |
| --- | --- | --- |
| D-1 | cloudAuthStore 违反分层：domain store 直接 `new CloudAuthClient()`（domain→network，全仓唯一违例）；accessToken/refreshToken 明文进 store（违反 authStore「状态层不存明文」纪律）；零测试；风格离群 | `domain/store/cloudAuthStore.ts` |
| D-2 | 8 表 schema 仅 3 表有 DAO：events/approval_queue/approval_history/session_summaries/push_tokens/device_info 建表无读写；approval outbox 实际持久化走 SecureStoreOutboxAdapter（双通道并存，表为死重）；`metaDao.test.ts` 名实不符（实测 settings/notifications） | `db/schema.ts` vs `db/dao/` |
| D-3 | 仪表盘 F1 未实现：页面仅渲染快速操作；useDashboardVm 的 deviceCount/pendingApprovalCount/activeRunCount/entries/三个 filter toggle 全部无消费；`windowOf()` 在 useMemo 内非响应式读取（潜在 stale） | `app/(tabs)/index.tsx` vs `useDashboardVm.ts` |
| D-4 | 断网判定恒 false：`mapWsPhase(phase, false)`，NetInfo 未装依赖未接线，「offline 优先级最高」设计未落地 | `feedBridge.ts:157` |
| D-5 | 单例上下文样板 ×5：observationWiring/filesWiring/quickRunWiring/runControlWiring/settingsWiring 的 singleton+get+resetForTest 复制粘贴 | 各 wiring 文件 |
| D-6 | 错误包装类重复：RunTaskCommandError / RunControlCommandError 同构（对 GatewayError 纯转发）+ 两份错误文案表同构 | quickRunWiring / runControlWiring |
| D-7 | 同语义动作对：authStore.clearPairing ≡ revokeLocal；approvalStore.markDecisionSent ≡ handleResolved（函数体全同） | authStore / approvalStore |
| D-8 | 模板残留资产 ~450KB：react-logo×3 / expo-badge×2 / expo-logo / logo-glow(331KB) / tutorial-web / tabIcons/ 全部无引用 | assets/images/ |
| D-9 | WsPhase 类型所有权倒挂：network 层反向 import domain/pure/selectors | ReconnectingWsClient/feedBridge/pairingWiring |
| D-10 | settingsStore 投机性配置面：general 组（responseStyle/analytics/telemetry）+ fontScale/listDensity/defaultSort 全部无 UI 无消费 | settingsReducers.ts |
| D-11 | jest 全量后 worker 不退出（定时器泄漏警告，来源待查：WsGateway 超时表 / 调度器 / retryTimer） | jest 输出 |
| D-12 | pairWelcomeScreen 死样式 `styles.input` | 未引用 |

### E. 安全缺口（AU5 已登记，跨端项如实分级）

| 编号 | 问题 | 本轮处置 |
| --- | --- | --- |
| E-1 | 事件流/tool 输出 sk- 打码未移植移动端（桌面 redact.ts 与 Rust redact.rs 共规范） | redactSecrets 下沉 `packages/shared-utils`（TS 单实现），移动端 ingest 面接入 |
| E-2 | auth.refresh 无发送方、markTokenExpired 无触发点（桌面 WS server 亦未实现 auth.refresh 处理——跨端缺口） | 本轮移动端只做诚实触发点：error 帧 auth.* 码 → markTokenExpired；auth.refresh 发送方登记跨端缺口待桌面排期 |
| E-3 | 证书固定：fingerprintVerifier 已在配对链落地（AU5 S-1 部分收敛）；RN WebSocket 信任注入面仍缺 | 维持登记，不属本轮 |

## 3. 分批实施方案（测试策略：每批完成后集中跑 typecheck + jest）

### 批次 1：兼容层清退 + 深路径修复 + 资产清理（纯机械，零行为变更）

1. 删 C-1~C-6 六处兼容面（消费方改直连：theme、domain/pure/terminalLineBuffer、domain/pure/cxnCode、./pairing、attemptCount、仅 crish:// 白名单）。
2. 8 处深路径改包导入（`@crish/shared-types` / `@crish/shared-utils`）；jest moduleNameMapper 补 `@crish/shared-utils` → src 直出（对齐 shared-types 防 stale dist 假绿先例）。
3. 删 D-8 模板残留资产、D-12 死样式。
4. 验收：typecheck + jest 全绿；rg 验证无残留 re-export / 深路径 / 无引用资产。

### 批次 2：设置持久化统一（A-1/A-5 修复 + D-10 收敛）

1. settingsStore 收敛为实际消费面：`appearance.theme` + `notification`（masterOn + 5 场景开关）；删除 general 组、files 组、fontScale/listDensity/defaultSort 空转面（未来接线时按组追加，merge-with-defaults 天然兼容）。
2. themeModeStore 删除 → useTheme 订阅 settingsStore.appearance.theme（hydrate 后生效，重启保留）。
3. 设置页 VM/组件迁移：场景开关 UI（总开关 + 审批/任务完成/消息/异常/设备离线）；删 settingsLocalStore.ts + settingsNotificationWiring.ts；prefsGate 直读 settingsStore（通道→场景映射 approval→approval、run→taskDone、general→message、error→error、security 恒放行）。
4. 缩略图假开关删除（A-5）。
5. 验收：typecheck + jest；新增「主题持久化往返」测试（set → 模拟 hydrate → 读取一致）。

### 批次 3：审批历史页 + 仪表盘 F1 状态卡（A-2 修复 + D-3 补全）

1. 新建 `app/approval-history.tsx`（F2 §7 历史记录全量页；ApprovalListScreen 抽出 HistoryList 复用；路由守卫同其余详情页）。
2. 仪表盘补 F1 状态卡：连接相位卡（相位 + 设备数 + 最后同步）+ 统计行（活跃 run / 待审批）+ 最近会话 feed 摘要（EventFeed 只读复用，修复 windowOf 非响应式读取——改经 useEventStore 订阅窗口）。
3. useDashboardVm 死字段清理：filter toggle 移除（过滤条属于 feed 页），保留页面真实消费面。
4. 验收：typecheck + jest + 新路由/新卡组件测试。

### 批次 4：cloudAuth 域收编 + 一键直连诚实化 + 配对端口（D-1/A-3/A-4 修复）

1. cloudAuthStore 迁出 domain → `src/adapters/cloud/cloudAuthStore.ts`：client 构造注入；token 明文不进 store（登录后经 secureStore 持久化，store 只持元数据/user/devices）；补 wiring 测试。
2. 一键直连诚实化：deviceId 用本机生成 id（domain/pure/id.ts）；票据申请失败如实展示错误（不再静默）；无凭据落库则**不进入 paired 态**（中继握手未实现前不写假配对）；删除虚假文案（⚡/「300ms E2EE」）。
3. 配对端口持久化：PAIRING_META_PORT_KEY 新键；beginPairing/finalizePairing/doHydrate 全链用持久化端口（A-4）。
4. 验收：typecheck + jest + pairingWiring 端口链路测试。

### 批次 5：redact 下沉 + token 过期触发（E-1/E-2 最小诚实落地）

1. `redactSecrets`（含测试）下沉 `packages/shared-utils/src/redact.ts` 并入 index 导出；桌面 `utils/redact.ts` 改 re-export 或改导入（单一 TS 实现源）。
2. 移动端接入点：terminalWiring ingest 面 + EventRow 流式文本渲染前打码。
3. WsGateway error 帧分发处：auth.* 错误码（auth.expired / auth.revoked / auth.unknown_device）→ authStore.markTokenExpired()（与 terminalWiring 的配对态清退联动）。
4. E-2 剩余（auth.refresh 发送方 + 桌面处理）登记跨端缺口，不在本轮伪造。

### 批次 6：样板去重 + 归位收口（D-4/D-5/D-7/D-9/D-11）+ 全量验证

1. `createWiringSingleton` 小工具收敛 ×5 单例样板（10 行级工具，非过度设计）。
2. 错误包装收敛：quickRun/runControl 共用 `GatewayCommandError` + 一份文案表结构（文案本体保留各自域）。
3. 动作合并：revokeLocal 删除（保留 clearPairing 单名）；approvalStore 的 markDecisionSent/handleResolved 合并为单实现双别名（或收敛为 resolve 一名）——按最小惊扰原则取别名收敛。
4. WsPhase 类型迁 `src/network/`（所有权归位）；domain/pure/selectors 保留 UI 相位映射（mapWsPhase 移至 wiring 投影点，断 offline 参数接线点保留显式 false → 恒定语义改为默认离线检测注入 seam，D-4 登记）。
5. NetInfo：本轮不引入新依赖（D-4 的完整落地需装 @react-native-community/netinfo，属功能增强）；在 feedBridge 预留注入 seam 显式化 + 登记缺口。
6. jest worker 泄漏定位（--detectOpenHandles）并修复；`metaDao.test.ts` 改名 `settingsAndNotificationsDao.test.ts`。
7. 验收：typecheck + jest 全量 + `npm run check:desktop`（如涉 shared-utils 需过桌面 typecheck）+ FULL_CHECK_COMMANDS 相关面。

## 4. 风险与边界

- 不动 Rust 侧与桌面 UI（批次 5 仅新增 shared-utils 导出 + 桌面导入面切换，桌面 typecheck 把关）。
- 不引入新 npm 依赖（NetInfo/FlashList/lucide 登记为后续增强，不属本轮）。
- E2E 真机联调（R2-16 遗留）需真机环境，本轮以单测/类型面为验收，真机项登记不谎报。
- 每批完成后 `git commit --only` 限定路径收口（多 Agent 共享工作区纪律）。

## 5. 状态账本

| 批次 | 状态 | 完成记录 |
| --- | --- | --- |
| 1 | ✅ 完成 | typecheck 全绿；jest 137 套件 / 2017 用例全绿（减 2 = 删除的兼容断言；首轮后台跑 3 失败为本机并行负载噪声，复跑 3 次稳定全绿）。清退兼容层 5 处（themeProjection+useAppTheme 别名 / terminalLineBuffer re-export / cxnCode 门面 / pairingWiring 门面 / retryCount 别名）+ conex:// 死 scheme + 深链死目标（/tasks、/usage、/diagnostics）；8 处深路径改包导入（jest mapper 补 @crish/shared-utils）；revokeLocal 合并进 clearPairing（D-7 提前）；测试资产归位（cxnCode/terminalLineBuffer/pairingWiring 三测试随实现移动）；删模板资产 ~450KB + 死样式 |
| 2 | 待开始 | — |
| 3 | 待开始 | — |
| 4 | 待开始 | — |
| 5 | 待开始 | — |
| 6 | 待开始 | — |
