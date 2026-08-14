// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/device/**
// Registry: crates/conex-types/contracts/device-protocol.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

export const DEVICE_EVENTS = [
  {"id":1,"type":"agent-start","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":2,"type":"agent-end","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p0"},
  {"id":3,"type":"turn-start","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":4,"type":"turn-end","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":5,"type":"message-start","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":6,"type":"message-delta","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":7,"type":"message-end","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":8,"type":"tool-start","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":9,"type":"tool-update","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":10,"type":"tool-end","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p2"},
  {"id":11,"type":"tool-batch-start","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":12,"type":"tool-batch-end","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":13,"type":"context-compression-start","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":14,"type":"context-compression-end","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":15,"type":"provider-diagnostic","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":16,"type":"runtime-error","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"p0"},
  {"id":17,"type":"runtime-steering","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":18,"type":"runtime-intervention-required","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"p0"},
  {"id":19,"type":"approval-requested","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p0"},
  {"id":20,"type":"approval-resolved","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p0"},
  {"id":21,"type":"checkpoint-created","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":22,"type":"checkpoint-restored","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":23,"type":"run-terminal","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p0"},
  {"id":24,"type":"cache-stats-updated","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":25,"type":"cache-waste-alert","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"p2"},
  {"id":26,"type":"cold-cache-warning","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"p2"},
  {"id":27,"type":"security-audit","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p0"},
  {"id":28,"type":"subagent-started","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":29,"type":"subagent-event","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":30,"type":"subagent-ended","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p0"},
  {"id":31,"type":"task-started","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"none"},
  {"id":32,"type":"task-output","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":33,"type":"task-heartbeat","strategy":"tuple","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":34,"type":"task-suspicious","strategy":"transparent","realtime":{"push":true,"backpressure":"soft"},"sync":false,"pushLevel":"p0"},
  {"id":35,"type":"task-completed","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p1"},
  {"id":36,"type":"task-failed","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p0"},
  {"id":37,"type":"task-killed","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":true,"pushLevel":"p1"},
  {"id":38,"type":"timer-fired","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"p1"},
  {"id":39,"type":"timer-cancelled","strategy":"tuple","realtime":{"push":true,"backpressure":"soft"},"sync":false,"pushLevel":"none"},
  {"id":40,"type":"cron-fired","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"p1"},
  {"id":41,"type":"recovery-escalated","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":42,"type":"recovery-steering","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":43,"type":"recovery-fork","strategy":"transparent","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":44,"type":"recovery-report","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":45,"type":"recovery-budget-denied","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":46,"type":"goal-round-started","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":47,"type":"goal-round-completed","strategy":"redacted","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":48,"type":"goal-continuation-decided","strategy":"tuple","realtime":{"push":true,"backpressure":"critical"},"sync":false,"pushLevel":"none"},
  {"id":49,"type":"steering-evaluated","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":50,"type":"control-intent","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":51,"type":"hook-outcome","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":52,"type":"summary-background","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":53,"type":"stage-summary-milestone","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":54,"type":"nudge-enqueued","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":55,"type":"recovery-acknowledged","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":56,"type":"recovery-retry-attempted","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"},
  {"id":57,"type":"provider-request-anchored","strategy":"redacted","realtime":{"push":true,"backpressure":"delta"},"sync":false,"pushLevel":"none"}
] as const;
export type DeviceEvent = (typeof DEVICE_EVENTS)[number];
export type DeviceEventType = DeviceEvent["type"];

export const EVENT_SYNC_ELIGIBLE = ["agent-start","agent-end","turn-start","turn-end","message-end","tool-start","tool-update","tool-end","context-compression-start","context-compression-end","approval-requested","approval-resolved","run-terminal","security-audit","subagent-started","subagent-ended","task-started","task-completed","task-failed","task-killed"] as const;
export type EventSyncEligibleType = (typeof EVENT_SYNC_ELIGIBLE)[number];

export const EVENT_STRATEGY_COUNTS = {"transparent":14,"tuple":10,"redacted":33} as const;

