// eventStore 纯逻辑 reducers（M5 §3.1：集合更新纯函数，store 动作只转发，jest 直测）
// 覆盖：feed 环形缓冲（F3 §3.4.2 / R2UX-05-09 / M6 §7.3：上限 500 条，超出丢最旧）、
//       去重（M6 §8.3 游标规则 2/4：(sessionId, sequence) 幂等键 + 游标只升不降）、
//       游标跟踪（lastSeq 供 resume）、过滤（R2UX-05-06 过滤条数据面）、稳定排序（seq 升序）
//
// T4 投影原语下沉（详案 T4 §1.3）：纯逻辑单源已迁入 `packages/shared-utils`
// （event-envelope / event-ring-window / event-filter），本文件保留为
// mobile 域到共享原语的接线转发（barrel）——消费方 import 面稳定，实现不重复。
import {
  readBool,
  readNumber,
  readRecord,
  readString,
  type EventEnvelopeFrame,
} from '@crish/shared-utils';
import {
  FEED_RING_MAX,
  advanceCursor,
  appendFeed,
  createWindow,
  hydrateFeed,
  stableSortBySeq,
  type AppendOutcome,
  type EventWindow,
  type FeedEntry,
} from '@crish/shared-utils';
import {
  deriveErrorLevel,
  filterByRunId,
  filterByTypes,
  filterErrors,
  filterFeed,
  type FeedFilter,
} from '@crish/shared-utils';

export {
  readBool,
  readNumber,
  readRecord,
  readString,
  FEED_RING_MAX,
  advanceCursor,
  appendFeed,
  createWindow,
  hydrateFeed,
  stableSortBySeq,
  deriveErrorLevel,
  filterByRunId,
  filterByTypes,
  filterErrors,
  filterFeed,
};
export type {
  EventEnvelopeFrame,
  AppendOutcome,
  EventWindow,
  FeedEntry,
  FeedFilter,
};
