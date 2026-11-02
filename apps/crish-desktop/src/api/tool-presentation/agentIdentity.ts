/**
 * 子智能体确定性色彩身份环与几何标识纯函数（P5 T-P5-09 · agentIdentity）。
 *
 * 将任意 Agent ID 或名称通过确定性散列映射到 1..8 号等感知亮度 OKLCH 色相
 * （`--agent-hue-{1..8}`）、几何标号（glyph）与语义图标名（iconName）：
 *   - 暗色主题：oklch(0.72 0.14 H)，相对 #141414 对比度 6.90:1 ~ 7.97:1（远超 WCAG AA 4.5:1）
 *   - 亮色主题：oklch(0.50 0.16 H)，相对 #ffffff 对比度 4.91:1 ~ 5.91:1（全部达标 WCAG AA 4.5:1）
 */

export interface AgentHueSpec {
  hueIndex: number;
  hueAngle: number;
  name: string;
  tokenName: string;
  hueVar: string;
  glyph: string;
  iconName: string;
  darkOklch: string;
  lightOklch: string;
  darkHex: string;
  lightHex: string;
}

export interface AgentIdentity {
  /** 色相编号：1..8 */
  hueIndex: number;
  /** CSS 变量引用表达式：'var(--agent-hue-N)' */
  hueVar: string;
  /** CSS 变量名：'--agent-hue-N' */
  tokenName: string;
  /** 稳定几何标号：'◆' | '▲' | '●' | '■' | '◈' | '⬢' | '⬡' | '★' */
  glyph: string;
  /** 语义几何图标名（对齐 IconName 契约） */
  iconName: string;
  /** 兼容近似色值引用 */
  colorHexApprox: string;
  /** 暗色主题 OKLCH 表达式 */
  darkOklch: string;
  /** 亮色主题 OKLCH 表达式 */
  lightOklch: string;
  /** 暗色主题 sRGB Hex 转换值（用于对比度审计与 Canvas 回退） */
  darkHex: string;
  /** 亮色主题 sRGB Hex 转换值（用于对比度审计与 Canvas 回退） */
  lightHex: string;
}

export const AGENT_GLYPHS = ['◆', '▲', '●', '■', '◈', '⬢', '⬡', '★'] as const;

export const AGENT_ICON_NAMES = [
  'bot',
  'cpu',
  'sparkles',
  'orbit',
  'compass',
  'zap',
  'target',
  'shield',
] as const;

export const AGENT_HUE_ANGLES = [25, 65, 115, 160, 205, 250, 295, 340] as const;

const AGENT_HUE_NAMES = [
  'Coral',
  'Amber',
  'Olive Green',
  'Mint',
  'Cyan',
  'Cobalt Blue',
  'Violet',
  'Magenta',
] as const;

function linearToSRgbChannel(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/**
 * 将 OKLCH (L, C, H) 精确转换为 sRGB #rrggbb 字符串（Ottosson 2020 标准矩阵）。
 */
export function oklchToHex(L: number, C: number, H: number): string {
  const rad = (H * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const b = C * Math.sin(rad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const r = Math.round(
    Math.max(0, Math.min(255, linearToSRgbChannel(rLin) * 255))
  );
  const g = Math.round(
    Math.max(0, Math.min(255, linearToSRgbChannel(gLin) * 255))
  );
  const bl = Math.round(
    Math.max(0, Math.min(255, linearToSRgbChannel(bLin) * 255))
  );

  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

/** 8 色子智能体色板权威规格表（1..8） */
export const AGENT_HUE_PALETTE: readonly AgentHueSpec[] = AGENT_HUE_ANGLES.map(
  (angle, idx) => {
    const hueIndex = idx + 1;
    const tokenName = `--agent-hue-${hueIndex}`;
    const hueVar = `var(${tokenName})`;
    const darkOklch = `oklch(0.72 0.14 ${angle})`;
    const lightOklch = `oklch(0.50 0.16 ${angle})`;
    return {
      hueIndex,
      hueAngle: angle,
      name: AGENT_HUE_NAMES[idx]!,
      tokenName,
      hueVar,
      glyph: AGENT_GLYPHS[idx]!,
      iconName: AGENT_ICON_NAMES[idx]!,
      darkOklch,
      lightOklch,
      darkHex: oklchToHex(0.72, 0.14, angle),
      lightHex: oklchToHex(0.5, 0.16, angle),
    };
  }
);

/** 由色环槽位规格构造身份对象（agentIdentity 与会话级分配的唯一构造点） */
function identityFromSpec(spec: AgentHueSpec): AgentIdentity {
  return {
    hueIndex: spec.hueIndex,
    hueVar: spec.hueVar,
    tokenName: spec.tokenName,
    glyph: spec.glyph,
    iconName: spec.iconName,
    colorHexApprox: spec.hueVar,
    darkOklch: spec.darkOklch,
    lightOklch: spec.lightOklch,
    darkHex: spec.darkHex,
    lightHex: spec.lightHex,
  };
}

/**
 * 根据子智能体 ID 或名称计算确定性色彩身份与几何图标。
 * 空串、空白串或异常输入安全退化至默认槽位，绝不抛异常。
 */
export function agentIdentity(idOrName?: string | null): AgentIdentity {
  const str = String(idOrName ?? '').trim() || 'agent';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const hueIndex = (Math.abs(hash) % 8) + 1;
  return identityFromSpec(AGENT_HUE_PALETTE[hueIndex - 1]!);
}

/** resolveAgentIdentity 为 agentIdentity 的同义导出 */
export const resolveAgentIdentity = agentIdentity;

/**
 * 会话级身份分配（R4a 地基；供 R4b 在流内分派卡 / 侧栏 / 团队板 / 顶栏
 * 四面共用同一分配结果）：在 agentIdentity 的纯哈希之上做 sibling
 * 撞色顺延——哈希只有 8 槽，同批并行子 agent 必然可能撞色/撞标号，
 * 若各呈现面各自调 agentIdentity(id)，同会话两个 agent 会同色同标。
 *
 * 规则：
 * - 按传入顺序（= 会话 agents 的既有顺序）逐个占槽；哈希槽已被同批
 *   更早的 agent 占用时，顺延到其后的第一个空槽（环回 1..8，
 *   glyph / iconName 随槽位规格一并取顺延槽的）；
 * - 无冲突时结果与逐个 agentIdentity(id) 完全一致——单 agent 时
 *   恒等于 agentIdentity(id)，不改变既有单 agent 呈现；
 * - 同批 ≥9 个 agent 时槽位耗尽，后到者回退其纯哈希结果（撞色在
 *   8 槽下不可避免，如实保留确定性，不引入随机/时间因素）；
 * - 空白 id 跳过（无法定址）；同一 id 重复出现只占一次。
 * 返回 Map<agentId, AgentIdentity>（key 为 trim 后的 id）。
 */
export function resolveAgentIdentities(
  agents: readonly { id?: string | null }[]
): Map<string, AgentIdentity> {
  const out = new Map<string, AgentIdentity>();
  const taken = new Set<number>();
  for (const a of agents ?? []) {
    const id = String(a?.id ?? '').trim();
    if (!id || out.has(id)) continue;
    let identity = agentIdentity(id);
    if (taken.has(identity.hueIndex)) {
      for (let step = 1; step < 8; step++) {
        const next = ((identity.hueIndex - 1 + step) % 8) + 1;
        if (!taken.has(next)) {
          identity = identityFromSpec(AGENT_HUE_PALETTE[next - 1]!);
          break;
        }
      }
    }
    taken.add(identity.hueIndex);
    out.set(id, identity);
  }
  return out;
}
