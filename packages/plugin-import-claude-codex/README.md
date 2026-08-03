# @crish/plugin-import-claude-codex（官方导入插件）

> 生态插件试点（E3）：Claude Code / Codex CLI 对话导入——纯函数抽包 + manifest 声明 + 宿主接线。
> 参考 kimi-datasource 的「纯声明包 + SKILL.md 式使用说明」形态：本包不承载 UI/文件系统能力，
> 文件读取由宿主经 `ImportFs` 注入面接入（依赖全注入原则）。

## 能力清单

- **工具（只读纯函数）**
  - `parse-claude-code-jsonl`：入参 `content`（JSONL 文本）+ 选项 → 出参 `SessionImportPayload`
  - `parse-codex-rollout-jsonl`：入参 `content`（JSONL 文本）+ 选项 → 出参 `SessionImportPayload`
- **钩子**：`session.start`（observe，会话开始注入使用说明日志）
- **探测**：`detectExternalSessions` + 根目录解析（`resolveDefaultImportRoots`）——元数据 only，不解析全文

## 使用说明（给模型 / 宿主）

1. 需要把 Claude Code 或 Codex CLI 的会话 JSONL 导入 Crish 时，先读文件内容（宿主 `ImportFs.readText`），
   再调用对应工具并传入 `content` 字符串。
2. 工具返回的 `SessionImportPayload` 是中立载荷（消息为 `ImportMessageDraft`），
   宿主侧 `map.ts` 的适配层把它转为 store 的 `SessionMessage[]` 后写库（`createSession` + `addMessage`）。
3. 可选参数：`sourceSessionId`（来源会话 id 兜底）、`maxLines`（行数上限）、
   `title` / `folder` / `sessionId`（覆盖标题/文件夹/目标会话 id）、`sourcePath`（溯源展示）。
4. 隐私：绝不记录消息正文；探测只保留路径 + 短标题预览。

## 目录结构

```
src/
├── manifest.ts          # manifest 声明（id @crish/import-claude-codex, v1.0.0, trustLevel full）
├── activate.ts          # activate(api)：注册 session.start observe 观察
├── tools.ts             # 工具执行体（parse + map → SessionImportPayload）
├── types.ts             # 中立载荷类型（不依赖宿主 store/types）
├── parse/               # parseClaudeCodeJsonl / parseCodexRolloutJsonl（纯函数）
├── map.ts               # mapToCrishSession（纯函数；宿主侧再做 draft → SessionMessage 适配）
├── detect.ts            # detect 纯函数 + ImportFs 注入面
└── __tests__/           # 解析/映射/探测/manifest/激活端到端测试（fixtures 齐全）
```

## 宿主接线（apps/crish-desktop）

- `src/api/import/`：瘦身为宿主编排（scan/importFsHost/importRootSettings/importSessions 保留；
  parse 与 map 与 detect 改消费本包；`types.ts` 载荷中立化）。
- `src/components/settings-extensions/`：`kind: 'plugin'` 泛化——manifest 元数据展示 + 启停开关
  （来自插件注册表状态；本包为内置官方插件，默认展示于已安装列表）。

## 开发与测试

```bash
npx vitest run packages/plugin-import-claude-codex   # 插件包测试
npm run typecheck                                     # 全仓类型（含宿主接线）
npm run test:desktop-helpers                          # 宿主 import 回归
```

## 版本

- 1.0.0：首个官方插件试点（纯函数 + manifest + 宿主接线；不做 UI 回调）
