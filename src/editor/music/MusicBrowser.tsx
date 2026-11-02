import { Icon } from '../Icons.js';
import { rpcTyped } from '../state/rpc-client.js';
import { colors, type MusicWorkspaceContext } from './music-panel-types.js';
import { musicUrl } from './music-model.js';

/** Left browser column: new song, project scores, patterns, samples and the MIDI import toggle. */
export function MusicBrowser({
  ctx,
  showMidi,
  setShowMidi,
}: {
  ctx: MusicWorkspaceContext;
  showMidi: boolean;
  setShowMidi: (open: boolean) => void;
}) {
  const { m, doc, draft, application, busy, edit } = ctx;
  const assets = application.snapshot.project.assets;
  const addPattern = () => {
    if (!doc) return;
    const id = crypto.randomUUID();
    edit((d) => {
      d.patterns = [
        ...(d.patterns ?? []),
        {
          id,
          name: 'Pattern ' + String((d.patterns?.length ?? 0) + 1).padStart(2, '0'),
          length: 4,
          channels: [],
        },
      ];
    });
    m.dispatch({ type: 'select', patternId: id });
  };
  const importAudio = () =>
    void m.task('导入采样', async () => {
      const input = window.vmotionDesktop
        ? await window.vmotionDesktop.pickAsset()
        : window.prompt('本地音频文件的完整路径');
      if (input) {
        await rpcTyped('import', { path: input, type: 'audio', copy: true });
        await m.refresh();
      }
    });
  return (
    <aside className="music-browser">
      <div className="music-panel-heading">
        <span className="music-eyebrow">BROWSER</span>
        <h3>乐曲与素材</h3>
      </div>
      <button
        className="music-new"
        disabled={busy}
        title="新建空白乐曲（#/music/new）；再次点击重新开始空白草稿"
        onClick={m.newSong}
      >
        ＋ 新建乐曲
      </button>
      <div className="music-browser-scroll">
        <h4>
          PROJECT SCORES <span>{assets.filter((a) => a.soundSource).length}</span>
        </h4>
        {assets
          .filter((a) => a.soundSource)
          .map((a) => (
            <a
              key={a.id}
              className={`music-resource ${doc.id === a.id ? 'active' : ''}`}
              href={musicUrl(a.id)}
            >
              <Icon name="music" />
              <span>
                {a.name}
                <small>{Number(a.metadata.duration || 0).toFixed(1)} 秒 · 可编辑</small>
              </span>
            </a>
          ))}
        <h4>
          PATTERNS{' '}
          <button
            aria-label="新建 Pattern"
            disabled={busy || (doc.patterns?.length ?? 0) >= 128}
            onClick={addPattern}
          >
            ＋
          </button>
        </h4>
        <button
          className={`music-resource ${!draft.patternId ? 'active' : ''}`}
          onClick={() => m.dispatch({ type: 'select', patternId: '' })}
        >
          <Icon name="layers" />
          <span>
            整曲音符<small>直接音符 / MIDI 导入</small>
          </span>
        </button>
        {doc.patterns?.map((p, i) => (
          <button
            key={p.id}
            draggable
            className={`music-resource ${p.id === draft.patternId ? 'active' : ''}`}
            onDragStart={(e) => e.dataTransfer.setData('application/x-vmotion-pattern', p.id)}
            onClick={() => m.dispatch({ type: 'select', patternId: p.id })}
          >
            <i style={{ background: colors[i % colors.length] }} />
            <span>
              {p.name}
              <small>
                {p.length} {doc.unit === 'beats' ? '拍' : '秒'} · 拖到 Playlist
              </small>
            </span>
          </button>
        ))}
        <h4>
          SAMPLES{' '}
          <button aria-label="导入音乐采样" disabled={busy} onClick={importAudio}>
            ＋
          </button>
        </h4>
        {assets
          .filter((a) => (a.type === 'audio' || a.type === 'video') && !a.soundSource)
          .map((a) => (
            <div className="music-resource" key={a.id}>
              <Icon name="volume" />
              <span>
                {a.name}
                <small>{Number(a.metadata.duration || 0).toFixed(1)} 秒</small>
              </span>
            </div>
          ))}
        <button disabled={busy} onClick={() => setShowMidi(!showMidi)}>
          导入 MIDI…
        </button>
      </div>
      <div className="music-browser-footer">
        48 kHz · Stereo
        <br />
        本地合成与采样引擎
      </div>
    </aside>
  );
}
