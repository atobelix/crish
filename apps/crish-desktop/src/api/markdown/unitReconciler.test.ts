// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { reconcileUnits } from './unitReconciler';
import { splitHtmlIntoUnits } from './unitSplitter';

function renderInto(container: HTMLElement, html: string): void {
  reconcileUnits(container, splitHtmlIntoUnits(html));
}

describe('reconcileUnits', () => {
  it('appends list items while preserving every previously rendered item', () => {
    const container = document.createElement('div');
    renderInto(container, '<ul><li><p>第一项</p></li></ul>');

    const list = container.querySelector('ul');
    const firstItem = container.querySelector('li');
    const firstParagraph = container.querySelector('p');
    const firstText = firstParagraph?.firstChild;

    renderInto(
      container,
      '<ul><li><p>第一项</p></li><li><p>第二项</p></li></ul>'
    );

    expect(container.querySelector('ul')).toBe(list);
    expect(container.querySelectorAll('li')[0]).toBe(firstItem);
    expect(container.querySelectorAll('p')[0]).toBe(firstParagraph);
    expect(firstParagraph?.firstChild).toBe(firstText);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.textContent).toBe('第一项第二项');
  });

  it('patches the active inline tail in place and updates attributes', () => {
    const container = document.createElement('div');
    renderInto(
      container,
      '<p class="md-p"><span data-state="active">正在</span></p>'
    );

    const paragraph = container.querySelector('p');
    const activeSpan = container.querySelector('span');
    const activeText = activeSpan?.firstChild;

    renderInto(
      container,
      '<p class="md-p"><span data-state="complete">正在编译</span></p>'
    );

    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelector('span')).toBe(activeSpan);
    expect(activeSpan?.firstChild).toBe(activeText);
    expect(activeSpan?.getAttribute('data-state')).toBe('complete');
    expect(activeSpan?.textContent).toBe('正在编译');
    expect(container.childNodes.length).toBeGreaterThan(0);
  });

  it('appends table rows without rebuilding the table, header, or prior rows', () => {
    const container = document.createElement('div');
    renderInto(
      container,
      '<div class="md-table-wrap"><table class="md-table"><thead>' +
        '<tr><th scope="col">编号</th><th scope="col">名称</th></tr>' +
        '</thead><tbody><tr><td>001</td><td>需求调研</td></tr></tbody>' +
        '</table></div>'
    );

    const wrapper = container.querySelector('.md-table-wrap');
    expect((wrapper as HTMLElement | null)?.style.contain).toBe('layout');
    const table = container.querySelector('table');
    const head = container.querySelector('thead');
    const headerCells = Array.from(container.querySelectorAll('th'));
    const body = container.querySelector('tbody');
    const firstRow = container.querySelector('tbody tr');
    const firstCells = Array.from(container.querySelectorAll('tbody td'));

    renderInto(
      container,
      '<div class="md-table-wrap"><table class="md-table"><thead>' +
        '<tr><th scope="col">编号</th><th scope="col">名称</th></tr>' +
        '</thead><tbody><tr><td>001</td><td>需求调研</td></tr>' +
        '<tr><td>002</td><td>原型设计</td></tr></tbody></table></div>'
    );

    expect(container.querySelector('.md-table-wrap')).toBe(wrapper);
    expect(container.querySelector('table')).toBe(table);
    expect(container.querySelector('thead')).toBe(head);
    expect(Array.from(container.querySelectorAll('th'))).toEqual(headerCells);
    expect(container.querySelector('tbody')).toBe(body);
    expect(container.querySelectorAll('tbody tr')[0]).toBe(firstRow);
    expect(Array.from(container.querySelectorAll('tbody td')).slice(0, 2)).toEqual(
      firstCells
    );
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.textContent).toContain('原型设计');
  });

  it('removes only the retracted suffix and keeps the unchanged prefix', () => {
    const container = document.createElement('div');
    renderInto(container, '<ul><li>第一项</li><li>第二项</li></ul>');
    const firstItem = container.querySelector('li');
    const secondItem = container.querySelectorAll('li')[1];

    renderInto(container, '<ul><li>第一项</li></ul>');

    expect(container.querySelector('li')).toBe(firstItem);
    expect(secondItem?.isConnected).toBe(false);
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  it('replaces the rewritten structural suffix when a unit changes tag', () => {
    const container = document.createElement('div');
    renderInto(container, '<p>unfinished heading</p><p>tail</p>');
    const original = container.firstElementChild;

    renderInto(container, '<h2>finished heading</h2><p>tail</p>');

    expect(container.firstElementChild?.tagName).toBe('H2');
    expect(container.firstElementChild).not.toBe(original);
    expect(container.textContent).toBe('finished headingtail');
  });

  it('reconciles an inline syntax completion inside the existing paragraph', () => {
    const container = document.createElement('div');
    renderInto(container, '<p>unfinished *emphasis</p>');
    const paragraph = container.querySelector('p');

    renderInto(container, '<p>unfinished <em>emphasis</em></p>');

    expect(container.querySelector('p')).toBe(paragraph);
    expect(container.querySelector('em')?.textContent).toBe('emphasis');
    expect(container.textContent).toBe('unfinished emphasis');
    expect(container.innerHTML).not.toContain('*emphasis');
  });

  it('keeps a nonempty rendered frame while an active unit is patched', () => {
    const container = document.createElement('div');
    renderInto(container, '<p>工作</p>');
    expect(container.childNodes.length).toBeGreaterThan(0);

    renderInto(container, '<p>工作中</p>');

    expect(container.childNodes.length).toBeGreaterThan(0);
    expect(container.textContent).toBe('工作中');
  });
});
