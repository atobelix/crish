/**
 * apps/crish-desktop/src/components/markdown/markdownG2Shapes.ts
 *
 * Markdown G² 形状适配器（DOM 层承载形态）。
 *
 * 为什么不是 G2Surface 组件（形态 A）：
 * Markdown 块是 Rust 产出的 HTML 字符串，经 MarkdownSurface 以 innerHTML +
 * 增量补丁注入 DOM——块内表面（代码块/表格/callout/details/数学块/引用块/
 * 任务框/kbd/图）不是 React 元素，组件无法挂载其上；把它们逐一改成 Island
 * （Rust 侧发占位 + Portal 注水）是渲染器架构级改动，超出形状迁移的范围。
 * 本适配器是同一生成层（utils/cornerPath）在 DOM 层的承载：按实测尺寸生成
 * 同路径 clip-path（cornerClipPath），与 G2Surface 的 clip 形态同源；唯一
 * 真值源仍是 cornerPath.ts，不存在第二份轮廓实现。
 *
 * 值仍以 CSS 为唯一真源：半径不在此写死——每面从 computed border-radius
 * 读取（排版层 token 解析后的 px 值），形状只做「圆弧 → 同值超椭圆」转换；
 * CSS 的 border-radius 声明保留为回退弧（摘掉适配器即回到当前外观）。
 *
 * 承载口径（逐面）：
 * - measured：全部面均为实测生成；尺寸变化（流式增长/折叠/窗口缩放/图片
 *   加载）由 ResizeObserverManager（G-03 单例，禁止裸 new ResizeObserver）
 *   驱动重算；0.5px 内尺寸抖动不重算（与 G2Surface 同阈）。
 * - 冻结策略：本族无尺寸动画；折叠（details 开合、代码块折叠）是尺寸阶跃，
 *   RO 回调在落定后重算一次；流式增长随行落定重算（字符串生成，单面
 *   <1ms 量级）；不主动冻结——重算只发生在尺寸落定后。
 * - 边框：1px 边框仍沿旧弧绘制（clip 路径比旧弧饱满约 0.04R，边框全程落
 *   在 clip 区内不被裁切；背景在四角对角线方向比边框外探 ≤0.35px，
 *   亚像素、不可见——R≤8 承载形态的固有偏差）。
 * - 滚动容器（.md-table-wrap / .md-math-block，overflow-x: auto）：clip-path
 *   会裁切横向滚动条的两端角部（R8 区域）；overlay 细条下的实际观感见
 *   施工报告活测项。
 * - 方案（双方案体系）：轮廓族经真源选择点 getCornerScheme() 现读（默认
 *   'g2' 超椭圆 / 'concentric' 同心圆弧）；同步器把方案记入面状态，方案
 *   变化与尺寸变化同级触发重算——切换方案后下一轮 sync 即全根换形，
 *   无需重挂。半径仍只读 computed 值，适配器不选方案、不写死半径。
 * - 行内码 / mark 不纳入：行内元素多行分片 + 单消息高频出现，量测成本与
 *   收益不成比例，R6 下形状差 <0.3px；待裁决 #1 定小半径档待遇。
 * - 伪元素（代码提示气泡 ::after）无 DOM 节点，无法量测，不纳入。
 * - 条带图（ProcessItemRenderer 的 styles.mdImg）与工具结果图
 *   （ChatToolCallBlock .toolResultImg）不在 MarkdownSurface 根内，不由
 *   本适配器覆盖——随各自持有单元跟进（见施工报告）。
 */
import {
  cornerClipPath,
  getCornerScheme,
  type CornerRadii,
  type CornerScheme,
} from '../../utils/cornerPath';
import {
  ResizeObserverManager,
  type ResizeCallback,
} from '../../utils/ResizeObserverManager';

/**
 * 适配面选择器表（MarkdownSurface 根内查询）。
 * 只列选择器：半径值一律读元素 computed border-radius，CSS 为值的唯一真源。
 * 逐面档位（现状值，形状只换不换值）：
 * - .md-code-block / .md-table-wrap：8（control 档）
 * - .md-callout / details / .md-math-block：8（--radius-m）
 * - blockquote, .md-quote：右 6 左 0（分角，逐角开关）
 * - .md-task-checkbox / kbd, .md-kbd / .md-code-lang / 代码操作钮：6（row 档）
 * - img, .md-img：16（R16 档；值由裁决 #7 统一，本批只补形状）
 */
export const MARKDOWN_G2_SHAPE_SELECTORS: readonly string[] = [
  '.md-code-block',
  '.md-table-wrap',
  '.md-callout',
  'details',
  '.md-math-block',
  'blockquote, .md-quote',
  '.md-task-checkbox',
  'kbd, .md-kbd',
  '.md-code-lang',
  '.md-code-copy, .md-code-wrap, .md-code-fold',
  'img, .md-img',
];

/**
 * 未纳入的排版层 border-radius 声明（逐项有理由；契约测试逐项钉住，
 * 见 markdownTypographyG2.contract.test.ts）。
 */
export const MARKDOWN_G2_SHAPE_EXCLUSIONS: readonly {
  selector: string;
  reason: string;
}[] = [
  {
    selector: 'code, .md-inline-code',
    // 行内元素会按行拆片，单条消息里出现很密，量测成本与收益不成比例。六像素档形状差小于零点三像素。小半径档待遇仍待裁决。
    reason: 'inline-fragment-cost',
  },
  {
    selector: 'mark',
    // 行内元素，理由与行内码相同。
    reason: 'inline-fragment-cost',
  },
  {
    selector: '.md-code-actions [data-tooltip]:hover::after',
    // 伪元素没有可量测的文档节点。
    reason: 'pseudo-element',
  },
  {
    selector: '.md-callout-title::before',
    // 胶囊半径按程序口径不进入改造面。
    reason: 'pill-radius',
  },
  {
    selector: '.md-path-link',
    // 有意直角，不进入改造面。
    reason: 'intentional-square',
  },
];

/** 尺寸抖动阈值（与 G2Surface 同阈）：0.5px 内不重算 */
const SIZE_EPSILON_PX = 0.5;

const PX_VALUE = /^(\d+(?:\.\d+)?)px$/;

/**
 * 解析 computed border-radius（浏览器已解析为 px 的简写）为逐角名义值。
 * - 1–4 值简写按 CSS 规则展开（tl / tr,bl / br 顺序）；
 * - 含 '/' 的椭圆写法取横向半径（超椭圆角以横向占位为准）；
 * - 含 '%'、0、全 0 或空 → null（胶囊/直角/无半径，不塑造）。
 */
export function resolveElementRadii(
  el: HTMLElement
): CornerRadii | null {
  if (typeof getComputedStyle !== 'function') return null;
  const raw = getComputedStyle(el).borderRadius ?? '';
  const horizontal = raw.split('/')[0]?.trim() ?? '';
  if (!horizontal) return null;
  const parts = horizontal.split(/\s+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 4) return null;
  const values: number[] = [];
  for (const part of parts) {
    if (part === '0') {
      values.push(0);
      continue;
    }
    const m = PX_VALUE.exec(part);
    if (!m || m[1] === undefined) return null;
    values.push(Number(m[1]));
  }
  const [a, b, c, d] = values as [
    number,
    number | undefined,
    number | undefined,
    number | undefined,
  ];
  const radii: CornerRadii =
    values.length === 1
      ? { tl: a, tr: a, br: a, bl: a }
      : values.length === 2
        ? { tl: a, tr: b as number, br: a, bl: b as number }
        : values.length === 3
          ? { tl: a, tr: b as number, br: c as number, bl: b as number }
          : {
              tl: a,
              tr: b as number,
              br: c as number,
              bl: d as number,
            };
  if (
    radii.tl === 0 &&
    radii.tr === 0 &&
    radii.br === 0 &&
    radii.bl === 0
  ) {
    return null;
  }
  return radii;
}

/**
 * 对单个元素应用一次 G² 形状：实测边框盒尺寸 + computed 半径 → clip-path。
 * 注意：clip-path 路径坐标系是边框盒，必须用 getBoundingClientRect
 * （ResizeObserverEntry.contentRect 是内容盒，小 2px 边框 + padding，
 * 不可直接作路径尺寸——G2Surface 的 SVG 层用内容盒是另一口径，此处不适用）。
 * 尺寸为 0 或无半径时清除此前设置的 clip-path 并返回 ''。
 * 返回应用的 clip-path 值（'' 表示未塑造）。
 */
export function applyG2ShapeToElement(el: HTMLElement): string {
  const rect = el.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const radii = resolveElementRadii(el);
  if (!(w > 0) || !(h > 0) || radii === null) {
    if (el.style.clipPath) el.style.removeProperty('clip-path');
    return '';
  }
  const next = cornerClipPath(w, h, radii, undefined, getCornerScheme());
  el.style.clipPath = next;
  return next;
}

interface ObservedState {
  cb: ResizeCallback;
  w: number;
  h: number;
  path: string;
  /** 上次生成时的轮廓方案（真源选择点现值）；变化即触发重算 */
  scheme: CornerScheme;
}

/**
 * 一根 MarkdownSurface 根的形状同步器（每个 Surface 实例一个）。
 * sync() 幂等：新面挂接 + 尺寸变化重算 + 失联面解绑；dispose() 在
 * Surface 卸载时释放全部监听（虚拟化超视距回收即卸载路径）。
 */
export class MarkdownG2ShapeSync {
  private readonly observed = new Map<Element, ObservedState>();
  private manager: ResizeObserverManager | null = null;
  private disposed = false;

  /** 全根扫描：对规则面逐一刷新；新面挂接 RO，失联面解绑。 */
  sync(root: HTMLElement): void {
    if (this.disposed) return;
    for (const [el, state] of Array.from(this.observed)) {
      if (!el.isConnected) this.unobserve(el, state);
    }
    for (const selector of MARKDOWN_G2_SHAPE_SELECTORS) {
      root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
        this.ensureObserved(el);
        this.refresh(el);
      });
    }
  }

  /** 释放本实例的全部监听；调用后 sync() 不再生效。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [el, state] of Array.from(this.observed)) {
      this.unobserve(el, state);
    }
    this.observed.clear();
  }

  private ensureObserved(el: HTMLElement): void {
    if (this.observed.has(el)) return;
    if (typeof ResizeObserver === 'undefined') return;
    if (this.manager === null) {
      this.manager = ResizeObserverManager.getInstance();
    }
    const manager = this.manager;
    const cb: ResizeCallback = () => {
      // RO 回调在布局落定后触发，此时 getBoundingClientRect 廉价；
      // contentRect 不可用（内容盒 ≠ 边框盒），见 applyG2ShapeToElement。
      this.refresh(el);
    };
    this.observed.set(el, {
      cb,
      w: 0,
      h: 0,
      path: '',
      scheme: getCornerScheme(),
    });
    manager.observe(el, cb);
  }

  private unobserve(el: Element, state: ObservedState): void {
    this.observed.delete(el);
    if (this.manager !== null) {
      this.manager.unobserve(el, state.cb);
    }
  }

  /**
   * 刷新一面：尺寸变化 >0.5px、方案变化或尚未塑造时重算；尺寸/半径/方案
   * 均不变时跳过（流式补丁每轮都调 sync，单面重算只发生在落定后）。
   */
  private refresh(el: HTMLElement): void {
    const state = this.observed.get(el);
    const rect = el.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (state !== undefined) {
      const scheme = getCornerScheme();
      const sizeChanged =
        Math.abs(state.w - w) > SIZE_EPSILON_PX ||
        Math.abs(state.h - h) > SIZE_EPSILON_PX;
      const schemeChanged = state.scheme !== scheme;
      if (!sizeChanged && !schemeChanged && state.path !== '') return;
      if (!(w > 0) || !(h > 0)) {
        if (el.style.clipPath) el.style.removeProperty('clip-path');
        state.w = w;
        state.h = h;
        state.path = '';
        state.scheme = scheme;
        return;
      }
      const radii = resolveElementRadii(el);
      if (radii === null) {
        if (el.style.clipPath) el.style.removeProperty('clip-path');
        state.w = w;
        state.h = h;
        state.path = '';
        state.scheme = scheme;
        return;
      }
      const next = cornerClipPath(w, h, radii, undefined, scheme);
      if (next !== state.path) el.style.clipPath = next;
      state.w = w;
      state.h = h;
      state.path = next;
      state.scheme = scheme;
      return;
    }
    // 未挂接 RO 的环境（如无 ResizeObserver）：只做一次性应用。
    applyG2ShapeToElement(el);
  }
}
