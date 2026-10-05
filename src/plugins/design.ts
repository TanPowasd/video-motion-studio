import {
  themeInspectSchema,
  themePlanSchema,
  inspectThemes,
  planTheme,
} from '../service/themes.js';
import {
  templateInspectSchema,
  templatePlanSchema,
  inspectTemplates,
  planTemplates,
} from '../service/templates.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { Renderer } from '../core/renderer.js';
import type { Snapshot } from '../core/model.js';
import type { CompositionDraft } from '../core/interaction.js';
export const designPlugin = {
  id: 'vmotion.design',
  name: '主题与版本模板',
  version: '1.0.0',
  methods: new Set(['themeInspect', 'themePlan', 'templateInspect', 'templatePlan']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'theme_inspect',
        description:
          'Read paginated typed/inherited/aliased theme tokens or one layer binding with literal/baseline/effective values and override priority. Native themes resolve before keys/drivers and share preview/selection/export.',
        method: 'themeInspect',
        schema: themeInspectSchema.shape,
      },
      {
        name: 'theme_plan',
        description:
          'Plan hash-checked theme authoring, token/parent changes and cross-scene bindings/local overrides/reset/detach. Themes remain live, edited literals and keys win, renderer checks value domains and cycles. Returns an exact stored candidate for preflight/apply and one undo.',
        method: 'themePlan',
        schema: themePlanSchema.shape,
      },
      {
        name: 'template_inspect',
        description:
          'Discover versioned scene templates or inspect one instance: typed ports/defaults, source version/hash, retained keys/overrides, pinned captured files and declared shared references. Full file hashes are opt-in.',
        method: 'templateInspect',
        schema: templateInspectSchema.shape,
      },
      {
        name: 'template_plan',
        description:
          'Publish a versioned template from sibling layers or explicit JSON nodes; pin captured author code/dependencies, place scene instances, upgrade selected versions preserving customized params/keys/overrides with explicit parameter/layer migrations, or detach a private editable copy. New defaults replace unchanged fields; deleted customized params, conflicts and invalid new constraints stop the plan. Returns short exact preflight/apply and one undo. Shared/dynamic code references need explicit allowSharedCode; originals remain unchanged.',
        method: 'templatePlan',
        schema: templatePlanSchema.shape,
      },
    ].map((t) => ({
      ...t,
      plugin: { id: 'vmotion.design', version: '1.0.0', origin: 'builtin' as const },
    }));
  },
  dispatch(
    host: {
      root: string;
      renderer: Renderer;
      snapshot: Snapshot;
      edit: (
        s: Snapshot,
        sceneId: string,
        frame: number,
        edits: CompositionDraft[],
      ) => Promise<any[]>;
    },
    method: string,
    params: unknown,
  ) {
    if (method === 'themeInspect') return inspectThemes(host.renderer, host.snapshot, params);
    if (method === 'templateInspect') return inspectTemplates(host.renderer, host.snapshot, params);
    if (method === 'themePlan')
      return planTheme(host.root, host.renderer, structuredClone(host.snapshot), params, host.edit);
    return planTemplates(
      host.root,
      host.renderer,
      structuredClone(host.snapshot),
      params,
      host.edit,
    );
  },
};
