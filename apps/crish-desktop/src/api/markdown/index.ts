export {
  parseMarkdownIntoBlocks,
  countNonSelfClosingOpenTags,
  countClosingTags,
  countDoubleDollars,
} from './parseMarkdownIntoBlocks';

export {
  IncrementalBlockSplitter,
  type LineBufferState,
} from './IncrementalBlockSplitter';

export { speculativeCloseBlock } from './SpeculativeVirtualCloser';
export {
  SlidingWindowRateEstimator,
  type RateSnapshot,
  type StreamingTier,
} from './SlidingWindowRateEstimator';
export {
  AdaptiveAnimateTimeline,
  type ScheduleSlot,
  type AdaptiveTimelineOptions,
} from './AdaptiveAnimateTimeline';
export { hasTableBlock } from './tableProbe';
export {
  preprocessCustomTags,
  findMarkdownCodeRanges,
  isPositionInRanges,
  normalizeClosedTag,
  DEFAULT_CUSTOM_TAGS,
  type CodeRange,
} from './preprocessCustomTags';
export { normalizeUnclosedOpenTags } from './normalizeUnclosedOpenTags';

