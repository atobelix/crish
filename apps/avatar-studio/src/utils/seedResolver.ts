import { ARCHETYPES, type ArchetypeId } from '../constants/archetypes';
import { SUNLIT_PALETTES, type PaletteDef } from '../constants/palettes';

/**
 * 简单快速的字符串哈希算法 (djb2)
 */
export function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface ResolvedSeedResult {
  archetype: ArchetypeId;
  palette: PaletteDef;
}

export function resolveAvatarFromSeed(seed: string): ResolvedSeedResult {
  const hash = hashString(seed || 'conex-user');
  
  const archetypeIndex = hash % ARCHETYPES.length;
  const archetype = ARCHETYPES[archetypeIndex];

  // 优先匹配 archetype 默认搭配的调色板，或者基于二次哈希选取
  const paletteMatch = SUNLIT_PALETTES.find((p) => p.id === archetype.defaultPaletteId);
  const palette = paletteMatch || SUNLIT_PALETTES[(hash >> 3) % SUNLIT_PALETTES.length];

  return {
    archetype: archetype.id,
    palette,
  };
}
