# Crish 桌面应用硬编码 Token 体系审计报告

> 由 8 个 Agent 跨文件深度分析生成
> 覆盖 92 个 CSS 文件、65 个 TSX 文件

---

## 一、各维度 Token 覆盖率总览

| 维度 | Token 覆盖率 | 健康度 | 主要问题 |
|------|------------|--------|---------|
| `font-family` | **100%** | ✅ 优秀 | — |
| `font-size` | **~94%** | ✅ 良好 | 68 处硬编码（13.5px、22px、12.5px、11.5px、10px） |
| **间距/尺寸 (px)** | **~20%** | ❌ 差 | 5000+ 硬编码 px，6px 最严重（367 次） |
| **border-radius** | **~15%** | ❌ 差 | Token 值与实际使用脱节，最常用 8px/6px 无对应 Token |
| **颜色** | **~60%** | ⚠️ 中等 | ~105 处硬编码色值，28 处 `color-mix(#000...)` 阴影 |
| `font-weight` | **~51%** | ⚠️ 中等 | ~193 处裸值（500/600/400） |
| `line-height` | **~22%** | ❌ 差 | ~226 处硬编码，1.3/1.4 最常见 |
| `letter-spacing` | **~4%** | ❌ 非常差 | 55 处硬编码 |
| **z-index** | **0%** | ❌ 缺失 | 全部为裸数值，建议统一为 CSS 变量 |
| **动画/过渡** | **~35%** | ⚠️ 中等 | `--transition-*` 定义完善但 2 个 token 从未使用，多处硬编码 90ms/50ms |
| **断点 (@media)** | **0%** | ❌ 缺失 | `--breakpoint-*` 定义了但无 @media 引用 |

---

## 二、最严重问题 Top 5

### 🔴 P0: 间距 6px 无对应 Token（367 次）

**值**: `6px` 在 gap/padding/margin 中出现 367 次  
**原因**: `tokens.css` 的 `--space-1: 4px` 和 `--space-2: 8px` 之间缺少 6px  
**建议**: 新增 `--space-1_5: 6px`

### 🔴 P0: `color-mix(in srgb, #000 ...)` 阴影散落 28 处

10 个不同文件直接使用 `#000` 做阴影混合，应统一为 `--shadow-color` 变量。

### 🔴 P0: Z-index 全部为裸值（90+ 处）

从 0 到 100001 共约 40 个不同值，无层级体系，存在冲突风险（9999 被 5 个不同元素使用）。

### 🟠 P1: Border-radius Token 值与实际使用脱节

| Token | 定义值 | 实际常用值 |
|-------|--------|-----------|
| `--radius-xs` | 3px | **4px**（60 次） |
| `--radius-sm` | 5px | ✅ 匹配（21 次） |
| `--radius-md` | 7px | **6px**（83 次） |
| `--radius-lg` | 9px | **8px**（108 次） |
| `--radius-xl` | 11px | **10px**（61 次） |
| `--radius-2xl` | 14px | **12px**（35 次） |

**建议**: 重新映射 Token 值以匹配实际使用频次。

### 🟠 P1: 字体大小 13.5px/22px/12.5px/11.5px/10px 无 Token（52 处）

这些值在设置页面中反复出现，应新增 `--font-size-2xl: 22px` 等 Token。

---

## 三、建议新建 Token 清单

### 3.1 CSS 变量（新增至 `tokens.css`）

| 建议 Token | 值 | 理由 |
|-----------|-----|------|
| `--space-1_5` | `6px` | 367 次间距中出现，最重要缺失 |
| `--space-0_5` | `2px` | 152 次间距中出现 |
| `--radius-4` | `4px` | 实际 60 次使用 vs `--radius-xs: 3px` 几乎无用 |
| `--radius-6` | `6px` | 实际 83 次使用 vs `--radius-md: 7px` 几乎无用 |
| `--radius-8` | `8px` | 实际 108 次使用，最常见 |
| `--radius-10` | `10px` | 实际 61 次使用 |
| `--radius-12` | `12px` | 实际 35 次使用 |
| `--shadow-color` | `#000` | 28 处 `color-mix(#000...)`，统一阴影颜色 |
| `--color-active` | `#16a34a` | 9 处模型激活态绿 |
| `--font-size-2xl` | `22px` | 10 处设置页标题 |
| `--font-size-sm-plus` | `13.5px` | 13 处设置次级文本 |
| `--font-size-nano` | `10px` | 9 处极小文本 |

### 3.2 建议新增 CSS 常量文件

| 文件 | 用途 | 包含 |
|------|------|------|
| `src/styles/breakpoints.css` | 统一断点管理 | `--breakpoint-sm/md/lg/xl` 并映射 @media 引用 |
| `src/styles/z-index.css` | 层级管理 | `--z-modal-backdrop: 9000`, `--z-toast: 10000` 等 |

### 3.3 建议新增 JS 常量文件

| 文件 | 用途 | 包含 |
|------|------|------|
| `src/constants/layout.ts` | 布局数值常量 | 侧栏宽、列宽比、菜单尺寸、终端缓冲等 |
| `src/constants/componentDefaults.ts` | 组件默认值 | 图标尺寸（ICON_SIZE_MD=14）、strokeWidth（1.75）等 |
| `src/utils/storageKeys.ts` | localStorage key 统一 | 全部 35 个 key |
| `src/utils/eventNames.ts` | DOM 事件名统一 | 全部 29 个 `crish-*` 事件 |
| `src/utils/panelIds.ts` | 面板 ID 常量 | 全部 11 个面板 ID |

---

## 四、各审计 Agent 产出

| Agent | 聚焦 | 发现文档 |
|-------|------|---------|
| R8-A1 | CSS 变量与颜色体系 | ~105 处硬编码色值，阴影 28 处，高亮 8 色缺失 |
| R8-A2 | 间距/尺寸/圆角 | 5000+ 硬编码 px，6px 最严重，radius 体系脱节 |
| R8-A3 | Z-index 层级 | 全部 90+ 处为硬编码，冲突风险 |
| R8-A4 | 动画/过渡/定时器 | `--transition-slide/hover` 从未使用，多处 90ms/50ms |
| R8-A5 | 字符串常量 | 35 个 localStorage key 散落，29 个事件名散落 |
| R8-A6 | 断点/布局常量 | `--breakpoint-*` 定义了但 0 处 @media 引用 |
| R8-A7 | 组件 Props/默认值 | Icon size 14（148 处）、strokeWidth 1.75（95 处）占主流 |
| R8-A8 | 字体/排版 | font-size 94% token 覆盖，line-height 22%、letter-spacing 4% |
