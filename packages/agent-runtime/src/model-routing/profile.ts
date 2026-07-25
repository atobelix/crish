import type { JsonObject, JsonValue } from "@crish/shared-types";
import { isRecord } from "@crish/shared-utils";
import type { ModelCapabilityFlags, ModelCatalog } from "../model-catalog/types";
import {
  type ModelCapabilityTag,
  type ModelProfile,
  type EnhancedModelProfile,
  type ModelCostTier,
  type ModelAvailability,
  type ModelHealthStatus,
  type ProviderEndpointSupport,
  type ProviderStreamingSupport,
  type ProviderRouteHealthEvent,
  type ModelProviderRouteMetadata,
  type ProviderRouteOfferLike,
} from "./types";

const KNOWN_COST_TIERS: ModelCostTier[] = ["free", "low", "medium", "high", "premium", "unknown"];

export function profileFromProviderRouteOffer(offer: ProviderRouteOfferLike): ModelProfile {
  const metadataProfile = modelProfileFromMetadata(offer.metadata?.modelProfile);
  const healthProfile = modelProfileFromMetadata(offer.health?.metadata?.modelProfile);
  return normalizeProfile({
    id: metadataProfile?.id ?? healthProfile?.id ?? offer.id,
    providerId: metadataProfile?.providerId ?? healthProfile?.providerId ?? offer.providerId,
    routeId: metadataProfile?.routeId ?? healthProfile?.routeId ?? offer.id,
    model: metadataProfile?.model ?? healthProfile?.model ?? offer.model,
    upstreamModel: metadataProfile?.upstreamModel ?? healthProfile?.upstreamModel ?? offer.upstreamModel ?? offer.model,
    endpointSupport: metadataProfile?.endpointSupport ?? healthProfile?.endpointSupport ?? endpointSupportField(offer.endpointSupport ?? offer.endpointType),
    streamingSupport: metadataProfile?.streamingSupport ?? healthProfile?.streamingSupport ?? streamingSupportField(offer.streamingSupport),
    credentialSource: metadataProfile?.credentialSource ?? healthProfile?.credentialSource ?? offer.credentialSource,
    route: routeMetadataFromOffer(offer, metadataProfile?.route ?? healthProfile?.route),
    aliases: metadataProfile?.aliases ?? healthProfile?.aliases ?? offer.aliases,
    ...(metadataProfile?.capabilities ?? healthProfile?.capabilities ? { capabilities: metadataProfile?.capabilities ?? healthProfile?.capabilities } : {}),
    costTier: metadataProfile?.costTier ?? healthProfile?.costTier,
    latencyMs: metadataProfile?.latencyMs ?? healthProfile?.latencyMs ?? nullableNumberToUndefined(offer.health?.lastLatencyMs),
    contextWindowTokens: metadataProfile?.contextWindowTokens ?? healthProfile?.contextWindowTokens,
    availability: metadataProfile?.availability ?? healthProfile?.availability,
    health: metadataProfile?.health ?? healthProfile?.health ?? offer.health?.status,
    lastSuccess: metadataProfile?.lastSuccess ?? healthProfile?.lastSuccess ?? routeHealthEventField(offer.health?.lastSuccess, offer.health?.lastSuccessAt, offer.health?.lastLatencyMs),
    lastFailure: metadataProfile?.lastFailure ?? healthProfile?.lastFailure ?? routeHealthEventField(offer.health?.lastFailure, offer.health?.lastFailureAt, undefined),
    priority: metadataProfile?.priority ?? healthProfile?.priority ?? offer.priority ?? offer.routingWeight,
    metadata: metadataProfile?.metadata ?? healthProfile?.metadata
  } as ModelProfile);
}

export function modelProfileFromMetadata(value: unknown): ModelProfile | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringField(value.id);
  const model = stringField(value.model);
  if (!id && !model) return undefined;
  return normalizeProfile({
    id: id ?? model ?? "unknown",
    providerId: stringField(value.providerId),
    routeId: stringField(value.routeId),
    model,
    upstreamModel: stringField(value.upstreamModel),
    endpointSupport: endpointSupportField(value.endpointSupport),
    streamingSupport: streamingSupportField(value.streamingSupport),
    credentialSource: jsonObjectField(value.credentialSource),
    route: routeMetadataField(value.route),
    aliases: stringArrayField(value.aliases),
    ...(capabilitiesField(value.capabilities) !== undefined ? { capabilities: capabilitiesField(value.capabilities) } : {}),
    costTier: costTierField(value.costTier),
    latencyMs: nonNegativeNumberField(value.latencyMs),
    contextWindowTokens: positiveIntegerField(value.contextWindowTokens),
    availability: availabilityField(value.availability),
    health: healthField(value.health),
    lastSuccess: routeHealthEventField(value.lastSuccess),
    lastFailure: routeHealthEventField(value.lastFailure),
    priority: nonNegativeNumberField(value.priority),
    metadata: jsonObjectField(value.metadata)
  } as ModelProfile);
}

export function enrichProfileFromCatalog(
  profile: ModelProfile,
  catalog: ModelCatalog
): EnhancedModelProfile {
  const entry = catalog.lookup(profile.model ?? profile.id, profile.providerId);
  if (!entry) return { ...profile, source: "user-config" } as EnhancedModelProfile;

  const capabilityFlags: Partial<ModelCapabilityFlags> = {};
  if (entry.supportsFunctionCalling !== undefined) capabilityFlags.supportsFunctionCalling = entry.supportsFunctionCalling;
  if (entry.supportsVision !== undefined) capabilityFlags.supportsVision = entry.supportsVision;
  if (entry.supportsReasoning !== undefined) capabilityFlags.supportsReasoning = entry.supportsReasoning;
  if (entry.supportsParallelFunctionCalling !== undefined) capabilityFlags.supportsParallelFunctionCalling = entry.supportsParallelFunctionCalling;
  if (entry.supportsResponseSchema !== undefined) capabilityFlags.supportsResponseSchema = entry.supportsResponseSchema;
  if (entry.supportsPromptCaching !== undefined) capabilityFlags.supportsPromptCaching = entry.supportsPromptCaching;

  const existingCaps = normalizeCapabilities(profile.capabilities) ?? {};
  const catalogCapabilities: Partial<Record<ModelCapabilityTag, number>> = {
    ...existingCaps,
  };
  if (entry.supportsVision) catalogCapabilities.vision = 1;
  if (entry.supportsFunctionCalling) catalogCapabilities["tool-use"] = 1;
  if (entry.supportsReasoning) catalogCapabilities.reasoning = 1;

  return {
    ...profile,
    capabilities: catalogCapabilities,
    capabilityFlags,
    pricing: {
      inputCostPerToken: entry.inputCostPerToken,
      outputCostPerToken: entry.outputCostPerToken,
      ...(entry.cacheReadInputCostPerToken !== undefined ? { cacheReadCostPerToken: entry.cacheReadInputCostPerToken } : {}),
      currency: "USD",
    },
    version: {
      ...(entry.releaseDate !== undefined ? { releaseDate: entry.releaseDate } : {}),
      ...(entry.deprecationDate !== undefined ? { deprecationDate: entry.deprecationDate } : {}),
      isDeprecated: !!entry.deprecationDate && new Date(entry.deprecationDate) < new Date(),
    },
    source: "catalog",
  };
}

export function normalizeProfile(profile: ModelProfile): ModelProfile {
  const capabilities = normalizeCapabilities(profile.capabilities);
  const providerId = normalizeOptionalString(profile.providerId);
  const routeId = normalizeOptionalString(profile.routeId);
  const model = normalizeOptionalString(profile.model);
  const upstreamModel = normalizeOptionalString(profile.upstreamModel);
  const endpointSupport = endpointSupportField(profile.endpointSupport);
  const streamingSupport = streamingSupportField(profile.streamingSupport);
  const credentialSource = jsonObjectField(profile.credentialSource);
  const route = routeMetadataField(profile.route);
  const costTier = costTierField(profile.costTier);
  const latencyMs = normalizeOptionalNonNegativeInteger(profile.latencyMs, undefined);
  const contextWindowTokens = normalizeOptionalPositiveInteger(profile.contextWindowTokens, undefined);
  const availability = availabilityField(profile.availability);
  const health = healthField(profile.health);
  const lastSuccess = routeHealthEventField(profile.lastSuccess);
  const lastFailure = routeHealthEventField(profile.lastFailure);
  const priority = normalizeOptionalNonNegativeInteger(profile.priority, undefined);
  return {
    id: normalizeString(profile.id) || normalizeString(profile.model) || "unknown",
    ...(providerId !== undefined ? { providerId } : {}),
    ...(routeId !== undefined ? { routeId } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(upstreamModel !== undefined ? { upstreamModel } : {}),
    ...(endpointSupport !== undefined ? { endpointSupport } : {}),
    ...(streamingSupport !== undefined ? { streamingSupport } : {}),
    ...(credentialSource !== undefined ? { credentialSource } : {}),
    ...(route !== undefined ? { route } : {}),
    aliases: uniqueStrings(profile.aliases ?? []),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(costTier !== undefined ? { costTier } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    ...(availability !== undefined ? { availability } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(lastSuccess !== undefined ? { lastSuccess } : {}),
    ...(lastFailure !== undefined ? { lastFailure } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(profile.metadata !== undefined ? { metadata: profile.metadata } : {})
  };
}

function routeMetadataFromOffer(offer: ProviderRouteOfferLike, override: ModelProviderRouteMetadata | undefined): ModelProviderRouteMetadata {
  const endpointSupport = override?.endpointSupport ?? endpointSupportField(offer.endpointSupport ?? offer.endpointType);
  const streamingSupport = override?.streamingSupport ?? streamingSupportField(offer.streamingSupport);
  const credentialSource = override?.credentialSource ?? offer.credentialSource;
  const health = override?.health ?? offer.health?.status;
  const lastSuccess = override?.lastSuccess ?? routeHealthEventField(offer.health?.lastSuccess, offer.health?.lastSuccessAt, offer.health?.lastLatencyMs);
  const lastFailure = override?.lastFailure ?? routeHealthEventField(offer.health?.lastFailure, offer.health?.lastFailureAt, undefined);
  return {
    providerId: override?.providerId ?? offer.providerId,
    routeId: override?.routeId ?? offer.id,
    model: override?.model ?? offer.model,
    upstreamModel: override?.upstreamModel ?? offer.upstreamModel ?? offer.model,
    ...(endpointSupport !== undefined ? { endpointSupport } : {}),
    ...(streamingSupport !== undefined ? { streamingSupport } : {}),
    ...(credentialSource !== undefined ? { credentialSource } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(lastSuccess !== undefined ? { lastSuccess } : {}),
    ...(lastFailure !== undefined ? { lastFailure } : {}),
    ...(override?.metadata !== undefined ? { metadata: override?.metadata } : {})
  };
}

function normalizeCapabilities(capabilities: Partial<Record<ModelCapabilityTag, number | boolean>> | undefined): Partial<Record<ModelCapabilityTag, number>> | undefined {
  if (!capabilities) return undefined;
  const entries = Object.entries(capabilities)
    .map(([tag, value]): [ModelCapabilityTag, number] | undefined => {
      const normalizedTag = normalizeString(tag);
      if (!normalizedTag) return undefined;
      if (value === true) return [normalizedTag, 1];
      if (value === false) return [normalizedTag, 0];
      const number = Number(value);
      if (!Number.isFinite(number)) return undefined;
      return [normalizedTag, clamp(number, 0, 1)];
    })
    .filter((entry): entry is [ModelCapabilityTag, number] => Boolean(entry));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function capabilitiesField(value: unknown): Partial<Record<ModelCapabilityTag, number>> | undefined {
  if (!isRecord(value)) return undefined;
  return normalizeCapabilities(value as Partial<Record<ModelCapabilityTag, number | boolean>>);
}

function costTierField(value: unknown): ModelCostTier | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return clamp(Math.trunc(value), 0, 5);
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return KNOWN_COST_TIERS.includes(normalized as ModelCostTier) ? (normalized as ModelCostTier) : undefined;
}

function availabilityField(value: unknown): ModelAvailability | undefined {
  if (value === "available" || value === "limited" || value === "unavailable" || value === "unknown") return value;
  return undefined;
}

function healthField(value: unknown): ModelHealthStatus | undefined {
  if (value === "healthy" || value === "degraded" || value === "unhealthy" || value === "unknown") return value;
  return undefined;
}

function endpointSupportField(value: unknown): ProviderEndpointSupport | undefined {
  if (value === "responses" || value === "chat-completions" || value === "auto") return value;
  return undefined;
}

function streamingSupportField(value: unknown): ProviderStreamingSupport | undefined {
  if (value === "streaming" || value === "non-streaming" || value === "optional" || value === "unknown") return value;
  if (value === true) return "streaming";
  if (value === false) return "non-streaming";
  return undefined;
}

function endpointSupportMatches(actual: ProviderEndpointSupport | undefined, required: ProviderEndpointSupport[]): boolean {
  if (!actual) return false;
  if (actual === "auto") return true;
  return required.includes(actual) || required.includes("auto");
}

function streamingSupportMatches(actual: ProviderStreamingSupport | undefined, required: ProviderStreamingSupport[]): boolean {
  if (!actual) return false;
  if (actual === "optional") return true;
  return required.includes(actual) || required.includes("optional");
}

export { endpointSupportField, streamingSupportField, endpointSupportMatches, streamingSupportMatches, costTierField, availabilityField, healthField };

function uniqueEndpointSupport(values: unknown[]): ProviderEndpointSupport[] {
  return uniqueStrings(values).filter((value): value is ProviderEndpointSupport => endpointSupportField(value) !== undefined);
}

function uniqueStreamingSupport(values: unknown[]): ProviderStreamingSupport[] {
  return uniqueStrings(values).filter((value): value is ProviderStreamingSupport => streamingSupportField(value) !== undefined);
}

export { uniqueEndpointSupport, uniqueStreamingSupport };

function routeHealthEventField(value: unknown, at?: number | null, latencyMs?: number | null): ProviderRouteHealthEvent | undefined {
  const event = isRecord(value) ? value : undefined;
  const normalizedAt = nullableNumberField(event?.at ?? at);
  const normalizedLatency = nullableNumberField(event?.latencyMs ?? latencyMs);
  const errorCode = nullableStringField(event?.errorCode);
  const metadata = jsonObjectField(event?.metadata);
  if (normalizedAt === undefined && normalizedLatency === undefined && errorCode === undefined && metadata === undefined) return undefined;
  return compactJson({
    at: normalizedAt ?? null,
    latencyMs: normalizedLatency ?? null,
    errorCode: errorCode ?? null,
    metadata
  }) as unknown as ProviderRouteHealthEvent;
}

export { routeHealthEventField };

function routeMetadataField(value: unknown): ModelProviderRouteMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = stringField(value.providerId);
  const routeId = stringField(value.routeId);
  const model = stringField(value.model);
  const upstreamModel = stringField(value.upstreamModel);
  const endpointSupport = endpointSupportField(value.endpointSupport);
  const streamingSupport = streamingSupportField(value.streamingSupport);
  const credentialSource = jsonObjectField(value.credentialSource);
  const health = healthField(value.health);
  const lastSuccess = routeHealthEventField(value.lastSuccess);
  const lastFailure = routeHealthEventField(value.lastFailure);
  const metadata = jsonObjectField(value.metadata);
  if (
    providerId === undefined &&
    routeId === undefined &&
    model === undefined &&
    upstreamModel === undefined &&
    endpointSupport === undefined &&
    streamingSupport === undefined &&
    credentialSource === undefined &&
    health === undefined &&
    lastSuccess === undefined &&
    lastFailure === undefined &&
    metadata === undefined
  ) {
    return undefined;
  }
  return compactJson({
    providerId,
    routeId,
    model,
    upstreamModel,
    endpointSupport,
    streamingSupport,
    credentialSource,
    health,
    lastSuccess: lastSuccess as unknown as JsonObject | undefined,
    lastFailure: lastFailure as unknown as JsonObject | undefined,
    metadata
  }) as unknown as ModelProviderRouteMetadata;
}

export { routeMetadataField };

function stringArrayField(value: unknown): string[] | undefined {
  return Array.isArray(value) ? uniqueStrings(value) : undefined;
}

function jsonObjectField(value: unknown): JsonObject | undefined {
  return isRecord(value) ? (value as JsonObject) : undefined;
}

function uniqueTags(values: ModelCapabilityTag[]): ModelCapabilityTag[] {
  return uniqueStrings(values) as ModelCapabilityTag[];
}

export { uniqueTags };

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => normalizeString(value)).filter((value) => value.length > 0))].sort();
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized || undefined;
}

function stringField(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function nonNegativeNumberField(value: unknown): number | undefined {
  return normalizeOptionalNonNegativeInteger(value, undefined);
}

function positiveIntegerField(value: unknown): number | undefined {
  return normalizeOptionalPositiveInteger(value, undefined);
}

function normalizeOptionalNonNegativeInteger(value: unknown, fallback: number): number;
function normalizeOptionalNonNegativeInteger(value: unknown, fallback: undefined): number | undefined;
function normalizeOptionalNonNegativeInteger(value: unknown, fallback: number | undefined): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.trunc(number));
}

function normalizeOptionalPositiveInteger(value: unknown, fallback: number): number;
function normalizeOptionalPositiveInteger(value: unknown, fallback: undefined): number | undefined;
function normalizeOptionalPositiveInteger(value: unknown, fallback: number | undefined): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.trunc(number);
}

function nullableNumberToUndefined(value: number | null | undefined): number | undefined {
  return value == null ? undefined : value;
}

function nullableNumberField(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : undefined;
}

function nullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return stringField(value);
}

function compactJson(input: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as JsonObject;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatScore(value: number): string {
  return roundScore(value).toString();
}

export { compactJson, clamp, roundScore, formatScore, normalizeString, uniqueStrings, stringField, normalizeOptionalNonNegativeInteger, normalizeOptionalPositiveInteger, nullableNumberToUndefined, nullableNumberField, nullableStringField };
