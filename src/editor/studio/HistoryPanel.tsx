import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../state/rpc-client.js';
import type { StudioContext } from './types.js';
import { PanelIntro } from './Controls.js';

/**
 * 「版本历史」: the project's Git-like history (.vmotion/history) — commits, branches, merges,
 * checkout / revert with preview + confirm, and merge conflicts resolved item by item.
 * When the workspace is bound to a coordinator it can read and act on the coordinator's
 * shared history instead (through the `historyRemote` proxy).
 */
type Author = { kind: 'ui' | 'mcp' | 'cli' | 'file'; client?: string; tool?: string };
type CommitRow = {
  id: string;
  short: string;
  parent: string | null;
  merge?: string;
  author: Author;
  message: string;
  at: number;
  action: string;
  files: string[];
  source?: string;
  branch?: string;
  refs?: string[];
};
type Branch = { name: string; current: boolean; head: string | null; short: string | null; at: number | null };
type ConflictRow = {
  index: number;
  file: string;
  path: string;
  base?: string;
  ours?: string;
  theirs?: string;
  oursDeleted?: boolean;
  theirsDeleted?: boolean;
};
type BranchState = {
  current: string;
  branches: Branch[];
  merging: { branch: string; into: string } | null;
  conflicts: ConflictRow[];
};
type Pending = {
  title: string;
  detail: string;
  request: Record<string, unknown>;
  preview?: any;
  danger?: boolean;
};
type Source = 'local' | 'remote';

const actionNames: Record<string, string> = {
  init: '初始版本',
  edit: '编辑',
  undo: '撤销',
  redo: '重做',
  external: '外部改动',
  checkout: '检出',
  revert: '回滚',
  merge: '合并',
};

/** coral = a person (Studio, or a collaborator syncing), mint = an external AI, grey = files / CLI. */
export function authorTone(author: Author): { who: string; tone: 'human' | 'ai' | 'neutral' } {
  if (author.kind === 'ui') return { who: '我（Studio）', tone: 'human' };
  if (author.kind === 'file') return { who: '外部文件', tone: 'neutral' };
  if (author.kind === 'cli') return { who: author.tool ? `命令行 · ${author.tool}` : '命令行', tone: 'neutral' };
  const client = author.client ?? 'AI';
  if (author.tool === 'remote_sync' || client === 'remote-sync')
    return { who: client.startsWith('remote:') ? client.slice(7) : '远程同步', tone: 'human' };
  return { who: client.startsWith('remote:') ? client.slice(7) : client, tone: 'ai' };
}

function when(at: number) {
  const d = new Date(at),
    diff = Date.now() - at,
    pad = (n: number) => String(n).padStart(2, '0'),
    clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000 && d.getDate() === new Date().getDate()) return `今天 ${clock}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

/** Lane layout for the graph rail: one column per open line of history. */
function laneLayout(commits: CommitRow[]) {
  const lanes: string[] = [];
  return commits.map((c) => {
    let col = lanes.indexOf(c.id);
    if (col < 0) {
      lanes.push(c.id);
      col = lanes.length - 1;
    }
    const before = lanes.length;
    for (let i = lanes.length - 1; i >= 0; i--) if (lanes[i] === c.id && i !== col) lanes.splice(i, 1);
    col = lanes.indexOf(c.id);
    const parents = [c.parent, c.merge].filter((p): p is string => !!p);
    if (!parents.length) lanes.splice(col, 1);
    else {
      if (lanes.includes(parents[0])) lanes.splice(col, 1);
      else lanes[col] = parents[0];
      if (parents[1] && !lanes.includes(parents[1])) lanes.splice(col + 1, 0, parents[1]);
    }
    return { col, width: Math.max(before, lanes.length, 1) };
  });
}

function Rail({ col, width, merge, tone }: { col: number; width: number; merge: boolean; tone: string }) {
  const step = 12,
    w = Math.min(width, 6) * step + 6;
  return (
    <svg className="vh-rail" width={w} height={44} aria-hidden="true">
      {Array.from({ length: Math.min(width, 6) }, (_, i) => (
        <line key={i} x1={i * step + 9} x2={i * step + 9} y1={0} y2={44} />
      ))}
      <circle
        className={`vh-dot ${tone}${merge ? ' merge' : ''}`}
        cx={Math.min(col, 5) * step + 9}
        cy={22}
        r={merge ? 5.5 : 4.5}
      />
    </svg>
  );
}

function DiffView({ diff }: { diff: any }) {
  if (!diff) return null;
  if (!diff.files?.length) return <p className="hint">这个提交没有改动文件内容。</p>;
  return (
    <div className="vh-diff">
      {diff.files.map((f: { file: string; change: string }) => {
        const patch = diff.patches?.find((p: any) => p.file === f.file);
        return (
          <details key={f.file} open={diff.files.length <= 3}>
            <summary>
              <span className={`vh-change ${f.change}`}>
                {f.change === 'added' ? '新增' : f.change === 'removed' ? '删除' : '修改'}
              </span>
              {f.file}
            </summary>
            {patch?.hunks?.length ? (
              <pre>
                {patch.hunks.map((h: any, i: number) => (
                  <React.Fragment key={i}>
                    <span className="vh-hunk">
                      第 {h.oldStart} 行 → 第 {h.newStart} 行
                    </span>
                    {'\n'}
                    {h.lines.map((line: string, j: number) => (
                      <span
                        key={j}
                        className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : ''}
                      >
                        {line}
                        {'\n'}
                      </span>
                    ))}
                  </React.Fragment>
                ))}
              </pre>
            ) : (
              <p className="hint">仅格式变化或内容过大，未显示逐行差异。</p>
            )}
          </details>
        );
      })}
    </div>
  );
}

const targetLabel = (t: any) => {
  const kind =
    t.kind === 'node' ? '图层' : t.kind === 'scene' ? '场景' : t.kind === 'clip' ? '片段' : t.kind === 'asset' ? '素材' : t.kind;
  const change = t.change === 'added' ? '新增' : t.change === 'removed' ? '删除' : '修改';
  return `${change}${kind} ${t.name ?? t.id ?? ''}${t.fields?.length ? `（${t.fields.slice(0, 4).join('、')}）` : ''}`;
};

export default function HistoryPanel({ context }: { context: StudioContext }) {
  const [source, setSource] = useState<Source>('local'),
    [remoteUrl, setRemoteUrl] = useState<string>(),
    [filter, setFilter] = useState<string>('__current'),
    [state, setState] = useState<BranchState>(),
    [commits, setCommits] = useState<CommitRow[]>([]),
    [more, setMore] = useState(false),
    [selected, setSelected] = useState<string>(),
    [detail, setDetail] = useState<{ commit: any; diff: any }>(),
    [pending, setPending] = useState<Pending>(),
    [newBranch, setNewBranch] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [reload, setReload] = useState(0);

  useEffect(() => {
    rpc('remoteStatus', { localOnly: true })
      .then((r: any) => setRemoteUrl(r?.binding?.url))
      .catch(() => undefined);
  }, []);

  const call = useCallback(
    async (method: 'historyLog' | 'historyRestore' | 'resolve', params: Record<string, unknown>) => {
      if (source === 'remote') return (await rpc('historyRemote', { method, params })) as any;
      if (method === 'historyLog') return (await rpc(method, params)) as any;
      const result = await context.run(method, params);
      // Bring the canvas / timeline up to the new working state.
      await context.run('state', {}).catch(() => undefined);
      return result;
    },
    [source, context],
  );

  const load = useCallback(async () => {
    setError('');
    try {
      const branches = (await call('historyLog', { action: 'branches' })) as BranchState;
      setState(branches);
      const log = await call('historyLog', {
        action: 'log',
        limit: 120,
        ...(filter === '__all' ? { all: true } : filter === '__current' ? {} : { branch: filter }),
      });
      setCommits(log.commits);
      setMore(log.more);
      setSelected((s) => (s && log.commits.some((c: CommitRow) => c.id === s) ? s : log.commits[0]?.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [call, filter]);
  useEffect(() => {
    void load();
  }, [load, reload, context.snapshot.revision]);

  useEffect(() => {
    if (!selected) return setDetail(undefined);
    let live = true;
    Promise.all([
      call('historyLog', { action: 'show', ref: selected }),
      call('historyLog', { action: 'diff', to: selected, patch: true, context: 2 }),
    ])
      .then(([shown, diff]) => live && setDetail({ commit: shown.commit, diff }))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [selected, call]);

  const lanes = useMemo(() => laneLayout(commits), [commits]);
  const current = state?.current ?? 'main';
  const others = (state?.branches ?? []).filter((b) => !b.current);

  /** Every write: preview with mode="plan" first, then the person confirms. */
  const prepare = async (p: Omit<Pending, 'preview'>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const preview = await call('historyRestore', { ...p.request, mode: 'plan' });
      setPending({ ...p, preview });
    } catch (err) {
      // Switching with unrecorded edits: offer the explicit "discard and switch" path instead.
      let e = err;
      const isSwitch = p.request.action === 'branch_switch' || p.request.switch === true;
      if ((e as { code?: string }).code === 'HISTORY_DIRTY' && isSwitch && !p.request.force) {
        try {
          const request = { ...p.request, force: true };
          const preview = await call('historyRestore', { ...request, mode: 'plan' });
          setPending({
            ...p,
            request,
            preview,
            danger: true,
            detail: `${p.detail} 工作区有未记录的改动，确认后这些改动会被丢弃。`,
          });
          return;
        } catch (e2) {
          e = e2;
        }
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      const res = await call('historyRestore', pending.request);
      setPending(undefined);
      setNotice(
        res?.conflicted
          ? `合并出现 ${res.stagedConflicts} 处冲突，请在下方逐项选择保留哪一边。`
          : res?.upToDate
            ? res.note
            : res?.committed === false && res?.note
              ? res.note
              : `${pending.title}完成。`,
      );
      setReload((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const resolveConflict = async (index: number, choice: 'ours' | 'theirs') => {
    setBusy(true);
    setError('');
    try {
      await call('resolve', { index, choice });
      setReload((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = detail?.commit;
  const preview = pending?.preview;
  return (
    <div className="vh-panel">
      <PanelIntro title="版本历史">
        每次被接受的改动都会自动成为一个提交。可以按分支查看、比较差异、检出或回滚，也可以开分支试验后再合并回来。
      </PanelIntro>

      <div className="vh-toolbar">
        {remoteUrl && (
          <div className="vh-segment" role="group" aria-label="历史来源">
            <button aria-pressed={source === 'local'} onClick={() => setSource('local')}>
              本地工程
            </button>
            <button aria-pressed={source === 'remote'} onClick={() => setSource('remote')} title={remoteUrl}>
              协调节点
            </button>
          </div>
        )}
        <label className="studio-field vh-filter">
          <span>显示分支</span>
          <select aria-label="显示分支" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="__current">当前分支（{current}）</option>
            <option value="__all">全部分支</option>
            {(state?.branches ?? []).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <div className="vh-branches" aria-label="分支">
          {(state?.branches ?? []).map((b) => (
            <span key={b.name} className={`vh-branch${b.current ? ' current' : ''}`}>
              {b.current && <i aria-hidden="true" />}
              {b.name}
              {!b.current && (
                <span className="vh-branch-actions">
                  <button
                    disabled={busy || !!state?.merging}
                    aria-label={`切换到 ${b.name}`}
                    onClick={() =>
                      void prepare({
                        title: `切换到分支「${b.name}」`,
                        detail: '工程文件会变成该分支最新提交的内容；当前分支的提交都会保留。',
                        request: { action: 'branch_switch', branch: b.name },
                      })
                    }
                  >
                    切换
                  </button>
                  <button
                    disabled={busy || !!state?.merging}
                    aria-label={`把 ${b.name} 合并到 ${current}`}
                    onClick={() =>
                      void prepare({
                        title: `合并「${b.name}」到「${current}」`,
                        detail: '按稳定 ID 三路合并，生成一个双父合并提交，可以一次撤销。',
                        request: { action: 'merge', branch: b.name },
                      })
                    }
                  >
                    合并
                  </button>
                  <button
                    className="vh-quiet"
                    disabled={busy}
                    aria-label={`删除分支 ${b.name}`}
                    onClick={() =>
                      void prepare({
                        title: `删除分支「${b.name}」`,
                        detail: '只删除分支名，提交仍保存在历史里。',
                        request: { action: 'branch_delete', branch: b.name },
                        danger: true,
                      })
                    }
                  >
                    删除
                  </button>
                </span>
              )}
            </span>
          ))}
        </div>
        <form
          className="vh-new-branch"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newBranch.trim();
            if (!name) return;
            void prepare({
              title: `新建分支「${name}」并切换过去`,
              detail: `从「${current}」的最新提交开始；之后的改动只记在新分支上。`,
              request: { action: 'branch_create', branch: name, switch: true },
            });
          }}
        >
          <input
            aria-label="新分支名"
            placeholder="新分支名，如 try-color"
            value={newBranch}
            onChange={(e) => setNewBranch(e.target.value)}
          />
          <button type="submit" disabled={busy || !newBranch.trim() || !!state?.merging}>
            新建分支
          </button>
        </form>
      </div>

      {state?.merging && (
        <section className="vh-merge" aria-label="合并冲突">
          <header>
            <strong>
              正在把「{state.merging.branch}」合并到「{state.merging.into}」
            </strong>
            <span>
              {state.conflicts.length
                ? `还有 ${state.conflicts.length} 处冲突需要选择`
                : '冲突已全部解决'}
            </span>
            <button
              className="vh-quiet"
              disabled={busy}
              onClick={() =>
                void prepare({
                  title: '放弃这次合并',
                  detail: '恢复到合并前的状态，未完成的选择都会丢弃。',
                  request: { action: 'merge_abort' },
                  danger: true,
                })
              }
            >
              放弃合并
            </button>
          </header>
          {state.conflicts.map((c) => (
            <article key={`${c.index}:${c.file}:${c.path}`} className="vh-conflict">
              <div className="vh-conflict-where">
                <strong>{c.file}</strong>
                <code>{c.path === '$file' ? '整个文件' : c.path === '$source' ? '源码' : c.path}</code>
              </div>
              <div className="vh-sides">
                <div className="vh-side ours">
                  <span>当前分支 · {state.merging!.into}</span>
                  <pre>{c.oursDeleted ? '（已删除）' : c.ours}</pre>
                  <button disabled={busy} onClick={() => void resolveConflict(c.index, 'ours')}>
                    保留这一边
                  </button>
                </div>
                <div className="vh-side theirs">
                  <span>合并来源 · {state.merging!.branch}</span>
                  <pre>{c.theirsDeleted ? '（已删除）' : c.theirs}</pre>
                  <button disabled={busy} onClick={() => void resolveConflict(c.index, 'theirs')}>
                    采用这一边
                  </button>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {pending && (
        <section className={`vh-confirm${pending.danger ? ' danger' : ''}`} role="dialog" aria-label="确认操作">
          <strong>{pending.title}</strong>
          <p>{pending.detail}</p>
          {preview?.changedFiles && (
            <p>
              {preview.changedFiles.length
                ? `将改动 ${preview.changedFiles.length} 个文件：${preview.changedFiles.slice(0, 6).join('、')}${preview.changedFiles.length > 6 ? ' 等' : ''}`
                : '工程文件不会变化。'}
            </p>
          )}
          {preview?.conflicts?.length > 0 && (
            <p className="vh-warn">预计 {preview.conflicts.length} 处冲突，合并后需要逐项选择。</p>
          )}
          {preview?.upToDate && <p>{preview.note}</p>}
          {preview?.merged === false && pending.request.action === 'branch_delete' && (
            <p className="vh-warn">这个分支还有没合并到「{current}」的提交，删除后只能通过提交 ID 找回。</p>
          )}
          {preview?.discarded?.length > 0 && (
            <p className="vh-warn">未记录的改动会被丢弃：{preview.discarded.join('、')}</p>
          )}
          <div className="candidate-buttons">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                if (pending.request.action === 'branch_delete' && preview?.merged === false)
                  pending.request = { ...pending.request, force: true };
                void confirm();
              }}
            >
              {busy ? '正在处理…' : '确认'}
            </button>
            <button disabled={busy} onClick={() => setPending(undefined)}>
              取消
            </button>
          </div>
        </section>
      )}
      {notice && <p className="vh-notice">{notice}</p>}
      {error && (
        <p className="studio-error" role="alert">
          {error}
        </p>
      )}

      <div className="vh-body">
        <ol className="vh-list" aria-label="提交列表">
          {commits.map((c, i) => {
            const a = authorTone(c.author);
            return (
              <li key={c.id}>
                <button
                  className={`vh-commit${selected === c.id ? ' selected' : ''}`}
                  aria-pressed={selected === c.id}
                  onClick={() => setSelected(c.id)}
                >
                  <Rail col={lanes[i]?.col ?? 0} width={lanes[i]?.width ?? 1} merge={!!c.merge} tone={a.tone} />
                  <span className="vh-commit-text">
                    <span className="vh-commit-title">
                      {c.merge && <b className="vh-tag merge">合并</b>}
                      {c.refs?.map((r) => (
                        <b key={r} className={`vh-tag ref${r.startsWith('HEAD') ? ' head' : ''}`}>
                          {r.replace('HEAD -> ', '')}
                        </b>
                      ))}
                      {c.message}
                    </span>
                    <span className="vh-commit-meta">
                      <span className={`vh-who ${a.tone}`}>{a.who}</span>
                      <span>{when(c.at)}</span>
                      <span>{c.files.length} 个文件</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {more && <li className="hint">只显示最近 {commits.length} 个提交。</li>}
          {!commits.length && !error && <li className="hint">正在读取历史…</li>}
        </ol>

        <section className="vh-detail" aria-label="提交详情">
          {commit ? (
            <>
              <header>
                <span className={`vh-who ${authorTone(commit.author).tone}`}>
                  {authorTone(commit.author).who}
                </span>
                <h3>{commit.message}</h3>
                <p>
                  {actionNames[commit.action] ?? commit.action} · {new Date(commit.at).toLocaleString('zh-CN')} ·{' '}
                  <code>{commit.short}</code>
                  {commit.merge && (
                    <>
                      {' '}
                      · 合并自 <code>{commit.merge.slice(0, 10)}</code>
                    </>
                  )}
                </p>
              </header>
              <div className="candidate-buttons">
                <button
                  disabled={busy || !!state?.merging}
                  onClick={() =>
                    void prepare({
                      title: `检出到 ${commit.short}`,
                      detail: '把整个工程恢复成这个提交的样子，作为一次新的、可撤销的提交。',
                      request: { action: 'checkout', ref: commit.id },
                    })
                  }
                >
                  检出到此提交
                </button>
                <button
                  disabled={busy || !commit.parent || !!state?.merging}
                  onClick={() =>
                    void prepare({
                      title: `回滚 ${commit.short}`,
                      detail: '只撤回这个提交带来的改动，保留之后的其他改动。',
                      request: { action: 'revert', ref: commit.id },
                    })
                  }
                >
                  回滚此提交
                </button>
                <button
                  disabled={busy || !!state?.merging}
                  onClick={() => {
                    const name = `from-${commit.short.slice(0, 7)}`;
                    void prepare({
                      title: `从 ${commit.short} 新建分支「${name}」`,
                      detail: '新分支指向这个提交，不会改动当前工程。',
                      request: { action: 'branch_create', branch: name, ref: commit.id },
                    });
                  }}
                >
                  从此处开分支
                </button>
              </div>
              {commit.targets?.length > 0 && (
                <ul className="vh-targets">
                  {commit.targets.slice(0, 12).map((t: any, i: number) => (
                    <li key={i}>{targetLabel(t)}</li>
                  ))}
                </ul>
              )}
              <DiffView diff={detail?.diff} />
            </>
          ) : (
            <p className="hint">选择左侧的提交查看改动。</p>
          )}
        </section>
      </div>
      {others.length === 0 && !state?.merging && (
        <p className="hint">目前只有「{current}」一条主线。新建分支后可以在这里切换与合并。</p>
      )}
    </div>
  );
}
