# L3 级桌面 Native 原生 Smoke 烟雾测试套件说明文档

本目录包含基于 **Tauri 2 架构** 的 L3 级桌面 Native 原生 Smoke 烟雾自动化测试套件 (`tauri-native-smoke.spec.ts`)。

---

## 1. 测试套件架构与目标

测试套件针对 `@crish/agent-workbench` 打包/编译生成的本地原生二进制程序（`crish-agent-workbench` / `crish-agent-workbench.exe`），完成以下 4 大核心维度的自动化断言校验：

1. **二进制应用进程拉起与生命周期 (L3-1)**：
   - 校验 Native 可执行文件在目标 OS（Windows / macOS / Linux）正常 Spawn 启动。
   - 校验进程分配有效 PID 且不提前崩溃或异常退出。
   - 校验 Tauri 原生引擎与 Sidecar Supervisor 成功完成 Rust 侧初始化。

2. **Sidecar Node Daemon 进程 Spawn 挂载 (L3-2)**：
   - 校验 Rust 主进程自动拉起并挂载 Sidecar Node Daemon 进程。
   - 获取并校验 Sidecar PID 及其侦听的 WebSocket 端口（默认 `ws://127.0.0.1:8765/`）。

3. **WebSocket Handshake 握手通信校验 (L3-2)**：
   - 建立 WebSocket 客户端连接到 Sidecar 服务。
   - 校验双向握手、协议版本匹配与状态响应。

4. **安全退出与僵尸进程清理 (L3-3)**：
   - 向主进程发送 `SIGTERM` 安全退出信号。
   - 断言主进程退出后，后台 Sidecar Node Daemon 进程被干净 Kill，操作系统进程表中无残存僵尸进程。

---

## 2. 前置准备与构建

在运行 Native 烟雾测试前，需确保目标二进制文件已成功编译：

```bash
# 编译 agent-workbench Tauri 2 原生二进制 (Debug 模式)
cargo build --manifest-path apps/agent-workbench/src-tauri/Cargo.toml

# 或编译 Release 发布包
npm run build:workbench
```

测试脚本会自动在以下路径按优先级查找目标二进制文件：
1. `<workspace>/target/debug/crish-agent-workbench[.exe]`
2. `<workspace>/target/release/crish-agent-workbench[.exe]`
3. `<workspace>/apps/agent-workbench/src-tauri/target/debug/crish-agent-workbench[.exe]`
4. `<workspace>/apps/agent-workbench/src-tauri/target/release/crish-agent-workbench[.exe]`

---

## 3. 运行测试命令

### 执行完整烟雾测试套件
```bash
npm run test:e2e:native
```

### 使用 Vitest 命令行直接运行
```bash
npx vitest run tests/e2e/tauri-native-smoke.spec.ts
```

---

## 4. 调试与排错指南 (Troubleshooting)

### 4.1 Rust 侧详细日志调试
可以通过设置环境变量 `RUST_LOG` 输出 Sidecar 详细追踪日志：
```bash
$env:RUST_LOG="info,sidecar=trace"
npm run test:e2e:native
```

### 4.2 检查与清除残存进程 (Manual Process Verification)

- **Windows (PowerShell)**:
  ```powershell
  # 查找是否存在残留的 crish 或 node daemon 进程
  Get-Process | Where-Object { $_.ProcessName -like "*crish*" }
  
  # 手动清理指定 PID
  Stop-Process -Id <PID> -Force
  ```

- **Unix / macOS (Bash)**:
  ```bash
  ps aux | grep crish
  kill -9 <PID>
  ```

### 4.3 端口冲突排查 (WebSocket Port 8765)
若测试提示 WebSocket 超时，请检查端口 8765 是否被占用：
```powershell
# Windows
netstat -ano | findstr 8765

# Unix
lsof -i :8765
```
