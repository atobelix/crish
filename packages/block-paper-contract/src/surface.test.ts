/**
 * A-SURF-01 / SendToNote 冒烟：surface 枚举与桥接 Intent 形状。
 *
 * 对齐 dual-engine-surface.md §1.1 / §5.2.1 / §7 A-SURF-01
 */
import { describe, expect, it } from 'vitest';
import {
  EDITOR_SURFACES,
  SURFACE_CHAT,
  SURFACE_NOTE_PAPER,
  isSendToNoteIntent,
  type EditorSurface,
  type SendToNoteIntent,
} from './surface';
import {
  EDITOR_SURFACES as RE_EXPORTED_SURFACES,
  type EditorSurface as ReExportedSurface,
  type SendToNoteIntent as ReExportedSend,
} from './index';

describe('A-SURF-01 EditorSurface 枚举', () => {
  it('存在且仅存在两个编辑 surface：chat | note-paper', () => {
    expect(EDITOR_SURFACES).toEqual(['chat', 'note-paper']);
    expect(EDITOR_SURFACES).toHaveLength(2);
    expect(new Set(EDITOR_SURFACES).size).toBe(2);
  });

  it('SURFACE_* 常量与枚举一致且可作入口标注', () => {
    expect(SURFACE_CHAT).toBe('chat');
    expect(SURFACE_NOTE_PAPER).toBe('note-paper');
    expect(EDITOR_SURFACES).toContain(SURFACE_CHAT);
    expect(EDITOR_SURFACES).toContain(SURFACE_NOTE_PAPER);

    const chat: EditorSurface = SURFACE_CHAT;
    const note: EditorSurface = SURFACE_NOTE_PAPER;
    expect(chat).not.toBe(note);
  });

  it('index 公开 re-export 与 surface 模块同源', () => {
    expect(RE_EXPORTED_SURFACES).toEqual(EDITOR_SURFACES);
    // 类型烟测：赋值形状兼容
    const _s: ReExportedSurface = 'note-paper';
    const intent: ReExportedSend = {
      type: 'send_to_note',
      intentId: 'i-1',
      source: { surface: 'chat', messageId: 'm-1', markdown: '# hi' },
      target: {
        surface: 'note-paper',
        docId: 'doc-1',
        mode: 'apply_md_fragment',
      },
      origin: 'user',
    };
    expect(_s).toBe('note-paper');
    expect(intent.type).toBe('send_to_note');
  });
});

describe('SendToNoteIntent 冒烟（§5.2.1）', () => {
  const sample: SendToNoteIntent = {
    type: 'send_to_note',
    intentId: 'intent-send-1',
    source: {
      surface: 'chat',
      messageId: 'msg-42',
      markdown: '## 完成态快照\n\n正文',
    },
    target: {
      surface: 'note-paper',
      docId: 'doc-note-1',
      parentId: 'b-root',
      afterBlockId: 'b-0001',
      mode: 'insert_blocks',
    },
    origin: 'user',
  };

  it('合法字面量可构造且字段齐全', () => {
    expect(sample.type).toBe('send_to_note');
    expect(sample.source.surface).toBe('chat');
    expect(sample.target.surface).toBe('note-paper');
    expect(typeof sample.source.markdown).toBe('string');
    expect(sample.source).not.toHaveProperty('lines');
    expect(['insert_blocks', 'apply_md_fragment', 'append_to_block']).toContain(
      sample.target.mode
    );
  });

  it('isSendToNoteIntent 接受合法载荷、拒绝残缺/错误 surface', () => {
    expect(isSendToNoteIntent(sample)).toBe(true);
    expect(isSendToNoteIntent(null)).toBe(false);
    expect(isSendToNoteIntent({})).toBe(false);
    expect(
      isSendToNoteIntent({
        ...sample,
        type: 'text_edit',
      })
    ).toBe(false);
    expect(
      isSendToNoteIntent({
        ...sample,
        source: { ...sample.source, surface: 'note-paper' },
      })
    ).toBe(false);
    expect(
      isSendToNoteIntent({
        ...sample,
        target: { ...sample.target, mode: 'silent_merge' },
      })
    ).toBe(false);
    expect(
      isSendToNoteIntent({
        ...sample,
        intentId: '',
      })
    ).toBe(false);
  });

  it('三种 target.mode 均可守卫通过', () => {
    for (const mode of [
      'insert_blocks',
      'apply_md_fragment',
      'append_to_block',
    ] as const) {
      expect(
        isSendToNoteIntent({
          ...sample,
          target: { surface: 'note-paper', docId: 'd', mode },
          origin: 'agent',
        })
      ).toBe(true);
    }
  });
});
