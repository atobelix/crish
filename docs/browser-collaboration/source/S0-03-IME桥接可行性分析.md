# S0-03 IME 桥接可行性分析（S0-C spike 报告）

- 日期：2026-08-09
- 角色：S0-C spike 验证 Agent（中文 IME 桥接可行性）
- 目的：对「帧流 + 输入转发」形态下的中文输入法（IME）方案做可行性分析，为 P1 G-3 判据提供前置实验设计
- 参照裁决：12 维度文档 §3.7（隐藏输入框桥接 + compositionend → `Input.insertText` 整串注入）；23 红队 RT-1（"全行业首个完整设计、零实测背书"，P0-3 升级为全方案最大单点风险）
- 方法：**受控 CDP 实测**（真实浏览器 + 真实 CDP WebSocket），11 项结论（9 实测 / 1 文档 / 1 推断）
- 环境：
  - Chrome **151.0.7922.72**（64-bit headed，`--remote-debugging-port=9334`，独立临时 profile）
  - Edge **147.0.3912.72**（Chromium 内核对照，`--remote-debugging-port=9335`，独立临时 profile）
  - Node v24.11.0（全局 WebSocket，零 npm 依赖）
  - 脚本与原始输出：`C:\Users\orange\AppData\Local\Temp\opencode\s0-ime\`（s0-ime-test.mjs / s0-ime-followup.mjs / edge-check.mjs / run-output*.txt，不入库）

---

## 0. 执行摘要（结论先行）

**可行性等级：有条件可行。** 方案最核心的 CDP 注入面——「整串中文经 `Input.insertText` 注入页面」——**全部关键行为实测通过**（中文/emoji 整串保真、尊重选区、isTrusted=true、事件干净、连发保序、contenteditable 可用、自动聚焦兜底）。**红队 RT-1 的"零实测背书"状态被本次打破**：此前唯一凭设计推断的 IME 主通道（insertText）已转为实测背书。残余风险全部集中于**面板层**（候选窗定位、聚焦共存、合成悬置），均为 P1 e2e 可测项，且每条都有兜底链。另有两项对既有设计有实质影响的实测新发现（见 §2 结论 C5/C9）。

| 判据前置项 | 结论 | 支撑 |
|---|---|---|
| insertText 整串注入中文 | **通过（实测）** | C2/C3/C4/C7/C8 |
| 229 键不会污染页面（不触发合成） | **通过（实测）** | C1 |
| imeSetComposition 可用性（否决项复核） | **可用（实测，保持否决作主通道）** | C9/C10 |
| Chrome/Edge 一致性 | **一致（实测）** | C9/C11 |
| 面板层候选窗/聚焦/悬置 | **未实测（P1 e2e）** | 推断，有兜底链 |

---

## 1. CDP 行为确认结论表（含证据等级）

证据等级：**[实测]**=本次实验亲自执行；**[实测-引用]**=S0-01 已实测（直接引用，不重测）；**[文档]**=协议 schema（`/json/protocol`）；**[推断]**=设计分析/文献知识，待 P1 e2e。

| # | 结论 | 证据等级 | 实测细节 |
|---|---|---|---|
| C1 | `dispatchKeyEvent` 注入 VK 229 **不触发页面 compositionstart**；页面仅收到普通 keydown：`keyCode=229, isComposing=false, isTrusted=true`；key=`"Process"`（显式给 key 时）/`""`（rawKeyDown 不给 key 时）；**无文本产生** | [实测] | EXP1/EXP1b：keyDown/rawKeyDown + keyUp 均无 composition 事件，value 不变。**否决了"229 键可模拟合成"的想象**；同时证明页面侧即使收到 229 也只是个无害的 Process 键 |
| C2 | `Input.insertText`（页面无合成上下文）= **纯文本插入**：触发 `beforeinput(inputType=insertText)` + `input`，均 `isTrusted=true`；**无 composition 事件、无 keydown/keypress、无 change** | [实测] | EXP2：`insertText("你好世界")` → value="你好世界"，事件仅 beforeinput+input 两条 |
| C3 | insertText **整串注入保真**：中文+emoji（surrogate pair）一次插入不拆对；光标落串尾 | [实测] | EXP3：`"你好🌍世界"` value 完整，selS=10（码点正确，🌍 占 2 个 UTF-16 单元未被切分） |
| C4 | insertText **尊重页面当前选区**（替换选中区，光标落在插入串尾） | [实测] | EXP4：value="abcde" 选区 2-4，insertText("XY") → "abXYe" |
| C5 | insertText **自动聚焦到页面「最后可编辑元素」**：即使页面焦点已 blur（activeEl=BODY）或被 button 占据，insertText 后焦点回到 input 且文本插入 input | [实测] | F1/F2：blur 后 insertText → activeEl 从 BODY 变回 "i"，value 追加。**对桥接是兜底性利好**：页面 input 聚焦假设即使被打破也能自动恢复；代价是「插入位置跟随页面焦点而非用户点击点」——页面脚本擅自改焦点时文本可能落错元素 |
| C6 | insertText **支持 contenteditable**（GitHub/飞书类编辑器形态） | [实测] | F3：contenteditable div 聚焦 + insertText("中文abc") → textContent="中文abc"，焦点保持 |
| C7 | change 事件语义正常：insertText 本身不触发 change；**失焦（blur）时 change 正常触发**（isTrusted=true） | [实测] | F2/F4：button 聚焦导致 input blur → change；insertText 后 blur → change，标准浏览器语义 |
| C8 | **连发 insertText 保序无丢失**（确认式输入/多候选上屏场景） | [实测] | EXP11：3 连发 → value 顺序完整 "一二三"，每发一对 beforeinput/input |
| C9 | **`Input.imeSetComposition` 在 Chrome 151 与 Edge 147 均可用**（命令执行成功，非报错）——触发 `compositionstart` → `compositionupdate` → `beforeinput(inputType=insertCompositionText)` → `input`，全部 isTrusted=true；合成文本**直接出现在 input.value 中**（isComposing=true 期间的 input 事件） | [实测] | EXP5/EXP6（Chrome）、edge-check（Edge）。**推翻了"experimental 命令大概率不可用"的假设**——12 文档否决它是因为「无候选引擎 SLA」，不是因为它调用失败；作为兜底增强（如强制结束悬置合成）它有实测支撑 |
| C10 | insertText **在页面存在活动合成时 = 提交合成**：compositionupdate → input(insertCompositionText) → **compositionend**；且该合成路径产出的 compositionend `isTrusted=false`（CDP 构造合成的已知事件细节差异） | [实测] | EXP6：imeSetComposition("nihao") 后 insertText("你好") → 合成文本被替换提交，compositionend 触发。桥接设计中页面无合成态（合成在面板层），走 C2 纯插入路径，不触发此 quirk；仅当采用 imeSetComposition 兜底时需知悉 |
| C11 | `insertText` 与 `imeSetComposition` 在协议 schema 中均标 **experimental**；Chrome 151 与 Edge 147 的 Input 域命令集合完全一致 | [文档] | `/json/protocol` 双浏览器核对。注：insertText 虽标 experimental 但为 DevTools 长期实装命令，S0-01 与本次均实测可用 |
| C12 | CDP Input 域注入事件 `isTrusted=true`；输入延迟 avg **0.49ms** / max 0.70ms（注入→页面事件送达） | [实测-引用] | S0-01 §2.2/§2.5，本报告不重测；IM E 桥的 insertText 与键盘同走 Input 域，延迟同量级 |
| I1 | 真实 OS IME（TSF 合成：微软拼音/搜狗/手写等）的完整事件序列 **CDP 不可模拟**——CDP 无 TSF 通道，合成只能经 imeSetComposition 人工构造且事件细节与真实 IME 有差异（C10）；故「OS IME 在面板层完成合成」是唯一能拿到真实合成体验的路径，**面板层全流程必须 P1 e2e 实测** | [推断] | 由 C1（CDP 不能触发合成）+ C10（人工构造有事件差异）推论；这是桥接设计的前提性约束而非缺陷 |

---

## 2. 隐藏输入框桥接风险清单

> 结论表（C1-C12）为以下逐项分析的事实基础。等级：高/中/低。

### R1 候选窗层差异（等级：中）
- **风险**：OS IME 候选窗浮在 Tauri webview（面板层）顶层，位置跟随隐藏输入框（设计：点击点下方 ~20px）；页面为 canvas 帧渲染——候选窗叠在"帧画面"之上，可能遮挡画面上待操作内容，且用户可能误判候选窗是页面内容。
- **分析**：候选窗属 OS 原生渲染，质量无压缩问题；遮挡行为与真实浏览器中"候选窗挡住页面"完全同构（用户已习惯）；候选窗渲染频率独立于帧流（8-20fps），视觉上候选窗"更跟手"是正常现象。真实风险仅是遮挡程度与位置跟随精度。
- **证据**：[推断]（涉及 Tauri webview 与 OS 输入法，CDP 不可测）；候选窗跟随隐藏输入框定位这一点（12 §3.7 假设）需 P1 验证。
- **处置**：P1 T8（候选窗位置/可见性/遮挡实测）；如遮挡关键内容，可将隐藏输入框定位改为点击点上方或面板边缘，或提供开关。不需架构改动。

### R2 聚焦共存（页面 input 保持聚焦时隐藏框如何工作）（等级：中，C5 显著降险）
- **风险**：双焦点模型——页面侧（Chromium）焦点由 CDP 注入点击自然维持（12 §3.6，isTrusted 点击驱动页面 focus）；面板侧（Tauri webview）焦点=隐藏输入框，OS IME 会话绑定面板侧焦点。两者在**不同渲染进程**，天然共存，无 DOM 级冲突。
- **分析**：
  - **利好（C5 实测）**：insertText 自动聚焦页面「最后可编辑元素」——页面焦点被意外改动时注入仍落到正确元素并恢复聚焦。桥接的"页面 input 保持聚焦"假设有 CDP 层兜底。
  - **残余风险 1**：insertText 落点是「页面当前焦点元素」而非「用户点击的元素」。页面脚本主动改焦点（登录表单校验失败 focus 错误提示等）→ 文本落错元素。处置：面板侧在 compositionend 前不干预；异常场景由 P1 T5 实测，必要时注入前补一次 CDP 点击目标元素（成本低）。
  - **残余风险 2**：Tauri 窗口失焦（用户 Alt+Tab 切走）→ 隐藏输入框 blur → OS IME 合成可能被取消（compositioncancel）。面板状态机需处理"合成期窗口失焦"（清缓冲/标记悬置），12 §3.7 未显式覆盖此场景。P1 T10 实测。
- **证据**：[实测]（C5）+ [推断]（面板层失焦行为）。
- **处置**：状态机补"blur 时合成期处理"分支；P1 T5/T10。

### R3 229 键副作用（等级：低，裁决已被实测支持）
- **风险**：合成键（keyCode 229 / key "Process"）是否污染页面。
- **分析**：C1 实测——CDP 注入 229 不触发页面合成，页面仅收普通 keydown（isComposing=false）。12 §3.7"合成期 keydown 一律不转发"的决策**正确且必要**：转发虽无害但无意义，且部分页面按 keydown 过滤可打印字符会误判 Process 键。面板层隐藏输入框收到的 229 来自真实 OS IME 合成（与 C1 的 CDP 构造场景不同），按 12 §3.7 状态机处理（composition 事件驱动，229 仅作兜底计数），逻辑位置正确。
- **证据**：[实测]（C1）+ [推断]（面板层真实 229 键流）。
- **处置**：无新动作；P1 T1/T4 断言页面无 Process 键事件。

### R4 中文标点 / 双拼 / 手写（等级：低-中）
- **风险**：特殊输入形态是否破坏"compositionend 整串注入"。
- **分析**：
  - 中文标点（"，。/、""）——在 OS IME 层随合成上屏，compositionend 整串包含标点，C2/C3 证明任意 Unicode 整串一次注入无特殊处理（P1 T6 验证"你好，世界"）。
  - 双拼——合成链路与全拼一致（OS 层完成），无 CDP 侧差异。
  - 手写——微软手写：手写面板/候选窗均在面板层（OS 提供，跟随隐藏输入框），上屏同样走 compositionend；P1 T9 实测。
  - 确认式输入（逐候选上屏，每字一次 compositionend）→ 多次 insertText，C8 已证 CDP 侧保序；面板状态机需保证多次合成期切换无泄漏（P1 T7）。
- **证据**：[实测]（C2/C3/C8）+ [推断]（OS 层行为）。
- **处置**：沿用 12 §3.7 兜底链（229 计数、Esc 空文本、悬置重置）；P1 T6/T7/T9。

### R5 Chrome/Edge 兼容差异（等级：低）
- **风险**：受管实例若为 Edge 内核（或用户切换内核），IME 桥是否一致。
- **分析**：C11 实测——Chrome 151 与 Edge 147 的 Input 域命令集合一致；C9/edge-check 实测——insertText 中文注入、imeSetComposition 合成构造行为一致（事件序列、isTrusted 均同）。Chromium 内核族无差异风险。
- **证据**：[实测]（C9/C11，双浏览器）。
- **处置**：P1 在目标受管内核上复测 T1/T3 核心流程一次即可；非 Chromium 内核（如未来接入 WebKit/Servo）需重测——当前架构（受管 Chromium）下不适用。

### R6 备选方案评估（基于实测的新增事实）
| 备选 | 评估 | 结论 |
|---|---|---|
| 组合期暂停帧渲染 | S0-01 实测「页面内容不变时帧率≈0」——合成期页面本就无变化（无新帧），暂停帧渲染**无增量收益**；若页面有 CSS 动画，暂停反而冻结画面误导用户 | **不采用**（无收益） |
| 组合期仅面板显示候选（= 本方案隐藏框桥接） | 合成与候选全在面板层；页面无内联候选预览为已知损失（12 §3.7 已列）。面板内内联预览浮层（compositionupdate 缓冲渲染）列为后续增强不变 | **本方案** |
| imeSetComposition 保持页面合成同步（12 否决项复核） | **新事实（C9/C10）**：命令在 Chrome/Edge 实测可用，能构造真实页面合成态。但：① 无候选引擎 SLA（否决理由不变）；② C10 实测其事件序列与真实 IME 有差异（compositionend isTrusted=false）——作为主通道语义不纯。**保留否决作主通道**；升级为"合成悬置兜底的增强选项"（对不发 compositionend 的 IME，可 imeSetComposition("") 强制结束页面合成态） | 否决作主通道；列为 P1 可选实验 |
| 一期禁用中文 IME（面板提示英文/粘贴） | 见 §4 降级兜底评估 | 最坏兜底，可接受（有条件） |

---

## 3. P1 G-3 实测方案（可执行步骤 + 断言 + 阈值）

> 前置：S4 面板最小骨架可用（FrameCanvas + InputLayer + 隐藏输入框 + Rust insertText 注入管线 + 受管 Chromium 实例）；测试机 Windows + 微软拼音为默认输入法。断言 1-3 为硬判据，任一失败 → G-3 不通过，触发 23 红队 §4.2 降级链第 3 条。

### T1 基础中文输入「你好世界」（硬项）
1. 步骤：面板导航到含文本框页面 → 点击文本框（隐藏输入框 focus，激活微软拼音）→ 键入 `nihao shijie` → 候选窗选择"你好 世界" → Enter 确认
2. 断言 1：面板隐藏输入框 compositionend 文本 == `你好世界`（无多余字符）
3. 断言 2：CDP `Runtime.evaluate` 读页面 `input.value == "你好世界"`
4. 断言 3：页面事件序列 = 仅 `beforeinput(insertText)+input` 各 1 条，isTrusted=true，**无 composition 事件、无 keydown(229/Process)**
5. 断言 4：候选窗消失后帧画面可见"你好世界"
6. 阈值：Enter 确认 → 页面 value 更新 ≤ 500ms（insertText 注入 + 帧刷新合计）

### T2 退格流程（硬项）
1. 步骤：value="你好世界" → 隐藏框内按 Backspace（拼音模式：退格删拼音字母）→ 确认上屏
2. 断言 1：合成期退格 → compositionend 文本符合预期（拼音退格仅改拼音，文本不变或截断，无错乱字符）
3. 断言 2：非合成期退格 → 页面收 CDP `keyDown(key=Backspace)`，value 正确回退一个字符
4. 阈值：退格后页面 value 与面板缓冲一致（无双缓冲偏差）

### T3 Esc 取消（硬项）
1. 步骤：开始拼音输入 → 候选窗出现 → Esc
2. 断言 1：面板 compositionend 文本为空（或收 compositioncancel）→ **不发起 insertText**（注入计数 == 0）
3. 断言 2：页面 value 零变化
4. 阈值：严格断言注入计数 0；随后直接输入英文（不经重新 focus）仍正常

### T4 混合输入（软项）
1. 步骤：中文确认后直接键入 `abc123`，再输入中文
2. 断言：页面 value == `你好abc123你好`；事件序列无 Process 键；英文走 §3.3 keyDown+text 通道
3. 阈值：value 精确匹配

### T5 合成中切换目标（软项）
1. 步骤：合成中输入一半 → 点击面板上页面另一文本框 → 继续输入确认
2. 断言：前一文本框合成被正确取消（缓冲清空）；insertText 落到新文本框（C5 自动聚焦兜底）
3. 阈值：两个文本框内容互不串扰

### T6 中文标点（硬项）
1. 步骤：输入 `nihao，shijie`（中文逗号随合成上屏）
2. 断言：compositionend 整串含 `，`；页面 value 完整
3. 阈值：value == `你好，世界`

### T7 连续确认式输入（硬项）
1. 步骤：连续 5 次逐候选上屏（空格/数字选字，不按 Enter）
2. 断言：5 次 insertText 按选字顺序落地（C8 CDP 侧已证，此处验证面板状态机多次合成期切换）
3. 阈值：value 顺序与选字顺序一致；无字符丢失/重复

### T8 候选窗位置（软项）
1. 步骤：点击面板中部文本框 → 激活 IME → 观察候选窗
2. 断言：候选窗出现在点击点下方 ~20px（隐藏输入框定位处）；不超出面板边界（超出 → 自动调整定位生效）
3. 阈值：候选窗水平偏移 ≤ 10px；可见率 100%

### T9 手写输入（软项）
1. 步骤：微软手写面板 → 手写"你好" → 上屏
2. 断言：compositionend 文本 == "你好"；页面 value 更新（同 T1 阈值）

### T10 窗口失焦中断（软项）
1. 步骤：合成中 Alt+Tab 切走再切回 → 继续输入
2. 断言：面板状态机退出合成期（缓冲清空/重建），无悬置残留；下一次 compositionend 不包含上一次残留
3. 阈值：无缓冲泄漏（R2 残余风险 2 的裁决点）

**通过/失败口径**：T1/T2/T3/T6/T7 为硬项（G-3 判据 = 硬项全过 + 软项 ≤1 项失败且经兜底链修复后复测通过）；软项失败不直接否决，进 12 §3.7 兜底链（229 计数/Esc 空文本/兼容矩阵补测）后复测。

---

## 4. 结论

### 4.1 可行性等级：**有条件可行**

- **条件满足面（实测背书）**：桥接的全部 CDP 侧关键行为通过——整串中文注入（C2）、emoji/surrogate 保真（C3）、选区语义（C4）、事件干净度与 isTrusted（C2）、连发保序（C8）、contenteditable（C6）、自动聚焦兜底（C5）、change 语义（C7）、Chrome/Edge 一致（C9/C11）。RT-1 所担心的"insertText 桥无实测背书"已解除——**该通道与 AI type 共用同一管线（12 §4.1）的判断同时获得背书**。
- **条件面（P1 e2e 实测）**：候选窗定位与遮挡（R1）、聚焦共存与窗口失焦（R2 残余 2）、真实 OS IME 合成序列（I1）——均为"面板层 e2e 可测"项，且有兜底链（T8/T10、12 §3.7），无原理性障碍。
- **否决项复核结论**：合成事件逐键转发（否决维持，C1 佐证）、imeSetComposition 作主通道（否决维持——C9/C10 证明其**可用**但事件语义不纯 + 无候选引擎 SLA；升级为悬置兜底增强选项）。

### 4.2 Top 3 风险

| # | 风险 | 等级 | 证据 | 兜底 |
|---|---|---|---|---|
| 1 | 候选窗定位与面板遮挡（R1） | 中 | [推断]，P1 T8 裁决 | 隐藏输入框定位策略调整（点击点上方/面板边缘）；候选窗遮挡属 OS 输入法正常行为，用户习惯成本低 |
| 2 | 聚焦共存：页面脚本改焦点落错元素 + Tauri 窗口失焦取消合成（R2） | 中 | C5 实测降险 + [推断] 残余 | C5 自动聚焦兜底；注入前补 CDP 点击；状态机补"合成期 blur"分支（P1 T5/T10） |
| 3 | 个别 IME 合成事件缺失（悬置） | 中 | [推断]（12 §3.7 既有） | 12 §3.7 兜底链（229 计数 + Esc 空文本 + 重置）；**新增可用选项**：imeSetComposition("") 强制结束页面合成态（C9/C10 实测可用） |

### 4.3 降级兜底评估

1. **12 §3.7 既有兜底链**（229 计数、Esc 空文本、兼容矩阵补测）——保留。
2. **新增兜底（本次实测产出）**：合成悬置时以 `Input.imeSetComposition("")` 强制结束页面合成态（C9/C10 证明命令可用）——可替代或增强"500ms 无更新重置"的被动兜底。
3. **最终兜底「一期禁用中文 IME、面板提示英文/粘贴」——可接受（有条件）**：
   - 实现成本≈布尔开关（23 红队修正 1：InputLayer 独立挂载，`interactive` 开关语义），不动输入管线；粘贴路径复用既有剪贴板 insertText 管线（12 §6.1 文本级路径）。
   - 接受度判断：产品面向中文用户，中文输入是核心体验，**不宜作为默认**；但当 G-3 硬项（T1/T2/T3/T6/T7）任一失败且兜底链全部失效时，该降级可保住其余全部能力（AI 协同、英文输入、粘贴），并以提示条明确告知。
   - **建议**：仅当 G-3 硬项失败时启用；启用后 P1 继续以任务单跟踪 IME 修复。

### 4.4 对既有文档的增量建议（供主控参考，不改动 12/23 原文）

1. 12 §3.7 补注：insertText 自动聚焦行为（C5）——"页面 input 保持聚焦"假设有 CDP 层兜底；面板状态机补"合成期窗口 blur"分支（R2 残余 2）。
2. 12 §3.7 兜底链升级：悬置重置可调 `Input.imeSetComposition("")`（C9/C10）。
3. 23 红队 RT-1 结论更新点：P0-3"零实测背书"已部分解除（CDP 注入面实测通过）；剩余未实测面（面板层）在 P1 以 G-3 判据裁决。

---

## 附：原始证据与复现

| 项 | 位置 |
|---|---|
| 实验脚本（主/补/Edge） | `C:\Users\orange\AppData\Local\Temp\opencode\s0-ime\s0-ime-test.mjs`、`s0-ime-followup.mjs`、`edge-check.mjs` |
| 原始输出（Chrome 10 实验） | `C:\Users\orange\AppData\Local\Temp\opencode\s0-ime\run-output.txt` |
| 原始输出（Chrome 补测 4 实验） | `C:\Users\orange\AppData\Local\Temp\opencode\s0-ime\run-output-followup.txt` |
| 原始输出（Edge 抽测） | `C:\Users\orange\AppData\Local\Temp\opencode\s0-ime\edge-output.txt` |
| 协议 schema | Chrome/Edge `GET /json/protocol` → Input 域（insertText/imeSetComposition 均 experimental） |
| 复现 | `node s0-ime-test.mjs`（需先启动 `chrome.exe --remote-debugging-port=9334 --user-data-dir=...\s0-ime\profile`） |

（唯一写文件：`S0-03-IME桥接可行性分析.md`；其余只读。全文 UTF-8 无 BOM。）
