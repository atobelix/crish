import React, { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * 方案 4: Minimalist Solid Geometric Emblem "The Prism Arch" (棱镜拱门 实体徽印)
 * - 关联 ARTON：提取 ARTON 的首字母 'A' 打造棱镜拱门实体徽印
 * - 视觉量感：放弃 0.75px 细线条，采用多层实心黑白对比色块与负空间
 * - 动效：多重实心色块层叠汇聚与平滑推远
 */
export const Solution4VectorBlueprint: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.prism-solid-outer', { scale: 0, opacity: 0, transformOrigin: 'center' });
      gsap.set('.prism-solid-inner', { scale: 0, opacity: 0, transformOrigin: 'center' });
      gsap.set('.arton-text-bold-4', { opacity: 0, y: 10 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.5 });

      // 1. 实心外层与内层拱门拼接
      tl.to('.prism-solid-outer', {
        scale: 1,
        opacity: 1,
        duration: 1.2,
        ease: 'back.out(1.5)',
      })
      .to('.prism-solid-inner', {
        scale: 1,
        opacity: 1,
        duration: 1.0,
        ease: 'power3.out',
      }, '-=0.6')
      // 2. ARTON 品牌字升起
      .to('.arton-text-bold-4', {
        opacity: 1,
        y: 0,
        duration: 1.0,
        ease: 'power2.out',
      }, '-=0.4')
      // 3. 实体微呼吸
      .to('.prism-wrapper-4', {
        scale: 1.06,
        duration: 1.5,
        yoyo: true,
        repeat: 1,
        ease: 'sine.inOut',
      })
      // 4. 退场
      .to('.prism-solid-outer, .prism-solid-inner, .arton-text-bold-4', {
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
        backgroundColor: '#0c0d0e',
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
        {/* ARTON 专属棱镜拱门实体徽印 */}
        <div className="prism-wrapper-4" style={{ width: '100px', height: '100px', position: 'relative' }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
            {/* 实心外层三角形徽章 (A 字廓形) */}
            <polygon className="prism-solid-outer" points="50,10 90,85 10,85" fill="#f4f4f5" />
            {/* 实心内扣 negative space 拱门 (抠出 A 内部) */}
            <polygon className="prism-solid-inner" points="50,34 72,76 28,76" fill="#0c0d0e" />
            {/* 实心加固中梁 */}
            <rect className="prism-solid-outer" x="32" y="58" width="36" height="10" fill="#f4f4f5" />
          </svg>
        </div>

        {/* 配合的重型 ARTON 品牌字体 */}
        <h1
          className="arton-text-bold-4"
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
