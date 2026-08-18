// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { slotCore } from './SlotCore';
import { SlotOutlet } from './SlotOutlet';

describe('SlotCore 四大插槽拓扑形态与 SlotOutlet 渲染', () => {
  beforeEach(() => {
    slotCore.clear();
  });

  it('1. Single 插槽：独占胜出 (arg min priority) 与影子退位容灾', () => {
    slotCore.registerSingle('test.single', {
      id: 'shadow-item',
      priority: 10,
      component: () => <div data-testid="shadow">Shadow Comp</div>,
    });

    slotCore.registerSingle('test.single', {
      id: 'winner-item',
      priority: 0,
      component: () => <div data-testid="winner">Winner Comp</div>,
    });

    const { rerender } = render(
      <SlotOutlet slotKey="test.single" context={{}} />
    );
    expect(screen.getByTestId('winner')).toBeDefined();
    expect(screen.queryByTestId('shadow')).toBeNull();

    // 触发影子退让
    act(() => {
      slotCore.abdicateSingle('test.single', 'winner-item');
    });
    rerender(<SlotOutlet slotKey="test.single" context={{}} />);

    expect(screen.queryByTestId('winner')).toBeNull();
    expect(screen.getByTestId('shadow')).toBeDefined();
  });

  it('2. List 插槽：有序序列 (order 升序) 与 id 覆盖', () => {
    slotCore.registerList('test.list', {
      id: 'item-2',
      order: 20,
      component: () => <span data-testid="item">Item 2</span>,
    });
    slotCore.registerList('test.list', {
      id: 'item-1',
      order: 10,
      component: () => <span data-testid="item">Item 1</span>,
    });

    render(<SlotOutlet slotKey="test.list" context={{}} />);
    const items = screen.getAllByTestId('item');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toBe('Item 1');
    expect(items[1].textContent).toBe('Item 2');
  });

  it('3. Keyed 插槽：O(1) 键控分发', () => {
    slotCore.registerKeyed('test.keyed', {
      id: 'chat-entry',
      key: 'chat',
      component: (ctx: any) => (
        <div data-testid="keyed-chat">Chat Pane for {ctx.user}</div>
      ),
    });
    slotCore.registerKeyed('test.keyed', {
      id: 'term-entry',
      key: 'terminal',
      component: () => <div data-testid="keyed-term">Term Pane</div>,
    });

    render(
      <SlotOutlet
        slotKey="test.keyed"
        entryKey="chat"
        context={{ user: 'Alice' }}
      />
    );

    expect(screen.getByTestId('keyed-chat').textContent).toBe(
      'Chat Pane for Alice'
    );
    expect(screen.queryByTestId('keyed-term')).toBeNull();
  });

  it('4. Chain 插槽：纯函数责任链首个匹配胜出，未当选 0 渲染', () => {
    slotCore.registerChain('test.chain', {
      id: 'admin-handler',
      select: (ctx: any) => ctx.role === 'admin',
      component: () => <div data-testid="chain-admin">Admin Dashboard</div>,
    });
    slotCore.registerChain('test.chain', {
      id: 'user-handler',
      select: (ctx: any) => ctx.role === 'user',
      component: () => <div data-testid="chain-user">User Dashboard</div>,
    });

    const { rerender } = render(
      <SlotOutlet slotKey="test.chain" context={{ role: 'user' }} />
    );
    expect(screen.getByTestId('chain-user')).toBeDefined();
    expect(screen.queryByTestId('chain-admin')).toBeNull();

    rerender(<SlotOutlet slotKey="test.chain" context={{ role: 'admin' }} />);
    expect(screen.getByTestId('chain-admin')).toBeDefined();
    expect(screen.queryByTestId('chain-user')).toBeNull();
  });

  it('SlotOutlet 具备 display: contents 与 data-slot 探针属性', () => {
    const { container } = render(
      <SlotOutlet slotKey="test.dom" context={{}} fallback={<span>Empty</span>} />
    );
    const outletDiv = container.querySelector('[data-slot="test.dom"]');
    expect(outletDiv).not.toBeNull();
    expect((outletDiv as HTMLElement).style.display).toBe('contents');
  });
});
