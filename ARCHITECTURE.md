# Conex 代码库架构分析

## 项目概览

**Conex** 是一个基于 Agent Runtime 的智能体工作台，提供完整的命令行和 Web UI 界面。

```
核心价值主张：
- 可视化的 AI Agent 交互界面
- 细粒度的工具调用权限控制
- 多智能体协作管理
- 完整的会话历史和快照系统
```

---

## 架构分层

```
┌─────────────────────────────────────────────────────┐
│                 UI Layer (呈现层)                     │
│  ┌──────────────────┐    ┌─────────────────────┐   │
│  │   Web UI         │    │   CLI Interface     │   │
│  │  apps/web-ui     │    │  apps/agent-        │   │
│  │                  │    │   workbench/cli     │   │
│  └──────────────────┘    └─────────────────────┘   │
└─────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────┐
│              Controller Layer (控制层)                │
│  ┌──────────────────────────────────────────────┐  │
│  │  Task Controller, Runtime Bridge              │  │
│  │  apps/agent-workbench/shared                  │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────┐
│              Runtime Layer (运行时层)                 │
│  ┌──────────────────────────────────────────────┐  │
│  │  Agent Runtime                                │  │
│  │  packages/agent-runtime                       │  │
│  │  - 模型调用、工具执行、权限管理               │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────┐
│              Provider Layer (提供商层)                │
│  ┌──────────────────────────────────────────────┐  │
│  │  OpenAI Compatible API                        │  │
│  │  - Claude, GPT, MiMo, 等                     │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 核心模块详解

### 1. Agent Runtime (`packages/agent-runtime`)

**职责**: 核心运行时引擎，负责模型调用、工具执行、权限管理

#### 关键模块

##### 1.1 runtime.ts (~2,500 行)
- **核心类**: `AgentRuntime`
- **功能**: 
  - 会话管理 (session management)
  - 消息循环 (message loop)
  - 工具调用编排 (tool orchestration)
  - 错误恢复 (error recovery)

```typescript
class AgentRuntime {
  async run(userMessage: string): Promise<void> {
    // 1. 添加用户消息到会话
    // 2. 调用模型 API
    // 3. 处理工具调用
    // 4. 权限检查
    // 5. 执行工具
    // 6. 返回结果给模型
    // 7. 循环直到完成
  }
}
```

##### 1.2 permissions.ts (~800 行)
- **核心接口**: `PermissionPolicy`
- **功能**: 
  - 权限决策引擎
  - 支持 allow/deny/ask 三种策略
  - 支持通配符和正则匹配
  - 审计日志

```typescript
interface PermissionPolicy {
  decide(request: PermissionRequest): PermissionDecision;
}

type PermissionDecision = 
  | { behavior: "allow", reason: string }
  | { behavior: "deny", reason: string }
  | { behavior: "ask", reason: string };
```

##### 1.3 tools.ts + local-tools.ts (~2,000 行)
- **核心**: 工具系统
- **内置工具**:
  - `Read` - 文件读取
  - `Write` - 文件写入
  - `Edit` - 文件编辑
  - `Bash` / `PowerShell` - 命令执行
  - `Glob` - 文件搜索
  - `Grep` - 内容搜索

```typescript
interface AgentTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
  execute(input: unknown): Promise<ToolOutput>;
}
```

##### 1.4 context-compression.ts (~600 行)
- **功能**: 上下文压缩
- **策略**:
  - 保留最近的 N 条消息
  - 压缩工具输出（摘要化）
  - 保留关键消息（用户指令、错误）

##### 1.5 subagents.ts (~500 行)
- **功能**: 子智能体管理
- **特性**:
  - 并行执行多个子任务
  - 父子智能体消息隔离
  - 子智能体的独立权限策略

##### 1.6 encoding.ts (~400 行)
- **功能**: 中文编码保护
- **特性**:
  - 自动检测文件编码
  - UTF-8 / GBK / GB2312 转换
  - 防止乱码写入

##### 1.7 snapshots.ts (~300 行)
- **功能**: 会话快照
- **用途**:
  - 保存当前会话状态
  - 恢复到历史快照
  - 支持分支会话

##### 1.8 background-command.ts (~400 行)
- **功能**: 后台命令执行
- **特性**:
  - 异步命令执行
  - 实时输出流
  - 超时控制

---

### 2. Agent Workbench (`apps/agent-workbench`)

**职责**: 命令行和桌面端工作台

#### 2.1 CLI 模块 (`src/cli/`)

##### main.ts
- CLI 入口点
- 参数解析
- 运行模式选择

##### goal-runner.ts
- 目标驱动执行
- 自动规划和执行

##### workbench-runner.ts
- 交互式工作台
- REPL 循环

##### runtime-factory.ts
- 运行时工厂
- 配置加载
- 提供商初始化

#### 2.2 共享模块 (`src/shared/`)

##### task-controller.ts
- 任务调度
- 任务状态管理
- 任务依赖解析

##### background-command-bridge.ts
- 后台命令桥接
- 将 runtime 的后台命令暴露给 UI

##### runtime-bridge.ts
- 运行时桥接层
- 事件转发
- 状态同步

---

### 3. Web UI (`apps/web-ui`)

**职责**: Web 前端界面

#### 3.1 核心文件

##### index.html
- 主页面结构
- 包含完整的 UI 组件树
- 侧边栏、聊天区、设置面板

##### app.js
- 主应用逻辑
- 事件绑定
- UI 交互

##### js/chat.js
- 聊天消息处理
- 消息渲染
- 流式显示

##### js/subagents.js
- 子智能体 UI 逻辑
- pill 状态更新
- 浮动窗口管理

##### js/theme.js
- 主题切换
- 深色/浅色模式
- 自定义主题

##### server.js
- HTTP 服务器
- 静态文件服务
- （待添加）WebSocket 服务

---

## 数据流

### 用户消息流程

```
用户输入
  ↓
UI (Web/CLI)
  ↓
Task Controller
  ↓
Runtime Bridge
  ↓
Agent Runtime
  ↓
Permission Policy ──→ (ask) ──→ 用户审批
  ↓ (allow)
Tool Execution
  ↓
Provider API (Claude/GPT)
  ↓
Response Stream
  ↓
UI 渲染
```

### 工具调用流程

```
模型请求工具调用
  ↓
Runtime 解析工具调用
  ↓
Permission Policy.decide()
  ├─→ allow: 直接执行
  ├─→ deny: 返回错误
  └─→ ask: 发送审批请求到 UI
        ↓
    用户审批 (UI)
        ↓
    执行工具
        ↓
    返回结果
```

---

## 技术栈

### 后端
- **语言**: TypeScript
- **运行时**: Node.js 20+
- **测试**: Vitest
- **桌面端**: Tauri 2.x (Rust)

### 前端
- **框架**: 原生 JavaScript (无框架)
- **样式**: CSS Variables + 自定义样式
- **图标**: Lucide Icons
- **字体**: Inter, Outfit, JetBrains Mono

### 构建工具
- **打包**: Vite
- **类型检查**: TypeScript 5.9+
- **Monorepo**: npm workspaces

---

## 依赖关系图

```
agent-workbench
    ↓
agent-runtime ←── shared-types
    ↓
provider-openai-compatible
    ↓
OpenAI/Claude API

web-ui (独立)
    ↓
(待连接到 agent-runtime)
```

---

## 配置系统

### Runtime 配置

```typescript
interface AgentRuntimeOptions {
  provider: ProviderConfig;
  tools: AgentTool[];
  permissionPolicy: PermissionPolicy;
  maxTurns?: number;
  workingDirectory?: string;
}
```

### Provider 配置

```typescript
interface ProviderConfig {
  type: "openai-compatible";
  apiKey: string;
  baseURL: string;
  model: string;
  temperature?: number;
}
```

---

## 扩展点

### 1. 自定义工具
```typescript
const myTool: AgentTool = {
  name: "my_tool",
  description: "My custom tool",
  input_schema: { /* ... */ },
  async execute(input) { /* ... */ }
};
```

### 2. 自定义权限策略
```typescript
const myPolicy: PermissionPolicy = {
  decide(request) {
    // 自定义逻辑
    return { behavior: "allow", reason: "..." };
  }
};
```

### 3. 自定义提供商
```typescript
class MyProvider implements AgentProvider {
  async stream(messages) { /* ... */ }
}
```

---

## 性能特性

### 上下文管理
- **压缩触发**: token 数超过阈值自动压缩
- **压缩策略**: 保留最近消息 + 摘要历史
- **快照恢复**: O(1) 恢复到任意快照

### 工具输出控制
- **预算限制**: 单个工具输出最大 200KB
- **超长截断**: 自动截断并提供"展开"选项
- **流式处理**: 大文件分块读取

### 并发控制
- **子智能体并行**: 最多 N 个并行子任务
- **后台命令**: 异步执行，不阻塞主流程

---

## 安全特性

### 权限控制
- **最小权限原则**: 默认拒绝所有操作
- **显式授权**: 每个工具调用需要审批
- **审计日志**: 记录所有工具调用

### 沙箱隔离
- **工作目录限制**: 限制文件访问范围
- **命令白名单**: 只允许特定命令
- **超时保护**: 防止无限循环

---

## 测试策略

### 单元测试
- Runtime 核心逻辑测试
- 工具执行测试
- 权限决策测试

### 集成测试
- 端到端会话测试
- 工具调用流程测试
- 子智能体协作测试

### 测试覆盖率
- 当前: ~40% (估算)
- 目标: 80%+

---

## 已知限制

1. **UI 未连接到 Runtime**: Web UI 是独立原型，需要集成
2. **无云端同步**: 会话数据仅本地存储
3. **单用户**: 不支持多用户协作
4. **无插件系统**: 功能扩展需要修改代码
5. **桌面端未充分利用**: Tauri 功能未完全发挥

---

## 下一步工作

详见 `ROADMAP.md`

最紧急的任务：
1. **WebSocket 服务器** - 连接 UI 和 Runtime
2. **工具审批流程** - 实现安全的工具调用
3. **会话持久化** - 保存和恢复会话历史
