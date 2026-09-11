# 系统补全执行进度

**更新日期**: 2026-07-22（Phase 4–5 推进收口）
**依据**: `00-master-multi-agent-roadmap.md` + `plans/01`–`05`

---

## 总览

| Phase                  | 状态    | 说明                                                                                    |
| ---------------------- | ------- | --------------------------------------------------------------------------------------- |
| 0 方案固化             | ✅      | audits + plans + master roadmap                                                         |
| 1 诚实能力面           | ✅      | Provider 真 Anthropic/Gemini + MCP 启停/配置 + UI 诚实                                  |
| 2 Goal 长程            | ✅      | run-task 下发 goal；假完成收敛；默认 12 轮                                              |
| 3 工具/循环            | ✅      | 超时 softDeny；fatalOnError；synthesis system；retry 轮次                               |
| 4 采集/Rewind/插件纵深 | ✅ 主体 | Rewind 入口 + tool-output guard + responseStyle + 插件安全加载 + 磁盘 oracle + 冒烟脚本 |
| 5 P2 增强              | ✅ 标记 | Sampling/Elicitation deferred 能力位；Permission 工厂；exclusive 分区语义               |

---

## 已落地代码要点

### Provider（plans/01）

- Anthropic Messages SSE 真实现 + daemon family 分派
- Gemini streamGenerateContent SSE 真实现 + daemon 分派
- LiteLLM sparse clone：`reference/litellm`（对照用）
- 废弃双轨 `provider-factory` 标注

### MCP + 权限（plans/02）

- `McpLifecycleManager.startServer/stopServer`
- daemon factory 真调用；idle list `configured`
- mcp.json / env / update-config 注入
- Desktop probe 不因 experimental 一律禁用
- 审批超时 → softDeny tool-result（不 abort）
- denial 结构化 code/softDeny
- **tool-output guard**：`tool-output-guard.ts` 投影层包装 untrusted 边界
- **exclusive / sequential / parallel** 分区语义明确（exclusive 永不入 parallel 组）
- **PermissionMiddleware 工厂**：`createPermissionMiddlewarePipeline`（主路径仍 `resolvePermission` + 同 policy，避免双审批）
- **Sampling / Elicitation**：capabilities `mcp.sampling` / `mcp.elicitation` = unsupported deferred

### Goal + 软件内测契约（plans/03）

- 桌面 run-task 带 `mode/visibleGoal/maxRounds/maxStalledRounds`
- DONE 不再强制勾满未完 checklist
- **磁盘 oracle**：`goal-disk-oracle.ts`（exists / file / contains / json-path）
- **软件内冒烟脚本**：`scripts/inapp-goal-smoke.mjs`（daemon probe + 场景清单报告）

### Session / UI（plans/04–05）

- 分叉 toast 诚实（仅本地副本）
- 扩展安装 toast 诚实
- 主对话 deny 失败回滚 + toast
- 批量审批全部批准/拒绝已接线
- **Rewind UI**：`conversationRewindApi` + ChatHeaderMore「对话回溯」→ daemon preview（诚实失败 toast）
- **Checkpoint restore**：product surface 仍不含 restore Tauri 命令；capability 文案标明 list/diff only
- **Durable fork**：daemon 仍 unsupported（合约未冻结前不开放按钮冒充）
- **responseStyle → prompt**：run-task `systemPrompt` 字段 + desktop 从设置注入风格指导
- **插件加载**：FS registry 默认只注册 manifest，需 `CRISH_ALLOW_UNSAFE_PLUGIN_IMPORT=1` 才同进程 import

### Loop 质量

- synthesis → system + internal
- fatalOnError 真中止
- orchestrator goal round：retry 不扣 productive

---

## 明确未完成 / 后续纵深（非阻塞主闭环）

| ID  | 项                                          | 说明                                                                      |
| --- | ------------------------------------------- | ------------------------------------------------------------------------- |
| R   | Durable session fork 完整实现               | Round B 合约已设计；实现待 session-tree 持久化克隆里程碑                  |
| R   | Rewind apply 完整预览面板                   | 入口 + preview API 已接；结构化 apply 确认 UI 可增强                      |
| R   | Checkpoint product restore                  | 决策为 product 表面不下架 list/diff；restore 仍 experimental/adapter 半截 |
| R   | 插件沙箱 worker                             | 默认禁 unsafe import；真正 worker/vm 沙箱为 P2                            |
| R   | PermissionMiddleware 替换 resolvePermission | 工厂已导出；避免双审批，未强制替换主路径                                  |
| R   | 流式 tool 预并发（streaming pipeline）      | 批内 parallel 已有；流式预取并发为 P2                                     |
| R   | Tauri WebView2 全自动 E2E                   | smoke 脚本 + capture 钩子；完整 3 条 goal E2E 需本机壳运行                |

---

## 验证命令（合并前）

```powershell
npx vitest run packages/agent-runtime packages/agent-daemon packages/agent-orchestrator apps/crish-desktop --coverage.enabled=false
node scripts/inapp-goal-smoke.mjs
```

---

## 本轮关键新文件

| 路径                                                             | 用途                        |
| ---------------------------------------------------------------- | --------------------------- |
| `packages/agent-runtime/src/tool-output-guard.ts`                | 不可信 tool-output 边界包装 |
| `packages/agent-runtime/src/goal-disk-oracle.ts`                 | Goal L3 磁盘证据门禁        |
| `packages/agent-runtime/src/response-style.ts`                   | responseStyle → system 文案 |
| `packages/agent-runtime/src/tools/create-permission-pipeline.ts` | Permission 管线工厂         |
| `apps/crish-desktop/src/api/conversationRewindApi.ts`            | Rewind preview/apply 桥     |
| `scripts/inapp-goal-smoke.mjs`                                   | 软件内 goal 冒烟报告        |
