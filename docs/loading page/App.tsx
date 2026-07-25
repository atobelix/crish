import React, { useState } from 'react';
import { Solution1MonoLine } from './solution-1-mono-line';
import { Solution2ZenArchitect } from './solution-2-zen-architect';
import { Solution3SwissTypo } from './solution-3-swiss-typo';
import { Solution4VectorBlueprint } from './solution-4-vector-blueprint';
import { Solution5FluidRibbon } from './solution-5-fluid-ribbon';
import { Solution6GridPulse } from './solution-6-grid-pulse';
import { Arton48Catalog } from './arton-48-systems-catalog';
import { ArtonIconStudio } from './arton-icon-studio';

export default function App() {
  const [activeTab, setActiveTab] = useState<'icon-studio' | 'catalog-48' | 'solution-1' | 'solution-2' | 'solution-3' | 'solution-4' | 'solution-5' | 'solution-6'>('icon-studio');

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', overflow: 'hidden', backgroundColor: '#09090b' }}>
      {/* 顶部悬浮切换栏 */}
      <div
        style={{
          position: 'fixed',
          top: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          display: 'flex',
          gap: '6px',
          padding: '6px 10px',
          borderRadius: '999px',
          backgroundColor: 'rgba(15, 15, 18, 0.88)',
          backdropFilter: 'blur(16px)',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
        }}
      >
        <button
          onClick={() => setActiveTab('icon-studio')}
          style={{
            padding: '6px 16px',
            borderRadius: '999px',
            border: 'none',
            backgroundColor: activeTab === 'icon-studio' ? '#f59e0b' : 'transparent',
            color: activeTab === 'icon-studio' ? '#09090b' : '#f4f4f5',
            fontWeight: 800,
            fontSize: '12px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          🎨 ARTON 字母图标设计实验室
        </button>

        <button
          onClick={() => setActiveTab('catalog-48')}
          style={{
            padding: '6px 16px',
            borderRadius: '999px',
            border: 'none',
            backgroundColor: activeTab === 'catalog-48' ? '#f4f4f5' : 'transparent',
            color: activeTab === 'catalog-48' ? '#09090b' : '#a1a1aa',
            fontWeight: 800,
            fontSize: '12px',
            cursor: 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          🚀 48 套全屏重型系统库
        </button>

        <div style={{ width: '1px', backgroundColor: 'rgba(255,255,255,0.15)', margin: '4px 2px' }} />

        {[
          { id: 'solution-1', label: '1. 重型金石 A' },
          { id: 'solution-2', label: '2. A-T 连体徽印' },
          { id: 'solution-3', label: '3. 瑞士巨型字' },
          { id: 'solution-4', label: '4. 棱镜实体拱门' },
          { id: 'solution-5', label: '5. 阴刻黑曜石' },
          { id: 'solution-6', label: '6. 2x2 模块拼合' },
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => setActiveTab(item.id as any)}
            style={{
              padding: '6px 14px',
              borderRadius: '999px',
              border: 'none',
              backgroundColor: activeTab === item.id ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
              color: activeTab === item.id ? '#ffffff' : '#a1a1aa',
              fontWeight: activeTab === item.id ? 600 : 400,
              fontSize: '12px',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* 视图渲染 */}
      {activeTab === 'icon-studio' && <ArtonIconStudio />}
      {activeTab === 'catalog-48' && <Arton48Catalog />}
      {activeTab === 'solution-1' && <Solution1MonoLine />}
      {activeTab === 'solution-2' && <Solution2ZenArchitect />}
      {activeTab === 'solution-3' && <Solution3SwissTypo />}
      {activeTab === 'solution-4' && <Solution4VectorBlueprint />}
      {activeTab === 'solution-5' && <Solution5FluidRibbon />}
      {activeTab === 'solution-6' && <Solution6GridPulse />}
    </div>
  );
}
