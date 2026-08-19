# 分维终稿 · 滚动条、Toast、输入区与壳

对应总案 I6 I7 I8。调研：`survey/08` `09` `11` `12` `15`。

## 滚动条

禁止创建 `shell-scrollbar.css`（壳换代禁名）。新出口例如 `apps/crish-desktop/src/styles/overlay-scrollbar.css`：

- `scrollbar-width: thin`
- `::-webkit-scrollbar` 约 6–8px，轨道透明，无上下三角观感
- token 用已有 `--tint-scrollbar-thumb`
- 接到：`.sidebarScroll`、`.menuContent`、设置 `.coverContent` / `.navScroll`

`style-contract` 基线从「≤5 且文件已删仍绿」改成**断言新出口存在**。

## Toast

- 不要用 `Button ghost sm` 当关闭块（那就是真机竖分割）
- 关闭是发丝图标，不要 28px 灰底
- 去掉 400ms 过冲从右侧弹入
- `notify` 过滤补上 `已自动获取`
- 成功/失败不要同一张灰皮（至少用已有 `AppToast.type`）

侧栏「更多」同一颗 `ghost sm` 灰方：改成真正的 ⋯ 图标钮，开菜单时 Tip 必须灭（走 I2）。

## OpenCode 重复

`listPickerProfiles`（或唯一列出函数）按**展示名**折叠；种子 `opencode-go` 与预设拷出来的 `custom-*` / `preset-opencode-go` 不得两行同名。添加预设若已有同名展示名则绑定已有行，不要 `createCustomProfile` 再造一份。

## 空叶 / 未命名

- UnitChrome 的 Tooltip 不要被钳成画布中央大胶囊；空态走 `ChatEmptyState` 已写的欢迎面
- 顶栏 caption 用会话展示名，禁止写死「未命名会话」（权威 `EMPTY_SESSION_TITLE = '新会话'`）
