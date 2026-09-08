// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  toCanonicalFsPath,
  isSameFsPath,
  getAncestorDirPaths,
  listDirectory,
  readTextFile,
  writeTextFile,
} from '../workspaceFsApi';
import {
  openFileInPanel,
  registerFileViewerOpener,
  takePendingOpenPath,
} from '../filePanelOpener';
import * as tauriInvoke from '../tauriInvoke';

describe('Wave 1 核心规范与契约验收套件 (SPEC-01)', () => {
  const WORKSPACE_KEY = 'crish_workspace';

  beforeEach(() => {
    localStorage.setItem(WORKSPACE_KEY, 'c:/Software/conex');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. toCanonicalFsPath 跨平台路径规范化纯函数
  // ─────────────────────────────────────────────────────────────────────────
  describe('toCanonicalFsPath 纯函数', () => {
    it('1.1 基础转换：Windows 反斜杠统一转换为正斜杠', () => {
      expect(toCanonicalFsPath('c:\\work\\project\\file.ts')).toBe('c:/work/project/file.ts');
      expect(toCanonicalFsPath('c:\\work\\sub\\')).toBe('c:/work/sub');
      expect(toCanonicalFsPath('src\\components\\Button.tsx')).toBe('src/components/Button.tsx');
    });

    it('1.2 盘符小写标准化：Windows 盘符统一强制小写（对齐 HB-16 与 master-plan）', () => {
      expect(toCanonicalFsPath('C:/work/project')).toBe('c:/work/project');
      expect(toCanonicalFsPath('D:\\data\\doc.pdf')).toBe('d:/data/doc.pdf');
      expect(toCanonicalFsPath('Z:/')).toBe('z:/');
      expect(toCanonicalFsPath('C:')).toBe('c:/');
      expect(toCanonicalFsPath('c:')).toBe('c:/');
    });

    it('1.3 根路径保护：保留盘符根与 POSIX/UNC 根末尾斜杠，剔除其余非根末尾斜杠', () => {
      expect(toCanonicalFsPath('c:/')).toBe('c:/');
      expect(toCanonicalFsPath('C:\\')).toBe('c:/');
      expect(toCanonicalFsPath('/')).toBe('/');
      expect(toCanonicalFsPath('//')).toBe('//');
      expect(toCanonicalFsPath('c:/work/')).toBe('c:/work');
      expect(toCanonicalFsPath('/usr/local/bin/')).toBe('/usr/local/bin');
    });

    it('1.4 冗余清理：非 UNC 连续多余斜杠压缩为单斜杠', () => {
      expect(toCanonicalFsPath('c://work///sub////file.ts')).toBe('c:/work/sub/file.ts');
      expect(toCanonicalFsPath('/usr///local//bin')).toBe('/usr/local/bin');
      expect(toCanonicalFsPath('///root///dir')).toBe('/root/dir');
    });

    it('1.5 UNC 路径支持：正确保留前导双斜杠并规范化内部路径', () => {
      expect(toCanonicalFsPath('\\\\server\\share\\folder\\file.txt')).toBe('//server/share/folder/file.txt');
      expect(toCanonicalFsPath('//wsl$/Ubuntu//var///log')).toBe('//wsl$/Ubuntu/var/log');
      expect(toCanonicalFsPath('//server/share/')).toBe('//server/share');
    });

    it('1.6 相对段消解与防越界栈消除：消解 /./ 与 /../，杜绝绝对路径越界逃逸', () => {
      expect(toCanonicalFsPath('c:/work/./src/./components/App.tsx')).toBe('c:/work/src/components/App.tsx');
      expect(toCanonicalFsPath('c:/work/sub/..')).toBe('c:/work');
      expect(toCanonicalFsPath('c:/work/sub/../file.ts')).toBe('c:/work/file.ts');
      expect(toCanonicalFsPath('c:/work/././dir')).toBe('c:/work/dir');
      // 绝对路径到顶不越界逃逸
      expect(toCanonicalFsPath('c:/..')).toBe('c:/');
      expect(toCanonicalFsPath('c:/../../work')).toBe('c:/work');
      // 保持隐藏文件与多扩展名无损
      expect(toCanonicalFsPath('c:/work/.gitignore')).toBe('c:/work/.gitignore');
      expect(toCanonicalFsPath('c:/work/.env.local')).toBe('c:/work/.env.local');
    });

    it('1.7 空值防御：空串、纯空白、无效输入恒定返回空串', () => {
      expect(toCanonicalFsPath('')).toBe('');
      expect(toCanonicalFsPath('   ')).toBe('');
      // @ts-expect-error 测试非字符串类型防御
      expect(toCanonicalFsPath(null)).toBe('');
      // @ts-expect-error 测试非字符串类型防御
      expect(toCanonicalFsPath(undefined)).toBe('');
    });

    it('1.8 严格幂等律：toCanonicalFsPath(toCanonicalFsPath(p)) === toCanonicalFsPath(p)', () => {
      const samples = [
        'C:\\Users\\test/Documents\\file.txt',
        '//server//share///a/./b/../c/',
        'D:/work/./././src/',
        '/var//log/nginx/',
      ];
      for (const p of samples) {
        const pass1 = toCanonicalFsPath(p);
        const pass2 = toCanonicalFsPath(pass1);
        expect(pass2).toBe(pass1);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. isSameFsPath 跨平台路径等值比对
  // ─────────────────────────────────────────────────────────────────────────
  describe('isSameFsPath 纯函数', () => {
    it('2.1 Windows 平台：大小写不敏感与反斜杠不敏感等值比对', () => {
      expect(isSameFsPath('c:\\work\\file.ts', 'C:/work/file.ts')).toBe(true);
      expect(isSameFsPath('C:/WORK/SUB', 'c:\\work\\sub\\')).toBe(true);
      expect(isSameFsPath('d:/test/a.txt', 'D:/TEST/A.TXT')).toBe(true);
    });

    it('2.2 Windows 平台：不同驱动器盘符判定为不同', () => {
      expect(isSameFsPath('c:/work/file.ts', 'd:/work/file.ts')).toBe(false);
      expect(isSameFsPath('c:/data', 'e:/data')).toBe(false);
    });

    it('2.3 UNC 路径：大小写不敏感等值比对', () => {
      expect(isSameFsPath('\\\\SERVER\\SHARE\\a.txt', '//server/share/A.TXT')).toBe(true);
      expect(isSameFsPath('//wsl$/ubuntu/file', '//WSL$/Ubuntu/file')).toBe(true);
    });

    it('2.4 空值与异常防御：任一路径为空恒定返回 false', () => {
      expect(isSameFsPath('', '')).toBe(false);
      expect(isSameFsPath('c:/work', '')).toBe(false);
      expect(isSameFsPath('', 'c:/work')).toBe(false);
      expect(isSameFsPath(null, 'c:/work')).toBe(false);
      expect(isSameFsPath('c:/work', undefined)).toBe(false);
    });

    it('2.5 代数公理验证：自反性与对称性', () => {
      const p1 = 'c:\\proj\\sub\\a.ts';
      const p2 = 'C:/PROJ/SUB/A.TS';
      expect(isSameFsPath(p1, p1)).toBe(true);
      expect(isSameFsPath(p1, p2)).toBe(isSameFsPath(p2, p1));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. getAncestorDirPaths 祖先链推导
  // ─────────────────────────────────────────────────────────────────────────
  describe('getAncestorDirPaths 纯函数', () => {
    it('3.1 典型深层文件：正确定向输出自上而下祖先链', () => {
      const target = 'c:/Software/conex/apps/crish-desktop/src/App.tsx';
      const root = 'c:/Software/conex';
      const expected = [
        'c:/Software/conex/apps',
        'c:/Software/conex/apps/crish-desktop',
        'c:/Software/conex/apps/crish-desktop/src',
      ];
      expect(getAncestorDirPaths(target, root)).toEqual(expected);
    });

    it('3.2 异构路径与盘符大小写混杂输入：精确匹配并规范化小写输出', () => {
      const target = 'C:\\Software\\conex\\packages\\ui\\src\\Button.tsx';
      const root = 'c:/SOFTWARE/CONEX/';
      const expected = [
        'c:/Software/conex/packages',
        'c:/Software/conex/packages/ui',
        'c:/Software/conex/packages/ui/src',
      ];
      expect(getAncestorDirPaths(target, root)).toEqual(expected);
    });

    it('3.3 根目录直属子文件：祖先集恒为空数组（无需展开祖先）', () => {
      const target = 'c:/Software/conex/README.md';
      const root = 'c:/Software/conex';
      expect(getAncestorDirPaths(target, root)).toEqual([]);
    });

    it('3.4 目标与根相同：祖先集恒为空数组', () => {
      expect(getAncestorDirPaths('c:/Software/conex', 'c:/Software/conex')).toEqual([]);
      expect(getAncestorDirPaths('C:\\software\\conex\\', 'c:/Software/conex')).toEqual([]);
    });

    it('3.5 越界隔离防御：兄弟前缀目录坚决拒绝', () => {
      // 兄弟前缀：c:/work 与 c:/work-extra，前缀相似但非子路径
      const target = 'c:/work-extra/src/file.ts';
      const root = 'c:/work';
      expect(getAncestorDirPaths(target, root)).toEqual([]);
    });

    it('3.6 跨盘符与树外路径防御：坚决拒绝返回空数组', () => {
      expect(getAncestorDirPaths('d:/other/project/file.ts', 'c:/project')).toEqual([]);
      expect(getAncestorDirPaths('c:/Windows/System32/cmd.exe', 'c:/Software/conex')).toEqual([]);
    });

    it('3.7 空值防御：目标或根为空时恒定返回空数组', () => {
      expect(getAncestorDirPaths('', 'c:/work')).toEqual([]);
      expect(getAncestorDirPaths('c:/work/sub/file.ts', '')).toEqual([]);
      expect(getAncestorDirPaths('   ', '   ')).toEqual([]);
    });

    it('3.8 拓扑递进长度不变性：祖先链长度严格等于深度差', () => {
      const root = 'c:/a';
      const target = 'c:/a/1/2/3/4/5/file.ts';
      const ancestors = getAncestorDirPaths(target, root);
      expect(ancestors).toHaveLength(5);
      expect(ancestors[0]).toBe('c:/a/1');
      expect(ancestors[4]).toBe('c:/a/1/2/3/4/5');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. 1:1 IPC 契约校准与刚性负向断言（CRIT-02 & NEG-01）
  // ─────────────────────────────────────────────────────────────────────────
  describe('listDirectory IPC 契约校准与负向守门断言', () => {
    it('[CRIT-02 & NEG-01] 出站 IPC 参数仅发 { path }，绝对无 workspaceRoot 幽灵字段', async () => {
      const invokeSpy = vi.spyOn(tauriInvoke, 'invokeResult').mockResolvedValue({
        status: 'ok',
        data: { items: [] },
      });

      await listDirectory('c:/Software/conex/src');

      expect(invokeSpy).toHaveBeenCalledTimes(1);
      const [cmd, payload] = invokeSpy.mock.calls[0] as [string, Record<string, unknown>];
      
      // 1. 命令名称对齐
      expect(cmd).toBe('workbench_list_directory');
      // 2. 刚性负向断言：出站参数绝无 workspaceRoot
      expect(payload).toHaveProperty('path');
      expect(payload.workspaceRoot).toBeUndefined();
      expect(Object.keys(payload)).toEqual(['path']);
      expect(payload.path).toBe('c:/Software/conex/src');
    });

    it('[NEG-07] readTextFile / writeTextFile 出站负载同样零 workspaceRoot（全域闭环）', async () => {
      const invokeSpy = vi.spyOn(tauriInvoke, 'invokeResult');
      invokeSpy.mockResolvedValueOnce({
        status: 'ok',
        data: { content: 'x', lineCount: 1, truncated: false },
      });
      await readTextFile('c:/Software/conex/src/a.ts', 400);

      const [readCmd, readPayload] = invokeSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(readCmd).toBe('workbench_read_file_content');
      expect(readPayload.workspaceRoot).toBeUndefined();
      expect(Object.keys(readPayload)).toEqual(['path', 'maxLines']);

      invokeSpy.mockResolvedValueOnce({ status: 'ok', data: {} });
      await writeTextFile('c:/Software/conex/src/a.ts', 'new', true);

      const [writeCmd, writePayload] = invokeSpy.mock.calls[1] as [string, Record<string, unknown>];
      expect(writeCmd).toBe('workbench_write_file_content');
      expect(writePayload.workspaceRoot).toBeUndefined();
      expect(Object.keys(writePayload)).toEqual(['path', 'content', 'overwrite']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. 广播总线与预览宿主彻底解耦断言（CRIT-01）
  // ─────────────────────────────────────────────────────────────────────────
  describe('openFileInPanel 广播解耦断言', () => {
    it('[CRIT-01] 无论目标是否为代码文件，首行无条件派发 crish-open-file 事件并暂存 pendingOpenPath', () => {
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      const mockViewerOpener = vi.fn();
      registerFileViewerOpener(mockViewerOpener);

      // 针对 .ts 代码文件调用
      const res = openFileInPanel('c:/Software/conex/src/main.ts');

      // 1. 宿主分流至 file-viewer
      expect(res).toBe('file-viewer');
      expect(mockViewerOpener).toHaveBeenCalledWith('c:/Software/conex/src/main.ts', undefined);

      // 2. 核心物证：window 广播事件 100% 触发，未被提前 return 截断
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const event = dispatchSpy.mock.calls[0][0] as CustomEvent<{ path: string }>;
      expect(event.type).toBe('crish-open-file');
      expect(event.detail.path).toBe('c:/Software/conex/src/main.ts');

      // 3. pendingOpenPath 暂存态校验
      expect(takePendingOpenPath()).toBe('c:/Software/conex/src/main.ts');
      // 再次消费应已被清空
      expect(takePendingOpenPath()).toBeNull();
    });
  });
});
