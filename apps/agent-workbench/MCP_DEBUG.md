# Workbench MCP 调试（tauri-plugin-mcp）

用 [P3GLEG/tauri-plugin-mcp](https://github.com/P3GLEG/tauri-plugin-mcp) 让 AI 直接操控 **Crish 桌面端 webview**（非系统浏览器）。

## 已接入

| 层 | 位置 |
|----|------|
| Rust 插件 | `src-tauri/Cargo.toml` → `tauri-plugin-mcp`（git） |
| 注册 | `src-tauri/src/main.rs`：`#[cfg(debug_assertions)]` + TCP `127.0.0.1:4000` |
| 权限 | `capabilities/default.json` → `mcp:default` |
| 前端 guest | `crish-desktop` 依赖 `tauri-plugin-mcp`；`main.tsx` DEV 下 `setupPluginListeners()` |

## 启动

1. **正常开 workbench**（debug）：
   ```bash
   npm run dev:workbench
   ```
2. **另开终端启动 MCP Server**（对接 Grok/Cursor）：
   ```bash
   npx tauri-plugin-mcp-server
   ```
   Windows 下默认会发现 `127.0.0.1:4000` 与 sidecar token。

3. **Grok / Cursor MCP 配置示例**（按本机客户端格式调整）：
   ```json
   {
     "mcpServers": {
       "tauri-mcp": {
         "command": "npx",
         "args": ["-y", "tauri-plugin-mcp-server"]
       }
     }
   }
   ```

## 常用工具（通过 MCP Server）

- `query_logs` — webview `console.*` + Rust 日志
- `query_page` — DOM map / state
- `click` / `execute_js` — 点侧栏会话、查 store
- `take_screenshot` — 真窗口截图
- `log_mark` — 动作前后打点，缩小日志窗口

## 注意

- **仅 debug**：release 不启 socket。
- Vite 挂掉时（`ERR_CONNECTION_REFUSED` / dynamic import fail）主区会空白，与业务逻辑无关——先保证 `localhost:5174` 存活再查交互 bug。
- 不要用系统 Chrome 打开 `localhost:5174` 当「产品环境」；产品以 Tauri 窗口为准。
