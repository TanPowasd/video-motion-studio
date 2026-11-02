import type {
  SoundDocument,
  SoundEvent,
  SoundPattern,
  SoundTrack,
} from '../../core/sound-schema.js';
import type { useMusic } from './use-music.js';
import type { MusicDraft } from './music-model.js';
export const colors = ['#f2aa62', '#86c7b1', '#a798e1', '#74b8dc', '#dc8c9e', '#b9c67b'];
export interface MusicPanelProps {
  doc: SoundDocument;
  m: ReturnType<typeof useMusic>;
  edit: (change: (doc: SoundDocument) => void) => void;
  busy: boolean;
  grid: number;
  setTab: (tab: string) => void;
  owner: string;
  setOwner: (owner: string) => void;
  pattern?: SoundPattern;
  track?: SoundTrack;
  draft: MusicDraft;
  length: number;
  addTrack: (preset: string) => void;
  selectTrack: (id: string) => void;
}

/** Shared state handed from the MusicWorkspace shell to its toolbar, browser, main area, forms and footer. */
export interface MusicWorkspaceContext {
  embedded: boolean;
  m: ReturnType<typeof useMusic>;
  doc: SoundDocument;
  draft: MusicDraft;
  application: NonNullable<ReturnType<typeof useMusic>['application']>;
  busy: boolean;
  validation: string;
  duration: number;
  clock: number;
  track?: SoundTrack;
  pattern?: SoundPattern;
  length: number;
  events: SoundEvent[];
  selected: SoundEvent[];
  edit: (change: (doc: SoundDocument) => void) => void;
  editEvents: (next: SoundEvent[]) => void;
  selectTrack: (id: string) => void;
  addTrack: (preset: string) => void;
}

export type MusicTool = 'select' | 'draw';
