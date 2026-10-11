// @vitest-environment jsdom
import React, { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelThinkingSection } from './ModelThinkingSection';

function Harness({
  seedMap,
}: {
  seedMap?: Record<string, string>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [thinkingMap, setThinkingMap] = useState<Record<string, string>>();

  return (
    <ModelThinkingSection
      enabled={enabled}
      thinkingMap={thinkingMap}
      seedMap={seedMap}
      onChange={(next) => {
        setEnabled(next.enabled);
        setThinkingMap(next.thinkingMap);
      }}
    />
  );
}

describe('ModelThinkingSection', () => {
  it('关闭后再打开会保留已经填过的档位，而不是改回标准表', () => {
    render(
      <Harness seedMap={{ Low: 'low', High: 'high' }} />
    );

    fireEvent.click(screen.getByRole('button', { name: '配置思考档位' }));
    expect(screen.getByDisplayValue('Low')).toBeInTheDocument();
    expect(screen.getByDisplayValue('high')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭思考' }));
    fireEvent.click(screen.getByRole('button', { name: '配置思考档位' }));

    expect(screen.getByDisplayValue('Low')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Off')).not.toBeInTheDocument();
  });
});
