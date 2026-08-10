// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/device/**
// Registry: crates/conex-types/contracts/device-protocol.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

export const STREAM_KINDS = [
  {"kind":"stream.open","direction":"desktop-to-mobile","bodyType":"StreamOpen","messageId":97},
  {"kind":"stream.chunk","direction":"both","bodyType":"StreamChunk","messageId":98},
  {"kind":"stream.resume","direction":"both","bodyType":"StreamResume","messageId":99},
  {"kind":"stream.close","direction":"both","bodyType":"StreamClose","messageId":100}
] as const;
export type StreamKindName = (typeof STREAM_KINDS)[number]["kind"];

export const STREAM_LIMITS = {"STREAM_CHUNK_MAX":65536,"STREAM_MAX_BYTES":268435456,"MAX_STREAMS":8,"STREAM_TTL_MS":300000} as const;

