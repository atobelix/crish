/**
 * send_to_note 产品 UI 挂载纯函数测（B-05 · A-SURF-06 intentId 形状）
 */
import { describe, expect, it } from 'vitest';
import {
  buildChatSendToNoteIntentId,
  DEFAULT_CHAT_NOTE_DOC_ID,
  shouldShowSendToNoteEntry,
} from './sendToNoteMount';

describe('shouldShowSendToNoteEntry（B-05 仅 completed）', () => {
  it('仅 completed 为 true；流式/错误/缺省均 false', () => {
    expect(shouldShowSendToNoteEntry('completed')).toBe(true);
    expect(shouldShowSendToNoteEntry('processing')).toBe(false);
    expect(shouldShowSendToNoteEntry('queued')).toBe(false);
    expect(shouldShowSendToNoteEntry('error')).toBe(false);
    expect(shouldShowSendToNoteEntry(undefined)).toBe(false);
    expect(shouldShowSendToNoteEntry(null)).toBe(false);
    expect(shouldShowSendToNoteEntry('')).toBe(false);
  });
});

describe('buildChatSendToNoteIntentId（A-SURF-06 幂等形状）', () => {
  it('形状为 stn-chat:<messageId> 且同 messageId 恒等', () => {
    const a = buildChatSendToNoteIntentId('msg-42');
    const b = buildChatSendToNoteIntentId('msg-42');
    expect(a).toBe('stn-chat:msg-42');
    expect(b).toBe(a);
  });

  it('不同 messageId 不碰撞', () => {
    expect(buildChatSendToNoteIntentId('m1')).not.toBe(
      buildChatSendToNoteIntentId('m2')
    );
  });

  it('默认 docId 为 silent-doc（fallback，≠ 活动笔记选择器）', () => {
    expect(DEFAULT_CHAT_NOTE_DOC_ID).toBe('silent-doc');
  });
});
