# Conex 修复方案补充：测试桩 / CI 脚本 / Rust 整合

> 校正版本审查发现 3 类缺口，本补充方案填平后使主计划可完整执行。

## 缺口全景

| 缺口类别 | 数量 | 影响 |
|---------|------|------|
| 缺失测试文件 | 19 | 11 项 verification_command 无法执行 |
| 缺失 CI 脚本 | 4 | G1/G3/G4/G5 门禁无校验器 |
| Rust 跨 crate 冲突 | 1 (compaction.rs) | ST-04 / SE-02 / PM-05 改同一文件 |

## Round S1：创建测试桩（19 个，分 3 波）

### S1-Wave1: apps/crish-desktop (8 个)
- streamRenderBuffer.test.ts → GAP-ST-01
- normalizer.test.ts → GAP-ST-07
- directFetchBridge.test.ts → GAP-UI-02
- useStreamCallbacks.test.ts → GAP-UI-02
- store/types.test.ts → GAP-SE-04
- DiffCardFileList.test.tsx → GAP-SE-04
- ComposePlusMenu.test.tsx → GAP-UI-03
- ModelPicker.test.tsx → GAP-UI-03
- ProjectPickerMenu.test.tsx → GAP-UI-03

### S1-Wave2: packages/agent-runtime (8 个)
- session-loop/index.test.ts → GAP-ST-09
- provider-call.test.ts → GAP-ST-09
- json-repair.test.ts → GAP-ST-10
- compression-utils.test.ts → GAP-SE-02
- trace/index.test.ts → GAP-CS-08
- chatgpt-pool.test.ts → GAP-CS-05
- validators/common.test.ts → GAP-TC-01
- mcp-server-controller.test.ts → GAP-TC-04

### S1-Wave3: packages/agent-daemon + orchestrator (3 个)
- daemon-approval-handler.test.ts → GAP-TC-02
- mcp-stdio-adapter.test.ts → GAP-TC-04
- orchestrator/types.test.ts → GAP-CS-02

## Round S2：创建 CI 规范检查脚本（4 个）

### S2-Wave1:
1. scripts/ci/check-g1-style.js — SLOC & Style Gate 校验器
2. scripts/ci/check-g3-g4-resource.js — 级联终止 & 资源泄漏校验器
3. scripts/ci/run-quality-gates.ps1 — Windows 统一 runner
4. scripts/ci/run-quality-gates.sh — Unix 统一 runner

## Round S3：Rust 整合

### S3-Wave1: compaction.rs 三合一
将 GAP-ST-04(calculate_total_tokens)、GAP-SE-02(safe_drop_end)、GAP-PM-05(retain+shrink_to_fit) 合并为同一 Wave 中的单一 Agent 修改，确保不冲突。

### S3-Wave2: conex-fs ↔ agent-workbench 依赖
为 SE-03(safe_canonicalize) 添加 conex-fs 到 agent-workbench 的依赖，或将 safe_canonicalize 直接内联到 agent-workbench。

## Round S4：最终验证
- 所有 19 个测试桩路径验证通过
- 所有 4 个 CI 脚本路径验证通过
- verification_command 更新为实际路径
