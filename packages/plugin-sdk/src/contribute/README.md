# Contribute Points（View 轨）· W4-C + M4 registerFlavour

对齐：`docs/block-workspace-architecture/plans/06-扩展与Agent工具面.md`、round-D `06-扩展宿主与Agent工具面.md` §5、**EL-07**（TS 扩展一等 / 投影-only）、`plans/specs/register-flavour-roadmap.md`。

## 职责

| API                                                | 行为                                                    |
| -------------------------------------------------- | ------------------------------------------------------- |
| `register(contrib)`                                | 登记 slash_item / block_view / widget / keymap          |
| `list(kind?)`                                      | **仅**返回 `ViewDescriptor`（可序列化 UI 元数据）       |
| `unregister` / `unregisterByPlugin`                | contribute 生命周期清理                                 |
| **`registerFlavour(def)`**                         | **M4 正式 API**：把第三方 flavour 写入 known 集（幂等） |
| `listFlavours` / `getFlavour`                      | flavour 元数据快照（投影-only）                         |
| `unregisterFlavour` / `unregisterFlavoursByPlugin` | flavour 登记清理                                        |
| `setKnownFlavours`                                 | 宿主批量 merge/replace known id 集                      |

## 权限（声明优先）

### contribute 注册（`register`）

- **必填**：`ui:contribute` — 无声明 → `missing_permission`
- **可选**：`note:read` / `note:write` / `note:extend`（声明不影响 View 描述符形状）
- 即便声明 `note:write`，View 轨 **仍不**返回 write store

### flavour 扩展（`registerFlavour`）

- **门槛**：`ui:contribute` **或** 专用 `note:extend`（任一即可）
  - `ui:contribute`：已有 View 贡献权，顺带扩展 known flavour
  - `note:extend`：仅扩展 flavour 元数据；**不**自动授予 `register(contrib)` 权
- **可选附带**：`note:read` / `note:write`（仍无写句柄）
- 与 TrustGate / manifest `permissions` 同字面量（`note:extend` 已入 `PLUGIN_PERMISSIONS`）

## block_view 与 flavour（M4 兑现）

- **W4-C**：`block_view` **只能装饰已知 flavour**
- known 来源：
  1. `DEFAULT_KNOWN_FLAVOURS`（内置）
  2. 宿主 `setKnownFlavours` / 构造期 `knownFlavours`
  3. **`registerFlavour({ id, displayName, category, allowedContribute, … })`**
- 未知 flavour：默认 `unknown_flavour` 拒绝；可选 `unknownFlavourPolicy: 'warn'` 降级
- 若 flavour 经 `registerFlavour` 登记且声明了 `allowedContribute`，则 contribute kind 须在列表内，否则 `contribute_not_allowed`
- **EL-07 兑现面变宽**：自定义块类型可进 known 集并被装饰，**但仍是投影-only**（无写路径、无 store 句柄）

## 禁止（EL-07 / 投影-only）

| 禁止                                                           | 原因                                      |
| -------------------------------------------------------------- | ----------------------------------------- |
| DOM 旁路存档（`innerHTML` / `getRootElement` / `execCommand`） | 不进 RS 事务，撕裂索引与 origin           |
| 扩展拿到 write store / `applyOp` / 直写 SQLite                 | 第二写入口；恶意扩展零持久化目标失败      |
| `registerFlavour` 夹带 store / applyOp                         | 扩展绕过写路径；载荷直接拒绝              |
| 把 contribute / flavour 当工具执行面                           | 写必须走 ToolRegistry + session-loop 审批 |

`register` / `registerFlavour` 均拒绝载荷上的 `store` / `applyOp` / `write` 等写句柄键；`list` / `listFlavours` 返回对象经 `Object.freeze`。

## 非目标（本波）

- 完整插件沙箱 VM / iframe 隔离
- Command 轨 `registerTool` 与确认矩阵（另轨）
- RS schema 校验引擎接线（F1 另轨；`schema` 字段仅元数据快照）
- 真实 React/Lit 组件挂载（仅 component 键字符串）

## 用法摘要

```ts
import {
  createContributePointRegistry,
  type Contribution,
  type FlavourDefinition,
} from '@crish/plugin-sdk/contribute';

const reg = createContributePointRegistry();

// 1) 扩展 known flavour（幂等）
const fr = reg.registerFlavour({
  id: 'vendor.callout',
  displayName: 'Callout',
  category: 'basic',
  allowedContribute: ['block_view', 'slash_item'],
  permissions: ['note:extend'], // 或 'ui:contribute'
  pluginId: '@vendor/note-helpers',
});
// fr.ok && fr.idempotent === false（首次）

// 2) 第三方 blockView 装饰已 register 的 flavour
const r = reg.register({
  id: 'callout-view',
  pluginId: '@vendor/note-helpers',
  kind: 'block_view',
  permissions: ['ui:contribute'],
  flavour: 'vendor.callout',
  component: 'vendor-callout-view',
});

// 3) 未知 flavour 仍拒
reg.register({
  id: 'evil',
  pluginId: '@vendor/note-helpers',
  kind: 'block_view',
  permissions: ['ui:contribute'],
  flavour: 'never-registered',
  component: 'x',
}); // → unknown_flavour

// 仅描述符 — 无 store
const items = reg.list('block_view');
const flavours = reg.listFlavours();
```
