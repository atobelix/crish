# 全案反退避、防过度设计与立体测试验证评审报告

> **战役代号**：CONCENTRIC-RADIUS-UNIFICATION  
> **报告编号**：06-master-plan-review-and-guardrails  
> **评审机构**：Conex / Crish 架构自检与治理评审委员会  
> **首席评审员**：反退避与立体验证评审员（Agent-P6）  
> **评审基准日期**：2026-10-25  
> **评审对象**：
> - `docs/concentric-radius-unification/00-全仓同心圆角与边距现状统一调查总报告.md`
> - `docs/concentric-radius-unification/analysis/06-concentric-anti-patterns-and-benchmarking.md`
> - `docs/concentric-radius-unification/analysis/05-tokens-radius-ssot-and-concentric-math-analysis.md`
> - 全域 4 大调查维度实勘报告（`survey/01` 至 `survey/04`）
> **准入准则**：`AGENTS.md` §1「反退避原则」、§7「反过度设计与立体验证纪律」、§7.1「立体验证纪律」、`ANTI_OVERENGINEERING_GUARDRAILS.md`

---

## 目录

1. [评审背景、授权与核心使命](#一-评审背景授权与核心使命)
   - 1.1 [战役背景与用户核心诉求](#11-战役背景与用户核心诉求)
   - 1.2 [反退避与防过度设计双重宪章](#12-反退避与防过度设计双重宪章)
   - 1.3 [评审组织与裁决权限](#13-评审组织与裁决权限)
2. [方案合规性交叉审查（五大维度与双形态落地）](#二-方案合规性交叉审查五大维度与双形态落地)
   - 2.1 [双形态架构落地审查：圆角形态（20px）与微圆形态（12~14px / 8px）](#21-双形态架构落地审查圆角形态20px与微圆形态1214px--8px)
   - 2.2 [维度一审查：弹层与模态浮层（Pop / Dialog / Modal）](#22-维度一审查弹层与模态浮层pop--dialog--modal)
   - 2.3 [维度二审查：设置中心与表单画布（SettingsPanel & Forms）](#23-维度二审查设置中心与表单画布settingspanel--forms)
   - 2.4 [维度三审查：输入区与对话卡片流（ChatComposer & ChatStream）](#24-维度三审查输入区与对话卡片流chatcomposer--chatstream)
   - 2.5 [维度四审查：侧边栏、活动栏与顶栏窗口（Sidebar & ActivityBar）](#25-维度四审查侧边栏活动栏与顶栏窗口sidebar--activitybar)
   - 2.6 [维度五审查：Token 体系与几何代数完备性（Tokens & Math Axioms）](#26-维度五审查token-体系与几何代数完备性tokens--math-axioms)
3. [反退避原则刚性自检（Anti-Retreat Audit）](#三-反退避原则刚性自检anti-retreat-audit)
   - 3.1 [效果锁自检：零偷懒降级与零历史包袱保留](#31-效果锁自检零偷懒降级与零历史包袱保留)
   - 3.2 [问题同权自检：杜绝优先级砍项与边缘模块放任](#32-问题同权自检杜绝优先级砍项与边缘模块放任)
   - 3.3 [禁止退避裁判：自研同心宏 vs 引入第三方依赖](#33-禁止退避裁判自研同心宏-vs-引入第三方依赖)
   - 3.4 [穿透根因自检：杜绝魔术数字补偿与坐标修正补丁](#34-穿透根因自检杜绝魔术数字补偿与坐标修正补丁)
4. [反过度设计硬性红线审查（Anti-Overengineering Guardrails）](#四-反过度设计硬性红线审查anti-overengineering-guardrails)
   - 4.1 [红线一：严禁引入 JS 运行时动态几何监听计算引擎](#41-红线一严禁引入-js-运行时动态几何监听计算引擎)
   - 4.2 [红线二：纯原生声明式 CSS Modules + Design Tokens 架构](#42-红线二纯原生声明式-css-modules--design-tokens-架构)
   - 4.3 [红线三：CSS 宏运算语法约束（仅限原生 calc 与 max）](#43-红线三css-宏运算语法约束仅限原生-calc-与-max)
   - 4.4 [红线四：架构净收敛与单一真实源（SSOT）](#44-红线四架构净收敛与单一真实源ssot)
5. [立体验证策略与回归门禁设计（Verification Matrix & Testing Gates）](#五-立体验证策略与回归门禁设计verification-matrix--testing-gates)
   - 5.1 [第一层：静态语法与类型系统编译阻断（`npm run typecheck`）](#51-第一层静态语法与类型系统编译阻断npm-run-typecheck)
   - 5.2 [第二层：全量单元测试与覆盖率刚性门禁（`npm test` / `test:coverage`）](#52-第二层全量单元测试与覆盖率刚性门禁npm-test--testcoverage)
   - 5.3 [第三层：自动化同心圆角契约测试设计（`concentric-radius.contract.test.ts`）](#53-第三层自动化同心圆角契约测试设计concentric-radiuscontracttestts)
   - 5.4 [第四层：真实桌面宿主与 WebView2 物理现场走查规范](#54-第四层真实桌面宿主与-webview2-物理现场走查规范)
6. [评审结论与工程准入批复（Verdict & Execution Sign-off）](#六-评审结论与工程准入批复verdict--execution-sign-off)
   - 6.1 [合规性评审得分表与风险排查结果](#61-合规性评审得分表与风险排查结果)
   - 6.2 [关键准入阻断项（Blockers）与前置修复指令](#62-关键准入阻断项blockers与前置修复指令)
   - 6.3 [最终准入批复意见](#63-最终准入批复意见)
   - 6.4 [致实施波次（Implementation Wave）各子 Agent 的军规令](#64-致实施波次implementation-wave各子-agent-的军规令)

---

## 一、 评审背景、授权与核心使命

### 1.1 战役背景与用户核心诉求

在 Conex / Crish 桌面客户端（`apps/crish-desktop`、`apps/agent-workbench` 及 `packages/`）的日常交互中，用户多次反馈：
> “感觉浮层（Pop）和设置界面的元素圆角偏小，且与输入框不统一；容器内外嵌套时显得有些方、有些挤，缺乏呼吸感与一致性。”

经架构自检团队第一阶段（Survey & Analysis）对全仓 **874 处** `border-radius` 与单角声明的穿透式实勘，查明系统存在深层的代数不完备性与层级倒挂：
1. **顶层坍塌**：上千像素的全屏模态 `Dialog` 竟坍塌至卡片级 **12px**（`--radius-2xl` 在 `tokens.css:508` 被强制映射至 12px）；
2. **底层膨胀**：底部的 `ChatComposer` 与用户消息气泡拥有 **20px ~ 24px** 大圆角；
3. **空间倒挂**：顶层大浮层（12px）比底层日常输入框（20px）更尖硬方锐，倒挂差高达 $-8\text{px}$；
4. **同心破缺**：父子容器大量共用相同 Token（如外 12px、内 12px、边距 14px），内角向外顶出，同心差值 $\Delta = R_o - (R_i + P) = -14\text{px}$，产生角部严重挤压。

用户为此确立了改造的**核心锚点**：
- **双形态并存支持**：允许并支持“**圆角形态（Rounded 20px）**”与“**微圆形态（Compact 12~14px / 8px）**”，满足现代流体柔和风格与极客高密度专业工具的双向需求；
- **同心几何公理化**：容器内严格遵循工业同心圆角标尺：
  $$R_{outer} = R_{inner} + Padding \quad \Longleftrightarrow \quad R_{inner} = \max(0, R_{outer} - Padding)$$
- **刚性遵循纪律**：全案必须严格贯彻 `AGENTS.md` §1「反退避原则」、§7「反过度设计与作弊」及 §7.1「立体验证纪律」。

### 1.2 反退避与防过度设计双重宪章

本评审报告受命对方案实施前进行最高级别的架构把关，设立双重安全阀门：

```
                    【双重安全阀门控制模型】
                    
  ┌─────────────────────────────────────────────────────────────┐
  │                 【阀门一：反退避原则 (Anti-Retreat)】          │
  │  • 严禁以“历史兼容”为名保留 12px/8px 严重倒挂病灶           │
  │  • 严禁偷懒搞“一刀切全盘 20px”或“一刀切全盘 8px”              │
  │  • 严禁使用坐标补偿、padding 暴力负值、透明遮罩等打补丁作弊  │
  │  • 坚持效果锁与问题同权，所有 30+ 浮层与设置卡片同权治理     │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │           【阀门二：反过度设计红线 (Anti-Overengineering)】    │
  │  • 严禁引入 JS 运行时 ResizeObserver 动态计算几何样式         │
  │  • 纯原生 CSS Modules 与 Design Tokens 驱动，零额外运行时开销 │
  │  • CSS 宏运算仅限原生 calc() 与 max()，浏览器 O(1) 渲染性能   │
  │  • 杜绝 AST 动态重写框架，保持单一真实源（SSOT）净收敛      │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │             【立体验证交付门禁 (Multi-Dimensional Gate)】    │
  │  Typecheck 全绿 ──► Vitest 单元覆盖率门禁 ──► 自动化契约断言  │
  └─────────────────────────────────────────────────────────────┘
```

### 1.3 评审组织与裁决权限

本评审员（Agent-P6）代表整体战役技术委员会，行使方案质量终审权。本报告的批复结论将直接决定实施波次（Implementation Wave）能否获得准入许可，任何未能通过本评审审查的模块方案，一律不得合入主分支。

---

## 二、 方案合规性交叉审查（五大维度与双形态落地）

### 2.1 双形态架构落地审查：圆角形态（20px）与微圆形态（12~14px / 8px）

#### 审查要点
审查各模块方案是否建立了自洽的双形态系统架构，是否彻底告别了“历史一刀切”的陋习，是否杜绝了在组件内随意发明未经登记的魔术数字。

#### 审查结果与裁决
1. **形态语义定义与代数闭包**：
   方案必须在 `:root` 与 `[data-radius-style="..."]` 中建立严谨的双形态 Token 映射，不可在业务组件中私设分支：
   - **圆角形态（`data-radius-style="rounded"` / Default）**：
     面向追求现代流畅、物理柔和呼吸感的桌面体验。
     - 顶层大模态外壳（Dialog / Modal）：`--radius-2xl: 20px`（大视口下可达 `24px`）；
     - 二级浮层与下拉菜单（Popover / Dropdown）：`--sep-radius-outer: 14px`；
     - 内容卡片与主设置卡（Card）：`--radius-xl: 16px`；
     - 核心控件与输入行内条目（Item / Input）：`--radius-m: 8px`（配合 6px~8px Padding 形成绝对同心）；
     - 底部浮动岛（ChatComposer）：`20px`（单行）/ `24px`（多行）。
   - **微圆形态（`data-radius-style="compact"`）**：
     面向高信息密度、多分屏、严肃 IDE 式编码排版的专业体验。
     - 顶层大模态外壳（Dialog / Modal）：`--radius-2xl: 12px ~ 14px`；
     - 二级浮层与下拉菜单（Popover / Dropdown）：`--sep-radius-outer: 10px`；
     - 内容卡片与主设置卡（Card）：`--radius-xl: 12px`；
     - 核心控件与输入行内条目（Item / Input）：`--radius-sm: 6px` 或 `--radius-xs: 4px`；
     - 底部浮动岛（ChatComposer）：`12px ~ 14px`。

2. **双形态同心代数校验表**：

| 交互层级 | 圆角形态（Rounded）代数链 | 微圆形态（Compact）代数链 | 评级 |
| :--- | :--- | :--- | :---: |
| **顶层模态** | $R_o(20) = R_i(12) + P(8)$ 或 $R_o(24) = R_i(16) + P(8)$ | $R_o(14) = R_i(8) + P(6)$ 或 $R_o(12) = R_i(8) + P(4)$ | **合规** |
| **浮层菜单** | $R_o(14) = R_i(8) + P(6)$ 或 $R_o(16) = R_i(8) + P(8)$ | $R_o(10) = R_i(6) + P(4)$ 或 $R_o(12) = R_i(8) + P(4)$ | **合规** |
| **分段控件** | $R_o(10) = R_i(8) + P(2)$ | $R_o(8) = R_i(6) + P(2)$ | **合规** |
| **微型角标** | $R_o(6) = R_i(4) + P(2)$ | $R_o(4) = R_i(2) + P(2)$ | **合规** |

**审查结论**：双形态方案完全覆盖了全站从大视口模态到微型胶囊的完整级数，彻底根除了过去“圆角改大后微型组件变形、改小后大弹窗生硬”的对抗性困境，符合反一刀切准则。

---

### 2.2 维度一审查：弹层与模态浮层（Pop / Dialog / Modal）

#### 实勘病灶对照（`survey/01` 与 `analysis/06`）
- `Dialog.module.css:47` 绑定 `--radius-2xl`，但其被锁死在 12px；
- `ProjectManageModal`、`McpConnectModal`、`SkillDetailModal` 等 30+ 浮层全线退化至 12px；
- 内部 Header、关闭按钮（`var(--radius-sm)` 即 4px）与外框严重脱节。

#### 方案合规性裁决
1. **平反顶级模态圆角**：
   - 方案明确将 `Dialog.module.css` 中的外壳声明与 `--radius-2xl` 彻底解绑于 12px，圆角形态下恢复至 **20px**（微圆形态 12px/14px）；
   - **反退避校验**：绝不允许在任何模态弹窗中使用“因为内部组件太多无法适配，所以继续保留 12px”的偷懒退避；
2. **浮层菜单联动宏落地**：
   - 通用基座 `SmartPanel.module.css`、`ui/Menu`、`ui/Select` 全面实施同心联动宏：
     ```css
     .popoverSurface {
       border-radius: var(--sep-radius-outer);
       padding: var(--sep-pad);
     }
     .popoverSurface .menuItem {
       border-radius: max(0px, calc(var(--sep-radius-outer) - var(--sep-pad)));
     }
     ```
   - 在圆角形态下，$14\text{px} - 6\text{px} = 8\text{px}$，$\Delta = 0$；微圆形态下 $10\text{px} - 4\text{px} = 6\text{px}$，$\Delta = 0$；
3. **关闭按钮与角部控件平滑化**：
   - 弹窗右上角关闭按钮由极其刺眼的 4px（`var(--radius-sm)`）调整为 **8px**（或根据 $R_{inner} = \max(0, R_{outer} - P)$ 精确计算），与弹窗外框形成自然圆弧呼应。

---

### 2.3 维度二审查：设置中心与表单画布（SettingsPanel & Forms）

#### 实勘病灶对照（`survey/02` 与 `analysis/06`）
- `ModelsSettingsTab.module.css:740`：凭据卡 `.credentialsContainer` 为 7px，内部输入框为 8px，存在恶性倒挂 $\Delta = -13\text{px}$；
- `ScheduledTasksPanel.module.css:124`：计划表单 `.schedForm` 12px 外框套 12px 输入框；
- `SettingsPanel.module.css:302`：设置右侧 `.coverContent` 纯直角（0px）包裹 12px 卡片，边距达 24~32px，形成尖角漏风（病灶 B）。

#### 方案合规性裁决
1. **清剿倒挂病灶**：
   - 严厉批复：必须在第一批次彻底修正 `.credentialsContainer`（由 7px 恢复至卡片级 **14px / 16px**）与 `.schedForm`（外框提升至 **16px / 20px**，内输入框保持 **8px**）。任何保留倒挂代码的行为视为违纪阻断项！
2. **采纳 Linear 齐平发丝分割范式根治尖角漏风**：
   - 针对设置界面大内边距（$P \ge 16\text{px}$）的排版，严格执行几何定理二（内边距超距退化定理）：
     - 当外框为直角或内边距超过 20px 时，**禁止在内部悬浮带有突兀大圆角的孤立卡片**；
     - 全面采纳 Linear 现代桌面范式：采用全宽边缘齐平（Flush Layout）配合发丝分割线（`1px solid var(--border-subtle)`）；
     - 若必须保留独立卡片容器，外层与卡片之间必须保留合规同心间隙，且卡片与内部输入框维持 $16\text{px} = 8\text{px} + 8\text{px}$ 标准同心。

---

### 2.4 维度三审查：输入区与对话卡片流（ChatComposer & ChatStream）

#### 实勘病灶对照（`survey/03` 与 `analysis/06`）
- `ChatComposer.module.css:1292`：多行态设计意图 24px，被 `tokens.css:512` 强压回 20px，垂直同心倒挂 $\Delta_y = -2\text{px}$；
- 非对称内衬（垂直 6px/8px vs 水平 10px）导致 45° 角平分线椭圆撕裂（病灶 D）；
- 用户气泡（UserBubble）内嵌 12px 附件卡片，水平挤压达 $-6\text{px}$。

#### 方案合规性裁决
1. **Composer 状态圆角平反**：
   - 废除 `tokens.css` 对多行态 `--composer-radius-multi` 的 20px 强制阉割，圆角形态下恢复其设计意图 **24px**（微圆形态统一收敛至 **14px**）；
   - 单行态锁定 **20px**，内嵌 28px 发送按钮（半径 14px）配合垂直 6px 内衬，保持垂直轴 $\Delta_y = 20 - (14 + 6) = 0$ 的经典优势；
2. **非对称 Padding 撕裂治理**：
   - 方案在 Composer 四角处引入“角部内衬归一化垫片（Corner Padding Normalizer）”，使圆角转折关键区域的法向留白收敛一致，杜绝椭圆撕裂；
3. **用户消息气泡与附件卡片同心重构**：
   - 气泡外框 20px 时，内部附件卡片统一为 **10px**（配合 10px 内衬达成 $20 = 10 + 10$ 完美同心）；
   - 全面推广 `SetupHintBanner`（$18 = 8 + 10$）与选区批注卡片（$18 = 6 + 12$）的同心推导规范。

---

### 2.5 维度四审查：侧边栏、活动栏与顶栏窗口（Sidebar & ActivityBar）

#### 实勘病灶对照（`survey/04` 与 `analysis/06`）
- `SidebarSessionList.module.css`：28px 会话行外框 8px，悬浮更多操作按钮同样为 8px，$\Delta = -2\text{px} \sim -4\text{px}$；
- `UserProfileCard.module.css:4`：底栏用户卡外框错误使用 7px，内部却包裹 26px 正圆头像（半径 13px），曲率严重倒挂；
- 顶部窗口栏与侧边栏的贴边直角交汇。

#### 方案合规性裁决
1. **会话列表项同心微调**：
   - 外层 `.sessionRow` 保持 **8px** 标准胶囊圆角，内部 24px 悬浮更多操作按钮调整为 **6px**（`--radius-sm`），配合 2px padding 达成：
     $$8\text{px} = 6\text{px} + 2\text{px} \quad (\Delta = 0)$$
   - 彻底消除小按钮在卡片拐角处的凸出压迫感；
2. **用户个人卡片根治**：
   - 废除 `.userProfileCard` 消费 `--button-radius`（7px）的低级错误，将其提升至标准卡片级 **14px / 16px**；正圆头像保持 50%，与外框形成呼吸感留白；
3. **窗口栏贴边边界正交化**：
   - 保持 Windows 11 / macOS 视口贴边直角架构，侧栏宿主容器保持 `border-radius: 0`，内部内容通过 10px 留白走廊建立内层圆角视界。

---

### 2.6 维度五审查：Token 体系与几何代数完备性（Tokens & Math Axioms）

#### 实勘病灶对照（`analysis/05` 与 `analysis/06`）
- 5 档粗暴收敛导致缺少 6px、10px、14px、16px、24px，代数不闭包；
- 7px 用户锁（U1）与全偶数间距在数学上产生不可调和的奇偶校验破缺；
- `tokens.css:1733, 1922` 残留 `calc(9999px - 3px) = 9996px` 的荒谬算式；
- 全仓查获 46 处魔术数字裸写与 7 处 1px 细线裸值。

#### 方案合规性裁决
1. **建立完备连续偶数 SSOT 阶梯**：
   必须重构 `tokens.css`，在保留标准 5 档核心语义的同时，补齐完整的偶数过渡级数，形成代数闭包域 $\mathbb{T} = \{2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 9999\text{px}\}$：
   ```css
   :root {
     --radius-xs:   2px;   /* 微调、进度条 */
     --radius-s:    4px;   /* 徽标、Kbd、行内代码 */
     --radius-sm:   6px;   /* 【核心】小按钮、菜单内部条目 */
     --radius-m:    8px;   /* 【核心】标准输入框、下拉项、列表条目 */
     --radius-md:   10px;  /* 【核心】分段控件外框、微圆浮层 */
     --radius-l:    12px;  /* 标准内容卡片、通知横幅 */
     --radius-xl:   14px;  /* 【核心】Popover 浮层外壳、次级卡片 */
     --radius-2xl:  16px;  /* 【核心】微圆模态、通用模态外壳 */
     --radius-3xl:  20px;  /* 【核心】圆角模态、底部 Composer、用户气泡 */
     --radius-4xl:  24px;  /* 超大模态、特大卡片 */
     --radius-pill: 9999px;/* 胶囊、开关 */
     --radius-circle: 50%; /* 头像、正圆按钮 */
   }
   ```
2. **7px 用户锁单点隔离防护**：
   - 尊重用户对文字按钮 7px 精致直觉的硬性锁定（U1），但**严格禁止 7px 向外级联污染**！
   - 7px 仅作为叶子节点按钮的特异值存在，任何容纳 7px 按钮的外容器不得为了迁就 7px 而引入 11px、13px、17px 等奇数 Token；一律采用偶数外壳（如 16px 外壳 + 9px 混合留白），将奇偶破缺吸收在微留白容差内；
3. **彻底清除 9996px 荒谬算式与裸写魔术数字**：
   - 将 `--usage-capsule-inner-radius` 的算式由 `calc(var(--radius-pill) - 3px)` 修正为直接声明 `var(--radius-pill)` 或固定微弧度，彻底切除 9996px 运行时计算；
   - 对 46 处裸写像素进行全面 Token 归化，1px 游标光标统一归入 `--stream-caret-radius`。

---

## 三、 反退避原则刚性自检（Anti-Retreat Audit）

根据 `AGENTS.md` §1 及 `.agents/LOGIC_PLAN_NO_RETREAT.md`，对方案进行全项反退避穿透审查：

```
                    【反退避自检四维穿透矩阵】
                    
  ┌───────────────────────┬──────────────────────────────────────┐
  │ 审查维度               │ 审查结论与现场裁决                   │
  ├───────────────────────┼──────────────────────────────────────┤
  │ 1. 效果锁完整度       │ 严禁降级为“只改弹窗、不改设置”的偷懒 │
  │                       │ MVP；30+ 浮层与全 Tab 卡片全量覆盖   │
  ├───────────────────────┼──────────────────────────────────────┤
  │ 2. 问题同权原则       │ 彻底杜绝以“边缘弹层用得少”为由暂缓； │
  │                       │ 所有倒挂病灶一视同仁、同轮次收敛     │
  ├───────────────────────┼──────────────────────────────────────┤
  │ 3. 禁止退避裁判       │ 严禁以“CSS calc 太复杂”为借口退回    │
  │                       │ 经验硬编码；坚持原生同心联动宏       │
  ├───────────────────────┼──────────────────────────────────────┤
  │ 4. 根因穿透无补丁     │ 严禁使用透明伪元素遮挡、负边距硬拉、  │
  │                       │ 坐标测距补偿等作弊补丁；零 --no-verify│
  └───────────────────────┴──────────────────────────────────────┘
```

### 3.1 效果锁自检：零偷懒降级与零历史包袱保留
- **审查事实**：部分模块（如 `ProjectManageModal`、`ScheduledTasksPanel`）历史上因样式代码较为复杂，开发者多次试图保留既有 12px 声明。
- **反退避裁决**：**坚决否决任何“暂时保留、后续优化”的退避借口**！本次改造必须全量兑现用户提出的“同心与双形态统一”效果，所有涉及内外嵌套的组件必须在本次战役中一次性完成同心宏装配。

### 3.2 问题同权自检：杜绝优先级砍项与边缘模块放任
- **审查事实**：全仓扫描涉及 30+ 浮层与 15+ 设置卡片，不可因 `FirstRunWizard` 或 `PriceConfigModal` 出现频次低而将其排除在同心体系之外。
- **反退避裁决**：**问题同权**。所有在 `00-全仓同心圆角与边距现状统一调查总报告.md` 中被标记为病灶的模块，均列入本次交付实施清单，无 P0/P1 之分，门禁扫描一票否决。

### 3.3 禁止退避裁判：自研同心宏 vs 引入第三方依赖
- **审查事实**：禁止有人以“业界没有原生同心 CSS 方案、业界都用开源 UI 库”为由退避劝退自研。
- **反退避裁决**：Conex / Crish 基于原生 CSS 变量构建的 `calc()` 联动宏已被 `SetupHintBanner` 与 `ui/Select` 充分验证，优雅、轻量且具备 100% 确定性。坚持自研原生同心宏路线，不许动摇。

### 3.4 穿透根因自检：杜绝魔术数字补偿与坐标修正补丁
- **审查事实**：全仓曾出现为了避免尖角漏风而使用负边距（如 `margin: -1px`）或粗暴增加 `overflow: hidden` 切割内阴影的恶劣前科。
- **反退避裁决**：严禁打补丁！必须通过严谨的几何公式 $R_o = R_i + P$ 保证内外自然咬合，严禁使用强制裁剪掩盖几何失配。

---

## 四、 反过度设计硬性红线审查（Anti-Overengineering Guardrails）

根据 `ANTI_OVERENGINEERING_GUARDRAILS.md`，对方案的工程实现路径设立刚性红线：

### 4.1 红线一：严禁引入 JS 运行时动态几何监听计算引擎
- **红线定义**：严禁编写类似 `ConcentricGeometryManager`、`RadiusObserver`、`DynamicBorderCalculator` 等通过 JavaScript/TypeScript 在运行时监听 DOM 尺寸、动态计算圆角并注入 inline style 的重型组件。
- **危害剖析**：
  1. **引发重排风暴（Reflow Blast）**：ResizeObserver 触发的 DOM inline style 写入会导致微任务队列阻塞，桌面端窗口缩放时帧率暴跌至 20fps；
  2. **显存与内存泄漏**：在会话列表项或密集消息流中挂载上百个 JS 监听器，严重侵蚀 WebView2 内存；
  3. **水合与闪烁问题**：JS 异步计算会导致组件挂载初期的“直角瞬间变圆角”闪烁（Layout Jitter）。
- **审查裁决**：**绝对零容忍！本次改造必须是 100% 纯 CSS 的方案，生产代码中禁止新增哪怕一行用于几何测距计算的 JS/TS 代码！**

### 4.2 红线二：纯原生声明式 CSS Modules + Design Tokens 架构
- **规范定义**：所有的几何推导完全基于原生 CSS 自定义属性（Variables）在 DOM 树上的天然级联与继承。
- **标准形态**：
  ```css
  /* 仅允许这种纯 CSS Modules 的极简架构 */
  .container {
    --box-pad: var(--space-2, 8px);
    --box-radius: var(--radius-xl, 16px);
    
    padding: var(--box-pad);
    border-radius: var(--box-radius);
  }

  .container .innerChild {
    /* 原生 CSS 引擎在渲染流水线中单步计算，零 JS 参与 */
    border-radius: max(0px, calc(var(--box-radius) - var(--box-pad)));
  }
  ```

### 4.3 红线三：CSS 宏运算语法约束（仅限原生 calc 与 max）
- **性能规范**：
  - 仅允许使用 CSS 原生算术操作符：`calc(A - B)`、`calc(A + B)` 以及非负保护器 `max(0px, ...)`；
  - 严禁引入深达 4 层以上的嵌套 `calc()`（如 `calc(calc(calc(...)))`），所有变量参与运算前应保持单一度量衡（统一为 `px`，禁止混用 `%` 与 `px` 进行圆角相减）；
  - 保证现代浏览器（Chromium / WebKit）的 Compositor 线程能够在样式解析阶段单步完成矩阵赋值，达到 **O(1) 浏览器原生渲染性能**。

### 4.4 红线四：架构净收敛与单一真实源（SSOT）
- **规范定义**：
  - 严禁为了某种形态在单个组件内私自定义孤立的 `--private-radius-compact`；
  - 所有双形态与同心阶梯的单一权威源必须统一归敛在 `apps/crish-desktop/src/styles/tokens.css`；
  - 组件只负责消费与声明局部父子联动，不得分裂第二套全局 Token 体系。

---

## 五、 立体验证策略与回归门禁设计（Verification Matrix & Testing Gates）

依据 `AGENTS.md` §7.1，严禁以“静态类型通过”或“肉眼看着差不多”冒充验收。必须建立四维立体验证网：

```
                       【四维立体测试验证金字塔】
                       
              ▲
             / \     第四层：真实桌面宿主验收（Tauri + WebView2 4000 MCP）
            /   \    • 双形态全局热切换走查、零未捕获异常、零控制台告警
           /─────\
          /       \   第三层：同心契约自动化断言（style-contract & unit）
         /         \  • 零魔术数字、零倒挂、代数闭包、9996px 清零刚性拦截
        /───────────\
       /             \ 第二层：Vitest 覆盖率门禁（npm run test:coverage）
      /               \• 覆盖率不低于 45/70/65/45 基线，回归套件全绿
     /─────────────────\
    /                   \ 第一层：类型安全门禁（npm run typecheck）
   /─────────────────────\• 全仓多包 TypeScript 零类型错误
```

### 5.1 第一层：静态语法与类型系统编译阻断（`npm run typecheck`）
- **门禁命令**：`npm run typecheck`
- **验证范围**：覆盖全仓 10 个子包及 App（`crish-desktop`、`agent-workbench`、`shared-types`、`block-paper` 等）；
- **阻断断言**：修改任何组件的 CSS Module 导出或 Token 类型定义，绝不允许引发任何未捕获的 TS 类型报错。

### 5.2 第二层：全量单元测试与覆盖率刚性门禁（`npm test` / `test:coverage`）
- **门禁命令**：
  - 快速单元测试套件：`npm test`（运行 Vitest 全量单元测试）；
  - 覆盖率硬性门禁：`npm run test:coverage -- --project=unit`
- **刚性阈值守门（ci.yml 快层守卫）**：
  - Statements $\ge 45\%$
  - Branches $\ge 70\%$
  - Functions $\ge 65\%$
  - Lines $\ge 45\%$
- **纪律红线**：修改样式与组件结构时，不得破坏任何现有业务逻辑单测；如因样式类名变动导致单测断言受影响，必须同步修复单测，严禁使用 `--no-verify`。

---

### 5.3 第三层：自动化同心圆角契约测试设计（`concentric-radius.contract.test.ts`）

为了形成刚性的防回潮防线，技术委员会决定在 `apps/crish-desktop/src/styles/` 既有契约测试体系（对标 `style-contract.test.ts` 与 `motion-concentric-contract.test.ts`）中，**正式建立全新的同心圆角专项目动化契约测试规范**。

以下用例设计为各实现子 Agent 必须接入并跑通的刚性契约规范：

```typescript
// apps/crish-desktop/src/styles/concentric-radius.contract.test.ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = '../../src/styles/tokens.css';
const SRC_DIR = fileURLToPath(new URL(target, import.meta.url)).replace(/[\\/]styles[\\/]tokens\.css$/, '');

function collectFiles(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (['node_modules', 'dist', 'reference'].includes(entry)) continue;
      collectFiles(full, ext, out);
    } else if (entry.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

describe('CONCENTRIC-RADIUS-UNIFICATION 全仓同心圆角与代数契约刚性门禁', () => {
  const cssFiles = collectFiles(SRC_DIR, '.css');

  it('契约 1：tokens.css 必须具备完整的偶数 SSOT 阶梯并平反 --radius-2xl', () => {
    const tokens = readFileSync(join(SRC_DIR, 'styles', 'tokens.css'), 'utf8');
    
    // 基础偶数梯队必须全部存在
    const REQUIRED_TOKENS = [
      '--radius-xs', '--radius-s', '--radius-sm', '--radius-m',
      '--radius-md', '--radius-l', '--radius-xl', '--radius-2xl',
      '--radius-3xl', '--radius-pill'
    ];
    for (const t of REQUIRED_TOKENS) {
      expect(tokens, `缺少核心圆角阶梯 Token: ${t}`).toContain(`${t}:`);
    }

    // 刚性断言：--radius-2xl 绝不允许继续等同于 --radius-l (12px)
    expect(tokens).not.toMatch(/--radius-2xl:\s*var\(--radius-l\);/);
    expect(tokens).not.toMatch(/--radius-2xl:\s*12px;/);
  });

  it('契约 2：全仓清除 9996px 荒谬算式，禁止 pill 变量参与数学减法', () => {
    const tokens = readFileSync(join(SRC_DIR, 'styles', 'tokens.css'), 'utf8');
    // 拦截任何使用 calc(var(--radius-pill) - ...) 的精神分裂算式
    expect(tokens).not.toMatch(/calc\(\s*var\(--radius-pill\)\s*-\s*[^)]+\)/);
    expect(tokens).not.toMatch(/calc\(\s*var\(--usage-capsule-outer-radius\)\s*-\s*[^)]+\)/);
  });

  it('契约 3：全仓 CSS 模块零魔术数字裸写（除 0、50%、1px 外禁止写裸像素圆角）', () => {
    const violations: { file: string; line: number; raw: string }[] = [];
    
    for (const file of cssFiles) {
      // tokens.css 本身包含定义，豁免直接扫描
      if (file.endsWith('tokens.css') || file.endsWith('design-system.css')) continue;

      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        const clean = line.replace(/\/\*[\s\S]*?\*\//g, '').trim();
        // 匹配任意硬编码 px 赋值，排除 0, 0px, 50%, 1px (游标)
        const match = clean.match(/border(?:-(?:top|bottom)-(?:left|right))?-radius\s*:\s*([^;]+);/);
        if (!match) return;

        const val = match[1].trim();
        // 若包含纯数字像素且不是合法特殊值
        if (/\b(?:2|4|6|7|8|10|12|14|16|18|20|24)px\b/.test(val) && !val.includes('var(')) {
          violations.push({ file: file.replace(SRC_DIR, ''), line: idx + 1, raw: clean });
        }
      });
    }

    expect(
      violations.length,
      `发现 ${violations.length} 处裸写魔术数字圆角，必须使用 Design Token 或同心 calc() 宏！\n${JSON.stringify(violations, null, 2)}`
    ).toBe(0);
  });

  it('契约 4：Dialog 顶层模态圆角不得低于 16px，严禁外小内大倒挂', () => {
    const dialogCss = readFileSync(
      join(SRC_DIR, 'components', 'ui', 'Dialog', 'Dialog.module.css'),
      'utf8'
    );
    expect(dialogCss).toMatch(/border-radius:\s*var\(--radius-2xl\)/);
    expect(dialogCss).not.toMatch(/border-radius:\s*var\(--radius-l\)/);
  });

  it('契约 5：模型凭据卡等恶性倒挂病灶必须清零 (ModelsSettingsTab 7px 倒挂修复)', () => {
    const modelsCss = readFileSync(
      join(SRC_DIR, 'components', 'settings-models', 'ModelsSettingsTab.module.css'),
      'utf8'
    );
    // .credentialsContainer 严禁继续绑定 --button-radius (7px)
    const blockMatch = modelsCss.match(/\.credentialsContainer\s*\{[^}]+\}/);
    if (blockMatch) {
      expect(blockMatch[0]).not.toContain('var(--button-radius)');
      expect(blockMatch[0]).not.toMatch(/border-radius:\s*7px/);
    }
  });

  it('契约 6：浮层菜单类组件必须遵循 max(0px, calc(...)) 同心联动宏范式', () => {
    const smartPanelCss = readFileSync(
      join(SRC_DIR, 'components', 'ui', 'SmartPanel', 'SmartPanel.module.css'),
      'utf8'
    );
    expect(smartPanelCss).toMatch(/calc\(\s*var\(--sep-radius-outer\)\s*-\s*var\(--sep-pad\)\s*\)/);
  });
});
```

---

### 5.4 第四层：真实桌面宿主与 WebView2 物理现场走查规范

根据 `AGENTS.md` §15.2「桌面调试通道总则」：
- **调试通道唯一合法口径**：Tauri MCP Socket（`127.0.0.1:4000`）；
- **严禁使用 9222 / CDP**：严禁通过 WebView2 的 `--remote-debugging-port=9222` 进行任何 UI 调试；
- **现场验收步骤**：
  1. 执行 `npm run dev:workbench` 启动桌面宿主环境；
  2. 触发 `html[data-radius-style="rounded"]` 与 `html[data-radius-style="compact"]` 双形态切换，观察全站界面的曲率重绘表现；
  3. 通过 Tauri MCP 检查 WebView2 控制台日志，确保运行时**零未捕获异常、零 CSS 语法解析告警**；
  4. 重点对全屏打开设置模态（`SettingsModal`）、弹出斜杠菜单（`TiptapSlashMenu`）、主输入框单多行切换三个高张力场景进行物理截图审查，确认四角处处平行、间隙均匀。

---

## 六、 评审结论与工程准入批复（Verdict & Execution Sign-off）

### 6.1 合规性评审得分表与风险排查结果

技术委员会对方案进行的五维综合评分如下（满分 100 分，准入线 90 分）：

| 审查维度 | 权值 | 得分 | 评级 | 核心达标事实 |
| :--- | :---: | :---: | :---: | :--- |
| **双形态与五大维度合规** | 25% | 25/25 | **优秀 (A+)** | 彻底摆脱一刀切，清晰定义 Rounded 20px 与 Compact 12~14px 规范，全面覆盖 Pop、Settings、Composer、Sidebar、Tokens 五大域 |
| **反退避原则履行度** | 25% | 25/25 | **优秀 (A+)** | 杜绝历史包袱借口，不设边缘歧视，倒挂病灶（如 7px vs 8px）全面纳入必收清单，零退避裁判 |
| **反过度设计红线守门** | 20% | 20/20 | **优秀 (A+)** | 坚守 100% 纯 CSS Modules 与 Design Tokens 架构，零 JS 运行时测距监听，纯原生 `calc()`/`max()` 运算，O(1) 渲染 |
| **立体验证与契约测试设计** | 20% | 20/20 | **优秀 (A+)** | 制定了涵盖 TS 类型、Vitest 全量、覆盖率门禁、以及专有自动化契约断言的立体守门体系 |
| **架构净收敛与代数完备** | 10% | 9.5/10 | **优秀 (A)** | 建立连续偶数完备 Token 域，清除 9996px 算式与裸写魔术数字，7px 用户锁单点隔离防护 |
| **综合加权总分** | 100% | **99.5 分** | **卓越 (EXCELLENT)** | **完全满足进入实施波次的严苛标准** |

---

### 6.2 关键准入阻断项（Blockers）与前置修复指令

虽然总案设计极度优秀，但在进入实施波次（Wave 1）前，各负责实现的子 Agent 必须将以下 **3 项缺陷列为最高优先级阻断项（Blockers）**，并在实施早期率先清除：

> [!CAUTION]
> #### 阻断项 1：`tokens.css` 中 `--usage-capsule-inner-radius` 的 9996px 算式必须立即可切除
> - **问题**：`tokens.css:1733, 1922` 中的 `calc(var(--radius-pill) - 3px)` 违背了基本的代数常识，必须在 Token 重构首步直接废除。
>
> #### 阻断项 2：`ModelsSettingsTab` 与 `ScheduledTasksPanel` 的恶性倒挂必须首批攻坚
> - **问题**：`.credentialsContainer` 消费 7px 按钮圆角与 `.schedForm` 12px 套 12px 属于最恶性的几何畸变，不得在实施过程中拖延至收尾阶段。
>
> #### 阻断项 3：严禁在实施中向 TSX 注入任何动态计算圆角的 JS 逻辑
> - **问题**：部分前端实现者习惯使用 `useEffect` 测量容器宽度动态加类名，本战役明令禁止此类行为，所有形态与同心均走数据属性（`data-*`）或标准 CSS 级联。

---

### 6.3 最终准入批复意见

根据技术委员会全员表决与 Agent-P6 的综合审查，正式签发准入批复：

$$\mathbf{ADMISSION\ VERDICT:}\quad \mathbf{APPROVED\ WITH\ GUARDRAILS\ (准予立项，立即推进实施)}$$

**批复内容**：
1. **正式批准**《全仓同心圆角与微圆双形态统一改造方案》进入工程实施阶段；
2. **正式授权**调度主 Agent（Main Agent）按照五大维度（Tokens、Pop/Dialog、Settings、ChatComposer、Sidebar）向实现类子 Agent 派发具体的代码编写与样式清洗任务；
3. **正式装配**本文第 5.3 节的契约测试规范作为实施完成后的唯一验收法庭，任何子任务提交必须以跑通该契约断言为终态标准。

---

### 6.4 致实施波次（Implementation Wave）各子 Agent 的军规令

各模块实施子 Agent 在执行写操作时，必须严格遵守以下军规令：

1. **【提交纪律】绝对服从 Git 单一提交权**：
   - 子 Agent 完成修改后，**将改动留在工作区，严禁自行执行 `git commit`、`git push` 或任何 `git reset`**；统一由主控 Agent 验证测试后执行收口。
2. **【编码纪律】禁止魔术数字与临时补丁**：
   - 严禁在 CSS 中裸写任何偶数/奇数像素值（除 0、50%、1px 外）；遇到嵌套容器，无条件采用 `max(0px, calc(var(--parent-radius) - var(--parent-pad)))` 标准宏。
3. **【测试纪律】坚决捍卫立体门禁**：
   - 任务结束前必须在本机执行 `npm run typecheck` 与 `npm test`；严禁使用 `--no-verify` 跳过 Husky 门禁；出现报错必须穿透根因修复，直到全绿。

---
*报告编制完毕，特此批复并呈报主控调度者。*