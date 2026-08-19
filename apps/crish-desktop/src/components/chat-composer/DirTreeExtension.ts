/**
 * @@ 目录树 suggestion：输入锚点唤工作区树。
 * 禁止假 TreeStore / 第二套 popovers.js。
 */
import { Extension } from '@tiptap/core';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import { ComposerDirTree } from './ComposerDirTree';
import {
  calculateSafeCursorAnchor,
  measureCursorLineBox,
} from './safeCursorAnchor';
import type { SlashCommandItem } from './composerTypes';

export const dirTreeSuggestionKey = new PluginKey('crishDirTreeSuggestion');

export interface DirTreeExtensionOptions {
  listboxId?: string;
  containerRef?: { current: HTMLElement | null };
}

const DUMMY_ITEM: SlashCommandItem = {
  id: 'dir-tree',
  title: 'workspace',
  description: '',
  command: () => undefined,
};

export const DirTreeExtension = Extension.create<DirTreeExtensionOptions>({
  name: 'dirTreeSuggestion',

  addOptions() {
    return {
      listboxId: undefined,
      containerRef: undefined,
    };
  },

  addProseMirrorPlugins() {
    const listboxId = this.options.listboxId;
    const containerRef = this.options.containerRef;

    return [
      Suggestion({
        editor: this.editor,
        char: '@@',
        allowedPrefixes: null,
        pluginKey: dirTreeSuggestionKey,
        items: () => [DUMMY_ITEM],
        command: () => undefined,
        render: () => {
          let component: ReactRenderer | null = null;
          let propsRef: { editor?: { view?: { dom?: HTMLElement } } } | null =
            null;
          let lastCachedBox: DOMRect | null = null;
          let lastSuggestedSide: 'top' | 'bottom' | undefined;

          const buildProps = (props: {
            editor: unknown;
            range: unknown;
            clientRect?: () => DOMRect | null;
          }) => ({
            items: [DUMMY_ITEM],
            command: () => undefined,
            editor: props.editor,
            range: props.range,
            isOpen: true,
            onClose: () => {
              component?.destroy();
              component = null;
            },
            listboxId,
            clientRect: () => {
              const view = (props.editor as { view?: unknown } | undefined)
                ?.view as
                | {
                    composing?: boolean;
                    input?: { composing?: boolean };
                    dom?: HTMLElement;
                  }
                | undefined;
              const range = props.range as { from?: number } | undefined;
              if (!view || range?.from == null) return lastCachedBox;
              if (view.composing || view.input?.composing) return lastCachedBox;
              try {
                const rawBox = measureCursorLineBox(view as never, range.from, 1);
                const safeAnchor = calculateSafeCursorAnchor({
                  rawCursorRect: rawBox,
                  editorViewDom: view.dom,
                  composerContainer: containerRef?.current ?? undefined,
                  previousSide: lastSuggestedSide,
                  hysteresis: 24,
                });
                if (safeAnchor) {
                  lastSuggestedSide = safeAnchor.suggestedSide;
                  lastCachedBox = Object.assign(
                    new DOMRect(
                      safeAnchor.left,
                      safeAnchor.top,
                      safeAnchor.width,
                      safeAnchor.height
                    ),
                    {
                      suggestedSide: safeAnchor.suggestedSide,
                      nearEdge: safeAnchor.nearEdge,
                      isFallback: safeAnchor.isFallback,
                      isValid: safeAnchor.isValid,
                    }
                  );
                  return lastCachedBox;
                }
                return lastCachedBox;
              } catch {
                return lastCachedBox;
              }
            },
          });

          return {
            onStart(props: {
              editor: { view?: { dom?: HTMLElement } };
              range: unknown;
            }) {
              propsRef = props;
              const dom = props.editor?.view?.dom;
              if (dom) {
                if (listboxId) dom.setAttribute('aria-controls', listboxId);
                dom.setAttribute('aria-expanded', 'true');
              }
              component = new ReactRenderer(ComposerDirTree, {
                props: buildProps(props),
                editor: props.editor as never,
              });
            },
            onUpdate(props: {
              editor: { view?: { dom?: HTMLElement } };
              range: unknown;
            }) {
              propsRef = props;
              component?.updateProps(buildProps(props));
            },
            onKeyDown(props: { event: KeyboardEvent; view?: unknown }) {
              if (props.event.key === 'Escape') {
                if (
                  props.event.isComposing ||
                  props.event.keyCode === 229 ||
                  props.event.key === 'Process'
                ) {
                  return false;
                }
                component?.destroy();
                component = null;
                if (props.view) {
                  exitSuggestion(props.view as never, dirTreeSuggestionKey);
                }
                return true;
              }
              return (
                (component?.ref as { onKeyDown?: (p: unknown) => boolean } | null)
                  ?.onKeyDown?.(props) ?? false
              );
            },
            onExit() {
              const dom = propsRef?.editor?.view?.dom;
              if (dom) {
                dom.removeAttribute('aria-expanded');
                dom.removeAttribute('aria-controls');
                dom.removeAttribute('aria-activedescendant');
              }
              component?.destroy();
              component = null;
              propsRef = null;
              lastCachedBox = null;
            },
          };
        },
      }),
    ];
  },
});
