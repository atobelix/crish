# 前端第二轮修复 · 总计划方案（R2 Master Plan v0.1）

> 主控产出：`docs/frontend-audit/60-repair2/40-final-plan/00-master-plan.md`
> 输入：50-reverify 三份复审（01 销号验证/02 收敛彻底性/03 回归排查）+ 60-repair2 四份维度方案（01 收敛补刀/02 性能修复/03 卫生门禁/04 P2 裁决）
> 版本：v0.1（待双评审后改进定稿）
> 性质：逻辑执行顺序方案；不含时间/人员/优先级；每轮 ≤12 Agent；闭环迭代

---

## 0. 本轮任务范围（复审确认的遗留 + 新发现）

| 来源 | 内容 |
|---|---|
| 复审 01/02：声明与代码不符 | P1-1 .ui-btn 死 CSS 未删；P1-12 props 三链未聚合；裸 button 102 文件未清零；R-11 mojibake 残留 25+ 行 |
| 复审 03：新发现问题 | P2-1 stop 终稿截断（>16KB 积压）；N1 同值帧丢字；N2 stop 后 isFinal 残留写入；P2 懒加载环风险等 |
| 复审 03：卫生 | check-css-encoding 门禁盲区（mojibake 固化检测不到）；P3 零星（菜单圆角/混色变量） |
| 复审 02：P2 挂账 | 10 类挂账裁决（方案 04：本轮收敛 3 动作 + 下轮 4 + 保留 4） |

---

## 1. 执行轨道（4 维度方案 → 轨道）

| 轨道 | 来源方案 | 核心任务 |
|---|---|---|
| T-A 收敛补刀 | 01-convergence-completion（12 步） | .ui-btn 死 CSS 删除（A 块）、props 三链聚合（B 块）、裸 button 6 波清零（C 块）、CapEditor Switch 归位（D 块） |
| T-B 性能修复 | 02-performance-fixes（7 步） | P2-1 stop 截断修复（四步最小面）、N1/N2 修复、chunk 环检测、P3 零星 |
| T-C 卫生门禁 | 03-hygiene-gate-upgrade（6 步） | mojibake 三层门禁（先建→重写清零→基线联动）、P3 零星、style-contract 基线调整（66→62/633→628） |
| T-D 挂账裁决执行 | 04-p2-adjudication | 本轮 3 动作：VirtualList 退役、滚动条契约化（31→1）、流式命名对齐 |

---

## 2. 批次编排（逻辑顺序，含冲突裁决）

### 批次 R2-1（卫生门禁先行，1 Agent）
- T-C 步骤 B-1：check-css-encoding.mjs 三层升级（PUA/GBK 逆变换/特征字）+ CI 接线（**新发现 N2：脚本未接线**）
- 理由：门禁先建 → 后续所有 CSS 改动受检；mojibake 检出清单固化
- 验证：门禁运行检出 4 文件 26 行残留；typecheck

### 批次 R2-2（收敛补刀 A 块 + 死代码退役，2 Agent 并行，文件面错开）
- T-A 步骤 A-1/A-2：.ui-btn 死 CSS 删除（shell-polish.css:18-84 + DiffCard.module.css:368 + settings-base/plugins/advanced 死选择器 + settings-switch 死规则）——**依赖 tsx 零消费确认（已由复审证实）**；style-contract 基线联动（!important 计数随删除下降）
- T-D R20：VirtualList 孤儿退役（仅自测消费，实测确认）
- 冲突裁决：两者文件面不同（styles/ vs shell/VirtualList.tsx）可并行
- 验证：style-contract 绿 + grep 零消费 + typecheck

### 批次 R2-3（mojibake 重写清零 + 卫生 P3，1-2 Agent）
- T-C 步骤 A-2：4 文件 26 行 mojibake 重写（shell-workspace 14/shell-dragdrop 6/panels 3/shell-polish 2 + 新发现 :356）
- T-C 步骤 C-1/C-2：P3 零星（settings-models 混色变量登记、菜单硬编码圆角 R16）
- 验证：门禁转绿（26→0）；check-css-encoding 全仓通过

### 批次 R2-4（性能修复，T-B，1-2 Agent）
- P2-1 stop 截断四步修复（删 stop 取消 + partialText 换序 + isFinal 停写 + 截断告警）
- N1 同值帧丢字修复（props 相等短路守卫调整）
- N2 stop 后 isFinal 残留写入修复
- 验证：V2 判据（64B 阈值 buffer 断言 commit 全文无损）+ 流式测试全绿
- 注意：useStreamCallbacks/StreamingTextBlock 为共享文件——单 Agent 串行执行

### 批次 R2-5（props 三链聚合，T-A B 块，1 Agent）
- ChatCard→ChatComposer（25 props → 聚合 spread）
- ChatCard→ChatMessageList（25 props → 聚合）
- ChatComposerWrapper→ChatStatusRibbons（27 props → 聚合，含 2 个死 props 清理）
- 验证：typecheck + 相关组件测试 + memo 联动确认（复用批次 5 的 T17 设计）
- 注意：此批依赖批次 R2-4 完成（useStreamCallbacks 稳定后动 ChatCard 面）；与 R2-6 串行（同一 ChatCard 文件）

### 批次 R2-6（裸 button 6 波清零，T-A C 块，2-3 Agent 分域并行）
- 6 波按域（复用 T16 波次表：settings 系收尾/chat-card 组/chat-composer 组/壳状态区/sidebar-files-diff/收尾波）
- 每波 ≤20 文件；variant 映射扩展（新形态需新增 variant 的登记）；豁免面（segment/chip 自定义形态族）
- 注意：与 R2-5 文件面重叠（chat-card 域）——**串行**（R2-5 先，R2-6 后）；每波独立提交
- 验证：每波 typecheck + 视觉抽样

### 批次 R2-7（滚动条契约化 + 流式命名对齐，T-D R5/R9，1 Agent）
- R5 滚动条 31 块 → 契约化（shell-scrollbar.css 唯一出口，SCROLLBAR_BASELINE 31→1）
- R9 流式命名对齐（handleStop 纯改名，轻量面）
- 验证：style-contract ④ 基线更新 + typecheck
- 注意：R5 与 R2-6 文件面可能重叠（涉及组件 module.css）——若冲突则 R5 延后至 R2-6 之后

### 批次 R2-8（CapEditor Switch 归位 + 收尾，1 Agent）
- T-A D 块：CapEditor checkbox-pill → ui/Switch（H3）
- 全量门禁复跑（cargo 我方面 + vitest + typecheck + lint + build + check-dist）
- 销号报告 v2（对照 50-reverify 遗留清单逐项销号）
- 验证：全绿 + 报告

---

## 3. 冲突裁决（跨轨道文件面）

| # | 冲突 | 裁决 |
|---|---|---|
| C-1 | R2-5 props 聚合 vs R2-6 裸 button（同 ChatCard 域文件） | 串行：R2-5 先、R2-6 后（批次顺序已定） |
| C-2 | R2-2 .ui-btn 删除 vs R2-7 滚动条（styles 面可能同文件） | R2-7 的滚动条契约化避开 R2-2 已删文件；执行时按 git status 复核 |
| C-3 | T-C 门禁基线（66→62/633→628）vs R2-2 删除导致 !important 下降 | 门禁基线在 R2-2 完成后统一调整（批次 R2-3 收口） |
| C-4 | 02 方案的 N1/N2 与批次 8 的 StreamingTextBlock 同文件 | T-B 单 Agent 串行执行（批次 R2-4） |

---

## 4. Agent 分配原则（防竞争）

1. 批次内多 Agent 文件面错开（R2-2 的 styles/ vs VirtualList、R2-6 的分域）
2. 共享文件（useStreamCallbacks/StreamingTextBlock/ChatCard）单轮单 Agent
3. 每波/每步独立提交（主控统一），机械替换 ≤20 文件/批
4. 并行域规避：实施前 git status 检查目标文件

---

## 5. 闭环机制

- 每批输出 = 代码 + 测试 + 提交；验证 = 该域门禁
- 下批输入 = 上批提交基线
- 最终验收 = R2-8 全量门禁 + 销号报告 v2（对照 50-reverify 遗留清单：P1-1/P1-12/裸 button/mojibake/P2-1/N1/N2/R20/R5/R9）

---

（v0.1 完——待双评审 + 改进）
