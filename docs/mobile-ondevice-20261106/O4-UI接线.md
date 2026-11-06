# O4 批：UI 接线（内置供应商条目 + 模型同步 + 管理视图 + 选择器联动）

时间：2026-11-06（EST）。范围：可行性报告 §5.4 + §5.5 O4 验收口径，并收 O3 遗留两笔账（vendor 裁决、标题调用点）。结论先行：**内置条目、models[] 同步、管理视图、列表置顶特殊行全部落地；`tsc --noEmit` 零错误，定向 jest 16 套件 / 200 例全绿（orange 主体）；真机走查未执行——验收机不在 adb 列表，如实登记待 O5。** 未 commit / push / 动 stash。延迟哈希复核 20/20 与本地最终版一致；段落纪律自证：13 个改动文件的「拉取副本哈希 == 改前备份哈希」，拉取→备份窗口内无他线同文件改动被覆盖（其中 localChatClient.ts / localChatEngine.ts / localChat.ts 三个文件的改前哈希与 O3 报告 MD5 逐一吻合）。

## 一、改动文件清单（PC 落盘 MD5）

**新建（7）**

| 文件 | MD5 |
|---|---|
| `src/adapters/onDevice/onDeviceProviderSync.ts`（内置条目构造 + 同步） | `3172a6d2543d6a324458d13835cbd673` |
| `src/adapters/onDevice/onDeviceProviderSync.test.ts` | `74bfadb3dd1b598b71427609cc977d23` |
| `src/adapters/viewmodels/useOnDeviceModelsVm.ts`（管理视图 VM + 纯映射） | `d5153d264d9f518939bcd4639ebe05f6` |
| `src/adapters/viewmodels/useOnDeviceModelsVm.test.ts` | `6c8dde2c0d8b16788e025d219626a1a9` |
| `src/presentation/components/localChat/views/OnDeviceModelsView.tsx`（管理视图） | `93cf57374d7d0fc14733b5a0701b0db7` |
| `app/settings-local-ondevice.tsx`（路由壳） | `2770ac3f86e1c5aa242f2b0b19b2b3cf` |
| `src/adapters/localChat/localChatEngine.onDeviceTitle.test.ts`（标题透传） | `1d702e67af555a25432345b70b91aa4b` |

**修改（13）**

| 文件 | 改动 | MD5 |
|---|---|---|
| `src/domain/types/localChat.ts` | 仅注释：LocalVendorKey 声明处补 O4 语义边界裁决（见第三节） | `301cddb80ef99b308cd822c23dbd3813` |
| `src/adapters/localChat/providerPresets.ts` | 删本地 LocalVendorKey 声明，改引领域声明 | `30324acb986a57393ce2aed73a855eb9` |
| `src/presentation/components/localChat/ui/vendorLogosData.ts` | 删本地 LocalVendorKey 声明与无人消费的 KnownVendorKey 别名，改引领域声明 | `f69d1d8005dc428969c0f0b89a10572b` |
| `src/presentation/components/localChat/ui/VendorLogo.tsx` | LocalVendorKey 改引领域声明 | `a7bacbc9c2fc5026356a59909b653d15` |
| `src/presentation/components/chat/LocalModelSheet.tsx` | 同上（isLocalVendorKey 仍引 vendorLogosData） | `90b69b2ac0b22cd155a7915c75e7cd9e` |
| `src/presentation/components/chat/ModelSheet.tsx` | 同上 | `6443099f8b0b2ce904dc02518431e39d` |
| `src/adapters/localChat/localChatClient.ts` | LocalVendorKey 改引领域声明 | `c1e3ef38194865908ab10b9f77d6f9a3` |
| `src/adapters/viewmodels/useProviderWizardVm.ts` | LocalVendorKey 改引领域声明 | `f54a66aa809298698f752a7eebdcebb1` |
| `src/adapters/localChat/localChatEngine.ts` | 标题组装点补 `providerId: sel.providerId` 一行（见第四节） | `813ec0ab8a7de98746f329960dbd972b` |
| `src/adapters/viewmodels/useLocalProvidersVm.ts` | rows 排除端侧条目 + 新增 onDeviceRow 投影 + 挂载后自愈同步；行投影抽 rowOf 共用 | `69ee3cff79032f29da8d3f1abc056490` |
| `src/presentation/components/localChat/views/ProvidersListView.tsx` | 置顶「本机模型」特殊行 + onSelectOnDevice 导航；Hero 为端侧条目时同路改道 | `a9b6c8db68a0b9ec4b49262c8597a383` |
| `app/settings-local-providers.tsx` | 传 onSelectOnDevice → `/settings-local-ondevice` | `325a4997351e1d5b9d8661a128bf81e2` |
| `app/settings-local-provider-detail.tsx` | 守卫：id=ondevice 改道管理视图（见第五节） | `0ee36c777605a7fd28b82eb6a477fec4` |

备份：`C:\Users\Administrator\AppData\Local\Temp\muse-backup-20261106-o4\`（13 个既有文件改前副本）。

## 二、内置条目与 models[] 同步（onDeviceProviderSync.ts）

- **条目构造（纯函数 buildOnDeviceProviderSpec）**：providerId 固定 `ondevice`、displayName「本机模型」、protocol `'ondevice/gguf'`、stream/enabled true；**无 baseUrl、无 apiKeyRef、无 vendor**（单测钉死三者为 undefined）。条目由代码构造，不经草稿路径（`buildProviderSpecFromDraft` 的 openai/chat 硬编码与它无关）、不进向导预置。模型能力只写端侧真值：contextWindow 取目录 `inference.contextSize`（3B 2048、其余缺省 4096，与 O3 客户端 initLlama 缺省一致）、纯文本模态、无思考档位（v1 纯对话 fail-closed）。defaultModelId = 就绪集中的推荐档（1.5B），与入参顺序无关。
- **同步（syncOnDeviceProvider）**：唯一真值源 = 管理器 `checkAll()`（ready = 文件在位 + 尺寸精确 + verified.json 在案）。就绪集与现条目 models[] 一致则不回写（单测以 kv 写入次数钉死）；无就绪模型且条目不存在时不造空条目；条目存在后就绪集变空则回写空 models[]（条目在、无可用模型，选择器如实呈现「暂无可用模型」）。回写走 `localChatStore.upsertProvider` 既有持久化落 SQLite kv。
- **回退不悬空（零新逻辑，复用 store 自愈）**：删除当前活动模型时，upsertProvider 的既有自愈把 activeModel 回退到条目默认模型（推荐档）；全删则清空；引用了被删模型的线程 modelRef 被解绑回跟随全局。单测逐条覆盖（活动 3B 被删 → 回退 1.5B；全删 → activeModel=null）。
- **触发点**：管理 VM 挂载核对后、每次下载落定 ready 后、每次删除后；供应商列表 VM 挂载（水合后）自愈同步一次（外部删文件/标记失效在此收敛）。无轮询。引擎 `readApiKey('ondevice')` 走既有路径返回 null（单测实证），HTTP 客户端本就允许 apiKey: null，端侧分发不读它。
- **选择器零改造**：LocalModelSheet 直接读 config.providers，条目 models[] 只含就绪模型 ⇒「列出的即可用」成立；其行标按 providerId 解析，'ondevice' 落 'custom' 通用字形（不造假品牌徽标）。每线程 modelRef 同理零改造。

## 三、vendor 终局裁决（O3 遗留一）：不加 'ondevice'，三处声明收敛为一处

**裁决：`LocalVendorKey` 不加 `'ondevice'`。** 理由：

1. 该枚举在全部声明处与消费点的语义是**「官方预置厂商」**：它键控三份全量 Record 字典——`PROVIDER_PRESETS`（每条 = 官方端点 + 密钥占位 + 官网 + 推荐模型，渲染为向导「快速接入预置」卡片）、`VENDOR_LOGOS_DATA`（官方品牌矢量徽标）、`PRESET_DESCRIPTIONS`。端侧条目无端点、无密钥、无品牌、无预置，且用户口径明确「条目由代码构造，不进供应商向导预置」。
2. 强行加入只有两条路，都不可接受：(a) 给 PROVIDER_PRESETS 造一条空端点预置——会作为可选厂商漏进向导，是明令禁止的假入口/假条目；(b) 把三份 Record 改 Partial 打穿完备性契约——为零功能收益拆掉 6+ 消费点（列表 VM 描述字典、详情/向导 VM、详情视图、徽标字典）的穷尽性检查（O3 实测一加即撑破 6 处）。
3. 功能上零需求：`LocalProviderSpec.vendor` 本就是可选字段；O3 路由只认 protocol；列表特殊行与管理视图不消费 vendor；LocalModelSheet 按 providerId 字符串回退 'custom' 通用字形，诚实且足够。

**双轨收敛（终局，不再顺延）**：实查声明共有**三处**（比 O3 报告所记多一处）——`domain/types/localChat.ts`、`adapters/localChat/providerPresets.ts`、`presentation/components/localChat/ui/vendorLogosData.ts`。现统一为**领域声明唯一真源**：后两处本地声明已删，改 `import type { LocalVendorKey } from '@/domain/types/localChat'`；全部导入面同步收敛（localChatClient、useProviderWizardVm 原从 providerPresets 引、VendorLogo/LocalModelSheet/ModelSheet 原从 vendorLogosData 引，现一律引领域声明）；vendorLogosData 中无人消费的 `KnownVendorKey` 别名一并删除；领域声明处注释写明语义边界与本裁决。回归守卫单测钉死：`PROVIDER_PRESETS` 键集恰为七个厂商、`isLocalVendorKey('ondevice') === false`。裁决与边界已写入三处文件头注释，后人改枚举先过此处。

- 附带观察（不在本批范围，仅登记）：providerPresets.ts 还平行重声明了 LocalThinkingSpec / LocalModalitiesSpec / LocalPricingSpec 与扩展版 LocalModelSpec（带 tags）——与本次 LocalVendorKey 是同类模式但属另一议题，本批未动，留收口裁决。

## 四、标题调用点（O3 遗留二）：已补填

`localChatEngine.ts` 的 `maybeGenerateAiTitle` 组装 `completeChatCompletion` 时补 `providerId: sel.providerId` 一行（sel 为线程自己的解析选择）。分发客户端据此把端侧线程的标题调用路由到端侧客户端，不再误走 HTTP（baseUrl 为空必然失败、静默回退截断标题）。新单测（真引擎 + 真 store + 假端侧客户端 + 计数型 HTTP 假传输）实证：标题调用入参 providerId='ondevice'、标题以 ai 来源落盘、HTTP 流与 jsonFetch 零触碰。O3 报告第八节待验清单第 1 条的标题缺口就此关闭（代码面；真机面仍归 O5）。

## 五、管理视图与列表接线

- **管理视图** `OnDeviceModelsView` + 路由 `app/settings-local-ondevice.tsx`：形态沿用语音设置页 ASR 下载门（Screen + 浮动 AppHeader + 分组卡 + ListRow + 删除确认 Dialog），不另起设计语言。五条目录逐条成块：状态行（名 + 副行「体积 · 许可（· 推荐）」+ 尾状态文案）、许可警示独立成行（仅 3B，warning 色，文案直引目录 `license.warning` 原文）、动作行按状态出现——未下载→「下载」、失败可重试→「重新下载」（副行呈失败原因）、已就绪→「删除」（destructive，Dialog 确认，文案含释放体积）；下载中副行呈管理器 progressText（已下/总量/百分比），无动作行。底部「存储」组呈总占用（管理器 usageBytes 合计，含 .part）。无复述布局的旁白文案；承载真实信息的（许可警示、体积、失败原因）保留。
- **VM** `useOnDeviceModelsVm`：状态源只有管理器——挂载 checkAll + 占用统计 + 同步回写；download 走 `ensureReady(id, onState)` 流式回状态、落定 ready 后同步；removeModel 走 `remove` 后重查 + 同步。行投影为纯函数 `onDeviceRowOf` / `onDeviceStatusText`（与 ASR 管理面 modelStatusLabel 同口径），单测钉死五态映射、进度/原因透传、警示仅 3B、推荐仅 1.5B。busy 按模型粒度防重复触发。
- **列表置顶特殊行**：ProvidersListView 首个分组「本机模型」——无密钥点、无延迟丸、无启停开关（那是直连供应商的语义），副行如实呈「N 个可用模型 / 尚未下载模型」，点按去管理面；活动 Hero 若为端侧条目，点按同路改道而非供应商详情。VM 侧 rows 已排除端侧条目（计数「X 个服务」只计直连供应商），onDeviceRow 单独投影，activeProvider 在 rows 与 onDeviceRow 两处找。
- **详情守卫（连带一处，预防性）**：`settings-local-provider-detail` 路由对 id=ondevice 直接渲染管理视图——端侧条目没有可编辑的端点/密钥字段，任何深链落到 HTTP 详情表单都是假编辑面，在此单点改道。

## 六、验证证据（orange 主体，自建计划任务通道 MuseO4Run，已注销）

- `tsc --noEmit -p tsconfig.json`（整 crish-mobile 工程）：**TSC_EXIT=0，零错误**。
- jest 定向 **16 套件 / 200 例全绿（JEST_EXIT=0）**：`src/adapters/onDevice`（O2 管理器 + O3 客户端 + 本批同步新套件）、`useOnDeviceModelsVm.test`（新）、`src/adapters/localChat`（含新标题套件）、`useLocalConversationEngine(.queueAttachments)`、`persistBootstrap.test`、`localChatProtocol.test`、`localChatStore.test`、`localChatSessionStore.test`、`LocalChatHubRow.test`、`LocalProviderEditView.test`（vendor 消费面回归）。全量套件留收口批。
- 本批新套件覆盖：条目构造不变量（无三假字段/默认推荐档/上下文真值）、同步六况（不造空条目、出现、幂等不重写、删活动回退、全删清空、校验失效收敛）、vendor 边界守卫、管理面状态映射五态 + 透传、标题 providerId 透传 + ai 落盘 + HTTP 零触碰。

## 七、真机待验清单（待 O5，验收机 MDX0220527044325 本批期间不在 adb 列表）

1. 下载 → 选择器出现：管理面下载 1.5B 至 ready → LocalModelSheet 出现该模型、设置列表特殊行计数变 1；
2. 新线程选用：本地模式选本机模型新线程 → 发送/流式/停止/续聊（与 O3 待验第 1 条合并）；
3. 删除 → 选择器消失且回退不悬空：删当前活动模型 → 选择器该模型消失、活动选择回退推荐档或清空、引用该模型的线程回退跟随全局不报错；
4. 标题实机：端侧线程首轮后标题由端侧模型生成（非截断）；
5. 与 O2/O3 待验合并：双源各拉通、杀进程续传、sha 篡改被拒、1.5B↔3B 切换 context 释放、Qwen3 思考关闭。

## 八、登记项

1. providerPresets 的 LocalThinkingSpec / LocalModalitiesSpec / LocalPricingSpec / 扩展 LocalModelSpec 平行声明未动（见第三节附带观察），留收口裁决。
2. 同步的真值源是管理器 check() 的廉价核对（尺寸 + 标记，不做全量哈希）——与 O2/O3 全链同一口径；文件内容被等尺寸篡改的极端情形要到推理加载时才暴露，届时 O3 客户端以 unknown 错误如实收尾。
3. 列表 VM 挂载同步与管理 VM 挂载同步各一份触发，收敛逻辑只在 syncOnDeviceProvider 一处（幂等、无变化不回写），不构成双轨。
4. LocalModelSheet 中端侧模型行与云端模型行同列呈现（仅模型名）是既有形态，本批未改版式；如需按供应商分组呈现，属新设计议题。
