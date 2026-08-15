import {
  type ModelCapabilityKey,
  MODEL_CAPABILITY_OPTIONS,
  setModelCapability,
  setModelContextLength,
  setModelDisplayName,
} from '../../api/modelCatalog';

export interface AddModelDraft {
  modelId: string;
  displayName: string;
  contextLength: string;
  caps: Record<ModelCapabilityKey, boolean>;
}

export function emptyAddDraft(): AddModelDraft {
  return {
    modelId: '',
    displayName: '',
    contextLength: '',
    caps: {
      tools: true,
      vision: false,
      reasoning: false,
    },
  };
}

export interface ConfigDraft {
  displayName: string;
  contextLength: string;
  caps: Record<ModelCapabilityKey, boolean>;
}

export function applyMetaForModel(
  profileId: string,
  modelId: string,
  draft: {
    displayName: string;
    contextLength: string;
    caps: Record<ModelCapabilityKey, boolean>;
  }
): void {
  if (draft.displayName.trim()) {
    setModelDisplayName(profileId, modelId, draft.displayName.trim());
  }
  const n = parseInt(draft.contextLength.replace(/[^\d]/g, ''), 10);
  if (Number.isFinite(n) && n > 0) {
    setModelContextLength(profileId, modelId, n);
  }
  for (const opt of MODEL_CAPABILITY_OPTIONS) {
    setModelCapability(
      profileId,
      modelId,
      opt.key,
      Boolean(draft.caps[opt.key])
    );
  }
}
