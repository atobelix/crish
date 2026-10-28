# 前端视觉层级、排版字阶与 Windows 字体物理对齐系统性重构落地方案

> **战役代号**：`frontend-systemic-refactor`  
> **方案编号**：`plans/03-visual-hierarchy-and-typography.md`  
> **架构专员**：Agent P03（视觉层级与字阶排版架构师）  
> **前置输入**：  
> - 审计报告：[`docs/frontend-comprehensive-audit/audits/03-audit-visual-hierarchy-and-typography.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/audits/03-audit-visual-hierarchy-and-typography.md)  
> - 权威总报告：[`docs/frontend-comprehensive-audit/01-前端全景深度盘查与架构健康度总报告.md`](file:///c:/Software/conex/docs/frontend-comprehensive-audit/01-前端全景深度盘查与架构健康度总报告.md)  
> **核心使命**：彻底根除全仓视觉层级失序、13px 模糊断层、Windows 微软雅黑 500/600 物理字形断层失真、Markdown 门禁 `@import` 假阳性误报以及硬编码行高/字号，建立 100% 刚性闭环的排版与视觉层级单一真理源（SSOT）。  
> **遵循铁律**：零打补丁、零硬编码、不搞双轨妥协、负代码清退、永久防回潮。

---

## 目录索引

1. [战役总纲与核心设计原则](#1-战役总纲与核心设计原则)
2. [架构病态与物理现场实证剖析](#2-架构病态与物理现场实证剖析)
   - 2.1 [`check:hierarchy-ssot` 286 处报错数学闭环与超标元凶](#21-checkhierarchy-ssot-286-处报错数学闭环与超标元凶)
   - 2.2 [Windows 微软雅黑物理字形断层实证（400/700 物理真实 vs 500/600 伪粗体锯齿）](#22-windows-微软雅黑物理字形断层实证400700-物理真实-vs-500600-伪粗体锯齿)
   - 2.3 [13px 模糊断层与全仓 1px 细碎字阶乱象](#23-13px-模糊断层与全仓-1px-细碎字阶乱象)
   - 2.4 [硬编码行高（1.2, 1.5, 20px 等）破坏垂直韵律与无障碍失真](#24-硬编码行高12-15-20px-等破坏垂直韵律与无障碍失真)
   - 2.5 [`check:markdown-style` 74 处假阳性报错根因与 Token 完备性穿透](#25-checkmarkdown-style-74-处假阳性报错根因与-token-完备性穿透)
   - 2.6 [`markdown-typography.css` 内部自身残存的旧 Token 与排版隐患](#26-markdown-typographycss-内部自身残存的旧-token-与排版隐患)
3. [目标架构与排版系统 SSOT 契约](#3-目标架构与排版系统-ssot-契约)
   - 3.1 [6 档标准字阶体系与 13px 彻底升降级契约](#31-6-档标准字阶体系与-13px-彻底升降级契约)
   - 3.2 [字重严格两档化模型（`--fw-regular: 400` vs `--fw-strong: 700`）](#32-字重严格两档化模型--fw-regular-400-vs---fw-strong-700)
   - 3.3 [4 档垂直韵律行高体系（`--lh-dense`, `--lh-ui`, `--lh-prose`, `--lh-row`）](#33-4-档垂直韵律行高体系--lh-dense---lh-ui---lh-prose---lh-row)
   - 3.4 [清退复合排版与墨色死层，全面收敛至原子字阶与语义文字色](#34-清退复合排版与墨色死层全面收敛至原子字阶与语义文字色)
   - 3.5 [展示容器实体描边清退与表面明度阶梯（Surface Steps）+ `--edge-rim` 规范](#35-展示容器实体描边清退与表面明度阶梯surface-steps---edge-rim-规范)
   - 3.6 [全仓 Markdown 渲染流 46 个 `--md-*` Token 100% 消费契约](#36-全仓-markdown-渲染流-46-个---md--token-100-消费契约)
4. [紧急解阻工程详案（Phase 1：增量止血与门禁脱困）](#4-紧急解阻工程详案phase-1增量止血与门禁脱困)
   - 4.1 [任务 1：升级 `check-markdown-style-compliance.mjs` 支持 `@import` 依赖链解析](#41-任务-1升级-check-markdown-style-compliancemjs-支持-import-依赖链解析)
   - 4.2 [任务 2：彻底重构 `PermissionModeMenu.module.css:259-275`](#42-任务-2彻底重构-permissionmodemenumodulecss259-275)
   - 4.3 [任务 3：彻底重构 `ProjectManageModal.module.css:80-108`](#43-任务-3彻底重构-projectmanagemodalmodulecss80-108)
   - 4.4 [任务 4：修复 `ChatComposer.module.css` 跨行声明导致的单行扫描器误判](#44-任务-4修复-chatcomposermodulecss-跨行声明导致的单行扫描器误判)
   - 4.5 [紧急解阻验证与门禁恢复 PASS 断言](#45-紧急解阻验证与门禁恢复-pass-断言)
5. [全仓系统性收敛与自动化 Codemod 施工详案（Phase 2 ~ Phase 4）](#5-全仓系统性收敛与自动化-codemod-施工详案phase-2--phase-4)
   - 5.1 [全仓字阶升降级与行高收敛 Codemod 实现（`scripts/codemod-typography-ssot.mjs`）](#51-全仓字阶升降级与行高收敛-codemod-实现scriptscodemod-typography-ssotmjs)
   - 5.2 [全仓 Windows 字重两档化与排版原子契约接入 Codemod（`scripts/codemod-font-weights-and-roles.mjs`）](#52-全仓-windows-字重两档化与排版原子契约接入-codemodscriptscodemod-font-weights-and-rolesmjs)
   - 5.3 [展示型容器实体描边清退与 `--edge-rim` 迁移 Codemod](#53-展示型容器实体描边清退与---edge-rim-迁移-codemod)
   - 5.4 [`markdown-typography.css` 内部 13px 与旧 Token 彻底清剿落地](#54-markdown-typographycss-内部-13px-与旧-token-彻底清剿落地)
   - 5.5 [物理清除 `tokens-type.css` 中的 `[WAVE2-DEPRECATED-ALIAS]` 临时别名死码](#55-物理清除-tokens-typecss-中的-wave2-deprecated-alias-临时别名死码)
6. [永久免疫机制与刚性棘轮门禁收口（Phase 5）](#6-永久免疫机制与刚性棘轮门禁收口phase-5)
   - 6.1 [棘轮基线动态更新与只减不增锁定机制](#61-棘轮基线动态更新与只减不增锁定机制)
   - 6.2 [静态代码守门：Stylelint 刚性拦截裸字面量与旧 Token](#62-静态代码守门stylelint-刚性拦截裸字面量与旧-token)
   - 6.3 [P9 终态 `--strict-zero` 归零验收路线图与断言矩阵](#63-p9-终态---strict-zero-归零验收路线图与断言矩阵)
7. [立体化验证方案与真实宿主对齐矩阵](#7-立体化验证方案与真实宿主对齐矩阵)
8. [架构收益对账与代码变更清单](#8-架构收益对账与代码变更清单)

---

## 1 战役总纲与核心设计原则

在 Conex / Crish 前端架构重构战役中，视觉层级（Visual Hierarchy）、排版字阶（Typography Scale）与 Markdown 样式体系构成了人机交互与长循环 Agent 审计的核心物理呈现面。本方案贯彻执行总纲六大铁律，确立如下核心准则：

```mermaid
flowchart TD
  subgraph CorePrinciples["六大重构准则"]
    P1["1. 零打补丁 (Zero Monkey-Patching)<br/>绝不用微调或坐标猜测补偿，根除架构断层"]
    P2["2. 零硬编码 (Zero Hardcoding)<br/>铲除裸 font-size / line-height / font-weight 字面量"]
    P3["3. 绝不搞双轨 (Clean Cut & No Dual-Track)<br/>彻底清退 13px 与旧 token 别名，一次性切断"]
    P4["4. 负代码产出 (Negative Code Yield)<br/>删除死 Token 与脆弱兼容层，精简 CSS 规则"]
    P5["5. 物理对齐 Windows (Physical Alignment)<br/>尊重 DirectWrite 事实，字重强制两档化 (400/700)"]
    P6["6. 永久防回潮 (Permanent Ratchet)<br/>只减不增棘轮锁死，最终全域归零 (--strict-zero)"]
  end
```

1. **零打补丁（Zero Monkey-Patching）**：不采用任何魔术数字或局部的临时覆盖（如内联 `!important` 或特异性加深），必须溯源至 `tokens-type.css`、`tokens-components.css` 的权威真理源。
2. **零硬编码（Zero Hardcoding）**：所有字号必须且只能来自标准 6 档字阶；所有行高必须且只能来自 4 档标准行高；所有字重必须且只能采用 `--fw-regular: 400` 或 `--fw-strong: 700`；所有边缘必须通过表面明度级差或 `--edge-*` 规范表达。
3. **彻底根除双轨妥协（No Dual-Track）**：坚决废除 `13px`、`11.5px` 等半像素与过渡字号，坚决废除 `[WAVE2-DEPRECATED-ALIAS]` 临时别名桥接，通过确定性 Codemod 语法树重写实现全仓一步到位切换。
4. **负代码产出（Negative Code Yield）**：清退 12 个废弃字号别名、6 个废弃字重别名、7 个废弃行高别名，清退多余的实体描边代码，实现样式表净减重。
5. **Windows 字体物理对齐（Physical DirectWrite Alignment）**：深刻认识 Windows 宿主环境下“微软雅黑无物理 500/600 字形”的硬件与操作系统现实，全仓字重降维至纯粹的两档化物理渲染。
6. **永久免疫刚性棘轮（Permanent Immunity）**：通过静态扫描脚本与 CI 棘轮机制，锁定违规数“只降不升”，直至 P9 阶段全面达成 `--strict-zero`（0 违规）。

---

## 2 架构病态与物理现场实证剖析

### 2.1 `check:hierarchy-ssot` 286 处报错数学闭环与超标元凶

运行 `npm run check:hierarchy-ssot` 时，终端爆发 286 处违规倾倒，引发 CI 阻断。通过审计报告与脚本源码对账，确立其精准数学闭环：

#### 1. 棘轮机制与 9 大域实测状态
门禁脚本 [`scripts/check-hierarchy-ssot.mjs`](file:///c:/Software/conex/scripts/check-hierarchy-ssot.mjs) 监控全仓 9 大核心交互组件域：

| 覆盖域 | CSS 文件数 | H1: 字阶/行高/字重字面量 (实测/基线) | H2: 实体描边声明 (实测/基线) | H3: 主题特判与强调色 (实测/基线) | 状态 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `chat-message-row` | 11 | 85 / 85 | 58 / 58 | 25 / 25 | **PASS** |
| `chat-message` | 3 | 12 / 12 | 5 / 5 | 0 / 0 | **PASS** |
| `chat-message-list` | 4 | 22 / 22 | 10 / 11 | 1 / 1 | **PASS** |
| `chat-tool-call` | 3 | 129 / 129 | 57 / 57 | 0 / 0 | **PASS** |
| `chat-composer` | 15 | **101 / 99** *(+2 违规)* | **72 / 71** *(+1 违规)* | 6 / 6 | <span style="color:red;font-weight:bold;">FAIL</span> |
| `sidebar` | 5 | 44 / 44 | **53 / 51** *(+2 违规)* | 11 / 11 | <span style="color:red;font-weight:bold;">FAIL</span> |
| `top-bar` | 1 | 0 / 0 | 0 / 0 | 0 / 0 | **PASS** |
| `binary-tree/PaneHeader` | 1 | 3 / 3 | 8 / 8 | 0 / 0 | **PASS** |
| `chat-card/UnitChromeActions` | 1 | 5 / 5 | 2 / 2 | 2 / 2 | **PASS** |
| **全仓总计** | **38** | **401 / 399** | **265 / 263** | **45 / 45** | <span style="color:red;font-weight:bold;">FAIL</span> |

#### 2. 286 处输出的数学闭环机制
查看 `scripts/check-hierarchy-ssot.mjs:451-466`：门禁设定为“**只要某个覆盖域实测超出基线（`cur > base`），就将该域下的所有 H1、H2、H3 违规项全量展开输出**”。
- 现场超标覆盖域仅有 2 个：`chat-composer` 与 `sidebar`；
- `chat-composer` 域：$H1(101) + H2(71) + H3(6) = \mathbf{178}$ 处；
- `sidebar` 域：$H1(44) + H2(53) + H3(11) = \mathbf{108}$ 处；
- 两域展开合计：$178 + 108 = \mathbf{286}$ 处明细输出！
- **结论**：并不是全仓突然爆发 286 处新问题，而是因为仅仅 **4 处增量违规** 突破了棘轮基线，导致门禁倾倒出两域已有的全部存量历史技术债务！

#### 3. 超标元凶代码级定位
1. **`chat-composer` H1 超标元凶**：  
   位于 [`PermissionModeMenu.module.css:258-275`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css#L258-L275)：
   ```css
   .title,
   .itemLabel {
     font-size: var(--font-size-sm, 13px); /* ❌ H1: 旧字阶 token: --font-size-sm */
     font-weight: 500;                     /* ❌ H1: 硬编码字重: 500 */
     line-height: 1.25;                    /* ❌ H1: 硬编码行高: 1.25 */
     ...
   }
   .itemDesc {
     font-size: var(--font-size-xs, 11px); /* ❌ H1: 旧字阶 token: --font-size-xs */
     line-height: 1.25;
   }
   ```
   历史基线中 `.itemLabel` 原先并未裸写 `font-size` 与 `font-weight: 500`。最近的微调提交写入了这两行，净增 2 处违规，使 H1 达到 101（基线 99），触发红线阻断。
2. **`sidebar` H2 超标元凶**：  
   位于 [`ProjectManageModal.module.css:80-107`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css#L80-L107)：
   ```css
   .dropzoneIconWrapper {
     ...
     border: 1px solid var(--border-subtle); /* ❌ H2: 未走预算的展示容器实体描边 */
   }
   .folderPickerDropzone:hover .dropzoneIconWrapper {
     border-color: color-mix(               /* ❌ H2: 未走预算的实体描边色彩 */
       in srgb,
       var(--border-subtle) 95%,
       var(--text-primary) 5%
     );
   }
   ```
   新设计的文件夹拖拽包装容器引入了带实体边框的图标背景，未接入 `--edge-rim` 或 `--edge-control` 白名单，导致 `sidebar` 域 H2 净增 2 处，从 51 飙升至 53（基线 51），触发红线阻断。
3. **`chat-composer` H2 跨行扫描器陷阱**：  
   在 [`ChatComposer.module.css:79-110`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L79-L110) 中，开发者声明了合法白名单 `--edge-focus`，但由于 Prettier 格式化将 `border-color: var(` 与 `--edge-focus` 分拆在不同行：
   ```css
   /* 第 88 行 */
   border-color: var(
     --edge-focus,
     color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)
   );
   ```
   门禁脚本逐行正则匹配时，第 88 行命中了 `border-color:` 但未在同一行检测到 `--edge-focus`，产生 1 处虚假 H2 违规，导致 composer H2 实测为 72（基线 71）。

---

### 2.2 Windows 微软雅黑物理字形断层实证（400/700 物理真实 vs 500/600 伪粗体锯齿）

在本次重构中，必须以确凿的计算机字体物理事实统一认知：

#### 1. 字体文件物理检查实证
在 Windows 10 / 11 操作系统标准字体库（`C:\Windows\Fonts\`）中，中文字体事实如下：
- **微软雅黑（Microsoft YaHei）仅有两个物理 TTC 字体文件**：
  1. `msyh.ttc`（Microsoft YaHei Regular，内建物理权重：**400**）；
  2. `msyhbd.ttc`（Microsoft YaHei Bold，内建物理权重：**700**）。
- **实测结论**：**Windows 原生微软雅黑字体不存在 500（Medium）或 600（SemiBold）的物理字形文件**！

#### 2. DirectWrite 渲染器回退与算法伪粗体（Faux Bold）机制
当 Web 应用在 WebView2（Chromium 内核 + Windows DirectWrite 渲染底座）中声明 `font-weight: 500` 或 `font-weight: 600` 时，DirectWrite 引擎将按如下规则处理：
```mermaid
flowchart TD
  Decl["CSS 声明字重"] --> Decision{"字重数值判断"}
  Decision -- "font-weight: 500" --> Fallback400["物理字形缺失<br/>DirectWrite 自动降级回退至 400 Regular<br/>（与普通正文毫无区别，层级假设失效！）"]
  Decision -- "font-weight: 600" --> FauxBold["物理字形缺失<br/>Chromium 触发算法轮廓描边 (Faux Bold)<br/>（笔画交叉处模糊发黑，边缘锯齿毛刺，文字发糊！）"]
  Decision -- "font-weight: 400" --> True400["精准渲染 msyh.ttc 400 物理点阵/矢量轮廓 (锐利清爽)"]
  Decision -- "font-weight: 700" --> True700["精准渲染 msyhbd.ttc 700 物理字形 (强统治力，骨架匀称)"]
```
- **架构危害**：
  前端过去存在“340 处 500/600 字重暴露量”，这些自以为“比正文稍微粗一点点、比粗体又柔和一点”的微妙设计假说，在 90% 以上的 Windows 桌面客户端上**不仅完全无法建立层级，反而导致视觉退化或发虚发糊**。
- **不可退避裁决**：
  全仓禁止裸写 500 与 600，彻底两档化为 `--fw-regular: 400` 与 `--fw-strong: 700`。任何层级区分改由“字阶（12/14/16px）+ 对比度（16.9:1 vs 9.8:1）+ 留白接近性”承担！

---

### 2.3 13px 模糊断层与全仓 1px 细碎字阶乱象

历史代码充斥大量 `13px`（以及别名 `--font-size-sm: 13px`）：
- 现状盘查表明：全仓曾存在 10.5px、11px、11.5px、12px、12.5px、13px、13.5px、14px、14.5px 连续以 0.5px~1px 细碎级差递增的混乱局面；
- 人眼在距离显示器 50~70cm 时，**根本无法有效分辨 13px 与 14px 的语义权重大差**，反而导致界面信息流缺乏节奏感，如同蒙上一层灰雾；
- 在 Windows 100% / 125% / 150% 等奇数缩放 DPI 下，13px 极易发生子像素渲染对齐偏差，导致汉字横竖笔画粗细不均。
- **裁决**：彻底清退 13px，建立步长 $\ge 2\text{px}$ 的标准 6 档字阶网格。

---

### 2.4 硬编码行高（1.2, 1.5, 20px 等）破坏垂直韵律与无障碍失真

全仓各组件中大量裸写数字行高：
1. **`line-height: 1.2` 与 `1.25`**：在微型标签上导致汉字上下被紧咬，在带重音符号或英文延伸部（g, j, p, q, y）时产生基线裁切溢出；
2. **`line-height: 1.5`**：散落在 `AnnotationChipItem` 等组件，属于 Bootstrap 式野蛮遗留，无法与项目 24px 网格基线槽对齐；
3. **固定像素行高 `20px`, `22px`, `28px`**：
   在 `ChatComposer.module.css` 与 `SidebarSessionList.module.css` 中大量使用。当用户在无障碍设置中开启 `--font-size-adjust`（例如大字体模式放大 +2px）时，字号变为 16px 但行高仍锁死在 20px，导致文字上下行严重重叠、不可阅读。必须收敛至语义化相对比例。

---

### 2.5 `check:markdown-style` 74 处假阳性报错根因与 Token 完备性穿透

运行 `npm run check:markdown-style` 提示 74 处违规，报错声称“从 tokens.css 解析到 0 个有效 Design Token 声明”，进而将 [`markdown-typography.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/markdown-typography.css) 中引用的所有 `--md-*` 变量判定为非法未定义。

#### 1. 根因穿透
- 架构演进中，单一巨石文件 `tokens.css` 已被物理拆分为 9 个模块（`tokens-base.css` 至 `tokens-components.css`），入口 `tokens.css` 仅包含 9 条 `@import` 语句；
- 门禁脚本 [`scripts/check-markdown-style-compliance.mjs:65-71`](file:///c:/Software/conex/scripts/check-markdown-style-compliance.mjs#L65-L71) 仅读取 `tokens.css` 单文件，未解析 `@import` 语法，导致白名单集合为空集合（`declaredTokens.size === 0`）；
- 任何消费 `var(--md-*)` 的有效代码均被误报。

#### 2. 46 个 `--md-*` 变量物理完备性实测
编写 AST 递归解析展开 9 个模块后实测：
- 全仓声明有效 Token **845 个**；
- `markdown-typography.css` 引用的 46 个 `--md-*` 变量，**100% 完整声明在 [`tokens-components.css:143-230`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-components.css#L143-L230) 与 `510-580` 行**（日间/暗色双态完备无缺）；
- **结论**：业务样式与 Token 体系 100% 正确合规，该问题为典型的“门禁工具未同步适配架构拆分”引起的假阳性误报。

---

### 2.6 `markdown-typography.css` 内部自身残存的旧 Token 与排版隐患

虽然 `markdown-typography.css` 位于 `src/styles/`（未纳入组件域 H1 扫描），但审计发现其内部依然残留历史旧字阶与非标字重：
- Line 72: `font-size: var(--font-size-sm, 13px);`（表格文字仍停留于 13px 模糊断层）；
- Line 86, 844: `font-weight: 600;`（表头与强调硬编码 600，在 Windows 触发伪粗体锯齿）；
- Line 138, 572, 585, 661: `font-size: var(--font-size-xs, 12px);`（依赖旧别名 `--font-size-xs`）；
- Line 241: `font-weight: 500;`（H6 硬编码 500）；
- Line 649, 681: `font-size: var(--font-size-micro, 11px);`（使用了已清退的 `--font-size-micro`）；
- Line 760: `line-height: var(--line-height-body, 1.55);`（使用了旧变量名，应为 `--lh-prose`）。
必须在本战役中将其一并收口治理！

---

## 3 目标架构与排版系统 SSOT 契约

依据 [`P0-基线与度量底座.md`](file:///c:/Software/conex/docs/visual-hierarchy-clarity-analysis/P0-基线与度量底座.md) 与 [`P2-文字阶梯与排版角色.md`](file:///c:/Software/conex/docs/visual-hierarchy-clarity-analysis/P2-文字阶梯与排版角色.md)，确立排版与层级终极真理源契约：

### 3.1 6 档标准字阶体系与 13px 彻底升降级契约

全仓字号阶梯刚性收敛至以下 6 档标准变量（定义于 [`tokens-type.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-type.css)）：

```css
/* 标准 6 档字阶体系（步长 >= 2px，支持无障碍统一缩放） */
--font-size-adjust: 0px;
--font-size-caption: calc(11px + var(--font-size-adjust, 0px)); /* 徽标、微型计数、辅助角标 */
--font-size-meta:    calc(12px + var(--font-size-adjust, 0px)); /* 过程行、时间戳、代码块元信息、侧栏副流 */
--font-size-body:    calc(14px + var(--font-size-adjust, 0px)); /* 正文基准、表单输入框、按钮文本、主流正文 */
--font-size-subhead: calc(16px + var(--font-size-adjust, 0px)); /* 卡片标题、H3 标题、弹窗副标题 */
--font-size-heading: calc(18px + var(--font-size-adjust, 0px)); /* 节标题、H2 标题、一级视图顶栏 */
--font-size-title:   calc(22px + var(--font-size-adjust, 0px)); /* 篇章大标题、H1 报告大标题 */
```

#### 13px 升降级铁律（Clean Cut 确定性裁定）
彻底退役 13px（`--font-size-sm` 与字面量 `13px`），按语义流向单向归流，禁止任何中间态：
1. **主流升档至 14px（`--font-size-body`）**：
   - 聊天输入框主体文本、表单输入框、下拉框主选项文本；
   - Markdown 表格正文、数据列表正文行；
   - 模态框操作项主标题（如 `PermissionModeMenu .title, .itemLabel`）。
2. **副流降档至 12px（`--font-size-meta`）**：
   - 侧栏会话次级信息、搜索结果元信息、时间戳、快捷键说明；
   - 附件卡片描述、文件大小指示器；
   - Markdown 引用块辅助信息、代码块行号。

---

### 3.2 字重严格两档化模型（`--fw-regular: 400` vs `--fw-strong: 700`）

全仓彻底废弃 `500` 与 `600` 字面量及 `--font-weight-medium`、`--font-weight-semibold`、`--font-weight-content` 等别名，仅保留两档语义字重：

```css
/* 字重两档化 SSOT 契约 */
--fw-regular: 400; /* 常规文本、输入内容、次级标题、列表项、正文 */
--fw-strong:  700; /* 具有绝对统治力的大标题、重要高亮、重要模态框强调 */
```

- **映射收敛判据**：
  - 凡原先出于“让文字稍微显眼一点”而标注的 `font-weight: 500`（如按钮、普通标签、未激活标题、会话列表条目），**100% 收敛为 `--fw-regular: 400`**；文字突出依靠色彩对比度（`--text-primary` 对比度 16.9:1 vs `--text-tertiary` 6.3:1）拉开。
  - 凡原先出于“卡片标题、H1~H3 标题、确认对话框警告”而标注的 `font-weight: 600`，**统一收敛为 `--fw-strong: 700`**，由 Windows 原生 `msyhbd.ttc` 物理字形精准着色渲染。

---

### 3.3 4 档垂直韵律行高体系（`--lh-dense`, `--lh-ui`, `--lh-prose`, `--lh-row`）

全仓禁止使用任何裸写数字行高（如 1.2, 1.5, 20px, 22px），统一收敛至 4 档语义比例：

```css
/* 4 档行高阶梯（SSOT 契约） */
--lh-dense: 1.25; /* 紧凑标题、徽标、微型标签、权限模式紧凑菜单 */
--lh-ui:    1.35; /* 交互控件、输入框、按钮、单行列表项、选择器 */
--lh-prose: 1.65; /* 长段落正文、阅读流、Markdown 长文本 */
--lh-row:   24px; /* 过程行、工具调用槽位、虚拟滚动单元行高基线 */
```

- **固定高度容器规约**：禁止使用 `line-height: 28px` 来撑开盒子高度，必须重构为 `min-height: 28px; line-height: var(--lh-ui); display: flex; align-items: center;`，确保在大字体无障碍缩放下文字不产生垂直溢出。

---

### 3.4 清退复合排版与墨色死层，全面收敛至原子字阶与语义文字色

根据评审裁决（`reviews/02-review-visual-tokens-and-primitives.md` §2.1）与《反过度设计红线》（`ANTI_OVERENGINEERING_GUARDRAILS.md`），**彻底废止纸面过度设计的“复合排版角色”（`--type-*` 9项）与“语义墨色”（`--ink-*` 7项）**，完全对齐 P02 §4.2 Cat-B 的物理删除决策：

#### 1. 废除复合角色层的三大硬性依据
1. **真实消费量为零**：全仓 200 个现存 CSS 模块与 2,575 个代码文件中，对 `--type-*` 与 `--ink-*` 的消费量为严格的 0 处，属于未经实战检验的纸面概念堆叠；
2. **CSS `font:` 简写的破坏性**：CSS 规范中 `font:` 简写会强制重置 `font-style`、`letter-spacing`、`line-height` 等所有未声明属性，极易导致样式层叠断裂与覆盖失效，现代前端已全面弃用；
3. **概念重复与真理源污染**：`--ink-*` 与既有的 `--text-primary / secondary / tertiary / quiet` 完全同义重复，制造了毫无价值的双轨模型。

#### 2. 全仓原子化单一真理源（SSOT）契约
全仓组件必须且仅能消费正交独立的原子排版 Token：
- **字号（Size）**：`var(--font-size-caption | meta | body | subhead | heading | title)`（6 档）；
- **行高（Line Height）**：`var(--lh-dense | ui | prose | row)`（4 档）；
- **字重（Weight）**：`var(--fw-regular | fw-strong)`（两档化 400 / 700）；
- **文字色（Color）**：`var(--text-primary | text-secondary | text-tertiary | text-quiet | text-danger)`；
- **字体栈（Font Family）**：`var(--font-sans)` 与 `var(--font-mono)`。

```css
/* 标准排版样式示范：原子属性清晰正交，零简写冲突 */
.processRow {
  font-size: var(--font-size-meta);
  line-height: var(--lh-row);
  font-weight: var(--fw-regular);
  color: var(--text-secondary);
}

.cardTitle {
  font-size: var(--font-size-subhead);
  line-height: var(--lh-ui);
  font-weight: var(--fw-strong);
  color: var(--text-primary);
}
```

---

### 3.5 展示容器实体描边清退与表面明度阶梯（Surface Steps）+ `--edge-rim` 规范

依据 [`P1-表面阶梯SSOT.md`](file:///c:/Software/conex/docs/visual-hierarchy-clarity-analysis/P1-表面阶梯SSOT.md)，Crish 前端界面彻底告别“用粗灰线到处圈框”的视觉线噪模式：

```mermaid
flowchart LR
  Canvas["Level 0: Canvas 底板<br/>#141414"] --> Shell["Level 1: Shell 侧栏/底座<br/>#1a1a1a"]
  Shell --> Card["Level 2: Card 会话列表/浮层<br/>#202020"]
  Card --> Raised["Level 3: Raised 输入框/激活项<br/>#262626"]
```

1. **展示型容器（Card / List / Item / Panel）**：
   - 彻底删除 `border: 1px solid var(--border-subtle)` 等实体描边；
   - 层级完全依靠背景明度级差（Luminance Steps，明度差 $\Delta L \ge 3\%$）自然划分。
2. **边缘微光预算（Edge Budget 白名单）**：
   - 当大浮层或卡片在低对比度显示器上需要微弱边缘提示时，**唯一允许使用 `--edge-rim`**（极淡微光发丝线：`hsl(0 0% 100% / 0.05)`）；
   - 可交互表单与输入框允许使用 `--edge-control`；
   - 聚焦态统一使用 `--edge-focus`；
   - 错误与警告状态使用 `--edge-semantic-*`。

---

### 3.6 全仓 Markdown 渲染流 46 个 `--md-*` Token 100% 消费契约

Markdown 渲染引擎（`MarkdownDocumentView`、`StreamingMarkdownView` 等）必须保持 100% 消费在 [`tokens-components.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-components.css) 中声明的 46 个 `--md-*` 变量。严禁组件内私自覆写：

| 分类 | 权威 Token 标识符 | 规范取值与基线 | 职责定义 |
| :--- | :--- | :--- | :--- |
| **基础排版** | `--md-font-family`, `--md-font-mono`, `--md-line-height-body`, `--md-paragraph-margin-bottom` | `--font-sans`, `--font-mono`, `--lh-prose`, `0.88em` | 全文基底、长段落阅读舒适流 |
| **标题体系** | `--md-h1-size` ~ `--md-h6-size` | 22px / 18px / 16px / 14px / 14px / 12px | 与标准 6 档字阶 100% 严格吻合 |
| | `--md-heading-color`, `--md-heading-font-weight` | `var(--text-primary)`, `var(--fw-strong)` | 纯亮标题统治力，强骨架 |
| | `--md-h1-border`, `--md-h2-border` | `1px solid var(--edge-rim)`, `none` | H1 底衬微光发丝线，H2 留白划分 |
| **代码块** | `--md-code-inline-bg/fg/radius`, `--md-code-block-bg/border/radius`, `--md-code-font-size/tab-size`, `--md-code-header-bg/border/fg`, `--md-code-copy-hover-bg` | 契约变量 | 行内代码胶囊与全功能代码块 |
| **引用与列表**| `--md-quote-border/bg/padding`, `--md-list-padding-left/item-margin`, `--md-task-box-size/check-stroke` | 契约变量 | 块引用与 GFM 任务清单状态机 |
| **表格系统** | `--md-table-cell-padding`, `--md-table-cell-padding-compact` | `10px 14px`, `8px 10px` | 舒适模式与紧凑模式单元格 |
| **超链接** | `--md-link-underline-color`, `--md-path-link-bg/fg` | `color-mix(...)`, 契约变量 | 半透明优雅下划线与路径链接 |

---

## 4 紧急解阻工程详案（Phase 1：增量止血与门禁脱困）

为以最快速度恢复 CI 门禁全绿，解除对日常研发流程的阻断，第一阶段实施以下 4 项零破坏性紧急整改：

### 4.1 任务 1：升级 `check-markdown-style-compliance.mjs` 支持 `@import` 依赖链解析

- **目标文件**：[`scripts/check-markdown-style-compliance.mjs`](file:///c:/Software/conex/scripts/check-markdown-style-compliance.mjs)
- **根因**：门禁脚本直读拆分后的入口 `tokens.css`，未能读取 9 个模块文件，误报 74 处违规。
- **重构方案**：将单文件读取重构为递归 `@import` 解析器，自动遍历并合并所有被导入 CSS 模块中的 `--*` 变量声明。

#### 完整升级代码落地
```javascript
// scripts/check-markdown-style-compliance.mjs 核心解析函数重构
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// 递归展开所有 @import 依赖并收集全部声明的 CSS Token
function collectDeclaredTokens(entryFilePath) {
  const declaredTokens = new Set();
  const tokenDeclRegex = /(--[a-zA-Z0-9_-]+)\s*:/g;
  const importRegex = /@import\s+['"]([^'"]+)['"];/g;
  const visitedFiles = new Set();

  function traverse(currentPath) {
    const absPath = resolve(currentPath);
    if (visitedFiles.has(absPath) || !existsSync(absPath)) return;
    visitedFiles.add(absPath);

    const content = readFileSync(absPath, 'utf-8');
    const baseDir = dirname(absPath);

    // 1. 递归解析当前文件的所有 @import 依赖
    let importMatch;
    while ((importMatch = importRegex.exec(content)) !== null) {
      const relImportPath = importMatch[1];
      const targetPath = resolve(baseDir, relImportPath);
      traverse(targetPath);
    }

    // 2. 提取当前文件内所有以 -- 开头的变量声明
    let tokenMatch;
    while ((tokenMatch = tokenDeclRegex.exec(content)) !== null) {
      declaredTokens.add(tokenMatch[1]);
    }
  }

  traverse(entryFilePath);
  return declaredTokens;
}

// 替换原有单文件读取：
const declaredTokens = collectDeclaredTokens(TOKENS_CSS_PATH);
console.log(`📋 从 tokens.css 依赖链递归解析到 ${declaredTokens.size} 个有效 Design Token 声明。`);
```

- **验证预期**：解析 Token 数量由 0 跃升至 845 个，`npm run check:markdown-style` 瞬间恢复 **100% PASS**（74 处假阳性报错彻底清零）。

---

### 4.2 任务 2：彻底重构 `PermissionModeMenu.module.css:259-275`

- **目标文件**：[`apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css)
- **根因**：新增了非法旧字阶 `--font-size-sm (13px)` 与裸字面量 `font-weight: 500`、`line-height: 1.25`，使 `chat-composer` H1 突破基线 99 达到 101。
- **重构方案**：拔除非标旧字阶，接入标准 `--font-size-body`（14px 舒适可读主流）与 `--fw-regular`（400 物理字重），行高接入 `--lh-dense`。

#### 重构代码前后对比
```diff
--- a/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css
+++ b/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css
@@ -256,19 +256,19 @@
 .title,
 .itemLabel {
-  font-size: var(--font-size-sm, 13px);
-  font-weight: 500;
-  line-height: 1.25;
+  font-size: var(--font-size-body);
+  font-weight: var(--fw-regular);
+  line-height: var(--lh-dense);
   color: var(--text-primary);
   white-space: nowrap;
   overflow: hidden;
   text-overflow: ellipsis;
 }
 
 .itemDesc {
-  font-size: var(--font-size-xs, 11px);
+  font-size: var(--font-size-caption);
+  font-weight: var(--fw-regular);
+  line-height: var(--lh-dense);
   color: var(--text-tertiary);
-  line-height: 1.25;
   overflow: hidden;
   text-overflow: ellipsis;
   white-space: nowrap;
```
- **预期收益**：直接消减 3 处 H1 违规，`chat-composer` 域 H1 从 101 回落至 **98（$\le 99$ 基线）**！

---

### 4.3 任务 3：彻底重构 `ProjectManageModal.module.css:80-108`

- **目标文件**：[`apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css)
- **根因**：新增的 `.dropzoneIconWrapper` 声明了未在 `--edge-*` 预算内的灰线描边 `border: 1px solid var(--border-subtle)`，导致 `sidebar` 域 H2 违规增至 53（基线 51）。
- **重构方案**：全面清退实体灰线，接入微光发丝线 `--edge-rim` 与控件边框 `--edge-control`。

#### 重构代码前后对比
```diff
--- a/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css
+++ b/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css
@@ -85,7 +85,7 @@
   height: 38px;
   border-radius: var(--radius-sm, 6px);
   background: var(--tint-hover);
-  border: 1px solid var(--border-subtle);
+  border: 1px solid var(--edge-rim);
   color: var(--text-secondary);
   margin-bottom: 2px;
   transition:
@@ -97,7 +97,7 @@
 .folderPickerDropzone:hover .dropzoneIconWrapper {
   background: var(--tint-active, var(--bg-hover));
-  border-color: color-mix(
-    in srgb,
-    var(--border-subtle) 95%,
-    var(--text-primary) 5%
-  );
+  border-color: var(--edge-control);
   color: var(--text-primary);
   transform: translateY(-1px);
 }
```
- **预期收益**：直接消减 2 处 H2 违规，`sidebar` 域 H2 从 53 回落至 **51（$\le 51$ 基线）**！

---

### 4.4 任务 4：修复 `ChatComposer.module.css` 跨行声明导致的单行扫描器误判

- **目标文件**：[`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css:80-115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L80-L115)
- **根因**：第 88 行与第 109 行的 `border-color: var(` 跨行书写，单行门禁扫描器未能感知后续行的 `--edge-focus` 白名单，误判产生 1 处 H2。
- **重构方案**：将白名单变量引用收敛在声明行单行之内，或直接内联。

#### 重构代码
```diff
--- a/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
+++ b/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css
@@ -85,10 +85,7 @@
   --edge-focus: color-mix(
     in srgb,
     var(--border-color) 94%,
     var(--text-primary) 6%
   );
-  border-color: var(
-    --edge-focus,
-    color-mix(in srgb, var(--border-color) 94%, var(--text-primary) 6%)
-  );
+  border-color: var(--edge-focus);
   box-shadow: var(--composer-shadow);
   outline: none;
 }
```
- **预期收益**：消减 1 处虚假 H2 违规，`chat-composer` 域 H2 回落至 **71（$\le 71$ 基线）**！

---

### 4.5 紧急解阻验证与门禁恢复 PASS 断言

执行上述 4 项重构后，再次运行校验命令，断言输出矩阵如下：

```text
=== Visual Hierarchy & Clarity SSOT 门禁校验报告 ===
--------------------------------------------------------------------------------
覆盖域                           文件数     H1(实测/基线)       H2(实测/基线)       H3(实测/基线)       状态
--------------------------------------------------------------------------------
chat-message-row              11      85/85           58/58           25/25           PASS
chat-message                  3       12/12           5/5             0/0             PASS
chat-message-list             4       22/22           10/11           1/1             PASS
chat-tool-call                3       129/129         57/57           0/0             PASS
chat-composer                 15      98/99           71/71           6/6             PASS
sidebar                       5       44/44           51/51           11/11           PASS
top-bar                       1       0/0             0/0             0/0             PASS
binary-tree/PaneHeader        1       3/3             8/8             0/0             PASS
chat-card/UnitChromeActions   1       5/5             2/2             2/2             PASS
--------------------------------------------------------------------------------
总计                            38      398/399         262/263         45/45           PASS
================================================================================
```

- `check:hierarchy-ssot` 退出码为 **0**；
- `check:markdown-style` 退出码为 **0**；
- **286 处大面积违规倾倒瞬间消失，全仓 9 大覆盖域全部转绿 PASS！**

---

## 5 全仓系统性收敛与自动化 Codemod 施工详案（Phase 2 ~ Phase 4）

在解除门禁阻断后，必须依据反退避原则启动地毯式系统性收敛，将存量 700+ 处历史违规以自动化脚本一次性根绝，杜绝双轨妥协。

### 5.1 全仓字阶升降级与行高收敛 Codemod 实现（`scripts/codemod-typography-ssot.mjs`）

创建确定性重写工具 [`scripts/codemod-typography-ssot.mjs`](file:///c:/Software/conex/scripts/codemod-typography-ssot.mjs)，支持全仓 `.module.css` 样式文件及 `.tsx` / `.ts` 源码中行内样式的 AST/正则安全替换。

#### 核心替换规约引擎
```javascript
#!/usr/bin/env node
/**
 * scripts/codemod-typography-ssot.mjs
 * 全仓字阶与行高 SSOT 自动化转换引擎（覆盖 CSS 与 TSX 行内样式）
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TARGET_DIR = path.resolve(REPO_ROOT, 'apps/crish-desktop/src');

// 1. CSS 模块语义上下文感知替换规约
function transformCss(content, filePath) {
  let modified = content;

  // A. 13px 旧字阶替换：按上下文进行升降级
  // 属于侧栏、时间戳、元数据、附件副标签的降级至 12px (meta)
  const isSecondaryContext = /sidebar|meta|timestamp|badge|tag|breadcrumb|tip|chip/i.test(filePath);
  const smReplacement = isSecondaryContext ? 'var(--font-size-meta)' : 'var(--font-size-body)';

  modified = modified.replace(/var\(\s*--font-size-sm\s*(?:,\s*13px)?\s*\)/g, smReplacement);
  modified = modified.replace(/(?:^|[;{\s])font-size:\s*13px\s*;/g, (m) => m.replace('13px', smReplacement));
  modified = modified.replace(/(?:^|[;{\s])font-size:\s*13\.5px\s*;/g, (m) => m.replace('13.5px', smReplacement));

  // B. 细碎旧字号别名清退
  modified = modified.replace(/var\(\s*--font-size-xs\s*(?:,\s*12px)?\s*\)/g, 'var(--font-size-meta)');
  modified = modified.replace(/var\(\s*--font-size-xs\s*(?:,\s*11px)?\s*\)/g, 'var(--font-size-caption)');
  modified = modified.replace(/var\(\s*--font-size-nano\s*(?:,[^)]+)?\s*\)/g, 'var(--font-size-caption)');
  modified = modified.replace(/var\(\s*--font-size-micro\s*(?:,[^)]+)?\s*\)/g, 'var(--font-size-caption)');
  modified = modified.replace(/var\(\s*--font-size-base\s*(?:,[^)]+)?\s*\)/g, 'var(--font-size-body)');
  modified = modified.replace(/var\(\s*--font-size-md\s*(?:,[^)]+)?\s*\)/g, 'var(--font-size-subhead)');
  modified = modified.replace(/var\(\s*--font-size-lg\s*(?:,[^)]+)?\s*\)/g, 'var(--font-size-heading)');
  modified = modified.replace(/var\(\s*--font-size-xl\s*(?:,[^)]+)?\s*\)/g, 'var(--font-size-title)');

  // C. 裸写像素字阶收敛至 6 档
  modified = modified.replace(/(?<=font-size:\s*)11px(?=\s*;)/g, 'var(--font-size-caption)');
  modified = modified.replace(/(?<=font-size:\s*)12px(?=\s*;)/g, 'var(--font-size-meta)');
  modified = modified.replace(/(?<=font-size:\s*)14px(?=\s*;)/g, 'var(--font-size-body)');
  modified = modified.replace(/(?<=font-size:\s*)16px(?=\s*;)/g, 'var(--font-size-subhead)');
  modified = modified.replace(/(?<=font-size:\s*)18px(?=\s*;)/g, 'var(--font-size-heading)');
  modified = modified.replace(/(?<=font-size:\s*)(?:20px|22px)(?=\s*;)/g, 'var(--font-size-title)');

  // D. 裸写行高收敛至 4 档标准语义比例
  modified = modified.replace(/(?<=line-height:\s*)(?:1\.2|1\.25)(?=\s*;)/g, 'var(--lh-dense)');
  modified = modified.replace(/(?<=line-height:\s*)(?:1\.35|1\.4)(?=\s*;)/g, 'var(--lh-ui)');
  modified = modified.replace(/(?<=line-height:\s*)(?:1\.5|1\.55|1\.6|1\.65)(?=\s*;)/g, 'var(--lh-prose)');
  modified = modified.replace(/(?<=line-height:\s*)(?:20px|22px|24px)(?=\s*;)/g, 'var(--lh-row)');

  // E. 清除 font-size: 0 黑魔法（转换为 flex gap: 0 无障碍模型）
  if (modified.includes('font-size: 0;')) {
    modified = modified.replace(/font-size:\s*0;\s*line-height:\s*1;/g, 'display: flex; gap: 0;');
  }

  return modified;
}

// 2. TSX / TS 源码中行内样式扫描与收敛规约（杜绝死角）
function transformTsx(content, filePath) {
  let modified = content;

  // 收敛 entry-core.tsx:441 中的硬编码字符串样式
  if (filePath.endsWith('entry-core.tsx')) {
    modified = modified.replace(/font-size:13px;font-weight:500;/g, 'font-size:var(--font-size-body);font-weight:var(--fw-regular);');
  }

  // 收敛 ModelBadgePickerMenu.tsx:280 等组件中的 style={{ fontSize: 'var(--font-size-sm, 13px)' }}
  modified = modified.replace(/fontSize:\s*['"]var\(--font-size-sm,\s*13px\)['"]/g, "fontSize: 'var(--font-size-body)'");
  modified = modified.replace(/fontSize:\s*['"]13px['"]/g, "fontSize: 'var(--font-size-body)'");

  return modified;
}
```

---

### 5.2 全仓 Windows 字重两档化与排版原子契约接入 Codemod（`scripts/codemod-font-weights-and-roles.mjs`）

#### 核心字重两档化清洗规则
```javascript
#!/usr/bin/env node
/**
 * scripts/codemod-font-weights-and-roles.mjs
 * Windows 字体物理对齐：字重两档化 (400/700) 转换引擎
 */
import fs from 'node:fs';
import path from 'node:path';

function transformWeights(content, filePath) {
  let modified = content;

  // 1. 废弃字重 Token 转换
  modified = modified.replace(/var\(\s*--font-weight-normal\s*\)/g, 'var(--fw-regular)');
  modified = modified.replace(/var\(\s*--font-weight-code\s*\)/g, 'var(--fw-regular)');
  modified = modified.replace(/var\(\s*--font-weight-medium\s*(?:,[^)]+)?\s*\)/g, 'var(--fw-regular)');
  modified = modified.replace(/var\(\s*--font-weight-content\s*(?:,[^)]+)?\s*\)/g, 'var(--fw-strong)');
  modified = modified.replace(/var\(\s*--font-weight-semibold\s*(?:,[^)]+)?\s*\)/g, 'var(--fw-strong)');
  modified = modified.replace(/var\(\s*--font-weight-heavy\s*(?:,[^)]+)?\s*\)/g, 'var(--fw-strong)');

  // 2. 裸字重字面量转换（按角色区分 400 与 700）
  const isTitleOrHeading = /title|heading|header|dialogtitle|modaltitle/i.test(filePath);

  // 裸 500 一律收敛为 regular (400)
  modified = modified.replace(/(?<=font-weight:\s*)500(?=\s*;)/g, 'var(--fw-regular)');
  // 裸 600 一律收敛为 strong (700)
  modified = modified.replace(/(?<=font-weight:\s*)600(?=\s*;)/g, 'var(--fw-strong)');
  // 裸 400 / normal 收敛为 regular
  modified = modified.replace(/(?<=font-weight:\s*)(?:400|normal)(?=\s*;)/g, 'var(--fw-regular)');
  // 裸 700 / bold 收敛为 strong
  modified = modified.replace(/(?<=font-weight:\s*)(?:700|bold)(?=\s*;)/g, 'var(--fw-strong)');

  return modified;
}
```

---

### 5.3 展示型容器实体描边清退与 `--edge-rim` 迁移 Codemod

针对全仓 260+ 处未走预算的展示容器实体描边：
1. **纯展示卡片与面板（`.card`, `.panel`, `.container`）**：
   - 将 `border: 1px solid var(--border-subtle);` 重构为依靠底板表面级差划分；
   - 若必须保持边缘轮廓，统一改写为 `border: 1px solid var(--edge-rim, transparent);`；
2. **列表项与操作栏分隔（`.divider`, `.itemRow`）**：
   - 统一改写为 `border-bottom: 1px solid var(--edge-rim, transparent);` 或使用原生 `gap: var(--space-row-gap)`；
3. **交互表单输入控件（`input`, `select`, `textarea`）**：
   - 统一改写为 `border: 1px solid var(--edge-control);`。

---

### 5.4 `markdown-typography.css` 内部 13px 与旧 Token 彻底清剿落地

直接针对 [`apps/crish-desktop/src/styles/markdown-typography.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/markdown-typography.css) 执行就地重塑：

```diff
--- a/apps/crish-desktop/src/styles/markdown-typography.css
+++ b/apps/crish-desktop/src/styles/markdown-typography.css
@@ -72,7 +72,7 @@
   .conex-markdown table {
-    font-size: var(--font-size-sm, 13px);
+    font-size: var(--font-size-body);
     border-collapse: collapse;
   }
@@ -86,7 +86,7 @@
   .conex-markdown th {
-    font-weight: 600;
+    font-weight: var(--fw-strong);
     background: var(--surface-card);
   }
@@ -138,7 +138,7 @@
   .conex-markdown .table-footnote {
-    font-size: var(--font-size-xs, 12px);
+    font-size: var(--font-size-meta);
   }
@@ -241,7 +241,7 @@
   .conex-markdown h6 {
-    font-weight: 500;
+    font-weight: var(--fw-regular);
   }
@@ -649,7 +649,7 @@
   .conex-markdown .code-lang-badge {
-    font-size: var(--font-size-micro, 11px);
+    font-size: var(--font-size-caption);
   }
@@ -760,7 +760,7 @@
   .conex-markdown pre code {
-    line-height: var(--line-height-body, 1.55);
+    line-height: var(--lh-prose);
   }
```

---

### 5.5 物理清除 `tokens-type.css` 与 `tokens-text.css` 中的别名与复合角色死码

在全仓完成上述 Codemod 替换且单测全量跑通后，执行负代码清退，彻底消除死 Token（与 P02 §4.2 Cat-B 决策 100% 对齐）：

1. **物理清退复合排版角色死层（9项，`tokens-type.css:85-102`）**：
   - `--type-prose`, `--type-process`, `--type-label`, `--type-meta`, `--type-caption`, `--type-card-title`, `--type-heading`, `--type-title`, `--type-code`（全量物理删除）；
2. **物理清退语义墨色死层（7项，`tokens-text.css:32-40`）**：
   - `--ink-prose`, `--ink-process`, `--ink-meta`, `--ink-caption`, `--ink-card-title`, `--ink-title`, `--ink-code`（全量物理删除）；
3. **物理清退历史临时别名死码（25项，`tokens-type.css:111-139`）**：
   从 [`tokens-type.css:111-139`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-type.css#L111-L139) 物理删除以下 25 行临时兼容死码，禁止双轨妥协：

```css
/* 彻底物理删除以下历史别名包袱，禁止双轨妥协： */
--font-size-xxs: ...;
--font-size-xs: ...;
--font-size-sm: ...;
--font-size-base: ...;
--font-size-md: ...;
--font-size-lg: ...;
--font-size-xl: ...;
--font-size-2xl: ...;
--font-size-nano: ...;
--font-size-micro: ...;
--font-size-xs-plus: ...;
--font-size-sm-plus: ...;

--font-weight-normal: ...;
--font-weight-code: ...;
--font-weight-medium: ...;
--font-weight-content: ...;
--font-weight-semibold: ...;
--font-weight-heavy: ...;

--line-height-dense: ...;
--line-height-tight: ...;
--line-height-compact: ...;
--line-height-ui: ...;
--line-height-base: ...;
--line-height-body: ...;
--line-height-none: ...;
```

---

## 6 永久免疫机制与刚性棘轮门禁收口（Phase 5）

### 6.1 棘轮基线动态更新与只减不增锁定机制

每次批量替换收敛完成后，立即执行：
```bash
node scripts/check-hierarchy-ssot.mjs --update-baseline
```
- **刚性锁定规则**：
  基线更新命令只允许降低或维持现有基线阈值（`newBase <= oldBase`），严禁任何抬高放宽行为。
- 将第一阶段完成后的新低值持久化至 [`docs/visual-hierarchy-clarity-analysis/baseline/hierarchy-ratchet.json`](file:///c:/Software/conex/docs/visual-hierarchy-clarity-analysis/baseline/hierarchy-ratchet.json)：
  ```json
  {
    "limits": {
      "total_h1": 398,
      "total_h2": 262,
      "total_h3": 45
    },
    "directories": {
      "chat-composer": {
        "h1": 98,
        "h2": 71,
        "h3": 6
      },
      "sidebar": {
        "h1": 44,
        "h2": 51,
        "h3": 11
      }
    }
  }
  ```

---

### 6.2 静态代码守门：Stylelint 刚性拦截裸字面量与旧 Token

在前端 CI 中配置永久静态拦截规则，对新增 PR 进行实时把关：
1. **禁止裸写 font-size 像素值**：声明 `font-size: 13px`、`11px` 等字面量直接报错阻断；
2. **禁止裸写 500 / 600 字重**：声明 `font-weight: 500` 或 `600` 直接阻断；
3. **禁止非白名单实体描边**：未引用 `--edge-*` 预算的 `border` 声明直接阻断。

---

### 6.3 P9 终态 `--strict-zero` 归零验收路线图与断言矩阵

收尾战役的各阶段目标明确如下：

```mermaid
timeline
    title 视觉层级与字阶排版系统收敛里程碑
    Phase 1 (紧急解阻) : 解锁 CI 门禁 : 消除 286 处违规倾倒 : 修复 Markdown 假阳性
    Phase 2 (P2战役) : 全仓字阶 6 档化 : 13px 彻底升降级 : 清退半像素
    Phase 3 (P3/P5战役) : Windows 字重两档化 (400/700) : 过程行接入原子字阶与行高 (--font-size-meta / --lh-row)
    Phase 4 (P1/P4战役) : 展示容器实体描边清退 : 接入表面明度阶梯与 --edge-rim
    Phase 5 (P9终态) : 执行 --strict-zero : 全仓 9 大覆盖域违规数 100% 归零
```

- **P9 终极验收命令**：
  ```bash
  node scripts/check-hierarchy-ssot.mjs --strict-zero
  ```
  **断言**：全仓 9 大覆盖域、38 个 CSS 文件内，`H1 = 0, H2 = 0, H3 = 0`，实现真正无死角架构纯净！

---

## 7 立体化验证方案与真实宿主对齐矩阵

根据 `AGENTS.md` §7.1「立体验证纪律」，本方案执行涵盖静态、单元契约与真实宿主环境的三重立体化验收：

| 验证维度 | 验证载体与执行命令 | 验收标准与硬性判据 |
| :--- | :--- | :--- |
| **静态门禁验证** | `node scripts/check-hierarchy-ssot.mjs`<br/>`node scripts/check-markdown-style-compliance.mjs` | 两大门禁退出码必须为 0，零违规、零报警、零未定义 Token。 |
| **单元契约验证** | `npx vitest run src/styles/textLadder.contract.test.ts` | 验证全主题 × 四级文字阶梯在各级表面上的 WCAG 对比度下限（AAA $\ge$ 12:1, AA $\ge$ 4.5:1）。 |
| **真实宿主物理验证** | Tauri MCP (`127.0.0.1:4000`) 触发 `execute_js` 运行 `hierarchyAudit.ts` | 在 Windows WebView2 真实 DirectWrite 渲染器下复测：<br/>1. 零 13px 渲染节点；<br/>2. 零 500/600 锯齿伪粗体；<br/>3. 过程行与正文字号严格分离（12px vs 14px）；<br/>4. 聊天流内可见实体描边减少 80% 以上。 |

---

## 8 架构收益对账与代码变更清单

### 8.1 收益对账表
1. **立即解除 CI 紧急阻断**：平抑 `check:hierarchy-ssot` 286 处大面积报错倾倒，消灭 `check:markdown-style` 74 处假阳性误报；
2. **彻底攻克 Windows 渲染顽疾**：消除微软雅黑无 500/600 物理字形导致的伪粗体毛刺与回退失效，界面文字锐利清爽；
3. **建立清晰统一的排版秩序**：彻底清除 13px 模糊断层与 1px 细碎级差，主副信息流层次分明；
4. **消除视觉线噪**：清退 260+ 处生硬灰线描边，实现基于微光发丝线与表面明度级差的现代桌面工作台质感；
5. **代码净减重（负代码产出）**：物理删除 25 处旧别名死代码，收敛散落字面量，提升前端架构可维护性。

### 8.2 变更文件清单速查
- **门禁守门脚本**：
  - [`scripts/check-markdown-style-compliance.mjs`](file:///c:/Software/conex/scripts/check-markdown-style-compliance.mjs)（升级 `@import` 递归解析）
  - [`scripts/check-hierarchy-ssot.mjs`](file:///c:/Software/conex/scripts/check-hierarchy-ssot.mjs)（基线更新与严格零模式）
- **紧急修复组件样式**：
  - [`apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.module.css)（拔除 13px/500）
  - [`apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/session-list/ProjectManageModal.module.css)（接入 `--edge-rim`）
  - [`apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css)（修复跨行扫描漏判）
- **Markdown 样式真理源**：
  - [`apps/crish-desktop/src/styles/markdown-typography.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/markdown-typography.css)（收敛 13px 与旧字重）
- **核心排版 Design Tokens**：
  - [`apps/crish-desktop/src/styles/tokens-type.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens-type.css)（清除 `[WAVE2-DEPRECATED-ALIAS]` 死码）
- **自动化收敛工具集**：
  - `scripts/codemod-typography-ssot.mjs`（字阶与行高 Codemod）
  - `scripts/codemod-font-weights-and-roles.mjs`（字重与排版角色 Codemod）
- **棘轮基线数据库**：
  - [`docs/visual-hierarchy-clarity-analysis/baseline/hierarchy-ratchet.json`](file:///c:/Software/conex/docs/visual-hierarchy-clarity-analysis/baseline/hierarchy-ratchet.json)
