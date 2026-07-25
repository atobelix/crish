# 构建系统与配置审计报告 (Round 12 - Check 7)

## 检查项 1: tsconfig 继承链

共扫描 17 个 `tsconfig*.json` 文件（含 `tsconfig.base.json`）。

| 文件 | 继承自 base? | 备注 |
|------|-------------|------|
| `tsconfig.base.json` | — | 根基准文件，无需继承 |
| `apps/agent-workbench/tsconfig.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `apps/crish-desktop/tsconfig.json` | N/A | 仅 `files: []` + `references`，标准项目引用模式，无需继承 |
| `apps/crish-desktop/tsconfig.app.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `apps/crish-desktop/tsconfig.node.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `packages/shared-utils/tsconfig.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `packages/shared-utils/tsconfig.build.json` | ✅ (链式: → `./tsconfig.json` → base) | |
| `packages/agent-runtime/tsconfig.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `packages/agent-runtime/tsconfig.build.json` | ✅ (链式: → `./tsconfig.json` → base) | |
| `packages/agent-orchestrator/tsconfig.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `packages/agent-orchestrator/tsconfig.build.json` | ✅ (链式: → `./tsconfig.json` → base) | |
| `packages/shared-types/tsconfig.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `packages/shared-types/tsconfig.build.json` | ✅ (链式: → `./tsconfig.json` → base) | |
| `packages/agent-daemon/tsconfig.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `packages/agent-daemon/tsconfig.build.json` | ✅ (链式: → `./tsconfig.json` → base) | |
| `packages/decision-engine/tsconfig.json` | ✅ `extends: "../../tsconfig.base.json"` | |
| `packages/decision-engine/tsconfig.build.json` | ✅ (链式: → `./tsconfig.json` → base) | |

**结论: ✅ 所有业务 tsconfig 均正确继承 `tsconfig.base.json`。`apps/crish-desktop/tsconfig.json` 为 references-only 文件，不参与编译，属标准实践。**

## 检查项 2: Cargo.toml lints 继承

根 `Cargo.toml` 定义了 `[workspace.lints.clippy]` 规则：
```toml
[workspace.lints.clippy]
allow-unwrap-in-tests = "allow"
allow-expect-in-tests = "allow"
```

| 文件 | 存在 `[lints] workspace = true`? |
|------|----------------------------------|
| `apps/agent-workbench/src-tauri/Cargo.toml` | ❌ **缺少** |
| `packages/agent-provider-http/Cargo.toml` | ❌ **缺少** |

**结论: ❌ 两个 Cargo.toml 均未继承 workspace lints。需在 `[package]` 后添加：**

```toml
[lints]
workspace = true
```

## 检查项 3: package.json 脚本一致性

| 脚本 | 命令 | 目标文件 | 状态 |
|------|------|---------|------|
| `test:integration` | `vitest run --config vitest.integration.config.ts` | `vitest.integration.config.ts` | ✅ 存在 |
| `check:store-types` | `node scripts/check-no-as-any-store.mjs` | `scripts/check-no-as-any-store.mjs` | ✅ 存在 |
| `check:no-any` | `node scripts/check-no-as-any.mjs` | `scripts/check-no-as-any.mjs` | ✅ 存在 |

**结论: ✅ 所有脚本目标文件均存在。**

## 检查项 4: CI 配置 depcruise

**项目不存在 `.github/workflows/` 目录，完全缺失 CI 配置文件。**

`package.json` 中的 `lint:depcruise` 脚本：
```
depcruise --config .dependency-cruiser.cjs packages apps --ignore "dist/"
```
- `.dependency-cruiser.cjs` 存在 ✅
- `--ignore "dist/"` 已排除 `dist/` ✅
- 但无任何 CI pipeline 来运行此脚本

**结论: ❌ CI 配置完全缺失（无 `.github/workflows/`）。`lint:depcruise` 脚本本身的 `dist/` 排除配置正确。**

## 检查项 5: clippy.toml + deny.toml + rustfmt.toml

| 文件 | 存在? | 内容 |
|------|-------|------|
| `clippy.toml` | ✅ | `allow-unwrap-in-tests = true`, `allow-expect-in-tests = true` — 与 workspace lints 一致 |
| `deny.toml` | ✅ | 完整的 advisories / licenses / bans 三段配置，许可证白名单合理（MIT, Apache-2.0, BSD, ISC, Unlicense, Zlib），GPL/AGPL 列入拒绝列表 |
| `rustfmt.toml` | ✅ | `max_width = 120`, `tab_spaces = 4`, `edition = "2024"`, `imports_granularity = "Item"`, `group_imports = "StdExternalCrate"` |

**结论: ✅ 三个 Rust 配置文件均存在且内容正确。**

---

## 配置不一致清单

| # | 严重度 | 位置 | 问题 |
|---|--------|------|------|
| 1 | 中 | `apps/agent-workbench/src-tauri/Cargo.toml` | 缺少 `[lints] workspace = true` |
| 2 | 中 | `packages/agent-provider-http/Cargo.toml` | 缺少 `[lints] workspace = true` |
| 3 | 高 | `.github/workflows/` (缺失) | 项目无任何 CI/CD 流水线配置 |

## 改进建议

1. **添加 `[lints] workspace = true`**：在两个 Cargo.toml 的 `[package]` 段后添加，以确保所有 Rust crate 统一遵循 workspace 级别的 clippy 规则：
   ```toml
   [lints]
   workspace = true
   ```

2. **创建 CI 工作流**：在 `.github/workflows/ci.yml` 中添加持续集成配置，至少包含：
   - TypeScript 类型检查 (`npm run typecheck`)
   - Lint 检查（ESLint + depcruise）
   - 单元测试 + 集成测试
   - Rust 构建/检查（如果 Rust 代码需要）
   ```yaml
   name: CI
   on: [push, pull_request]
   jobs:
     build:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
         - run: npm ci
         - run: npm run typecheck
         - run: npm run lint
         - run: npm run lint:depcruise
         - run: npm test
         - run: npm run test:integration
   ```
