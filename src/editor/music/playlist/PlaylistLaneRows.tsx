import type { SoundClip, SoundDocument } from '../../../core/sound-schema.js';
import type { MusicRun } from '../music-panel-types.js';
import { PlaylistClipView, PlaylistLaneHeader } from './PlaylistLanes.js';
import type { PlaylistPreview } from './use-playlist-gestures.js';

/** The visible lane rows (virtualised by the caller's lane range) with their clips and ghosts. */
export function PlaylistLaneRows({
  doc,
  run,
  busy,
  offsets,
  lanes,
  byLane,
  preview,
  range,
  selected,
  focusLane,
  zoomY,
  px,
  laneFromY,
  assetName,
}: {
  doc: SoundDocument;
  run: MusicRun;
  busy: boolean;
  offsets: Float64Array;
  lanes: { first: number; last: number };
  byLane: Map<number, SoundClip[]>;
  preview: PlaylistPreview;
  /** Visible time range (document units); clips outside it are not rendered. */
  range: [number, number];
  selected: Set<string>;
  focusLane: number;
  zoomY: number;
  px: number;
  laneFromY: (clientY: number) => number;
  assetName: (id: string) => string | undefined;
}) {
  const patches = preview.patches;
  return (
    <>
      {Array.from({ length: Math.max(0, lanes.last - lanes.first + 1) }, (_, k) => {
        const lane = lanes.first + k,
          track = doc.playlistTracks[lane],
          height = offsets[lane + 1] - offsets[lane],
          list = (byLane.get(lane) ?? []).concat(),
          moving = patches
            ? doc.clips.filter(
                (c) => patches.has(c.id) && patches.get(c.id)!.lane === lane && c.lane !== lane,
              )
            : [];
        const shown = [...list, ...moving]
          .filter((c) => !(patches?.has(c.id) && (patches.get(c.id)!.lane ?? c.lane) !== lane))
          .map((c) => (patches?.has(c.id) ? { ...c, ...patches.get(c.id) } : c))
          .filter((c) => c.at < range[1] && c.at + c.length > range[0]);
        const ghosts = (preview.added ?? []).filter((c) => c.lane === lane);
        return (
          <div
            key={track.id}
            className={`music-playlist-lane ${track.muted ? 'muted' : ''} ${lane === focusLane ? 'focus' : ''}`}
            style={{ top: offsets[lane], height }}
          >
            <PlaylistLaneHeader
              doc={doc}
              lane={lane}
              track={track}
              height={height}
              zoomY={zoomY}
              run={run}
              busy={busy}
              laneFromY={laneFromY}
            />
            <div className="music-lane-clips">
              {shown.map((c) =>
                preview.removed?.has(c.id) ? null : (
                  <PlaylistClipView
                    key={c.id}
                    doc={doc}
                    clip={c}
                    px={px}
                    height={height}
                    selected={selected.has(c.id)}
                    assetName={c.kind === 'audio' ? assetName(c.refId) : undefined}
                  />
                ),
              )}
              {ghosts.map((c) => (
                <PlaylistClipView
                  key={c.id}
                  doc={doc}
                  clip={c}
                  px={px}
                  height={height}
                  selected={false}
                  ghost
                />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
