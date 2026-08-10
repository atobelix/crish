// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/device/**
// Registry: crates/conex-types/contracts/device-protocol.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

export const DEVICE_CAPABILITIES = ["fileRead","fileWrite","taskList","taskInput","runTask","runControl","streams","eventReplay","approval","settings","devices","search","sessionSearch","cron","timer","subagent","presence"] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const CAPABILITY_METADATA = {
  "fileRead": {"owner":"both","commands":["C16","C17","C19","C20","C22","C23"]},
  "fileWrite": {"owner":"desktop","commands":["C18"]},
  "taskList": {"owner":"desktop","commands":["C06","C07"]},
  "taskInput": {"owner":"desktop","commands":[]},
  "runTask": {"owner":"desktop","commands":["C24"]},
  "runControl": {"owner":"desktop","commands":["C25","C26"]},
  "streams": {"owner":"desktop","commands":["stream.*"]},
  "eventReplay": {"owner":"desktop","commands":["events.resume","C03"]},
  "approval": {"owner":"desktop","commands":["C11","C12","C13","C14"]},
  "settings": {"owner":"desktop","commands":["C28","C29","C30","C31"]},
  "devices": {"owner":"desktop","commands":["C33","C34","C35","C36","C37"]},
  "search": {"owner":"desktop","commands":["C21"]},
  "sessionSearch": {"owner":"desktop","commands":["C27"]},
  "cron": {"owner":"desktop","commands":["events.push(cron-fired)"]},
  "timer": {"owner":"desktop","commands":["events.push(timer-fired)"]},
  "subagent": {"owner":"desktop","commands":["events.push(subagent-*)"]},
  "presence": {"owner":"desktop","commands":["C32"]}
} as const;
export type CapabilityMetadata = (typeof CAPABILITY_METADATA)[DeviceCapability];

