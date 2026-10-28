import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// 自适应解析：优先直连 packages/ui 独立源码，未抽取前 fallback 至 desktop 本地源码
const PKG_UI_SRC = resolve(__dirname, '../../packages/ui/src/index.ts');
const LOCAL_UI_SRC = resolve(__dirname, 'src/components/ui/index.ts');
const resolvedUIEntry = existsSync(PKG_UI_SRC) ? PKG_UI_SRC : LOCAL_UI_SRC;

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'playground'),
  server: {
    port: 5174,
    strictPort: true,
    open: false,
    host: '127.0.0.1',
    fs: {
      allow: [resolve(__dirname, '..'), resolve(__dirname)],
    },
  },
  resolve: {
    alias: [
      // 1. 直连 ui 原子层源码，无论包抽离前后均实现无编译极速 HMR
      {
        find: /^@crish\/ui$/,
        replacement: resolvedUIEntry,
      },
      {
        find: /^@\/components\/ui$/,
        replacement: resolvedUIEntry,
      },
      // 2. 根路径别名对齐
      {
        find: '@',
        replacement: resolve(__dirname, 'src'),
      },
      // 3. Tauri Native 虚拟挡板（防止组件意外调用 native API 导致白屏）
      {
        find: /^@tauri-apps\/api(.*)$/,
        replacement: resolve(__dirname, 'playground/mock/tauri-mock.ts'),
      },
      {
        find: /^@tauri-apps\/plugin(.*)$/,
        replacement: resolve(__dirname, 'playground/mock/tauri-mock.ts'),
      },
    ],
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
    },
  },
});
