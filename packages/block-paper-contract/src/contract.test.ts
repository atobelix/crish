/**
 * 契约包轻量运行时断言（常量 + 冒烟样本可构造）。
 * 类型形状由 `npm run typecheck`（tsc --noEmit）与 contract.smoke.ts 共同守门。
 */
import { describe, expect, it } from 'vitest';
import {
  QUERY_BLOCKS_LIMIT_DEFAULT,
  QUERY_BLOCKS_LIMIT_MAX,
  QUERY_BLOCKS_TOOL_NAME,
  asFlavourRegistration,
  EDITOR_SURFACES,
  isSendToNoteIntent,
} from './index';
import {
  queryToolMeta,
  sampleFlavour,
  sampleIntents,
  sampleMountSpec,
  sampleProjectionDiff,
  sampleQueryParams,
  sampleQueryResult,
  sampleRegisterFlavour,
  sampleSendToNoteIntent,
  sampleSurfaces,
} from './contract.smoke';

describe('@crish/block-paper-contract', () => {
  it('query_blocks 工具名与 limit 边界与 schema 文档一致', () => {
    expect(QUERY_BLOCKS_TOOL_NAME).toBe('query_blocks');
    expect(QUERY_BLOCKS_LIMIT_DEFAULT).toBe(50);
    expect(QUERY_BLOCKS_LIMIT_MAX).toBe(200);
    expect(queryToolMeta.name).toBe('query_blocks');
  });

  it('query_blocks 冒烟样本字段齐全', () => {
    expect(sampleQueryParams.doc_id).toBe('doc-smoke-1');
    expect(sampleQueryResult.truncated).toBe(false);
    expect(sampleQueryResult.blocks[0]?.kind).toBe('paragraph');
  });

  it('FlavourRegistration 可注册且 id/schema 必填', () => {
    const reg = asFlavourRegistration(sampleFlavour);
    expect(reg.id).toBe('callout');
    expect(reg.schema.hasText).toBe(true);
    const dispose = sampleRegisterFlavour(reg);
    expect(typeof dispose === 'function' || dispose === undefined).toBe(true);
    if (typeof dispose === 'function') dispose();
  });

  it('ProjectionDiff / MountSpec / Intent 冒烟样本形状稳定', () => {
    expect(sampleProjectionDiff.rev).toBe(1);
    expect(sampleProjectionDiff.fullRebuild).toBe(false);
    expect(sampleMountSpec.pinned).toContain('b-composing');
    expect(sampleIntents.map((i) => i.type).sort()).toEqual([
      'op',
      'text_edit',
    ]);
  });

  it('A-SURF-01：EditorSurface 仅 chat | note-paper', () => {
    expect(EDITOR_SURFACES).toEqual(['chat', 'note-paper']);
    expect(sampleSurfaces).toEqual(EDITOR_SURFACES);
  });

  it('SendToNoteIntent 冒烟样本可守卫通过且无 lines 字段', () => {
    expect(isSendToNoteIntent(sampleSendToNoteIntent)).toBe(true);
    expect(sampleSendToNoteIntent.source).not.toHaveProperty('lines');
    expect(sampleSendToNoteIntent.source.markdown).toContain('smoke');
  });
});
