# Crish Desktop

产品桌面 UI。对用户而言是**一体客户端**：引擎由 Tauri 壳内嵌同进程运行，对用户呈现为单进程应用，不暴露「后端」概念。

旧版 workbench 前端已弃用；Tauri 壳与命令行支持层（`src/core`、`src/shared`）仍在 `apps/agent-workbench`。

## 产品约束

- 打包后：引擎随 Tauri 壳同进程启动，无独立后端进程；UI 在引擎首次就绪前显示启动页，避免「空壳能开、服务永远连不上」。
- 用户可见故障文案默认只谈「服务暂时不可用」，不出现端口等实现细节。
- 开发者若要改引擎地址：`localStorage.setItem('crish_show_engine_settings','1')`。

## 内部结构（开发用）

| 层 | 路径 | 职责 |
| --- | --- | --- |
| UI | `apps/crish-desktop` | 会话与布局 |
| Shell | `apps/agent-workbench/src-tauri` | 窗口、IPC 命令注册、事件桥、引擎初始化与恢复 |
| Engine | `crates/*`（Rust，同进程内嵌） | 会话循环 / 编排 / provider / 工具 |

## 开发

```bash
# 推荐：完整桌面（Tauri 壳 + Rust 引擎 + React UI）
npm run dev:workbench

# 仅 React UI（Vite 拆 UI；无 Tauri 宿主能力，引擎联调需 dev:workbench）
npm run dev:desktop
```

## 脚本

- `npm run dev:workbench` — Tauri 桌面（壳 + 引擎 + UI）
- `npm run dev:desktop` — Vite UI only
- `npm run build:desktop` / `check:desktop`
