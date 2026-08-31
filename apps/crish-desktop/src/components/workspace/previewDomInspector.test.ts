// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateCssSelector,
  computeBestSelector,
  generateXPath,
  extractElementPayload,
  parseInspectedElementPayload,
  attachDomInspector,
  inspectElementInIframe,
  DOM_INSPECTOR_SCRIPT,
  DOM_INSPECTED_MESSAGE_TYPE,
  DOM_INSPECTOR_TOGGLE_MESSAGE_TYPE,
} from './previewDomInspector';

describe('previewDomInspector', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.querySelectorAll('[id^="__crish_"]').forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  describe('generateCssSelector', () => {
    it('generates html/body selector for root elements', () => {
      expect(generateCssSelector(document.documentElement)).toBe('html');
      expect(generateCssSelector(document.body)).toBe('body');
    });

    it('generates ID selector if element has unique ID', () => {
      const btn = document.createElement('button');
      btn.id = 'unique-btn';
      container.appendChild(btn);

      expect(generateCssSelector(btn)).toBe('#unique-btn');
    });

    it('generates hierarchical selector with classes and nth-of-type', () => {
      const list = document.createElement('ul');
      list.className = 'nav-list main-menu';
      const item1 = document.createElement('li');
      item1.className = 'item';
      const item2 = document.createElement('li');
      item2.className = 'item active';
      list.appendChild(item1);
      list.appendChild(item2);
      container.appendChild(list);

      const sel1 = generateCssSelector(item1);
      const sel2 = generateCssSelector(item2);

      expect(sel1).toContain('ul.nav-list.main-menu > li.item:nth-of-type(1)');
      expect(sel2).toContain('ul.nav-list.main-menu > li.item.active:nth-of-type(2)');
    });

    it('handles element without id or class', () => {
      const p = document.createElement('p');
      container.appendChild(p);

      const sel = generateCssSelector(p);
      expect(sel).toContain('p');
    });
  });

  describe('computeBestSelector (selector_generator_priority)', () => {
    it('prioritizes data-testid test anchor over id and classes', () => {
      const btn = document.createElement('button');
      btn.id = 'submit-id';
      btn.className = 'btn-primary';
      btn.setAttribute('data-testid', 'submit-btn');
      container.appendChild(btn);

      expect(computeBestSelector(btn)).toBe('[data-testid="submit-btn"]');
    });

    it('supports all documented test anchor attributes', () => {
      for (const attr of ['data-test', 'data-cy', 'data-qa', 'data-id']) {
        const el = document.createElement('div');
        el.setAttribute(attr, 'anchor-value');
        container.appendChild(el);
        expect(computeBestSelector(el)).toBe(`[${attr}="anchor-value"]`);
        el.remove();
      }
    });

    it('falls back to unique id when no test anchor exists', () => {
      const nav = document.createElement('nav');
      nav.id = 'main-nav';
      nav.className = 'nav-list';
      container.appendChild(nav);

      expect(computeBestSelector(nav)).toBe('#main-nav');
    });

    it('uses semantic classes and filters Tailwind hashed/dynamic atomic classes', () => {
      const card = document.createElement('div');
      card.className = 'product-card flex p-4 abc123xyz 9f8e7d6c5b4a';
      container.appendChild(card);

      const selector = computeBestSelector(card);
      // 语义类保留
      expect(selector).toContain('div.product-card');
      // 动态哈希类（6+ 位纯字母数字）被过滤
      expect(selector).not.toContain('abc123xyz');
      expect(selector).not.toContain('9f8e7d6c5b4a');
    });

    it('filters responsive variant and arbitrary-value Tailwind classes', () => {
      const el = document.createElement('div');
      el.className = 'header-item sm:flex lg:block p-[13px]';
      container.appendChild(el);

      const selector = computeBestSelector(el);
      expect(selector).toContain('header-item');
      expect(selector).not.toContain(':');
      expect(selector).not.toContain('[');
    });

    it('falls back to hierarchical path when element has no unique anchors', () => {
      const list = document.createElement('ul');
      list.className = 'menu';
      const item1 = document.createElement('li');
      item1.className = 'menu-item';
      const item2 = document.createElement('li');
      item2.className = 'menu-item';
      list.appendChild(item1);
      list.appendChild(item2);
      container.appendChild(list);

      const sel = computeBestSelector(item2);
      expect(sel).toContain('ul.menu > li.menu-item:nth-of-type(2)');
    });
  });

  describe('generateXPath', () => {
    it('generates XPath for simple hierarchy', () => {
      const section = document.createElement('section');
      const div = document.createElement('div');
      const span = document.createElement('span');
      div.appendChild(span);
      section.appendChild(div);
      container.appendChild(section);

      const xpath = generateXPath(span);
      expect(xpath.toLowerCase()).toContain('/div[1]/span[1]');
    });

    it('generates correct index for multiple siblings', () => {
      const p1 = document.createElement('p');
      const p2 = document.createElement('p');
      const p3 = document.createElement('p');
      container.appendChild(p1);
      container.appendChild(p2);
      container.appendChild(p3);

      expect(generateXPath(p2)).toContain('p[2]');
      expect(generateXPath(p3)).toContain('p[3]');
    });
  });

  describe('extractElementPayload', () => {
    it('extracts complete structured attributes, text, and html', () => {
      const a = document.createElement('a');
      a.id = 'docs-link';
      a.className = 'link external';
      a.href = 'https://example.com';
      a.setAttribute('data-test', 'custom-val');
      a.textContent = 'Documentation Link';
      container.appendChild(a);

      const payload = extractElementPayload(a);

      expect(payload.tagName).toBe('a');
      expect(payload.id).toBe('docs-link');
      expect(payload.className).toBe('link external');
      expect(payload.textContent).toBe('Documentation Link');
      expect(payload.outerHtml).toContain('https://example.com');
      expect(payload.attributes['data-test']).toBe('custom-val');
      expect(payload.attributes['id']).toBe('docs-link');
      expect(payload.rect).toBeDefined();
      expect(payload.selector).toBe('#docs-link');
    });
  });

  describe('parseInspectedElementPayload', () => {
    it('parses valid DomInspectedMessage', () => {
      const msg = {
        type: DOM_INSPECTED_MESSAGE_TYPE,
        payload: {
          tagName: 'button',
          id: 'btn-1',
          className: 'btn',
          selector: '#btn-1',
          xpath: '/html/body/button[1]',
          outerHtml: '<button id="btn-1">Click</button>',
          textContent: 'Click',
          rect: { x: 10, y: 20, width: 100, height: 40, top: 20, left: 10 },
          attributes: { id: 'btn-1' },
        },
      };

      const result = parseInspectedElementPayload(msg);
      expect(result).not.toBeNull();
      expect(result?.tagName).toBe('button');
      expect(result?.selector).toBe('#btn-1');
    });

    it('parses direct payload object', () => {
      const payload = {
        tagName: 'div',
        id: '',
        className: 'card',
        selector: 'div.card',
        xpath: '/html/body/div[1]',
        outerHtml: '<div class="card">Text</div>',
        textContent: 'Text',
        rect: { x: 0, y: 0, width: 200, height: 100, top: 0, left: 0 },
        attributes: {},
      };

      const result = parseInspectedElementPayload(payload);
      expect(result).not.toBeNull();
      expect(result?.selector).toBe('div.card');
    });

    it('returns null for invalid or corrupted payloads', () => {
      expect(parseInspectedElementPayload(null)).toBeNull();
      expect(parseInspectedElementPayload(undefined)).toBeNull();
      expect(parseInspectedElementPayload('string')).toBeNull();
      expect(parseInspectedElementPayload({ type: 'other' })).toBeNull();
      expect(parseInspectedElementPayload({ type: DOM_INSPECTED_MESSAGE_TYPE, payload: {} })).toBeNull();
    });
  });

  describe('attachDomInspector runtime', () => {
    it('mounts overlay and badge, handles pointermove and click', () => {
      const button = document.createElement('button');
      button.id = 'target-btn';
      button.textContent = 'Target Button';
      container.appendChild(button);

      // Mock getBoundingClientRect
      vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
        x: 50,
        y: 60,
        top: 60,
        left: 50,
        bottom: 100,
        right: 150,
        width: 100,
        height: 40,
        toJSON: () => {},
      });

      const onInspect = vi.fn();
      const detach = attachDomInspector(document, onInspect);

      const overlayRoot = document.getElementById('__crish_dom_inspector_root__');
      expect(overlayRoot).not.toBeNull();

      // Trigger pointermove
      const pointerEvent = new MouseEvent('pointermove', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(pointerEvent, 'target', { value: button });
      window.dispatchEvent(pointerEvent);

      // Trigger click
      const clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(clickEvent, 'target', { value: button });
      window.dispatchEvent(clickEvent);

      expect(onInspect).toHaveBeenCalledTimes(1);
      const inspected = onInspect.mock.calls[0][0];
      expect(inspected.id).toBe('target-btn');
      expect(inspected.tagName).toBe('button');

      // Cleanup
      detach();
      expect(document.getElementById('__crish_dom_inspector_root__')).toBeNull();
    });
  });

  describe('inspectElementInIframe', () => {
    it('sends toggle message to iframe contentWindow', () => {
      const iframe = document.createElement('iframe');
      container.appendChild(iframe);

      const postMessageMock = vi.fn();
      Object.defineProperty(iframe, 'contentWindow', {
        value: {
          postMessage: postMessageMock,
        },
        writable: true,
      });

      const success = inspectElementInIframe(iframe, true);
      expect(success).toBe(true);
      expect(postMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: DOM_INSPECTOR_TOGGLE_MESSAGE_TYPE,
          enabled: true,
        }),
        '*'
      );
    });

    it('returns false when iframe is null', () => {
      expect(inspectElementInIframe(null, true)).toBe(false);
    });
  });

  describe('DOM_INSPECTOR_SCRIPT', () => {
    it('exports a valid standalone JS snippet string', () => {
      expect(typeof DOM_INSPECTOR_SCRIPT).toBe('string');
      expect(DOM_INSPECTOR_SCRIPT).toContain('__CRISH_INSPECTOR_LOADED__');
      expect(DOM_INSPECTOR_SCRIPT).toContain(DOM_INSPECTOR_TOGGLE_MESSAGE_TYPE);
    });
  });
});
