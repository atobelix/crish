# Tauri 2 L3 级桌面 Native 原生 Smoke 烟雾测试指南

本指南详细说明了 Conex / Crish 项目中针对 **Tauri 2 桌面架构** 实现的 **L3 级 Native 原生烟雾测试套件** 的规范、架构原理与运行维护说明。

---

## 1. 概述

随着项目演进，桌面端 (`apps/agent-workbench`) 依赖 Rust 原生主进程拉起 Node.js Sidecar Daemon 进行底层 AI Agent 编排与通信。
L3 Native Smoke 测试用于防范桌面二进制在实际操作系统环境中的崩溃、Sidecar 挂载失败、WebSocket 握手超时以及退班时的僵尸进程泄露。

---

## 2. 测试规范与实现代码

测试用例位于：[tests/e2e/tauri-native-smoke.spec.ts](file:///c:/Software/conex/tests/e2e/tauri-native-smoke.spec.ts)

测试项列表：
| 用例编号 | 测试名称 | 验证重点 |
|---|---|---|
| **L3-1** | Native 目标程序拉起与 Tauri IPC 初始化 | 验证二进制可执行文件拉起、PID 分配及 Rust 侧 Sidecar 启动引擎初始化 |
| **L3-2** | Sidecar Spawn 挂载与 WebSocket Handshake 握手 | 验证 Node.js Sidecar 自动 Spawn 挂载及 `ws://127.0.0.1:8765` 通信正常 |
| **L3-3** | 进程安全退出与僵尸进程 Kill | 验证向主进程发送 `SIGTERM` 退出信号后，后台 Sidecar 进程彻底清理无残留 |

---

## 3. 运行命令

```bash
# 运行 Native 烟雾测试
npm run test:e2e:native
```

---

## 4. CI/CD 集成

在 CI 流水线中，构建完 `crish-agent-workbench` 二进制后，应安排执行 `npm run test:e2e:native` 以拦截任何二进制启动或进程泄漏回归。
