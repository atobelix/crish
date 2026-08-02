import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

// ============================================================================
// SOLUTION 1.1: Center Hero Monolith ("Massing Assembly")
// Screen Layout: Center Hero (100vh Centered Massing)
// ============================================================================
export const Solution1_1_CenterHero: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.hero-curtain-1', { scaleY: 0, transformOrigin: 'top center' });
      gsap.set('.block-slab-left-1', { y: -140, opacity: 0 });
      gsap.set('.block-slab-right-1', { y: 140, opacity: 0 });
      gsap.set('.block-beam-1', { scaleX: 0, transformOrigin: 'center center' });
      gsap.set('.negative-core-1', { scale: 0, transformOrigin: 'center center' });
      gsap.set('.kinetic-title-1', { y: 30, opacity: 0, letterSpacing: '0.1em' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      // 1. Guided Entrance: Dark backdrop drop
      tl.to('.hero-curtain-1', { scaleY: 1, duration: 0.6, ease: 'power3.inOut' })
      // 2. Solid Block Motion: Heavy slabs crash into center stage
      .to('.block-slab-left-1', { y: 0, opacity: 1, duration: 0.8, ease: 'power4.out' }, '+=0.1')
      .to('.block-slab-right-1', { y: 0, opacity: 1, duration: 0.8, ease: 'power4.out' }, '-=0.6')
      .to('.block-beam-1', { scaleX: 1, duration: 0.7, ease: 'expo.out' }, '-=0.4')
      // 3. Bold Icon Motion: Negative space cut-out punch
      .to('.negative-core-1', { scale: 1, duration: 0.6, ease: 'back.out(2)' }, '-=0.2')
      // 4. Kinetic Typography: Tracking expansion reveal
      .to('.kinetic-title-1', {
        opacity: 1,
        y: 0,
        letterSpacing: '0.45em',
        duration: 0.9,
        ease: 'power3.out',
      }, '-=0.3')
      // Shear pulse
      .to('.block-slab-left-1', { x: -8, duration: 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '+=0.3')
      .to('.block-slab-right-1', { x: 8, duration: 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '-=1.0')
      // Outro
      .to('.block-slab-left-1, .block-slab-right-1, .block-beam-1, .negative-core-1, .kinetic-title-1', {
        opacity: 0,
        y: (i) => (i % 2 === 0 ? -40 : 40),
        duration: 0.7,
        ease: 'power2.in',
      }, '+=1.0')
      .to('.hero-curtain-1', { scaleY: 0, transformOrigin: 'bottom center', duration: 0.6, ease: 'power3.inOut' }, '-=0.3');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#050507',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div className="hero-curtain-1" style={{ position: 'absolute', inset: 0, backgroundColor: '#09090b' }} />

      <div style={{ position: 'relative', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '36px' }}>
        <div style={{ width: '180px', height: '180px', position: 'relative' }}>
          <svg viewBox="0 0 180 180" style={{ width: '100%', height: '100%' }}>
            <polygon className="block-slab-left-1" points="25,160 75,20 100,20 50,160" fill="#f4f4f5" />
            <polygon className="block-slab-right-1" points="155,160 105,20 80,20 130,160" fill="#e4e4e7" />
            <polygon className="block-beam-1" points="40,110 140,110 132,132 48,132" fill="#d4d4d8" />
            <polygon className="negative-core-1" points="90,52 68,96 112,96" fill="#09090b" />
          </svg>
        </div>

        <div style={{ textAlign: 'center' }}>
          <h1 className="kinetic-title-1" style={{ fontSize: '36px', fontWeight: 900, color: '#f4f4f5', margin: 0, textTransform: 'uppercase' }}>
            ARTON
          </h1>
          <div className="kinetic-title-1" style={{ fontSize: '11px', fontWeight: 700, color: '#71717a', marginTop: '8px', letterSpacing: '0.3em' }}>
            1.1 CENTER HERO MONOLITH
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 1.2: Left Architectural Column Monolith ("Columnar Shift")
// Screen Layout: Left Architectural Column (38% Left Pillar / 62% Viewport)
// ============================================================================
export const Solution1_2_LeftColumn: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.left-pillar-2', { xPercent: -100 });
      gsap.set('.pillar-block-1', { y: -80, opacity: 0 });
      gsap.set('.pillar-block-2', { y: 80, opacity: 0 });
      gsap.set('.notch-cut-2', { scaleX: 0, transformOrigin: 'left center' });
      gsap.set('.kinetic-letter-2', { x: 60, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      // 1. Guided Entrance: Left architectural vault door slides in
      tl.to('.left-pillar-2', { xPercent: 0, duration: 0.8, ease: 'power4.out' })
      // 2. Solid Block Motion: Staggered columnar blocks slide inside left pillar
      .to('.pillar-block-1', { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out' }, '-=0.3')
      .to('.pillar-block-2', { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out' }, '-=0.5')
      // 3. Bold Icon Motion: Notch block extends across pillar boundary
      .to('.notch-cut-2', { scaleX: 1, duration: 0.6, ease: 'expo.out' }, '-=0.3')
      // 4. Kinetic Typography: Letters enter horizontally from right void
      .to('.kinetic-letter-2', {
        x: 0,
        opacity: 1,
        duration: 0.6,
        stagger: 0.1,
        ease: 'power3.out',
      }, '-=0.4')
      // Reciprocating block shift
      .to('.pillar-block-1', { y: 20, duration: 0.8, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '+=0.2')
      .to('.pillar-block-2', { y: -20, duration: 0.8, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '-=1.6')
      // Outro
      .to('.kinetic-letter-2', { opacity: 0, x: -40, stagger: 0.05, duration: 0.5, ease: 'power2.in' }, '+=1.0')
      .to('.notch-cut-2', { scaleX: 0, duration: 0.4, ease: 'power2.in' }, '-=0.3')
      .to('.left-pillar-2', { xPercent: -100, duration: 0.7, ease: 'power4.in' }, '-=0.2');
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
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      {/* 38% Left Architectural Column */}
      <div
        className="left-pillar-2"
        style={{
          width: '38%',
          height: '100%',
          backgroundColor: '#121215',
          borderRight: '2px solid #27272a',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '24px',
          boxShadow: '20px 0 50px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ width: '120px', height: '240px', position: 'relative' }}>
          <svg viewBox="0 0 120 240" style={{ width: '100%', height: '100%' }}>
            <rect className="pillar-block-1" x="20" y="20" width="80" height="90" fill="#f4f4f5" rx="2" />
            <rect className="pillar-block-2" x="20" y="130" width="80" height="90" fill="#27272a" rx="2" />
            {/* Notch Icon cut out */}
            <path className="notch-cut-2" d="M 0 100 L 100 100 L 80 140 L 0 140 Z" fill="#e4e4e7" />
          </svg>
        </div>
      </div>

      {/* 62% Main Viewport */}
      <div style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: '80px' }}>
        <div style={{ display: 'flex', gap: '20px' }}>
          {['A', 'R', 'T', 'O', 'N'].map((char, index) => (
            <span
              key={index}
              className="kinetic-letter-2"
              style={{
                fontSize: '84px',
                fontWeight: 900,
                color: '#f4f4f5',
                display: 'inline-block',
              }}
            >
              {char}
            </span>
          ))}
        </div>
        <p className="kinetic-letter-2" style={{ color: '#71717a', fontSize: '13px', fontWeight: 700, letterSpacing: '0.4em', marginTop: '16px' }}>
          1.2 LEFT ARCHITECTURAL COLUMN
        </p>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 1.3: Bottom Left Dock Monolith ("Foundational Base")
// Screen Layout: Bottom Left Dock Card (Floating Monolith Box)
// ============================================================================
export const Solution1_3_BottomLeftDock: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.dock-card-3', { y: 220, opacity: 0 });
      gsap.set('.matrix-block-1', { x: -80, opacity: 0 });
      gsap.set('.matrix-block-2', { x: 80, opacity: 0 });
      gsap.set('.dock-stamp-3', { scale: 0, rotate: -45 });
      gsap.set('.dock-label-3', { y: 20, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      // 1. Guided Entrance: Dock rises up from floor
      tl.to('.dock-card-3', { y: 0, opacity: 1, duration: 0.8, ease: 'power4.out' })
      // 2. Solid Block Motion: Accordion block matrices slide horizontally
      .to('.matrix-block-1', { x: 0, opacity: 1, duration: 0.6, ease: 'power3.out' }, '-=0.3')
      .to('.matrix-block-2', { x: 0, opacity: 1, duration: 0.6, ease: 'power3.out' }, '-=0.4')
      // 3. Bold Icon Motion: Solid stamp block flips & snaps
      .to('.dock-stamp-3', { scale: 1, rotate: 0, duration: 0.7, ease: 'back.out(1.8)' }, '-=0.2')
      // 4. Kinetic Typography: Text unmasks inside dock header
      .to('.dock-label-3', { y: 0, opacity: 1, duration: 0.6, ease: 'power2.out' }, '-=0.3')
      // Horizontal pulse shift
      .to('.matrix-block-1', { x: 12, duration: 0.6, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '+=0.4')
      .to('.matrix-block-2', { x: -12, duration: 0.6, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '-=1.2')
      // Outro
      .to('.dock-stamp-3, .dock-label-3, .matrix-block-1, .matrix-block-2', { opacity: 0, duration: 0.5 }, '+=1.0')
      .to('.dock-card-3', { y: 220, opacity: 0, duration: 0.7, ease: 'power4.in' }, '-=0.2');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#070709',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'radial-gradient(#18181b 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          opacity: 0.4,
        }}
      />

      <div
        className="dock-card-3"
        style={{
          position: 'absolute',
          bottom: '48px',
          left: '48px',
          width: '520px',
          height: '240px',
          backgroundColor: '#121216',
          border: '2px solid #27272a',
          borderRadius: '12px',
          boxShadow: '0 30px 60px rgba(0,0,0,0.85)',
          display: 'flex',
          alignItems: 'center',
          padding: '32px',
          gap: '32px',
        }}
      >
        <div style={{ width: '130px', height: '130px', position: 'relative', flexShrink: 0 }}>
          <svg viewBox="0 0 130 130" style={{ width: '100%', height: '100%' }}>
            <rect className="matrix-block-1" x="10" y="10" width="52" height="52" fill="#f4f4f5" rx="4" />
            <rect className="matrix-block-2" x="68" y="10" width="52" height="52" fill="#3f3f46" rx="4" />
            <polygon className="dock-stamp-3" points="10,68 120,68 65,120" fill="#e4e4e7" />
          </svg>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <h2 className="dock-label-3" style={{ fontSize: '32px', fontWeight: 900, color: '#f4f4f5', margin: 0, letterSpacing: '0.25em' }}>
            ARTON
          </h2>
          <span className="dock-label-3" style={{ fontSize: '11px', fontWeight: 700, color: '#71717a', letterSpacing: '0.2em' }}>
            1.3 BOTTOM LEFT DOCK MONOLITH
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 1.4: Top Bar Monolith / Cantilever Beam ("Overhead Beam")
// Screen Layout: Top Bar Monolith Header (Top Structural Beam)
// ============================================================================
export const Solution1_4_TopBarBeam: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.top-beam-4', { yPercent: -100 });
      gsap.set('.beam-tooth-4', { scaleY: 0, transformOrigin: 'top center' });
      gsap.set('.cantilever-mark-4', { y: -50, opacity: 0 });
      gsap.set('.kinetic-text-4', { x: -100, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.top-beam-4', { yPercent: 0, duration: 0.7, ease: 'power4.out' })
      .to('.beam-tooth-4', { scaleY: 1, duration: 0.5, stagger: 0.1, ease: 'power3.out' }, '-=0.2')
      .to('.cantilever-mark-4', { y: 0, opacity: 1, duration: 0.6, ease: 'back.out(1.5)' }, '-=0.3')
      .to('.kinetic-text-4', { x: 0, opacity: 1, duration: 0.8, ease: 'power3.out' }, '-=0.4')
      .to('.beam-tooth-4', { scaleY: 0.6, duration: 0.5, yoyo: true, repeat: 1, stagger: 0.08, ease: 'sine.inOut' }, '+=0.3')
      .to('.kinetic-text-4, .cantilever-mark-4', { opacity: 0, y: -30, duration: 0.5 }, '+=1.0')
      .to('.beam-tooth-4', { scaleY: 0, duration: 0.4, stagger: 0.05, ease: 'power2.in' }, '-=0.3')
      .to('.top-beam-4', { yPercent: -100, duration: 0.7, ease: 'power4.in' }, '-=0.2');
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
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        className="top-beam-4"
        style={{
          width: '100%',
          height: '220px',
          backgroundColor: '#151518',
          borderBottom: '3px solid #27272a',
          boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
          position: 'relative',
          padding: '32px 64px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '40px' }}>
          <div style={{ width: '100px', height: '100px', position: 'relative' }}>
            <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%' }}>
              <polygon className="cantilever-mark-4" points="10,10 90,10 50,90" fill="#f4f4f5" />
              <polygon className="cantilever-mark-4" points="30,10 70,10 50,50" fill="#151518" />
            </svg>
          </div>

          <div>
            <h1 className="kinetic-text-4" style={{ fontSize: '40px', fontWeight: 900, color: '#f4f4f5', margin: 0, letterSpacing: '0.3em' }}>
              ARTON
            </h1>
            <span className="kinetic-text-4" style={{ color: '#71717a', fontSize: '11px', fontWeight: 700, letterSpacing: '0.35em' }}>
              1.4 TOP BAR MONOLITH BEAM
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '16px', position: 'absolute', bottom: '-40px', right: '64px' }}>
          {[80, 110, 60, 95].map((h, i) => (
            <div
              key={i}
              className="beam-tooth-4"
              style={{
                width: '36px',
                height: `${h}px`,
                backgroundColor: i % 2 === 0 ? '#f4f4f5' : '#3f3f46',
                borderRadius: '0 0 4px 4px',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 1.5: Floating Dark Card / Elevated Slab Monolith ("Monolithic Void")
// Screen Layout: Floating Dark Card (Centered Elevated Monolith Slab)
// ============================================================================
export const Solution1_5_FloatingDarkCard: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.elevated-card-5', { scale: 0.85, opacity: 0 });
      gsap.set('.quad-block-top-left', { x: -60, y: -60 });
      gsap.set('.quad-block-top-right', { x: 60, y: -60 });
      gsap.set('.quad-block-bottom-left', { x: -60, y: 60 });
      gsap.set('.quad-block-bottom-right', { x: 60, y: 60 });
      gsap.set('.void-icon-5', { scale: 0, opacity: 0 });
      gsap.set('.kinetic-footer-5', { y: 20, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.elevated-card-5', { scale: 1, opacity: 1, duration: 0.8, ease: 'power3.out' })
      .to('.quad-block-top-left, .quad-block-top-right, .quad-block-bottom-left, .quad-block-bottom-right', {
        x: 0,
        y: 0,
        duration: 0.7,
        ease: 'expo.out',
        stagger: 0.08,
      }, '-=0.3')
      .to('.void-icon-5', { scale: 1, opacity: 1, duration: 0.6, ease: 'back.out(2)' }, '-=0.2')
      .to('.kinetic-footer-5', { y: 0, opacity: 1, duration: 0.6, ease: 'power2.out' }, '-=0.3')
      .to('.quad-block-top-left', { x: -8, y: -8, duration: 0.6, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '+=0.4')
      .to('.quad-block-bottom-right', { x: 8, y: 8, duration: 0.6, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '-=1.2')
      .to('.void-icon-5, .kinetic-footer-5', { opacity: 0, duration: 0.4 }, '+=1.0')
      .to('.elevated-card-5', { scale: 0.85, opacity: 0, duration: 0.6, ease: 'power3.in' }, '-=0.2');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#050507',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        className="elevated-card-5"
        style={{
          width: '640px',
          height: '420px',
          backgroundColor: '#0e0e12',
          border: '2px solid #27272a',
          borderRadius: '16px',
          boxShadow: '0 40px 90px rgba(0,0,0,0.9)',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '32px',
          padding: '40px',
        }}
      >
        <div style={{ width: '160px', height: '160px', position: 'relative' }}>
          <svg viewBox="0 0 160 160" style={{ width: '100%', height: '100%' }}>
            <rect className="quad-block-top-left" x="10" y="10" width="65" height="65" fill="#f4f4f5" rx="4" />
            <rect className="quad-block-top-right" x="85" y="10" width="65" height="65" fill="#d4d4d8" rx="4" />
            <rect className="quad-block-bottom-left" x="10" y="85" width="65" height="65" fill="#71717a" rx="4" />
            <rect className="quad-block-bottom-right" x="85" y="85" width="65" height="65" fill="#27272a" rx="4" />
            <circle className="void-icon-5" cx="80" cy="80" r="32" fill="#0e0e12" />
            <polygon className="void-icon-5" points="80,58 64,92 96,92" fill="#f4f4f5" />
          </svg>
        </div>

        <div style={{ textAlign: 'center' }}>
          <h2 className="kinetic-footer-5" style={{ fontSize: '32px', fontWeight: 900, color: '#f4f4f5', margin: 0, letterSpacing: '0.4em' }}>
            ARTON
          </h2>
          <span className="kinetic-footer-5" style={{ fontSize: '11px', fontWeight: 700, color: '#71717a', marginTop: '6px', display: 'block', letterSpacing: '0.25em' }}>
            1.5 FLOATING DARK CARD MONOLITH
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 1.6: Diagonal Split Monolith ("Shear Block")
// Screen Layout: Diagonal Split Screen (45° Monolith Wedge)
// ============================================================================
export const Solution1_6_DiagonalSplit: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.diagonal-wedge-6', { xPercent: -100, yPercent: -100 });
      gsap.set('.shear-half-left-6', { x: -100, opacity: 0 });
      gsap.set('.shear-half-right-6', { x: 100, opacity: 0 });
      gsap.set('.kinetic-diag-text-6', { y: 40, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.diagonal-wedge-6', { xPercent: 0, yPercent: 0, duration: 0.9, ease: 'power4.out' })
      .to('.shear-half-left-6', { x: 0, opacity: 1, duration: 0.7, ease: 'expo.out' }, '-=0.3')
      .to('.shear-half-right-6', { x: 0, opacity: 1, duration: 0.7, ease: 'expo.out' }, '-=0.5')
      .to('.kinetic-diag-text-6', { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out' }, '-=0.2')
      .to('.shear-half-left-6', { x: -15, duration: 0.6, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '+=0.3')
      .to('.shear-half-right-6', { x: 15, duration: 0.6, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '-=1.2')
      .to('.kinetic-diag-text-6, .shear-half-left-6, .shear-half-right-6', { opacity: 0, duration: 0.5 }, '+=1.0')
      .to('.diagonal-wedge-6', { xPercent: 100, yPercent: 100, duration: 0.8, ease: 'power4.in' }, '-=0.2');
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
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        className="diagonal-wedge-6"
        style={{
          position: 'absolute',
          inset: '-20%',
          backgroundColor: '#18181c',
          clipPath: 'polygon(0 0, 100% 40%, 100% 100%, 0 60%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '32px' }}>
          <div style={{ width: '160px', height: '160px', position: 'relative' }}>
            <svg viewBox="0 0 160 160" style={{ width: '100%', height: '100%' }}>
              <polygon className="shear-half-left-6" points="20,140 75,20 75,140" fill="#f4f4f5" />
              <polygon className="shear-half-right-6" points="140,140 85,20 85,140" fill="#71717a" />
            </svg>
          </div>

          <div style={{ textAlign: 'center' }}>
            <h1 className="kinetic-diag-text-6" style={{ fontSize: '38px', fontWeight: 900, color: '#f4f4f5', margin: 0, letterSpacing: '0.4em' }}>
              ARTON
            </h1>
            <span className="kinetic-diag-text-6" style={{ fontSize: '11px', fontWeight: 700, color: '#a1a1aa', letterSpacing: '0.3em', marginTop: '6px', display: 'block' }}>
              1.6 DIAGONAL SPLIT MONOLITH
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 1.7: Triple Column Monolith ("Trilith Arch")
// Screen Layout: Triple Column (3 Equal Vertical Monolithic Pillars)
// ============================================================================
export const Solution1_7_TripleColumn: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.trilith-col-1', { yPercent: -100 });
      gsap.set('.trilith-col-2', { yPercent: 100 });
      gsap.set('.trilith-col-3', { yPercent: -100 });
      gsap.set('.trilith-slab-7', { scaleY: 0, transformOrigin: 'center center' });
      gsap.set('.kinetic-letter-7', { scale: 0, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.trilith-col-1', { yPercent: 0, duration: 0.8, ease: 'power4.out' })
      .to('.trilith-col-2', { yPercent: 0, duration: 0.8, ease: 'power4.out' }, '-=0.6')
      .to('.trilith-col-3', { yPercent: 0, duration: 0.8, ease: 'power4.out' }, '-=0.6')
      .to('.trilith-slab-7', { scaleY: 1, duration: 0.6, stagger: 0.15, ease: 'expo.out' }, '-=0.2')
      .to('.kinetic-letter-7', { scale: 1, opacity: 1, duration: 0.5, stagger: 0.1, ease: 'back.out(2)' }, '-=0.3')
      .to('.trilith-col-2', { y: -30, duration: 0.7, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '+=0.3')
      .to('.kinetic-letter-7', { scale: 0, opacity: 0, duration: 0.4 }, '+=1.0')
      .to('.trilith-col-1', { yPercent: 100, duration: 0.7, ease: 'power4.in' }, '-=0.2')
      .to('.trilith-col-2', { yPercent: -100, duration: 0.7, ease: 'power4.in' }, '-=0.6')
      .to('.trilith-col-3', { yPercent: 100, duration: 0.7, ease: 'power4.in' }, '-=0.6');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#050507',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        className="trilith-col-1"
        style={{
          flex: 1,
          height: '100%',
          backgroundColor: '#0d0d10',
          borderRight: '1px solid #27272a',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '32px',
        }}
      >
        <div className="trilith-slab-7" style={{ width: '80px', height: '140px', backgroundColor: '#f4f4f5', borderRadius: '4px' }} />
        <span className="kinetic-letter-7" style={{ fontSize: '48px', fontWeight: 900, color: '#f4f4f5' }}>A</span>
      </div>

      <div
        className="trilith-col-2"
        style={{
          flex: 1,
          height: '100%',
          backgroundColor: '#141418',
          borderRight: '1px solid #27272a',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '32px',
        }}
      >
        <div className="trilith-slab-7" style={{ width: '80px', height: '180px', backgroundColor: '#71717a', borderRadius: '4px' }} />
        <span className="kinetic-letter-7" style={{ fontSize: '48px', fontWeight: 900, color: '#f4f4f5' }}>R T</span>
      </div>

      <div
        className="trilith-col-3"
        style={{
          flex: 1,
          height: '100%',
          backgroundColor: '#1b1b22',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '32px',
        }}
      >
        <div className="trilith-slab-7" style={{ width: '80px', height: '120px', backgroundColor: '#e4e4e7', borderRadius: '4px' }} />
        <span className="kinetic-letter-7" style={{ fontSize: '48px', fontWeight: 900, color: '#f4f4f5' }}>O N</span>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 1.8: Asymmetric Right Monolith / Portal Wall ("Architectural Gate")
// Screen Layout: Asymmetric Right (35% Negative Void / 65% Portal Wall)
// ============================================================================
export const Solution1_8_AsymmetricRightPortal: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.portal-wall-8', { xPercent: 100 });
      gsap.set('.gate-door-1', { scaleX: 0, transformOrigin: 'left center' });
      gsap.set('.gate-door-2', { scaleX: 0, transformOrigin: 'right center' });
      gsap.set('.portal-mark-8', { rotate: -90, opacity: 0 });
      gsap.set('.left-kinetic-text-8', { y: 60, opacity: 0 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.portal-wall-8', { xPercent: 0, duration: 0.9, ease: 'power4.out' })
      .to('.gate-door-1, .gate-door-2', { scaleX: 1, duration: 0.6, stagger: 0.15, ease: 'expo.out' }, '-=0.3')
      .to('.portal-mark-8', { rotate: 0, opacity: 1, duration: 0.7, ease: 'back.out(1.8)' }, '-=0.2')
      .to('.left-kinetic-text-8', { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out' }, '-=0.4')
      .to('.gate-door-1', { scaleX: 0.8, duration: 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut' }, '+=0.4')
      .to('.left-kinetic-text-8, .portal-mark-8', { opacity: 0, y: -40, duration: 0.5 }, '+=1.0')
      .to('.portal-wall-8', { xPercent: 100, duration: 0.8, ease: 'power4.in' }, '-=0.2');
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
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div style={{ width: '35%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingLeft: '64px' }}>
        <h1 className="left-kinetic-text-8" style={{ fontSize: '56px', fontWeight: 900, color: '#f4f4f5', margin: 0, letterSpacing: '0.2em', lineHeight: 1.1 }}>
          A<br />R<br />T<br />O<br />N
        </h1>
        <p className="left-kinetic-text-8" style={{ color: '#71717a', fontSize: '11px', fontWeight: 700, letterSpacing: '0.3em', marginTop: '24px' }}>
          1.8 ASYMMETRIC PORTAL
        </p>
      </div>

      <div
        className="portal-wall-8"
        style={{
          width: '65%',
          height: '100%',
          backgroundColor: '#121216',
          borderLeft: '3px solid #27272a',
          boxShadow: '-30px 0 70px rgba(0,0,0,0.85)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '64px',
          position: 'relative',
        }}
      >
        <div style={{ width: '220px', height: '220px', position: 'relative' }}>
          <svg viewBox="0 0 220 220" style={{ width: '100%', height: '100%' }}>
            <rect className="gate-door-1" x="10" y="10" width="200" height="90" fill="#f4f4f5" rx="4" />
            <rect className="gate-door-2" x="10" y="120" width="200" height="90" fill="#27272a" rx="4" />
            <polygon className="portal-mark-8" points="110,30 50,150 170,150" fill="#09090b" />
          </svg>
        </div>
      </div>
    </div>
  );
};
