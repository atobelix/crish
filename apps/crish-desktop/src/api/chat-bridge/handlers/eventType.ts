import {
  parseEngineEnvelope,
} from '../../engineEventSchema';
import {
  safeParseDaemonEvent,
} from '../../engineEventZod';

export function resolveEventType(
  event: unknown
): { type: string; raw: Record<string, unknown> } | null {
  const zodEnv = safeParseDaemonEvent(event);
  if (zodEnv.ok === true) {
    const type = String(zodEnv.data.type ?? '').trim();
    if (!type) return null;
    return { type, raw: zodEnv.data.raw };
  }
  const light = parseEngineEnvelope(event);
  if (light.ok === true) {
    const type = String(light.data.type ?? '').trim();
    if (!type) return null;
    return { type, raw: light.data.raw };
  }
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    const raw = event as Record<string, unknown>;
    const type = String(raw.type ?? raw.event ?? raw.kind ?? '').trim();
    if (type) return { type, raw };
  }
  return null;
}
