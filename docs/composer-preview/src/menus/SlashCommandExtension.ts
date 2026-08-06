/**
 * SlashCommandExtension — 斜杠菜单与编辑器的桥接
 *
 * 用 Tiptap 的 Suggestion 插件监听 `/`，把菜单挂到光标处。
 *
 * 定位策略：不引入 tippy/floating-ui，直接用 Suggestion 提供的
 * `clientRect` 做绝对定位，并做上下翻转与横向夹取——
 * 这个菜单只有一个锚点场景，为它引一整个定位库不划算。
 *
 * 生命周期上有两个坑，这里都处理了：
 *   1. `onKeyDown` 必须转发给菜单实例，否则方向键会被编辑器吃掉；
 *   2. 菜单销毁时要解绑 resize/scroll，否则长会话下会堆积监听器。
 */

import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { createRoot, type Root } from 'react-dom/client';
import React from 'react';
import { SlashMenu, type SlashMenuHandle } from './SlashMenu';

/** 菜单与光标之间的间距 */
const GAP = 6;
/** 菜单距视口边缘的最小留白 */
const EDGE = 12;

interface MenuHost {
  element: HTMLDivElement;
  root: Root;
  handle: React.RefObject<SlashMenuHandle | null>;
  detach: () => void;
}

function createHost(): MenuHost {
  const element = document.createElement('div');
  element.className = 'slash-menu-anchor';
  document.body.appendChild(element);

  const root = createRoot(element);
  const handle = React.createRef<SlashMenuHandle>();

  return {
    element,
    root,
    handle,
    detach() {
      // 延后一拍卸载：React 不允许在自身渲染周期内同步 unmount
      const target = root;
      const node = element;
      queueMicrotask(() => {
        target.unmount();
        node.remove();
      });
    },
  };
}

/** 把菜单定位到光标处，空间不足时翻到上方 */
function place(host: MenuHost, rect: DOMRect | null): void {
  if (!rect) return;
  const menu = host.element.firstElementChild as HTMLElement | null;
  const height = menu?.offsetHeight ?? 320;
  const width = menu?.offsetWidth ?? 300;

  const spaceBelow = window.innerHeight - rect.bottom;
  const flip = spaceBelow < height + GAP + EDGE && rect.top > height + GAP + EDGE;

  const top = flip ? rect.top - height - GAP : rect.bottom + GAP;
  const left = Math.min(
    Math.max(EDGE, rect.left),
    Math.max(EDGE, window.innerWidth - width - EDGE),
  );

  host.element.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  host.element.dataset.placement = flip ? 'top' : 'bottom';
}

export const SlashCommandExtension = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    const editor = this.editor as Editor;

    return [
      Suggestion({
        editor,
        char: '/',
        // 只在行首或空白之后触发，避免在 URL、路径里误弹
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          const before = $from.nodeBefore?.textContent ?? '';
          if (before && !/\s$/.test(before)) return false;
          // 代码块内不弹菜单
          return !$from.parent.type.spec.code;
        },

        command: ({ editor: ed, range, props }: { editor: Editor; range: Range; props: { run: (e: Editor, r: Range) => void } }) => {
          props.run(ed, range);
        },

        items: () => [],

        render: () => {
          let host: MenuHost | null = null;
          let reposition: (() => void) | null = null;

          const render = (props: SuggestionProps) => {
            if (!host) return;
            host.root.render(
              React.createElement(SlashMenu, {
                ref: host.handle,
                editor: props.editor,
                range: props.range,
                query: props.query,
                onClose: () => {
                  // 关掉菜单但把已输入的 `/xxx` 留在文本里
                  props.editor.commands.focus();
                  host?.detach();
                  host = null;
                },
              }),
            );
            // 等 React 提交后再测量，否则拿不到真实高度
            requestAnimationFrame(() => place(host as MenuHost, props.clientRect?.() ?? null));
          };

          return {
            onStart: (props: SuggestionProps) => {
              host = createHost();
              render(props);

              reposition = () => place(host as MenuHost, props.clientRect?.() ?? null);
              window.addEventListener('resize', reposition);
              window.addEventListener('scroll', reposition, true);
            },

            onUpdate: (props: SuggestionProps) => {
              if (!host) return;
              render(props);
            },

            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (!host) return false;
              return host.handle.current?.onKeyDown(props.event) ?? false;
            },

            onExit: () => {
              if (reposition) {
                window.removeEventListener('resize', reposition);
                window.removeEventListener('scroll', reposition, true);
                reposition = null;
              }
              host?.detach();
              host = null;
            },
          };
        },
      }),
    ];
  },
});
