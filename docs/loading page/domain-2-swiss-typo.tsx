import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

// ============================================================================
// SOLUTION 2.1: Giant Swiss Headline Center (Monolithic Center Mask)
// ============================================================================
export const Domain2_1_GiantHeadline: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s21-curtain-top', { scaleY: 1, transformOrigin: 'top center' });
      gsap.set('.s21-curtain-bottom', { scaleY: 1, transformOrigin: 'bottom center' });
      gsap.set('.s21-letter', { y: 120, opacity: 0 });
      gsap.set('.s21-block-wipe', { scaleX: 0, transformOrigin: 'left center' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s21-curtain-top, .s21-curtain-bottom', {
        scaleY: 0.28,
        duration: 0.9,
        ease: 'power4.inOut',
      })
      .to('.s21-block-wipe', {
        scaleX: 1,
        duration: 0.6,
        ease: 'power3.inOut',
      })
      .to('.s21-letter', {
        y: 0,
        opacity: 1,
        duration: 0.8,
        stagger: 0.08,
        ease: 'power4.out',
      }, '-=0.2')
      .to('.s21-letter-box', {
        letterSpacing: '0.22em',
        duration: 1.8,
        ease: 'sine.inOut',
      }, '-=0.4')
      .to('.s21-block-wipe', {
        scaleX: 0,
        transformOrigin: 'right center',
        duration: 0.5,
        ease: 'power3.inOut',
      }, '-=1.4')
      .to('.s21-letter', {
        y: -100,
        opacity: 0,
        duration: 0.6,
        stagger: 0.04,
        ease: 'power3.in',
      }, '+=0.8')
      .to('.s21-curtain-top, .s21-curtain-bottom', {
        scaleY: 1,
        duration: 0.7,
        ease: 'power4.inOut',
      });
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#0A0A0C',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      <div className="s21-curtain-top" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '50%', backgroundColor: '#E60000', zIndex: 10 }} />
      <div className="s21-curtain-bottom" style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: '50%', backgroundColor: '#E60000', zIndex: 10 }} />

      <div style={{ position: 'relative', zIndex: 5, width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <div className="s21-block-wipe" style={{ position: 'absolute', width: '90%', height: '140px', backgroundColor: '#FFFFFF', zIndex: 15 }} />
        
        <div className="s21-letter-box" style={{ display: 'flex', gap: '16px', overflow: 'hidden', padding: '20px 0', letterSpacing: '-0.02em', transition: 'letter-spacing 0.1s' }}>
          {['A', 'R', 'T', 'O', 'N'].map((char, index) => (
            <span
              key={index}
              className="s21-letter"
              style={{
                fontSize: 'clamp(72px, 14vw, 160px)',
                fontWeight: 900,
                color: '#FFFFFF',
                display: 'inline-block',
                lineHeight: 1,
                fontFamily: 'Inter, system-ui, sans-serif',
                textTransform: 'uppercase',
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

// ============================================================================
// SOLUTION 2.2: Split Screen Half-and-Half (Dual Contrast Split Mask)
// ============================================================================
export const Domain2_2_SplitScreen: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s22-left-panel', { yPercent: -100 });
      gsap.set('.s22-right-panel', { yPercent: 100 });
      gsap.set('.s22-center-beam', { scaleY: 0, transformOrigin: 'center center' });
      gsap.set('.s22-top-half', { x: -140 });
      gsap.set('.s22-bottom-half', { x: 140 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s22-left-panel, .s22-right-panel', {
        yPercent: 0,
        duration: 0.9,
        ease: 'power4.inOut',
      })
      .to('.s22-center-beam', {
        scaleY: 1,
        duration: 0.5,
        ease: 'power3.out',
      })
      .to('.s22-top-half, .s22-bottom-half', {
        x: 0,
        duration: 0.8,
        ease: 'power4.out',
      })
      .to('.s22-center-beam', {
        backgroundColor: '#FFD600',
        duration: 0.4,
      })
      .to('.s22-top-half', { x: 140, opacity: 0, duration: 0.6, ease: 'power3.in' }, '+=1.0')
      .to('.s22-bottom-half', { x: -140, opacity: 0, duration: 0.6, ease: 'power3.in' }, '-=0.6')
      .to('.s22-left-panel', { yPercent: -100, duration: 0.7, ease: 'power4.inOut' })
      .to('.s22-right-panel', { yPercent: 100, duration: 0.7, ease: 'power4.inOut' }, '-=0.7');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#000000',
        position: 'relative',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div
        className="s22-left-panel"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '50%',
          height: '100%',
          backgroundColor: '#F4F4F0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          paddingRight: '10px',
          zIndex: 2,
        }}
      >
        <div className="s22-top-half" style={{ fontSize: 'clamp(80px, 16vw, 200px)', fontWeight: 900, color: '#0A0A0C', lineHeight: 1, fontFamily: 'Inter, sans-serif' }}>
          ART
        </div>
      </div>

      <div
        className="s22-right-panel"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: '50%',
          height: '100%',
          backgroundColor: '#0A0A0C',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-start',
          paddingLeft: '10px',
          zIndex: 2,
        }}
      >
        <div className="s22-bottom-half" style={{ fontSize: 'clamp(80px, 16vw, 200px)', fontWeight: 900, color: '#E60000', lineHeight: 1, fontFamily: 'Inter, sans-serif' }}>
          ON
        </div>
      </div>

      <div
        className="s22-center-beam"
        style={{
          position: 'absolute',
          top: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          width: '12px',
          height: '100%',
          backgroundColor: '#E60000',
          zIndex: 10,
        }}
      />
    </div>
  );
};

// ============================================================================
// SOLUTION 2.3: Top-Left Giant Monogram (Asymmetric Monogram Aperture)
// ============================================================================
export const Domain2_3_TopLeftMonogram: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s23-monogram-mask', { clipPath: 'polygon(0 0, 0 0, 0 100%, 0 100%)' });
      gsap.set('.s23-stem-letter', { x: -120, opacity: 0 });
      gsap.set('.s23-solid-wipe', { scaleX: 0, transformOrigin: 'left center' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s23-monogram-mask', {
        clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)',
        duration: 0.9,
        ease: 'power4.inOut',
      })
      .to('.s23-solid-wipe', {
        scaleX: 1,
        duration: 0.5,
        ease: 'power3.inOut',
      })
      .to('.s23-stem-letter', {
        x: 0,
        opacity: 1,
        duration: 0.7,
        stagger: 0.1,
        ease: 'power4.out',
      }, '-=0.2')
      .to('.s23-solid-wipe', {
        scaleX: 0,
        transformOrigin: 'right center',
        duration: 0.5,
        ease: 'power3.inOut',
      }, '-=0.6')
      .to('.s23-stem-letter', { x: 120, opacity: 0, duration: 0.5, stagger: 0.05, ease: 'power3.in' }, '+=1.0')
      .to('.s23-monogram-mask', { clipPath: 'polygon(0 0, 0 0, 0 100%, 0 100%)', duration: 0.7, ease: 'power4.inOut' });
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#0A0A0C',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '60px',
        boxSizing: 'border-box',
        userSelect: 'none',
      }}
    >
      <div className="s23-monogram-mask" style={{ display: 'flex', alignItems: 'baseline', gap: '20px' }}>
        <span
          style={{
            fontSize: 'clamp(180px, 32vw, 360px)',
            fontWeight: 900,
            color: '#E60000',
            lineHeight: 0.8,
            fontFamily: 'Inter, sans-serif',
          }}
        >
          A
        </span>
        <div style={{ display: 'flex', gap: '16px', position: 'relative', overflow: 'hidden', padding: '10px 0' }}>
          <div className="s23-solid-wipe" style={{ position: 'absolute', inset: 0, backgroundColor: '#FFFFFF', zIndex: 5 }} />
          {['R', 'T', 'O', 'N'].map((char, index) => (
            <span
              key={index}
              className="s23-stem-letter"
              style={{
                fontSize: 'clamp(72px, 12vw, 160px)',
                fontWeight: 900,
                color: '#FFFFFF',
                lineHeight: 0.9,
                fontFamily: 'Inter, sans-serif',
              }}
            >
              {char}
            </span>
          ))}
        </div>
      </div>

      <div style={{ alignSelf: 'flex-end', textAlign: 'right', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ height: '8px', width: '120px', backgroundColor: '#E60000', alignSelf: 'flex-end' }} />
        <span style={{ fontSize: '14px', fontWeight: 900, color: '#F4F4F0', letterSpacing: '0.15em' }}>
          SWISS MASK SYSTEM // 02.3
        </span>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 2.4: Corner Bracket Framed (Heavy Structural Frame Mask)
// ============================================================================
export const Domain2_4_CornerFrame: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s24-top-left', { x: -80, y: -80 });
      gsap.set('.s24-top-right', { x: 80, y: -80 });
      gsap.set('.s24-bot-left', { x: -80, y: 80 });
      gsap.set('.s24-bot-right', { x: 80, y: 80 });
      gsap.set('.s24-line-1', { x: -200, opacity: 0 });
      gsap.set('.s24-line-2', { x: 200, opacity: 0 });
      gsap.set('.s24-diag-wipe', { scaleX: 0, transformOrigin: 'left center' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s24-top-left, .s24-top-right, .s24-bot-left, .s24-bot-right', {
        x: 0,
        y: 0,
        duration: 0.8,
        ease: 'power4.out',
      })
      .to('.s24-diag-wipe', {
        scaleX: 1,
        duration: 0.5,
        ease: 'power3.inOut',
      })
      .to('.s24-line-1', { x: 0, opacity: 1, duration: 0.7, ease: 'power4.out' }, '-=0.2')
      .to('.s24-line-2', { x: 0, opacity: 1, duration: 0.7, ease: 'power4.out' }, '-=0.5')
      .to('.s24-diag-wipe', { scaleX: 0, transformOrigin: 'right center', duration: 0.5, ease: 'power3.inOut' })
      .to('.s24-line-1', { x: 200, opacity: 0, duration: 0.5, ease: 'power3.in' }, '+=1.0')
      .to('.s24-line-2', { x: -200, opacity: 0, duration: 0.5, ease: 'power3.in' }, '-=0.5')
      .to('.s24-top-left', { x: -80, y: -80, duration: 0.6, ease: 'power4.in' })
      .to('.s24-top-right', { x: 80, y: -80, duration: 0.6, ease: 'power4.in' }, '-=0.6')
      .to('.s24-bot-left', { x: -80, y: 80, duration: 0.6, ease: 'power4.in' }, '-=0.6')
      .to('.s24-bot-right', { x: 80, y: 80, duration: 0.6, ease: 'power4.in' }, '-=0.6');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#0A0A0C',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      <div className="s24-top-left" style={{ position: 'absolute', top: '40px', left: '40px', width: '120px', height: '120px', borderLeft: '24px solid #E60000', borderTop: '24px solid #E60000' }} />
      <div className="s24-top-right" style={{ position: 'absolute', top: '40px', right: '40px', width: '120px', height: '120px', borderRight: '24px solid #E60000', borderTop: '24px solid #E60000' }} />
      <div className="s24-bot-left" style={{ position: 'absolute', bottom: '40px', left: '40px', width: '120px', height: '120px', borderLeft: '24px solid #E60000', borderBottom: '24px solid #E60000' }} />
      <div className="s24-bot-right" style={{ position: 'absolute', bottom: '40px', right: '40px', width: '120px', height: '120px', borderRight: '24px solid #E60000', borderBottom: '24px solid #E60000' }} />

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0px', position: 'relative' }}>
        <div className="s24-diag-wipe" style={{ position: 'absolute', inset: -20, backgroundColor: '#FFFFFF', zIndex: 10 }} />
        <div className="s24-line-1" style={{ fontSize: 'clamp(80px, 16vw, 180px)', fontWeight: 900, color: '#FFFFFF', lineHeight: 0.9, fontFamily: 'Inter, sans-serif' }}>
          AR
        </div>
        <div className="s24-line-2" style={{ fontSize: 'clamp(80px, 16vw, 180px)', fontWeight: 900, color: '#E60000', lineHeight: 0.9, fontFamily: 'Inter, sans-serif' }}>
          TON
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 2.5: 3-Tier Horizontal Band (Triple Band Stencil System)
// ============================================================================
export const Domain2_5_TripleBand: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s25-band-1', { xPercent: -100 });
      gsap.set('.s25-band-2', { xPercent: 100 });
      gsap.set('.s25-band-3', { xPercent: -100 });
      gsap.set('.s25-text-1', { x: -100 });
      gsap.set('.s25-text-2', { x: 100 });
      gsap.set('.s25-text-3', { x: -100 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s25-band-1, .s25-band-2, .s25-band-3', {
        xPercent: 0,
        duration: 0.8,
        stagger: 0.1,
        ease: 'power4.inOut',
      })
      .to('.s25-text-1, .s25-text-2, .s25-text-3', {
        x: 0,
        duration: 0.8,
        stagger: 0.08,
        ease: 'power4.out',
      })
      .to('.s25-text-1', { x: 100, duration: 0.6, ease: 'power3.in' }, '+=1.0')
      .to('.s25-text-2', { x: -100, duration: 0.6, ease: 'power3.in' }, '-=0.6')
      .to('.s25-text-3', { x: 100, duration: 0.6, ease: 'power3.in' }, '-=0.6')
      .to('.s25-band-1', { xPercent: -100, duration: 0.6, ease: 'power4.in' })
      .to('.s25-band-2', { xPercent: 100, duration: 0.6, ease: 'power4.in' }, '-=0.6')
      .to('.s25-band-3', { xPercent: -100, duration: 0.6, ease: 'power4.in' }, '-=0.6');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#000000',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div className="s25-band-1" style={{ flex: 1, backgroundColor: '#141416', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div className="s25-text-1" style={{ fontSize: 'clamp(72px, 14vw, 180px)', fontWeight: 900, color: '#FFFFFF', fontFamily: 'Inter, sans-serif' }}>
          ARTON
        </div>
      </div>

      <div className="s25-band-2" style={{ flex: 1, backgroundColor: '#E60000', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div className="s25-text-2" style={{ fontSize: 'clamp(72px, 14vw, 180px)', fontWeight: 900, color: '#0A0A0C', fontFamily: 'Inter, sans-serif' }}>
          ARTON
        </div>
      </div>

      <div className="s25-band-3" style={{ flex: 1, backgroundColor: '#F4F4F0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div className="s25-text-3" style={{ fontSize: 'clamp(72px, 14vw, 180px)', fontWeight: 900, color: '#E60000', fontFamily: 'Inter, sans-serif' }}>
          ARTON
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 2.6: Dual Diagonal Cut (Angled Solid Shearing System)
// ============================================================================
export const Domain2_6_DiagonalCut: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s26-poly-top', { xPercent: -100, yPercent: -100 });
      gsap.set('.s26-poly-bot', { xPercent: 100, yPercent: 100 });
      gsap.set('.s26-letter', { skewX: -30, opacity: 0 });
      gsap.set('.s26-slash-bar', { scaleX: 0, transformOrigin: 'center center' });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s26-poly-top, .s26-poly-bot', {
        xPercent: 0,
        yPercent: 0,
        duration: 0.9,
        ease: 'power4.inOut',
      })
      .to('.s26-slash-bar', {
        scaleX: 1,
        duration: 0.4,
        ease: 'power3.out',
      })
      .to('.s26-letter', {
        skewX: 0,
        opacity: 1,
        duration: 0.7,
        stagger: 0.08,
        ease: 'power4.out',
      }, '-=0.2')
      .to('.s26-letter', { skewX: 30, opacity: 0, duration: 0.5, stagger: 0.04, ease: 'power3.in' }, '+=1.0')
      .to('.s26-poly-top', { xPercent: -100, yPercent: -100, duration: 0.7, ease: 'power4.in' })
      .to('.s26-poly-bot', { xPercent: 100, yPercent: 100, duration: 0.7, ease: 'power4.in' }, '-=0.7');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#0A0A0C',
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
      }}
    >
      <div
        className="s26-poly-top"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: '#E60000',
          clipPath: 'polygon(0 0, 100% 0, 0 100%)',
          zIndex: 2,
        }}
      />

      <div
        className="s26-poly-bot"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: '#F4F4F0',
          clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
          zIndex: 2,
        }}
      />

      <div
        className="s26-slash-bar"
        style={{
          position: 'absolute',
          width: '140%',
          height: '24px',
          backgroundColor: '#FFD600',
          transform: 'rotate(-25deg)',
          zIndex: 8,
        }}
      />

      <div style={{ position: 'relative', zIndex: 10, display: 'flex', gap: '16px', transform: 'rotate(-25deg)' }}>
        {['A', 'R', 'T', 'O', 'N'].map((char, index) => (
          <span
            key={index}
            className="s26-letter"
            style={{
              fontSize: 'clamp(64px, 12vw, 150px)',
              fontWeight: 900,
              color: '#0A0A0C',
              fontFamily: 'Inter, sans-serif',
              display: 'inline-block',
            }}
          >
            {char}
          </span>
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 2.7: Stencil Window / Grid Matrix Aperture
// ============================================================================
export const Domain2_7_StencilMatrix: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s27-cell', { scale: 0, opacity: 0 });
      gsap.set('.s27-char', { yPercent: 100 });
      gsap.set('.s27-ticker', { xPercent: 100 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s27-cell', {
        scale: 1,
        opacity: 1,
        duration: 0.7,
        stagger: 0.1,
        ease: 'power4.out',
      })
      .to('.s27-char', {
        yPercent: 0,
        duration: 0.7,
        stagger: 0.1,
        ease: 'power4.out',
      }, '-=0.3')
      .to('.s27-ticker', {
        xPercent: -100,
        duration: 4.0,
        ease: 'none',
      }, '-=0.5')
      .to('.s27-char', { yPercent: -100, duration: 0.5, stagger: 0.05, ease: 'power3.in' })
      .to('.s27-cell', { scale: 0, opacity: 0, duration: 0.5, stagger: 0.05, ease: 'power4.in' }, '-=0.3');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  const gridData = [
    { char: 'A', bg: '#E60000', color: '#FFFFFF' },
    { char: 'R', bg: '#F4F4F0', color: '#0A0A0C' },
    { char: 'T', bg: '#18181B', color: '#E60000' },
    { char: 'O', bg: '#FFD600', color: '#0A0A0C' },
  ];

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#0A0A0C',
        display: 'flex',
        flexDirection: 'column',
        padding: '24px',
        boxSizing: 'border-box',
        gap: '24px',
        userSelect: 'none',
      }}
    >
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: '20px' }}>
        {gridData.map((item, index) => (
          <div
            key={index}
            className="s27-cell"
            style={{
              backgroundColor: item.bg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              borderRadius: '0px',
            }}
          >
            <div style={{ overflow: 'hidden' }}>
              <span
                className="s27-char"
                style={{
                  fontSize: 'clamp(80px, 16vw, 220px)',
                  fontWeight: 900,
                  color: item.color,
                  fontFamily: 'Inter, sans-serif',
                  display: 'inline-block',
                  lineHeight: 0.9,
                }}
              >
                {item.char}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div style={{ height: '60px', backgroundColor: '#E60000', overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
        <div
          className="s27-ticker"
          style={{
            fontSize: '20px',
            fontWeight: 900,
            color: '#FFFFFF',
            whiteSpace: 'nowrap',
            letterSpacing: '0.2em',
            fontFamily: 'Inter, sans-serif',
          }}
        >
          ARTON // STENCIL MATRIX SYSTEM // SWISS MASK 02.7 // ARTON ARCHITECTURE & DESIGN //
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// SOLUTION 2.8: Inverted Dark Box (Monochrome Negative Lockup)
// ============================================================================
export const Domain2_8_InvertedBox: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set('.s28-dark-box', { scale: 0 });
      gsap.set('.s28-knockout-text', { y: 60, opacity: 0 });
      gsap.set('.s28-slit-word', { yPercent: 100 });

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2 });

      tl.to('.s28-dark-box', {
        scale: 1,
        duration: 0.8,
        ease: 'power4.out',
      })
      .to('.s28-knockout-text', {
        y: 0,
        opacity: 1,
        duration: 0.7,
        ease: 'power4.out',
      }, '-=0.3')
      .to('.s28-slit-word', { yPercent: 0, duration: 0.5, ease: 'power3.out' })
      .to('.s28-slit-word', { yPercent: -100, duration: 0.5, ease: 'power3.in' }, '+=0.8')
      .to('.s28-knockout-text', { opacity: 0, y: -60, duration: 0.5, ease: 'power3.in' })
      .to('.s28-dark-box', { scale: 0, duration: 0.6, ease: 'power4.in' }, '-=0.2');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#FFFFFF',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div
        className="s28-dark-box"
        style={{
          width: '82vw',
          height: '72vh',
          backgroundColor: '#0A0A0C',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px',
          boxSizing: 'border-box',
          gap: '24px',
        }}
      >
        <div className="s28-knockout-text" style={{ fontSize: 'clamp(80px, 18vw, 240px)', fontWeight: 900, color: '#FFFFFF', letterSpacing: '-0.03em', fontFamily: 'Inter, sans-serif', lineHeight: 0.9 }}>
          ARTON
        </div>

        <div style={{ height: '36px', overflow: 'hidden', borderTop: '2px solid #E60000', borderBottom: '2px solid #E60000', padding: '4px 20px' }}>
          <div className="s28-slit-word" style={{ fontSize: '18px', fontWeight: 900, color: '#E60000', letterSpacing: '0.25em', fontFamily: 'Inter, sans-serif' }}>
            SWISS TYPOGRAPHIC MASK SYSTEM
          </div>
        </div>
      </div>
    </div>
  );
};
