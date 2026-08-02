import React, { useEffect, useRef } from 'react';
import gsap from 'gsap';

/**
 * 方案 3: Swiss Style Ultra-Bold Block Unmasking (瑞士重型字形 遮罩解构)
 * - 关联 ARTON：直接使用黑体极简巨型 ARTON 全称作为主标志
 * - 视觉量感：超粗重字形 (font-weight: 900)，放弃细线，带来极强的视觉冲击力
 * - 动效：实心块面扫过与高对比度文字解构
 */
export const Solution3SwissTypo: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.swiss-letter', { y: 60, opacity: 0, filter: 'blur(10px)' });
      gsap.set('.solid-scan-bar', { scaleX: 0, transformOrigin: 'left center' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.5 });

      // 1. 实心重型 Scan Bar 扫过
      tl.to('.solid-scan-bar', {
        scaleX: 1,
        duration: 0.8,
        ease: 'power3.inOut',
      })
      // 2. 巨幅 ARTON 字母逐字强力升起
      .to('.swiss-letter', {
        y: 0,
        opacity: 1,
        filter: 'blur(0px)',
        duration: 0.8,
        ease: 'power4.out',
        stagger: 0.1,
      }, '-=0.4')
      .to('.solid-scan-bar', {
        scaleX: 0,
        transformOrigin: 'right center',
        duration: 0.6,
        ease: 'power3.inOut',
      })
      // 3. 字母反色与极简挤压
      .to('.swiss-letter', {
        letterSpacing: '0.15em',
        duration: 2.0,
        ease: 'sine.inOut',
      }, '+=0.5')
      .to('.swiss-letter', {
        opacity: 0,
        y: -40,
        duration: 0.8,
        stagger: 0.05,
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
        backgroundColor: '#050505',
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
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
        {/* 实心 Scan Bar 扫过光条 */}
        <div
          className="solid-scan-bar"
          style={{
            position: 'absolute',
            top: '50%',
            left: '-10%',
            width: '120%',
            height: '4px',
            backgroundColor: '#ffffff',
            zIndex: 10,
          }}
        />

        {/* 巨幅瑞士重型 ARTON 字形 */}
        <div style={{ display: 'flex', gap: '8px', overflow: 'hidden', padding: '10px' }}>
          {['A', 'R', 'T', 'O', 'N'].map((char, index) => (
            <span
              key={index}
              className="swiss-letter"
              style={{
                fontSize: '84px',
                fontWeight: 900,
                color: '#f4f4f5',
                display: 'inline-block',
                lineHeight: 1,
              }}
            >
              {char}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};
