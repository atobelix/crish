# Contribute Points（View 轨）· W4-C 骨架

对齐：`docs/block-workspace-architecture/plans/06-扩展与Agent工具面.md`、round-D `06-扩展宿主与Agent工具面.md` §5、**EL-07**（TS 扩展一等 / 投影-only）。

## 职责

| API                                 | 行为                                              |
| ----------------------------------- | ------------------------------------------------- |
| `register(contrib)`                 | 登记 slash_item / block_view / widget / keymap    |
| `list(kind?)`                       | **仅**返回 `ViewDescriptor`（可序列化 UI 元数据） |
| `unregister` / `unregisterByPlugin` | 生命周期清理                                      |

## 权限（声明优先）

- **必填**：`ui:contribute` — 无声明 → `missing_permission`，拒绝注册
- **可选声明字段**：`note:read` / `note:write`（笔记域；`note:write` 仍只表示「可走审批写工具」，**不**等于拿到 write store）
- 与 TrustGate / manifest `permissions` 同字面量；本注册表在 contribute 载荷上再校验一遍

## block_view 与 flavour（M4 回应）

- **W4-C**：`block_view` **只能装饰已知 flavour**（`DEFAULT_KNOWN_FLAVOURS` 或宿主 `setKnownFlavours`）
- 未知 flavour：默认 `unknown_flavour` 拒绝；可选 `unknownFlavourPolicy: 'warn'` 降级注册并回调
- **非永久锁死**：`registerFlavour` 路线图 F1+ 后，宿主把第三方 flavour 并入 known 集即可装饰（见 `plans/specs/register-flavour-roadmap.md`）

## 禁止（EL-07 / 投影-only）

| 禁止                                                           | 原因                                      |
| -------------------------------------------------------------- | ----------------------------------------- |
| DOM 旁路存档（`innerHTML` / `getRootElement` / `execCommand`） | 不进 RS 事务，撕裂索引与 origin           |
| 扩展拿到 write store / `applyOp` / 直写 SQLite                 | 第二写入口；恶意扩展零持久化目标失败      |
| 把 contribute 当工具执行面                                     | 写必须走 ToolRegistry + session-loop 审批 |

`register` 会拒绝载荷上的 `store` / `applyOp` / `write` 等写句柄键；`list` 返回对象经 `Object.freeze`，形状固定为视图描述符。

## 非目标（本波）

- 完整插件沙箱 VM / iframe 隔离
- Command 轨 `registerTool` 与确认矩阵（另轨）
- 真实 React/Lit 组件挂载（仅 component 键字符串）

## 用法摘要

```ts
import {
  createContributePointRegistry,
  type Contribution,
} from '@crish/plugin-sdk/contribute';

const reg = createContributePointRegistry();

const r = reg.register({
  id: 'cite',
  pluginId: '@vendor/note-helpers',
  kind: 'slash_item',
  permissions: ['ui:contribute'],
  title: '插入引用',
  action: { insert: 'cite' },
});

// 仅描述符 — 无 store
const items = reg.list('slash_item');
```
