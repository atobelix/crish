# `@crish/block-paper`

块纸面 **呈现 chrome**（W3-C）：静默假数据骨架、把手/折叠/多选状态模型、slash 菜单状态机。

> **本包是呈现 chrome，不是文档权威。**  
> 写路径必须走 **Intent → RS apply**。  
> **禁止** 把 DOM / ProseMirror doc / 本包假数据当作真相源持久化。

## 边界

| 本包 **做**                                    | 本包 **不做**                   |
| ---------------------------------------------- | ------------------------------- |
| 静默 L0 chrome 状态（把手/折叠/多选高亮）      | 真实 DocSession / RS / 协同接线 |
| Slash 打开/过滤/关闭（composing 禁开）         | 叶子 PM/CM6 适配（W3-D）        |
| N 块假投影（`ProjectionDiff` / `MemoryBlock`） | 结构 Op 真正落地（W3-F）        |
| 纯 TS 可测模型                                 | 接 `apps/crish-desktop` 业务    |

依赖：

- `@crish/block-paper-contract` — W0 类型（`ProjectionDiff` / `BlockId` / `SlashContribution` …）
- `@crish/editor-kit` — `MemoryBlock` / `applyProjectionDiff` / IME 守卫思想

## 导出一览

```ts
import {
  BlockChromeModel,
  SlashMenuModel,
  createSilentFixture,
  listSilentBlocks,
  DEFAULT_SLASH_CATALOG,
} from '@crish/block-paper';
```

## 静默假数据（A-SIL 子集）

```ts
const fixture = createSilentFixture(32, { docId: 'demo' });
// fixture.state 已 apply 增量 Diff；fullRemountCount === 0
// fixture.blocks / fixture.order 符合 MemoryBlock 形状
const blocks = listSilentBlocks(fixture);
```

假数据 **仅供 chrome 原型与单测**；接真实键入必须等 01+04 投影通道。

## BlockChromeModel

| API                                       | 语义                                      |
| ----------------------------------------- | ----------------------------------------- |
| `setHovered` / `setFocused`               | 按需露出把手                              |
| `getHandleVisibility(id)`                 | `hidden` \| `hover` \| `focus` \| `multi` |
| `setCollapsed` / `toggleCollapsed`        | 折叠呈现态                                |
| `setMultiSelected` / `clearMultiSelected` | 多选高亮（逻辑 id）                       |
| `resetToSilent`                           | 清 hover/focus/多选/命令 → L0 纸面        |

默认 **L0**：无交互时所有把手 `hidden`（A-SIL-01：无常驻噪声）。

## SlashMenuModel + IME

```ts
const imeComposing = { current: false };
const slash = new SlashMenuModel({
  isComposing: () => imeComposing.current,
});

imeComposing.current = true;
slash.open('b-0001', 0); // → { ok: false, code: 'composing' }

imeComposing.current = false;
slash.open('b-0001', 0); // → ok
slash.setQuery('标');
slash.close(); // A-SIL-02：关闭后宿主保持选区
```

对齐 editor-kit `structureKeyGuard` / A-IME-02：**composing 时禁止打开 slash**。

## 不变量速查

1. **DOM 不是真相** — 投影与选区逻辑坐标才是呈现源；写必须 Intent→RS
2. **静默默认 L0** — chrome 按需（hover / 多选 / 命令态）
3. **composing 禁 slash** — 注入 `isComposing`，与 ImeMachine 一致
4. **假数据可加载不抛** — `createSilentFixture(n)` 对任意有限 n≥0 安全
5. **多选是逻辑 id 列表** — 禁止像素测距选块（A-SEL-01）

## 脚本

```bash
npm run typecheck -w @crish/block-paper
npx vitest run packages/block-paper/src
# 或
npm test -w @crish/block-paper
```

## 任务索引

- 方案：`docs/block-workspace-architecture/plans/05-块呈现与交互.md`
- IME/投影：`plans/04-投影虚拟化与IME.md`、`@crish/editor-kit`
- 验收：A-SIL-01…02 子集（W3-C）；**≠ EL-01 / A-BLK 全表关闭**
