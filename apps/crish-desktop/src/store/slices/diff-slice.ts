import { upsertDiffFile } from '../layoutHelpers';
import type { FileDiff } from '../types';

export interface DiffSlice {
  activeDiffSource: FileDiff | null;
  diffFiles: FileDiff[];
  setActiveDiffSource: (diff: FileDiff | null) => void;
  setDiffFiles: (files: FileDiff[] | ((prev: FileDiff[]) => FileDiff[])) => void;
  pushDiffFile: (diff: FileDiff) => void;
  removeDiffFile: (filePath: string) => void;
}

export type DiffImmerSet = (recipe: (state: DiffSlice) => void) => void;
export type DiffGet = () => DiffSlice;

export function createInitialDiffState(): Pick<DiffSlice, 'activeDiffSource' | 'diffFiles'> {
  return { activeDiffSource: null, diffFiles: [] };
}

export function createDiffActions(set: DiffImmerSet, get: DiffGet): Pick<DiffSlice, 'setActiveDiffSource' | 'setDiffFiles' | 'pushDiffFile' | 'removeDiffFile'> {
  return {
    setActiveDiffSource: (diff) =>
      set((state) => {
        state.activeDiffSource = diff;
        if (diff) upsertDiffFile(state.diffFiles, diff);
      }),
    setDiffFiles: (files) =>
      set((state) => {
        const next = typeof files === 'function' ? (files as (prev: FileDiff[]) => FileDiff[])(state.diffFiles) : files;
        state.diffFiles = Array.isArray(next) ? next : [];
        state.activeDiffSource = state.diffFiles[0] || null;
      }),
    pushDiffFile: (diff) =>
      set((state) => {
        upsertDiffFile(state.diffFiles, diff);
        state.activeDiffSource = diff;
      }),
    removeDiffFile: (filePath) =>
      set((state) => {
        const path = filePath || '';
        state.diffFiles = state.diffFiles.filter((f) => f.filePath !== path);
        if (state.activeDiffSource?.filePath === path) state.activeDiffSource = state.diffFiles[0] || null;
      }),
  };
}
