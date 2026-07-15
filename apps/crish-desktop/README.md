# Crish Desktop

产品桌面 UI。对用户而言是**一体客户端**：引擎由 Tauri 壳内嵌拉起与保活，不暴露「后端 / daemon」概念。

旧版 workbench 前端已弃用；壳与 CLI 仍在 `apps/agent-workbench`。

## 产品约束

- 打包后：启动即由 sidecar 启动引擎，失败则壳侧重试；UI 在首次就绪前显示启动页，避免「空壳能开、服务永远连不上」。
- 用户可见故障文案默认只谈「服务暂时不可用」，不出现端口 / WebSocket / daemon。
- 开发者若要改引擎地址：`localStorage.setItem('crish_show_engine_settings','1')`。

## 内部结构（开发用）

| 层 | 路径 | 职责 |
| --- | --- | --- |
| UI | `apps/crish-desktop` | 会话与布局 |
| Shell | `apps/agent-workbench/src-tauri` | 窗口、引擎进程守护 |
| Engine | `packages/agent-daemon` | 协议与任务执行 |

## 开发

```bash
# 推荐：完整桌面（一体）
npm run dev:workbench

# 仅浏览器拆 UI（需另开 npm run daemon）
npm run dev:desktop
```

## 脚本

- `npm run dev:workbench` — Tauri 桌面
- `npm run dev:desktop` — Vite UI only
- `npm run build:desktop` / `check:desktop`
- `npm run daemon` — 独立引擎（浏览器联调）
