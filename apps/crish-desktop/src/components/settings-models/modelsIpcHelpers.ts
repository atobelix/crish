import type { ModelCapabilityKey } from '../../api/modelCatalogTypes';
import type { ModelProtocol } from '../../api/modelsCatalogTypes';

export interface AddModelDraft {
  modelId: string;
  displayName: string;
  contextLength: string;
  maxOutputTokens?: string;
  caps: Record<ModelCapabilityKey, boolean>;
  thinkingLevel?: string;
  protocol?: ModelProtocol;
  modalities?: {
    input: string[];
    output: string[];
  };
  thinkingEnabled?: boolean;
  thinkingMap?: Record<string, string>;
  pricing?: {
    currency: 'USD' | 'CNY';
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
  };
}

export function emptyAddDraft(): AddModelDraft {
  return {
    modelId: '',
    displayName: '',
    contextLength: '',
    maxOutputTokens: '',
    caps: {
      tools: true,
      image: false,
      video: false,
      reasoning: false,
    },
    modalities: {
      input: ['text', 'image'],
      output: ['text'],
    },
    thinkingEnabled: false,
  };
}

export interface ConfigDraft {
  displayName: string;
  contextLength: string;
  maxOutputTokens?: string;
  caps: Record<ModelCapabilityKey, boolean>;
  thinkingLevel?: string;
  protocol?: ModelProtocol;
  modalities?: {
    input: string[];
    output: string[];
  };
  thinkingEnabled?: boolean;
  thinkingMap?: Record<string, string>;
  pricing?: {
    currency: 'USD' | 'CNY';
    input?: string;
    output?: string;
    cacheRead?: string;
    cacheWrite?: string;
  };
}
