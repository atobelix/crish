import React, { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * 方案 5: Kinetic Debossed Letterpress Monolith (阴刻金石 字形压印)
 * - 关联 ARTON：将 ARTON 全称与 'A' 徽记以金石阴刻 (Debossed Letterpress) 形式雕刻在重型黑曜石色块上
 * - 视觉量感：重型实心金石块面与触感阴影，完全摒弃细线条
 * - 动效：光束扫过阴刻雕槽，呈现极具品质感的质地起伏
 */
export const Solution5FluidRibbon: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.deboss-slab', { scale: 0.88, opacity: 0 });
      gsap.set('.deboss-light-sweep', { x: '-100%' });
      gsap.set('.arton-text-bold-5', { opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.5 });

      // 1. 重型黑曜石色块压印下沉
      tl.to('.deboss-slab', {
        scale: 1.0,
        opacity: 1,
        duration: 1.4,
        ease: 'power3.out',
      })
      // 2. 光线从阴刻雕槽中划过
      .to('.deboss-light-sweep', {
        x: '100%',
        duration: 1.8,
        ease: 'sine.inOut',
      }, '-=0.6')
      // 3. 压印文字清晰浮现
      .to('.arton-text-bold-5', {
        opacity: 1,
        duration: 1.0,
      }, '-=1.2')
      // 4. 重置
      .to('.deboss-slab, .arton-text-bold-5', {
        opacity: 0,
        duration: 0.8,
      }, '+=1.2');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#08080a',
        color: '#ffffff',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Inter, system-ui, sans-serif',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '36px' }}>
        {/* ARTON 专属重型黑曜石阴刻色块 (Debossed Monolith) */}
        <div
          className="deboss-slab"
          style={{
            position: 'relative',
            width: '260px',
            height: '140px',
            backgroundColor: '#121215',
            borderRadius: '16px',
            boxShadow: 'inset 0 4px 12px rgba(0,0,0,0.9), inset 0 -2px 4px rgba(255,255,255,0.08), 0 16px 32px rgba(0,0,0,0.6)',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '16px',
            overflow: 'hidden',
          }}
        >
          {/* 扫过雕槽的阴刻光影 */}
          <div
            className="deboss-light-sweep"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.12) 50%, transparent 100%)',
              pointerEvents: 'none',
            }}
          />

          {/* 阴刻 A 徽标 */}
          <div style={{ width: '48px', height: '48px' }}>
            <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
              <polygon points="50,15 85,85 15,85" fill="#f4f4f5" />
              <polygon points="50,40 68,75 32,75" fill="#121215" />
            </svg>
          </div>

          {/* 阴刻 ARTON 重型字形 */}
          <h1
            className="arton-text-bold-5"
            style={{
              fontSize: '24px',
              fontWeight: 900,
              letterSpacing: '0.4em',
              margin: 0,
              color: '#f4f4f5',
              paddingLeft: '0.4em',
              textShadow: '0 2px 4px rgba(0, 0, 0, 0.9), 0 -1px 1px rgba(255, 255, 255, 0.2)',
            }}
          >
            ARTON
          </h1>
        </div>
      </div>
    </div>
  );
};
