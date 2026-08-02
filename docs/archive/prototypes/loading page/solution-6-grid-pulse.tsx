import React, { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * 方案 6: Deconstructed Modular Quadrants "A" Assembly (模块化 2x2 ARTON 品牌印记)
 * - 关联 ARTON：将 ARTON 首字母 'A' 拆解为 4 个重型实心模块，四角对冲拼合
 * - 视觉量感：纯实心色块 (Solid Block Tiles)，无细线条，构图扎实
 * - 动效：四角实心模块吸附对齐拼合
 */
export const Solution6GridPulse: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.mod-tile-tl', { x: -30, y: -30, opacity: 0 });
      gsap.set('.mod-tile-tr', { x: 30, y: -30, opacity: 0 });
      gsap.set('.mod-tile-bl', { x: -30, y: 30, opacity: 0 });
      gsap.set('.mod-tile-br', { x: 30, y: 30, opacity: 0 });
      gsap.set('.arton-text-bold-6', { opacity: 0, y: 10 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.5 });

      // 1. 4 个重型实心模块向中心吸附锁死
      tl.to('.mod-tile-tl, .mod-tile-tr, .mod-tile-bl, .mod-tile-br', {
        x: 0,
        y: 0,
        opacity: 1,
        duration: 1.2,
        ease: 'power4.out',
        stagger: 0.08,
      })
      // 2. ARTON 品牌字升起
      .to('.arton-text-bold-6', {
        opacity: 1,
        y: 0,
        duration: 1.0,
        ease: 'power2.out',
      }, '-=0.4')
      // 3. 组合块微晃动
      .to('.mod-grid-wrapper', {
        rotate: 45,
        duration: 2.0,
        ease: 'power3.inOut',
      }, '+=0.4')
      .to('.mod-grid-wrapper', {
        rotate: 0,
        duration: 2.0,
        ease: 'power3.inOut',
      })
      // 4. 重置
      .to('.mod-tile-tl, .mod-tile-tr, .mod-tile-bl, .mod-tile-br, .arton-text-bold-6', {
        opacity: 0,
        duration: 0.8,
      }, '+=1.0');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#0d0e10',
        color: '#f0f1f3',
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
        {/* ARTON 专属 2x2 模块化实心 'A' 拼合印记 */}
        <div className="mod-grid-wrapper" style={{ width: '100px', height: '100px', position: 'relative' }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
            {/* 左上模块 */}
            <polygon className="mod-tile-tl" points="10,10 46,10 46,46 10,46" fill="#f4f4f5" />
            <polygon className="mod-tile-tl" points="46,10 46,46 22,46" fill="#0d0e10" />

            {/* 右上模块 */}
            <polygon className="mod-tile-tr" points="54,10 90,10 90,46 54,46" fill="#f4f4f5" />
            <polygon className="mod-tile-tr" points="54,10 54,46 78,46" fill="#0d0e10" />

            {/* 左下模块 */}
            <polygon className="mod-tile-bl" points="10,54 46,54 46,90 10,90" fill="#f4f4f5" />

            {/* 右下模块 */}
            <polygon className="mod-tile-br" points="54,54 90,54 90,90 54,90" fill="#f4f4f5" />
          </svg>
        </div>

        {/* 配合的重型 ARTON 品牌字体 */}
        <h1
          className="arton-text-bold-6"
          style={{
            fontSize: '30px',
            fontWeight: 900,
            letterSpacing: '0.4em',
            margin: 0,
            color: '#f4f4f5',
            paddingLeft: '0.4em',
          }}
        >
          ARTON
        </h1>
      </div>
    </div>
  );
};
