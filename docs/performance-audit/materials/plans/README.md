# 方案生成轮产出约定

> 战役：performance-fix（从 performance-audit 转入修复）
> 依据：`docs/agent-roles/prompts/主控-全流程调度-v3.md` §二
> 日期：2026-09-13

## 目录

`materials/plans/` 下：

- `independent-0N-<角度>.md` — 独立总案（≥6）
- `review-plans-0N.md` — 方案评审
- `master-total-plan.md` — 主控定总案（主控写入根目录 `92-修复总方案.md` 后此文件可作草稿）
- `detail-<维度>.md` — 分维详案
- `review-detail-0N.md` — 分维/总案评审

## 独立总案必含

1. 全局效果与维度划分
2. 依赖与逻辑顺序（禁工期/人员/业务优先级）
3. **本方案要删掉什么/收敛什么**（无删除项须主控验证豁免依据）
4. 文件域与并行边界
5. 验收：功能 + 负产出 + 五端物证
6. 与审计发现 ID 映射（用 90 前缀 ID）

## 输入（只读）

- `docs/performance-audit/00-性能审查总纲.md`
- `docs/performance-audit/90-发现清单索引.md`
- `docs/performance-audit/01`…`16` 报告（按需抽读执行摘要与问题清单）
- `docs/performance-audit/91-系统性修复总方案.md` — **主控草稿，非绑定结论**；独立总案可推翻其取舍
- 仓库代码（证据锚点）

## 禁止

- 抄 91 冒充独立
- 降效果锁 / 保留双轨兼容岛
- 空壳目录无删除面

## 主控 91 草稿定位

`91` 为流程修正前的主控预写草稿；本轮以独立总案交叉验证后，由主控按 v3 定稿 `92-修复总方案.md`。执行轮仅认 92 + 分维详案。
