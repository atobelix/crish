/**
 * Streaming store public entry point.
 * Store implementation and command helpers depend on the leaf core module;
 * this facade keeps existing import paths stable without a helper/core cycle.
 */
export * from './streamingStoreCore';

export {
  setStreamText,
  setStreamThinking,
  setStreamTool,
  clearStreamTool,
  clearStreamTools,
  clearStream,
  clearStreams,
  clearSessionStreams,
  getStreamText,
  getStreamThinking,
  getStreamTools,
  getStreamTool,
  getStreamEntry,
} from './streamingStoreHelpers';
