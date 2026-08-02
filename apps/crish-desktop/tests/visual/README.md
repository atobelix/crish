# tests/visual —— Visual 回归门禁（PE-11 T11.2 唯一 owner）

PE-05 样式迁移期的视觉回归门禁：可重复截图基线 + 1% 像素差阈值 + 人工复核流程，
防止「改样式改坏布局」无感知（AU-02 §五.4）。

---

## 1. 稳定化三件套（T11.2-1）

1. **mock Tauri invoke**：复用 T11.1 L2 mock 引擎（`tests/e2e/mock-engine.ts`），
   浏览器环境注入 `__TAURI_INTERNALS__`，事件/命令面全部确定性；
2. **固定 viewport**：`apps/crish-desktop/playwright.config.ts` 统一声明
   （1280×800 / deviceScaleFactor 1）；
3. **字体与动画**：`helpers.openVisualApp` 等待 `document.fonts.ready` +
   mock 引擎注入 `*{animation:none!important;transition:none!important}`。

## 2. 阈值与更新流程（T11.2-2）

- 阈值：`toHaveScreenshot({ maxDiffPixelRatio: 0.01 })`（1% 像素差，容忍抗锯齿抖动）；
- 基线入库：`tests/visual/__screenshots__/`（提交到 git，
  `git ls-files | grep __screenshots__` 非空为验收）；
- 更新基线：`npm --workspace @crish/crish-desktop run test:visual:update`；
- **golden 变更必须显式审查**：PR 附 diff 图，评审人确认后方合并
  （对齐 PE-03 T03.8「golden 变更必须显式更新」精神）；
- 负例验证：人为注入样式回归（如改错主色）→ 套件必须失败。

## 3. 运行方式

```bash
# 生成/比对基线（自动拉起 vite dev server :5174）
npm --workspace @crish/crish-desktop run test:visual

# 更新基线（仅确认基线合理时执行）
npm --workspace @crish/crish-desktop run test:visual:update
```

CI 归属：慢层（nightly + 发布前）。PE-05 每个迁移单元（T05.1.2/5.2/5.3/5.5）
提交前必跑：迁移前后各拍一次，diff 归零或人工确认（T11.2-4 联动条款）。

## 4. 8 个 story（T11.2-3）

| #   | story                                       | 文件内 test 名  |
| --- | ------------------------------------------- | --------------- |
| 01  | 初始布局（侧栏+主区空态）                   | 01 初始布局     |
| 02  | 侧栏会话列表（3 会话 mock）                 | 02 侧栏会话列表 |
| 03  | 设置面板（模型 tab）                        | 03 设置面板     |
| 04  | 聊天消息（纯文本完成态）                    | 04 聊天消息     |
| 05  | fence 代码块（含未闭合软渲染态 + 完成态）   | 05 fence 代码块 |
| 06  | 表格                                        | 06 表格         |
| 07  | 工具调用卡                                  | 07 工具调用卡   |
| 08  | 暗色主题（prefers-color-scheme + 主题设置） | 08 暗色主题     |

## 5. 与 F5 snapshot 层边界（T11.2-4）

- 渲染树快照（jest 式 `toMatchSnapshot`）继续归 `apps/crish-desktop/tests/snapshots/`；
- 本目录只做**像素级**截图比对，两套件不重叠。
