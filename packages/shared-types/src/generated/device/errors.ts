// =======================================================================
// GENERATED FILE - DO NOT EDIT BY HAND.
// Source of truth: crates/conex-types/src/device/**
// Registry: crates/conex-types/contracts/device-protocol.json
// Generator: scripts/generate-engine-bindings.mjs
// Regenerate: node scripts/generate-engine-bindings.mjs
// =======================================================================

export const DEVICE_ERROR_COMMON = ["cmd.invalid","cmd.unknown","cmd.denied","cmd.timeout","cmd.cancelled","internal","frame_too_large","transport.closed"] as const;
export const DEVICE_ERROR_PROTOCOL = ["pair.invalid_code","pair.expired","pair.used","pair.too_many_attempts","pair.challenge_mismatch","pair.no_challenge","pair.registry_full","auth.bad_signature","auth.device_revoked","auth.unknown_device","auth.unknown_desktop","auth.expired","auth.stale","auth.rotate_conflict","version_mismatch","frame_too_large","transport.closed"] as const;
export const DEVICE_ERROR_BUSINESS = ["cmd.invalid","cmd.not_found","cmd.unknown","cmd.engine_not_ready","cmd.restore_in_progress","cmd.session_busy","cmd.approval_mismatch","cmd.denied","cmd.requires_approval","cmd.timeout","cmd.cancelled","cmd.too_many_requests","stream.not_subscribed","stream.cursor_invalid","stream.cursor_stale","stream.too_many_subscriptions","stream.too_many_streams","file.not_found","file.not_granted","file.too_large","file.binary","file.encoding","file.exists","approval.expired","approval.rejected","settings.key_denied","settings.confirm_timeout","internal"] as const;

export const DEVICE_ERROR_CODES = ["cmd.invalid","cmd.unknown","cmd.denied","cmd.timeout","cmd.cancelled","internal","frame_too_large","transport.closed","pair.invalid_code","pair.expired","pair.used","pair.too_many_attempts","pair.challenge_mismatch","pair.no_challenge","pair.registry_full","auth.bad_signature","auth.device_revoked","auth.unknown_device","auth.unknown_desktop","auth.expired","auth.stale","auth.rotate_conflict","version_mismatch","cmd.not_found","cmd.engine_not_ready","cmd.restore_in_progress","cmd.session_busy","cmd.approval_mismatch","cmd.requires_approval","cmd.too_many_requests","stream.not_subscribed","stream.cursor_invalid","stream.cursor_stale","stream.too_many_subscriptions","stream.too_many_streams","file.not_found","file.not_granted","file.too_large","file.binary","file.encoding","file.exists","approval.expired","approval.rejected","settings.key_denied","settings.confirm_timeout"] as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number];

export const CORE_ERROR_MAPPING = {
  "InvalidInput": ["cmd.invalid","file.not_granted","cmd.denied"],
  "NotFound": ["cmd.not_found","file.not_found","cmd.approval_mismatch"],
  "Cancelled": ["cmd.cancelled"],
  "Encoding": ["file.encoding","cmd.invalid"],
  "Io": ["internal"],
  "Internal": ["internal","cmd.engine_not_ready"]
} as const;
export type CoreErrorKind = keyof typeof CORE_ERROR_MAPPING;

