import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { configService } from '../../src/services/ConfigService';
import { z } from 'zod';

describe('ConfigService Fuzz', () => {
  beforeAll(() => {
    configService.define('shortcuts.overrides', z.record(z.string(), z.string()), {}, 'localStorage');
    configService.define('ui.size', z.enum(['small', 'medium', 'large']), 'medium');
    configService.define('ui.sidebarCollapsed', z.boolean(), false);
  });

  beforeEach(() => {
    localStorage.clear();
  });

  it('handles corrupt JSON gracefully', () => {
    localStorage.setItem('crish_config_v2:shortcuts.overrides', '{corrupt json!!!');
    expect(() => configService.get('shortcuts.overrides')).not.toThrow();
  });

  it('handles extremely long key names', () => {
    const longKey = 'a'.repeat(10000);
    expect(() => configService.define(longKey, z.any(), null)).not.toThrow();
    expect(configService.get(longKey)).toBeNull();
  });

  it('handles undefined and null values', () => {
    expect(() => configService.get('ui.sidebarCollapsed')).not.toThrow();
    const val = configService.get('ui.size');
    expect(['small', 'medium', 'large']).toContain(val);
  });

  it('handles schema migration gracefully', () => {
    localStorage.setItem('crish_config_v2:test.old', JSON.stringify({ v1: 'data' }));
    configService.define('test.old', z.string(), 'new-default');
    expect(configService.get('test.old')).toBe('new-default');
  });

  it('survives 1000 rapid get/set operations', () => {
    for (let i = 0; i < 1000; i++) {
      configService.set('ui.sidebarCollapsed', i % 2 === 0);
    }
    expect(typeof configService.get('ui.sidebarCollapsed')).toBe('boolean');
  });
});
