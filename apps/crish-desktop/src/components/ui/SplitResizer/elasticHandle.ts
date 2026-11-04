/**
 * apps/crish-desktop/src/components/ui/SplitResizer/elasticHandle.ts
 *
 * 弹性拖柄呈现引擎（纯数学层，无 React / 无 DOM 读写除 paint 目标外）。
 *
 * 来源规格：`~/workspace/crish-audit/弹性拖柄演示解析.md`（macOS 风格分栏拖柄复刻解析）。
 * 核心机制：
 * 1. 手柄是一条 SVG 二次贝塞尔单路径，全部形态 = 4 参数连续空间
 *    （offsetX 偏移 / bend 弯曲 / strokeWidth 粗细 / halfLen 半长）+ 描边色 + 不透明度；
 * 2. 每个视觉量是一个独立二阶弹簧 {value, target, velocity, k, c}，逐帧半隐式欧拉积分；
 *    位置弹簧（k=340）比手柄偏移/弯曲弹簧（k=320/290）更硬，相位差造就弹性形变观感；
 * 3. 边界为指数橡皮筋（damped = max·(1 − exp(−over/tau))），释放后把 target 钳回合法
 *    区间，位置弹簧自行回弹；
 * 4. 形态即状态编码：弧向 = 拖拽方向；绷直 + 变细 + 变淡 = 已触限且仍在硬拉；
 * 5. 颜色也是弹簧量（colorMix 在静止端点 ↔ 激活端点之间插值），从不瞬时跳变。
 *
 * 演示原稿的位置类参数为视口比例制，本文件已全部 px 化（对照表见交付报告）。
 * prefers-reduced-motion 降级：弹簧直达 target（关过冲与回弹），只保留数值正确性。
 */

export type SplitResizerOrientation = 'vertical' | 'horizontal';

export type Rgb = readonly [number, number, number];

/** 弹簧键名（与演示七个视觉量一一对应） */
export type ElasticSpringKey =
  | 'position'
  | 'offsetX'
  | 'bend'
  | 'strokeWidth'
  | 'halfLen'
  | 'opacity'
  | 'colorMix';

export interface SpringConfig {
  stiffness: number;
  damping: number;
}

export interface SpringState {
  value: number;
  target: number;
  velocity: number;
  config: SpringConfig;
}

/** 演示实测弹簧预设（k / c）；阻尼比 ζ 全部 < 1（欠阻尼 = 弹性的来源） */
export const ELASTIC_SPRING_PRESET: Readonly<
  Record<ElasticSpringKey, SpringConfig>
> = {
  position: { stiffness: 340, damping: 32 },
  offsetX: { stiffness: 320, damping: 26 },
  bend: { stiffness: 290, damping: 24 },
  strokeWidth: { stiffness: 300, damping: 28 },
  halfLen: { stiffness: 300, damping: 28 },
  opacity: { stiffness: 260, damping: 28 },
  colorMix: { stiffness: 260, damping: 26 },
};

/** 手柄形态参数（演示实测值，位置类已 px 化） */
export interface ElasticHandleParams {
  /** 悬停胶囊粗细（px） */
  capsuleStrokeWidth: number;
  /** 悬停胶囊半长（px），全长 = 2 × halfLen */
  capsuleHalfLen: number;
  /** 区间内拖拽满拉力时粗细（px） */
  dragStrokeWidth: number;
  /** 区间内拖拽满拉力时半长（px） */
  dragHalfLen: number;
  /** 区间内拖拽满拉力时偏移（px，带方向符号） */
  dragOffsetMax: number;
  /** 区间内拖拽满拉力时弧顶偏移（px，带方向符号） */
  dragBendMax: number;
  /** 区间内拖拽满拉力时颜色混合比（0 = 静止端点，1 = 激活端点） */
  dragColorMix: number;
  /** 触限时半长（px） */
  limitHalfLen: number;
  /** 触限近端粗细（px） */
  limitStrokeWidth: number;
  /** 触限远端粗细回落量（px）：stroke = limitStrokeWidth − limitStrokeFade × far */
  limitStrokeFade: number;
  /** 触限远端颜色回淡量：colorMix = 1 − limitColorFade × far */
  limitColorFade: number;
  /** 触限时手柄向拉拽侧贴靠的偏移（px，带方向符号） */
  limitOffset: number;
  /** 拉力拉满所需位移（px）：pull = min(1, |Δ| / pullFullPx + pullBase) */
  pullFullPx: number;
  /** 起步拉力（保证按下即开始形变） */
  pullBase: number;
  /** 拖拽方向判定死区（px） */
  directionDeadZonePx: number;
  /** 触限远近归一化距离（px）：far = min(1, over / farFullPx) */
  farFullPx: number;
  /** 橡皮筋封顶位移（px） */
  overscrollMax: number;
  /** 橡皮筋指数衰减 τ（px） */
  overscrollTau: number;
  /** 释放后指针已远时，胶囊停留再淡出的时长（ms） */
  releaseHoldMs: number;
}

export const ELASTIC_HANDLE_DEFAULTS: Readonly<ElasticHandleParams> = {
  capsuleStrokeWidth: 9.5,
  capsuleHalfLen: 19.5,
  dragStrokeWidth: 2.5,
  dragHalfLen: 30.5,
  dragOffsetMax: 11,
  dragBendMax: 5.6,
  dragColorMix: 0.85,
  limitHalfLen: 33.5,
  limitStrokeWidth: 1.8,
  limitStrokeFade: 0.65,
  limitColorFade: 0.65,
  limitOffset: 5.5,
  pullFullPx: 24,
  pullBase: 0.35,
  directionDeadZonePx: 3,
  farFullPx: 160,
  overscrollMax: 24,
  overscrollTau: 56,
  releaseHoldMs: 650,
};

const SETTLE_EPSILON = 0.001;

export function createSpring(value: number, config: SpringConfig): SpringState {
  return { value, target: value, velocity: 0, config };
}

export function springIsSettled(state: SpringState): boolean {
  return (
    Math.abs(state.value - state.target) < SETTLE_EPSILON &&
    Math.abs(state.velocity) < SETTLE_EPSILON
  );
}

/**
 * 推进一个弹簧 dt 秒（半隐式欧拉，内部拆 2 子步保证高刚度稳定）。
 * reducedMotion 时直达 target。返回是否已静止吸附。
 */
export function stepSpring(
  state: SpringState,
  dtSeconds: number,
  reducedMotion: boolean
): boolean {
  if (reducedMotion) {
    state.value = state.target;
    state.velocity = 0;
    return true;
  }
  const subSteps = 2;
  const h = Math.min(Math.max(dtSeconds, 0), 0.032) / subSteps;
  if (h <= 0) return springIsSettled(state);
  const { stiffness: k, damping: c } = state.config;
  for (let i = 0; i < subSteps; i += 1) {
    const force = -k * (state.value - state.target);
    const dampingForce = -c * state.velocity;
    state.velocity += (force + dampingForce) * h;
    state.value += state.velocity * h;
  }
  if (springIsSettled(state)) {
    state.value = state.target;
    state.velocity = 0;
    return true;
  }
  return false;
}

/** 指数橡皮筋：越界 over(px) → 衰减后的呈现越界量，渐近封顶 max */
export function rubberBand(over: number, max: number, tau: number): number {
  if (!Number.isFinite(over) || over <= 0) return 0;
  const safeTau = Number.isFinite(tau) && tau > 0 ? tau : 56;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  return safeMax * (1 - Math.exp(-over / safeTau));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 两个 RGB 端点按 mix（0–1）插值，输出 CSS rgb() 字符串 */
export function mixRgbColor(rest: Rgb, active: Rgb, mix: number): string {
  const t = Math.min(1, Math.max(0, mix));
  const r = Math.round(lerp(rest[0], active[0], t));
  const g = Math.round(lerp(rest[1], active[1], t));
  const b = Math.round(lerp(rest[2], active[2], t));
  return `rgb(${r}, ${g}, ${b})`;
}

export interface MorphTargets {
  offsetX: number;
  bend: number;
  strokeWidth: number;
  halfLen: number;
  colorMix: number;
}

/** 胶囊形态（悬停 / 释放收尾的目标形态） */
export function capsuleMorphTargets(params: ElasticHandleParams): MorphTargets {
  return {
    offsetX: 0,
    bend: 0,
    strokeWidth: params.capsuleStrokeWidth,
    halfLen: params.capsuleHalfLen,
    colorMix: 0,
  };
}

export interface DragMorphResult {
  morph: MorphTargets;
  /** 位置弹簧目标：钳制值 ± 橡皮筋衰减后的越界量（尺寸 px 域） */
  displayTarget: number;
  /** 越界量（px，未越界为 0） */
  over: number;
  /** 拖拽方向（相对拖拽起点的位移符号；死区内为 0） */
  dir: -1 | 0 | 1;
}

/**
 * 拖拽中的形态目标计算（纯函数）。
 * - rawValue：未钳制的原始目标尺寸（px）；startValue：拖拽起始尺寸（px）。
 * - 区间内：弧向 = 拖向，拉力随相对起点位移增长；
 * - 触限：bend 归 0（绷直）、向拉拽侧贴靠、随拉远更细更淡，位置走橡皮筋。
 * - collapsed（实时折叠区）：位置目标直接归 0——面板在拖拽流中由位置
 *   弹簧动画收起（不瞬断）；形态沿用下限触限形态（绷直、向收起侧贴靠、
 *   随跌破深度更细更淡），远近以跌破 min 的深度归一化。
 */
export function dragMorphTargets(
  rawValue: number,
  startValue: number,
  min: number,
  max: number,
  params: ElasticHandleParams,
  collapsed = false,
  motionDelta?: number
): DragMorphResult {
  const raw = Number.isFinite(rawValue) ? rawValue : startValue;
  if (collapsed) {
    const over = Math.max(0, min - raw);
    const far = Math.min(1, over / params.farFullPx);
    return {
      morph: {
        offsetX: -params.limitOffset,
        bend: 0,
        strokeWidth: Math.max(
          1,
          params.limitStrokeWidth - params.limitStrokeFade * far
        ),
        halfLen: params.limitHalfLen,
        colorMix: 1 - params.limitColorFade * far,
      },
      displayTarget: 0,
      over,
      dir: -1,
    };
  }
  let over = 0;
  let bound = raw;
  if (raw < min) {
    over = min - raw;
    bound = min;
  } else if (raw > max) {
    over = raw - max;
    bound = max;
  }

  if (over > 0) {
    const side: -1 | 1 = raw < min ? -1 : 1;
    const far = Math.min(1, over / params.farFullPx);
    return {
      morph: {
        offsetX: side * params.limitOffset,
        bend: 0,
        strokeWidth: Math.max(
          1,
          params.limitStrokeWidth - params.limitStrokeFade * far
        ),
        halfLen: params.limitHalfLen,
        colorMix: 1 - params.limitColorFade * far,
      },
      displayTarget:
        bound +
        side * rubberBand(over, params.overscrollMax, params.overscrollTau),
      over,
      dir: side,
    };
  }

  // 弧向算法依据当前鼠标运动增量（而非记忆静态原点）：鼠标往哪边移，圆弧就朝哪边弯
  const delta = motionDelta !== undefined ? motionDelta : raw - startValue;
  const dir: -1 | 0 | 1 =
    Math.abs(delta) <= params.directionDeadZonePx ? 0 : delta > 0 ? 1 : -1;
  const pull = Math.min(
    1,
    Math.abs(delta) / params.pullFullPx + (dir !== 0 ? params.pullBase : 0)
  );
  return {
    morph: {
      offsetX: dir * params.dragOffsetMax * pull,
      bend: dir * params.dragBendMax * pull,
      strokeWidth: lerp(
        params.capsuleStrokeWidth,
        params.dragStrokeWidth,
        pull
      ),
      halfLen: lerp(params.capsuleHalfLen, params.dragHalfLen, pull),
      colorMix: params.dragColorMix * pull,
    },
    displayTarget: raw,
    over: 0,
    dir,
  };
}

export type ElasticHandleMode = 'idle' | 'hover' | 'drag' | 'settle';

export interface ElasticHandleEngineOptions {
  params?: Partial<ElasticHandleParams>;
  springs?: Partial<Record<ElasticSpringKey, Partial<SpringConfig>>>;
  reducedMotion?: boolean;
  /** 描边色端点：静止（colorMix=0）与激活（colorMix=1） */
  colors?: { rest: Rgb; active: Rgb };
  /** 初始尺寸（px），位置弹簧起点 */
  initialValue?: number;
  /** 轴向符号（1 = 正向位移尺寸增加；-1 = 正向位移尺寸减小，如右侧面板） */
  axisSign?: 1 | -1;
}

/** 浅色主题 --border-color 的解析回退值（tokens-radius.css） */
export const FALLBACK_REST_RGB: Rgb = [236, 236, 236];

/**
 * 由静止端点色推导激活端点：向对比极（浅色主题向黑、深色主题向白）走 30% 台阶。
 * 依据解析存档 §四.4 的相对台阶口径（演示 38% 灰阶跨度在桌面收敛为 25–30%）。
 */
export function deriveActiveRgb(rest: Rgb, step = 0.3): Rgb {
  const luminance =
    (0.2126 * rest[0] + 0.7152 * rest[1] + 0.0722 * rest[2]) / 255;
  const pole = luminance > 0.5 ? 0 : 255;
  const mix = (channel: number) =>
    Math.round(channel + (pole - channel) * step);
  return [mix(rest[0]), mix(rest[1]), mix(rest[2])];
}

/**
 * 弹性手柄引擎：持有 7 个弹簧与状态机，由组件的 rAF 循环驱动 step()，
 * 每帧读取 pathD / strokeColor / opacity / displayValue 直写 DOM。
 * 本类不持有任何 DOM 引用（paint 目标由组件负责），可独立单测。
 */
export class ElasticHandleEngine {
  readonly params: ElasticHandleParams;

  private readonly springs: Record<ElasticSpringKey, SpringState>;

  private mode: ElasticHandleMode = 'idle';

  private hovered = false;

  private focused = false;

  private dragStartValue = 0;

  private dragMin = 0;

  private dragMax = 0;

  /** settle 模式下允许开始淡出的内部时钟（ms，引擎累计） */
  private settleDeadlineMs: number | null = null;

  private clockMs = 0;

  private reducedMotion: boolean;

  private colors: { rest: Rgb; active: Rgb };

  private axisSign: 1 | -1;

  private lastDragValue = 0;

  private dragMotionDelta = 0;

  constructor(options: ElasticHandleEngineOptions = {}) {
    this.params = { ...ELASTIC_HANDLE_DEFAULTS, ...(options.params ?? {}) };
    const preset = ELASTIC_SPRING_PRESET;
    const mk = (key: ElasticSpringKey, value: number): SpringState =>
      createSpring(value, {
        ...preset[key],
        ...(options.springs?.[key] ?? {}),
      });
    const initial = options.initialValue ?? 0;
    this.springs = {
      position: mk('position', initial),
      offsetX: mk('offsetX', 0),
      bend: mk('bend', 0),
      strokeWidth: mk('strokeWidth', this.params.capsuleStrokeWidth),
      halfLen: mk('halfLen', this.params.capsuleHalfLen),
      opacity: mk('opacity', 0),
      colorMix: mk('colorMix', 0),
    };
    this.reducedMotion = options.reducedMotion ?? false;
    const rest = options.colors?.rest ?? FALLBACK_REST_RGB;
    this.colors = {
      rest,
      active: options.colors?.active ?? deriveActiveRgb(rest),
    };
    this.axisSign = options.axisSign ?? 1;
  }

  getMode(): ElasticHandleMode {
    return this.mode;
  }

  setAxisSign(sign: 1 | -1): void {
    this.axisSign = sign;
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  setColors(rest: Rgb, active?: Rgb): void {
    this.colors = { rest, active: active ?? deriveActiveRgb(rest) };
  }

  /** 当前呈现尺寸（位置弹簧值，px）——组件据此写 live CSS 变量 */
  get displayValue(): number {
    return this.springs.position.value;
  }

  get opacityValue(): number {
    return Math.min(1, Math.max(0, this.springs.opacity.value));
  }

  get strokeWidthValue(): number {
    return Math.max(1, this.springs.strokeWidth.value);
  }

  strokeColor(): string {
    return mixRgbColor(
      this.colors.rest,
      this.colors.active,
      this.springs.colorMix.value
    );
  }

  /**
   * 生成 SVG path 的 d 属性。
   * 抽象坐标 (across, along)：across 为跨线偏移（offsetX），along 为沿线方向。
   * vertical（竖直分界）：x = across，y = along；horizontal 交换。
   */
  pathD(orientation: SplitResizerOrientation): string {
    const across = this.springs.offsetX.value;
    const bend = this.springs.bend.value;
    const halfLen = this.springs.halfLen.value;
    const fmt = (n: number) => Math.round(n * 100) / 100;
    if (orientation === 'vertical') {
      return `M ${fmt(across)} ${fmt(-halfLen)} Q ${fmt(across + bend * 2)} 0 ${fmt(across)} ${fmt(halfLen)}`;
    }
    return `M ${fmt(-halfLen)} ${fmt(across)} Q 0 ${fmt(across + bend * 2)} ${fmt(halfLen)} ${fmt(across)}`;
  }

  /** 幂等：组件可在每次指针移动时以当前接近判定重复调用 */
  setHover(on: boolean): void {
    this.hovered = on;
    if (this.mode === 'drag') return;
    if (on) {
      if (this.mode === 'idle' || this.mode === 'settle') {
        this.mode = 'hover';
        this.settleDeadlineMs = null;
      }
    } else if (!this.focused) {
      // hover 结束、或 settle 停留态（无截止时刻）下指针离开近区 → 淡出
      if (this.mode === 'hover') this.mode = 'idle';
      else if (this.mode === 'settle' && this.settleDeadlineMs === null) {
        this.mode = 'idle';
      }
    }
    this.retarget();
  }

  setFocused(on: boolean): void {
    this.focused = on;
    if (this.mode === 'drag') return;
    if (on) {
      if (this.mode === 'idle' || this.mode === 'settle') {
        this.mode = 'hover';
        this.settleDeadlineMs = null;
      }
    } else if (!this.hovered) {
      if (this.mode === 'hover') this.mode = 'idle';
      else if (this.mode === 'settle' && this.settleDeadlineMs === null) {
        this.mode = 'idle';
      }
    }
    this.retarget();
  }

  beginDrag(startValue: number, min: number, max: number): void {
    this.mode = 'drag';
    this.settleDeadlineMs = null;
    this.dragStartValue = startValue;
    this.lastDragValue = startValue;
    this.dragMotionDelta = 0;
    this.dragMin = min;
    this.dragMax = max;
    this.springs.position.target = startValue;
    this.springs.position.value = startValue;
    this.springs.position.velocity = 0;
    this.retarget();
  }

  updateDrag(rawValue: number, collapsed = false, motionDelta?: number): void {
    if (this.mode !== 'drag') return;
    if (motionDelta !== undefined) {
      this.dragMotionDelta = motionDelta;
      this.lastDragValue = rawValue;
    } else {
      const step = (rawValue - this.lastDragValue) * this.axisSign;
      this.lastDragValue = rawValue;
      if (Math.abs(step) >= this.params.directionDeadZonePx) {
        this.dragMotionDelta =
          step > 0 ? this.params.pullFullPx : -this.params.pullFullPx;
      }
    }
    const result = dragMorphTargets(
      rawValue,
      this.dragStartValue,
      this.dragMin,
      this.dragMax,
      this.params,
      collapsed,
      this.dragMotionDelta
    );
    this.applyMorph(result.morph);
    this.springs.position.target = result.displayTarget;
    // 尺寸去弹簧阻尼：拖拽尺寸即时 1:1 跟手，消除延迟与振荡过冲；形态动效由其余弹簧独立呈现
    this.springs.position.value = result.displayTarget;
    this.springs.position.velocity = 0;
    this.springs.opacity.target = 1;
  }

  /**
   * 结束拖拽：手柄先回膨胀为胶囊（settling 表演），位置目标交由
   * setExternalValue 写入提交值。
   * - 指针仍在悬停区 / 元素聚焦：转 hover 停留为悬停胶囊；
   * - pointerNear（指针在近区但未入悬停区）：停留，待 setHover(false) 到达后淡出；
   * - 指针已远：releaseHoldMs 后淡出（演示同款收尾）。
   */
  endDrag(pointerNear: boolean): void {
    if (this.mode !== 'drag') return;
    if (this.hovered || this.focused) {
      this.mode = 'hover';
      this.settleDeadlineMs = null;
    } else {
      this.mode = 'settle';
      this.settleDeadlineMs = pointerNear
        ? null
        : this.clockMs + this.params.releaseHoldMs;
    }
    this.retarget();
  }

  /** 取消拖拽（Esc 等）：与 endDrag 相同的收尾形态，位置由调用方恢复 */
  cancelDrag(): void {
    if (this.mode !== 'drag') return;
    this.mode = this.hovered || this.focused ? 'hover' : 'settle';
    this.settleDeadlineMs =
      this.mode === 'settle' ? this.clockMs + this.params.releaseHoldMs : null;
    this.retarget();
  }

  /** 非拖拽期的位置目标（受控值变化 / 键盘步进 / 双击复位） */
  setExternalValue(value: number): void {
    if (this.mode === 'drag') return;
    if (Number.isFinite(value)) {
      this.springs.position.target = value;
      this.springs.position.value = value;
      this.springs.position.velocity = 0;
    }
  }

  /** 推进一帧（dtMs 将钳制到 [0, 32]） */
  step(dtMs: number): void {
    const dt = Math.min(Math.max(dtMs, 0), 32) / 1000;
    this.clockMs += dt * 1000;
    if (
      this.mode === 'settle' &&
      this.settleDeadlineMs !== null &&
      this.clockMs >= this.settleDeadlineMs
    ) {
      this.settleDeadlineMs = null;
      this.mode = 'idle';
      this.retarget();
    }
    (Object.keys(this.springs) as ElasticSpringKey[]).forEach((key) => {
      if (key === 'position') {
        // 尺寸位置不走阻尼振子，直接吸附 target，实现零迟滞即时响应
        this.springs.position.value = this.springs.position.target;
        this.springs.position.velocity = 0;
        return;
      }
      stepSpring(this.springs[key], dt, this.reducedMotion);
    });
  }

  /** 全部弹簧静止且无待处理的 settle 截止时刻时为 true（rAF 可停） */
  isAtRest(): boolean {
    if (this.settleDeadlineMs !== null) return false;
    return (Object.keys(this.springs) as ElasticSpringKey[]).every((key) =>
      springIsSettled(this.springs[key])
    );
  }

  private applyMorph(morph: MorphTargets): void {
    this.springs.offsetX.target = morph.offsetX;
    this.springs.bend.target = morph.bend;
    this.springs.strokeWidth.target = morph.strokeWidth;
    this.springs.halfLen.target = morph.halfLen;
    this.springs.colorMix.target = morph.colorMix;
  }

  private retarget(): void {
    switch (this.mode) {
      case 'drag':
        this.springs.opacity.target = 1;
        break;
      case 'hover':
        this.applyMorph(capsuleMorphTargets(this.params));
        this.springs.opacity.target = 1;
        break;
      case 'settle':
        this.applyMorph(capsuleMorphTargets(this.params));
        this.springs.opacity.target = 1;
        break;
      case 'idle':
      default:
        this.applyMorph(capsuleMorphTargets(this.params));
        this.springs.opacity.target = 0;
        break;
    }
  }
}
