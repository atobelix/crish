import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';

export interface IconConcept {
  id: string;
  category: string;
  title: string;
  titleZh: string;
  description: string;
  renderSvg: (svgRef: React.RefObject<SVGSVGElement | null>) => React.ReactNode;
}

export const ARTON_36_CONCEPTS: IconConcept[] = [
  // Category 1: Monogram Geometry & Deconstructed Letterform
  {
    id: 'c1-1',
    category: '1. 字母 A 几何解构',
    title: 'The Origami Crest',
    titleZh: '折纸几何 A',
    description: '多重几何线条折叠出悬浮 A 标志',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 50 15 L 20 80 L 38 80 L 50 48 L 62 80 L 80 80 Z" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <line className="icon-path-36" x1="32" y1="62" x2="68" y2="62" stroke="rgba(255,255,255,0.5)" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c1-2',
    category: '1. 字母 A 几何解构',
    title: 'The Delta Horizon',
    titleZh: '三角地平线 A',
    description: '三层渐进式极简地平线三角',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <polygon className="icon-path-36" points="50,15 25,75 75,75" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <polygon className="icon-path-36" points="50,32 35,65 65,65" stroke="rgba(255,255,255,0.4)" strokeWidth="1" fill="none" />
        <line className="icon-path-36" x1="15" y1="85" x2="85" y2="85" stroke="#f4f4f5" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c1-3',
    category: '1. 字母 A 几何解构',
    title: 'The Interlocking Apex',
    titleZh: '双线交错 A',
    description: '两条不封闭的极细弧线交错形成顶角',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 22 80 L 50 18 Q 60 50 78 80" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <path className="icon-path-36" d="M 78 80 L 50 18 Q 40 50 22 80" stroke="rgba(255,255,255,0.5)" strokeWidth="1" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c1-4',
    category: '1. 字母 A 几何解构',
    title: 'The Monolithic Arch',
    titleZh: '建筑拱门 A',
    description: '包豪斯风格拱门与悬空横梁',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 25 80 L 25 45 A 25 25 0 0 1 75 45 L 75 80" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <line className="icon-path-36" x1="20" y1="58" x2="80" y2="58" stroke="#f4f4f5" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c1-5',
    category: '1. 字母 A 几何解构',
    title: 'The Prism Needle',
    titleZh: '棱镜指针 A',
    description: '细长棱镜中轴指针',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <polygon className="icon-path-36" points="50,10 30,85 50,70 70,85" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <line className="icon-path-36" x1="50" y1="10" x2="50" y2="70" stroke="rgba(255,255,255,0.6)" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c1-6',
    category: '1. 字母 A 几何解构',
    title: 'The Minimal Pulse Peak',
    titleZh: '脉冲山峰 A',
    description: '连续折线脉冲升起形成山峰 A',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 10 75 L 30 75 L 50 15 L 70 75 L 90 75" stroke="#f4f4f5" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        <circle className="icon-path-36" cx="50" cy="15" r="3" fill="#f4f4f5" />
      </svg>
    ),
  },

  // Category 2: Celestial Mechanics & Orbital Vectors
  {
    id: 'c2-1',
    category: '2. 天体轨线与光圈',
    title: 'The Quad-Ellipse Gyro',
    titleZh: '四轨陀螺仪',
    description: '四重交错椭圆轨道环绕中心粒子',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <ellipse className="icon-path-36" cx="50" cy="50" rx="40" ry="14" stroke="#f4f4f5" strokeWidth="1" fill="none" transform="rotate(0 50 50)" />
        <ellipse className="icon-path-36" cx="50" cy="50" rx="40" ry="14" stroke="rgba(255,255,255,0.6)" strokeWidth="1" fill="none" transform="rotate(45 50 50)" />
        <ellipse className="icon-path-36" cx="50" cy="50" rx="40" ry="14" stroke="rgba(255,255,255,0.4)" strokeWidth="1" fill="none" transform="rotate(90 50 50)" />
        <ellipse className="icon-path-36" cx="50" cy="50" rx="40" ry="14" stroke="rgba(255,255,255,0.2)" strokeWidth="1" fill="none" transform="rotate(135 50 50)" />
      </svg>
    ),
  },
  {
    id: 'c2-2',
    category: '2. 天体轨线与光圈',
    title: 'The Eclipse Lens',
    titleZh: '日食透镜',
    description: '月食相位弧线遮罩',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <circle className="icon-path-36" cx="42" cy="50" r="35" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <circle className="icon-path-36" cx="58" cy="50" r="35" stroke="rgba(255,255,255,0.4)" strokeWidth="1" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c2-3',
    category: '2. 天体轨线与光圈',
    title: 'The Pulsar Arc',
    titleZh: '脉冲星双弧',
    description: '相向对峙的 1px 极细能量双弧',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 20 50 A 35 35 0 0 1 80 50" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <path className="icon-path-36" d="M 80 50 A 35 35 0 0 1 20 50" stroke="rgba(255,255,255,0.3)" strokeWidth="1" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c2-4',
    category: '2. 天体轨线与光圈',
    title: 'The Solstice Meridian',
    titleZh: '冬至子午线',
    description: '贯穿天体极点的垂直轴线',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <circle className="icon-path-36" cx="50" cy="50" r="38" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <line className="icon-path-36" x1="50" y1="5" x2="50" y2="95" stroke="#f4f4f5" strokeWidth="1" />
        <circle cx="50" cy="50" r="3" fill="#f4f4f5" />
      </svg>
    ),
  },
  {
    id: 'c2-5',
    category: '2. 天体轨线与光圈',
    title: 'The Concentric Wavefront',
    titleZh: '同心波前',
    description: '三重等距同心圆涟漪扩散',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <circle className="icon-path-36" cx="50" cy="50" r="15" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <circle className="icon-path-36" cx="50" cy="50" r="28" stroke="rgba(255,255,255,0.6)" strokeWidth="1" fill="none" />
        <circle className="icon-path-36" cx="50" cy="50" r="40" stroke="rgba(255,255,255,0.3)" strokeWidth="1" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c2-6',
    category: '2. 天体轨线与光圈',
    title: 'The Astrolabe Reticle',
    titleZh: '星盘十字',
    description: '四极刻度指针与外围度盘',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <circle className="icon-path-36" cx="50" cy="50" r="36" stroke="#f4f4f5" strokeWidth="1" fill="none" strokeDasharray="4 4" />
        <polygon className="icon-path-36" points="50,20 54,46 80,50 54,54 50,80 46,54 20,50 46,46" stroke="#f4f4f5" strokeWidth="1" fill="none" />
      </svg>
    ),
  },

  // Category 3: 3D Spatial Wireframes & Isometric Monoliths
  {
    id: 'c3-1',
    category: '3. 3D 空间三维线框',
    title: 'The Hypercube Tesseract',
    titleZh: '超立方线框',
    description: '内外双层嵌套四维超立方体',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <rect className="icon-path-36" x="20" y="20" width="60" height="60" fill="none" stroke="#f4f4f5" strokeWidth="1" />
        <rect className="icon-path-36" x="38" y="38" width="24" height="24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1" />
        <line className="icon-path-36" x1="20" y1="20" x2="38" y2="38" stroke="#f4f4f5" strokeWidth="1" />
        <line className="icon-path-36" x1="80" y1="20" x2="62" y2="38" stroke="#f4f4f5" strokeWidth="1" />
        <line className="icon-path-36" x1="80" y1="80" x2="62" y2="62" stroke="#f4f4f5" strokeWidth="1" />
        <line className="icon-path-36" x1="20" y1="80" x2="38" y2="62" stroke="#f4f4f5" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c3-2',
    category: '3. 3D 空间三维线框',
    title: 'The Isometric Prism Pyramid',
    titleZh: '等轴侧棱锥',
    description: '四角金字塔棱镜透视',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <polygon className="icon-path-36" points="50,15 85,75 15,75" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <line className="icon-path-36" x1="50" y1="15" x2="50" y2="75" stroke="rgba(255,255,255,0.6)" strokeWidth="1" />
        <line className="icon-path-36" x1="50" y1="15" x2="60" y2="75" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c3-3',
    category: '3. 3D 空间三维线框',
    title: 'The Floating Octahedron',
    titleZh: '悬浮八面体',
    description: '上下双锥体连接中央腰线',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <polygon className="icon-path-36" points="50,10 80,50 50,90 20,50" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <line className="icon-path-36" x1="20" y1="50" x2="80" y2="50" stroke="#f4f4f5" strokeWidth="1" />
        <line className="icon-path-36" x1="50" y1="10" x2="50" y2="90" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c3-4',
    category: '3. 3D 空间三维线框',
    title: 'The Möbius Strip Knot',
    titleZh: '莫比乌斯环',
    description: '单侧连续翻转曲面结构',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 25 50 C 25 25, 75 75, 75 50 C 75 25, 25 75, 25 50 Z" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c3-5',
    category: '3. 3D 空间三维线框',
    title: 'The Chiral Polyhedron',
    titleZh: '手性多面体',
    description: '非对称手性多边形交点',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <polygon className="icon-path-36" points="30,20 75,25 85,70 40,85 15,45" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <line className="icon-path-36" x1="30" y1="20" x2="85" y2="70" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
        <line className="icon-path-36" x1="75" y1="25" x2="15" y2="45" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c3-6',
    category: '3. 3D 空间三维线框',
    title: 'The Hexagonal Matrix Lattice',
    titleZh: '六边形晶格',
    description: '蜂窝状六边形矢量组装',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <polygon className="icon-path-36" points="50,15 80,32 80,68 50,85 20,68 20,32" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <line className="icon-path-36" x1="50" y1="15" x2="50" y2="50" stroke="#f4f4f5" strokeWidth="1" />
        <line className="icon-path-36" x1="80" y1="68" x2="50" y2="50" stroke="#f4f4f5" strokeWidth="1" />
        <line className="icon-path-36" x1="20" y1="68" x2="50" y2="50" stroke="#f4f4f5" strokeWidth="1" />
      </svg>
    ),
  },

  // Category 4: Precision Architectural CAD & Anchor Lines
  {
    id: 'c4-1',
    category: '4. 精密 CAD 蓝图标尺',
    title: 'The Quadrant Compass',
    titleZh: '四分仪罗盘',
    description: '90° 精密直角刻度弧与规针',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 20 80 L 20 20 L 80 80 Z" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <path className="icon-path-36" d="M 20 50 A 30 30 0 0 1 50 80" stroke="rgba(255,255,255,0.6)" strokeWidth="1" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c4-2',
    category: '4. 精密 CAD 蓝图标尺',
    title: 'The Precision Caliper',
    titleZh: '精密游标卡尺',
    description: '微米级对齐游标卡尺卡口',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 15 25 L 85 25 M 15 25 L 15 75 M 35 25 L 35 55 M 65 25 L 65 55 M 85 25 L 85 75" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c4-3',
    category: '4. 精密 CAD 蓝图标尺',
    title: 'The Vernier Crosshair',
    titleZh: '分厘十字',
    description: '带微观分厘刻度线的瞄准光标',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <circle className="icon-path-36" cx="50" cy="50" r="30" stroke="#f4f4f5" strokeWidth="1" fill="none" />
        <line className="icon-path-36" x1="10" y1="50" x2="90" y2="50" stroke="#f4f4f5" strokeWidth="0.8" />
        <line className="icon-path-36" x1="50" y1="10" x2="50" y2="90" stroke="#f4f4f5" strokeWidth="0.8" />
      </svg>
    ),
  },
  {
    id: 'c4-4',
    category: '4. 精密 CAD 蓝图标尺',
    title: 'The Bounding Vertex Lattice',
    titleZh: '边界顶点网格',
    description: '四角带有定位坐标点的裁剪框',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <rect className="icon-path-36" x="25" y="25" width="50" height="50" fill="none" stroke="#f4f4f5" strokeWidth="1" strokeDasharray="6 4" />
        <circle cx="25" cy="25" r="3" fill="#f4f4f5" />
        <circle cx="75" cy="25" r="3" fill="#f4f4f5" />
        <circle cx="75" cy="75" r="3" fill="#f4f4f5" />
        <circle cx="25" cy="75" r="3" fill="#f4f4f5" />
      </svg>
    ),
  },
  {
    id: 'c4-5',
    category: '4. 精密 CAD 蓝图标尺',
    title: 'The Orthographic Projection',
    titleZh: '正交投影',
    description: '三视图正交辅助线交织',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <line className="icon-path-36" x1="10" y1="50" x2="90" y2="50" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
        <line className="icon-path-36" x1="50" y1="10" x2="50" y2="90" stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
        <rect className="icon-path-36" x="20" y="20" width="25" height="25" fill="none" stroke="#f4f4f5" strokeWidth="1" />
        <rect className="icon-path-36" x="55" y="20" width="25" height="25" fill="none" stroke="#f4f4f5" strokeWidth="1" />
        <rect className="icon-path-36" x="20" y="55" width="25" height="25" fill="none" stroke="#f4f4f5" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c4-6',
    category: '4. 精密 CAD 蓝图标尺',
    title: 'The Tangent Radius Gauge',
    titleZh: '切线半径规',
    description: '圆弧切线极坐标测量规',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 20 80 A 60 60 0 0 1 80 20" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <line className="icon-path-36" x1="20" y1="80" x2="80" y2="20" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
      </svg>
    ),
  },

  // Category 5: Organic Fluid Dynamics & Bezier Ribbons
  {
    id: 'c5-1',
    category: '5. 有机流体与无限双纽',
    title: 'The Lemniscate Loop',
    titleZh: '双纽线 Infinity',
    description: '双焦点 ∞ 符号连续平滑运动',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 20 50 C 20 30, 45 30, 50 50 C 55 70, 80 70, 80 50 C 80 30, 55 30, 50 50 C 45 70, 20 70, 20 50 Z" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c5-2',
    category: '5. 有机流体与无限双纽',
    title: 'The Harmonic Sine Stream',
    titleZh: '谐波正弦流',
    description: '多重正弦波相位叠加游动',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 10 50 Q 30 20, 50 50 T 90 50" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <path className="icon-path-36" d="M 10 50 Q 30 80, 50 50 T 90 50" stroke="rgba(255,255,255,0.4)" strokeWidth="1" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c5-3',
    category: '5. 有机流体与无限双纽',
    title: 'The Spiral Helix',
    titleZh: '螺旋 DNA 链',
    description: '双螺旋结构交替扭转',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 30 15 C 70 35, 70 65, 30 85" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <path className="icon-path-36" d="M 70 15 C 30 35, 30 65, 70 85" stroke="rgba(255,255,255,0.4)" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c5-4',
    category: '5. 有机流体与无限双纽',
    title: 'The Fluid Vortex Ribbon',
    titleZh: '漩涡流体',
    description: '中心向内打转的流体气旋',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 50 15 A 35 35 0 1 1 20 50 A 25 25 0 1 1 40 65 A 10 10 0 1 1 50 50" stroke="#f4f4f5" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'c5-5',
    category: '5. 有机流体与无限双纽',
    title: 'The Wavelet Superposition',
    titleZh: '波包叠加',
    description: '高斯包络下的波形包络',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 10 50 Q 25 50 35 30 T 50 10 T 65 70 T 75 50 T 90 50" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c5-6',
    category: '5. 有机流体与无限双纽',
    title: 'The Curvilinear Ribbon Crest',
    titleZh: '曲面流线羽翼',
    description: '流畅如羽翼般划过的曲面线条',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 15 70 Q 50 10, 85 30 Q 50 50, 15 70 Z" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
      </svg>
    ),
  },

  // Category 6: Kinetic Typographic Badges & Minimal Stencils
  {
    id: 'c6-1',
    category: '6. 极简模板与印章徽章',
    title: 'The Stencil Frame A',
    titleZh: '模板切口 A',
    description: '带精准工业切口缝隙的 A 字型',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 50 15 L 25 75 M 50 15 L 75 75 M 32 55 L 68 55" stroke="#f4f4f5" strokeWidth="2" strokeDasharray="18 4" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c6-2',
    category: '6. 极简模板与印章徽章',
    title: 'The Debossed Monolith Crest',
    titleZh: '压印金石徽章',
    description: '哑光沉雕矩形印记框',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <rect className="icon-path-36" x="20" y="20" width="60" height="60" rx="4" fill="none" stroke="#f4f4f5" strokeWidth="1.5" />
        <path className="icon-path-36" d="M 38 68 L 50 32 L 62 68 M 43 54 L 57 54" stroke="#f4f4f5" strokeWidth="1.5" fill="none" />
      </svg>
    ),
  },
  {
    id: 'c6-3',
    category: '6. 极简模板与印章徽章',
    title: 'The Bracketed Core',
    titleZh: '括弧核心',
    description: '左右极简大括号包裹中心原点',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <path className="icon-path-36" d="M 30 20 C 15 20, 15 50, 10 50 C 15 50, 15 80, 30 80" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <path className="icon-path-36" d="M 70 20 C 85 20, 85 50, 90 50 C 85 50, 85 80, 70 80" stroke="#f4f4f5" strokeWidth="1.2" fill="none" />
        <circle cx="50" cy="50" r="3" fill="#f4f4f5" />
      </svg>
    ),
  },
  {
    id: 'c6-4',
    category: '6. 极简模板与印章徽章',
    title: 'The Structural Slash',
    titleZh: '结构斜线',
    description: '45° 极简平行解构切线',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <line className="icon-path-36" x1="20" y1="80" x2="70" y2="20" stroke="#f4f4f5" strokeWidth="2" />
        <line className="icon-path-36" x1="30" y1="80" x2="80" y2="20" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />
      </svg>
    ),
  },
  {
    id: 'c6-5',
    category: '6. 极简模板与印章徽章',
    title: 'The Minimalist Dot Monogram',
    titleZh: '点阵极简印',
    description: '3x3 精密矩阵盲文点阵',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        {[30, 50, 70].map((x) =>
          [30, 50, 70].map((y) => (
            <circle key={`${x}-${y}`} className="icon-path-36" cx={x} cy={y} r="2.5" fill="#f4f4f5" />
          ))
        )}
      </svg>
    ),
  },
  {
    id: 'c6-6',
    category: '6. 极简模板与印章徽章',
    title: 'The Architectural Seal',
    titleZh: '建筑方印',
    description: '包豪斯正方形与外切圆的交集印章',
    renderSvg: () => (
      <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
        <rect className="icon-path-36" x="25" y="25" width="50" height="50" fill="none" stroke="#f4f4f5" strokeWidth="1.2" />
        <circle className="icon-path-36" cx="50" cy="50" r="35" stroke="rgba(255,255,255,0.5)" strokeWidth="1" fill="none" />
      </svg>
    ),
  },
];

export const Arton36Catalog: React.FC = () => {
  const [selectedId, setSelectedId] = useState<string>('c1-1');
  const containerRef = useRef<HTMLDivElement>(null);

  const activeConcept = ARTON_36_CONCEPTS.find((c) => c.id === selectedId) || ARTON_36_CONCEPTS[0];

  useEffect(() => {
    const ctx = gsap.context(() => {
      const paths = containerRef.current?.querySelectorAll<SVGPathElement | SVGLineElement | SVGCircleElement | SVGRectElement | SVGPolygonElement | SVGEllipseElement>('.icon-path-36');
      paths?.forEach((p) => {
        const len = (p as any).getTotalLength ? (p as any).getTotalLength() : 250;
        gsap.set(p, { strokeDasharray: len, strokeDashoffset: len });
      });

      gsap.to('.icon-path-36', {
        strokeDashoffset: 0,
        duration: 2.0,
        ease: 'power3.inOut',
        stagger: 0.1,
      });

      gsap.fromTo('.active-title', { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 1.0, ease: 'power2.out' });
    }, containerRef);

    return () => ctx.revert();
  }, [selectedId]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#09090b',
        color: '#f4f4f5',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Inter, system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* 顶栏控制台 */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#050505',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '0.2em' }}>ARTON</span>
          <span style={{ fontSize: '12px', color: '#a1a1aa', borderLeft: '1px solid #3f3f46', paddingLeft: '12px' }}>
            36 款全新极简品牌图标方案库 (0数字 / 0进度条)
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 左侧 36 方案选择列表 */}
        <div
          style={{
            width: '320px',
            borderRight: '1px solid rgba(255, 255, 255, 0.1)',
            overflowY: 'auto',
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            backgroundColor: '#0c0d0e',
          }}
        >
          {ARTON_36_CONCEPTS.map((concept) => {
            const isSelected = concept.id === selectedId;
            return (
              <button
                key={concept.id}
                onClick={() => setSelectedId(concept.id)}
                style={{
                  textAlign: 'left',
                  padding: '10px 14px',
                  borderRadius: '6px',
                  backgroundColor: isSelected ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
                  border: isSelected ? '1px solid rgba(255, 255, 255, 0.25)' : '1px solid transparent',
                  color: isSelected ? '#ffffff' : '#a1a1aa',
                  cursor: 'pointer',
                  fontSize: '13px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  transition: 'all 0.2s ease',
                }}
              >
                <div>
                  <div style={{ fontWeight: isSelected ? 600 : 400, color: isSelected ? '#ffffff' : '#d4d4d8' }}>
                    {concept.titleZh}
                  </div>
                  <div style={{ fontSize: '11px', color: '#71717a', marginTop: '2px' }}>{concept.title}</div>
                </div>
                <div style={{ fontSize: '10px', opacity: 0.5 }}>{concept.id}</div>
              </button>
            );
          })}
        </div>

        {/* 右侧主预览区 */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            backgroundColor: '#09090b',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '32px' }}>
            {/* 动态图标主体 */}
            <div style={{ width: '120px', height: '120px' }}>
              {activeConcept.renderSvg(useRef(null))}
            </div>

            {/* 结合 ARTON 品牌字样 */}
            <div style={{ textAlign: 'center' }}>
              <h1
                className="active-title"
                style={{
                  fontSize: '32px',
                  fontWeight: 800,
                  letterSpacing: '0.45em',
                  margin: 0,
                  color: '#f4f4f5',
                  paddingLeft: '0.45em',
                }}
              >
                ARTON
              </h1>
              <p style={{ margin: '12px 0 0 0', fontSize: '13px', color: '#71717a', letterSpacing: '0.1em' }}>
                {activeConcept.category} · {activeConcept.titleZh} ({activeConcept.title})
              </p>
              <p style={{ margin: '6px 0 0 0', fontSize: '12px', color: '#52525b' }}>
                {activeConcept.description}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
