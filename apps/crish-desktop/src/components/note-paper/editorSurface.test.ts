/**
 * 桌面 editorSurface 单源：别名 === 契约 SURFACE_*。
 * surface 单源 ≠ 打开完成 ≠ 关 EL ≠ 独立软件已拆。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EDITOR_SURFACES as CONTRACT_SURFACES,
  SURFACE_CHAT,
  SURFACE_NOTE_PAPER,
} from '@crish/block-paper-contract';
import {
  EDITOR_SURFACE_CHAT,
  EDITOR_SURFACE_NOTE_PAPER,
  EDITOR_SURFACES,
  isEditorSurface,
} from './editorSurface';
import {
  EDITOR_SURFACE_CHAT as BRIDGE_SURFACE_CHAT,
  EDITOR_SURFACE_NOTE_PAPER as BRIDGE_SURFACE_NOTE_PAPER,
} from '../../bridges/send-to-note';

const DIR =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const LOCAL_SURFACE_LITERAL =
  /=\s*['"]chat['"]\s+as const|=\s*['"]note-paper['"]\s+as const/;

describe('editorSurface 契约单源', () => {
  it('桌面别名与契约 SURFACE_* 值相等且同引用', () => {
    expect(EDITOR_SURFACE_CHAT).toBe(SURFACE_CHAT);
    expect(EDITOR_SURFACE_NOTE_PAPER).toBe(SURFACE_NOTE_PAPER);
    expect(EDITOR_SURFACES).toEqual(CONTRACT_SURFACES);
    expect(EDITOR_SURFACES).toBe(CONTRACT_SURFACES);
  });

  it('桥 re-export 与桌面/契约同一套，不是第三权威', () => {
    expect(BRIDGE_SURFACE_CHAT).toBe(SURFACE_CHAT);
    expect(BRIDGE_SURFACE_NOTE_PAPER).toBe(SURFACE_NOTE_PAPER);
    expect(BRIDGE_SURFACE_CHAT).toBe(EDITOR_SURFACE_CHAT);
    expect(BRIDGE_SURFACE_NOTE_PAPER).toBe(EDITOR_SURFACE_NOTE_PAPER);
  });

  it('isEditorSurface 只认契约两个 surface', () => {
    expect(isEditorSurface(SURFACE_CHAT)).toBe(true);
    expect(isEditorSurface(SURFACE_NOTE_PAPER)).toBe(true);
    expect(isEditorSurface(EDITOR_SURFACE_CHAT)).toBe(true);
    expect(isEditorSurface(EDITOR_SURFACE_NOTE_PAPER)).toBe(true);
    expect(isEditorSurface('scheduled')).toBe(false);
    expect(isEditorSurface('')).toBe(false);
    expect(isEditorSurface(null)).toBe(false);
  });

  it('桌面与桥不本地再写死 chat | note-paper 字面量', () => {
    const editorSrc = readFileSync(resolve(DIR, 'editorSurface.ts'), 'utf8');
    const bridgeSrc = readFileSync(
      resolve(DIR, '../../bridges/send-to-note.ts'),
      'utf8',
    );
    expect(editorSrc).not.toMatch(LOCAL_SURFACE_LITERAL);
    expect(bridgeSrc).not.toMatch(LOCAL_SURFACE_LITERAL);
    expect(editorSrc).toMatch(/@crish\/block-paper-contract/);
    expect(bridgeSrc).toMatch(/from ['"].*note-paper\/editorSurface['"]/);
  });
});
