import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

// ============================================================================
// 4.1 - GOLDEN RATIO ASYMMETRIC RIGHT
// ============================================================================
export const Solution4_1_GoldenRatio: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.g-left-slab', { yPercent: -100, opacity: 0 });
      gsap.set('.g-right-col', { yPercent: 100, opacity: 0 });
      gsap.set('.g-icon-part', { scale: 0, rotate: -45, transformOrigin: 'center center' });
      gsap.set('.g-typo-char', { x: -80, opacity: 0 });
      gsap.set('.g-block-pulse', { scaleY: 0, transformOrigin: 'bottom center' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.g-left-slab, .g-right-col', {
        yPercent: 0,
        opacity: 1,
        duration: 1.1,
        ease: 'power4.out',
        stagger: 0.15,
      })
      .to('.g-icon-part', {
        scale: 1,
        rotate: 0,
        duration: 0.9,
        ease: 'back.out(1.7)',
        stagger: 0.08,
      }, '-=0.4')
      .to('.g-typo-char', {
        x: 0,
        opacity: 1,
        duration: 0.7,
        ease: 'power3.out',
        stagger: 0.06,
      }, '-=0.5')
      .to('.g-block-pulse', {
        scaleY: 1,
        duration: 0.8,
        ease: 'expo.out',
        stagger: 0.1,
      }, '-=0.3')
      .to('.g-icon-wrapper', {
        rotate: 90,
        duration: 1.2,
        ease: 'power4.inOut',
      }, '+=0.4')
      .to('.g-block-pulse', {
        backgroundColor: '#f59e0b',
        duration: 0.6,
        stagger: 0.1,
      }, '-=0.8')
      .to('.g-left-slab, .g-right-col', {
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
        display: 'flex',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        className="g-left-slab"
        style={{
          width: '61.8%',
          height: '100%',
          backgroundColor: '#141417',
          borderRight: '12px solid #27272a',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '80px',
          boxSizing: 'border-box',
          position: 'relative',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ width: '24px', height: '24px', backgroundColor: '#f59e0b' }} />
          <span style={{ color: '#a1a1aa', fontWeight: 800, fontSize: '14px', textTransform: 'uppercase' }}>
            System Frame // Golden 61.8
          </span>
        </div>

        <div className="g-icon-wrapper" style={{ width: '180px', height: '180px', position: 'relative' }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
            <polygon className="g-icon-part" points="10,90 50,10 90,90 65,90 50,55 35,90" fill="#f4f4f5" />
            <rect className="g-icon-part" x="32" y="62" width="36" height="12" fill="#f59e0b" />
          </svg>
        </div>

        <div style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            {['A', 'R', 'T', 'O', 'N'].map((char, i) => (
              <span
                key={i}
                className="g-typo-char"
                style={{
                  fontSize: '96px',
                  fontWeight: 900,
                  color: '#ffffff',
                  lineHeight: 0.9,
                  letterSpacing: '-0.02em',
                }}
              >
                {char}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div
        className="g-right-col"
        style={{
          width: '38.2%',
          height: '100%',
          backgroundColor: '#1c1c21',
          padding: '60px 40px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="g-block-pulse" style={{ height: '80px', backgroundColor: '#27272a', width: '100%' }} />
          <div className="g-block-pulse" style={{ height: '160px', backgroundColor: '#3f3f46', width: '100%' }} />
          <div className="g-block-pulse" style={{ height: '60px', backgroundColor: '#27272a', width: '100%' }} />
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 4.2 - 4-RETICLE CORNER INSET
// ============================================================================
export const Solution4_2_ReticleCorner: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.ret-tl', { xPercent: -100, yPercent: -100 });
      gsap.set('.ret-tr', { xPercent: 100, yPercent: -100 });
      gsap.set('.ret-bl', { xPercent: -100, yPercent: 100 });
      gsap.set('.ret-br', { xPercent: 100, yPercent: 100 });
      gsap.set('.ret-center-stage', { scale: 0.7, opacity: 0 });
      gsap.set('.ret-emblem', { rotate: 0, scale: 0.8 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.ret-tl, .ret-tr, .ret-bl, .ret-br', {
        xPercent: 0,
        yPercent: 0,
        duration: 1.0,
        ease: 'power4.out',
        stagger: 0.08,
      })
      .to('.ret-center-stage', {
        scale: 1,
        opacity: 1,
        duration: 0.8,
        ease: 'expo.out',
      }, '-=0.4')
      .to('.ret-emblem', {
        rotate: 90,
        scale: 1,
        duration: 0.8,
        ease: 'power3.inOut',
      })
      .to('.ret-tl, .ret-tr, .ret-bl, .ret-br, .ret-center-stage', {
        opacity: 0,
        duration: 0.6,
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
        backgroundColor: '#0c0a09',
        position: 'relative',
        overflow: 'hidden',
        padding: '32px',
        boxSizing: 'border-box',
      }}
    >
      <div className="ret-tl" style={{ position: 'absolute', top: '32px', left: '32px', width: '260px', height: '220px', backgroundColor: '#1c1917', borderBottom: '16px solid #ef4444', borderRight: '16px solid #ef4444' }} />
      <div className="ret-tr" style={{ position: 'absolute', top: '32px', right: '32px', width: '320px', height: '180px', backgroundColor: '#292524', borderBottom: '16px solid #f5f5f4', borderLeft: '16px solid #f5f5f4' }} />
      <div className="ret-bl" style={{ position: 'absolute', bottom: '32px', left: '32px', width: '340px', height: '200px', backgroundColor: '#292524', borderTop: '16px solid #f5f5f4', borderRight: '16px solid #f5f5f4' }} />
      <div className="ret-br" style={{ position: 'absolute', bottom: '32px', right: '32px', width: '280px', height: '240px', backgroundColor: '#1c1917', borderTop: '16px solid #ef4444', borderLeft: '16px solid #ef4444' }} />

      <div className="ret-center-stage" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '32px' }}>
        <div className="ret-emblem" style={{ width: '160px', height: '160px' }}>
          <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
            <polygon points="50,5 95,50 50,95 5,50" fill="#ef4444" />
            <polygon points="50,22 78,50 50,78 22,50" fill="#0c0a09" />
            <polygon points="50,36 64,50 50,64 36,50" fill="#f5f5f4" />
          </svg>
        </div>
        <h1 style={{ fontSize: '64px', fontWeight: 900, color: '#f5f5f4', letterSpacing: '0.3em', margin: 0, paddingLeft: '0.3em' }}>ARTON</h1>
      </div>
    </div>
  );
};
