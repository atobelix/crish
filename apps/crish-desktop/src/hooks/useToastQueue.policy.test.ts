/**
 * Toast 产品策略契约：仅错误与可撤销。
 * 模式与 useToastQueue 导出同源，防止成功刷屏回流。
 * 再扫：调用点零成功 toast + 设置/定时/模型/字体/账户 页内成功·进度禁令加固。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyToastPolicy,
  formatEngineDegradeToast,
  isAllowedToast,
  isForbiddenSuccessToast,
  shouldDropSuccessToast,
} from './useToastQueue';

describe('toast product policy', () => {
  it('forbids routine success / open-panel / tip toasts', () => {
    const bad = [
      '已打开定时任务',
      '已导出 Markdown',
      '已复制',
      '已保存',
      '本机已保存；引擎未连接',
      '本机已保存；引擎未同步：timeout',
      '已进入目标模式',
      '已加载技能 foo',
      '已记住规则',
      '已粘贴图片',
      '已加入白名单：npm',
      '已创建分支：会话 - 分支',
      '已批准执行，已切回需确认模式',
      '已停止目标',
      '已同步到引擎',
      '已添加；未带本地密钥，请确认引擎已有密钥',
      '正在检查更新…',
      '正在重新生成…',
      '切换到演示模式',
      '协作看板',
      '预览浏览器 → https://x',
      '提示：名称含文件/推送类关键词时，引擎仍不会自动监听仓库。',
      '未扫描到本机字体',
      '当前引擎不支持从界面启停；MCP 通常随任务运行时连接',
    ];
    for (const m of bad) {
      expect(isForbiddenSuccessToast(m), m).toBe(true);
    }
  });

  it('forbids settings / schedule / models page success residues (actionHint·setOk)', () => {
    // 再扫：这些现仅走页内 hint，禁止回流 toast
    const residual = [
      '已创建',
      '已启用',
      '已暂停',
      '已删除',
      '已加入列表',
      '已添加并设为当前 · gpt-4o',
      '已设为当前模型 · gpt-4o',
      '密钥已保存',
      '密钥已保存并同步',
      '地址已保存并同步引擎',
      '已获取 12 个模型，列表已更新',
      '连通成功 · gpt-4o · 120ms',
      '正在获取模型列表…',
      '正在测试 gpt-4o…',
    ];
    for (const m of residual) {
      expect(isForbiddenSuccessToast(m), m).toBe(true);
      expect(shouldDropSuccessToast(m), m).toBe(true);
      expect(classifyToastPolicy(m), m).toBe('drop-success');
    }
  });

  it('forbids second-wave residues: schedule trigger / font scan / account / CRUD verbs', () => {
    // 再扫二轮：定时触发、字体、账户连通、通用成功动词与进度
    const wave2 = [
      '已触发',
      '已触发 · ab12cd34',
      '已连接 ws://127.0.0.1:9',
      '已列出 42 个本机字体',
      '已切换模型',
      '已更新',
      '已应用变更',
      '已刷新列表',
      '已导入配置',
      '已恢复默认',
      '已重置',
      '已清空白名单',
      '已移除项',
      '已禁用技能',
      '已完成同步',
      '已记录用户偏好',
      '已写入磁盘',
      '已选中文件',
      '保存成功',
      '同步成功',
      '更新成功',
      '操作成功',
      '连接成功',
      '扫描完成',
      '列表已更新',
      '正在扫描…',
      '正在同步到引擎…',
      '正在连接…',
      '连接中…',
    ];
    for (const m of wave2) {
      expect(isForbiddenSuccessToast(m), m).toBe(true);
      expect(shouldDropSuccessToast(m), m).toBe(true);
      expect(classifyToastPolicy(m), m).toBe('drop-success');
    }
  });

  it('allows errors and undoable archive/branch-style toasts', () => {
    const good = [
      '导出失败',
      '复制失败',
      '用法：/goal <要完成的目标>',
      '未找到该技能',
      '无法安全应用',
      '已归档: 某会话',
      '已分叉: 某会话 - 分支',
      '已分叉会话（可撤销）',
      '引擎未同步：timeout（本机已保存）',
      '引擎未连接（本机已保存）',
      '未带本地密钥，请确认引擎已有密钥',
      '规则较长，引擎侧已截断',
      '技能斜杠命令已关闭（设置 → 技能）',
      '该规则已存在',
      '目标已达上限（8 轮）',
      '部分失败 2',
      '请先打开项目后再切换到项目作用域',
      '请等待当前回复完成',
      '引擎回报模型不一致，请重试',
      '没有可复制的正文',
      '没有可重新生成的内容',
      '该消息不在当前过滤结果中',
      '请确认引擎已有密钥',
      '浏览器拦截了弹窗',
      '无效命令',
      '应用失败 · a.ts：冲突',
      '部分失败 3 · b.ts 等',
      '无法打开路径（需桌面壳）',
      '未找到待确认项',
      '图片粘贴失败',
      '快捷命令保存失败：disk full',
    ];
    for (const m of good) {
      expect(isAllowedToast(m) || !isForbiddenSuccessToast(m), m).toBe(true);
      expect(isForbiddenSuccessToast(m), m).toBe(false);
      expect(shouldDropSuccessToast(m), m).toBe(false);
      expect(classifyToastPolicy(m), m).toBe('show');
    }
  });

  it('archive/branch with title still not open-panel spam', () => {
    // 归档/分叉带 Undo 是策略允许的；「已打开」类不是
    expect(isForbiddenSuccessToast('已归档: 测试会话')).toBe(false);
    expect(isForbiddenSuccessToast('已分叉: 测试会话 - 分支')).toBe(false);
    expect(isForbiddenSuccessToast('已打开设置')).toBe(true);
  });

  it('shouldDropSuccessToast: drops bare success, keeps onUndo path', () => {
    const noop = () => {};
    expect(shouldDropSuccessToast('已保存')).toBe(true);
    expect(shouldDropSuccessToast('已创建')).toBe(true);
    expect(shouldDropSuccessToast('已加入列表')).toBe(true);
    expect(shouldDropSuccessToast('已触发 · deadbeef')).toBe(true);
    expect(shouldDropSuccessToast('已列出 3 个本机字体')).toBe(true);
    // 可撤销：即使文案像成功也放行（归档/分叉）
    expect(shouldDropSuccessToast('已归档: 某会话', noop)).toBe(false);
    expect(shouldDropSuccessToast('已分叉: 某会话 - 分支', noop)).toBe(false);
    // 成功 + onUndo 理论上可过门闩（产品仍应避免造假 Undo）
    expect(shouldDropSuccessToast('已保存', noop)).toBe(false);
    // 错误永不 drop
    expect(shouldDropSuccessToast('保存失败')).toBe(false);
    expect(shouldDropSuccessToast('保存失败', noop)).toBe(false);
  });

  it('drops empty / whitespace messages (no blank toast flash)', () => {
    expect(shouldDropSuccessToast('')).toBe(true);
    expect(shouldDropSuccessToast('   ')).toBe(true);
    expect(shouldDropSuccessToast('\n\t')).toBe(true);
    expect(classifyToastPolicy('')).toBe('drop-empty');
    expect(classifyToastPolicy('  ')).toBe('drop-empty');
    // 空串不算「成功禁令」命中，但入口仍 drop
    expect(isForbiddenSuccessToast('')).toBe(false);
    expect(isAllowedToast('')).toBe(false);
  });

  it('classifyToastPolicy: show vs drop-success vs drop-empty', () => {
    const undo = () => {};
    expect(classifyToastPolicy('复制失败')).toBe('show');
    expect(classifyToastPolicy('已归档: x', undo)).toBe('show');
    expect(classifyToastPolicy('已保存')).toBe('drop-success');
    expect(classifyToastPolicy('已触发')).toBe('drop-success');
    expect(classifyToastPolicy('正在获取模型列表…')).toBe('drop-success');
    expect(classifyToastPolicy('')).toBe('drop-empty');
  });

  it('degradation toasts lead with failure, not bare 已保存 success', () => {
    // 旧文案「本机已保存；引擎未连接」易被当成成功刷屏；应先说问题
    expect(isForbiddenSuccessToast('本机已保存；引擎未连接')).toBe(true);
    expect(isForbiddenSuccessToast('本机已保存；引擎未同步：x')).toBe(true);
    expect(isAllowedToast('引擎未连接（本机已保存）')).toBe(true);
    expect(isAllowedToast('引擎未同步：econnrefused（本机已保存）')).toBe(true);
    expect(isForbiddenSuccessToast(formatEngineDegradeToast(null))).toBe(false);
    expect(isForbiddenSuccessToast(formatEngineDegradeToast('timeout'))).toBe(false);
    expect(formatEngineDegradeToast(null)).toBe('引擎未连接（本机已保存）');
    expect(formatEngineDegradeToast('引擎未连接')).toBe('引擎未连接（本机已保存）');
    expect(formatEngineDegradeToast('timeout')).toBe('引擎未同步：timeout（本机已保存）');
    expect(formatEngineDegradeToast('引擎未同步：econnrefused')).toBe(
      '引擎未同步：econnrefused（本机已保存）',
    );
  });

  it('formatEngineDegradeToast rewrites legacy success-leading detail', () => {
    // 若调用方误把旧文案当 error 传入，仍输出问题优先句式
    expect(formatEngineDegradeToast('本机已保存；引擎未连接')).toBe(
      '引擎未连接（本机已保存）',
    );
    expect(formatEngineDegradeToast('本机已保存；引擎未同步：timeout')).toBe(
      '引擎未同步：timeout（本机已保存）',
    );
    expect(formatEngineDegradeToast('本机已保存：disk')).toBe(
      '引擎未同步：disk（本机已保存）',
    );
    expect(isForbiddenSuccessToast(formatEngineDegradeToast('本机已保存；引擎未连接'))).toBe(
      false,
    );
    expect(shouldDropSuccessToast(formatEngineDegradeToast('本机已保存；timeout'))).toBe(
      false,
    );
  });

  it('forbids third-wave residues: update check / unit price / provider toggle / font already-set', () => {
    // 再扫三轮：快捷更新检查、模型单价与供应商开关、字体「已是」页内 hint
    const wave3 = [
      '当前已是最新版本',
      '单价已保存 · gpt-4o',
      '供应商已启用',
      '供应商已关闭',
      '界面字体已是「宋体」',
      '代码字体已是「Consolas」',
      '已是默认字体',
      '无需更新',
      '检查完成',
      '最新版本',
    ];
    for (const m of wave3) {
      expect(isForbiddenSuccessToast(m), m).toBe(true);
      expect(shouldDropSuccessToast(m), m).toBe(true);
      expect(classifyToastPolicy(m), m).toBe('drop-success');
    }
  });

  it('call-site matrix: real desktop toasts pass gate; page hints stay dropped', () => {
    // 抽样真实调用点文案：错误应 show；页内 hint 若误入 showToast 应 drop
    const mustShow = [
      '导出失败',
      '复制失败',
      '保存失败',
      '连接失败：offline',
      '扫描失败：x',
      '字体应用失败：x',
      '读取供应商失败：x',
      '启动失败',
      '停止失败',
      '创建失败，请检查引擎是否就绪',
      '触发失败',
      '删除失败',
      '更新失败',
      '切换失败：未知错误',
      '未带本地密钥，请确认引擎已有密钥',
      '引擎回报模型不一致，请重试',
      '用法：/learn <要记住的规则>',
      '该规则已存在',
      '技能斜杠命令已关闭（设置 → 技能）',
      '未找到该技能，请在设置 → 技能 中确认名称与启用状态',
      '目标已达上限（8 轮）',
      '请输入字体名称',
      '请等待当前回复完成',
      '没有可复制的正文',
      '该消息不在当前过滤结果中',
      '未找到该固定消息',
      '未找到待确认项',
      '无法安全自动应用，请在编辑器确认',
      '无法读取 Git 状态',
      '从 Git 载入失败',
      '页面无法刷新',
      '当前地址无法在外部打开',
      '浏览器拦截了弹窗',
      '空白页无法加入书签',
      '无效命令',
      '部分失败 2',
      '应用失败 · foo.ts',
    ];
    for (const m of mustShow) {
      expect(shouldDropSuccessToast(m), `must show: ${m}`).toBe(false);
      expect(classifyToastPolicy(m), m).toBe('show');
    }

    const mustDrop = [
      '已设为当前模型 · gpt-4o',
      '已添加并设为当前 · gpt-4o',
      '已加入列表',
      '密钥已保存并同步',
      '地址已保存并同步引擎',
      '已获取 12 个模型，列表已更新',
      '连通成功 · gpt-4o · 120ms',
      '正在获取模型列表…',
      '正在测试 gpt-4o…',
      '已创建',
      '已启用',
      '已暂停',
      '已删除',
      '已触发 · deadbeef',
      '已列出 12 个本机字体',
      '未扫描到本机字体',
      '已连接 ws://127.0.0.1:1',
      '提示：名称含文件/推送类关键词时，引擎仍不会自动监听仓库。',
      '已打开设置',
      '已复制',
      '已保存',
      '本机已保存；引擎未连接',
      // 三轮残余：真实/潜在成功回流
      '当前已是最新版本',
      '单价已保存 · gpt-4o',
      '供应商已启用',
      '供应商已关闭',
      '界面字体已是「宋体」',
      '已是默认字体',
    ];
    for (const m of mustDrop) {
      expect(shouldDropSuccessToast(m), `must drop: ${m}`).toBe(true);
      expect(classifyToastPolicy(m), m).toBe('drop-success');
    }
  });
});
