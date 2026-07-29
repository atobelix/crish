import React from 'react';
import type { DropPreviewDirection } from '../../store/types';

export const KNOWN_BODY_IDS = new Set([
  'chat',
  'preview',
  'overview',
  'files',
  'diff',
  'terminal',
  'settings',
  'runtime',
  'agent',
]);

export function getDockOverlayStyle(
  showDockOverlay: boolean,
  dropPreview: { direction: DropPreviewDirection } | null
): React.CSSProperties | null {
  if (!showDockOverlay || !dropPreview) return null;
  const { direction } = dropPreview;
  if (direction === 'merge') {
    return {
      position: 'absolute',
      top: '6px',
      left: '10px',
      right: '10px',
      height: '32px',
      borderRadius: '6px',
      backgroundColor:
        'color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)',
      border:
        '1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent)',
      animation: 'pulse-merge-highlight 1.5s infinite ease-in-out',
      pointerEvents: 'none',
      zIndex: 'var(--z-drag-highlight)',
    };
  } else if (direction === 'top') {
    return {
      position: 'absolute',
      top: '48px',
      left: '10px',
      right: '10px',
      height: 'calc((100% - 58px) / 2)',
      borderRadius: '6px',
      backgroundColor:
        'color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)',
      border:
        '1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent)',
      animation: 'pulse-merge-highlight 1.5s infinite ease-in-out',
      pointerEvents: 'none',
      zIndex: 'var(--z-drag-highlight)',
    };
  } else if (direction === 'bottom') {
    return {
      position: 'absolute',
      top: 'calc(48px + (100% - 58px) / 2)',
      bottom: '10px',
      left: '10px',
      right: '10px',
      borderRadius: '6px',
      backgroundColor:
        'color-mix(in srgb, var(--accent-color, #1a73e8) 6%, transparent)',
      border:
        '1px dashed color-mix(in srgb, var(--accent-color, #1a73e8) 45%, transparent)',
      animation: 'pulse-merge-highlight 1.5s infinite ease-in-out',
      pointerEvents: 'none',
      zIndex: 'var(--z-drag-highlight)',
    };
  }
  return null;
}
