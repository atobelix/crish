# 移动端全面复兴与打包打通审计战役 (mobile-revival-audit)

## 战役背景
根据用户指示与主控代码精读，当前 `apps/crish-mobile`（Expo SDK 57 / RN 0.86 / React 19.2.3）具备高完整度的领域状态机、加密协商和 UI 表现层，但受跨包契约漂移（`shared-types` 导出丢失）与打包工程化未完成（无原生目录、缺少 app.json 标识、Metro serializer 损坏）阻断，处于无法打包且存在类型/测试报错的状态。

## 战役阶段规划
- **阶段一（当前）**：11 维度全量深度内部自审（由 11 位专职子 Agent 并行执行，结果落入 `surveys/`）
- **阶段二**：主控汇总 11 维审计结果，产出总问题池与收敛详案
- **阶段三**：按“先收敛删除、再修复对齐、最后打通打包”的逻辑顺序推进执行与真机/模拟器验收

## 目录结构
- `README.md`：本战役索引与纪律说明
- `surveys/`：11 个子 Agent 的专项调查报告
  - `01-packaging-and-build-infrastructure.md`
  - `02-typecheck-and-contract-drift.md`
  - `03-pairing-and-crypto-handshake.md`
  - `04-network-gateway-and-reconcile.md`
  - `05-approval-center-and-outbox.md`
  - `06-sessions-runs-and-events.md`
  - `07-terminal-and-line-buffer.md`
  - `08-storage-sqlite-and-secure-store.md`
  - `09-notifications-and-expo-compatibility.md`
  - `10-ui-specification-and-interaction.md`
  - `11-dead-code-and-markers-audit.md`
