> **【已废弃 / 非产品真相】** 产品 UI 为 `apps/crish-desktop`。Tauri 不加载 workbench Preact。请以根目录 `README.md` 与 `ARCHITECTURE.md` 为准。本文仅作历史参考。

# Crish 项目架构与路线图

## 架构概览

Crish 采用 **daemon + Tauri 桌面端** 架构，分为 8 层：

| 层级 | 名称 | 职责 | 状态 |
|------|------|------|------|
| L0 | Global State Verification | 全局状态一致性验证 | 完成 |
| L1 | Provider Transport | LLM API 传输层 | 完成 |
| L2 | Runtime Core | 运行时核心引擎 | 完成 |
| L3 | Orchestrator | 编排层 | 完成 |
| L4 | Daemon | 守护进程 (Rust sidecar) | 完成 |
| L5 | Tauri Backend | Rust 原生桥接 | 完成 |
| L6 | Frontend | Preact 前端 | 完成 |
| L7 | Cross-Cutting | 横切关注点 | 进行中 |

### 核心组件

#### Agent Runtime (`packages/agent-runtime`)
运行时核心引擎，负责：
- 消息循环与流式对话
- 工具调用执行（并行/串行）
- 上下文压缩与结构化摘要
- 权限策略决定
- 子智能体递归管理
- 会话快照与恢复
- 断连重连与流恢复

#### Daemon Sidecar (`apps/agent-workbench/src-tauri/src/sidecar.rs`)
Rust 守护进程，管理 Node.js 运行时生命周期：
- 运行时进程发现（node/bun/npx/tsx）
- 指数退避重连
- HTTP 通信诊断
- 结构化日志和错误报告

#### Agent Workbench (`apps/agent-workbench/src`)
Preact + Tauri 桌面应用：
- 完整聊天界面（流式渲染、工具调用卡片、文件编辑摘要）
- 面板布局系统（对话/项目/审批/工具/产物/诊断/计划/设置）
- 消息管道（事件投影、结构化渲染）
- 全局状态管理（AppState）
- 子智能体可视化管理
- 上下文压缩可视化（CompactionSummaryCard）

---

## 近期规划

### 测试基础设施
- [ ] `message-pipeline.ts` 核心流程测试
- [ ] `runtime-event-projector.ts` 事件投影测试
- [ ] `stream-recovery.ts` 流恢复测试
- [ ] `sidecar.rs` daemon 发现和重连测试

### 运行时增强
- [ ] 上下文层级化压缩（L7.6）
- [ ] 模型甜点区集成（systemPromptOverhead 融入压缩决策）
- [ ] 压缩与子智能体任务分配统一（走同一 `createStructuredSummary`）

### 前端增强
- [ ] 离线消息队列恢复
- [ ] Code 模式文件编辑器集成
- [ ] Plan 模式计划文档渲染

---

## 中期规划

### 高级工具
- [ ] MCP 服务器生命周期管理 UI
- [ ] 工具调用策略配置面板
- [ ] 批量审批增强

### 协作功能
- [ ] 配置导入/导出
- [ ] 会话模板系统

---

## 长期愿景

### 企业级功能
- [ ] 多语言运行时支持（Deno, Bun full）
- [ ] 沙箱隔离执行
- [ ] 审计日志

### 扩展生态
- [ ] 插件系统
- [ ] 自定义技能注册
- [ ] 远程 Provider 代理

---

## 技术选型

| 领域 | 技术 |
|------|------|
| 前端框架 | Preact (JSX) |
| 桌面壳 | Tauri v2 |
| 后端桥接 | Rust (Tauri commands) |
| 守护进程 | Rust sidecar |
| 运行时 | Node.js (TypeScript) |
| LLM 协议 | OpenAI 兼容 API |
| 状态管理 | AppState + event bus |
| 消息格式 | TypeScript interfaces |