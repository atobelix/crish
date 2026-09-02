# 06 · 多行 Select 文字重叠、全局按钮与快捷键发灰及受管浏览器全景排查报告

> **排查对象**：
> 1. 多行权限下拉框（`PermissionModeMenu` / `Menu` / `Select`）
> 2. 全仓次级按钮（`Button variant="secondary"`）与快捷键徽标（`Kbd` / `.shortcutKeyBtn`）
> 3. 设置诊断页（`StatusDiagnosticsPanel`）、规则页（`SettingsRulesTab`）、定时任务（`ScheduledTasksPanel`）、扩展页
> 4. 受管浏览器与数据导入（`SettingsBrowserTab` / `BrowserImportSection`）

---

## 一、多行 Select 选项文字重叠破裂与浮层过窄排查（对应用户截图 1）

### 1. 现象与复现路径
- 在输入框权限切换（如“完全访问 ⌃”）或包含多行副文本的下拉菜单中：
  - 选项包含两行文本（标题如“需确认”，副说明如“改文件、推送前先问”）；
  - 下拉列表渲染时，上下两行文字相互穿透、纵向碰撞重叠，严重影响阅读；
  - 浮层宽度过窄导致中文被强行挤压拆行，且出现粗糙原生灰滚动条。

### 2. 深层根因剖析
1. **基座容器固定行高死锁**：
   - 在 `Menu.module.css:L65-L66` 中，通用 `.menuItem` 硬编码了：
     ```css
     height: 28px;
     min-height: 28px;
     ```
   - 当 `PermissionModeMenu.tsx` 渲染自定义子组件（`<div className={styles.textCol}>` 包含标题和副文本，自然高度需 40px~44px）时，外层 `<button>` 高度被死死锁在 28px，内部 `textCol` 溢出（overflow）并强行刺穿到下一个 sibling item，造成严重的上下行重叠！
2. **浮层宽度限制与硬折行**：
   - `PermissionModeMenu.module.css:L125-L126` 设置了 `min-width: 230px; max-width: 280px;`；在减去 14px 图标、左右 padding、Checkmark 之后，剩余内容宽度仅约 140px，不足以排下 18 个汉字，被迫拆为两行；
3. **滚动条未美化与选中底色脏灰**：
   - `scrollbar-color` 依赖旧式变量，且选中项 `.isSelected` 简单使用了 `var(--tint-hover)`，未能呈现高质感翡翠绿对勾与独立层次。

### 3. 彻底根治方案
1. **解锁自适应高度与 Flex 弹性排版**：
   - 将 `.menuItem` / `.permMenuItem` 改为 `min-height: 32px; height: auto; padding: 8px 10px;`；
   - 内部 `.textCol` 设置 `display: flex; flex-direction: column; gap: 2px; line-height: 1.35;`，彻底根除文字重叠；
2. **弹性扩展宽度**：
   - 将多行浮层最小宽度放宽至 `min-width: 260px; max-width: 340px;`，单行容纳完整语义描述；
3. **对标 Appica 选中与 Hover 墨阶**：
   - 选中态：`background: var(--tint-active); font-weight: 500;` + 品牌绿对勾（`<Check size={14} color="var(--brand)" />`）；
   - Hover 态：`background: var(--tint-hover);`。

---

## 二、全局按钮与快捷键发灰/死灰色阶排查（对应用户截图 2）

### 1. 现象与复现路径
- 用户明确指出：“布局和灰度还是有问题。 快捷键的灰度也是有问题，明显太灰了。 扩展界面里的按钮也是一样。 定时任务和规则也是一样。”
- 诊断页的 `[🔍 重建索引]`、`[debug]`、`[无错误记录]`，以及全仓所有次级按钮和快捷键录制按钮，呈现出发暗、死灰、无对比度的“禁用态（Disabled）”视觉效果。

### 2. 深层根因剖析
1. **`Button variant="secondary"` 的底层 Token 破损**：
   - 审查 `Button.module.css:L135-L141`：
     ```css
     .buttonSecondary,
     .button[data-variant='secondary'] {
       --btn-bg: var(--control-soft-bg); /* 指向 var(--tint-hover)，即半透明灰度！ */
       --btn-fg: var(--text-primary);
       --btn-border: var(--border-subtle);
     }
     ```
   - 在浅色模式下，`--control-soft-bg` 是一层 `hsl(35 20% 92% / 0.6)` 的半透明灰色；当按钮放置在 100% 纯白卡底（`--bg-card`）上时，**它被渲染成了一块发暗死灰的色块**，没有任何卡片实体感与悬浮投影，使得用户直觉误判为“不可点击的禁用按钮”！
2. **快捷键徽标与录制按钮继承了死灰色块**：
   - `SettingsShortcutsTab.tsx:L370` 的快捷键按钮使用了 `variant="secondary"`，导致所有快捷键（`Ctrl + Enter`、`Alt + ...`）全变成了灰沉沉的暗斑；
3. **`monoBadge` 与诊断卡片灰度混淆**：
   - `[debug]` 徽标使用了 `--control-soft-bg`，与边框混为一体；`[无错误记录]` 缺乏清爽的卡片层级。

### 3. 彻底根治方案
1. **全面重塑 `Button variant="secondary"` 实体白卡质感（对标 Appica UI）**：
   - 浅色模式：
     ```css
     --btn-bg: var(--bg-card, hsl(0 0% 100%));
     --btn-fg: var(--text-primary);
     --btn-border: var(--border-color, hsl(35 10% 86%));
     --btn-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
     ```
   - 深色模式：
     ```css
     --btn-bg: var(--bg-elevated, hsl(35 12% 16%));
     --btn-fg: var(--text-primary);
     --btn-border: var(--border-subtle);
     --btn-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
     ```
   - **效果**：全仓所有次级按钮（重建索引、添加任务、新建规则、导入文件等）瞬间焕发纯白通透的实体卡片质感，带有精致发丝边框与低空微阴影，彻底消灭死灰感！
2. **快捷键按键（Kbd / ShortcutKeyBtn）质感升级**：
   - 纯白卡底 `hsl(0 0% 100%)` + 精致发丝边框 + 等宽数字字体 `font-variant-numeric: tabular-nums;` + 柔和 Hover 微光；
   - 录制态（Recording）：柔和 1.5px 软灰焦点环（`color-mix` 6%~10% 墨阶）。
3. **扩展、定时任务与规则界面全量脱灰**：
   - 统一收敛至重塑后的 `variant="secondary"` 与 `variant="ghost"`，消灭杂乱硬编码。

---

## 三、受管浏览器界面的画风割裂与现代化改造排查（对应用户截图 8）

### 1. 现象与复现路径
- 用户指出：“这个界面和其他的界面不是一个画风啊，这个怎么不改？”（`SettingsBrowserTab.tsx` / `BrowserImportSection.tsx`）。
- 存在问题：
  - 高饱和度刺眼绿块按钮（`[↑ 导入书签]`、`[↑ 导入历史]`、`[↑ 导入登录态]`）；
  - 生硬虚线框（`dashed border`）、粗糙的嵌入灰方块；
  - 底部 `[书签列表] [历史列表]` 采用原生粗糙切换，未接入现代 `SegmentedControl`。

### 2. 改造方案
1. **容器卡片化与 SettingsRow 体系归一**：
   - 将各导入模块重构为标准 `SettingsSection` + `SettingsCard` + `SettingsRow`；
2. **按钮与输入框标准化**：
   - 绿色刺眼按钮替换为标准 `Button variant="primary"`（使用优雅品牌绿 `var(--brand)` + 7px 契约圆角）或 `Button variant="secondary"`；
   - 文件选择与路径输入框统一接入 `ui/Input`；
3. **拖拽区域质感重塑**：
   - 虚线框改为柔和发丝虚线 `1px dashed var(--border-color)` + 2.4% 暖灰底板 + Hover 品牌微光；
4. **底部列表切换升级**：
   - `[书签列表] [历史列表]` 全面接入现代 3.5% 暖灰底板 + 纯白滑块 `SegmentedControl`。

---

## 四、排查结论与实施收口计划

以上所有缺陷的深层根因与数学/样式模型已 100% 查清，且已编写详尽的修复规格。待用户确认后，将统一作为“改进实施总案”的一部分全量落地！