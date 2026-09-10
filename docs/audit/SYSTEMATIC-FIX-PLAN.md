# Crish/conex 系统性修复方案（BATCH-08～27 审计闭环）

> 依据：`docs/audit/SUMMARY.md` + 三分报告 + `secondary-verification.md`（P0/P1 均已 `[x]` 确认）  
> 约束：杜绝硬编码、杜绝双轨/多轨逻辑、杜绝功能伪连通、杜绝「兼容层」残留、设计样式只走 Token SSOT  
> 本文**仅描述逻辑执行顺序**：步骤之间是依赖关系，所列问题同权，不含排期、分工或「先做谁后做谁」的重要性排序表述。

---

## 0. 目标态不变量（后续所有步骤必须服从）

在改任何调用方之前，先把下列不变量写成**可执行契约**（类型 + 运行时断言 + 门禁脚本），并删除一切与之冲突的并行实现。

### 0.1 路径与本地 I/O
- 一切本地文件读/写/asset URL **只允许**经统一解析器得到的「工作区内规范路径」；空路径、越界路径、未解析路径一律硬失败。
- 禁止「`convertFileSrc` 失败 → `workbench_run_shell` 拼命令读盘」作为产品路径；若保留调试通道，必须独立门闩且默认关闭，不得被拖放/附件/预览隐式调用。
- 拖放、斜杠附件、文件面板、Markdown 路径链接共用同一入口，**单一消费方**。

### 0.2 IPC / 命令契约
- 每个 Tauri/WS 命令的参数类型在前后端同源定义；禁止 `Value::Null` 冒充「空参数对象」。
- 错误必须可观测：禁止「恒 `ok: true`」或空 `onApproval*` 吞掉失败。
- 废除的 API 不得以 stub（恒 `null` / 恒 `''` / no-op）形式继续被调用。

### 0.3 渲染与内容安全
- Markdown/富文本：**先消毒再渲染**；禁止新增未消毒的 `dangerouslySetInnerHTML`。
- 产品纪律与渲染行为一致：若 AGENTS 禁 Emoji，则 GFM 短码翻译不得默认开启。
- 预览桥 `postMessage` 必须校验 `origin`，禁止 `targetOrigin: '*'` 作为唯一通道。

### 0.4 样式与 Token
- 字号/颜色/间距/字体栈只认设计 Token SSOT；删除双轨变量（例如同时存在的 `--md-h1-size` 与 `--md-heading-h1-size`）。
- 禁止在业务 CSS 中回潮裸 Hex / 魔法数字字号（门禁脚本扫全量相关面，不只扫单文件）。
- 正文/UI/代码字体通过 Token 引用，不在组件内硬编码系统字体栈分叉。

### 0.5 状态与持久化
- 会话/附件/进度条数据只从**可订阅 store** 读取；禁止 `getSessionById` 一次性快照冒充实时 UI。
- 附件与多模态载荷：落盘与上行 prompt 不得静默携带完整 `dataUrl` / 本机绝对路径（除非显式、可审计的用户授权模型）。
- 「应急草稿」必须有对称的写与读回生产路径；禁止只写不读的伪连通。

### 0.6 测试与防回潮
- 每个不变量对应至少一条自动化守卫（单元 / 契约 / `check:desktop` 链）。
- 文档铁律与代码门禁同步；禁止「长文已写、脚本未接」。

---

## 1. 建立统一基础原语（所有上层依赖此层）

### 1.1 路径沙箱原语（单一实现）
1. 收敛 `resolveWorkspacePath` / 相对根判定为唯一实现；删除 `useFileNavigation` 等处「`:` / `..` 启发式」并行判定。
2. 定义并导出：`assertWorkspacePath | ResolvedPath`（空串拒绝、越界拒绝）。
3. 将读、写、`toAssetUrl`、reveal、打开面板全部改为只接受 `ResolvedPath`。
4. 为该原语补齐：合法路径、空路径、越界、Windows/Unix 绝对路径误判用例。

### 1.2 本地读盘原语（拆除 shell 兜底产品路径）
1. 重写 `localFileReader.ts`：仅走平台文件 API / 受控 IPC；删除或隔离 `workbench_run_shell` + PowerShell/`base64`/`head` 拼路径读盘。
2. MIME/扩展名策略 SSOT（含是否允许 SVG 作图片附件）；禁止调用方各写一套后缀正则。
3. 单测覆盖：越界拒绝、空路径拒绝、大文件上限、失败不再回落 shell。

### 1.3 IPC 参数与错误原语
1. 为 `listPendingApprovals` 等命令定义显式空参类型（`{}` / `Option`），前后端同步；消灭 `Null` 反序列化恒 `CmdInvalid`。
2. 审计「打开路径 / 审批回调」等返回值：失败不得报 `ok: true`；前端禁止空实现审批 action 伪装可用。
3. 契约测试：空参、缺字段、超大 payload、错误码映射。

### 1.4 设计 Token 单一真相源
1. 盘点 `tokens.css` / `markdown-typography.css` 双轨标题与字体变量，合并为一条命名体系。
2. 业务样式改为只消费 SSOT 变量；删除旧轨与裸 Hex。
3. 将 markdown 合规脚本与 input-guard **全部挂入** `check:desktop`；扫描面扩到实际会回潮的目录，禁止只扫单文件的伪门禁。

---

## 2. 拆除伪连通与死接口（在调用方继续堆功能之前）

### 2.1 注入/派发 stub 清零
1. 删除 `dispatchWorkflowAssistantCard` / `dispatchSkillContextCard` / `dispatchGoalModeCard` / `dispatchGrillMeCard` / `dispatchAttachmentCards` 等恒空实现。
2. 同步删除或改写所有调用点（`slashSendPreflight`、定时任务面板、设置日程等），改为真实注入/状态横幅，或根本不调用。
3. 门禁：禁止再引入 `chat-injection` 路径与「dispatch* 返回空仍当成功」模式。

### 2.2 文档/脚本伪连通清零
1. 凡 BATCH 文档声称的铁律（禁注入回潮、RELAY_SECRET、禁 Emoji、Token SSOT），必须有对应脚本或测试接线；未接线则删掉「已落地」措辞或补上接线——二者择一，禁止文档假装完成。
2. 示例密钥统一改为明显假值，避免扫描噪音掩盖真泄漏。

---

## 3. 把基础原语接到所有入口（消灭多轨入口）

### 3.1 附件与拖放单一管道
1. 指定唯一消费方（例如仅 Composer 或仅 ChatCard 其一）处理：`tauri://drag-drop`、window `drop`、卡片 `onDrop`、Tiptap `handleDrop`。
2. 其余监听只转发到该管道或删除；附件入队以稳定 id 幂等。
3. 所有入队路径只调用 §1.2 读盘原语，禁止旁路。

### 3.2 文件面板 / 预览 / 路径链接
1. `readTextFile` / `writeTextFile` / `toAssetUrl` / `revealPath` / `openPathInFilesPanel` 全部经 §1.1。
2. JSON 格式化入口与真实解析能力对齐：去掉对 jsonc/jsonl 的假开通，或实现真解析——禁止按钮可点却必失败。
3. 大文件计行复用 `LineBuffer`，删除全量 `split('\n')` 回潮轨。

### 3.3 多模态上行与落盘
1. 视觉能力探测为 SSOT；非视觉模型路径只发送脱敏元数据（文件名/类型/大小），禁止写入完整 `dataUrl` 与本机绝对路径。
2. 会话持久化 schema：附件字段禁止默认存完整 `dataUrl`/绝对 `path`；需要时存工作区相对引用或内容哈希。
3. 批注保存改为不可变更新，禁止原地 mutate React state 对象。

---

## 4. 宿主桥接与预览通道收敛

### 4.1 Preview postMessage
1. 宿主 `subscribeToInspector` 校验 `event.origin`（白名单）。
2. 桥脚本 `postMessage` 使用明确 `targetOrigin`，删除 `'*'` 作为唯一目标。
3. 同源代理拉取策略与文档一致：明确允许集，禁止「缺 Origin 头即放行」的隐式宽松与正式策略并存。

### 4.2 Tauri 拖拽区与骨架屏
1. `data-tauri-drag-region` 只挂在非交互标题带；清理骨架屏 SVG 多层拖拽区吞点击。
2. 交互控件显式 `no-drag`，保证点击可达。

### 4.3 Workbench / 桌面打开路径
1. 修复「打开路径恒 ok」类契约谎言；与 §1.3 错误原语对齐。
2. 可执行后缀拦截保持单一列表 SSOT，前后端共用或生成。

---

## 5. 会话 UI 状态轨合并（列表 / 流式 / 进度）

### 5.1 虚拟列表测高
1. 对话虚拟列表与 Diff `VirtualPlainCodeViewer`：测高策略单一；禁止「首帧锁定永久 `isMeasuredRef`」与「字号/UI 缩放变化后仍用旧标量」并存。
2. 字号/Token 变更时统一使测高失效并重测；吸底逻辑与测高共用同一高度源，避免 offsetHeight/估算双轨打架。

### 5.2 流式进度与计划条
1. `ComposerPlanProgressBar` 等改为订阅 session store（或等价 observable），删除 `getSessionById` 快照轨。
2. 审批/重试/通知条只从注入的真实 props 工作；删除空实现 fallback 伪装可用（或改为显式不可用 UI，禁止静默 no-op）。

### 5.3 模块级无界集合
1. `WorkflowConfirmCard` 的确认签名 Set 按 session/workflow 分桶，会话销毁时清理；禁止进程级只增不减集合作为唯一防重机制。

---

## 6. 便签与草稿闭环（写必可读回）

1. 生产路径挂载/打开文档时调用已有的 `loadEmergencyDraftSync`（或等价恢复 API），与 `beforeunload` 写入对称。
2. `flushPendingDraft` 排空语义形式化（循环至队列空或显式失败可见），禁止「固定两轮 pass」的伪排空。
3. 块 ID 生成：桌面强制 crypto  entropic id；弱熵回落不得出现在生产构建。

---

## 7. 渲染纪律与 XSS 面收敛

1. `MarkdownDocumentView` 保持「上游消毒 + 单一渲染出口」；外链导航统一走 `sanitizeUrlCandidate`（大小写/协议一致），删除组件内另一套 `startsWith` 启发式轨。
2. Tiptap 粘贴：DOMPurify 配置显式禁止未知协议；补回归单测，防止配置回退。
3. GFM emoji 短码：默认关闭或与 AGENTS §21 对齐为同一开关；禁止「UI 禁 Emoji + 渲染器自动插入 Emoji」双轨。
4. 技能预览等设置页继续只走 `MarkdownDocumentView`，禁止回潮 `dangerouslySetInnerHTML`。

---

## 8. Rust / crates 与桌面边界对齐

1. `conex-relay`：保持无默认密钥；启动失败路径清晰；测试覆盖篡改拒绝。
2. `conex-markdown`：行为变更（HR、emoji、CJK wbr）与前端快照/CSS 同一决策，禁止前后端各执一词。
3. `conex-db` / 会话删除与清空：事务边界与前端「防僵尸复活」叙事一致，补契约测试。

---

## 9. 防回潮门禁一次性装上（否则前面修复会被下一批冲掉）

将下列检查全部挂入日常 `check:desktop`（或等价总闸），缺一则总闸失败：

1. 禁止 `chat-injection` 路径与 stub `dispatch*` 被调用。  
2. 禁止 `localFileReader` / 附件链路出现 `workbench_run_shell` 读盘。  
3. 禁止业务 CSS 裸 Hex / 双轨 markdown 标题 token。  
4. 禁止非视觉多模态路径拼接 `dataUrl` 或绝对盘符路径进 prompt。  
5. IPC 空参与错误码契约测试。  
6. preview postMessage 必须出现 origin 校验（静态扫描或单测）。  
7. 应急草稿：存在生产调用 `loadEmergencyDraftSync`（或标记的恢复 API）的引用扫描。

---

## 10. 验收与审计闭环（逻辑终点）

1. 对 §0 每条不变量做一次「证据复核」：路径、测试名、门禁脚本名写入 `docs/audit/FIX-ACCEPTANCE.md`。  
2. `code-audit` 按 `secondary-checklist.md` 对修复后的树再跑一轮，差异写入 `secondary-verification.md` 追加节。  
3. 仅当不变量、门禁、二次核查三者一致时，本修复方案视为逻辑闭合；否则回到对应章节补齐，禁止用兼容层或开关默认值假装闭合。

---

## 附录 A · 审计发现到步骤映射（便于核查，非优先级表）

| 审计项 | 落入步骤 |
|--------|----------|
| localFileReader shell 任意读 + 拖放放大 | §1.2 → §3.1 |
| write/toAssetUrl 空路径 | §1.1 |
| listPendingApprovals Null | §1.3 |
| 非视觉 dataUrl/路径进 prompt 与落盘 | §3.3 |
| 多路拖放双入队 | §3.1 |
| preview 缺 origin / `'*'` | §4.1 |
| dispatch* 空壳仍调用 | §2.1 |
| 应急草稿只写不读 | §6 |
| 计划条无订阅 | §5.2 |
| 虚拟列表测高永久锁定 | §5.1 |
| Token 双轨 / 门禁未接线 | §1.4 → §9 |
| GFM emoji vs 禁 Emoji | §7.3 |
| jsonc 假格式化 / split 回潮 | §3.2 |
| 骨架 drag-region 吞点击 | §4.2 |

## 附录 B · 明确禁止的「修复姿势」

- 用「兼容旧调用」保留 stub、双实现、feature flag 默认开旧轨。  
- 用硬编码路径/密钥/字号「先跑通再改」。  
- 只改调用方不改原语，或只改原语不改门禁。  
- 文档宣称完成但 `check:desktop` 未覆盖。  
- 为省事恢复 shell 读盘或 `postMessage('*')`。
