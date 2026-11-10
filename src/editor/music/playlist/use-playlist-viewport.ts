import React, { useEffect, useLayoutEffect, useRef } from 'react';
import {
  HEAD,
  PX_PER_UNIT,
  ZOOM_X,
  ZOOM_Y,
  playlistViewMemory,
  type PlaylistViewState,
} from './playlist-view.js';

/**
 * Viewport plumbing for the virtualised Playlist: tracks scroll/size (one update per frame) and
 * handles Ctrl+wheel zoom (time around the cursor; Ctrl+Shift/Alt+wheel = lane height).
 */
export function usePlaylistViewport(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  setScroll: (s: { left: number; top: number; w: number; h: number }) => void,
  setViewState: React.Dispatch<React.SetStateAction<PlaylistViewState>>,
  px: number,
) {
  // Scroll/size tracking for virtualisation (one state update per frame).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setScroll({ left: el.scrollLeft, top: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
    };
    const queue = () => (frame ||= requestAnimationFrame(read));
    el.addEventListener('scroll', queue, { passive: true });
    const ro = new ResizeObserver(queue);
    ro.observe(el);
    read();
    return () => {
      el.removeEventListener('scroll', queue);
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  // Ctrl+wheel zooms time around the cursor; Ctrl+Shift/Alt+wheel zooms lane height.
  const zoomAnchor = useRef<{ t: number; x: number } | undefined>(undefined);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-Math.sign(e.deltaY) * 0.15);
      if (e.shiftKey || e.altKey)
        setViewState(
          (v) =>
            (playlistViewMemory.view = {
              ...v,
              zoomY: Math.max(ZOOM_Y.min, Math.min(ZOOM_Y.max, v.zoomY * factor)),
            }),
        );
      else {
        const x = e.clientX - el.getBoundingClientRect().left;
        setViewState((v) => {
          const before = PX_PER_UNIT * v.zoomX,
            zoomX = Math.max(ZOOM_X.min, Math.min(ZOOM_X.max, v.zoomX * factor));
          zoomAnchor.current = { t: (el.scrollLeft + x - HEAD) / before, x };
          return (playlistViewMemory.view = { ...v, zoomX });
        });
      }
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current,
      a = zoomAnchor.current;
    if (!el || !a) return;
    zoomAnchor.current = undefined;
    el.scrollLeft = Math.max(0, a.t * px + HEAD - a.x);
  }, [px]);
}
