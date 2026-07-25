import { installBrowserStorageMocks } from '@crish/test-utils';

// 为集成测试环境安装统一的 localStorage / sessionStorage mock。
// 原本在此处内联 vi.fn + Map 实现，现已下沉到 @crish/test-utils 以消除跨文件重复。
installBrowserStorageMocks();
