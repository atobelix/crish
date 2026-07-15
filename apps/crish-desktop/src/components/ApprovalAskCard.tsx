/**
 * 权限询问卡（通俗文案 + 必有用户输入，参考 TRAE 式「其他/请输入」）
 */
import React, { useState } from 'react';
import * as Lucide from 'lucide-react';

type Props = {
  msgId: string;
  summary: string;
  cmd?: string;
  busy?: boolean;
  onAllow: (note: string) => void;
  onAllowRemember: (note: string) => void;
  onDeny: () => void;
};

/** 把技术摘要收成用户能懂的一句话（summary 优先为人话主文案） */
function plainQuestion(summary: string, cmd?: string): string {
  const s = (summary || '').trim();
  const c = (cmd || '').trim();
  // summary 已是人话时，直接问「是否允许…」
  if (/[\u4e00-\u9fff]/.test(s) && s.length <= 56 && !/^[\w./\\-]+$/.test(s)) {
    if (/^是否允许/.test(s)) return s;
    if (
      /正在|查看|修改|搜索|运行|安装|构建|列出|浏览|执行|启动|切换|推送|拉取|暂存|贮藏|创建|克隆|配置|发布|还原|回退|重置|请求|连接|传输|管理|查询|应用|进入|删除|复制|移动|格式化|检查|获取|操作|通过|处理|添加|卸载|编译|刷新|更新/.test(
        s,
      )
    ) {
      return `是否允许：${s.replace(/^正在/, '')}？`.replace(/？？$/, '？');
    }
  }
  if (/读|查看|read/i.test(s) && !/写|删|edit|write|rm|修改/i.test(s)) {
    return '是否允许查看相关文件或信息？';
  }
  if (/写|编辑|修改|edit|write|patch/i.test(s)) {
    return '是否允许修改项目中的文件？';
  }
  if (/删|rm |remove|delete/i.test(s) || /删|rm |delete/i.test(c)) {
    return '是否允许删除文件或执行有风险的清理？';
  }
  if (/git |push|commit/i.test(c) || /Git|git/i.test(s)) {
    return '是否允许执行 Git 相关操作？';
  }
  if (/kubectl |aws |ssh |chmod |dotnet |cmake |make /i.test(c) || /Kubernetes|AWS|SSH|权限|\.NET|CMake|Make/i.test(s)) {
    return '是否允许执行系统或云资源相关操作？';
  }
  if (/npm |pnpm |yarn |bun |pip |cargo |go |composer |安装|构建/i.test(c + s)) {
    return '是否允许运行安装或构建类命令？';
  }
  if (c) {
    return '是否允许运行下面这条命令？';
  }
  return '是否允许继续这项操作？';
}

export const ApprovalAskCard: React.FC<Props> = ({
  msgId,
  summary,
  cmd,
  busy,
  onAllow,
  onAllowRemember,
  onDeny,
}) => {
  const [note, setNote] = useState('');
  const question = plainQuestion(summary, cmd);

  return (
    <div className="approval-card" role="region" aria-label="需要你的确认" data-msg={msgId}>
      <div className="approval-card-top">
        <span className="approval-card-badge">
          <Lucide.ShieldQuestion size={14} strokeWidth={1.75} />
          需要你的确认
        </span>
        <span className="approval-card-status">等待中</span>
      </div>
      <div className="approval-card-title">{question}</div>
      {summary && summary !== question ? (
        <div className="approval-card-desc">{summary}</div>
      ) : null}
      {cmd ? (
        <div className="approval-card-cmd-wrap">
          <span className="approval-card-cmd-label">将执行</span>
          <code className="approval-card-cmd">{cmd}</code>
        </div>
      ) : null}

      <label className="approval-card-note">
        <span>补充说明（可选，也可直接写你的要求）</span>
        <textarea
          className="approval-card-input"
          rows={2}
          maxLength={500}
          placeholder="例如：只允许这一次 / 不要改测试文件…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
        <span className="approval-card-count">{note.length}/500</span>
      </label>

      <div className="approval-card-actions">
        <button
          type="button"
          className="approval-card-btn ghost"
          disabled={busy}
          onClick={() => onAllowRemember(note)}
          title="允许，并将命令前缀加入白名单"
        >
          允许并记住
        </button>
        <button
          type="button"
          className="approval-card-btn deny"
          disabled={busy}
          onClick={onDeny}
        >
          拒绝
        </button>
        <button
          type="button"
          className="approval-card-btn allow"
          disabled={busy}
          onClick={() => onAllow(note)}
        >
          允许
        </button>
      </div>
    </div>
  );
};
