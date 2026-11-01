// 样式 token 守卫（交接 §8「没有裸 hex」+ §7 第 10 步）：
// app/ 与 src/presentation/ 下的非测试源码禁止裸 hex 颜色、数字圆角、数字字号 / 行高，
// 颜色、圆角与字阶一律走 theme（useTheme）。白名单仅收冻结或待清理文件，清理后须同步移除。
//
// 与原型同值断言（M1 防走样核心，2026-11-01)：本文件下半部把参考原型的浅色关键值
// 做成 fixture 常量表，断言 theme.ts 浅色导出逐项相等。一期移植曾因「只禁裸值、
// 不对原型值」而验收全绿但视觉走样——此节即针对性封堵：今后改 token 必须
// 先改原型（或经统筹裁决），再同步改此表与 theme.ts，三者不一致即红。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import {
  darkTheme,
  lightTheme,
  neutralTheme,
  THEME_MODES,
  THEME_MODE_LABELS,
} from '../adapters/platform/theme';

const ROOT = join(__dirname, '..', '..');
const SCAN_DIRS = ['app', join('src', 'presentation')];

/** 暂缓治理的文件（相对 crish-mobile 根，正斜杠） */
const ALLOWLIST: Record<string, string> = {
  // 文件相关页面与组件在本次改版中冻结（交接 §7 第 9 步）
  'src/presentation/components/files/FilePreview.tsx': '文件模块冻结',
};

const RULES: { name: string; pattern: RegExp }[] = [
  { name: '裸 hex 颜色', pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: '数字圆角', pattern: /[A-Za-z]*[rR]adius:\s*-?\d/ },
  { name: '数字字号 / 行高', pattern: /\b(fontSize|lineHeight):\s*\d/ },
];

function collect(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return collect(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

/** 去掉注释行，避免把文档里的编号（如 #123）误判为颜色 */
function codeLines(source: string): { line: number; text: string }[] {
  return source
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text));
}

describe('样式 token 守卫', () => {
  const files = SCAN_DIRS.flatMap((dir) => collect(join(ROOT, dir))).map(
    (full) => ({
      full,
      rel: relative(ROOT, full).split(sep).join('/'),
    })
  );

  it('扫描范围非空', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(RULES)('不允许$name', ({ pattern }) => {
    const hits = files
      .filter(({ rel }) => !(rel in ALLOWLIST))
      .flatMap(({ full, rel }) =>
        codeLines(readFileSync(full, 'utf8'))
          .filter(({ text }) => pattern.test(text))
          .map(({ line, text }) => `${rel}:${line}: ${text.trim()}`)
      );
    expect(hits).toEqual([]);
  });

  it('白名单里的文件都还存在（清理后须同步移除）', () => {
    const existing = new Set(files.map(({ rel }) => rel));
    const stale = Object.keys(ALLOWLIST).filter((rel) => !existing.has(rel));
    expect(stale).toEqual([]);
  });
});

// ── 原型同值 fixture ─────────────────────────────────────────────────────────
// 真源：C:\Software\conex\reference\crish-mobile-drawer\
//   css/variables.css（色板/遮罩）+ css/*.css 组件稿（圆角/字阶/阴影/把手）
//   + toast.css / variables 的半透明口径（J7 悬浮档与桌面 Mica/Acrylic 先例对齐）。
// 纪律：改值先改原型（或经统筹裁决并在本表注明裁决号），再同步 theme.ts。
// PROTOTYPE_* = 原型直给值；RETAINED_* = 原型无此项、App 保留/推导值，一并钉住防漂移。
const PROTOTYPE_LIGHT_COLORS: Record<string, string> = {
  canvas: '#f9f9f9',
  canvasGrouped: '#f9f9f9',
  canvasDrawer: '#f5f5f5',
  surface: '#ffffff',
  surfaceGrouped: '#ffffff',
  surfaceRaised: '#ffffff',
  fillSubtle: '#f9f9f9',
  fillPressed: 'rgba(0,0,0,0.035)',
  fillSelected: 'rgba(0,0,0,0.03)',
  bubbleUser: '#171717',
  bubbleUserText: '#ffffff',
  textPrimary: '#171717',
  textSecondary: '#555555',
  textTertiary: '#777777',
  textDisabled: '#aaaaaa',
  hairline: 'rgba(0,0,0,0.045)',
  borderStrong: '#e5e5e5',
  actionPrimary: '#10b981',
  brand: '#10b981',
  success: '#10b981',
  // 离线点：原型 .device-online-pip.offline 直给（M2 核出、M8 补 token 钉版）
  dotOffline: '#9ca3af',
  danger: '#ef4444',
  warning: '#f59e0b',
  scrim: 'rgba(0,0,0,0.28)',
  scrimStrong: 'rgba(0,0,0,0.35)',
  field: '#ffffff',
  fieldFocus: '#ffffff',
  // J7 悬浮通透档（依据：原型 scrim+blur 口径、桌面壳层 Mica 0.80/Acrylic 0.85、本端 glass 0.72)
  surfaceTranslucent: 'rgba(255,255,255,0.78)',
  surfaceTranslucentStrong: 'rgba(255,255,255,0.88)',
};

const RETAINED_LIGHT_COLORS: Record<string, string> = {
  actionPrimaryText: '#ffffff',
  // 推导：按下绿取 brandStrong 深绿同族一档
  actionPrimaryPressed: '#047857',
  actionDisabled: '#ececec',
  brandStrong: '#047857',
  brandSoft: '#e7f6ec',
  successSoft: '#e7f6ec',
  dangerForeground: '#ffffff',
  // 裁决取值：报告 #6 给的 #fef2f2 / #f9eded 两候选中取 #fef2f2
  dangerSoft: '#fef2f2',
  // 图形/文字分工：warning 图形档走原型琥珀，文字档保留深棕保对比度
  warningText: '#9a5200',
  warningSoft: '#fdf3e1',
  // 原型体系外（App 自有，保留并钉住）
  info: '#0b66d6',
  infoSoft: '#e8f1fd',
  onMedia: '#ffffff',
  onMediaDanger: '#fecaca',
  shadow: '#000000',
  glass: 'rgba(249,249,249,0.72)',
  glassSheet: 'rgba(249,249,249,0.86)',
};

// 深色角色钉版（裁决 J1：原型无深色真源，只钉角色修正与推导档，防后续批次误改）
const DARK_ROLE_COLORS: Record<string, string> = {
  canvasDrawer: '#0e0e0e',
  fillSelected: 'rgba(255,255,255,0.05)',
  bubbleUser: '#262626',
  bubbleUserText: '#ececec',
  actionPrimary: '#10b981',
  actionPrimaryText: '#ffffff',
  success: '#10b981',
  dotOffline: '#9ca3af',
  warning: '#e3a33b',
  warningText: '#e3a33b',
  danger: '#f87171',
  scrimStrong: 'rgba(0,0,0,0.6)',
  surfaceTranslucent: 'rgba(23,23,23,0.72)',
  surfaceTranslucentStrong: 'rgba(23,23,23,0.86)',
};

// 纯净中性灰钉版（M7，裁决 J5/J8)：【推导值，来源 = 原型灰阶 + J8 克制原则，
// 经用户验收后转正】。原型主题面板只有「纯净中性灰」选项名、无任何色值——本表
// 不是原型同值 fixture，而是推导纪律的钉版：结构层与浅色同值（原型灰阶直给），
// 功能色（绿/蓝）收敛为墨/灰阶，状态色（红/琥珀）降饱和保留色相。改本表须先
// 经统筹裁决并注明，不得与 theme.ts 单方面漂移。
const DERIVED_NEUTRAL_COLORS: Record<string, string> = {
  canvas: '#f9f9f9',
  canvasGrouped: '#f9f9f9',
  canvasDrawer: '#f5f5f5',
  surface: '#ffffff',
  surfaceGrouped: '#ffffff',
  surfaceRaised: '#ffffff',
  fillSubtle: '#f9f9f9',
  fillPressed: 'rgba(0,0,0,0.035)',
  fillSelected: 'rgba(0,0,0,0.03)',
  bubbleUser: '#171717',
  bubbleUserText: '#ffffff',
  textPrimary: '#171717',
  textSecondary: '#555555',
  textTertiary: '#777777',
  textDisabled: '#aaaaaa',
  hairline: 'rgba(0,0,0,0.045)',
  borderStrong: '#e5e5e5',
  // 功能色收敛：主操作/品牌/完成 由绿改墨，信息蓝改 text-2 中性灰
  actionPrimary: '#171717',
  actionPrimaryText: '#ffffff',
  actionDisabled: '#ececec',
  brand: '#171717',
  brandStrong: '#171717',
  brandSoft: '#f0f0f0',
  success: '#171717',
  successSoft: '#f0f0f0',
  // 离线点：原型值同明度去色相（推导，中性灰档纪律）
  dotOffline: '#a5a5a5',
  info: '#555555',
  infoSoft: '#eeeeee',
  // 状态色降饱和（HSL 饱和：红 84%→62%、琥珀 92%→68%、文字棕 100%→63%)
  danger: '#c62f2f',
  dangerForeground: '#ffffff',
  dangerSoft: '#f7eeee',
  warning: '#bd8324',
  warningText: '#8a6d1f',
  warningSoft: '#f6f1e6',
  onMedia: '#ffffff',
  onMediaDanger: '#e9dede',
  scrim: 'rgba(0,0,0,0.28)',
  scrimStrong: 'rgba(0,0,0,0.35)',
  shadow: '#000000',
  field: '#ffffff',
  fieldFocus: '#ffffff',
  actionPrimaryPressed: '#2a2a2a',
  glass: 'rgba(249,249,249,0.72)',
  glassSheet: 'rgba(249,249,249,0.86)',
  surfaceTranslucent: 'rgba(255,255,255,0.78)',
  surfaceTranslucentStrong: 'rgba(255,255,255,0.88)',
};

// 推导规则 1 的机器断言面：结构层键在中性灰与浅色之间必须同值（同灰阶骨架）
const NEUTRAL_STRUCTURAL_KEYS = [
  'canvas',
  'canvasGrouped',
  'canvasDrawer',
  'surface',
  'surfaceGrouped',
  'surfaceRaised',
  'fillSubtle',
  'fillPressed',
  'fillSelected',
  'bubbleUser',
  'bubbleUserText',
  'textPrimary',
  'textSecondary',
  'textTertiary',
  'textDisabled',
  'hairline',
  'borderStrong',
  'actionPrimaryText',
  'actionDisabled',
  'dangerForeground',
  'onMedia',
  'scrim',
  'scrimStrong',
  'shadow',
  'field',
  'fieldFocus',
  'glass',
  'glassSheet',
  'surfaceTranslucent',
  'surfaceTranslucentStrong',
] as const;

function colorMismatches(
  actual: object,
  fixture: Record<string, string>
): string[] {
  // ThemeColors 是 interface（无索引签名），此处按名查值即可，内部收窄
  const map = actual as Record<string, string>;
  return Object.entries(fixture)
    .filter(([key, value]) => map[key] !== value)
    .map(([key, value]) => `${key}: 期望 ${value}，实际 ${map[key]}`);
}

describe('与原型同值（防走样 fixture)', () => {
  it('浅色颜色全表 = 原型值 + 保留/推导钉版', () => {
    expect(
      colorMismatches(lightTheme.colors, {
        ...PROTOTYPE_LIGHT_COLORS,
        ...RETAINED_LIGHT_COLORS,
      })
    ).toEqual([]);
  });

  it('深色角色色 = J1 钉版', () => {
    expect(colorMismatches(darkTheme.colors, DARK_ROLE_COLORS)).toEqual([]);
  });

  it('几何 token = 原型值', () => {
    const { layout, size, radius } = lightTheme;
    expect(layout.dialogMaxWidth).toBe(320);
    expect(layout.drawerMaxWidth).toBe(320);
    expect(layout.iconStroke).toBe(1.8);
    expect(layout.drawerParallaxOffset).toBe(-60);
    expect(size.sheetHandleWidth).toBe(36);
    expect(size.sheetHandleHeight).toBe(4);
    expect(radius.composer).toBe(26);
    expect(radius.sheet).toBe(28);
    expect(radius.sheetApproval).toBe(24);
    expect(radius.dialog).toBe(36);
    expect(radius.card).toBe(20);
    expect(radius.menu).toBe(18);
    expect(radius.bubble).toBe(18);
  });

  it('字阶 = 14 中心制（原型逐项）', () => {
    const { type } = lightTheme;
    expect(type.body).toMatchObject({ fontSize: 14, lineHeight: 21 });
    expect(type.chat).toMatchObject({ fontSize: 14, lineHeight: 21 });
    expect(type.callout).toMatchObject({ fontSize: 14, lineHeight: 20 });
    expect(type.headline).toMatchObject({ fontSize: 16, fontWeight: '600' });
    expect(type.title2).toMatchObject({ fontSize: 16.5, fontWeight: '600' });
    expect(type.bodyStrong).toMatchObject({ fontSize: 16, fontWeight: '600' });
    expect(type.footnote).toMatchObject({ fontSize: 13, fontWeight: '400' });
    expect(type.caption).toMatchObject({ fontSize: 12.5, fontWeight: '400' });
    expect(type.sectionLabel).toMatchObject({
      fontSize: 12,
      fontWeight: '600',
    });
    expect(type.mono).toMatchObject({ fontSize: 12 });
    expect(type.accountName).toMatchObject({
      fontSize: 16,
      fontWeight: '600',
    });
  });

  it('阴影 α 与方向 = 原型定版（浅色）', () => {
    const { shadow } = lightTheme;
    expect(shadow.xs.shadowOpacity).toBe(0.02);
    expect(shadow.sm.shadowOpacity).toBe(0.03);
    expect(shadow.md.shadowOpacity).toBe(0.06);
    expect(shadow.lg.shadowOpacity).toBe(0.08);
    expect(shadow.card.shadowOpacity).toBe(0.02);
    expect(shadow.card.shadowOffset?.width).toBeLessThan(0);
    expect(shadow.sheetUp.shadowOpacity).toBe(0.08);
    expect(shadow.sheetUp.shadowOffset?.height).toBe(-10);
    // 别名纪律：sheet 别名即主卡档、floating 别名即 sm 档
    expect(shadow.sheet).toBe(shadow.card);
    expect(shadow.floating).toBe(shadow.sm);
  });

  it('动效口径：emphasized 曲线与抽屉/展开时长（原型）', () => {
    const { motion } = lightTheme;
    expect(motion.easing.emphasized).toEqual([0.16, 1, 0.3, 1]);
    expect(motion.duration.drawer).toBe(350);
    expect(motion.duration.expand).toBe(280);
    expect(motion.toast.displayMs).toBe(2500);
  });

  it('头像兜底 = 统一中性灰（原型）', () => {
    for (const tone of lightTheme.avatarTones) {
      expect(tone).toEqual({ bg: '#e4e4e4', fg: '#555555' });
    }
  });

  it('纯净中性灰全表 = 推导钉版（M7/J5，待用户验收转正）', () => {
    expect(
      colorMismatches(neutralTheme.colors, DERIVED_NEUTRAL_COLORS)
    ).toEqual([]);
    // 键集合与浅色同构（全键覆盖，缺一即红）
    expect(Object.keys(neutralTheme.colors).sort()).toEqual(
      Object.keys(lightTheme.colors).sort()
    );
    expect(Object.keys(DERIVED_NEUTRAL_COLORS).sort()).toEqual(
      Object.keys(lightTheme.colors).sort()
    );
  });

  it('中性灰结构层与浅色同值（推导规则 1：同灰阶骨架）', () => {
    const neutral = neutralTheme.colors as unknown as Record<string, string>;
    const light = lightTheme.colors as unknown as Record<string, string>;
    const drift = NEUTRAL_STRUCTURAL_KEYS.filter(
      (key) => neutral[key] !== light[key]
    );
    expect(drift).toEqual([]);
    // 头像兜底与浅色共享同一中性表
    expect(neutralTheme.avatarTones).toEqual(lightTheme.avatarTones);
    expect(neutralTheme.dark).toBe(false);
  });

  it('主题四档接线：THEME_MODES 含 neutral 且标签为「纯净中性灰」', () => {
    expect(THEME_MODES).toEqual(['system', 'light', 'dark', 'neutral']);
    expect(THEME_MODE_LABELS.neutral).toBe('纯净中性灰');
  });
});
