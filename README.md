# Crish

**Crish** 是一个基于 Agent Runtime 的智能体工作台，提供完整的 Web UI 和 CLI 接口。

## 项目结构

```
crish/
├── apps/
│   ├── agent-workbench/    # CLI 和桌面工作台
│   │   ├── src/
│   │   │   ├── cli/        # 命令行入口、goal-run、运行记录
│   │   │   └── shared/     # task-controller、runtime bridge
│   │   └── src-tauri/      # Tauri 桌面端（可选）
│   └── web-ui/             # Web 前端界面（replicate_ui）
├── packages/
│   ├── agent-runtime/      # 核心 runtime（~15,782 行）
│   │   ├── runtime.ts      # 模型调用、工具调用
│   │   ├── permissions.ts  # 权限管理
│   │   ├── encoding.ts     # 编码保护
│   │   ├── snapshots.ts    # 快照系统
│   │   ├── context-compression.ts  # 上下文压缩
│   │   ├── tool-output-budget.ts   # 工具输出预算
│   │   ├── background-command.ts   # 后台命令
│   │   └── subagents.ts    # 子智能体
│   └── shared-types/       # 共享类型定义
└── package.json
```

## 核心功能

### Agent Runtime (packages/agent-runtime)
- **模型调用**: OpenAI 兼容的 API 调用
- **工具系统**: 文件读写、命令执行、浏览器控制
- **权限管理**: 细粒度的安全控制
- **编码保护**: 中文编码自动检测和保护
- **上下文压缩**: 自动压缩历史消息
- **快照系统**: 会话状态快照和恢复
- **子智能体**: 多智能体协作

### Agent Workbench (apps/agent-workbench)
- **CLI 工具**: 命令行交互界面
- **Goal Runner**: 目标驱动的任务执行
- **Task Controller**: 任务调度和管理
- **Runtime Bridge**: 运行时桥接层

### Web UI (apps/web-ui)
- **聊天界面**: 类似 Codex 的对话界面
- **工具审批**: 可视化的工具调用审批
- **子智能体管理**: 可视化管理多个智能体
- **代码差异查看**: 内嵌 diff 查看器
- **设置面板**: 完整的配置界面

## 快速开始

### 安装依赖

```bash
npm install
```

### 开发模式

启动 Web UI：
```bash
npm run dev:ui
```

启动 CLI 工作台：
```bash
npm run cli
```

### 构建

构建 Web UI：
```bash
npm run build:ui
```

构建工作台：
```bash
npm run build:workbench
```

## 技术栈

- **Runtime**: Node.js + TypeScript
- **UI**: HTML/CSS/JavaScript (原生)
- **Desktop**: Tauri + Rust (可选)
- **Testing**: Vitest

## 架构设计

### 分层架构

```
┌─────────────────────────────────────┐
│         UI Layer (Web/CLI)          │
│   apps/web-ui + apps/agent-workbench│
├─────────────────────────────────────┤
│       Controller Layer              │
│  task-controller, runtime-bridge    │
├─────────────────────────────────────┤
│       Agent Runtime Layer           │
│  packages/agent-runtime             │
├─────────────────────────────────────┤
│       Provider Layer                │
│  OpenAI Compatible API              │
└─────────────────────────────────────┘
```

### 核心概念

1. **Session**: 会话管理，包含消息历史和上下文
2. **Runtime**: 运行时环境，负责模型调用和工具执行
3. **Permission Policy**: 权限策略，控制工具调用权限
4. **Tool**: 工具定义，包含文件操作、命令执行等
5. **Snapshot**: 快照机制，用于状态保存和恢复
6. **Compression**: 上下文压缩，优化 token 使用

## 后续改进方向

见 `ROADMAP.md`

## License

MIT
