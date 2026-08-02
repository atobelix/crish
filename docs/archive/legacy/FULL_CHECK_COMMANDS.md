# Conex 全量地毯式门禁与质量检查命令集 (FULL_CHECK_COMMANDS)

> **核心指令**：不断追加所有需要的检查命令，并在 AGENTS.md 等 agent 文件中严格引用。未来所有重构、大改与 Agent 轮次必须全量跑通本命令集中的所有门禁。

---

## 💥 全量一键组合命令 (Powershell One-Liner)

```powershell
npm run check:core; if ($LASTEXITCODE -eq 0) { cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml }; if ($LASTEXITCODE -eq 0) { npm run check:store-types }; if ($LASTEXITCODE -eq 0) { npm run lint:depcruise }; if ($LASTEXITCODE -eq 0) { npx turbo run build }; if ($LASTEXITCODE -eq 0) { npx vitest run }; if ($LASTEXITCODE -eq 0) { cargo test --workspace }; if ($LASTEXITCODE -eq 0) { npm run test:integration }; if ($LASTEXITCODE -eq 0) { npm run test:fuzz }; if ($LASTEXITCODE -eq 0) { npm run test:e2e }; if ($LASTEXITCODE -eq 0) { node -e "const fs=require('fs'),path=require('path');function walk(d){let r=[];for(let f of fs.readdirSync(d)){if(['node_modules','.git','dist','target','build'].includes(f))continue;f=path.join(d,f);if(fs.statSync(f).isDirectory())r=r.concat(walk(f));else if(!/\.(png|jpg|ico|webp|zst|tar|exe)$/i.test(f))r.push(f)}return r}let errs=walk('.').filter(f=>fs.readFileSync(f,'utf8').includes('\uFFFD'));if(errs.length){console.error('Found FFFD in:',errs);process.exit(1)}else{console.log('Zero FFFD verified!')}" }
```

---

## 🛡️ 地毯式 10 大关卡分步指令 (Complete Gate Pipeline)

### 1. 全 Workspace TypeScript 静态类型检查
```powershell
npm run check:core
```

### 2. Rust Sidecar 与 11 个 Rust Crates 静态检查
```powershell
cargo check --manifest-path apps/agent-workbench/src-tauri/Cargo.toml
```

### 3. Zustand Store 专属类型防线与 `as any` 逃逸审查
```powershell
npm run check:store-types
```

### 4. 依赖解耦与架构无循环依赖检测 (`.dependency-cruiser.cjs`)
```powershell
npm run lint:depcruise
```

### 5. 全量 Workspace 生产打包与 PostCSS / Vite 样式校验
```powershell
npx turbo run build
```

### 6. 全量 TS/JS 单元测试套件 (Vitest Suite)
```powershell
npx vitest run
```

### 7. 全量 Rust 底层 Crates 单元与集成测试套件 (Cargo Test)
```powershell
cargo test --workspace
```

### 8. 跨模块状态与持久化恢复集成测试套件
```powershell
npm run test:integration
```

### 9. 虚拟列表与并发 Buffer Fuzz 模糊测试
```powershell
npm run test:fuzz
```

### 10. Playwright & Native E2E 端到端 UI 自动化测试
```powershell
# E2E 界面 UI 与 Store 不变性测试
npm run test:e2e

# 全量 E2E 自动化测试套件
node scripts/run-full-e2e-suite.mjs

# Rust/Tauri 原生 E2E 测试
npx vitest run tests/e2e/tauri-native-smoke.spec.ts
```

### 11. ESLint 与 CSS Stylelint 代码规范检查
```powershell
npm run lint
npm run lint:css
```

### 12. 全仓 UTF-8 编码与 U+FFFD 乱码替代字符审计
```powershell
node -e "const fs=require('fs'),path=require('path');function walk(d){let r=[];for(let f of fs.readdirSync(d)){if(['node_modules','.git','dist','target','build','reference'].includes(f))continue;f=path.join(d,f);if(fs.statSync(f).isDirectory())r=r.concat(walk(f));else if(/\.(ts|tsx|js|mjs|cjs|json|css|md|html|rs|toml)$/i.test(f))r.push(f)}return r}let errs=walk('.').filter(f=>fs.readFileSync(f,'utf8').includes('\uFFFD'));if(errs.length){console.error('Found FFFD in:',errs);process.exit(1)}else{console.log('Zero FFFD verified in source code!')}"
```
