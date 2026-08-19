# 04 · Composer 新件与 token（S4 终稿）

| 字段 | 内容 |
| --- | --- |
| **效果** | 输入区与对话流同一套克制 surface；缺件补齐；不覆盖产品 Composer 内核 |
| **切片** | S4 |
| **依赖** | S1 包含块（现 `ChatComposerWrapper`） |
| **并行** | 可与 S3 并行 |

## 1. 目标效果

产品权威仍是 `components/chat-composer/ChatComposer.tsx`（Tiptap + 回落、斜杠、@、队列、撤回、L2/L3）。参考仓只吸 IA 与密度。

| 件 | 完成句 | 不要 |
| --- | --- | --- |
| 附件卡 | 横滑发丝卡、类型图标、悬停小叉、点开走叶预览 | picsum、绿虚线 tab 拖拽皮 |
| inline tag | 文件图标盒 + Skill 变体，点卡开预览 | `dangerouslySetInnerHTML` + 参考仓图标字典 |
| `@@` 目录树 | 输入锚点唤工作区树 | 假 `src/components/` DOM；第二套 popovers.js |
| 融合触发 | 一条弱分割胶囊：左真模型、右思考档 | 写死 Claude 3.7；品牌绿光晕 |
| 圆形发送 | 可选：空态收起、无绿光晕 | `--brand` glow |
| 权限胶囊 | 可吸 icon-only 密度 | 五档色盘灌进产品四模 |
| 拖放遮罩 | 叶内 contain，无彩 inset | 整页绿框 |
| Tooltip | 全部自定义 Tooltip | 原生 `title` |

语音钮本战役不做（无链路）。`/` `@` Skill 已有运行时，只收敛皮，不注册第二 slash。

## 2. Token

映射产品 `styles/tokens.css`：`--text-*` / `--border-*` / `--composer-bg` / `--tint-*` / `--focus-ring-subtle`（6%）。

禁止引入：`--brand` 光晕、`--flow-rail-*`、Geist/MiSans 整包、Google Fonts、`composer.css` 1966 行星壳、`transition: all`。

新对话/composer 面禁止再引 `--accent-blue`。完成态无彩，绿不表示成功。

## 3. 文件域

仅 `apps/crish-desktop/src/components/chat-composer/**` 与相关 CSS module。不改 `shell-layout.css` 行数帽。

## 4. 验收

- 焦点混入 ≤ 6%（空态 ≤ 5%），`box-shadow: none`。
- 无新增原生 `title=`。
- 附件/@@/融合有单测或交互测（jsdom）；像素等 S9。
- 发送仍只吃纯文本（input-stream 锁）。

## 5. 非目标

不重开 composer-preview / frontend-convergence；不捏回上帝 Hook；不删 `composerDrafts` persist。
