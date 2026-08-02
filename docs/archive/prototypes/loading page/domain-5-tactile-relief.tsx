import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

// ============================================================================
// 5.1 SOLUTION: CENTERED OBSIDIAN SLAB
// ============================================================================
export const Solution5_1_ObsidianSlab: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.slab-51', { y: -70, opacity: 0, scale: 0.92 });
      gsap.set('.carved-a-51', { scale: 0.88, opacity: 0, y: -10 });
      gsap.set('.light-beam-51', { xPercent: -150 });
      gsap.set('.typo-letter-51', { y: 24, opacity: 0 });
      gsap.set('.slab-shadow-51', { scale: 0.7, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.0 });

      tl.to('.slab-shadow-51', { scale: 1, opacity: 0.8, duration: 1.2, ease: 'power3.out' }, 0)
        .to('.slab-51', { y: 0, opacity: 1, scale: 1, duration: 1.2, ease: 'power4.out' }, 0)
        .to('.carved-a-51', { scale: 1, opacity: 1, y: 0, duration: 0.9, ease: 'back.out(1.5)' }, '-=0.5')
        .to('.carved-a-51', { y: 4, duration: 0.4, ease: 'power2.inOut', yoyo: true, repeat: 1 })
        .to('.light-beam-51', { xPercent: 180, duration: 1.4, ease: 'power2.inOut' }, '-=0.6')
        .to('.typo-letter-51', { y: 0, opacity: 1, duration: 0.7, stagger: 0.08, ease: 'power3.out' }, '-=0.8')
        .to('.slab-51', {
          boxShadow: '0 50px 100px rgba(0,0,0,0.95), inset 0 2px 4px rgba(255,255,255,0.2)',
          duration: 1.2,
          yoyo: true,
          repeat: 1,
        })
        .to('.slab-51, .slab-shadow-51', { opacity: 0, y: 40, scale: 0.95, duration: 0.8, ease: 'power3.in' }, '+=1.0');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100vh', backgroundColor: '#07080a', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      <div className="slab-shadow-51" style={{ position: 'absolute', width: '460px', height: '100px', borderRadius: '50%', backgroundColor: 'rgba(0, 0, 0, 0.9)', filter: 'blur(32px)', transform: 'translateY(240px)' }} />

      <div
        className="slab-51"
        style={{
          width: '420px',
          height: '520px',
          backgroundColor: '#121419',
          borderRadius: '28px',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '48px 32px',
          boxShadow: '0 40px 90px rgba(0,0,0,0.95), inset 1px 1px 2px rgba(255,255,255,0.12), inset -2px -2px 6px rgba(0,0,0,0.9)',
          border: '1px solid rgba(255, 255, 255, 0.05)',
          overflow: 'hidden',
        }}
      >
        <div className="light-beam-51" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', background: 'linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.12) 50%, transparent 70%)', pointerEvents: 'none' }} />

        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#4a5264' }} />
          <span style={{ fontSize: '11px', letterSpacing: '0.3em', color: '#6c778e', fontWeight: 700, textTransform: 'uppercase' }}>Domain 5.1 • Slab Relief</span>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#4a5264' }} />
        </div>

        <div className="carved-a-51" style={{ width: '180px', height: '180px', borderRadius: '24px', backgroundColor: '#0a0b0e', boxShadow: 'inset 6px 6px 14px rgba(0,0,0,0.95), inset -4px -4px 10px rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg viewBox="0 0 100 100" style={{ width: '110px', height: '110px' }}>
            <polygon points="18,85 45,15 55,15 28,85" fill="#1e222b" stroke="#3a4150" strokeWidth="1.5" />
            <polygon points="72,85 45,15 55,15 82,85" fill="#1e222b" stroke="#3a4150" strokeWidth="1.5" />
            <polygon points="30,58 70,58 66,70 34,70" fill="#181b22" stroke="#4b5466" strokeWidth="1" />
            <polygon points="50,32 38,54 62,54" fill="#040507" />
          </svg>
        </div>

        <div style={{ display: 'flex', gap: '12px' }}>
          {['A', 'R', 'T', 'O', 'N'].map((char, index) => (
            <div key={index} style={{ width: '36px', height: '48px', backgroundColor: '#08090c', borderRadius: '8px', boxShadow: 'inset 3px 3px 6px #000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              <span className="typo-letter-51" style={{ color: '#e2e8f0', fontSize: '20px', fontWeight: 900 }}>{char}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
