import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

type Theme = 'dark' | 'light';
const ACCENT = '#10b981';

// Theme-based style tokens
const clr = (t: Theme) => ({
  fg: t === 'dark' ? '#f4f4f5' : '#09090b',
  bg: t === 'dark' ? '#09090b' : '#ffffff',
  muted: t === 'dark' ? '#71717a' : '#a1a1aa',
  panel: t === 'dark' ? '#141417' : '#f4f5f7',
  border: t === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
  textPrimary: t === 'dark' ? '#ffffff' : '#000000',
  gridColor: t === 'dark' ? '#222226' : '#e4e4e7',
  accent: ACCENT
});

const SKIN_PRESETS: Record<string, { name: string; isDark: boolean; bg: string; fg: string; accent: string; panel: string; border: string; muted: string }> = {
  'cyber': { name: '赛博星空', isDark: true, bg: '#110f1c', fg: '#f1effa', accent: '#c084fc', panel: '#1a172a', border: '#2d2747', muted: '#7d75a8' },
  'deep-night': { name: '深邃夜空', isDark: true, bg: '#0f172a', fg: '#f1f5f9', accent: '#38bdf8', panel: '#1e293b', border: '#334155', muted: '#64748b' },
  'dark-forest': { name: '森林绿影', isDark: true, bg: '#121c17', fg: '#e2f0e9', accent: '#34d399', panel: '#1a2720', border: '#263a30', muted: '#6f8a7e' },
  'aurora': { name: '北欧极光', isDark: true, bg: '#0a1a1b', fg: '#e2f4f5', accent: '#2dd4bf', panel: '#132627', border: '#1b3a3b', muted: '#5c8182' },
  'burgundy': { name: '暗红丝绒', isDark: true, bg: '#1a0f12', fg: '#faecf0', accent: '#f43f5e', panel: '#25171b', border: '#3e282c', muted: '#9a7c82' },
  'warm-gray': { name: '护眼暖灰', isDark: false, bg: 'hsl(35, 12%, 95%)', fg: '#111111', accent: '#10b981', panel: 'hsl(35, 12%, 91%)', border: 'hsl(35, 10%, 84%)', muted: '#6b655b' },
  'cream': { name: '杏仁奶油', isDark: false, bg: '#fffbf0', fg: '#2a2415', accent: '#f59e0b', panel: '#f5efe0', border: '#e5dfcf', muted: '#8b7f65' },
  'glacier': { name: '冰川薄荷', isDark: false, bg: '#f0f9fa', fg: '#0a2e2b', accent: '#06b6d4', panel: '#e0f2fe', border: '#bae6fd', muted: '#4f7c78' },
};

// ─────────────────────────────────────────────────────────────────────────────
// Parametric Icon Geometry Definition
// ─────────────────────────────────────────────────────────────────────────────
export interface IconSpec {
  id: string;
  nameZh: string;
  desc: string;
  angle: number;       // Rotation of the legs (original 18)
  rectWidth: number;   // Leg thickness (original 16)
  barWidth: number;    // Crossbar width (original 136 - wide)
  barHeight: number;   // Crossbar height (original 18)
  barY: number;        // Crossbar vertical position (original 92)
  dotY: number;        // Accent dot vertical position (original 28)
  hasGap: boolean;     // Add a background gap cutting the crossing area to relieve crowding
  flatBottom: boolean; // Crop bottom rounded feet to align flat on coordinate grid
}

const CANDIDATES: IconSpec[] = [
  {
    id: 'original',
    nameZh: 'A. 原始比例对照',
    desc: '横梁较宽，底部交叉处呈现自然重合。在某些尺寸下会显得略显拥挤。',
    angle: 18,
    rectWidth: 16,
    barWidth: 136,
    barHeight: 18,
    barY: 92,
    dotY: 28,
    hasGap: false,
    flatBottom: false
  },
  {
    id: 'trim-bar',
    nameZh: 'B. 横梁缩窄打薄',
    desc: '仅调整横梁。宽度从 136 压缩至 108，厚度由 18 减为 14，瞬间解决横向偏宽感觉。',
    angle: 18,
    rectWidth: 16,
    barWidth: 108,
    barHeight: 14,
    barY: 92,
    dotY: 28,
    hasGap: false,
    flatBottom: false
  },
  {
    id: 'narrow-angle',
    nameZh: 'C. 收窄斜角 + 细横梁',
    desc: '倾斜角收拢至 14°，大幅缓解底部交叉处的拥挤感，配以 106 宽度的干练横梁。',
    angle: 14,
    rectWidth: 16,
    barWidth: 106,
    barHeight: 14,
    barY: 92,
    dotY: 28,
    hasGap: false,
    flatBottom: false
  },
  {
    id: 'overlap-gap',
    nameZh: 'D. 交叉处透气微缝',
    desc: '利用负空间遮罩在两条斜腿交叉点处切开 5px 缝隙，使几何图形产生前后叠放的空间感。',
    angle: 18,
    rectWidth: 16,
    barWidth: 112,
    barHeight: 14,
    barY: 92,
    dotY: 28,
    hasGap: true,
    flatBottom: false
  },
  {
    id: 'golden-ratio',
    nameZh: 'E. 黄金比例平衡 (推荐)',
    desc: '整合优化：斜角 15°，骨骼粗细减为 14。横梁 104×13 且位置微调上移，绿点拉近，最和谐协调。',
    angle: 15,
    rectWidth: 14,
    barWidth: 104,
    barHeight: 13,
    barY: 94,
    dotY: 32,
    hasGap: false,
    flatBottom: false
  },
  {
    id: 'golden-ratio-gap',
    nameZh: 'F. 黄金比例 + 叠层微缝',
    desc: '将黄金分割比例与叠层微缝结合。既具备干练的横梁尺寸，又拥有立体的阴影交错。',
    angle: 15,
    rectWidth: 14,
    barWidth: 104,
    barHeight: 13,
    barY: 94,
    dotY: 32,
    hasGap: true,
    flatBottom: false
  },
  {
    id: 'flat-ground',
    nameZh: 'G. 建筑齐平底座',
    desc: '在底部 Y=144 处切平两条斜臂。使其不再凸出圆角，如同一座底座坚实的现代雕塑。',
    angle: 16,
    rectWidth: 15,
    barWidth: 110,
    barHeight: 14,
    barY: 92,
    dotY: 30,
    hasGap: false,
    flatBottom: true
  },
  {
    id: 'ultra-minimal',
    nameZh: 'H. 极简空灵细线',
    desc: '将骨骼厚度减至 11，横梁缩为 98×11。适合超扁平、高冷高雅的界面环境。',
    angle: 15,
    rectWidth: 11,
    barWidth: 98,
    barHeight: 11,
    barY: 94,
    dotY: 32,
    hasGap: false,
    flatBottom: false
  }
];

// ─────────────────────────────────────────────────────────────────────────────
// Configurable SVG Icon Component
// ─────────────────────────────────────────────────────────────────────────────
const ConfigurableIcon = ({ 
  spec, 
  skin, 
  showLoaderElements = false,
  classNamePrefix = "" 
}: { 
  spec: IconSpec; 
  skin: any; 
  showLoaderElements?: boolean;
  classNamePrefix?: string 
}) => {
  const { angle, rectWidth, barWidth, barHeight, barY, dotY, hasGap, flatBottom } = spec;

  const lX = 100 - rectWidth;
  const rX = 100;
  const bX = 100 - barWidth / 2;

  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%', overflow: 'visible' }} fill="none">
      {flatBottom && (
        <defs>
          <clipPath id={`flat-clip-${spec.id}-${classNamePrefix}`}>
            <rect x="-50" y="-50" width="300" height="194" />
          </clipPath>
        </defs>
      )}

      {/* Dynamic Loader concentric rings/dots (only rendered when needed) */}
      {showLoaderElements && (
        <>
          <circle 
            className="loading-orbit" 
            cx="100" 
            cy="100" 
            r="80" 
            stroke={skin.accent} 
            strokeWidth="2.5" 
            strokeLinecap="round"
            opacity="0"
            style={{ transformOrigin: 'center center' }}
          />
          <circle 
            className="loading-particle" 
            cx="180" 
            cy="100" 
            r="6" 
            fill={skin.accent} 
            opacity="0"
            style={{ transformOrigin: 'center center', filter: `drop-shadow(0 0 6px ${skin.accent})` }}
          />
        </>
      )}

      <g clipPath={flatBottom ? `url(#flat-clip-${spec.id}-${classNamePrefix})` : undefined}>
        {/* Right Leg Group */}
        <g className={`${classNamePrefix}logo-group-r`} transform={`rotate(${angle} 100 100)`}>
          <rect 
            className={`${classNamePrefix}logo-arm-r`} 
            x={rX} 
            y="30" 
            width={rectWidth} 
            height="120" 
            rx={rectWidth / 2} 
            fill={skin.fg} 
          />
        </g>

        {/* Left Leg Gap Cut */}
        {hasGap && (
          <g className={`${classNamePrefix}logo-group-l-gap`} transform={`rotate(${-angle} 100 100)`}>
            <rect 
              x={lX} 
              y="30" 
              width={rectWidth} 
              height="120" 
              rx={rectWidth / 2} 
              fill="none"
              stroke={skin.bg}
              strokeWidth={rectWidth > 13 ? "6" : "4.5"}
              style={{ transition: 'stroke 0.4s' }}
            />
          </g>
        )}

        {/* Left Leg Group */}
        <g className={`${classNamePrefix}logo-group-l`} transform={`rotate(${-angle} 100 100)`}>
          <rect 
            className={`${classNamePrefix}logo-arm-l`} 
            x={lX} 
            y="30" 
            width={rectWidth} 
            height="120" 
            rx={rectWidth / 2} 
            fill={skin.fg} 
          />
        </g>
      </g>

      {/* Crossbar */}
      <rect 
        className={`${classNamePrefix}logo-bar`} 
        x={bX} 
        y={barY} 
        width={barWidth} 
        height={barHeight} 
        rx={barHeight / 2} 
        fill={skin.fg} 
      />

      {/* Top Dot */}
      <circle 
        className={`${classNamePrefix}logo-dot`} 
        cx="100" 
        cy={dotY} 
        r="9" 
        fill={skin.accent} 
      />
    </svg>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Animation Implementations (Linked to dynamic geometries)
// ─────────────────────────────────────────────────────────────────────────────

const animElastic = (container: HTMLElement, spec: IconSpec) => {
  const q = (s: string) => container.querySelectorAll(s);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.8 });
  
  gsap.set(q('.logo-group-l'), { rotate: -80, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: 80, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l, .logo-arm-r'), { scale: 1, y: 0 }); 
  gsap.set(q('.logo-bar'), { scaleX: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-dot'), { scale: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-char'), { y: 30, opacity: 0, scale: 0.6 });

  tl.to(q('.logo-group-l'), { rotate: -spec.angle, opacity: 1, duration: 0.85, ease: 'back.out(1.6)', svgOrigin: '100 100' })
    .to(q('.logo-group-r'), { rotate: spec.angle, opacity: 1, duration: 0.85, ease: 'back.out(1.6)', svgOrigin: '100 100' }, '<0.08')
    .to(q('.logo-bar'), { scaleX: 1, duration: 0.6, ease: 'expo.out' }, '-=0.45')
    .to(q('.logo-dot'), { scale: 1, duration: 0.65, ease: 'elastic.out(1, 0.45)' }, '-=0.25')
    .to(q('.logo-char'), { y: 0, opacity: 1, scale: 1, duration: 0.5, stagger: 0.08, ease: 'back.out(1.5)' }, '-=0.3')
    .to(q('.logo-dot'), { scale: 1.22, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 2 }, '+=0.2')
    .to(q('.logo-char-O'), { scale: 1.25, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 2 }, '<')
    .to(q('.logo-group-l, .logo-group-r, .logo-bar, .logo-dot, .logo-char'), { opacity: 0, duration: 0.6, ease: 'power2.in' }, '+=1.2');
  return tl;
};

const animHandwriting = (container: HTMLElement, spec: IconSpec) => {
  const q = (s: string) => container.querySelectorAll(s);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.8 });

  gsap.set(q('.logo-group-l'), { rotate: -spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l'), { scaleY: 0, opacity: 1, transformOrigin: 'center top' });
  gsap.set(q('.logo-arm-r'), { scaleY: 0, opacity: 1, transformOrigin: 'center top' });
  gsap.set(q('.logo-bar'), { scaleX: 0, opacity: 1, transformOrigin: 'center center' });
  gsap.set(q('.logo-dot'), { scale: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-char'), { opacity: 0, filter: 'blur(8px)' });

  tl.to(q('.logo-arm-l'), { scaleY: 1, duration: 0.75, ease: 'power3.out' })
    .to(q('.logo-arm-r'), { scaleY: 1, duration: 0.75, ease: 'power3.out' }, '<0.15')
    .to(q('.logo-bar'), { scaleX: 1, duration: 0.6, ease: 'power2.out' }, '-=0.3')
    .to(q('.logo-dot'), { scale: 1, duration: 0.5, ease: 'back.out(2.5)' }, '-=0.15')
    .to(q('.logo-char'), { opacity: 1, filter: 'blur(0px)', duration: 0.6, stagger: 0.1, ease: 'power2.out' }, '-=0.2')
    .to(q('.logo-dot'), { scale: 1.15, duration: 0.4, ease: 'sine.inOut', yoyo: true, repeat: 3 }, '+=0.4')
    .to(q('.logo-arm-l, .logo-arm-r, .logo-bar, .logo-dot, .logo-char'), { opacity: 0, duration: 0.6, ease: 'power2.in' }, '+=1.2');
  return tl;
};

const animMolecular = (container: HTMLElement, spec: IconSpec) => {
  const q = (s: string) => container.querySelectorAll(s);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.8 });

  gsap.set(q('.logo-group-l'), { rotate: -spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l'), { y: -150, opacity: 0 });
  gsap.set(q('.logo-arm-r'), { y: -150, opacity: 0 });
  gsap.set(q('.logo-bar'), { y: 80, scaleY: 0, opacity: 0 });
  gsap.set(q('.logo-dot'), { y: -60, scale: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-char'), { opacity: 0, scale: 0.3 });

  tl.to(q('.logo-arm-l, .logo-arm-r'), { y: 0, opacity: 1, duration: 0.85, ease: 'power4.out', stagger: 0.08 })
    .to(q('.logo-bar'), { y: 0, scaleY: 1, opacity: 1, duration: 0.6, ease: 'back.out(1.5)' }, '-=0.4')
    .to(q('.logo-dot'), { y: 0, scale: 1, duration: 0.7, ease: 'elastic.out(1, 0.4)' }, '-=0.25')
    .fromTo(q('.logo-char'), 
      { x: (i) => (i - 2) * 40, y: -60, opacity: 0, scale: 0.2 },
      { x: 0, y: 0, opacity: 1, scale: 1, duration: 0.8, ease: 'power4.out', stagger: 0.05 },
      '-=0.35'
    )
    .to(q('.logo-dot'), { scale: 1.2, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 2 }, '+=0.2')
    .to(q('.logo-arm-l, .logo-arm-r, .logo-bar, .logo-dot, .logo-char'), { opacity: 0, duration: 0.6 }, '+=1.2');
  return tl;
};

const animScanner = (container: HTMLElement, spec: IconSpec) => {
  const q = (s: string) => container.querySelectorAll(s);
  const scanLine = container.querySelector('.scan-line');
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.8 });

  gsap.set(q('.logo-group-l'), { rotate: -spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l, .logo-arm-r'), { y: 0, scale: 1 });
  gsap.set(q('.logo-arm-l, .logo-arm-r, .logo-bar, .logo-dot'), { opacity: 0.08 });
  gsap.set(q('.logo-char'), { opacity: 0.08 });
  gsap.set(scanLine, { top: '0px', opacity: 0 });

  tl.to(scanLine, { opacity: 1, duration: 0.15 })
    .to(scanLine, { top: '180px', duration: 1.4, ease: 'power1.inOut' })
    .to(q('.logo-dot'), { opacity: 1, scale: 1.25, duration: 0.25, ease: 'power2.out', yoyo: true, repeat: 1, transformOrigin: 'center center' }, '<0.1')
    .to(q('.logo-arm-l'), { opacity: 1, duration: 0.3 }, '<0.25')
    .to(q('.logo-arm-r'), { opacity: 1, duration: 0.3 }, '<0.05')
    .to(q('.logo-bar'), { opacity: 1, duration: 0.3 }, '<0.2')
    .to(q('.logo-char'), { opacity: 1, scale: 1.15, duration: 0.2, stagger: 0.08, yoyo: true, repeat: 1, ease: 'sine.out' }, '-=0.55')
    .to(scanLine, { opacity: 0, duration: 0.2 })
    .to(q('.logo-dot'), { scale: 1.2, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 2 }, '+=0.2')
    .to(q('.logo-arm-l, .logo-arm-r, .logo-bar, .logo-dot, .logo-char'), { opacity: 0, duration: 0.6 }, '+=1.0');
  return tl;
};

const animCompass = (container: HTMLElement, spec: IconSpec) => {
  const q = (s: string) => container.querySelectorAll(s);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.8 });

  gsap.set(q('.logo-group-l'), { rotate: -180, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: 180, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l, .logo-arm-r'), { y: 0, scale: 1 });
  gsap.set(q('.logo-bar'), { scaleX: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-dot'), { scale: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-char'), { opacity: 0, y: 15 });

  tl.to(q('.logo-group-l'), { rotate: -spec.angle, opacity: 1, duration: 0.9, ease: 'power3.out', svgOrigin: '100 100' })
    .to(q('.logo-group-r'), { rotate: spec.angle, opacity: 1, duration: 0.9, ease: 'power3.out', svgOrigin: '100 100' }, '<0.1')
    .to(q('.logo-bar'), { scaleX: 1, duration: 0.6, ease: 'expo.out' }, '-=0.4')
    .to(q('.logo-dot'), { scale: 1, duration: 0.5, ease: 'back.out(2)' }, '-=0.2')
    .to(q('.logo-char'), { opacity: 1, y: 0, duration: 0.6, stagger: 0.06, ease: 'power2.out' }, '-=0.15')
    .to(q('.logo-dot'), { scale: 1.15, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 2 }, '+=0.4')
    .to(q('.logo-group-l, .logo-group-r, .logo-bar, .logo-dot, .logo-char'), { opacity: 0, duration: 0.6 }, '+=1.2');
  return tl;
};

const animBroadcast = (container: HTMLElement, spec: IconSpec) => {
  const q = (s: string) => container.querySelectorAll(s);
  const halo = container.querySelector('.glow-halo');
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

  gsap.set(q('.logo-group-l'), { rotate: -spec.angle, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: spec.angle, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l, .logo-arm-r'), { y: 0, scale: 1 });
  gsap.set(q('.logo-bar, .logo-dot'), { opacity: 0 });
  gsap.set(q('.logo-char'), { opacity: 0 });
  gsap.set(halo, { scale: 0, opacity: 0 });

  tl.to(q('.logo-group-l, .logo-group-r'), { opacity: 1, duration: 0.6, stagger: 0.08 })
    .to(q('.logo-bar'), { opacity: 1, duration: 0.45 }, '-=0.25')
    .to(q('.logo-dot'), { opacity: 1, duration: 0.35 }, '-=0.15')
    .to(q('.logo-char'), { opacity: 1, duration: 0.6, stagger: 0.05 }, '-=0.2')
    .set(halo, { scale: 0.5, opacity: 0.8 })
    .to(halo, { scale: 6, opacity: 0, duration: 1.4, ease: 'power2.out' }, '+=0.1')
    .set(halo, { scale: 0.5, opacity: 0.8 }, '+=0.2')
    .to(halo, { scale: 6, opacity: 0, duration: 1.4, ease: 'power2.out' })
    .to(q('.logo-group-l, .logo-group-r, .logo-bar, .logo-dot, .logo-char'), { opacity: 0, duration: 0.65 }, '+=0.6');
  return tl;
};

const animAperture = (container: HTMLElement, spec: IconSpec) => {
  const q = (s: string) => container.querySelectorAll(s);
  const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.8 });

  gsap.set(q('.logo-group-l'), { rotate: -spec.angle, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: spec.angle, opacity: 0, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l'), { scale: 0, opacity: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-arm-r'), { scale: 0, opacity: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-bar'), { scale: 0, opacity: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-dot'), { scale: 4, opacity: 0, transformOrigin: 'center center' });
  gsap.set(q('.logo-char'), { opacity: 0, scale: 0.8 });

  tl.to(q('.logo-dot'), { scale: 1, opacity: 1, duration: 0.75, ease: 'power4.out' })
    .to(q('.logo-group-l, .logo-group-r'), { opacity: 1, duration: 0.1 }, '-=0.3')
    .to(q('.logo-arm-l, .logo-arm-r'), { scale: 1, opacity: 1, duration: 0.75, ease: 'back.out(1.4)', stagger: 0.08 }, '-=0.3')
    .to(q('.logo-bar'), { scale: 1, opacity: 1, duration: 0.55, ease: 'back.out(1.4)' }, '-=0.4')
    .to(q('.logo-char'), { opacity: 1, scale: 1, duration: 0.5, stagger: 0.07, ease: 'back.out(1.5)' }, '-=0.25')
    .to(q('.logo-dot'), { scale: 1.15, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 2 }, '+=0.3')
    .to(q('.logo-group-l, .logo-group-r, .logo-bar, .logo-dot, .logo-char'), { opacity: 0, duration: 0.6 }, '+=1.1');
  return tl;
};

const animLoader = (container: HTMLElement, spec: IconSpec, skin: any) => {
  const q = (s: string) => container.querySelectorAll(s);
  const orbit = container.querySelector('.loading-orbit');
  const particle = container.querySelector('.loading-particle');
  const tl = gsap.timeline({ repeat: -1 });

  gsap.set(q('.logo-group-l'), { rotate: -spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-group-r'), { rotate: spec.angle, opacity: 1, svgOrigin: '100 100' });
  gsap.set(q('.logo-arm-l, .logo-arm-r, .logo-bar'), { scale: 1, y: 0, opacity: 0.35 }); 
  gsap.set(q('.logo-dot'), { scale: 1, opacity: 1 }); 
  
  gsap.set(orbit, { opacity: 0.25, strokeDasharray: 502.4, strokeDashoffset: 502.4, rotate: -90 });
  gsap.set(particle, { opacity: 0, scale: 0 });

  tl.to(orbit, { strokeDashoffset: 120, duration: 1.2, ease: 'power2.out' })
    .to(particle, { opacity: 1, scale: 1, duration: 0.4 }, '-=0.6')
    .to(orbit, { rotate: 270, strokeDashoffset: 350, duration: 2.2, ease: 'sine.inOut', repeat: -1, yoyo: true }, '-=0.2')
    .to([orbit, particle], { rotate: '+=360', duration: 3.5, ease: 'none', repeat: -1 }, 0)
    .to(q('.logo-dot'), { scale: 1.25, duration: 0.8, yoyo: true, repeat: -1, ease: 'sine.inOut' }, 0)
    .to(q('.logo-char'), {
      opacity: 0.9,
      color: skin.accent,
      scale: 1.15,
      stagger: { each: 0.15, repeat: -1, yoyo: true },
      duration: 0.6,
      ease: 'sine.inOut'
    }, 0);
  return tl;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Studio Component
// ─────────────────────────────────────────────────────────────────────────────
export function ArtonIconStudio() {
  const [activeTab, setActiveTab] = useState<'motion' | 'geometry'>('motion');
  const [activeSpecId, setActiveSpecId] = useState<string>('golden-ratio'); // Default to golden ratio
  const [activeAnimId, setActiveAnimId] = useState<string>('elastic');
  
  const [skinKey, setSkinKey] = useState<string>(() => {
    try {
      return localStorage.getItem('crish_theme_skin') || 'cyber';
    } catch {
      return 'cyber';
    }
  });

  const stageRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);

  const currentSkin = SKIN_PRESETS[skinKey] || SKIN_PRESETS['cyber'];
  const activeSpec = CANDIDATES.find(c => c.id === activeSpecId)!;

  // ANIMATION LIST
  const ANIMATIONS = [
    { id: 'elastic', name: '01. 经典弹性动力学', fn: animElastic, tech: 'Group Rotation' },
    { id: 'handwriting', name: '02. 笔画循迹手绘', fn: animHandwriting, tech: 'Rect ScaleY' },
    { id: 'molecular', name: '03. 分子微粒重组', fn: animMolecular, tech: 'Local Offset Translate' },
    { id: 'scanner', name: '04. 光栅扫掠激活', fn: animScanner, tech: 'Sweep Mask' },
    { id: 'compass', name: '05. 罗盘旋转对齐', fn: animCompass, tech: 'Radial Rotation' },
    { id: 'broadcast', name: '06. 始终在线广播', fn: animBroadcast, tech: 'Halo Blur Ripple' },
    { id: 'aperture', name: '07. 负空间视口对焦', fn: animAperture, tech: 'Scale Inversion' },
    { id: 'loader', name: '08. 动态加载循环 (Loop)', fn: (c: HTMLElement, s: IconSpec) => animLoader(c, s, currentSkin), tech: 'Orbit Dash Sweep' },
  ];

  const activeAnim = ANIMATIONS.find(a => a.id === activeAnimId)!;

  // Guidance click transition
  const handleSelectAnim = (id: string) => {
    const container = stageRef.current;
    if (!container) {
      setActiveAnimId(id);
      return;
    }
    gsap.to(container, {
      scale: 0.94,
      filter: 'blur(3px)',
      duration: 0.18,
      ease: 'power2.out',
      onComplete: () => {
        setActiveAnimId(id);
        gsap.to(container, { scale: 1, filter: 'blur(0px)', duration: 0.45, ease: 'back.out(1.5)' });
      }
    });
  };

  const handleApplySpec = (id: string) => {
    setActiveSpecId(id);
    // Auto transition to animation view with a soft scale pop
    setActiveTab('motion');
  };

  // Re-load GSAP timelines
  useEffect(() => {
    if (activeTab !== 'motion') return;
    const container = stageRef.current;
    if (!container) return;

    if (tlRef.current) {
      tlRef.current.kill();
      tlRef.current = null;
    }

    const elements = container.querySelectorAll(
      '.logo-group-l, .logo-group-r, .logo-arm-l, .logo-arm-r, .logo-bar, .logo-dot, .logo-char, .glow-halo, .scan-line, .loading-orbit, .loading-particle'
    );
    gsap.set(elements, { clearProps: 'all' });

    const rafId = requestAnimationFrame(() => {
      const tl = activeAnim.fn(container, activeSpec);
      tlRef.current = tl;
    });

    return () => {
      cancelAnimationFrame(rafId);
      if (tlRef.current) tlRef.current.kill();
    };
  }, [activeAnimId, activeSpecId, skinKey, activeTab]);

  const sizes = [
    { px: 110, r: '24px', label: '128px 桌面' },
    { px: 52,  r: '12px', label: '48px 任务栏' },
    { px: 24,  r: '5px',  label: '24px 控制台' }
  ];

  return (
    <div style={{
      width: '100vw', height: '100vh',
      backgroundColor: currentSkin.bg, color: currentSkin.fg,
      fontFamily: "'Outfit', 'Inter', system-ui, sans-serif",
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      transition: 'background 0.4s cubic-bezier(0.16, 1, 0.3, 1), color 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    }}>
      
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{
        padding: '12px 28px',
        backgroundColor: currentSkin.panel,
        borderBottom: `1px solid ${currentSkin.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
        zIndex: 100,
        transition: 'background 0.4s, border 0.4s'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span style={{ fontWeight: 900, fontSize: '15px', letterSpacing: '0.12em' }}>ARTON</span>
          
          {/* Main workspace view switch */}
          <div style={{ display: 'flex', backgroundColor: currentSkin.bg, padding: '3px', borderRadius: '8px', border: `1px solid ${currentSkin.border}` }}>
            <button 
              onClick={() => setActiveTab('motion')}
              style={{
                padding: '4px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                fontSize: '11px', fontWeight: 700, transition: 'all 0.2s',
                backgroundColor: activeTab === 'motion' ? currentSkin.accent : 'transparent',
                color: activeTab === 'motion' ? currentSkin.bg : currentSkin.muted
              }}
            >
              🎥 动效演绎室
            </button>
            <button 
              onClick={() => setActiveTab('geometry')}
              style={{
                padding: '4px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
                fontSize: '11px', fontWeight: 700, transition: 'all 0.2s',
                backgroundColor: activeTab === 'geometry' ? currentSkin.accent : 'transparent',
                color: activeTab === 'geometry' ? currentSkin.bg : currentSkin.muted
              }}
            >
              📐 重心比例微调网格
            </button>
          </div>
        </div>

        {/* Dynamic theme selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: currentSkin.muted, fontWeight: 700 }}>适配软件主题：</span>
          <select 
            value={skinKey}
            onChange={(e) => {
              const val = e.target.value;
              setSkinKey(val);
              try { localStorage.setItem('crish_theme_skin', val); } catch (err) {}
            }}
            style={{
              padding: '5px 12px', borderRadius: '8px', fontSize: '11px', fontWeight: 700,
              backgroundColor: currentSkin.bg, color: currentSkin.fg, border: `1px solid ${currentSkin.border}`,
              cursor: 'pointer', outline: 'none',
            }}
          >
            {Object.entries(SKIN_PRESETS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.isDark ? '🌙' : '☀️'} {v.name} ({k})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ── Main Panel View ── */}
      {activeTab === 'motion' ? (
        // 🎥 View A: Animation Sandbox
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          
          {/* Left Sidebar */}
          <div style={{
            width: '280px', flexShrink: 0, backgroundColor: currentSkin.panel,
            borderRight: `1px solid ${currentSkin.border}`, padding: '16px 12px',
            display: 'flex', flexDirection: 'column', gap: '6px', overflowY: 'auto',
            transition: 'background 0.4s, border 0.4s'
          }}>
            <div style={{ 
              fontSize: '10px', fontWeight: 800, color: currentSkin.muted, letterSpacing: '0.12em', 
              padding: '0 6px 6px 6px', borderBottom: `1px solid ${currentSkin.border}`, marginBottom: '8px'
            }}>
              动效选择 (当前静态比例: {activeSpec.nameZh.slice(3)})
            </div>

            {ANIMATIONS.map(an => {
              const isActive = an.id === activeAnimId;
              return (
                <button 
                  key={an.id} 
                  onClick={() => handleSelectAnim(an.id)} 
                  style={{
                    display: 'flex', flexDirection: 'column', width: '100%', textAlign: 'left', 
                    padding: '12px 14px', borderRadius: '12px', cursor: 'pointer',
                    border: `1px solid ${isActive ? `rgba(${currentSkin.isDark ? '255,255,255' : '0,0,0'}, 0.15)` : 'transparent'}`,
                    backgroundColor: isActive ? `rgba(${currentSkin.isDark ? '255,255,255' : '0,0,0'}, 0.05)` : 'transparent',
                    transition: 'all 0.2s ease', outline: 'none',
                  }}
                >
                  <div style={{ fontSize: '13px', fontWeight: isActive ? 800 : 600, color: isActive ? currentSkin.accent : currentSkin.fg, lineHeight: 1.2 }}>
                    {an.name}
                  </div>
                  <div style={{ fontSize: '10px', color: currentSkin.muted, marginTop: '4px', fontFamily: 'monospace' }}>
                    {an.tech}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Sandbox Stage */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden' }}>
            <div style={{
              position: 'absolute', inset: 0, pointerEvents: 'none',
              backgroundImage: `radial-gradient(${currentSkin.border} 1.5px, transparent 1.5px)`,
              backgroundSize: '24px 24px', opacity: 0.6,
            }} />

            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
              <div 
                ref={stageRef}
                style={{
                  width: '280px', height: '310px', borderRadius: '36px', padding: '24px',
                  backgroundColor: currentSkin.bg,
                  boxShadow: currentSkin.isDark
                    ? `0 30px 80px rgba(0,0,0,0.85), inset 0 1px 2px rgba(255,255,255,0.05), 0 0 40px rgba(${currentSkin.accent === '#18181b' ? '0,0,0' : '16,185,129'}, 0.03)`
                    : '0 20px 50px rgba(9,9,11,0.06), 0 0 1px rgba(9,9,11,0.1)',
                  border: `1px solid ${currentSkin.border}`, zIndex: 10, position: 'relative',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  transition: 'background 0.4s, border 0.4s'
                }}
              >
                <ConfigurableIcon spec={activeSpec} skin={currentSkin} showLoaderElements={activeAnimId === 'loader'} />
              </div>

              {/* Sizes Preview */}
              <div style={{
                position: 'absolute', right: '36px', top: '50%', transform: 'translateY(-50%)',
                display: 'flex', flexDirection: 'column', gap: '16px',
                backgroundColor: currentSkin.panel, padding: '20px 22px', borderRadius: '20px',
                border: `1px solid ${currentSkin.border}`, zIndex: 20,
                boxShadow: '0 8px 30px rgba(0,0,0,0.12)', transition: 'background 0.4s, border 0.4s'
              }}>
                <div style={{ fontSize: '10px', fontWeight: 800, color: currentSkin.muted, letterSpacing: '0.05em', marginBottom: '4px' }}>
                  终端静态适配预览
                </div>
                {sizes.map(({ px, r, label }) => (
                  <div key={px} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                      width: px, height: px, flexShrink: 0, borderRadius: r,
                      padding: Math.max(2, Math.round(px * 0.08)) + 'px',
                      backgroundColor: currentSkin.bg, border: `1px solid ${currentSkin.border}`, overflow: 'hidden',
                      transition: 'background 0.4s, border 0.4s'
                    }}>
                      <ConfigurableIcon spec={activeSpec} skin={currentSkin} />
                    </div>
                    <span style={{ fontSize: '11px', color: currentSkin.muted, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom info */}
            <div style={{
              padding: '20px 28px', flexShrink: 0, backgroundColor: currentSkin.panel,
              borderTop: `1px solid ${currentSkin.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '24px', zIndex: 10,
              transition: 'background 0.4s, border 0.4s'
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 800, fontSize: '15px', color: currentSkin.fg }}>{activeAnim.name}</span>
                  <span style={{ 
                    fontSize: '10px', fontWeight: 700, color: currentSkin.accent,
                    backgroundColor: `rgba(${currentSkin.isDark ? '255,255,255' : '0,0,0'}, 0.05)`,
                    border: `1px solid ${currentSkin.border}`, padding: '3px 10px', borderRadius: '999px' 
                  }}>
                    {activeAnim.tech}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: currentSkin.muted, lineHeight: 1.6 }}>{activeAnim.desc}</div>
              </div>
              <div style={{
                fontSize: '11px', color: currentSkin.muted, fontWeight: 700, padding: '8px 16px', borderRadius: '10px',
                backgroundColor: `rgba(${currentSkin.isDark ? '255,255,255' : '0,0,0'}, 0.04)`, border: `1px solid ${currentSkin.border}`,
                whiteSpace: 'nowrap',
              }}>
                静态重心方案: {activeSpec.nameZh.slice(3)}
              </div>
            </div>
          </div>
        </div>
      ) : (
        // 📐 View B: Grid tuning of static candidates
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', padding: '30px 40px', gap: '24px' }}>
          
          <div style={{ borderBottom: `1px solid ${currentSkin.border}`, paddingBottom: '12px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: 900, color: currentSkin.fg, margin: 0 }}>
              几何重心与比例调优网格 (Tuning Grid)
            </h2>
            <p style={{ fontSize: '12px', color: currentSkin.muted, marginTop: '6px', margin: 0 }}>
              针对“底部交叉拥挤”与“横梁偏宽”问题设计的 8 种改进几何参数。在此进行静态横向对比，点击【应用到动效】可将参数全局带入动效实验室中预览。
            </p>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: '24px',
            paddingBottom: '40px'
          }}>
            {CANDIDATES.map(cand => {
              const isApplied = cand.id === activeSpecId;
              return (
                <div 
                  key={cand.id}
                  style={{
                    backgroundColor: currentSkin.panel,
                    borderRadius: '24px',
                    border: `1px solid ${isApplied ? currentSkin.accent : currentSkin.border}`,
                    padding: '20px',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '16px',
                    boxShadow: isApplied ? `0 8px 24px rgba(0,0,0,0.12), 0 0 16px rgba(${currentSkin.isDark ? '255,255,255' : '0,0,0'}, 0.02)` : 'none',
                    transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                    <span style={{ fontSize: '13px', fontWeight: 800, color: isApplied ? currentSkin.accent : currentSkin.fg }}>
                      {cand.nameZh}
                    </span>
                    {isApplied && (
                      <span style={{ fontSize: '10px', color: currentSkin.accent, fontWeight: 700, backgroundColor: `rgba(${currentSkin.isDark ? '255,255,255' : '0,0,0'}, 0.05)`, border: `1px solid ${currentSkin.border}`, padding: '2px 8px', borderRadius: '999px' }}>
                        当前应用中
                      </span>
                    )}
                  </div>

                  {/* Configurable Static Icon Viewport */}
                  <div style={{
                    width: '130px', height: '130px',
                    backgroundColor: currentSkin.bg,
                    borderRadius: '20px',
                    padding: '16px',
                    border: `1px solid ${currentSkin.border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'background 0.4s, border 0.4s'
                  }}>
                    <ConfigurableIcon spec={cand} skin={currentSkin} classNamePrefix={`grid-spec-${cand.id}-`} />
                  </div>

                  {/* Spec detailed parameters */}
                  <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '120px' }}>
                    <p style={{ fontSize: '11px', color: currentSkin.muted, lineHeight: 1.5, margin: 0 }}>
                      {cand.desc}
                    </p>
                    
                    {/* CAD data panel */}
                    <div style={{ 
                      marginTop: 'auto', backgroundColor: currentSkin.bg, padding: '8px 12px', borderRadius: '10px',
                      fontSize: '10px', fontFamily: 'monospace', color: currentSkin.muted,
                      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px',
                      border: `1px solid ${currentSkin.border}`
                    }}>
                      <div>倾斜角度: {cand.angle}°</div>
                      <div>骨骼粗细: {cand.rectWidth}px</div>
                      <div>横梁宽度: {cand.barWidth}px</div>
                      <div>横梁高度: {cand.barHeight}px</div>
                      <div>横梁高度Y: {cand.barY}px</div>
                      <div>顶点高度Y: {cand.dotY}px</div>
                      <div>交叉透气: {cand.hasGap ? '开启 (缝隙)' : '无'}</div>
                      <div>齐平剪裁: {cand.flatBottom ? '开启 (平底)' : '无'}</div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleApplySpec(cand.id)}
                    style={{
                      width: '100%',
                      padding: '8px',
                      borderRadius: '10px',
                      fontSize: '11px',
                      fontWeight: 800,
                      cursor: 'pointer',
                      backgroundColor: isApplied ? currentSkin.bg : currentSkin.fg,
                      color: isApplied ? currentSkin.accent : currentSkin.bg,
                      border: isApplied ? `1px solid ${currentSkin.border}` : 'none',
                      transition: 'all 0.2s'
                    }}
                  >
                    {isApplied ? '应用并返回动效室' : '应用到动效'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
