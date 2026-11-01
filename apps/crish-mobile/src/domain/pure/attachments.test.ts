// G5b · 附件组装与预检单测：与桌面 multimodal.ts 同构口径逐项对拍
// （parts 构造、视觉/降级双路、prompt 附件块、截断、大小预检）。
import {
  ATTACHMENT_DATA_URL_MAX_BYTES,
  buildRunPayload,
  checkRunPayloadSizes,
  formatBytes,
  utf8ByteLength,
  type ComposerAttachment,
} from './attachments';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

function imageAttachment(
  overrides: Partial<ComposerAttachment> = {}
): ComposerAttachment {
  return {
    id: 'a-1',
    name: '截图.png',
    kind: 'image',
    dataUrl: PNG_DATA_URL,
    sizeBytes: 1024,
    mime: 'image/png',
    ...overrides,
  };
}

describe('buildRunPayload', () => {
  it('无附件返回 null（调用方走纯文本路径）', () => {
    expect(buildRunPayload('你好', [], true)).toBeNull();
  });

  it('视觉模型：text part 在首 + image_url part 形态与桌面同构', () => {
    const payload = buildRunPayload('看这张图', [imageAttachment()], true)!;
    expect(payload.hasImages).toBe(true);
    expect(payload.content).toEqual([
      { type: 'text', text: '看这张图' },
      {
        type: 'image_url',
        image_url: { url: PNG_DATA_URL, detail: 'auto' },
        name: '截图.png',
        mime: 'image/png',
      },
    ]);
    expect(payload.prompt).toBe(
      '看这张图\n\n[附件]\n[图片附件: 截图.png]\n用户上传了图片 截图.png，请结合 OCR/视觉理解分析（图片已通过结构化 image_url 部分下发）'
    );
  });

  it('非视觉模型：图片降级为元数据 text part，hasImages=false，注记逐字对齐桌面', () => {
    const payload = buildRunPayload('看这张图', [imageAttachment()], false)!;
    expect(payload.hasImages).toBe(false);
    const note = [
      '[图片附件元数据: 截图.png]',
      '格式: image/png',
      '大小: 1.0 KB',
      '（当前模型为纯文本非视觉模型：不接收结构化图像，亦不下发 dataUrl / 本机绝对路径）',
    ].join('\n');
    expect(payload.content).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'text', text: note },
    ]);
    expect(payload.prompt).toBe(`看这张图\n\n[附件]\n${note}`);
    // 降级后 content 不得残留任何 dataUrl
    expect(JSON.stringify(payload.content)).not.toContain('data:image');
  });

  it('纯附件（空文本）：prompt 取附件块正文且非空，无首 text part', () => {
    const payload = buildRunPayload('   ', [imageAttachment()], true)!;
    expect(payload.prompt.startsWith('[附件]\n[图片附件: 截图.png]')).toBe(
      true
    );
    expect(payload.content[0]!.type).toBe('image_url');
  });

  it('文本文件：--- name --- 包裹，80000 字符截断并带 …(截断) 标记', () => {
    const longText = 'x'.repeat(80_001);
    const payload = buildRunPayload(
      '',
      [
        {
          id: 'a-2',
          name: '日志.txt',
          kind: 'text',
          text: longText,
          textTruncated: true,
        },
      ],
      true
    )!;
    const partText = payload.content[0]!.text!;
    expect(partText.startsWith('--- 日志.txt ---\n')).toBe(true);
    expect(partText.endsWith('\n…(截断)')).toBe(true);
    expect(partText.length).toBe(
      '--- 日志.txt ---\n'.length + 80_000 + '\n…(截断)'.length
    );
    expect(payload.prompt).toContain(partText);
  });

  it('普通文件：仅元数据行 - name', () => {
    const payload = buildRunPayload(
      '见附件',
      [{ id: 'a-3', name: '合同.pdf', kind: 'file', sizeBytes: 2048 }],
      true
    )!;
    expect(payload.content).toEqual([
      { type: 'text', text: '见附件' },
      { type: 'text', text: '- 合同.pdf' },
    ]);
    expect(payload.prompt).toBe('见附件\n\n[附件]\n- 合同.pdf');
    expect(payload.hasImages).toBe(false);
  });

  it('多附件混合：顺序保真，块内以空行分隔', () => {
    const payload = buildRunPayload(
      '汇总',
      [
        imageAttachment(),
        { id: 'a-2', name: '说明.md', kind: 'text', text: '正文' },
        { id: 'a-3', name: '数据.zip', kind: 'file' },
      ],
      true
    )!;
    expect(payload.content.map((p) => p.type)).toEqual([
      'text',
      'image_url',
      'text',
      'text',
    ]);
    expect(payload.prompt).toContain('[附件]\n[图片附件: 截图.png]');
    expect(payload.prompt).toContain('--- 说明.md ---\n正文');
    expect(payload.prompt).toContain('- 数据.zip');
  });
});

describe('checkRunPayloadSizes', () => {
  it('达标 payload 通过', () => {
    const payload = buildRunPayload('hi', [imageAttachment()], true)!;
    expect(checkRunPayloadSizes(payload)).toEqual({ ok: true });
  });

  it('单 dataUrl 超限：按 dataUrl 原因拦截并点名附件', () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(ATTACHMENT_DATA_URL_MAX_BYTES)}`;
    const payload = buildRunPayload(
      '',
      [imageAttachment({ dataUrl: big })],
      true
    )!;
    const check = checkRunPayloadSizes(payload);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toBe('dataUrl');
      expect(check.message).toContain('截图.png');
    }
  });

  it('content 总量超限：多图累积越过总量上限时拦截（单图各自达标）', () => {
    const each = `data:image/jpeg;base64,${'A'.repeat(300_000)}`;
    const payload = buildRunPayload(
      '',
      [
        imageAttachment({ id: 'a-1', dataUrl: each }),
        imageAttachment({ id: 'a-2', name: '二.png', dataUrl: each }),
        imageAttachment({ id: 'a-3', name: '三.png', dataUrl: each }),
      ],
      true
    )!;
    const check = checkRunPayloadSizes(payload);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('content');
  });

  it('prompt 超限：长正文输入 + 文本文件块叠加越过 prompt 上限（content 总量未越限）', () => {
    // 正文 30000 汉字（9 万字节）+ 文本文件 80000 汉字（24 万字节）：
    // prompt ≈ 33 万字节 > 262144；content ≈ 33 万字节 < 720896，
    // 故命中原因应为 prompt 而非 content。
    const payload = buildRunPayload(
      '汉'.repeat(30_000),
      [{ id: 'a-9', name: '大.txt', kind: 'text', text: '汉'.repeat(80_000) }],
      true
    )!;
    const check = checkRunPayloadSizes(payload);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toBe('prompt');
  });

  it('降级路径：dataUrl 不入 content，大小预检不因原图大而误拦', () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(ATTACHMENT_DATA_URL_MAX_BYTES)}`;
    const payload = buildRunPayload(
      '',
      [imageAttachment({ dataUrl: big })],
      false
    )!;
    expect(checkRunPayloadSizes(payload)).toEqual({ ok: true });
  });
});

describe('utf8ByteLength / formatBytes', () => {
  it('utf8ByteLength：ASCII=1、CJK=3、代理对=4', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('汉字')).toBe(6);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('')).toBe(0);
  });

  it('formatBytes 与桌面同口径', () => {
    expect(formatBytes(-1)).toBe('未知大小');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
