# tasks/ · 任务书索引与派发契约

> **用途**：本目录是**派发用任务书**（可直接作为子 Agent 的唯一指令来源），目的单一——**避免子 Agent 漂移**。
> **上游**：`../00-总方案-Token消费面统一与分裂收敛.md`（问题清单与拓扑）· `../01-分维-防御脚本断言阶梯.md`（门禁规格）· `../02/03-分维-*.md`（分维详案）· `../04-纪律-执行拓扑与Agent派发契约.md`（派发纪律）
> **使用方式**：派发时给子 Agent「本目录 README + 对应批次文件中的**单个单元小节**」，并明确「只执行该小节」。

---

## 一、批次文件索引

| 文件 | 单元 | 批次主题 |
|---|---|---|
| `B1-冻结与清零.md` | T1 · T2 · T3 · T4 · T5 | 地基：哨兵冻结 + 红项清零 + 兜底/裸色首批清退 |
| `B2-分类与真源.md` | T6 · T7 · T8 · T9 | A/B 分类 → 运行时真源唯一化 → 族归位 → 孤岛登记 |
| `B3-消费面与层叠.md` | T10 · T11 | 几何刻度迁移 · 层叠生效修复与样式假象整治 |
| `B4-存储与跨层.md` | T12 · T13 | 存储双轨清退 + 负向断言 · 跨层契约 1:1 |
| `B5-收尾.md` | T14 · T15 | 门禁阶梯接线 · 全链路物证采集 |
| `B6-设置界面清零与密度档复活.md` | T16–T24 | 设置域消费面物理清零 · 密度档复活 · 幽灵属性裁决 · 门禁棘轮（上游 `../05-分维-设置界面消费面清零与密度档复活.md`） |

批次依赖见 `../00-总方案` §四。**未满足前置依赖的单元不得开工。**

---

## 二、通用派发契约（每个单元都适用，子 Agent 必读）

1. **模型**：继承主 Agent 当前模型（不指定 `model`）。
2. **执行环境**：统一 **pwsh7**；写文件 **UTF-8 无 BOM**（CSS 加 BOM 会被 `check-css-encoding.mjs` 拦下）。
3. **提交权**：子 Agent **不得** `git commit` / `reset --hard` / `checkout .` / `restore`。改动留在工作区由主 Agent 收口。
4. **文件域**：只改任务书列出的文件。越界即拒收。发现必须改的域外文件 → **上报**，不得自行扩大。
5. **写前必做**：`git status --porcelain -- <你的文件域>` —— **若待改文件已被他人修改（出现 ` M`），立即停止并上报**，不得覆盖他人改动。本仓库有并行会话在改同一批文件。
6. **完成自查**（缺一不可）：① 范围自查（`git status` ⊆ 文件域）② 验收断言逐条跑并附**原始输出** ③ **负向用例**证明新增门禁会 FAIL ④ 删除类改动必须有「已不存在」断言 ⑤ 反补丁自查（无魔术数字/临时兼容/注释保留旧实现）⑥ 未提升任何基线 ⑦ 未用 `--no-verify`。
7. **禁止**：`--no-verify` · 抬高棘轮基线 · 注释保留旧实现 · 永久兼容 Shim · 自行新增 token 档位（必须登记请示）。

---

## 三、写路径互斥矩阵

| 单元 | 独占文件域 | 共享（需串行） |
|---|---|---|
| T1 | `scripts/check-token-ssot.mjs`（新建）· `scripts/token-registry.json`（新建）· `docs/token-consumption-unification/基线记录/`（新建） | — |
| T2 | `styles/z-index.css` · `ui/Tooltip/Tooltip.module.css` · `chat-message-list/ChatMessageList.module.css` · `chat-message-list/ChatScrollFloorSlot.module.css` | **`styles/tokens.css`** |
| T3 | 全部 `*.module.css`（排除 T2 四个 + `styles/`） | — |
| T4 | `chat-message-row/ChatMessageRow.module.css` · `chat-composer/ChatComposer.module.css` | — |
| T5 | `api/localStorageApi.ts` · `api/themeStore.ts` · `store/minimalConfig.ts` · `api/settings/settingsAccess.ts`（实际路径见现状对账） | — |
| T6 | `scripts/token-registry.json` · `scripts/check-token-ssot.mjs` | **`styles/tokens.css`** |
| T7 | `api/themePersonalization.ts` · `api/oklchColorGuard.ts` · `api/fontStore.ts` · `api/codeBlockIndent.ts` · `services/visualThemeController.ts` · `app/AppBootstrap.ts` · `main.tsx` | **`styles/tokens.css`** |
| T8 | `styles/markdown-typography.css` · `ui/Button` · `ui/Dialog` · `ui/Tabs` · `ui/SegmentedControl` · `diff/DiffCard` · `workspace/PreviewCard` · `sidebar/SidebarNav` · 5 个 dialog 文件 | **`styles/tokens.css`** |
| T9 | 11 个孤岛组件 `*.module.css` | `scripts/token-registry.json` |
| T10 | 热点榜 10 文件（与 T4 重叠者串行） | — |
| T11 | `styles/tokens.css`（选择器） · `styles/layout-contract.test.ts` | **`styles/tokens.css`** |
| T12 | `api/localStorageApi.ts` · `api/themeStore.ts` · `api/fontStore.ts` · `api/clientApiSettings.ts` · `store/` · `api/settings/`（与 T5 重叠者串行） | — |
| T13 | `apps/agent-workbench/src-tauri/src/**` · `api/transport/command-contract-drift.test.ts` | — |
| T14 | `scripts/` · `package.json` · `.husky/` · `.github/workflows/` | — |
| T15 | 只读 + 测试代码 | — |

**`tokens.css` 串行序**：`T2 → T6 → T7 → T8 → T11`。

---

## 四、现状对账（**2026-09-11 实测，派发前必读**）

> 本节记录「哪些单元已完成、哪些域已被并行会话占用」，防止子 Agent 重做或撞域。

### 4.1 已完成 / 已验证

| 单元 | 状态 | 证据 |
|---|---|---|
| **T4** | ✅ **完成并经主 Agent 独立核实** | `ChatComposer.module.css` 的 `hex/rgb/hsl` 归零、`color-mix`×27、无 BOM、花括号平衡；`ChatMessageRow.module.css` 余 15 处裸 hex 与登记的 ②13+③2 吻合；`audits/03-待裁决扩档需求.md` 已建 |
| **T2（主体）** | ✅ **核心验收已达成** | `node scripts/check-token-consistency.mjs` → **PASS 0/0/0**（`undefined_refs` / `nofallback_refs` / `dead_tokens` 全为 0）；4 个 `--shell-*` 死 token 与 `--z-pinned-bar` 已删；`Tooltip.module.css` 的 `--bg-surface-active` 已清零；`--chat-stream-pad-x` 已定义（`tokens.css:347` 与 `:699`） |
| **T2（残项）** | ⚠️ **未完成，需收尾** | 两处消费点**仍带裸兜底**：`ChatMessageList.module.css:38` 与 `ChatScrollFloorSlot.module.css:20` 仍是 `var(--chat-stream-pad-x, 20px)` → 应改为裸 `var()`；**且需核对取值正确性**：当前定义为 `var(--space-5, 20px)`，须确认 `--space-5` 的实际值与 SSOT 常量 `CHAT_SCROLL_PAD_X` 一致（若 `--space-5` ≠ 20px，则该定义是**错值**，须修正） |

### 4.2 未开工

| 单元 | 状态 | 说明 |
|---|---|---|
| **T1** | ❌ 未产出 | `scripts/check-token-ssot.mjs`、`scripts/token-registry.json`、`基线记录/` 均不存在 |
| **T3** | ❌ 未做 | 实测：裸 fallback **2,424** 处（宽口径）、**58 个** token 仍存在 ≥2 种矛盾兜底变体 |
| **T5** | ✅ **已执行**（但未跑测试验证） | 负向测试 `api/__tests__/legacy-storage-negative.test.ts` 已建，文件头自述「T5 存储幽灵读与零调用桩物理清退」；`migrateLegacyKeys`/`disposeSolarTimer`/4 个幽灵读 key 均已清零。**待办：跑一次该测试确认通过** |
| T6–T15 | ❌ 未开工 | — |

### 4.3 ⚠️ 并行会话占用告警（**撞域风险最高的事项**）

工作区存在**另一个进行中的 "preferences SSOT" 战役**，正在重构与 T5/T7/T12 完全相同的文件。已出现的**未跟踪新文件**：

```
apps/agent-workbench/src-tauri/src/preferences_commands.rs      (Rust 命令)
crates/conex-db/src/preferences.rs                              (DB 层)
apps/crish-desktop/src/api/preferences/{index,preferencesClient,preferencesSchema}.ts
apps/crish-desktop/src/api/preferences/__tests__/preferencesClient.test.ts
apps/crish-desktop/src/api/cache/runtimeCache.ts
apps/crish-desktop/src/hooks/usePreferencesHydration.ts
apps/crish-desktop/src/services/TokenRuntimeController.ts        ← 与 T7 目标重叠
apps/crish-desktop/src/api/__tests__/legacy-storage-negative.test.ts  ← T5 产出
```

已处于**修改中**（` M`）且与本战役重叠的文件（**非穷尽**）：`api/themeStore.ts` · `api/themePersonalization.ts` · `api/fontStore.ts` · `api/oklchColorGuard.ts` · `api/localStorageApi.ts` · `api/themePresets.ts` · `store/minimalConfig.ts` · `services/visualThemeController.ts` · `utils/storageKeys.ts` · `styles/tokens.css` · `styles/z-index.css` · `styles/design-system.css` · `scripts/check-token-consistency.mjs` · `scripts/check-color-ssot.mjs` · `apps/agent-workbench/src-tauri/src/main.rs` · `.../command_manifest.rs` · `api/transport/command-contract-drift.test.ts` · 以及 **30+ 个 `*.module.css`**。

**派发约束（强制）**：
1. **T7 / T12 / T13 暂缓派发** —— 其文件域正被并行会话占用，贸然开工必然互相覆盖。
2. **T3 / T10 派发时必须自我限制**：开工前先 `git status --porcelain -- <候选文件>`，**跳过任何已处于 ` M` 的文件**，只处理干净文件，并在汇报中列出「因他方占用而跳过的文件」。
3. **T1 可安全派发**（只新建文件，不触碰既有脚本）；但 **禁止修改 `scripts/check-token-consistency.mjs` / `check-color-ssot.mjs`**（他方正改），新门禁必须**独立成文件**。
4. 任何单元发现「待改文件已被他人修改」→ **立即停止并上报**，不得覆盖。

### 4.4 工具环境备注（子 Agent 必读）

- 本机 **Bash 工具环境损坏**（`dirname`/`ls`/`grep` not found）→ **只用 pwsh**。
- **PowerShell 工具的 stdout 常不被捕获**（exit 0 但无输出）→ 脚本 `Out-File` 到 `$env:TEMP` 再 Read。**不要写临时文件到仓库根**（根目录有大量他人文件，严禁用通配符批量删）。
- node：`C:\Users\orange\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`。
- **`.git` 曾于 2026-09-11 损坏并被主 Agent 增量重建**（`HEAD`/`config`/`index` 曾被删）。现已恢复正常：`HEAD=refactor/architecture@f854cf5e`，4 个分支找回。若 git 报 `not a git repository`，**停止操作并上报**，不要尝试自行"修"。
- **核查改动一律直接读文件**，不要只依赖 git diff（仓库无 remote，且历史上出现过 `git diff A B` 静默退化为 `--no-index` 互 diff 的假统计）。

---

## 五、验收总则（所有单元）

1. **不得以「模块内自测绿灯 / typecheck 无报错 / 文档声明完成」作为交付依据**（`00` §七）。
2. 每条新增门禁必须有**负向用例**证明其会 FAIL（防「门禁恒绿」）。
3. 所有删除类改动必须有**负向断言**（`not.toContain` / 零引用检索）。
4. **棘轮基线只降不升**；`--update` 须在提交信息中说明理由。
5. **测试资产只扩展、不删除**（`AGENTS.md` §9）。

---

## 六、B6 执行现状对账（2026-09-12 主 Agent 收口实测）

| 单元 | 状态 | 证据 |
|---|---|---|
| T16 密度档复活 | ✅ | `App.tsx` 已传 `uiSize`/`shellChromeMode`；单测 4/4 绿；Playwright 物证浅色三档 `--space-1` = 4/4/**6px** 互不相同（`apps/crish-desktop/scripts/qa/f5-density-proof.json`，目录被 .gitignore 忽略，物证需另行收集） |
| T17 外壳清零 | ✅ | 3 文件裸兜底=0；`SettingsPanel:310` 一致兜底一并删除 |
| T18 共享UI清零 | ✅ | Button/Input/Menu/SelectContent/Tooltip 兜底=0；禁用透明度 0.45→0.5、下拉 z 100→300（预期变更） |
| T19 models CSS 清零 | ✅ | 裸兜底/矛盾=0；几何 162→15（余为豁免+注释授权）；类名集合 diff 为空 |
| T20 账户外观清零 | ✅ | 6 CSS 兜底=0；`999px`→`--radius-full`；sr-only 复用；`--z-dropdown-menu` 删兜底（z-index.css:34 有定义） |
| T21 组2 清零 | ✅ | 12 CSS 兜底=0（主 Agent 机械清零收口） |
| T22 扩展域清零 | ✅ | 3 CSS + SkillCardList sr-only；`SettingsExtensionsTab.module.css` 因并行 ` M` 跳过（余 6 处兜底待其收口后清） |
| T23 门禁棘轮 | ✅ | `check-token-fallback-drift.mjs`（基线 29/3，修复了 `--update` 写回 undefined 的 bug）+ `check-inline-style-hardcode.mjs`（基线 38）；两门禁均有负向用例（注入→FAIL，还原→PASS）；**未接 package.json/husky（归 B5/T14）** |
| T24 models 内联归一 | ✅ **2026-09-12 22:4x 主 Agent 亲自完成** | 502 中断的落盘为**破坏性半成品**（TSX className 引用与新建 CSS 类全面脱节、9 个 UI CSS 被大块截断）→ 主 Agent 已恢复 16 文件至 HEAD 并删除 6 个半成品 CSS；内联硬编码 **38→2**（余 2 处为 SVG strokeWidth 数据层与状态驱动三元，属豁免类）；同时与并行会话在 ModelsSettingsTab.module.css 上合流（其迁移 ProfileHeader/ModelThinkingEditor 并补 box-sizing，主 Agent 完成其余 5 文件 + CSS 收敛：删同文件重复定义 .mrdHead 等双定义、.modelsDetail/.mrdBody 对齐实际生效值、新增 .mrdPinnedHeader/.mrdActionBar/.mrdModelListScroll/.mrdRowMiniBtn/.mrdLatencyBadge[data-latency]/.cascadeRowLabel/.mrlItemDot 状态类等）；7 文件 esbuild 语法全过、类引用双向完整、内联 sr-only 第三处（SettingsSidebar）改用全局类 |
| T25 幽灵属性 | ✅ | 6 处 `data-density="compact"` 物理切除；AppBootstrap 写入点保留（测试消费）；`shellChrome` 设置项幽灵契约上报待裁决；`FontSelectField.tsx:184` 待 T24 波次串行 |
| T26 主题分支方案 | ✅ | `audits/06-主题分支下沉收编方案.md`；结论：无需新增档位（6 处由现有 token 派生，`--recording-bg` 等未达 ≥2 门槛） |

**消费面指标迁移**（44 文件口径，`check-token-fallback-drift` 实测）：裸兜底 **430 → 29**（余 6 处在并行占用文件 +承重默认）· 矛盾兜底 **54 → 3**（余 3 处 `--dialog-width` 跨文件承重，F2 待裁决）。

**事故记录**：子 Agent 网络中断（429/502）导致的**未汇报落盘**中，round-3「UI 补漏」与「T24」两个 agent 产出为**破坏性半成品**（正则式兜底删除在嵌套 `color-mix` 上下文丢失前缀/多出右括号；T24 类引用脱节）——已由主 Agent 逐文件验证并恢复。**教训已写入 `css-token-consumption-audit` skill 关键陷阱节。**


### 六.1 二次收口（2026-09-12 22:4x）

- **T24 完成**（见上表）。内联基线 38 → **2**；兜底基线 29 → **24**（门禁实测拦截到并行会话新引入的 7 处兜底漂移并已清除——门禁防御价值首次兑现）。
- 扩档登记追加：`150px` 搜索框宽 3 处同语义（audits/03 §七同族追加）。
- 全量门禁 6/6 PASS。改动仍未提交（工作区与并行会话混合），收口提交待用户裁决。
