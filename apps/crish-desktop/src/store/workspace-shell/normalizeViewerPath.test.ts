import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeViewerFilePath } from './normalizeViewerPath';
import * as workspaceFsApi from '../../api/workspaceFsApi';

describe('normalizeViewerFilePath (DETAIL-PLAN-03 纯逻辑归一化测试)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. 空值与脏输入防护：输入空值或非字符串返回空串', () => {
    expect(normalizeViewerFilePath('')).toBe('');
    expect(normalizeViewerFilePath('   ')).toBe('');
    expect(normalizeViewerFilePath(null as unknown as string)).toBe('');
    expect(normalizeViewerFilePath(undefined as unknown as string)).toBe('');
  });

  it('2. Windows 盘符大小写收敛：强制将驱动器盘符转为统一大写 (C:/...)', () => {
    expect(normalizeViewerFilePath('c:/software/conex/src/App.tsx')).toBe(
      'C:/software/conex/src/App.tsx'
    );
    expect(normalizeViewerFilePath('d:/repo/test.rs')).toBe('D:/repo/test.rs');
    expect(normalizeViewerFilePath('C:/Already/Upper.ts')).toBe(
      'C:/Already/Upper.ts'
    );
  });

  it('3. 反斜杠自动替换：将 Windows 反斜杠统统转换为标准正斜杠', () => {
    expect(
      normalizeViewerFilePath('C:\\Software\\conex\\src\\components\\Diff.tsx')
    ).toBe('C:/Software/conex/src/components/Diff.tsx');
    expect(normalizeViewerFilePath('c:\\windows\\system32\\drivers')).toBe(
      'C:/windows/system32/drivers'
    );
  });

  it('4. 冗余当前目录 ./ 与 /./ 彻底剥离', () => {
    expect(normalizeViewerFilePath('./src/main.ts')).toBe(
      normalizeViewerFilePath('src/main.ts')
    );
    expect(normalizeViewerFilePath('C:/repo/./src/./index.ts')).toBe(
      'C:/repo/src/index.ts'
    );
  });

  it('5. UNC 网络共享与 WSL 路径保护：保留开头的双正斜杠', () => {
    expect(normalizeViewerFilePath('\\\\wsl.localhost\\Ubuntu\\home\\user\\proj')).toBe(
      '//wsl.localhost/Ubuntu/home/user/proj'
    );
    expect(normalizeViewerFilePath('//server/share/folder/file.txt')).toBe(
      '//server/share/folder/file.txt'
    );
  });

  it('6. 相对路径基于工作区路径规范拼接，且工作区盘符同样大写化', () => {
    vi.spyOn(workspaceFsApi, 'getWorkspacePath').mockReturnValue('c:/my-workspace');
    expect(normalizeViewerFilePath('src/models/user.ts')).toBe(
      'C:/my-workspace/src/models/user.ts'
    );
    expect(normalizeViewerFilePath('./package.json')).toBe(
      'C:/my-workspace/package.json'
    );
  });

  it('7. 尾部斜杠修剪：除根目录外一律剥离多余尾部斜杠', () => {
    expect(normalizeViewerFilePath('C:/Software/conex/')).toBe(
      'C:/Software/conex'
    );
    expect(normalizeViewerFilePath('/')).toBe('/');
    expect(normalizeViewerFilePath('C:/')).toBe('C:/');
  });
});
