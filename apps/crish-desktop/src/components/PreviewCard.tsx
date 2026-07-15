import React, { useState } from 'react';
import * as Lucide from 'lucide-react';
import { isDemoMode } from '../api/appMode';

interface PreviewCardProps {
  wsId: string;
  onShowToast: (message: string) => void;
}

/**
 * 正式版：预览未接入真实浏览器/本地服务时显示诚实空态。
 * 演示模式保留简易 mock 导航壳（仅供 UI 演示）。
 */
export const PreviewCard: React.FC<PreviewCardProps> = ({
  wsId: _wsId,
  onShowToast,
}) => {
  const demo = isDemoMode();
  const [browserUrl, setBrowserUrl] = useState('http://localhost:5174/');

  if (!demo) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, background: '#fff' }}>
        <div
          className="card-subheader preview-subheader"
          style={{
            padding: '8px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            borderBottom: '1px solid var(--border-subtle)',
            background: '#fff',
          }}
        >
          <Lucide.Eye size={14} style={{ color: 'var(--text-tertiary)' }} />
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>预览</span>
        </div>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 28,
            color: 'var(--text-tertiary)',
            fontSize: 13,
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          <Lucide.Eye size={28} style={{ opacity: 0.35 }} />
          <div>预览面板尚未接入</div>
          <div style={{ fontSize: 12, maxWidth: 280 }}>
            正式版暂不提供内嵌浏览器模拟。本地服务请在系统浏览器中打开，或等待后续真预览能力。
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: 1, background: '#fff' }}>
      <div
        className="card-subheader preview-subheader"
        style={{
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          borderBottom: '1px solid var(--border-subtle)',
          background: '#fff',
        }}
      >
        <Lucide.Globe size={13} style={{ color: 'var(--text-tertiary)' }} />
        <input
          value={browserUrl}
          onChange={(e) => setBrowserUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onShowToast(`(演示) 导航到 ${browserUrl}`);
          }}
          style={{
            flex: 1,
            border: '1px solid var(--border-color)',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 13,
        }}
      >
        演示预览占位 · {browserUrl}
      </div>
    </div>
  );
};
