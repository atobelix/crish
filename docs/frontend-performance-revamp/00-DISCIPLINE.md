# 00 — 战役纪律与调度状态（前端全栈性能重构与最先进单轨收敛战役）

> **战役代号**：`frontend-performance-revamp`  
> **权威目录**：`docs/frontend-performance-revamp/`  
> **生效时间**：2026-10-13  
> **指挥纪律依据**：严格遵循仓库根目录 `AGENTS.md`、`.agents/LOGIC_PLAN_NO_RETREAT.md` 与 `ANTI_OVERENGINEERING_GUARDRAILS.md`。

---

## 一、用户最高战略裁决（铁律红线）

1. **最先进单轨代码铁律（零无谓兼容、零多版本残留）**：
   - 彻底切除无实际意义的所谓“双轨兼容 / 伪兼容适配层 / 历史别名残留”。
   - 只要不涉及不可丢失的历史核心用户数据（如本地对话持久化数据结构），一律保留且只保留一套最先进、最高效、最优雅的原生现代化方案。
   - 拔除兼容层时，必须确保最先进新方案在各端到端场景下具有 100% 完备的功能覆盖，并且比旧代码性能更强、吞吐更高、状态更稳。
2. **效果锁定与反退避**：
   - 用户要求的性能指标与交互体验标准严格锁定，禁止以“工期紧张 / 架构复杂 / 实现困难”自行砍功能或降级为简陋版。
3. **两轮双 Agent 交叉滑动窗口机制**：
   - **第一轮（双 Agent 交叉独立案）**：
     - 10 个 Agent 按环形滑动窗口分配（Agent 1 负责 Stage 1&2，Agent 2 负责 Stage 2&3 ... Agent 10 负责 Stage 10&1）。
     - 每个阶段均有且仅有两个独立 Agent 出具完整的分析与技术方案，写入 `independent-plans/` 独占文件。
   - **第二轮（综合与最优融合终案）**：
     - 针对每个阶段，由对应 Agent 全景研读该阶段的两个独立方案，吸收二者长处并剔除毒点，生成更优越、更强悍的该阶段最终实施方案，写入 `final-plans/`。
   - **第三轮（分波次立体工程实现）**：
     - 主控 Agent 限定文件域派发实施，严禁跨文件写冲突，立体式验证闭环交付。

---

## 二、工作区目录白名单与结构规范（AGENTS.md §4）

根据 2026-08-21 战役工作区结构规范：

1. **根目录白名单**：
   - `00-DISCIPLINE.md`（本纪律文档与调度状态）
   - `00-总方案-前端全栈性能重构与最先进单轨收敛总规划.md`（总架构方案）
   - `01-状态管理与重渲染优化实施详案.md` ~ `10-冷启动链路与构建拆包优化实施详案.md`（最终阶段定稿，第二轮生成后落盘根目录或 final-plans/）
2. **子目录规范（只允许单层子文件夹，归类充分，禁止碎片）**：
   - `independent-plans/`：第一轮 10 个 Agent 交叉独立计划方案（`01-agent1-stage1-2.md` ~ `10-agent10-stage10-1.md`）
   - `final-plans/`：第二轮 10 大阶段融合终案
3. **严禁事项**：
   - 禁止在根目录堆放散乱的子阶段报告；
   - 禁止创建二级嵌套子目录；
   - 禁止提交运行期临时中间文件（引擎会话临时产物进 `.agent-outputs/`）。

---

## 三、第一轮交叉派发与文件映射表

| Agent 标识   | 角色定位                     | 覆盖阶段                | 独占产出文件路径                                                             |
| :----------- | :--------------------------- | :---------------------- | :--------------------------------------------------------------------------- |
| **Agent-01** | 状态管理与对话流式架构专家   | **Stage 01 & Stage 02** | `docs/frontend-performance-revamp/independent-plans/01-agent1-stage1-2.md`   |
| **Agent-02** | 流式引擎与长列表虚拟滚动专家 | **Stage 02 & Stage 03** | `docs/frontend-performance-revamp/independent-plans/02-agent2-stage2-3.md`   |
| **Agent-03** | 虚拟滚动与增量Markdown专家   | **Stage 03 & Stage 04** | `docs/frontend-performance-revamp/independent-plans/03-agent3-stage3-4.md`   |
| **Agent-04** | Markdown解析与块编辑器专家   | **Stage 04 & Stage 05** | `docs/frontend-performance-revamp/independent-plans/04-agent4-stage4-5.md`   |
| **Agent-05** | 输入器与分屏侧边栏布局专家   | **Stage 05 & Stage 06** | `docs/frontend-performance-revamp/independent-plans/05-agent5-stage5-6.md`   |
| **Agent-06** | 分屏布局与重型工具视图专家   | **Stage 06 & Stage 07** | `docs/frontend-performance-revamp/independent-plans/06-agent6-stage6-7.md`   |
| **Agent-07** | 重型视图与UI原子浮层CSS专家  | **Stage 07 & Stage 08** | `docs/frontend-performance-revamp/independent-plans/07-agent7-stage7-8.md`   |
| **Agent-08** | UI组件管线与生命周期内存专家 | **Stage 08 & Stage 09** | `docs/frontend-performance-revamp/independent-plans/08-agent8-stage8-9.md`   |
| **Agent-09** | 生命周期与冷启动水合拆包专家 | **Stage 09 & Stage 10** | `docs/frontend-performance-revamp/independent-plans/09-agent9-stage9-10.md`  |
| **Agent-10** | 冷启动水合与全局状态拓扑专家 | **Stage 10 & Stage 01** | `docs/frontend-performance-revamp/independent-plans/10-agent10-stage10-1.md` |

---

## 四、当前调度进度状态机

- [x] **Phase 0**：建立 `docs/frontend-performance-revamp` 战役工作区与纪律文档；
- [x] **Phase 1**：编写收录 10 大阶段输入/目标/不变量的总规划主文档；
- [x] **Phase 2**：派发 10 个子 Agent 按滑动窗口生成 10 份独立方案（10/10 均已圆满落盘）；
- [x] **Phase 3**：等待全部终态，核验 `independent-plans/` 完整性（10 份高质量方案全量闭环）；
- [x] **Phase 4**：启动第二轮，10 个 Agent 针对 10 个 Stage 融合两份独立方案并提出更优设计，输出最终详案（10/10 终案已全部定稿落盘于 `final-plans/`）；
- [x] **Phase 4.5**：派发 4 个评审 Agent 开展真实性、可执行性、先进性、逻辑递进顺序与反过度设计专项审计与就地优化（4/4 份专项审计报告全量落盘于 `audits/`，终案完成就地加固与全局 DAG 波次闭环）；
- [ ] **Phase 5（进行中）**：按 Wave 0 ~ Wave 4 严格 DAG 波次分派 Agent 实施落地与全量门禁验收收口。
