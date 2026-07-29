import React from 'react';

export function PanelLazyFallback() {
  return (
    <div
      className="skel-shimmer"
      style={{ height: '100%', minHeight: 48, borderRadius: 6 }}
      aria-hidden="true"
    />
  );
}
