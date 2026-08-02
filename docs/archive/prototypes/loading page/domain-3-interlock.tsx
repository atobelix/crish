import React, { useState, useEffect, useRef } from 'react';
import gsap from 'gsap';

// ==========================================
// SOLUTION 3.1: QUADRANT GRID INTERLOCK
// ==========================================
export const Solution3_1_QuadrantInterlock: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });

      gsap.set('.q-tile', { opacity: 0, scale: 0.6, x: 0, y: 0 });
      gsap.set('.q-tile-tl', { x: -120, y: -120 });
      gsap.set('.q-tile-tr', { x: 120, y: -120 });
      gsap.set('.q-tile-bl', { x: -120, y: 120 });
      gsap.set('.q-tile-br', { x: 120, y: 120 });
      gsap.set('.q-text-char', { opacity: 0, y: 20 });
      gsap.set('.q-center-symbol', { scale: 0, rotate: -45 });

      tl.to('.q-tile', {
        opacity: 1,
        scale: 1,
        x: 0,
        y: 0,
        duration: 0.7,
        stagger: 0.1,
        ease: 'back.out(1.7)',
      })
      .to('.q-center-symbol', {
        scale: 1,
        rotate: 0,
        duration: 0.5,
        ease: 'elastic.out(1, 0.5)',
      }, '-=0.2')
      .to('.q-text-char', {
        opacity: 1,
        y: 0,
        duration: 0.3,
        stagger: 0.05,
        ease: 'power2.out',
      }, '-=0.2')
      .to('.q-grid-inner', {
        rotate: 90,
        duration: 0.6,
        ease: 'power3.inOut',
      }, '+=0.4')
      .to('.q-tile', {
        scale: 0.9,
        duration: 0.2,
        yoyo: true,
        repeat: 1,
      }, '-=0.6')
      .to('.q-tile', {
        opacity: 0,
        scale: 0.7,
        duration: 0.4,
        stagger: 0.05,
      }, '+=0.6');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden bg-slate-950 text-white">
      <div className="q-grid-inner relative w-72 h-72 sm:w-80 sm:h-80 grid grid-cols-2 grid-rows-2 gap-3 p-3 bg-slate-900 border-4 border-slate-800 shadow-2xl rounded-xl">
        <div className="q-tile q-tile-tl bg-indigo-600 rounded-lg p-3 flex flex-col justify-between shadow-lg relative overflow-hidden">
          <div className="w-8 h-8 bg-indigo-400 rounded-sm flex items-center justify-center font-black text-slate-950 text-lg">A</div>
          <div className="w-full h-4 bg-indigo-800 rounded-sm" />
        </div>
        <div className="q-tile q-tile-tr bg-cyan-600 rounded-lg p-3 flex flex-col justify-between items-end shadow-lg relative overflow-hidden">
          <div className="w-8 h-8 bg-cyan-300 rounded-sm flex items-center justify-center font-black text-slate-950 text-lg">R</div>
          <div className="w-12 h-4 bg-cyan-800 rounded-sm" />
        </div>
        <div className="q-tile q-tile-bl bg-cyan-600 rounded-lg p-3 flex flex-col justify-between shadow-lg relative overflow-hidden">
          <div className="w-12 h-4 bg-cyan-800 rounded-sm" />
          <div className="w-8 h-8 bg-cyan-300 rounded-sm flex items-center justify-center font-black text-slate-950 text-lg">T</div>
        </div>
        <div className="q-tile q-tile-br bg-indigo-600 rounded-lg p-3 flex flex-col justify-between items-end shadow-lg relative overflow-hidden">
          <div className="w-full h-4 bg-indigo-800 rounded-sm" />
          <div className="w-8 h-8 bg-indigo-400 rounded-sm flex items-center justify-center font-black text-slate-950 text-lg">ON</div>
        </div>
        <div className="q-center-symbol absolute inset-0 m-auto w-24 h-24 bg-amber-400 border-4 border-slate-950 rounded-lg flex items-center justify-center shadow-2xl z-10">
          <svg viewBox="0 0 100 100" className="w-16 h-16 fill-slate-950">
            <path d="M 20,80 L 40,20 L 60,20 L 80,80 L 62,80 L 55,58 L 32,58 L 28,80 Z M 37,42 L 50,42 L 44,28 Z" />
            <path d="M 15,15 L 85,15 L 85,30 L 57,30 L 57,85 L 43,85 L 43,30 L 15,30 Z" opacity="0.3" />
          </svg>
        </div>
      </div>
      <div className="mt-10 flex gap-2 text-3xl sm:text-4xl font-black tracking-widest uppercase">
        {"ARTON".split("").map((char, i) => (
          <span key={i} className="q-text-char inline-block px-3 py-1 bg-slate-800 border-b-4 border-indigo-500 rounded">
            {char}
          </span>
        ))}
      </div>
    </div>
  );
};

// ==========================================
// SOLUTION 3.2: DIAGONAL SLIDING BEVELS
// ==========================================
export const Solution3_2_DiagonalBevels: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });

      gsap.set('.d-blade-left', { x: '-120%', y: '-120%' });
      gsap.set('.d-blade-right', { x: '120%', y: '120%' });
      gsap.set('.d-center-badge', { scale: 0, opacity: 0 });
      gsap.set('.d-typo-box', { opacity: 0, scaleX: 0 });

      tl.to('.d-blade-left, .d-blade-right', {
        x: '0%',
        y: '0%',
        duration: 0.8,
        ease: 'expo.out',
      })
      .to('.d-center-badge', {
        scale: 1,
        opacity: 1,
        duration: 0.4,
        ease: 'back.out(2)',
      }, '-=0.3')
      .to('.d-typo-box', {
        opacity: 1,
        scaleX: 1,
        duration: 0.4,
        ease: 'power2.out',
      })
      .to('.d-blade-left', {
        x: '-8%',
        duration: 0.3,
        yoyo: true,
        repeat: 1,
        ease: 'sine.inOut',
      }, '+=0.3')
      .to('.d-blade-right', {
        x: '8%',
        duration: 0.3,
        yoyo: true,
        repeat: 1,
        ease: 'sine.inOut',
      }, '-=0.6')
      .to('.d-blade-left', { x: '120%', y: '120%', duration: 0.6, ease: 'expo.in' }, '+=0.6')
      .to('.d-blade-right', { x: '-120%', y: '-120%', duration: 0.6, ease: 'expo.in' }, '-=0.6');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden bg-zinc-950 text-zinc-100">
      <div className="relative w-80 sm:w-96 h-80 flex items-center justify-center">
        <div className="d-blade-left absolute w-64 h-32 bg-amber-500 border-r-8 border-amber-300 shadow-2xl -skew-x-12 -translate-y-12 -translate-x-10 rounded-l-2xl flex items-center justify-start pl-6">
          <div className="skew-x-12 font-black text-zinc-950 text-2xl tracking-tighter">MODULAR</div>
        </div>
        <div className="d-blade-right absolute w-64 h-32 bg-zinc-800 border-l-8 border-amber-500 shadow-2xl -skew-x-12 translate-y-12 translate-x-10 rounded-r-2xl flex items-center justify-end pr-6">
          <div className="skew-x-12 font-black text-amber-400 text-2xl tracking-tighter">BEVEL</div>
        </div>
        <div className="d-center-badge z-20 w-28 h-28 bg-zinc-900 border-4 border-amber-400 shadow-2xl rounded-2xl flex items-center justify-center -skew-x-6">
          <div className="skew-x-6 flex flex-col items-center">
            <span className="text-4xl font-black text-amber-400 leading-none">A-T</span>
          </div>
        </div>
      </div>
      <div className="d-typo-box mt-8 px-8 py-3 bg-amber-500 text-zinc-950 font-black text-3xl tracking-widest -skew-x-12 shadow-xl border-b-4 border-zinc-950">
        <div className="skew-x-12">ARTON ASSEMBLY</div>
      </div>
    </div>
  );
};

// ==========================================
// SOLUTION 3.3: HEXAGONAL CORE MONOLITH
// ==========================================
export const Solution3_3_HexCoreMonolith: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1 });

      gsap.set('.h-wedge', { opacity: 0, scale: 2, rotate: (i) => i * 60 });
      gsap.set('.h-center-core', { scale: 0 });
      gsap.set('.h-ring', { rotate: 0 });
      gsap.set('.h-text-node', { opacity: 0, y: 10 });

      tl.to('.h-wedge', {
        opacity: 1,
        scale: 1,
        duration: 0.7,
        stagger: 0.08,
        ease: 'power3.out',
      })
      .to('.h-center-core', {
        scale: 1,
        duration: 0.5,
        ease: 'back.out(2)',
      }, '-=0.2')
      .to('.h-ring', {
        rotate: 120,
        duration: 0.8,
        ease: 'power2.inOut',
      })
      .to('.h-text-node', {
        opacity: 1,
        y: 0,
        duration: 0.3,
        stagger: 0.06,
      }, '-=0.4')
      .to('.h-center-core', {
        scale: 1.15,
        duration: 0.25,
        yoyo: true,
        repeat: 1,
      }, '+=0.3')
      .to('.h-wedge', {
        opacity: 0,
        scale: 0.3,
        duration: 0.5,
        stagger: 0.05,
      }, '+=0.6');
    }, containerRef);

    return () => ctx.revert();
  }, []);

  return (
    <div ref={containerRef} className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden bg-slate-950 text-emerald-400">
      <div className="relative w-80 h-80 flex items-center justify-center">
        <div className="h-ring absolute w-72 h-72 rounded-full border-4 border-dashed border-emerald-800/40 flex items-center justify-center" />
        {[0, 60, 120, 180, 240, 300].map((deg, i) => (
          <div
            key={i}
            className="h-wedge absolute w-32 h-32 flex items-center justify-center"
            style={{ transformOrigin: 'center center' }}
          >
            <div className="w-24 h-12 bg-emerald-600 border-2 border-emerald-950 rounded-sm shadow-xl flex items-center justify-center font-black text-slate-950 text-xs tracking-tighter">
              SECTOR 0{i + 1}
            </div>
          </div>
        ))}
        <div className="h-center-core z-20 w-32 h-32 bg-emerald-400 text-slate-950 rounded-2xl flex flex-col items-center justify-center shadow-[0_0_50px_rgba(52,211,153,0.3)] border-4 border-slate-950">
          <div className="text-4xl font-black tracking-tighter leading-none">A-T</div>
        </div>
      </div>
      <div className="mt-8 flex gap-3 text-3xl font-black text-emerald-300">
        {"ARTON".split("").map((char, i) => (
          <div key={i} className="h-text-node px-3 py-1 bg-slate-900 border-2 border-emerald-500 rounded-lg shadow-md">
            {char}
          </div>
        ))}
      </div>
    </div>
  );
};
