# 流式渲染卡顿跳动与时序重排系统性治理战役纪律与调度规范

> **战役名称**：`stream-jitter-and-order-repair`  
> **创建时间**：2026-10-12  
> **核心目标**：彻底根治流式 Markdown 解析卡顿、分块封口 DOM 塌陷闪烁、虚拟滚动程序吸底突跳、以及历史会话水合时序重排四大关联顽疾。

---

## 一、工作区结构规范（严格遵守 AGENTS.md 战役规范）

1. **根目录白名单**：
   - 本纪律文档：`00-DISCIPLINE.md`
   - 方案实现总文档：`00-总方案.md`（子 Agent 独立方案汇总收敛后生成）
   - 方案分维度实现文档：如 `01-分维详案-时序与水合.md`、`02-分维详案-渲染与过渡.md`、`03-分维详案-虚拟滚动吸底.md`
2. **一级子目录规范**：
   - 独立方案库：`independent-plans/`（各子 Agent 独立输出的专业方案）
   - 方案评审库：`plan-reviews/`（方案交叉评审产物）
   - 补充分析库：`analysis/`（现场数据与深度分析快照）
   - 禁止在根目录散落碎片文件，禁止二级及更深嵌套目录。

---

## 二、六大子 Agent 任务域与产出分配

| 编号   | 专职角色                   | 核心任务域                                                                                                   | 唯一产出路径                                                                                   |
| :----- | :------------------------- | :----------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------- |
| **01** | 时序与水合单轨专家         | 解决 `sessionEventProjection.ts` 时间戳丢失、`compareMessageOrder` 退化为 ID 字典序、SQLite JIT 水合脱节问题 | `docs/stream-jitter-and-order-repair/independent-plans/01-消息因果时序与水合单轨方案.md`       |
| **02** | Markdown 封口与过渡专家    | 解决 `MarkdownBlockItem.tsx` 封口时 `renderedHtml` 瞬间清空塌陷、0px 白屏与闪烁重绘问题                      | `docs/stream-jitter-and-order-repair/independent-plans/02-Markdown封口过渡与零塌陷方案.md`     |
| **03** | 流式解析与微任务调度专家   | 解决 `markdownRenderAsync.ts` 多分片级联触发微任务重渲染风暴、打字吐字顿挫问题                               | `docs/stream-jitter-and-order-repair/independent-plans/03-流式解析微任务批合并与帧调度方案.md` |
| **04** | 虚拟滚动与吸底脱敏专家     | 解决 `MessageVirtualizer.tsx` / `useVirtualScroll.ts` 程序吸底误触手势冻结（100ms 测高停滞导致突跳）问题     | `docs/stream-jitter-and-order-repair/independent-plans/04-虚拟滚动测高与吸底手势解耦方案.md`   |
| **05** | 动态高度锚定与抖动抑制专家 | 解决思考块/工具行动态尺寸展开收起、虚拟列表可视区锚点漂移与视觉抖动问题                                      | `docs/stream-jitter-and-order-repair/independent-plans/05-消息行动态高度锚定与抖动抑制方案.md` |
| **06** | 架构净收敛与门禁断言专家   | 统筹跨模块解耦、杜绝魔术补偿与打补丁，制定自动化测试与验收基线                                               | `docs/stream-jitter-and-order-repair/independent-plans/06-跨层架构净收敛与立体门禁方案.md`     |

---

## 三、协作铁律（零容忍）

1. **绝对禁止盲目补偿打补丁**：严禁使用 `setTimeout` 延迟补丁、基于 DOM 坐标的魔术数字累加、或针对特殊 sender 的硬编码分支。
2. **单一真理路径（SSOT）**：时序以客观时间戳与因果序列为准，状态以单向数据流为准。
3. **提交权仅归主 Agent**：子 Agent 一律不得提交 Git，所有改动保留在文档产出与工作区。
