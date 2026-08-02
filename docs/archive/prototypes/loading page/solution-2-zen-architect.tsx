import React, { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * 方案 2: The Interlocking "A-T" Monogram (双字重构 'A-T' 连体徽章)
 * - 关联 ARTON：直接提取 ARTON 品牌名中的 'A' 与 'T' 进行重型几何连体设计
 * - 视觉量感：重型实心笔画 (10px 粗线条与实心切角)，充满视觉张力
 * - 动效：A 与 T 的解构拼接与交织
 */
export const Solution2ZenArchitect: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.at-stem-a', { y: 20, opacity: 0 });
      gsap.set('.at-stem-t', { y: -20, opacity: 0 });
      gsap.set('.arton-text-bold-2', { opacity: 0, scale: 0.9 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.5 });

      // 1. A 主体与 T 横梁相对冲插锁死
      tl.to('.at-stem-a', {
        y: 0,
        opacity: 1,
        duration: 1.0,
        ease: 'power3.out',
      })
      .to('.at-stem-t', {
        y: 0,
        opacity: 1,
        duration: 1.0,
        ease: 'power3.out',
      }, '-=0.8')
      // 2. ARTON 品牌名渐现
      .to('.arton-text-bold-2', {
        opacity: 1,
        scale: 1.0,
        duration: 1.2,
        ease: 'power2.out',
      }, '-=0.4')
      // 3. 微旋转重组
      .to('.at-emblem-wrapper', {
        rotate: 90,
        duration: 2.5,
        ease: 'power3.inOut',
      }, '+=0.5')
      .to('.at-emblem-wrapper', {
        rotate: 0,
        duration: 2.5,
        ease: 'power3.inOut',
      })
      // 4. 重置
      .to('.at-stem-a, .at-stem-t, .arton-text-bold-2', {
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
        {/* ARTON 专属 'A-T' 连体重型徽章 */}
        <div className="at-emblem-wrapper" style={{ width: '110px', height: '110px', position: 'relative' }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
            {/* T 字顶端加粗重型横梁 */}
            <path className="at-stem-t" d="M 10 18 H 90 V 30 H 10 Z" fill="#f4f4f5" />

            {/* A 与 T 中轴合一的重型立体柱 */}
            <path className="at-stem-a" d="M 44 18 H 56 V 90 H 44 Z" fill="#f4f4f5" />

            {/* A 的左斜重切边 */}
            <path className="at-stem-a" d="M 50 20 L 15 88 H 29 L 50 48 Z" fill="#f4f4f5" />

            {/* A 的右斜重切边 */}
            <path className="at-stem-a" d="M 50 20 L 85 88 H 71 L 50 48 Z" fill="#f4f4f5" />

            {/* A 的下横加固块 */}
            <path className="at-stem-t" d="M 32 60 H 68 V 70 H 32 Z" fill="#09090b" />
            <path className="at-stem-t" d="M 36 62 H 64 V 68 H 36 Z" fill="#f4f4f5" />
          </svg>
        </div>

        {/* 配合的重型 ARTON 品牌字体 */}
        <h1
          className="arton-text-bold-2"
          style={{
            fontSize: '30px',
            fontWeight: 900,
            letterSpacing: '0.45em',
            margin: 0,
            color: '#f4f4f5',
            paddingLeft: '0.45em',
          }}
        >
          ARTON
        </h1>
      </div>
    </div>
  );
};
