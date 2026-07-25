import React, { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * 方案 1: Bold Solid Architectural Monolith "A" (重型建筑金石 'A')
 * - 关联 ARTON：直接提取品牌首字母 'A' 打造重型 3D 实体切角金石
 * - 视觉量感：放弃纤细画线，采用粗犷实心块面 (Solid Filled) 与负空间切割
 * - 动效：块面跌落组装 + 柔和金石阴影光泽
 */
export const Solution1MonoLine: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.monolith-block', { scaleY: 0, opacity: 0, transformOrigin: 'bottom center' });
      gsap.set('.monolith-core', { scale: 0, opacity: 0, transformOrigin: 'center center' });
      gsap.set('.arton-text-bold-1', { opacity: 0, y: 12, filter: 'blur(8px)' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.5 });

      // 1. 重型 实体 A 块面向下坠落组装
      tl.to('.monolith-block', {
        scaleY: 1,
        opacity: 1,
        duration: 1.2,
        ease: 'power4.out',
        stagger: 0.15,
      })
      // 2. 负空间核心三角形弹回
      .to('.monolith-core', {
        scale: 1,
        opacity: 1,
        duration: 0.8,
        ease: 'back.out(1.8)',
      }, '-=0.6')
      // 3. ARTON 文字强力展现
      .to('.arton-text-bold-1', {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        duration: 1.0,
        ease: 'power2.out',
      }, '-=0.4')
      // 4. 光泽扫过
      .to('.monolith-wrapper-1', {
        filter: 'drop-shadow(0 0 16px rgba(255, 255, 255, 0.25))',
        duration: 1.2,
        yoyo: true,
        repeat: 1,
      })
      // 5. 退出
      .to('.monolith-block, .monolith-core, .arton-text-bold-1', {
        opacity: 0,
        duration: 0.8,
        ease: 'power2.in',
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
        backgroundColor: '#09090b',
        color: '#f4f4f5',
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
        {/* ARTON 专属重型金石 'A' 实体图标 */}
        <div className="monolith-wrapper-1" style={{ width: '100px', height: '100px', position: 'relative' }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
            {/* 左侧实心重柱 */}
            <polygon className="monolith-block" points="15,90 42,10 58,10 31,90" fill="#f4f4f5" />
            {/* 右侧实心重柱 */}
            <polygon className="monolith-block" points="69,90 42,10 58,10 85,90" fill="#f4f4f5" />
            {/* 实心重加固横梁 */}
            <polygon className="monolith-block" points="26,62 74,62 70,74 30,74" fill="#f4f4f5" />
            {/* 负空间切角核心 (内抠三角形) */}
            <polygon className="monolith-core" points="50,30 38,54 62,54" fill="#09090b" />
          </svg>
        </div>

        {/* 配合的重型 ARTON 品牌字体 */}
        <h1
          className="arton-text-bold-1"
          style={{
            fontSize: '32px',
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
