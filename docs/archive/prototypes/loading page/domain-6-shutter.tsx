import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

// ==========================================
// 6.1 HORIZONTAL DUAL SHUTTER
// ==========================================
export const Solution6_1_HorizontalDualShutter: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      gsap.set('.shutter-left-6-1', { xPercent: 0 });
      gsap.set('.shutter-right-6-1', { xPercent: 0 });
      gsap.set('.lock-block-6-1', { scale: 1, opacity: 1 });
      gsap.set('.arton-text-6-1', { opacity: 0, scale: 0.8, letterSpacing: '0.1em' });

      tl.to('.lock-block-6-1', { scale: 1.15, duration: 0.4, ease: 'back.out(2)' })
        .to('.lock-block-6-1', { opacity: 0, scale: 0, duration: 0.3, ease: 'power2.in' })
        .to('.shutter-left-6-1', { xPercent: -100, duration: 1.3, ease: 'power4.inOut' }, '-=0.1')
        .to('.shutter-right-6-1', { xPercent: 100, duration: 1.3, ease: 'power4.inOut' }, '<')
        .to('.arton-text-6-1', { opacity: 1, scale: 1, letterSpacing: '0.4em', duration: 1.0, ease: 'power3.out' }, '-=0.6')
        .to('.shutter-left-6-1, .shutter-right-6-1', { xPercent: 0, duration: 1.0, ease: 'power4.inOut' }, '+=0.8')
        .to('.lock-block-6-1', { scale: 1, opacity: 1, duration: 0.5 });
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100vh', backgroundColor: '#09090b', position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <h1 className="arton-text-6-1" style={{ fontSize: '56px', fontWeight: 900, letterSpacing: '0.4em', color: '#f4f4f5', margin: 0, paddingLeft: '0.4em' }}>ARTON</h1>
        <div style={{ fontSize: '12px', letterSpacing: '0.3em', color: '#a1a1aa', fontWeight: 600, marginTop: '8px' }}>KINETIC SHUTTER SYSTEM // 6.1</div>
      </div>

      <div className="shutter-left-6-1" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: '50vw', backgroundColor: '#121215', zIndex: 10, borderRight: '2px solid #27272a' }} />
      <div className="shutter-right-6-1" style={{ position: 'absolute', top: 0, bottom: 0, right: 0, width: '50vw', backgroundColor: '#121215', zIndex: 10, borderLeft: '2px solid #27272a' }} />

      <div className="lock-block-6-1" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '70px', height: '70px', backgroundColor: '#18181b', border: '2px solid #3f3f46', borderRadius: '12px', zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: '24px', fontWeight: 900, color: '#f4f4f5' }}>A</div>
      </div>
    </div>
  );
};
