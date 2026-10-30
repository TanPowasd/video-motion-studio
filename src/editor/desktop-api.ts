import type { ProjectCreationInput, ProjectHome } from '../core/project-creation.js';
import type { RemoteBinding } from '../core/remote-model.js';
import type {
  RemoteBindInput,
  RemoteCloneInput,
  RemoteHostStartInput,
  RemoteHostStatus,
  RemoteProbeInput,
  RemoteProbeResult,
} from '../service/remote-host.js';

declare global {
  interface Window {
    vmotionDesktop?: {
      pickAsset: () => Promise<string | undefined>;
      pickPluginSource?: (kind: 'file' | 'folder') => Promise<string | undefined>;
      pickProjectDirectory: (directory?: string) => Promise<string | undefined>;
      projectHome: () => Promise<ProjectHome>;
      openProject: (root?: string) => Promise<void>;
      createProject: (options: ProjectCreationInput & { directory: string }) => Promise<void>;
      cloneRemoteProject?: (options: RemoteCloneInput) => Promise<{
        root: string;
        path: string;
        url: string;
        peerId: string;
        project: string;
        revision: string;
        files: number;
        downloadedAssets: number;
      }>;
      probeRemoteCoordinator?: (options: RemoteProbeInput) => Promise<RemoteProbeResult>;
      bindRemoteProject?: (options: RemoteBindInput) => Promise<{
        binding?: RemoteBinding;
        probed: RemoteProbeResult;
        savedToken: boolean;
      }>;
      remoteHostStatus?: () => Promise<RemoteHostStatus>;
      startRemoteHost?: (options?: RemoteHostStartInput) => Promise<RemoteHostStatus>;
      stopRemoteHost?: () => Promise<RemoteHostStatus>;
      showHome: () => Promise<void>;
      openAgentWorkbench: (route?: string) => Promise<void>;
      openStudioWorkbench: () => Promise<void>;
      showFile: (file: string) => Promise<void>;
      /** Theme preference stored in the desktop settings file (read synchronously by the preload). */
      themePreference?: 'system' | 'dark' | 'light';
      setThemePreference?: (preference: 'system' | 'dark' | 'light') => Promise<void>;
    };
  }
}
export {};
