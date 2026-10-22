// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { GENERAL_FOLDER } from '../../../api/projectStore';
import {
  folderContainerSelector,
  isGeneralFolderName,
  previewToInsertBeforeId,
} from './sessionListDropTarget';

describe('sessionListDropTarget', () => {
  it('previewToInsertBeforeId：before 原样返回，after 取下一行，末行为 null', () => {
    const ids = ['a', 'b', 'c'];
    expect(previewToInsertBeforeId(ids, null, 'before')).toBeNull();
    expect(previewToInsertBeforeId(ids, 'b', 'before')).toBe('b');
    expect(previewToInsertBeforeId(ids, 'b', 'after')).toBe('c');
    expect(previewToInsertBeforeId(ids, 'c', 'after')).toBeNull();
    expect(previewToInsertBeforeId(ids, 'x', 'after')).toBe('x');
  });

  it('isGeneralFolderName：空白与常规分组别名视为常规分组', () => {
    for (const name of [
      undefined,
      null,
      '',
      '  ',
      GENERAL_FOLDER,
      '会话',
      '常规会话',
      'general',
    ]) {
      expect(isGeneralFolderName(name)).toBe(true);
    }
    expect(isGeneralFolderName('项目 A')).toBe(false);
  });

  it('folderContainerSelector：常规分组走 general 落区，其余按 data-folder-name 精确匹配', () => {
    expect(folderContainerSelector('general')).toBe(
      '[data-drop-zone="general"]'
    );
    const sel = folderContainerSelector('a"b');
    const el = document.createElement('div');
    el.setAttribute('data-folder-name', 'a"b');
    document.body.appendChild(el);
    expect(document.querySelector(sel)).toBe(el);
    el.remove();
  });
});
