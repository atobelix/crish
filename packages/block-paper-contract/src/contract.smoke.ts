/**
 * 编译期冒烟样本：用合法字面量占位各契约类型。
 * 由 `tsc --noEmit` 门禁；形状漂移时本文件直接红。
 *
 * 不接线业务；不进入 index 公开面。
 */

import type { QueryBlocksParams, QueryBlocksResult } from './query-blocks';
import {
  QUERY_BLOCKS_LIMIT_DEFAULT,
  QUERY_BLOCKS_LIMIT_MAX,
  QUERY_BLOCKS_TOOL_NAME,
} from './query-blocks';
import type { FlavourRegistration, RegisterFlavour } from './flavour';
import { asFlavourRegistration } from './flavour';
import type { DocEvent, Intent, MountSpec, ProjectionDiff } from './projection';

// ---------------------------------------------------------------------------
// query_blocks
// ---------------------------------------------------------------------------

export const sampleQueryParams: QueryBlocksParams = {
  doc_id: 'doc-smoke-1',
  kind_in: ['paragraph', 'heading'],
  attrs_eq: { collapsed: false, level: 1 },
  text_match: 'hello',
  ref_to: 'block-target',
  ref_from: 'block-source',
  limit: QUERY_BLOCKS_LIMIT_DEFAULT,
};

export const sampleQueryResult: QueryBlocksResult = {
  blocks: [
    {
      id: 'b1',
      kind: 'paragraph',
      snippet: 'hello world',
      attrs: { collapsed: false },
    },
  ],
  truncated: false,
};

export const queryToolMeta = {
  name: QUERY_BLOCKS_TOOL_NAME,
  limitMax: QUERY_BLOCKS_LIMIT_MAX,
  limitDefault: QUERY_BLOCKS_LIMIT_DEFAULT,
} as const;

// ---------------------------------------------------------------------------
// FlavourRegistration / registerFlavour
// ---------------------------------------------------------------------------

export const sampleFlavour: FlavourRegistration = asFlavourRegistration({
  id: 'callout',
  schema: {
    props: { type: 'object', properties: { emoji: { type: 'string' } } },
    hasText: true,
    displayName: 'Callout',
  },
  blockView: {
    component: 'block-paper/callout-view',
    virtualizable: true,
  },
  slash: {
    id: 'insert-callout',
    title: 'Callout',
    group: 'basic',
    action: { insert: 'callout' },
  },
});

/** 仅占位签名，验证 RegisterFlavour 可被实现类型满足 */
export const sampleRegisterFlavour: RegisterFlavour = (reg) => {
  void reg.id;
  void reg.schema;
  return () => {
    /* unregister stub */
  };
};

// ---------------------------------------------------------------------------
// ProjectionDiff / DocEvent / MountSpec / Intent
// ---------------------------------------------------------------------------

export const sampleProjectionDiff: ProjectionDiff = {
  docId: 'doc-smoke-1',
  rev: 1,
  upserts: [{ id: 'b1', props: { checked: false }, children: ['b2'] }],
  removes: [],
  textTouches: ['b1'],
  // fullRebuild 仅允许 false 或省略
  fullRebuild: false,
};

export const sampleDocEvents: DocEvent[] = [
  { type: 'projection', diff: sampleProjectionDiff },
  { type: 'reject', intentId: 'intent-1', reason: 'conflict' },
  { type: 'awareness', peers: [] },
];

export const sampleMountSpec: MountSpec = {
  window: { startIndex: 0, endIndex: 40 },
  pinned: ['b-focus', 'b-composing'],
  heights: [
    { id: 'b-focus', px: 24, estimated: false },
    { id: 'b-next', px: 32, estimated: true },
  ],
};

export const sampleIntents: Intent[] = [
  {
    type: 'text_edit',
    blockId: 'b-focus',
    range: [0, 0],
    insert: 'a',
    intentId: 'intent-text-1',
  },
  {
    type: 'op',
    ops: [{ kind: 'turn_into', blockId: 'b1', flavour: 'heading' }],
    intentId: 'intent-op-1',
  },
];
