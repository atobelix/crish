// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Trans } from '../Trans';
import { I18nProvider } from '../I18nContext';

describe('Trans 富文本插槽组件测试套件', () => {
  describe('1. 纯文本与模板替换', () => {
    it('支持直接通过 children 渲染纯文本', () => {
      render(<Trans>简单的纯文本内容</Trans>);
      expect(screen.getByText('简单的纯文本内容')).toBeInTheDocument();
    });

    it('支持通过 fallback 属性渲染纯文本', () => {
      render(<Trans fallback="来自 Fallback 的纯文本" />);
      expect(screen.getByText('来自 Fallback 的纯文本')).toBeInTheDocument();
    });
  });

  describe('2. 单层与嵌套标签组件注入', () => {
    it('支持单层标签（<b>, <a>）映射为传入的 React 节点', () => {
      render(
        <Trans
          fallback="欢迎使用 <b>Crish</b>，点击 <a>了解更多</a>"
          components={{
            b: <strong data-testid="brand" />,
            a: <a href="https://conex.dev" data-testid="link" />,
          }}
        />
      );

      const brand = screen.getByTestId('brand');
      expect(brand.tagName).toBe('STRONG');
      expect(brand).toHaveTextContent('Crish');

      const link = screen.getByTestId('link');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', 'https://conex.dev');
      expect(link).toHaveTextContent('了解更多');
    });

    it('支持多层深度嵌套标签（<a><b>...</b></a>）', () => {
      render(
        <Trans
          fallback="请阅读并同意 <license>开源社区的 <b>核心许可声明</b></license>。"
          components={{
            license: <div data-testid="license-box" className="box" />,
            b: <strong data-testid="license-strong" />,
          }}
        />
      );

      const licenseBox = screen.getByTestId('license-box');
      expect(licenseBox).toBeInTheDocument();

      const strong = screen.getByTestId('license-strong');
      expect(licenseBox).toContainElement(strong);
      expect(strong).toHaveTextContent('核心许可声明');
      expect(licenseBox).toHaveTextContent('开源社区的 核心许可声明');
    });

    it('支持同名标签嵌套（<box>Outer <box>Inner</box></box>）', () => {
      render(
        <Trans
          fallback="<box>外层容器 <box>内层容器</box></box>"
          components={{
            box: <span data-testid="nest-box" className="nested-item" />,
          }}
        />
      );

      const boxes = screen.getAllByTestId('nest-box');
      expect(boxes.length).toBe(2);
      expect(boxes[0]).toContainElement(boxes[1]);
      expect(boxes[1]).toHaveTextContent('内层容器');
    });

    it('支持函数式插槽与数字索引标签（<0>...</0>）', () => {
      render(
        <Trans
          fallback="用户提示：<0>重要须知</0>"
          components={{
            0: (children) => <mark data-testid="num-tag">{children}</mark>,
          }}
        />
      );

      const mark = screen.getByTestId('num-tag');
      expect(mark.tagName).toBe('MARK');
      expect(mark).toHaveTextContent('重要须知');
    });

    it('未在 components 注册的标签安全降级，保留内部文字，绝不抛出异常', () => {
      render(
        <Trans fallback="保留 <unregistered>未注册标签内的文字</unregistered> 完整" />
      );

      expect(screen.getByText(/未注册标签内的文字/)).toBeInTheDocument();
    });
  });

  describe('3. 变量参数插值 ({param})', () => {
    it('正确插值字符串与数值变量', () => {
      render(
        <Trans
          fallback="你好 {name}，当前排队 {count} 人"
          values={{ name: 'Alice', count: 42 }}
        />
      );

      expect(
        screen.getByText('你好 Alice，当前排队 42 人')
      ).toBeInTheDocument();
    });

    it('支持标签内部包裹插值变量', () => {
      render(
        <Trans
          fallback="欢迎登录 <user>{username}</user>，角色为 <b>{role}</b>"
          values={{ username: 'Bob', role: 'Admin' }}
          components={{
            user: <span data-testid="user-node" />,
            b: <strong data-testid="role-node" />,
          }}
        />
      );

      expect(screen.getByTestId('user-node')).toHaveTextContent('Bob');
      expect(screen.getByTestId('role-node')).toHaveTextContent('Admin');
    });

    it('支持将 ReactElement 直接作为插值参数传入', () => {
      render(
        <Trans
          fallback="头像：{avatarNode} 用户：{name}"
          values={{
            avatarNode: (
              <img src="/test.png" alt="UserAvatar" data-testid="avatar-img" />
            ),
            name: 'Charlie',
          }}
        />
      );

      expect(screen.getByTestId('avatar-img')).toBeInTheDocument();
      expect(screen.getByText(/Charlie/)).toBeInTheDocument();
    });

    it('缺失参数与异常数值平滑消解，杜绝 "undefined" 与 "NaN" 污染', () => {
      render(
        <Trans
          fallback="缺失项：{missingParam}，异常数值：{invalidNum}，空值：{nullVal}"
          values={{
            invalidNum: NaN,
            nullVal: null,
          }}
        />
      );

      // 缺失参数保留原形 {missingParam}，NaN 转为 "-"，null 转为空
      expect(
        screen.getByText(/缺失项：\{missingParam\}，异常数值：-，空值：/)
      ).toBeInTheDocument();
    });
  });

  describe('4. 缺失键与上下文回退行为', () => {
    it('未命中 i18nKey 时回退为显式 fallback', () => {
      render(
        <Trans i18nKey="non.existent.random.key" fallback="自定义回退文案" />
      );

      expect(screen.getByText('自定义回退文案')).toBeInTheDocument();
    });

    it('未命中 i18nKey 且无 fallback 时回退为 string children', () => {
      render(<Trans i18nKey="non.existent.key">默认子节点文本</Trans>);

      expect(screen.getByText('默认子节点文本')).toBeInTheDocument();
    });

    it('在 I18nProvider 环境下正确获取中英文词条', () => {
      const { unmount } = render(
        <I18nProvider initialLanguage="zh-CN">
          <Trans i18nKey="common.ok" />
        </I18nProvider>
      );
      expect(screen.getByText('确定')).toBeInTheDocument();
      unmount();

      render(
        <I18nProvider initialLanguage="en-US">
          <Trans i18nKey="common.ok" />
        </I18nProvider>
      );
      expect(screen.getByText('OK')).toBeInTheDocument();
    });

    it('极端破损的 XML 字符串容错，绝不抛出未捕获异常白屏', () => {
      expect(() => {
        render(<Trans fallback="Broken <tag without close" />);
      }).not.toThrow();

      expect(() => {
        render(<Trans fallback="Random <123> mismatched </456> tags" />);
      }).not.toThrow();
    });
  });
});
