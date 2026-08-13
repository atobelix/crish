// 页面占位模板冒烟测试（M4 §2.3 templates/）：标题必显 + 描述可选分支
import { render, screen } from '@testing-library/react-native';
import PlaceholderScreen from './PlaceholderScreen';

describe('PlaceholderScreen（骨架期统一占位形态）', () => {
  it('渲染标题；无描述时不渲染描述行', async () => {
    await render(<PlaceholderScreen title="设置" />);
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.queryByText(/功能即将上线/)).toBeNull();
  });

  it('带描述时渲染描述文案', async () => {
    await render(
      <PlaceholderScreen title="文件" description="文件浏览功能即将上线" />
    );
    expect(screen.getByText('文件')).toBeTruthy();
    expect(screen.getByText('文件浏览功能即将上线')).toBeTruthy();
  });
});
