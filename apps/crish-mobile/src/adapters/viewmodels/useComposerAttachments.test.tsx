// useComposerAttachments 单测（G5b）：选取结果落位纪律——
// 入选追加 / 权限被拒与超限拒绝只提示不入队 / 取消静默 / 逐个移除 /
// 清空 / 选取在途防重入。intake 经 override 注入假实现（真实 picker
// 与图片处理在 attachmentIntake，属原生面不在本测范围）。
import { act, renderHook } from '@testing-library/react-native';
import type { ComposerAttachment } from '@/domain/pure/attachments';
import type {
  AttachmentIntake,
  AttachmentPickOutcome,
} from '@/adapters/attachments/attachmentIntake';
import { useComposerAttachments } from './useComposerAttachments';

const ATT_A: ComposerAttachment = {
  id: 'a-1',
  name: '一.png',
  kind: 'image',
  dataUrl: 'data:image/png;base64,AA==',
};
const ATT_B: ComposerAttachment = {
  id: 'a-2',
  name: '二.txt',
  kind: 'text',
  text: '正文',
};

function fakeIntake(
  outcome: AttachmentPickOutcome | (() => Promise<AttachmentPickOutcome>)
) {
  const resolve = async (): Promise<AttachmentPickOutcome> =>
    typeof outcome === 'function' ? outcome() : outcome;
  const intake: AttachmentIntake = {
    pickFromCamera: jest.fn(resolve),
    pickFromLibrary: jest.fn(resolve),
    pickFromFiles: jest.fn(resolve),
  };
  return intake;
}

describe('useComposerAttachments', () => {
  it('入选追加：三入口各追加一项，顺序保真，不发提示', async () => {
    const notify = jest.fn();
    const intake = fakeIntake({ kind: 'picked', attachment: ATT_A });
    const { result } = await renderHook(() =>
      useComposerAttachments({ notify, intakeOverride: intake })
    );
    await act(async () => {
      result.current.pickFromLibrary();
    });
    expect(result.current.attachments.map((a) => a.id)).toEqual(['a-1']);
    (intake.pickFromFiles as jest.Mock).mockResolvedValue({
      kind: 'picked',
      attachment: ATT_B,
    } satisfies AttachmentPickOutcome);
    await act(async () => {
      result.current.pickFromFiles();
    });
    expect(result.current.attachments.map((a) => a.id)).toEqual(['a-1', 'a-2']);
    expect(notify).not.toHaveBeenCalled();
    expect(result.current.picking).toBe(false);
  });

  it('权限被拒：诚实提示且不入队', async () => {
    const notify = jest.fn();
    const intake = fakeIntake({
      kind: 'denied',
      message: '未获得相册权限，无法选择图片。',
    });
    const { result } = await renderHook(() =>
      useComposerAttachments({ notify, intakeOverride: intake })
    );
    await act(async () => {
      result.current.pickFromLibrary();
    });
    expect(result.current.attachments).toEqual([]);
    expect(notify).toHaveBeenCalledWith('未获得相册权限，无法选择图片。');
  });

  it('压缩后仍超限：当场拒绝（提示点名），不入队', async () => {
    const notify = jest.fn();
    const intake = fakeIntake({
      kind: 'tooLarge',
      name: '大图.jpg',
      message: '图片「大图.jpg」压缩后仍超过单张上限，已跳过',
    });
    const { result } = await renderHook(() =>
      useComposerAttachments({ notify, intakeOverride: intake })
    );
    await act(async () => {
      result.current.pickFromCamera();
    });
    expect(result.current.attachments).toEqual([]);
    expect(notify).toHaveBeenCalledWith(
      '图片「大图.jpg」压缩后仍超过单张上限，已跳过'
    );
  });

  it('用户取消：静默（不入队、不提示）', async () => {
    const notify = jest.fn();
    const intake = fakeIntake({ kind: 'cancelled' });
    const { result } = await renderHook(() =>
      useComposerAttachments({ notify, intakeOverride: intake })
    );
    await act(async () => {
      result.current.pickFromFiles();
    });
    expect(result.current.attachments).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('逐个移除与清空', async () => {
    const notify = jest.fn();
    const intake = fakeIntake({ kind: 'picked', attachment: ATT_A });
    const { result } = await renderHook(() =>
      useComposerAttachments({ notify, intakeOverride: intake })
    );
    await act(async () => {
      result.current.pickFromLibrary();
    });
    await act(async () => {
      result.current.remove('a-1');
    });
    expect(result.current.attachments).toEqual([]);
    await act(async () => {
      result.current.pickFromLibrary();
    });
    expect(result.current.attachments).toHaveLength(1);
    await act(async () => {
      result.current.clear();
    });
    expect(result.current.attachments).toEqual([]);
  });

  it('选取在途防重入：在途期间重复触发只调一次 intake', async () => {
    const notify = jest.fn();
    let release: (o: AttachmentPickOutcome) => void = () => {};
    const intake = fakeIntake(
      () =>
        new Promise<AttachmentPickOutcome>((resolve) => {
          release = resolve;
        })
    );
    const { result } = await renderHook(() =>
      useComposerAttachments({ notify, intakeOverride: intake })
    );
    await act(async () => {
      result.current.pickFromCamera();
      result.current.pickFromLibrary();
      result.current.pickFromFiles();
    });
    expect(intake.pickFromCamera).toHaveBeenCalledTimes(1);
    expect(intake.pickFromLibrary).not.toHaveBeenCalled();
    expect(intake.pickFromFiles).not.toHaveBeenCalled();
    expect(result.current.picking).toBe(true);
    await act(async () => {
      release({ kind: 'cancelled' });
    });
    expect(result.current.picking).toBe(false);
  });
});
