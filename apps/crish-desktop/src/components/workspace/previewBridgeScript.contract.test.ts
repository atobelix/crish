/**
 * previewBridgeScript 契约测试（audit-repair-202609 · T19）。
 *
 * 注入桥是预览 DOM inspector 的唯一运行时客户端实现（纯字符串，由代理在
 * 服务端注入）。本测试锁定其与 previewProtocol.ts 的契约：来源标识、消息
 * 类型、真 XPath（非历史伪实现 '//' + tag）、导航通知与防重复注入。
 */
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_BRIDGE_SCRIPT,
  PREVIEW_BRIDGE_SCRIPT_ID,
} from '../../../dev-server/previewBridgeScript';
import {
  CRISH_PREVIEW_HOST_SOURCE,
  CRISH_PREVIEW_INSPECTOR_SOURCE,
} from './previewProtocol';

describe('previewBridgeScript 契约', () => {
  it('脚本以唯一 script id 防重复注入', () => {
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(
      `<script id="${PREVIEW_BRIDGE_SCRIPT_ID}">`
    );
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(
      'if (window.__CONEX_PREVIEW_BRIDGE__) return;'
    );
  });

  it('使用协议真源的 source 标识', () => {
    // 宿主来源：桥只接受 previewProtocol.CRISH_PREVIEW_HOST_SOURCE
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(
      `e.data.source !== '${CRISH_PREVIEW_HOST_SOURCE}'`
    );
    // 客户端来源：桥以 CRISH_PREVIEW_INSPECTOR_SOURCE 上报
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(
      `source: '${CRISH_PREVIEW_INSPECTOR_SOURCE}'`
    );
  });

  it('上报全部四类 inspect 消息 + Esc 退出', () => {
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("type: 'INSPECT_READY'");
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("type: 'INSPECT_HOVER'");
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("type: 'INSPECT_SELECT'");
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("type: 'INSPECT_TOGGLE'");
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("'Escape'");
  });

  it('INSPECT_SELECT 携带真实位置 XPath（子索引轴），非 "//" + tagname 伪实现', () => {
    expect(PREVIEW_BRIDGE_SCRIPT).toContain('xpath: computeXPath(el)');
    // computeXPath 必须包含子索引轴与根路径拼接
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(
      "parts.unshift(node.tagName.toLowerCase() + '[' + index + ']')"
    );
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("return '/' + parts.join('/')");
    expect(PREVIEW_BRIDGE_SCRIPT).not.toContain("xpath: '//' + tag");
  });

  it('链接点击 / GET 表单提交以 preview:navigate 通知宿主', () => {
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("type: 'preview:navigate'");
    expect(PREVIEW_BRIDGE_SCRIPT).toContain("document.addEventListener('submit'");
  });

  it('§4.1：postMessage 使用明确 TARGET_ORIGIN，禁止 \'*\' 目标', () => {
    expect(PREVIEW_BRIDGE_SCRIPT).toContain('var TARGET_ORIGIN = resolveParentTargetOrigin()');
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(
      'window.parent.postMessage(payload, TARGET_ORIGIN)'
    );
    expect(PREVIEW_BRIDGE_SCRIPT).toContain('postToParent(');
    const runtime = PREVIEW_BRIDGE_SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(
      /\/\/.*$/gm,
      ''
    );
    expect(runtime).not.toMatch(/postMessage\([^)]*,\s*'\*'\s*\)/);
    expect(PREVIEW_BRIDGE_SCRIPT).toContain(
      'e.origin !== TARGET_ORIGIN && e.origin !== window.location.origin'
    );
  });

});
