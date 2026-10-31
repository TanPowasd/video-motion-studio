import React, { useCallback, useEffect, useRef, useState } from 'react';
import './desktop-api.js';
import './remote-collaboration.css';
import { Icon } from './Icons.js';
import { rpc, rpcTyped } from './state/rpc-client.js';
import type { RemoteBinding } from '../core/remote-model.js';
import type { RemoteHostStatus, RemoteProbeResult } from '../service/remote-host.js';
import type { ApplicationState } from '../service/rpc-contract.js';

export type RemoteCollabTab = 'host' | 'client';

export function openRemoteCollaboration(tab?: RemoteCollabTab) {
  window.dispatchEvent(new CustomEvent('vmotion:remote-collab', { detail: { tab } }));
}

function notifyRemoteStateChanged() {
  window.dispatchEvent(new Event('vmotion:remote-state-changed'));
}

function randomBrowserToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function maskSecret(token: string | undefined, visible: boolean): string {
  if (!token) return '';
  if (visible) return token;
  if (token.length <= 8) return '••••••••';
  return `${token.slice(0, 4)}••••••••••••${token.slice(-4)}`;
}

function isLikelyIpv6Input(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('[') || (trimmed.match(/[:\uff1a]/g)?.length ?? 0) >= 2;
}

function bareDomainCandidate(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /[:\uff1a/,\s;，；[\]]/.test(trimmed)) return undefined;
  if (/^\d+(?:\.\d+){3}$/.test(trimmed)) return undefined;
  return trimmed;
}

function formatRemainingLease(expiresAt: number): string {
  const sec = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  if (sec >= 60) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  return `${sec}秒`;
}

function relationshipMeta(rel: string | undefined): { label: string; tone: 'ok' | 'warn' | 'accent' | '' } {
  switch (rel) {
    case 'in-sync':
      return { label: '已同步', tone: 'ok' };
    case 'ahead':
      return { label: '本地有未推送改动', tone: 'accent' };
    case 'behind':
      return { label: '远端有新版本可拉取', tone: 'warn' };
    case 'diverged':
      return { label: '双向修改（可三路自动合并）', tone: 'warn' };
    case 'uninitialized':
      return { label: '首次连接待同步', tone: '' };
    default:
      return { label: '未检测', tone: '' };
  }
}

export function useRemoteIndicator() {
  const [info, setInfo] = useState<{ hosting: boolean; port?: number; boundUrl?: string }>({
    hosting: false,
  });
  const refresh = useCallback(async () => {
    try {
      const [hostRes, localRes] = await Promise.all([
        window.vmotionDesktop?.remoteHostStatus?.().catch(() => undefined),
        rpcTyped('remoteStatus', { localOnly: true }).catch(() => undefined),
      ]);
      const hosting = Boolean(
        hostRes?.running ||
          (localRes && 'server' in localRes && localRes.server?.enabled),
      );
      const port =
        hostRes?.port ??
        (localRes && 'server' in localRes && localRes.server?.enabled
          ? localRes.server.port
          : undefined);
      const boundUrl =
        localRes && 'binding' in localRes && localRes.binding?.url
          ? localRes.binding.url
          : undefined;
      setInfo({ hosting, port, boundUrl });
    } catch {
      /* ignore when no project open */
    }
  }, []);

  useEffect(() => {
    void refresh();
    window.addEventListener('vmotion:remote-state-changed', refresh);
    return () => window.removeEventListener('vmotion:remote-state-changed', refresh);
  }, [refresh]);

  return info;
}

export function RemoteCollaborationButton() {
  return (
    <button onClick={() => openRemoteCollaboration()} aria-label="远程协作">
      远程协作
    </button>
  );
}

export function RemoteCloneForm({
  onCancel,
  onCloned,
}: {
  onCancel: () => void;
  onCloned?: () => void;
}) {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [name, setName] = useState('');
  const [folderName, setFolderName] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [directory, setDirectory] = useState('');
  const [saveToken, setSaveToken] = useState(true);
  const [probed, setProbed] = useState<RemoteProbeResult>();
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let active = true;
    window.vmotionDesktop
      ?.projectHome()
      .then((data) => {
        if (active) setDirectory(data.directory);
      })
      .catch((err) => {
        if (active) setError((err as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !probing) {
        event.preventDefault();
        onCancel();
      }
      if (event.key !== 'Tab') return;
      const fields = Array.from(
        formRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
        ) ?? [],
      ).filter((field) => !field.closest('fieldset:disabled'));
      const first = fields[0];
      const last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [busy, probing, onCancel]);

  const handleProbe = async () => {
    if (!url.trim()) {
      setError('请先填写远程主机地址（支持域名、域名:端口、URL 或 IPv4/IPv6，例如 studio.example.com 或 collab.example.com:4318）');
      return;
    }
    if (!window.vmotionDesktop?.probeRemoteCoordinator) {
      setError('请在桌面版中使用远程项目克隆功能');
      return;
    }
    setError('');
    setProbing(true);
    try {
      const result = await window.vmotionDesktop.probeRemoteCoordinator({
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      setProbed(result);
      if (!folderTouched && result.suggestedFolderName) {
        setFolderName(result.suggestedFolderName);
      }
    } catch (err) {
      setProbed(undefined);
      setError((err as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!window.vmotionDesktop?.cloneRemoteProject) {
      setError('请在 Vmotion 桌面版克隆并打开远程项目');
      return;
    }
    if (!url.trim()) {
      setError('请输入远程主机地址');
      return;
    }
    if (!directory.trim()) {
      setError('请选择本地保存位置');
      return;
    }
    setBusy(true);
    try {
      await window.vmotionDesktop.cloneRemoteProject({
        url: url.trim(),
        ...(token.trim() ? { token: token.trim() } : {}),
        saveToken,
        ...(name.trim() ? { name: name.trim() } : {}),
        directory: directory.trim(),
        ...(folderName.trim() ? { folderName: folderName.trim() } : {}),
      });
      notifyRemoteStateChanged();
      onCloned?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form ref={formRef} className="new-project-form" onSubmit={handleSubmit}>
      <div className="project-form-heading">
        <h2>连接远程项目</h2>
        <button
          type="button"
          aria-label="关闭连接远程项目"
          disabled={busy}
          onClick={onCancel}
        >
          <Icon name="close" />
        </button>
      </div>
      <fieldset disabled={busy}>
        <label>
          远程主机地址
          <div className="project-directory">
            <input
              autoFocus
              placeholder="例如 https://studio.example.com、collab.example.com:4318 或 192.168.1.10:4318"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setProbed(undefined);
              }}
            />
            <button
              type="button"
              className="secondary"
              disabled={probing || !url.trim()}
              onClick={() => void handleProbe()}
            >
              {probing ? '检测中…' : '测试连接'}
            </button>
          </div>
          <small className="remote-muted">
            支持域名（studio.example.com / https://…）、域名:端口（ddns.example.com:4318）及 IPv4 / IPv6 地址
          </small>
        </label>

        <label>
          访问令牌（Bearer Token）
          <div className="project-directory">
            <input
              type={showToken ? 'text' : 'password'}
              placeholder="粘贴主机提供的编辑令牌或只读审片令牌"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setProbed(undefined);
              }}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => setShowToken((v) => !v)}
            >
              {showToken ? '隐藏' : '显示'}
            </button>
          </div>
        </label>

        {probed && (
          <div className="remote-notice" role="status" style={{ marginBottom: 14 }}>
            <strong>连接成功：{probed.project}</strong>（<code>{probed.url}</code>） · 权限：
            {probed.role === 'editor' ? '可编辑（Editor）' : '只读审片（Viewer）'} ·{' '}
            {probed.width}×{probed.height} · {probed.fileCount} 个工程文件 · {probed.assets} 个素材 · 在线{' '}
            {probed.peers.filter((p) => p.active).length} 人
          </div>
        )}

        <div className="project-form-grid">
          <label>
            协作者署名（可选）
            <input
              placeholder="例如 张三 / 动效台-B"
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            本地文件夹名称
            <input
              placeholder="留空自动使用远程工程名"
              maxLength={120}
              value={folderName}
              onChange={(e) => {
                setFolderName(e.target.value);
                setFolderTouched(true);
              }}
            />
          </label>
        </div>

        <label>
          本地保存位置
          <div className="project-directory">
            <input value={directory} onChange={(e) => setDirectory(e.target.value)} />
            <button
              type="button"
              className="secondary"
              onClick={async () => {
                try {
                  const picked = await window.vmotionDesktop?.pickProjectDirectory(directory);
                  if (picked) setDirectory(picked);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              浏览…
            </button>
          </div>
        </label>

        <label
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            marginBottom: 12,
          }}
        >
          <input
            type="checkbox"
            style={{ width: 15, height: 15, padding: 0 }}
            checked={saveToken}
            onChange={(e) => setSaveToken(e.target.checked)}
          />
          <span>将访问令牌保存在本机工程（.vmotion/remote/auth.json，不随工程上传）</span>
        </label>

        <p className="project-form-hint">
          克隆目标：{directory}
          {directory && !directory.endsWith('\\') && !directory.endsWith('/') ? '\\' : ''}
          {folderName.trim() || probed?.suggestedFolderName || '<远程工程名>'}
        </p>

        {error && (
          <p className="project-form-error" role="alert">
            {error}
          </p>
        )}

        <div className="project-form-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '正在克隆工程与素材…' : '克隆并打开'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

type RemoteClientLiveStatus = Extract<
  Awaited<ReturnType<typeof rpcTyped<'remoteStatus'>>>,
  { mode: 'client' }
>;

export function RemoteCollaboration() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<RemoteCollabTab>('host');
  const [requestedTab, setRequestedTab] = useState<RemoteCollabTab | undefined>(undefined);
  const [cloningModal, setCloningModal] = useState(false);

  const [appState, setAppState] = useState<ApplicationState>();
  const [hostStatus, setHostStatus] = useState<RemoteHostStatus>();
  const [localCoordServer, setLocalCoordServer] = useState<{
    enabled: boolean;
    host?: string;
    port?: number;
  }>();

  // Host form state
  const [bindPreset, setBindPreset] = useState<'::' | '0.0.0.0' | '127.0.0.1' | 'custom'>('::');
  const [customHost, setCustomHost] = useState('');
  const [port, setPort] = useState(4318);
  const [ipv6Only, setIpv6Only] = useState(false);
  const [publicUrlInput, setPublicUrlInput] = useState('');
  const [livePublicUrl, setLivePublicUrl] = useState('');
  const [customEditorToken, setCustomEditorToken] = useState('');
  const [enableViewerToken, setEnableViewerToken] = useState(true);
  const [customViewerToken, setCustomViewerToken] = useState('');
  const [selectedShareUrl, setSelectedShareUrl] = useState('');
  const [showEditorToken, setShowEditorToken] = useState(false);
  const [showViewerToken, setShowViewerToken] = useState(false);

  // Client state
  const [clientBinding, setClientBinding] = useState<RemoteBinding>();
  const [clientLive, setClientLive] = useState<RemoteClientLiveStatus>();
  const [clientUrl, setClientUrl] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [showClientToken, setShowClientToken] = useState(false);
  const [clientName, setClientName] = useState('');
  const [clientSaveToken, setClientSaveToken] = useState(true);
  const [syncStrategy, setSyncStrategy] = useState<'merge' | 'theirs' | 'ours'>('merge');
  const [syncMessage, setSyncMessage] = useState('');
  const [lockReason, setLockReason] = useState('');
  const [renderFormat, setRenderFormat] = useState<'mp4' | 'png' | 'wav'>('mp4');
  const [renderSchedule, setRenderSchedule] = useState<
    'auto' | 'split-tracks' | 'split-scenes' | 'serial'
  >('auto');
  const [renderFilename, setRenderFilename] = useState('');
  const [lastRenderedOutput, setLastRenderedOutput] = useState<{
    localOutput: string;
    bytes: number;
  }>();

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [copiedKey, setCopiedKey] = useState('');

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? '' : prev)), 2000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    const show = (ev: Event) => {
      const detail = (ev as CustomEvent<{ tab?: RemoteCollabTab } | undefined>).detail;
      setError('');
      setNotice('');
      setCloningModal(false);
      setRequestedTab(detail?.tab);
      if (detail?.tab) setTab(detail.tab);
      setOpen(true);
    };
    window.addEventListener('vmotion:remote-collab', show);
    document.documentElement.dataset.remoteCollabReady = 'true';
    return () => {
      delete document.documentElement.dataset.remoteCollabReady;
      window.removeEventListener('vmotion:remote-collab', show);
    };
  }, []);

  const refreshAll = useCallback(
    async (options: { autoPickTab?: boolean; queryRemoteClient?: boolean } = {}) => {
      const [nextState, nextHost, localRes] = await Promise.all([
        rpcTyped('state', {}).catch(() => undefined),
        window.vmotionDesktop?.remoteHostStatus?.().catch(() => undefined),
        rpcTyped('remoteStatus', { localOnly: true }).catch(() => undefined),
      ]);
      setAppState(nextState);
      if (nextHost) {
        setHostStatus(nextHost);
        setLivePublicUrl(nextHost.publicUrl ?? '');
        if (nextHost.publicUrl) {
          setPublicUrlInput((prev) => prev || nextHost.publicUrl!);
        }
        setSelectedShareUrl((prev) =>
          prev && nextHost.urls.includes(prev) ? prev : (nextHost.url ?? nextHost.urls[0] ?? ''),
        );
      }
      const existingBinding =
        localRes && 'binding' in localRes ? localRes.binding : undefined;
      if (localRes && 'server' in localRes) {
        setLocalCoordServer(localRes.server);
      }
      if (existingBinding) {
        setClientBinding(existingBinding);
        setClientUrl((prev) => prev || existingBinding.url);
        setClientName((prev) => prev || existingBinding.name);
      }

      if (options.autoPickTab && !requestedTab) {
        if (nextHost?.running || (localRes && 'server' in localRes && localRes.server?.enabled)) {
          setTab('host');
        } else if (existingBinding?.url) {
          setTab('client');
        } else {
          setTab('host');
        }
      }

      if (options.queryRemoteClient && existingBinding?.url) {
        try {
          const live = await rpcTyped('remoteStatus', {});
          if (live.mode === 'client') {
            setClientLive(live);
          }
        } catch (err) {
          setError((err as Error).message);
        }
      }
    },
    [requestedTab],
  );

  useEffect(() => {
    if (!open) return;
    void refreshAll({ autoPickTab: true, queryRemoteClient: true });
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !cloningModal) setOpen(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, busy, cloningModal, refreshAll]);

  // Auto-refresh host peers & locks while modal is open and host is running
  useEffect(() => {
    if (!open || tab !== 'host' || !hostStatus?.running) return;
    const timer = setInterval(() => {
      void window.vmotionDesktop
        ?.remoteHostStatus?.()
        .then((next) => {
          if (next) setHostStatus(next);
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [open, tab, hostStatus?.running]);

  if (!open) return null;

  if (cloningModal) {
    return (
      <div className="project-modal" role="dialog" aria-modal="true" aria-label="连接远程项目">
        <RemoteCloneForm
          onCancel={() => setCloningModal(false)}
          onCloned={() => {
            setCloningModal(false);
            setOpen(false);
          }}
        />
      </div>
    );
  }

  const hasOpenProject = Boolean(appState?.snapshot || hostStatus?.projectRoot);
  const projectName =
    appState?.snapshot?.project.name ?? hostStatus?.projectName ?? '未打开工程';
  const activeSceneId = (() => {
    const m = /^#\/composition\/([^/?#]+)/.exec(location.hash);
    if (m) return decodeURIComponent(m[1]);
    return appState?.snapshot?.scenes[0]?.id;
  })();
  const activeSceneName =
    appState?.snapshot?.scenes.find((s) => s.id === activeSceneId)?.name ?? activeSceneId;
  const activeSequenceId = appState?.snapshot?.project.activeSequence;

  const effectiveBindHost = bindPreset === 'custom' ? customHost.trim() : bindPreset;
  const shareUrl = selectedShareUrl || hostStatus?.url || hostStatus?.urls[0] || '';
  const safeCloneDir = (projectName || 'remote-project').replace(/[<>:"/\\|?*]/g, '-');
  const maskedEditorForPreview = hostStatus?.editorToken
    ? maskSecret(hostStatus.editorToken, showEditorToken)
    : '';
  const cliCloneCommand =
    shareUrl && hostStatus?.editorToken
      ? `vmotion remote clone "${shareUrl}" "./${safeCloneDir}" --token "${hostStatus.editorToken}" --save-token`
      : '';
  const cliClonePreview =
    shareUrl && hostStatus?.editorToken
      ? `vmotion remote clone "${shareUrl}" "./${safeCloneDir}" --token "${maskedEditorForPreview}" --save-token`
      : '';
  const remoteMcpJson =
    shareUrl && hostStatus?.editorToken
      ? JSON.stringify(
          {
            mcpServers: {
              'vmotion-remote': {
                command: 'vmotion',
                args: ['mcp', '--remote', shareUrl, '--token', hostStatus.editorToken],
              },
            },
          },
          null,
          2,
        )
      : '';
  const remoteMcpPreview =
    shareUrl && hostStatus?.editorToken
      ? JSON.stringify(
          {
            mcpServers: {
              'vmotion-remote': {
                command: 'vmotion',
                args: ['mcp', '--remote', shareUrl, '--token', maskedEditorForPreview],
              },
            },
          },
          null,
          2,
        )
      : '';

  const startHost = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!window.vmotionDesktop?.startRemoteHost) {
      setError('请在 Vmotion 桌面版启动远程主机，或在命令行运行 vmotion remote serve');
      return;
    }
    if (!effectiveBindHost) {
      setError('请输入要绑定的网卡地址');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await window.vmotionDesktop.startRemoteHost({
        host: effectiveBindHost,
        port,
        ipv6Only:
          bindPreset === '::' || isLikelyIpv6Input(effectiveBindHost) ? ipv6Only : false,
        ...(publicUrlInput.trim() ? { publicUrl: publicUrlInput.trim() } : {}),
        ...(customEditorToken.trim() ? { editorToken: customEditorToken.trim() } : {}),
        enableViewerToken,
        ...(enableViewerToken && customViewerToken.trim()
          ? { viewerToken: customViewerToken.trim() }
          : {}),
      });
      setHostStatus(next);
      setLivePublicUrl(next.publicUrl ?? '');
      setSelectedShareUrl(next.url ?? next.urls[0] ?? '');
      setShowEditorToken(false);
      setShowViewerToken(false);
      setNotice(`远程协作主机已启动（端口 ${next.port}），可将下方地址与令牌发给协作者。`);
      notifyRemoteStateChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const updateRunningPublicUrl = async (rawValue: string) => {
    if (!window.vmotionDesktop?.setRemoteHostPublicUrl) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const trimmed = rawValue.trim();
      const next = await window.vmotionDesktop.setRemoteHostPublicUrl({
        publicUrl: trimmed || undefined,
      });
      setHostStatus(next);
      setLivePublicUrl(next.publicUrl ?? '');
      setPublicUrlInput(next.publicUrl ?? '');
      setSelectedShareUrl((prev) =>
        next.publicUrls?.[0] ??
          (prev && next.urls.includes(prev) ? prev : (next.url ?? next.urls[0] ?? '')),
      );
      setNotice(
        next.publicUrls?.length
          ? `已更新对外域名地址：${next.publicUrls.join(' , ')}`
          : '已清除对外域名地址，恢复显示本机网卡地址。',
      );
      notifyRemoteStateChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stopHost = async () => {
    if (!window.vmotionDesktop?.stopRemoteHost) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await window.vmotionDesktop.stopRemoteHost();
      setHostStatus(next);
      setNotice('已停止远程协作主机，所有外部远程端口已关闭。');
      notifyRemoteStateChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const forceReleaseHostLock = async (scope: string) => {
    setBusy(true);
    setError('');
    try {
      await rpcTyped('remoteLock', {
        action: 'release',
        scopes: [scope],
        force: true,
        localOnly: true,
      });
      const next = await window.vmotionDesktop?.remoteHostStatus?.();
      if (next) setHostStatus(next);
      setNotice(`已强制释放作用域锁：${scope}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connectAndCheckClient = async () => {
    const targetUrl = clientUrl.trim() || clientBinding?.url;
    if (!targetUrl) {
      setError(
        '请输入远程协作主机地址（例如 https://studio.example.com、collab.example.com:4318 或 192.168.1.10:4318）',
      );
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (window.vmotionDesktop?.bindRemoteProject) {
        const bound = await window.vmotionDesktop.bindRemoteProject({
          url: targetUrl,
          ...(clientToken.trim() ? { token: clientToken.trim() } : {}),
          saveToken: clientSaveToken,
          ...(clientName.trim() ? { name: clientName.trim() } : {}),
        });
        if (bound.binding) {
          setClientBinding(bound.binding);
          setClientUrl(bound.binding.url);
        }
      }
      const live = await rpcTyped('remoteStatus', {
        url: targetUrl,
        ...(clientToken.trim() ? { token: clientToken.trim() } : {}),
        ...(clientName.trim() ? { name: clientName.trim() } : {}),
      });
      if (live.mode === 'client') {
        setClientLive(live);
        if (live.binding) {
          setClientBinding(live.binding);
          setClientUrl(live.binding.url);
        }
        setNotice(`已连接远程工程「${live.remote.project.name}」（权限：${live.remote.role === 'editor' ? '可编辑' : '只读审片'}）。`);
      }
      const nextHost = await window.vmotionDesktop?.remoteHostStatus?.().catch(() => undefined);
      if (nextHost) setHostStatus(nextHost);
      notifyRemoteStateChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runClientSync = async (direction: 'sync' | 'pull' | 'push') => {
    const targetUrl = clientUrl.trim() || clientBinding?.url;
    if (!targetUrl) {
      setError('请先填写远程协作主机地址');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = (await rpc('remoteSync', {
        direction,
        mode: 'apply',
        strategy: syncStrategy,
        url: targetUrl,
        ...(clientToken.trim() ? { token: clientToken.trim(), saveToken: clientSaveToken } : {}),
        ...(clientName.trim() ? { name: clientName.trim() } : {}),
        ...(syncMessage.trim() ? { message: syncMessage.trim() } : {}),
      })) as {
        stagedConflicts?: number;
        changedFiles?: string[];
        downloadedAssets?: string[];
        uploadedAssets?: string[];
      };

      if (result.stagedConflicts && result.stagedConflicts > 0) {
        setNotice(
          `同步时检测到 ${result.stagedConflicts} 处冲突，已安全暂存到工程冲突列表，请在解决冲突后再次同步。`,
        );
      } else {
        const label =
          direction === 'sync' ? '双向同步' : direction === 'pull' ? '拉取远端' : '推送本地';
        const changed = result.changedFiles?.length ?? 0;
        const down = result.downloadedAssets?.length ?? 0;
        const up = result.uploadedAssets?.length ?? 0;
        setNotice(
          `${label}完成 · 本地变更文件 ${changed} 个 · 下载素材 ${down} 个 · 上传素材 ${up} 个`,
        );
        setSyncMessage('');
      }
      await refreshAll({ queryRemoteClient: true });
      notifyRemoteStateChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runClientLock = async (
    action: 'acquire' | 'renew' | 'release',
    scopes?: string[],
  ) => {
    const targetUrl = clientUrl.trim() || clientBinding?.url;
    if (!targetUrl) {
      setError('请先连接远程协作主机');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await rpcTyped('remoteLock', {
        action,
        ...(scopes?.length ? { scopes } : {}),
        ...(lockReason.trim() ? { reason: lockReason.trim() } : {}),
        url: targetUrl,
        ...(clientToken.trim() ? { token: clientToken.trim() } : {}),
        ...(clientName.trim() ? { name: clientName.trim() } : {}),
      });
      await refreshAll({ queryRemoteClient: true });
      setNotice(
        action === 'acquire'
          ? `已锁定：${scopes?.join(', ')}`
          : action === 'renew'
            ? '已续租当前持有的全部作用域锁'
            : `已释放锁：${scopes?.join(', ') || '全部自有锁'}`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runRemoteRender = async () => {
    const targetUrl = clientUrl.trim() || clientBinding?.url;
    if (!targetUrl) {
      setError('请先连接远程协作主机');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    setLastRenderedOutput(undefined);
    try {
      const cleanBase = renderFilename
        .trim()
        .replace(/\.(mp4|wav|png|zip)$/i, '')
        .replace(/[^A-Za-z0-9._-]/g, '-');
      const ext = renderFormat === 'mp4' ? '.mp4' : renderFormat === 'wav' ? '.wav' : '.zip';
      const targetRel = `exports/${cleanBase || `remote-${Date.now()}`}${ext}`;
      const res = (await rpc('remoteRender', {
        action: 'start',
        wait: true,
        waitMs: 120_000,
        downloadTo: targetRel,
        url: targetUrl,
        ...(clientToken.trim() ? { token: clientToken.trim() } : {}),
        ...(clientName.trim() ? { name: clientName.trim() } : {}),
        options: {
          format: renderFormat,
          schedule: renderSchedule,
          ...(cleanBase ? { filename: cleanBase } : {}),
          ...(activeSequenceId ? { sequenceId: activeSequenceId } : {}),
        },
      })) as {
        job?: { id: string; status: string; error?: string };
        downloaded?: { localOutput: string; bytes: number };
      };
      if (res.downloaded) {
        setLastRenderedOutput(res.downloaded);
        setNotice(
          `远程渲染完成并已取回本地：${res.downloaded.localOutput}（${(res.downloaded.bytes / 1024).toFixed(1)} KB）`,
        );
      } else if (res.job?.status === 'failed') {
        setError(res.job.error || '远程渲染失败');
      } else {
        setNotice(`远程渲染任务状态：${res.job?.status ?? '已提交'}（ID: ${res.job?.id ?? ''}）`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const relMeta = relationshipMeta(clientLive?.relationship);

  return (
    <div className="project-modal" role="dialog" aria-modal="true" aria-label="远程协作">
      <section className="remote-collab-modal">
        <header className="remote-collab-header">
          <div className="remote-collab-title">
            <Icon name="link" size={18} />
            <h2>远程协作</h2>
            {hasOpenProject && (
              <span className="remote-project-chip" title={hostStatus?.projectRoot ?? appState?.root}>
                {projectName}
              </span>
            )}
          </div>
          <div className="remote-collab-header-actions">
            {window.vmotionDesktop?.cloneRemoteProject && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setCloningModal(true)}
              >
                <Icon name="folder" size={14} />
                克隆远程新工程…
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void refreshAll({ queryRemoteClient: tab === 'client' })}
            >
              刷新
            </button>
            <button
              type="button"
              className="secondary"
              aria-label="关闭远程协作"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
          </div>
        </header>

        <div className="remote-collab-tabs" role="tablist" aria-label="远程协作模式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'host'}
            className={tab === 'host' ? 'active' : ''}
            onClick={() => setTab('host')}
          >
            {(hostStatus?.running || localCoordServer?.enabled) && (
              <span className="remote-tab-dot" />
            )}
            创建远程主机（共享当前工程）
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'client'}
            className={tab === 'client' ? 'active' : ''}
            onClick={() => {
              setTab('client');
              if (clientBinding?.url && !clientLive) {
                void refreshAll({ queryRemoteClient: true });
              }
            }}
          >
            {clientBinding?.url && <span className="remote-tab-dot" />}
            连接远端主机（同步 / 锁 / 远程渲染）
          </button>
        </div>

        <div className="remote-collab-body">
          {error && (
            <div className="project-form-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="remote-notice" role="status">
              {notice}
            </div>
          )}

          {!hasOpenProject ? (
            <div className="remote-card">
              <h3>当前尚未打开本地工程</h3>
              <p className="remote-muted">
                若要将本机作为远程协作主机共享给他人，请先在首页新建或打开一个本地项目；若要加入他人的远程主机，可直接克隆并打开远程工程。
              </p>
              {window.vmotionDesktop?.cloneRemoteProject && (
                <div className="remote-button-row">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setCloningModal(true)}
                  >
                    <Icon name="link" size={15} />
                    连接并克隆远程项目
                  </button>
                </div>
              )}
            </div>
          ) : tab === 'host' ? (
            <>
              {hostStatus?.running ? (
                <>
                  <div className="remote-banner running">
                    <div className="remote-banner-status">
                      <span className="remote-badge ok">主机运行中</span>
                      <span>
                        监听 <code>{hostStatus.host}</code> · 端口 <code>{hostStatus.port}</code>
                        {hostStatus.ipv6Only ? '（仅 IPv6）' : ''}
                      </span>
                      {hostStatus.revision && (
                        <span className="remote-muted">
                          版本 <code>{hostStatus.revision.slice(0, 12)}</code>
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void stopHost()}
                    >
                      停止远程主机
                    </button>
                  </div>

                  <div className="remote-card">
                    <div className="remote-card-head">
                      <h3>1. 选择并复制连接地址</h3>
                      <span className="remote-muted">点选任一地址即可更新下方分享命令</span>
                    </div>
                    <div className="remote-url-list">
                      {hostStatus.urls.map((u) => (
                        <div
                          key={u}
                          className={`remote-url-item ${shareUrl === u ? 'selected' : ''}`}
                        >
                          <label className="remote-url-pick">
                            <input
                              type="radio"
                              name="share-url"
                              checked={shareUrl === u}
                              onChange={() => setSelectedShareUrl(u)}
                            />
                            <span>{u}</span>
                            {hostStatus.publicUrls?.includes(u) && (
                              <span className="remote-badge accent">域名</span>
                            )}
                          </label>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void copyText(`url:${u}`, u)}
                          >
                            {copiedKey === `url:${u}` ? '已复制' : '复制地址'}
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className="remote-field">
                      <span>
                        对外域名 / 域名:端口（可选 · 反向代理、DDNS、端口映射或异地组网域名，多个用逗号分隔）
                      </span>
                      <div className="remote-inline-input">
                        <input
                          aria-label="运行中对外域名地址"
                          placeholder={`例如 https://studio.example.com 或 ddns.example.com:${hostStatus.port}`}
                          value={livePublicUrl}
                          onChange={(e) => setLivePublicUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void updateRunningPublicUrl(livePublicUrl);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => void updateRunningPublicUrl(livePublicUrl)}
                        >
                          应用域名
                        </button>
                        {Boolean(hostStatus.publicUrl || livePublicUrl.trim()) && (
                          <button
                            type="button"
                            className="secondary"
                            disabled={busy}
                            onClick={() => void updateRunningPublicUrl('')}
                          >
                            清除
                          </button>
                        )}
                      </div>
                      {(() => {
                        const bare = bareDomainCandidate(livePublicUrl);
                        if (!bare) return null;
                        const httpsUrl = `https://${bare}`;
                        const portUrl = `${bare}:${hostStatus.port}`;
                        return (
                          <div className="remote-quick-chips">
                            <span className="remote-muted">快捷填入：</span>
                            <button
                              type="button"
                              className="remote-chip-btn"
                              onClick={() => setLivePublicUrl(httpsUrl)}
                            >
                              {httpsUrl}
                            </button>
                            <button
                              type="button"
                              className="remote-chip-btn"
                              onClick={() => setLivePublicUrl(portUrl)}
                            >
                              {portUrl}
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>

                  <div className="remote-card">
                    <div className="remote-card-head">
                      <h3>2. 访问令牌（Bearer Token）</h3>
                      <span className="remote-muted">仅显示在本机桌面端，请妥善发送给协作者</span>
                    </div>
                    {hostStatus.editorToken && (
                      <div className="remote-field">
                        <span>可编辑令牌（Editor · 允许拉取、推送、加锁、远程渲染与编辑）</span>
                        <div className="remote-inline-input">
                          <input
                            readOnly
                            value={maskSecret(hostStatus.editorToken, showEditorToken)}
                          />
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setShowEditorToken((v) => !v)}
                          >
                            {showEditorToken ? '隐藏' : '显示'}
                          </button>
                          <button
                            type="button"
                            className="primary"
                            onClick={() => void copyText('editorToken', hostStatus.editorToken!)}
                          >
                            {copiedKey === 'editorToken' ? '已复制' : '复制编辑令牌'}
                          </button>
                        </div>
                      </div>
                    )}
                    {hostStatus.viewerToken && (
                      <div className="remote-field">
                        <span>只读审片令牌（Viewer · 仅允许查看状态、拉取工程与只读审片）</span>
                        <div className="remote-inline-input">
                          <input
                            readOnly
                            value={maskSecret(hostStatus.viewerToken, showViewerToken)}
                          />
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setShowViewerToken((v) => !v)}
                          >
                            {showViewerToken ? '隐藏' : '显示'}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void copyText('viewerToken', hostStatus.viewerToken!)}
                          >
                            {copiedKey === 'viewerToken' ? '已复制' : '复制只读令牌'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="remote-card">
                    <div className="remote-card-head">
                      <h3>3. 一键发给协作者或远程 AI</h3>
                    </div>
                    <p className="remote-muted">
                      协作者在另一台电脑打开 Vmotion 首页 → 点击「连接远程项目」→ 粘贴上方地址与令牌即可直接克隆并打开工程。
                    </p>
                    {cliCloneCommand && (
                      <div className="remote-code-box">
                        <div className="remote-card-head">
                          <span className="remote-muted">命令行克隆命令（CLI）</span>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void copyText('cliClone', cliCloneCommand)}
                          >
                            {copiedKey === 'cliClone' ? '已复制' : '复制克隆命令'}
                          </button>
                        </div>
                        <pre>{cliClonePreview}</pre>
                      </div>
                    )}
                    {remoteMcpJson && (
                      <div className="remote-code-box">
                        <div className="remote-card-head">
                          <span className="remote-muted">跨设备外部 AI 直连配置（Remote MCP）</span>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => void copyText('remoteMcp', remoteMcpJson)}
                          >
                            {copiedKey === 'remoteMcp' ? '已复制' : '复制远程 MCP 配置'}
                          </button>
                        </div>
                        <pre>{remoteMcpPreview}</pre>
                      </div>
                    )}
                  </div>

                  <div className="remote-grid-2">
                    <div className="remote-card">
                      <div className="remote-card-head">
                        <h3>在线协作者（{hostStatus.peers.filter((p) => p.active).length}）</h3>
                      </div>
                      {hostStatus.peers.length ? (
                        <div className="remote-list">
                          {hostStatus.peers.map((p) => (
                            <div key={p.peerId} className="remote-list-row">
                              <span>
                                <strong>{p.name}</strong>{' '}
                                <span className="remote-muted">
                                  ({p.role === 'editor' ? '可编辑' : '只读'})
                                </span>
                              </span>
                              <span className={`remote-badge ${p.active ? 'ok' : ''}`}>
                                {p.active ? '在线' : '离线'}
                                {p.sceneId ? ` · ${p.sceneId}` : ''}
                                {p.frame !== undefined ? ` #${p.frame}` : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="remote-muted">暂无协作者连接</p>
                      )}
                    </div>

                    <div className="remote-card">
                      <div className="remote-card-head">
                        <h3>活动作用域锁（{hostStatus.locks.length}）</h3>
                      </div>
                      {hostStatus.locks.length ? (
                        <div className="remote-list">
                          {hostStatus.locks.map((l) => (
                            <div key={l.scope} className="remote-list-row">
                              <span>
                                <code>{l.scope}</code> · {l.name}（剩余{' '}
                                {formatRemainingLease(l.expiresAt)}）
                              </span>
                              <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() => void forceReleaseHostLock(l.scope)}
                              >
                                强制释放
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="remote-muted">当前无锁定作用域</p>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <form className="remote-card" onSubmit={startHost}>
                  <div className="remote-card-head">
                    <h3>将当前工程作为远程协作主机共享</h3>
                    {localCoordServer?.enabled && (
                      <span className="remote-badge ok">
                        CLI 主机已运行 ({localCoordServer.host}:{localCoordServer.port})
                      </span>
                    )}
                  </div>
                  <p className="remote-muted">
                    启动后，局域网、Tailscale / WireGuard、DDNS / 反向代理域名或 IPv6 网络内的其他电脑与外部 AI 可通过访问令牌克隆工程、三路合并同步、申请场景租约锁或借用本机显卡渲染。本机编辑器界面仍固定在安全的本地回环地址运行。
                  </p>

                  <div className="remote-grid-2">
                    <label className="remote-field">
                      监听网络范围
                      <select
                        value={bindPreset}
                        onChange={(e) =>
                          setBindPreset(
                            e.target.value as '::' | '0.0.0.0' | '127.0.0.1' | 'custom',
                          )
                        }
                      >
                        <option value="::">双栈监听 ::（推荐 · 同时支持 IPv4 与 IPv6）</option>
                        <option value="0.0.0.0">全部 IPv4 网卡 0.0.0.0（局域网 / VPN）</option>
                        <option value="127.0.0.1">仅本机回环 127.0.0.1（本机反代 / 测试）</option>
                        <option value="custom">指定本机网卡 IP / 主机名…</option>
                      </select>
                    </label>

                    <label className="remote-field">
                      监听端口（0 为自动分配空闲端口）
                      <input
                        type="number"
                        min={0}
                        max={65535}
                        value={port}
                        onChange={(e) => setPort(Number(e.target.value))}
                      />
                    </label>
                  </div>

                  {bindPreset === 'custom' && (
                    <label className="remote-field">
                      自定义本机绑定地址（网卡 IP、主机名或 主机名:端口，例如 192.168.1.10、[fd00::1] 或 studio-pc.local:4318）
                      <input
                        placeholder="192.168.1.10、[fd00::1] 或 studio-pc.local:4318"
                        value={customHost}
                        onChange={(e) => setCustomHost(e.target.value)}
                      />
                    </label>
                  )}

                  {(bindPreset === '::' ||
                    (bindPreset === 'custom' && isLikelyIpv6Input(customHost))) && (
                    <label className="remote-check">
                      <input
                        type="checkbox"
                        checked={ipv6Only}
                        onChange={(e) => setIpv6Only(e.target.checked)}
                      />
                      <span>仅允许纯 IPv6 客户端连接（ipv6Only）</span>
                    </label>
                  )}

                  <label className="remote-field">
                    对外访问域名 / 域名:端口（可选 · 用于反向代理、DDNS、端口映射或异地组网域名，多个用逗号分隔）
                    <input
                      placeholder={`例如 https://studio.example.com 或 ddns.example.com:${port || 4318}`}
                      value={publicUrlInput}
                      onChange={(e) => setPublicUrlInput(e.target.value)}
                    />
                    {(() => {
                      const bare = bareDomainCandidate(publicUrlInput);
                      if (!bare) return null;
                      const httpsUrl = `https://${bare}`;
                      const portUrl = `${bare}:${port || 4318}`;
                      return (
                        <div className="remote-quick-chips">
                          <span className="remote-muted">快捷填入：</span>
                          <button
                            type="button"
                            className="remote-chip-btn"
                            onClick={() => setPublicUrlInput(httpsUrl)}
                          >
                            {httpsUrl}
                          </button>
                          <button
                            type="button"
                            className="remote-chip-btn"
                            onClick={() => setPublicUrlInput(portUrl)}
                          >
                            {portUrl}
                          </button>
                        </div>
                      );
                    })()}
                  </label>

                  <label className="remote-field">
                    自定义编辑令牌（可选，留空自动生成随机高强度令牌）
                    <div className="remote-inline-input">
                      <input
                        placeholder="留空将在启动时自动生成随机令牌"
                        value={customEditorToken}
                        onChange={(e) => setCustomEditorToken(e.target.value)}
                      />
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setCustomEditorToken(randomBrowserToken())}
                      >
                        随机生成
                      </button>
                    </div>
                  </label>

                  <label className="remote-check">
                    <input
                      type="checkbox"
                      checked={enableViewerToken}
                      onChange={(e) => setEnableViewerToken(e.target.checked)}
                    />
                    <span>同时生成只读审片令牌（Viewer Token · 供导演/客户只读拉取与查看）</span>
                  </label>

                  {enableViewerToken && (
                    <label className="remote-field">
                      自定义只读令牌（可选，留空自动生成）
                      <input
                        placeholder="留空自动生成只读令牌"
                        value={customViewerToken}
                        onChange={(e) => setCustomViewerToken(e.target.value)}
                      />
                    </label>
                  )}

                  <div className="remote-button-row" style={{ justifyContent: 'flex-end' }}>
                    <button
                      type="submit"
                      className="primary"
                      disabled={busy || !window.vmotionDesktop?.startRemoteHost}
                    >
                      {busy ? '正在启动主机…' : '启动远程主机'}
                    </button>
                  </div>
                  {!window.vmotionDesktop?.startRemoteHost && (
                    <p className="remote-muted">
                      提示：浏览器模式下可通过命令行运行 <code>vmotion remote serve &lt;工程路径&gt;</code> 启动远程主机。
                    </p>
                  )}
                </form>
              )}
            </>
          ) : (
            <>
              <div className="remote-card">
                <div className="remote-card-head">
                  <h3>远程主机连接设置</h3>
                  {clientBinding?.url && (
                    <span className="remote-badge ok">已绑定：{clientBinding.url}</span>
                  )}
                </div>
                <div className="remote-grid-2">
                  <label className="remote-field">
                    远程主机地址（域名 / 域名:端口 / IP）
                    <input
                      placeholder="例如 https://studio.example.com、collab.example.com:4318 或 [fd00::5]:4318"
                      value={clientUrl}
                      onChange={(e) => setClientUrl(e.target.value)}
                    />
                  </label>
                  <label className="remote-field">
                    协作者署名
                    <input
                      placeholder="例如 张三 / 剪辑台-A"
                      maxLength={80}
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                    />
                  </label>
                </div>

                <label className="remote-field">
                  访问令牌（Bearer Token）
                  <div className="remote-inline-input">
                    <input
                      type={showClientToken ? 'text' : 'password'}
                      placeholder={
                        hostStatus?.hasSavedClientToken
                          ? '本机已保存令牌，留空直接复用；填入新令牌可覆盖更新'
                          : '粘贴远程主机的编辑令牌或只读令牌'
                      }
                      value={clientToken}
                      onChange={(e) => setClientToken(e.target.value)}
                    />
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setShowClientToken((v) => !v)}
                    >
                      {showClientToken ? '隐藏' : '显示'}
                    </button>
                  </div>
                </label>

                <div className="remote-card-head">
                  <label className="remote-check">
                    <input
                      type="checkbox"
                      checked={clientSaveToken}
                      onChange={(e) => setClientSaveToken(e.target.checked)}
                    />
                    <span>保存令牌到本机工程（.vmotion/remote/auth.json）</span>
                  </label>
                  <div className="remote-button-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => void connectAndCheckClient()}
                    >
                      {busy ? '正在连接…' : '连接并检查远端状态'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="remote-card">
                <div className="remote-card-head">
                  <h3>增量三路同步与素材传输</h3>
                  {clientLive && (
                    <span className={`remote-badge ${relMeta.tone}`}>{relMeta.label}</span>
                  )}
                </div>

                {clientLive ? (
                  <>
                    <p className="remote-muted">
                      远端工程：<strong>{clientLive.remote.project.name}</strong> · 权限：
                      {clientLive.remote.role === 'editor' ? '可编辑' : '只读审片'} · 本地版本{' '}
                      <code>{clientLive.local.revision.slice(0, 10)}</code> / 远端版本{' '}
                      <code>{clientLive.remote.revision.slice(0, 10)}</code> · 在线{' '}
                      {clientLive.remote.peers.filter((p) => p.active).length} 人
                    </p>
                    {clientLive.local.conflicts > 0 && (
                      <div className="project-form-error">
                        本地存在 {clientLive.local.conflicts} 处未解决冲突，请先处理冲突后再推送。
                      </div>
                    )}
                    {clientLive.changedFilesVsRemote.length > 0 && (
                      <div className="remote-files-pills">
                        <span className="remote-muted">差异文件：</span>
                        {clientLive.changedFilesVsRemote.slice(0, 12).map((f) => (
                          <code key={f}>{f}</code>
                        ))}
                        {clientLive.changedFilesVsRemote.length > 12 && (
                          <span className="remote-muted">
                            等 {clientLive.changedFilesVsRemote.length} 个文件
                          </span>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="remote-muted">
                    点击上方「连接并检查远端状态」查看本地与远程主机的版本差异、锁和在线成员。
                  </p>
                )}

                <div className="remote-grid-2">
                  <label className="remote-field">
                    同步备注（可选，记入远端改动历史）
                    <input
                      placeholder="例如：更新片头字幕与转场节奏"
                      maxLength={240}
                      value={syncMessage}
                      onChange={(e) => setSyncMessage(e.target.value)}
                    />
                  </label>
                  <label className="remote-field">
                    合并策略
                    <select
                      value={syncStrategy}
                      onChange={(e) =>
                        setSyncStrategy(e.target.value as 'merge' | 'theirs' | 'ours')
                      }
                    >
                      <option value="merge">稳定 ID 三路自动合并（推荐）</option>
                      <option value="theirs">冲突时以远端主机为准（theirs）</option>
                      <option value="ours">冲突时以本机改动为准（ours）</option>
                    </select>
                  </label>
                </div>

                <div className="remote-button-row">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || (!clientUrl.trim() && !clientBinding?.url)}
                    onClick={() => void runClientSync('sync')}
                  >
                    双向同步（Sync）
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || (!clientUrl.trim() && !clientBinding?.url)}
                    onClick={() => void runClientSync('pull')}
                  >
                    仅拉取远端（Pull）
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || (!clientUrl.trim() && !clientBinding?.url)}
                    onClick={() => void runClientSync('push')}
                  >
                    仅推送本地（Push）
                  </button>
                </div>
              </div>

              <div className="remote-grid-2">
                <div className="remote-card">
                  <div className="remote-card-head">
                    <h3>作用域租约锁</h3>
                  </div>
                  <p className="remote-muted">
                    修改前可先锁定单个场景或序列，防止多人或远程 AI 同时覆盖同一镜头（租约到期自动释放）。
                  </p>
                  <label className="remote-field">
                    锁定说明（可选）
                    <input
                      placeholder="例如：正在精调开场动画"
                      maxLength={200}
                      value={lockReason}
                      onChange={(e) => setLockReason(e.target.value)}
                    />
                  </label>
                  <div className="remote-button-row">
                    {activeSceneId && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void runClientLock('acquire', [`scene:${activeSceneId}`])}
                      >
                        <Icon name="lock" size={13} />
                        锁定场景「{activeSceneName}」
                      </button>
                    )}
                    {activeSequenceId && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void runClientLock('acquire', [`sequence:${activeSequenceId}`])
                        }
                      >
                        <Icon name="lock" size={13} />
                        锁定主序列
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void runClientLock('acquire', ['project'])}
                    >
                      锁定全工程
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void runClientLock('renew')}
                    >
                      续租
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void runClientLock('release')}
                    >
                      <Icon name="unlock" size={13} />
                      释放我的锁
                    </button>
                  </div>

                  {clientLive?.remote.locks.length ? (
                    <div className="remote-list">
                      {clientLive.remote.locks.map((l) => (
                        <div key={l.scope} className="remote-list-row">
                          <span>
                            <code>{l.scope}</code> · {l.name}（
                            {formatRemainingLease(l.expiresAt)}）
                          </span>
                          {clientBinding?.peerId === l.peerId && (
                            <button
                              type="button"
                              className="secondary"
                              disabled={busy}
                              onClick={() => void runClientLock('release', [l.scope])}
                            >
                              释放
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="remote-card">
                  <div className="remote-card-head">
                    <h3>借用远程主机算力渲染</h3>
                  </div>
                  <p className="remote-muted">
                    轻薄本可让远程高配主机执行异构并行渲染，完成后自动校验 SHA-256 并下载回本机 exports/。
                  </p>
                  <div className="remote-grid-2">
                    <label className="remote-field">
                      输出格式
                      <select
                        value={renderFormat}
                        onChange={(e) =>
                          setRenderFormat(e.target.value as 'mp4' | 'png' | 'wav')
                        }
                      >
                        <option value="mp4">MP4 视频</option>
                        <option value="png">PNG 序列压缩包 (.zip)</option>
                        <option value="wav">WAV 无损音频</option>
                      </select>
                    </label>
                    <label className="remote-field">
                      并行调度
                      <select
                        value={renderSchedule}
                        onChange={(e) =>
                          setRenderSchedule(
                            e.target.value as
                              | 'auto'
                              | 'split-tracks'
                              | 'split-scenes'
                              | 'serial',
                          )
                        }
                      >
                        <option value="auto">自动异构并行（auto）</option>
                        <option value="split-tracks">按轨道并行（split-tracks）</option>
                        <option value="split-scenes">按场景并行（split-scenes）</option>
                        <option value="serial">单路串行（serial）</option>
                      </select>
                    </label>
                  </div>
                  <label className="remote-field">
                    文件名（可选，保存在 exports/ 下）
                    <input
                      placeholder="留空自动命名，例如 final-cut"
                      maxLength={80}
                      value={renderFilename}
                      onChange={(e) => setRenderFilename(e.target.value)}
                    />
                  </label>
                  <div className="remote-button-row">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || (!clientUrl.trim() && !clientBinding?.url)}
                      onClick={() => void runRemoteRender()}
                    >
                      <Icon name="export" size={14} />
                      {busy ? '处理中…' : '远程渲染并下载到本机'}
                    </button>
                    {lastRenderedOutput && window.vmotionDesktop && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          void window.vmotionDesktop!.showFile(lastRenderedOutput.localOutput)
                        }
                      >
                        在文件夹中显示
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
