# 第二轮修复 · 卫生与门禁升级维度 · 修复方案（60-repair2）

> 产出：方案设计子 Agent（只读 + 本文档产出，无代码改动）。
> 输入：`50-reverify/01-signoff-verification.md`（§3.1 四文件 mojibake 残留 + §3.3 check-css-encoding 盲区坐实）、`50-reverify/02-convergence-thoroughness.md`（R15 未登记混色变量 / R16 菜单圆角残余）、`50-reverify/03-regression-check.md`（P3 清单）、`scripts/check-css-encoding.mjs`（门禁现状实读）、`20-proposals/01-convergence-completion.md`（同轮 A 块 .ui-btn 删除方案，D 节联动）。
> 性质：卫生收尾 + 门禁补盲（让「mojibake 清零」可机器验证）；只读实证，全部行号与计数经 2026-08-10 工作区实读复核。
> 验收前置：本文档自身即任务书；执行时以 `rg`/`python` 实测为准（口径见 §附）。
> 修订日志 v2（2026-08-10，吸收评审 `30-reviews/02-technical-correctness.md`）：
> 1. **白名单时序修正**：`--whitelist-dirty-check` 与 01 方案 A 块删除的时序缺口——01 A 块（批次 R2-2）物理删除会命中白名单挂账行号（settings-base :1193-1210 / settings-plugins :986-1005 / theme-dark :126-134 等），删除提交若不同步清理白名单则 dirty-check 立即红。**处置：删除 + 白名单清理 + 基线调整同一提交原子化**（评审 C-P1-2 / R-4，§2.3/§2.4/§4.3 已落地）；
> 2. **基线收口口径**：style-contract 基线（66→62 / 633→628）改在**批次 R2-2 提交内原子化**收口（主控裁决 P0-3，覆盖 master plan C-3 旧口径「R2-3 收口」；评审 C-P1-1——style-contract.test.ts 三方争夺 01×03×04，01+03 同提交、04 W2 紧随）；
> 3. `--whitelist-dirty-check` 的 CI 启用时点后置到 R2-2 白名单清理落地后（§2.4）。

---

## 0. 结论速览

| 块 | 复审判定 | 本轮动作 | 规模（实读） | 分步 |
|---|---|---|---|---|
| A | §3.1 四文件 25 行 mojibake 残留（实读修正为 **26 行**，补 :356） | 人工重写 + 门禁转绿 | 4 文件 26 行（workspace 15 / dragdrop 6 / panels 3 / polish 2） | 2 步 |
| B | §3.3 门禁盲区坐实：只查 FFFD/BOM，检测不到乱码固化 | 三层检测升级（PUA / GBK 逆变换 / 特征字表）+ 接线 package.json + CI | 1 脚本重写 + 2 处接线 | 1 步 |
| C | R15 未登记 / R16 圆角 / 03 文档 P3 清单 | 登记或收敛（P3 粒度） | R15 15 变量 / R16 4 处 / P3×6 项逐条裁决 | 2 步 |
| D | 01 方案 A 块声称「无需同步门禁」——**实读不实** | style-contract 基线同步下调（**批次 R2-2 同提交原子化**，主控裁决 P0-3，v2 修正收口时点） | !important 633→628、999px 66→62 | 随 A 块提交 |

**一句话**：先建三层 mojibake 门禁（检测出 26 行残留）→ 人工重写四文件 → 门禁转绿；顺带修正 01 方案「门禁无需同步」的错误结论（删死 CSS 后基线必须下调锁定成果），P3 零星逐条裁决。

---

## 1. A 块：四文件 mojibake 补扫与修复（26 行）

### 1.1 定位清单（2026-08-10 实读，与 01 文档的差异已标注）

**扫描方法**：Python 三层扫描（PUA 区 U+E000–U+F8FF / GBK 逆变换 / 特征字表）实跑全仓。**01 文档列 25 行，实测 26 行**——`shell-workspace.css:356`（濠婃艾濮╅崠鐚寸窗 → 恢复「滚动区：tabs-bar ws-chrome-scroll」）为 01 文档漏登（无 PUA、特征字不在 01 所用清单内，仅 GBK 逆变换可检出——正是盲区证据）。

| 文件 | 行数 | 行号（实读） | 与 01 文档差异 |
|---|---|---|---|
| `styles/shell/shell-workspace.css` | 15 | 90 / 191 / 317 / **356** / 379 / 442 / 622 / 668 / 1131 / 1144 / 1145 / 1146 / 1160 / 1161 / 1182 | 01 列 14 行，漏 :356 |
| `styles/panels.css` | 3 | 1 / 217 / 231 | 一致 |
| `styles/shell/shell-polish.css` | 2 | 626 / 811 | 一致 |
| `styles/shell/shell-dragdrop.css` | 6 | 38 / 40 / 58 / 69 / 88 / 96 | 一致 |

**特征构成**（决定修复方式，三层分类按 §2.2 口径）：
- **PUA 字符行**（U+E000–U+F8FF，GBK 单字节区被解码器映射成 PUA 的固化痕迹）：workspace 12 行、panels 2 行、polish 2 行、dragdrop 2 行（88/96）——共 18 行；
- **GBK 逆变换可恢复行**（`line.encode('gbk') → decode('utf-8')` 成功）：workspace:356（→「滚动区：tabs-bar ws-chrome-scroll」）——共 1 行；
- **仅特征字命中行**（无 PUA、逆变换失败——字符含无法 GBK 编码的残片，靠层 3 特征字表检出）：workspace:317/622、panels:1、dragdrop:38（鈹€ 盒线）/40/58/69——共 7 行。

### 1.2 修复方式：人工重写为主、特征还原为辅

- **主方式：人工重写**（01 文档 B 类口径；skill 护栏：不依赖终端显示、不用 shell 重写中文、apply_patch/edit 直改、改后回读校验）。26 行均为注释，语义可通过上下文（相邻选择器/声明）还原，例如：
  - workspace:379「閳ユ柡鈧妞ょ數顒烽敍姘session tab card-tab」→ 按 :370-380 上下文重写为「会话窗口 session tab card-tab」；
  - dragdrop:88「椤舵爮浼氳瘽鏍囩鎷栨嫿…」→ 按规则体（.tab 拖拽 reorder + ghost 不拦截）重写为「顶部栏会话标签拖拽：保持 tab 可命中（reorder），ghost 永不拦截 pointer」；
  - polish:626「Sidebar density…--space-*…--row-height」→ 重写为「侧栏密度：--space-* / --row-height」；
  - polish:811「focus-visible…--focus-ring / --focus-ring-strong」→ 重写为「focus-visible 用 --focus-ring / --focus-ring-strong」。
- **辅方式：GBK 逆变换恢复串作提示**（不自动写回——恢复串可能残留 PUA，如 WorkspaceChromeBars:218 恢复串仍含 \ue0c4；仅人工参考）。批量恢复脚本**禁止自动覆盖**，只能输出候选供人工确认。
- **判据**：重写后注释为可读中文、语义与相邻规则一致；文件仍 UTF-8 无 BOM（edit 工具天然保证）；回读校验无新增乱码。

### 1.3 分步

**A-1 步（门禁先建，见 §2 B-1 步）后，A-2 步（4 文件重写，1 提交）**：按上表 26 行逐一重写；每文件重写后立即跑 §2 新门禁确认该文件零命中。shell-workspace.css:1144/1145/1146 与 1160/1161 两处几乎重复（background/border 声明行内注释）——两处语义相同，重写保持一致。

### 1.4 验证 / 判据

| 验证 | 方式 |
|---|---|
| 清零判据 | 升级后门禁对 4 文件零命中（PUA 层 + 逆变换层 + 特征字层全绿）；`python` 三层扫描 4 文件 = 0 行 |
| 不引入新乱码 | `node scripts/check-css-encoding.mjs`（升级版）+ skill 的 `check_chinese_text.py` 双跑无告警 |
| 语义抽查 | 重写行与相邻选择器语义核对（人工签字表，26 行逐行） |
| 回归 | `npm run typecheck` + `npx vitest run src/styles/style-contract.test.ts`（23/23）+ 快层单元测试 |

**完成判据**：四文件 26 行全部人工重写；新门禁四文件零命中；style-contract 基线按 §4 同步后全绿。

---

## 2. B 块：check-css-encoding.mjs 门禁升级（三层检测）

### 2.1 现状与盲区（实读确认）

`scripts/check-css-encoding.mjs`（54 行）三项检查：① 严格 UTF-8 解码（A 类真 GBK 字节）② BOM ③ U+FFFD。**对「合法 UTF-8 的 mojibake 固化」完全无效**——已实测：26 行目标乱码全仓通过现有门禁（零 FFFD、零 BOM、可解码）。

**附加发现（新发现 N2）**：该脚本**未接线**——`package.json` 无 `check:css-encoding` script、`ci.yml` 快层 lint job 无对应 step（rg 实测零命中）。「门禁入库」仅是脚本文件存在，从未生效。升级必须同步接线，否则仍是纸面门禁。

### 2.2 三层检测设计

**层 1：PUA 区扫描（U+E000–U+F8FF）——强特征，全仓强制零豁免**

- 规则：任一行含字面 PUA 字符即违规（`/\p{Co}/u` 或 `[\uE000-\uF8FF]`）。
- 依据：全仓 31 个文件、约 228 行 mojibake 命中此特征（其中 4 目标文件外约 210 行挂账）；**干净文件零命中**（tokens.css / ui 组件 / 全部 tsx 实跑验证）。PUA 在源码注释/字符串中无合法用途；CSS `content: "\e001"` 是 ASCII 转义序列，不会被误扫。
- 豁免：**不允许**（PUA 是字节损坏铁证）。

**层 2：GBK 逆变换检测——强特征，全仓强制零豁免**

- 规则：对含 CJK 的行执行 `line.encode('gbk') → decode('utf-8', errors='strict')`，成功且恢复串含 ≥2 个 CJK 字符 → 违规。
- 依据：GBK 字节几乎不可能构成合法 UTF-8 序列，合法中文行逆变换必然抛错；全仓实测仅 9 个文件 13 行命中（全部为 mojibake 文件），干净文件零命中。恢复串（如 :356→「滚动区」）同时作为人工重写提示输出。
- 豁免：**不允许**。

**层 3：特征字表扫描——弱特征，带行级白名单**

- 特征字表（实跑统计所得）：`閳ユ柡鈧姘顒烽敍妞ょ數鐎鏂鍙鍘鍦鎻鎷鎸鍗鍐鍑鍔鈥鈧锛?濠婃艾濮╅崠鐚寸窗鈹€` + 片假名段 `\u30a0-\u30ff`（用户提供的「閳ユ柡鈧姘」在表内）。
- 规则：行内命中 ≥2 个特征字，或 1 个特征字 + 上下文佐证（同行含 `?` 替换痕迹 / 连续 3+ 罕见字）→ 违规。
- 误报控制：单特征字且无佐证不报（如片假名可能出现在合法日语注释中——本项目暂无日语面，白名单兜底即可）；**行级白名单**（`scripts/css-encoding-whitelist.json`）登记例外（文件相对路径 + 行号 + 理由），仅层 3 支持白名单。
- 豁免：行级白名单（理由必须写明，如「合法日语术语」）。

### 2.3 白名单机制与挂账衔接

- 白名单文件：`scripts/css-encoding-whitelist.json`，格式 `{ "文件相对路径": { "行号": "理由" } }`；脚本启动时加载，白名单行在层 3 命中时报 warning 不报 error（`--strict` 下也 error）。
- **与挂账衔接**：01/02 文档登记的「清单外 ~100 处」挂账（settings-base 57 行 / settings-models 43 / settings-plugins 21 / chat-markdown 17 / settings-advanced 9 / chat-approval 4 / settings-extensions 2 / settings-usage 4 / shell-menus 4 / shell-sidebar 2 等，实测约 163 行 + module.css 族 ~66 行 + terminalStore 15 行，合计约 244 行）**绝大部分命中层 1/层 2**（PUA 行占约 210）——层 1/2 零豁免则全仓立即红。**处理口径**：挂账面按文件整体登记（每文件白名单行号 = 当前全部命中行，理由「挂账，见 50-reverify 01 §3.2 / 后续卫生轮次」），本轮只清零 4 文件；**新增行不被白名单覆盖**（行号精确匹配），挂账文件新增乱码仍报 error。
- 白名单维护：`node scripts/check-css-encoding.mjs --init-whitelist` 生成当前命中快照；修复后手工删除已修复行号；CI 加 `--whitelist-dirty-check`（白名单中存在「文件当前已不命中」的行号 → 报错要求清理，防白名单膨胀）。
- **时序联动（v2 新增，评审 C-P1-2 / R-4）**：01 方案 A 块（批次 R2-2）的物理删除面与白名单挂账行号**直接重叠**——settings-base.css:1193（mojibake 注释行，位于删除段 :1194-1210 前邻）/1194-1210、settings-plugins.css:986-1005 段、theme-dark.css:126-134、settings-switch 段（:552/723/2362-2416）等均在挂账白名单内。**时序缺口**：R2-1 门禁先建并生成快照 → R2-2 删除 → 白名单出现「已不命中」行号 → `--whitelist-dirty-check` 立即红。**处置：01 A 块删除提交与白名单清理同一提交**（删除面行号同步从 whitelist.json 摘除），`--whitelist-dirty-check` 方可持续为绿；CI step 启用时点见 §2.4。

### 2.4 接线（新发现 N2 的修复）

| 位置 | 改动 |
|---|---|
| `package.json` scripts | `"check:css-encoding": "node scripts/check-css-encoding.mjs --whitelist-dirty-check"` |
| `ci.yml` 快层 lint job | `- run: npm run check:css-encoding`（插在 `check:swallowed-errors-frontend` 之后）；**`--whitelist-dirty-check` 生效时点（v2 修正）**：R2-1 接线时可先以不带 dirty-check 的形态入库（白名单挂账面随时会因 R2-2 删除而脏）；R2-2 白名单清理落地后启用含 dirty-check 的完整形态（或 R2-1 即含 flag、R2-2 删除与清理严格同提交——两条路径二选一，派单时锁定） |
| `scripts/check-css-encoding.mjs` | 保留既有三项检查（A 类/BOM/FFFD）+ 层 1/2/3；退出码非 0 = 违规；输出带文件:行号 + 层号 + 恢复提示（层 2） |

### 2.5 验证 / 判据

| 验证 | 方式 |
|---|---|
| 检测有效性 | 升级后立即扫出 4 文件 26 行（层 1:18 + 层 2:若干 + 层 3 兜底）；修复后 4 文件零命中 |
| 零误报 | 全仓运行：命中集 ⊆ 已知 mojibake 文件集（实测 25 文件）；干净文件（tokens.css/ui/tsx 抽样）零命中 |
| 门禁拦截 | 白名单外的任一新乱码行 → exit 1；挂账文件新增行 → exit 1 |
| 接线生效 | `npm run check:css-encoding` 直接可跑；CI 快层含该 step（ci.yml 实读） |

**完成判据**：三层检测全绿 = 4 文件零命中 + 挂账白名单行全部命中且有理由；`--whitelist-dirty-check` 无脏行；package.json + ci.yml 接线实读确认。

---

## 3. C 块：P3 零星卫生清单（逐条裁决）

### 3.1 R15：settings-models.css 域内混色变量未登记（02 文档 R15）

**实读**：`styles/settings/settings-models.css` 15 个域内变量（`:1012-1015` `--models-border 7% / --models-border-soft 4% / --models-fill 3.5% / --models-fill-max 7%`、`:1320-1324` 同组 + `--models-off-track 5% / --models-off-border 11%`、`:1428` off-track 8%、`:1465-1467` `--settings-border 11% / --settings-border-soft 8% / --settings-fill 3.5%`、`:1602-1603` border/soft 重复定义）。消费面：`var(--models-*)` 仅 settings-models.css 域内自消费（rg 实测：非该文件零命中），`var(--settings-content-max)` 被 7+ 文件消费（布局 token，合法，不属混色面）。

**裁决：登记，不收敛**。理由：① 这些是**域内自洽 token 定义行**（DEF_LINE 口径，style-contract ② 不计数定义行），非裸混色消费点——不违反 tint 收敛纪律；② 3.5%/4%/5%/7%/8%/11% 非标准档若收敛到 8 档（4/8/12/10/12/18/25/28）会产生**视觉漂移**（settings 域观感），P3 粒度不值得动；③ 02 文档 R15 口径为「未登记」而非「违规」——补登记即闭环。

**动作**：
- 在 `style-contract.test.ts` ② 段注释（:160-165 例外登记区）追加一行：settings-models.css 域内 `--models-*/--settings-border*` 15 变量为登记例外（理由：域内自洽 token，DEF_LINE 定义行，非消费点）；
- 可选：settings-models.css 头部加一段注释说明域内 tint 档位表（3.5~11%），标注「域内自洽、禁消费点裸混色」。

**验证/判据**：`rg "var\(--models-|var\(--settings-border" --glob "*.css"` 命中仅 settings-models.css；style-contract ② 计数仍 = 3（≤ 基线 3）；视觉零变化。

### 3.2 R16：菜单硬编码圆角残余（02 文档 R16，4 处）

| 位置（实读） | 现状 | 裁决 |
|---|---|---|
| `components/chat-composer/ComposePlusMenu.module.css:111` | `.slim .item { border-radius: 7px }` | **token 化**：`var(--radius-sm)`（tokens.css 有 --radius-sm，先核对值等价；不等价则登记保留） |
| `components/settings/SettingsQuickMenu.module.css:80` | `.ui-segment-item { border-radius: 999px }` | **保留**：999px = pill 语义正确值，且属 RADIUS_999 基线（66）内，非新增；若改 token 需 `--radius-pill` 新档，不值得 |
| `components/chat-composer/TiptapSlashMenu.module.css:38` | `::-webkit-scrollbar-thumb { border-radius: 2px }` | **保留**：scrollbar 拇指 2px 与全局 scrollbar 契约（shell-scrollbar.css:32-47）同口径；该块计入 SCROLLBAR_BASELINE 31 |
| `components/chat-composer/PermissionModeMenu.module.css:47` | `.permPillDot { border-radius: 50% }` | **保留**：6px 圆点 50% 是圆形语义，非圆角档位；改 50% 会失真 |

**裁决汇总**：仅 ComposePlusMenu:111 一处动（token 化），其余 3 处登记保留。02 文档 R16 口径「零星，可接受」——本轮收 1 处 + 登记 3 处。

### 3.3 03 文档 P3 清单逐条裁决

| # | 项（03 文档） | 实读确认 | 裁决 |
|---|---|---|---|
| P3-1 | skillsApi.ts 5 处 `Function('return import(...)')`（:214/226/598/616 + importFsHost.ts:53） | 实读命中 | **登记 + 可选修复**：改静态 import 是真修复（涉及动态插件面，改动面大），本轮登记；若做，验证 prod CSP 下无 EvalError |
| P3-2 | --text-tertiary 加深观感扁平 | 03 文档登记 | **视觉轮次确认**（无代码动作） |
| P3-3 | store/README.md 过期（sessionActions 拆分、D2 真源、日期 2026-07） | 实读：`store/README.md:44-61` 未列拆分文件 | **文档同步**（低风险，1 提交） |
| P3-4 | StatusDiagnosticsPanel.tsx:163「DEAD: rustCoreStore」过时注释 | 实读命中 | **清理注释**（1 行，随 P3 提交） |
| P3-5 | Tooltip focus 触发常驻行为 | 03 文档登记 | **视觉轮次确认** |
| P3-6 | .ui-btn 死 CSS（shell-polish:18-84 等） | 01 方案 A 块已覆盖 | **随 01 方案 A 块执行**（本方案 §4 联动） |

### 3.4 分步

**C-1 步（登记面，1 提交）**：R15 登记（style-contract 注释 + settings-models.css 头注释）+ R16 登记（3 处保留在方案文档签字）+ P3-2/P3-5 视觉轮次登记。
**C-2 步（改动面，1 提交）**：ComposePlusMenu:111 token 化 + P3-3 store/README 同步 + P3-4 注释清理。

### 3.5 验证 / 判据

- `npx vitest run src/styles/style-contract.test.ts` 23/23（R15 登记后计数不变）；
- `rg "border-radius:\s*7px" components/chat-composer` 零命中（ComposePlusMenu:111 已 token 化）；
- store/README 更新后 `rg "sessionActions|connectionStatus" store/README.md` 命中；StatusDiagnosticsPanel 无 DEAD 注释；
- 行为变更登记：R16 仅圆角值等值替换（token 化等价核对）；P3-3/P3-4 纯文档/注释。

---

## 4. D 块：门禁联动（01 方案 A 块删除后的 style-contract 基线）

### 4.1 01 方案结论修正（新发现 N3）

01 方案 A 块 §1.1 声称「style-contract.test.ts 无引用（已确认）→ 无需同步门禁」。**实读不成立**：.ui-btn / settings-switch 死 CSS 删除会**降低**两项 ratchet 计数，基线必须同步下调才能锁定成果（style-contract 哲学 = 单调递减 ratchet，01 文档 §4 自述「基线 ratchet 只拦新增」——不下调基线 = 未来可回填 4 个 999px + 5 个 !important 而不红，成果流失）。

### 4.2 基线变化实测（逐处清点）

| 待删块（01 方案 A 块） | 999px 变化 | !important 变化 |
|---|---|---|
| shell-polish.css:18-86 `.ui-btn` 体系 12 条 | **-3**（:36 .ui-btn-sm / :58 .ui-btn-secondary / :73 .ui-btn-ghost 各 999px） | 0 |
| DiffCard.module.css:368-378（applyActions/applyBtn） | 0 | 0 |
| settings-base.css:555-557（sched-settings-row .ui-btn） | 0 | 0 |
| settings-base.css:816-819（settings-security-icon-btn.ui-btn） | 0 | 0 |
| settings-base.css:1198-1210（settings-preset-chip 族） | 0 | 0 |
| settings-plugins.css:986-991（ui-btn/ui-btn-sm/models-btn 三选择器删，保留 settings-btn-rect） | 0 | **0**（:990 的 1 个 !important 随保留块留存） |
| settings-plugins.css:993-997（models-btn:not(.ghost) 两条） | 0 | **-2**（:995/:996） |
| settings-plugins.css:998-1005（ui-btn-ghost + hover） | 0 | **-3**（:999/:1003/:1004） |
| settings-advanced.css:472-474（ui-btn.danger:hover） | 0 | 0 |
| settings-base.css:2362-2416（settings-switch 主块）+ theme-dark.css:126-134 + settings-base:552/723 + settings-plugins:715 | **-1**（:2369） | 0 |

**合计**：`RADIUS_999_BASELINE 66 → 62`；`IMPORTANT_BASELINE 633 → 628`；`BARE_MIX_BASELINE 3` 不变（删除面无裸混色）；`SCROLLBAR_BASELINE 31` 不变；⑧ `.card-tab.active` 断言不变。

### 4.3 联动动作

| 项 | 动作 |
|---|---|
| `style-contract.test.ts:188` | `RADIUS_999_BASELINE = 66` → `62`（注释注明：随 01 A 块删 .ui-btn -3 + settings-switch -1） |
| `style-contract.test.ts:233` | `IMPORTANT_BASELINE = 633` → `628`（注释注明：随 01 A 块删 settings-plugins 死规则 -5） |
| 提交时机 | **与 01 方案 A 块同一提交**（批次 R2-2 内原子化，主控裁决 P0-3，v2 修正——**删除 + 基线 62/628 + 白名单清理三件事同一提交**，覆盖 master plan C-3 旧口径「R2-3 收口」；评审 C-P1-1：style-contract.test.ts 三方争夺 01 A 块 × 03 D 块 × 04 W2，01+03 严格串行原子化后 04 W2 紧随）。否则中间态 CI 绿但基线虚高（未来可回填 4 个 999px + 5 个 !important 不红，成果流失）；严禁 A 块先删、基线后调的两提交拆分 |
| 防回填 | 01 方案 A 块完成后跑一次全量 vitest + `rg "999px"` 计数复核，确认 62/628 与实际吻合 |

**验证/判据**：A 块删除后 `rg -o "border-radius:\s*999(?!\d)"` 全仓计数 = 62；`rg -o "!important"` = 628；style-contract 23/23 绿；01 方案 A 块判据（rg .ui-btn 仅注释命中）维持。

---

## 5. 执行顺序（仅逻辑顺序，建议调度排列）

| 序 | 步 | 文件面 | 验证 | 判据 |
|---|---|---|---|---|
| 1 | **B-1 门禁先建**：check-css-encoding.mjs 三层升级 + `--init-whitelist` 生成挂账白名单 + package.json/ci.yml 接线 | 1 脚本 + 2 配置 | 全仓跑：4 文件 26 行红、挂账白名单全命中 | 三层检测实跑输出与 §1.1 清单一致 |
| 2 | **A-2 修复**：四文件 26 行人工重写（每文件完立即跑门禁） | 4 css | 门禁四文件零命中 + 语义签字表 | 26/26 清零、无新增 |
| 3 | **D 联动（随 R2-2 批执行，v2 修正不单独成步）**：style-contract 基线 66→62 / 633→628 + 白名单清理（§2.3）——**与 01 方案 A 块删除同一提交**（批次 R2-2 内原子化，主控裁决 P0-3）；本方案提供口径与验证，执行点归属 01 A 块提交 | style-contract.test.ts + scripts/css-encoding-whitelist.json | style-contract 23/23 + 计数复核 | 62/628 实读吻合；dirty-check 无脏行 |
| 4 | **C-1 登记**：R15 登记、R16 3 处保留登记、P3-2/P3-5 视觉轮次登记 | style-contract.test.ts 注释 + 本方案签字 | style-contract 计数不变 | 23/23 绿 |
| 5 | **C-2 改动**：ComposePlusMenu:111 token 化 + store/README 同步 + P3-4 注释清理 | 3 文件 | typecheck + 快层测试 | 全绿、零行为变更 |
| 6 | **收尾**：全量验证批 | — | `npm run typecheck` + 快层 unit + style-contract + `check:css-encoding` + `check:ui-layer` | 全部绿 |

**顺序理由**：门禁先建（红）→ 修复（绿）的闭环优先级高于 P3 零星；D 联动与 01 方案 A 块强耦合——**同一提交原子化（批次 R2-2，主控裁决 P0-3，v2 修正）**：删除 + 基线 + 白名单清理三件事不得拆提交、不得提前改基线（否则中间态基线虚高或 dirty-check 红）；C 块独立可并行（文档/注释面），但避免与 01 A 块同文件（style-contract.test.ts 由 D 独占）。

---

## 6. 新发现清单（本方案实读补充，均带证据）

| # | 发现 | 证据 | 建议 |
|---|---|---|---|
| N1 | shell-workspace.css:356 乱码为 01 文档漏登（26 行 vs 25 行） | PUA 层不命中，仅 GBK 逆变换检出「滚动区：tabs-bar ws-chrome-scroll」 | 并入 A 块修复清单（已在 §1.1） |
| N2 | check-css-encoding.mjs **未接线**（package.json / ci.yml 零命中）——「门禁入库」从未生效 | `rg "css-encoding" package.json ci.yml` 零命中 | §2.4 接线（本方案 B 块核心） |
| N3 | 01 方案 A 块「无需同步门禁」不实：删死 CSS 改变 999px/!important 计数 | shell-polish:36/58/73、settings-base:2369、settings-plugins:995-1004 逐行实读 | §4 基线同步（62/628） |
| N4 | **`.models-btn` 家族全仓 tsx 零消费**（settings-models.css 24 行 + settings-plugins.css 615/622/680/697 + 688-697 等）——01 方案 A7 声称「models-btn 仍 14 处 tsx 消费」与实读不符（14 处是 settings-btn-rect，models-btn 实为 0） | `rg "models-btn" --glob "*.tsx"` 零命中；`settings-btn-rect` 3 文件消费 | 01 A7 拆行时**多删** `.settings-pane .models-btn` 选择器（§4.2 已按此口径计算）；settings-models.css 内 models-btn 家族可作为后续卫生轮次死代码清理项（可选） |
| N5 | `--models-*`/`--settings-border*` 变量**仅 settings-models.css 域内自消费**（非该文件零命中） | `rg "var\(--models-"` 全仓 | R15 登记口径以此为准（§3.1）——不存在跨文件消费，收敛风险最低 |
| N6 | 挂账 mojibake 实际规模大于 01 文档「~100 处」：全仓三层扫描命中 **31 文件 ~244 行**（settings-* 族 ~163 + module.css 族 ~66 + terminalStore 15 + chat 族 21 + shell 族其余 ~25，不含 4 目标文件 26 行） | Python 全仓三层扫描 | 白名单快照生成即真实挂账清单；terminalStore.ts 15 行含 10 行 PUA（.ts 文件！），建议后续轮优先（注释在 .ts 内、语义可逆） |
| N7 | terminalStore.ts 为**唯一中招的 .ts 文件**（15 行：A 层 10 行 PUA + B 层 1 行可逆 + C 层 4 行特征字，分布 :2-50 头注释与 JSDoc） | 实读 `store/terminalStore.ts:2-50`；B 层恢复串「活动会话镜像」 | 本轮白名单登记；后续卫生轮次第 1 优先（GBK 逆变换可恢复大半语义） |

---

## 7. 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | 层 2（GBK 逆变换）误报：合法中文行偶然逆变换成功 | 门禁误红、挫伤可信度 | 实测零命中（全仓 9 文件 13 行全部为 mojibake）；要求恢复串 CJK ≥2；白名单兜底 |
| 2 | 层 3 特征字表误报（片假名 / 罕见字合法出现） | 误红 | 白名单行级登记 + 上下文佐证条件（≥2 特征字） |
| 3 | 白名单膨胀：挂账行号快照陈旧 → 白名单掩盖新增；**R2-2 删除面使白名单出现「已不命中」行号（v2 补）** | 门禁失效 / dirty-check 立即红 | `--whitelist-dirty-check`（CI 强制）：白名单存在「已不命中」行号即 exit 1；**删除面行号与 01 A 块删除同提交清理（§2.3 时序联动）** |
| 4 | 人工重写语义偏差（注释语义不可恢复处） | 注释误导 | 签字表逐行核对；可恢复语义的行用层 2 恢复串做参考 |
| 5 | 与 01 方案 A 块同文件并发（shell-polish.css / style-contract.test.ts / css-encoding-whitelist.json，v2 补） | 编辑冲突 | D 块与 01 A 块同提交原子化（批次 R2-2，主控裁决 P0-3）；白名单清理并入同一提交（§2.3）；C 块避开 A 块文件面 |
| 6 | 批量恢复脚本自动写回导致二次损坏 | 数据损失 | **禁止自动写回**（恢复串仅提示）；修复一律人工 edit |
| 7 | 挂账文件（settings-* 等 ~200 行）本不动，用户视角乱码仍可见 | 观感残留 | 与 01 文档挂账口径一致（如实登记，非本轮承诺）；白名单清单即后续轮次路线图 |

---

## 附：复核口径与不确定性

- 计数口径：Python 三层扫描（PUA 正则 `[\uE000-\uF8FF]` / GBK 逆变换 `encode('gbk')+decode('utf-8',strict)` 且恢复串 CJK≥2 / 特征字表 ≥2 或 1+佐证）；`rg` 全仓补充验证；覆盖 `apps/crish-desktop/src` 全量 css/ts/tsx（排除 `*.test.*`）。
- 特征字表为实跑归纳，非穷举：GBK 误读产物字面量取决于原文组合，表外乱码可能漏检——但层 1（PUA）与层 2（逆变换）是结构性检测，覆盖绝大部分；表仅兜底。
- 行号基于 2026-08-10 工作区状态；执行前以最新 rg/python 实测为准（尤其 A 块重写后行号会漂移，验收判据用「特征命中=0」而非固定行号）。
- 白名单生成范围 = 全仓三层扫描命中（31 文件 ~244 行挂账） - 4 目标文件 26 行；01/02 文档登记的挂账面（~100 处口径）与本方案白名单快照（~244 行）的差异说明：01/02 为抽样登记，本方案为全量扫描——以快照为准并回写文档。

（本文档完——卫生与门禁升级维度方案：门禁先建三层检测 → 四文件 26 行清零 → 基线联动 62/628 → P3 逐条裁决）
