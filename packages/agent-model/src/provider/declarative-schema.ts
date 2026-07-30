const PROVIDER_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
const MAX_MODEL_ID_LENGTH = 128;

const KNOWN_DECLARATIVE_FIELDS = new Set([
  'providerId',
  'name',
  'description',
  'website',
  'docsUrl',
  'engine',
  'baseUrl',
  'auth',
  'models',
  'endpointType',
  'streamingSupport',
  'paths',
  'capabilities',
  'engineOptions',
  'rateLimiting',
  'metadata',
]);

export function validateProviderId(providerId: string): void {
  if (!PROVIDER_ID_REGEX.test(providerId)) {
    throw new Error(
      `Invalid providerId "${providerId}": only alphanumeric characters, hyphens, and underscores are allowed`
    );
  }
}

export interface DeclarativeProviderDef {
  providerId: string;
  name: string;
  description?: string;
  website?: string;
  docsUrl?: string;

  engine: 'openai-compatible' | 'anthropic-messages' | 'ollama';
  baseUrl: string;

  auth?: {
    type: 'api-key' | 'bearer' | 'header' | 'none';
    placement: 'header' | 'query';
    keyHeader?: string;
    defaultEnvVar?: string;
  };

  models: Array<{
    id: string;
    aliases?: string[];
    capabilities?: string[];
    contextWindow?: number;
    maxOutputTokens?: number;
    costPer1kInput?: number;
    costPer1kOutput?: number;
  }>;

  endpointType?: 'chat-completions' | 'responses' | 'auto';
  streamingSupport?: 'streaming' | 'non-streaming' | 'optional';

  paths?: {
    chatCompletions?: string;
    responses?: string;
    models?: string;
  };

  capabilities?: {
    toolUse?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    streaming?: boolean;
    systemPrompt?: boolean;
    jsonMode?: boolean;
    parallelToolCalls?: boolean;
  };

  engineOptions?: {
    authHeader?: 'authorization' | 'x-api-key' | 'x-goog-api-key' | 'custom';
    maxTokensField?:
      'max_tokens' | 'max_completion_tokens' | 'max_output_tokens' | 'none';
    reasoningContent?: 'omit' | 'text-delta' | 'thought-delta';
    toolChoice?: 'auto' | 'required' | 'none';
    anthropicVersion?: string;
    keepAlive?: string;
  };

  rateLimiting?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
  };

  metadata?: Record<string, unknown>;
}

export interface NormalizedDeclarativeDef {
  providerId: string;
  engine: 'openai-compatible' | 'anthropic-messages' | 'ollama';
  baseUrl: string;
  auth: {
    type: 'api-key' | 'bearer' | 'header' | 'none';
    placement: 'header' | 'query';
    keyHeader: string;
    defaultEnvVar: string;
  };
  models: Array<{
    id: string;
    aliases: string[];
    capabilities: string[];
    contextWindow: number;
    maxOutputTokens: number;
    costPer1kInput: number;
    costPer1kOutput: number;
  }>;
  paths: {
    chatCompletions: string;
    responses?: string | undefined;
    models: string;
  };
  capabilities: {
    toolUse: boolean;
    vision: boolean;
    reasoning: boolean;
    streaming: boolean;
    systemPrompt: boolean;
    jsonMode: boolean;
    parallelToolCalls: boolean;
  };
  engineOptions: {
    authHeader: string;
    maxTokensField: string;
    reasoningContent: string;
    toolChoice: string;
    anthropicVersion: string;
    keepAlive: string;
  };
  rateLimiting: { requestsPerMinute: number; tokensPerMinute: number };
  metadata: Record<string, unknown>;
}

export function normalizeDeclarativeDef(
  raw: DeclarativeProviderDef
): NormalizedDeclarativeDef {
  validateProviderId(raw.providerId);

  for (const key of Object.keys(raw)) {
    if (!KNOWN_DECLARATIVE_FIELDS.has(key)) {
      console.warn(
        `[normalizeDeclarativeDef] Unknown field "${key}" will be ignored`
      );
    }
  }

  for (const model of raw.models ?? []) {
    if (model.id.length > MAX_MODEL_ID_LENGTH) {
      throw new Error(
        `Model id "${model.id}" exceeds maximum length of ${MAX_MODEL_ID_LENGTH} characters (${model.id.length})`
      );
    }
  }

  return {
    providerId: raw.providerId,
    engine: raw.engine,
    baseUrl: raw.baseUrl.replace(/\/+$/, ''),
    auth: {
      type: raw.auth?.type ?? 'api-key',
      placement: raw.auth?.placement ?? 'header',
      keyHeader:
        raw.auth?.keyHeader ??
        (raw.auth?.type === 'bearer' ? 'Authorization' : 'x-api-key'),
      defaultEnvVar:
        raw.auth?.defaultEnvVar ??
        `${raw.providerId.replace(/-/g, '_').toUpperCase()}_API_KEY`,
    },
    models: (raw.models ?? []).map((m) => ({
      id: m.id,
      aliases: m.aliases ?? [],
      capabilities: m.capabilities ?? [],
      contextWindow: m.contextWindow ?? 4096,
      maxOutputTokens: m.maxOutputTokens ?? 4096,
      costPer1kInput: m.costPer1kInput ?? 0,
      costPer1kOutput: m.costPer1kOutput ?? 0,
    })),
    paths: {
      chatCompletions: raw.paths?.chatCompletions ?? '/v1/chat/completions',
      responses: raw.paths?.responses,
      models: raw.paths?.models ?? '/v1/models',
    },
    capabilities: {
      toolUse: raw.capabilities?.toolUse ?? false,
      vision: raw.capabilities?.vision ?? false,
      reasoning: raw.capabilities?.reasoning ?? false,
      streaming: raw.capabilities?.streaming ?? true,
      systemPrompt: raw.capabilities?.systemPrompt ?? true,
      jsonMode: raw.capabilities?.jsonMode ?? false,
      parallelToolCalls: raw.capabilities?.parallelToolCalls ?? false,
    },
    engineOptions: {
      authHeader: raw.engineOptions?.authHeader ?? 'authorization',
      maxTokensField: raw.engineOptions?.maxTokensField ?? 'max_tokens',
      reasoningContent: raw.engineOptions?.reasoningContent ?? 'omit',
      toolChoice: raw.engineOptions?.toolChoice ?? 'auto',
      anthropicVersion: raw.engineOptions?.anthropicVersion ?? '2023-06-01',
      keepAlive: raw.engineOptions?.keepAlive ?? '5m',
    },
    rateLimiting: {
      requestsPerMinute: raw.rateLimiting?.requestsPerMinute ?? 0,
      tokensPerMinute: raw.rateLimiting?.tokensPerMinute ?? 0,
    },
    metadata: raw.metadata ?? {},
  };
}
