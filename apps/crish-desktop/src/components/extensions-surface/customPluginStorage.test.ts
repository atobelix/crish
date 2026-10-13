// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadCustomPlugins,
  saveCustomPlugin,
  removeCustomPlugin,
  generatePluginSharePayload,
  parsePluginSharePayload,
  CUSTOM_PLUGINS_STORAGE_KEY,
  type CustomPluginItem,
} from './customPluginStorage';

describe('customPluginStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('loads empty array when localStorage is empty or corrupted', () => {
    expect(loadCustomPlugins()).toEqual([]);

    localStorage.setItem(CUSTOM_PLUGINS_STORAGE_KEY, 'invalid-json{{');
    expect(loadCustomPlugins()).toEqual([]);

    localStorage.setItem(
      CUSTOM_PLUGINS_STORAGE_KEY,
      JSON.stringify('not-an-array')
    );
    expect(loadCustomPlugins()).toEqual([]);
  });

  it('filters out invalid items without id or name', () => {
    const mixed = [
      { id: 'valid-1', name: 'Plugin One' },
      { id: '', name: 'Empty Id' },
      { id: 'valid-2' }, // missing name
      null,
      123,
    ];
    localStorage.setItem(CUSTOM_PLUGINS_STORAGE_KEY, JSON.stringify(mixed));

    const loaded = loadCustomPlugins();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('valid-1');
  });

  it('saves new custom plugin and dispatches event', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    const item: CustomPluginItem = {
      id: 'my-tool',
      name: 'My Tool',
      version: '1.0.0',
      description: 'Useful tool',
      type: 'custom',
      createdAt: 1000,
    };

    saveCustomPlugin(item);

    const loaded = loadCustomPlugins();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(item);
    expect(dispatchSpy).toHaveBeenCalled();
  });

  it('updates existing plugin with same id', () => {
    const item1: CustomPluginItem = {
      id: 'tool-x',
      name: 'Tool X',
      version: '1.0.0',
      description: 'Desc 1',
      type: 'custom',
      createdAt: 1000,
    };
    saveCustomPlugin(item1);

    const updatedItem: CustomPluginItem = {
      ...item1,
      description: 'Updated Desc',
      version: '1.1.0',
    };
    saveCustomPlugin(updatedItem);

    const loaded = loadCustomPlugins();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].description).toBe('Updated Desc');
    expect(loaded[0].version).toBe('1.1.0');
  });

  it('removes custom plugin by id', () => {
    const item1: CustomPluginItem = {
      id: 'tool-1',
      name: 'Tool 1',
      version: '1.0.0',
      description: '',
      type: 'custom',
      createdAt: 1000,
    };
    const item2: CustomPluginItem = {
      id: 'tool-2',
      name: 'Tool 2',
      version: '1.0.0',
      description: '',
      type: 'custom',
      createdAt: 2000,
    };

    saveCustomPlugin(item1);
    saveCustomPlugin(item2);
    expect(loadCustomPlugins()).toHaveLength(2);

    removeCustomPlugin('tool-1');
    const remaining = loadCustomPlugins();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('tool-2');
  });

  it('generates standard share payload json string', () => {
    const item: CustomPluginItem = {
      id: 'format-tool',
      name: 'Code Formatter',
      version: '2.0.0',
      description: 'Fast formatter',
      type: 'tool',
      author: 'Tester',
      tags: ['formatter', 'dev'],
      createdAt: 123456,
    };

    const payloadStr = generatePluginSharePayload(item);
    expect(typeof payloadStr).toBe('string');
    const parsed = JSON.parse(payloadStr);

    expect(parsed.id).toBe('format-tool');
    expect(parsed.name).toBe('Code Formatter');
    expect(parsed.version).toBe('2.0.0');
    expect(parsed.author).toBe('Tester');
    expect(parsed.tags).toContain('formatter');
  });

  it('parses valid plugin share payload correctly', () => {
    const jsonStr = JSON.stringify({
      id: 'share-id',
      name: 'Shared Name',
      version: '1.2.3',
      description: 'Shared desc',
      type: 'view',
      author: 'Alice',
      tags: ['custom'],
    });

    const parsed = parsePluginSharePayload(jsonStr);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe('share-id');
    expect(parsed?.name).toBe('Shared Name');
    expect(parsed?.version).toBe('1.2.3');
    expect(parsed?.type).toBe('view');
    expect(parsed?.author).toBe('Alice');
  });

  it('returns null for invalid share payloads', () => {
    expect(parsePluginSharePayload('')).toBeNull();
    expect(parsePluginSharePayload('not-json')).toBeNull();
    expect(parsePluginSharePayload('{}')).toBeNull();
    expect(
      parsePluginSharePayload(JSON.stringify({ version: '1.0.0' }))
    ).toBeNull();
  });
});
