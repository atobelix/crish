/**
 * apps/crish-desktop/src/components/chat-message/searchExpandBridge.ts
 *
 * 领域通信桥接模块：轻量级内存状态桥，联动 sessionSearch 搜索命中与消息过程折叠展开调度
 * （DIM-05 双轨检索穿透专项架构）。
 */

import { useState, useEffect } from 'react';

type Listener = (isExpanded: boolean) => void;

class SearchExpandBridgeImpl {
  private expandedMap = new Map<string, boolean>();
  private listeners = new Map<string, Set<Listener>>();
  private messageToSession = new Map<string, string>();
  private sessionToMessages = new Map<string, Set<string>>();

  public isExpanded(msgId: string, defaultValue = false): boolean {
    if (!msgId) return false;
    return this.expandedMap.get(msgId) ?? defaultValue;
  }

  public setExpanded(msgId: string, expanded: boolean, sessionId?: string): void {
    if (!msgId) return;
    if (sessionId) {
      this.bindMessageToSession(sessionId, msgId);
    }
    const current = this.expandedMap.get(msgId);
    if (current === expanded) return;
    this.expandedMap.set(msgId, expanded);
    this.notify(msgId, expanded);
  }

  public toggleExpanded(msgId: string, defaultValue = false): void {
    if (!msgId) return;
    const current = this.isExpanded(msgId, defaultValue);
    this.setExpanded(msgId, !current);
  }

  public expandMessageProcess(msgId: string): void {
    this.setExpanded(msgId, true);
  }

  public collapseMessageProcess(msgId: string): void {
    this.setExpanded(msgId, false);
  }

  public getAllExpandedMessageIds(): string[] {
    const res: string[] = [];
    for (const [id, expanded] of this.expandedMap.entries()) {
      if (expanded) res.push(id);
    }
    return res;
  }

  public subscribe(msgId: string, listener: Listener): () => void {
    if (!msgId) return () => {};
    let set = this.listeners.get(msgId);
    if (!set) {
      set = new Set();
      this.listeners.set(msgId, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(msgId);
      if (s) {
        s.delete(listener);
        if (s.size === 0) {
          this.listeners.delete(msgId);
        }
      }
    };
  }

  private notify(msgId: string, expanded: boolean): void {
    const set = this.listeners.get(msgId);
    if (set) {
      for (const listener of Array.from(set)) {
        try {
          listener(expanded);
        } catch (err) {
          console.error('[SearchExpandBridge] listener error', err);
        }
      }
    }
  }

  public bindMessageToSession(sessionId: string, msgId: string): void {
    if (!sessionId || !msgId) return;
    const oldSession = this.messageToSession.get(msgId);
    if (oldSession && oldSession !== sessionId) {
      const oldSet = this.sessionToMessages.get(oldSession);
      if (oldSet) {
        oldSet.delete(msgId);
      }
    }
    this.messageToSession.set(msgId, sessionId);
    let set = this.sessionToMessages.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionToMessages.set(sessionId, set);
    }
    set.add(msgId);
  }

  public bindMessagesToSession(sessionId: string, msgIds: string[]): void {
    if (!sessionId || !Array.isArray(msgIds)) return;
    for (const id of msgIds) {
      this.bindMessageToSession(sessionId, id);
    }
  }

  public getMessageSession(msgId: string): string | undefined {
    return this.messageToSession.get(msgId);
  }

  public clearExpansionState(sessionId?: string): void {
    if (sessionId) {
      const msgIds = this.sessionToMessages.get(sessionId);
      if (msgIds) {
        for (const msgId of Array.from(msgIds)) {
          const wasExpanded = this.expandedMap.get(msgId);
          this.expandedMap.delete(msgId);
          this.messageToSession.delete(msgId);
          if (wasExpanded) {
            this.notify(msgId, false);
          }
        }
        this.sessionToMessages.delete(sessionId);
      }
    } else {
      const previouslyExpanded: string[] = [];
      for (const [msgId, exp] of this.expandedMap.entries()) {
        if (exp) previouslyExpanded.push(msgId);
      }
      this.expandedMap.clear();
      this.messageToSession.clear();
      this.sessionToMessages.clear();
      for (const msgId of previouslyExpanded) {
        this.notify(msgId, false);
      }
    }
  }

  public clearSubscribers(): void {
    this.listeners.clear();
  }

  public clear(): void {
    this.clearExpansionState();
    this.clearSubscribers();
  }
}

export const searchExpandBridge = new SearchExpandBridgeImpl();

export const isMessageProcessExpanded = (msgId: string, defaultVal = false): boolean =>
  searchExpandBridge.isExpanded(msgId, defaultVal);

export const setMessageProcessExpanded = (msgId: string, expanded: boolean, sessionId?: string): void =>
  searchExpandBridge.setExpanded(msgId, expanded, sessionId);

export const toggleMessageProcessExpanded = (msgId: string, defaultVal = false): void =>
  searchExpandBridge.toggleExpanded(msgId, defaultVal);

export const expandMessageProcess = (msgId: string): void =>
  searchExpandBridge.expandMessageProcess(msgId);

export const collapseMessageProcess = (msgId: string): void =>
  searchExpandBridge.collapseMessageProcess(msgId);

export const getAllExpandedMessageIds = (): string[] =>
  searchExpandBridge.getAllExpandedMessageIds();

export const subscribeMessageProcessExpansion = (
  msgId: string,
  callback: (isExpanded: boolean) => void
): (() => void) => searchExpandBridge.subscribe(msgId, callback);

export const clearMessageProcessExpansionState = (sessionId?: string): void =>
  searchExpandBridge.clearExpansionState(sessionId);

export const clearMessageProcessSubscribers = (): void =>
  searchExpandBridge.clearSubscribers();

export const bindMessageToSession = (sessionId: string, msgId: string): void =>
  searchExpandBridge.bindMessageToSession(sessionId, msgId);

export const bindMessagesToSession = (sessionId: string, msgIds: string[]): void =>
  searchExpandBridge.bindMessagesToSession(sessionId, msgIds);

export const getMessageSession = (msgId: string): string | undefined =>
  searchExpandBridge.getMessageSession(msgId);

export function jumpToSearchHit(
  msgId: string,
  vsm: any,
  scroller: HTMLElement | { scrollTo?: (opts: any) => void; scrollTop?: number }
): void {
  if (!msgId || !vsm || !scroller) return;
  const order = typeof vsm.getOrder === 'function' ? vsm.getOrder() : null;
  if (!Array.isArray(order)) return;
  const index = order.indexOf(msgId);
  if (index === -1) return;

  const top = typeof vsm.getOffset === 'function' ? vsm.getOffset(index) : 0;
  if (typeof (scroller as any).scrollTo === 'function') {
    (scroller as any).scrollTo({ top, behavior: 'auto' });
  } else if ('scrollTop' in scroller) {
    (scroller as any).scrollTop = top;
  }

  expandMessageProcess(msgId);
}

export function useMessageProcessExpanded(
  msgId: string,
  initialExpanded = false
): boolean {
  const [isExpanded, setIsExpanded] = useState(() =>
    isMessageProcessExpanded(msgId, initialExpanded)
  );

  useEffect(() => {
    setIsExpanded(isMessageProcessExpanded(msgId, initialExpanded));
    return subscribeMessageProcessExpansion(msgId, (exp) => {
      setIsExpanded(exp);
    });
  }, [msgId, initialExpanded]);

  return isExpanded;
}
