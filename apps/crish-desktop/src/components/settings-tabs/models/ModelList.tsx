/**
 * Model profile list and default model selection cascade components.
 */
import React from 'react';
import {
  ModelProfileList,
  ModelsCascadeSelect,
} from '../../settings-models/ModelProfileList';
import type { ProviderProfile } from '../../../api/providerProfiles';

export { ModelProfileList, ModelsCascadeSelect };

interface ModelListProps {
  profiles: ProviderProfile[];
  selectedId: string | null;
  onSelectProfile: (id: string) => void;
}

export const ModelList: React.FC<ModelListProps> = ({
  profiles,
  selectedId,
  onSelectProfile,
}) => {
  return (
    <ModelProfileList
      profiles={profiles}
      selectedId={selectedId}
      onSelectProfile={onSelectProfile}
    />
  );
};
