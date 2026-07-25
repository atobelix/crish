# Conex 全量地毯式门禁与质量检查命令集 (Exhaustive Verification Pipeline)

> **使用规范**：在修改任何代码后，必须跑通本命令集中的所有 6 大关卡，涵盖 **TS 类型检查、静态代码规则与 `as any` 禁用、架构依赖图分析、单元与集成测试、Fuzz 模糊测试、产品全量构建与性能验收**。

---

## 💥 地毯式一键全量组合命令 (Full PowerShell Bombardment One-Liner)

在 Windows PowerShell 下直接复制运行以下单行命令，将按顺序自动跑完所有 6 大严苛门禁：

```powershell
npx turbo run typecheck; if ($LASTEXITCODE -eq 0) { node scripts/check-no-as-any-store.mjs }; if ($LASTEXITCODE -eq 0) { node scripts/check-no-as-any.mjs }; if ($LASTEXITCODE -eq 0) { npm run check:deps }; if ($LASTEXITCODE -eq 0) { cargo test --workspace }; if ($LASTEXITCODE -eq 0) { npx vitest run --no-coverage }; if ($LASTEXITCODE -eq 0) { npm run test:integration }; if ($LASTEXITCODE -eq 0) { npm run build:product }
```

---

## 🛡️ 六大严苛门禁分步指令 (6-Phase Gate Pipeline)

### 第一关：全 Workspace 静态类型地毯式扫描 (Typecheck All Workspaces)
```powershell
npx turbo run typecheck
```
* **覆盖范围**：涵盖 `@crish/crish-desktop`、`agent-runtime`、`agent-orchestrator`、`agent-daemon`、`shared-types` 等全量 13 个 Crate / Package。
* **合格标准**：0 个 TypeScript 编译错误（Exit Code 0）。

---

### 第二关：Store 类型安全与 `as any` / 架构循环依赖门禁 (Strict Lint & Dependency Graph)
```powershell
# 1. 检查 Zustand Store 类型安全（严禁 as any 隐式绕过）
node scripts/check-no-as-any-store.mjs

# 2. 全项目 as any 滥用审查
node scripts/check-no-as-any.mjs

# 3. 架构解耦与无循环依赖扫描 (Dependency Cruiser)
npm run check:deps
```
* **覆盖范围**：扫描全项目 AST，拦截强行 `as any` 强转、违规逆向依赖与 `dist/` 循环引用。
* **合格标准**：0 Warnings / 0 Errors。

---

### 第三关：全量单元测试与覆盖率扫描 (Full Unit Test & Coverage Suite)
```powershell
# 1. 快速单测执行（全 Workspace 单元测试套件）
npx vitest run --no-coverage

# 2. TS 端全量覆盖率扫描 (已配置 include 限定连接源代码，自动排除 reference 外部参照库)
npx vitest run --coverage --coverage.reporter=text

# 3. Rust 底层 Crate 单元测试套件 (覆盖 14 个 Rust Crates)
cargo test --workspace
```
* **覆盖范围**：涵盖 `apps/crish-desktop/src`、`packages/*/src` 下所有修改的 TS 文件以及 `crates/` 目录下所有 Rust Crate。
* **合格标准**：所有 Test Files 均为 `passed`，Rust & TS 测试 0 失败，覆盖率符合预设指标。

---

### 第四关：集成测试与 Fuzz 模糊测试 (Integration & Fuzzing Suite)
```powershell
# 1. 集成测试套件（跨模块状态并发、持久化恢复）
npm run test:integration

# 2. 模糊测试套件（虚拟列表百万数据量、流式 Buffer 压测）
npm run test:fuzz
```
* **覆盖范围**：测试 Store 50 并发 Mutation、长消息 VirtualScroll 边界、内存恢复路径。
* **合格标准**：所有测试通过。

---

### 第五关：全量产品包与 Node 守护进程构建 (Full Product Build)
```powershell
npm run build:product
```
* **覆盖范围**：Vite 前端 Bundle 打包、esbuild 语法高亮/CSS 压缩、`agent-daemon` 守护进程打包。
* **合格标准**：产物构建完成，无缺失导出、无 Vite chunk 缺失错误。

---

### 第六关：性能基准与内存泄漏验收 (Benchmark & Acceptance)
```powershell
npm run bench:acceptance
```
* **覆盖范围**：验证冷启动 / 热启动耗时、内存占用峰值。
* **合格标准**：符合反过度设计与性能指标要求。

---

## 🚫 代码修改硬性禁令 (Enforced Development Rules)

1. **禁止只看部分代码**：修改前必须读取关联文件的 100% 全量代码，绝不猜测。
2. **禁止补丁式修复**：严禁在 `try-catch` 里返回 dummy 假数据或使用 `as any` 遮蔽错误。
3. **彻底完成验证闭环**：代码改动完成后必须完整跑一遍上述 6 大关卡，确保项目质量稳定。
