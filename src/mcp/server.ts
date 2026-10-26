import { randomUUID } from 'node:crypto';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Application } from '../service/application.js';
import { VmotionError } from '../core/model.js';
import type { InboxRequest, SamplingMode } from '../core/inbox-model.js';
import {
  existingService,
  rpc,
  servePipe,
  subscribePipe,
  type McpServerEvent,
} from '../service/ipc.js';
import { runSamplingRequest, type SamplingToolResult } from './sampling-runner.js';
import { animationReference } from '../sdk/reference.js';
import { toolDefinitions, type ToolDefinition } from './catalog.js';
import {
  coreTools,
  findTool,
  toolCategories,
  toolAnnotations,
  toolSearchSchema,
  searchTools,
  toolSchema,
  toolSchemaRequestSchema,
  toolLoadSchema,
  selectTools,
  metaToolNames,
  metaToolDescriptions,
  metaToolSchemas,
  metaToolAnnotations,
  toolNotFound,
} from './discovery.js';
import { parseArguments } from './argument-errors.js';
import { invokeTool, toolError, toolCallSchema } from './invoke.js';
import { withChangeOrigin } from '../service/change-journal.js';
import { projectPluginTools, type PluginCatalog } from './plugin-tools.js';

export type McpToolMode = 'compact' | 'all' | 'auto';
/** SDK-side shape that accepts any value per key, so our own validator reports full fixes. */
const lenient = (shape: z.ZodRawShape) =>
  z.object(Object.fromEntries(Object.keys(shape).map((key) => [key, z.unknown()]))).passthrough();
const AUTO_LOAD_LIMIT = 32;
export async function startMcp(root: string, options: { tools?: McpToolMode } = {}) {
  const remote = await existingService(root),
    app = remote ? undefined : await new Application(root).open(),
    // Attribution for the Studio change feed + MCP sampling capability from the handshake.
    agent = {
      sessionId: randomUUID(),
      client: undefined as string | undefined,
      pid: process.pid,
      origins: false,
      sampling: 'none' as SamplingMode,
    },
    pipe = app ? await servePipe(app) : undefined,
    call = (method: string, params?: unknown) =>
      app ? app.dispatch(method, params) : rpc(root, method, params),
    mode = options.tools ?? 'compact',
    server = new McpServer(
      { name: 'vmotion', version: '0.2.0' },
      {
        instructions:
          'Use project_context and agent_guide. Only the tools in tools/list can be called by direct name; call every other capability with tool_call {name,arguments} (or tools_load it first). tools_search lists capabilities with effect read|plan|write; tool_schema gives one exact interface (entry tools included). Planners return plan.planId: project_preflight({planId}) then project_apply({planId}). The application never calls AI models.',
      },
    ),
    builtinDefinitions = toolDefinitions(),
    registered = new Map<string, RegisteredTool>();
  // @modelcontextprotocol/sdk Protocol._oncancel drops notifications/cancelled when requestId === 0 (`if (!requestId) return`).
  const serverProto = server.server as unknown as { _requestMessageId?: number };
  if (serverProto._requestMessageId === 0) serverProto._requestMessageId = 1;
  let definitions = builtinDefinitions;
  let definitionsByName = new Map(definitions.map((t) => [t.name, t]));
  const listCache = new Map<string, { schema: unknown; json: Record<string, unknown> }>();
  let enabled = mode === 'all' ? new Set(definitions.map((t) => t.name)) : new Set(coreTools);
  const autoLoaded = new Set<string>();
  /** --tools auto: a capability used through tool_call/tool_schema becomes a direct tool. */
  const autoLoad = (name: string) => {
    if (mode !== 'auto' || enabled.has(name) || autoLoaded.size >= AUTO_LOAD_LIMIT) return;
    const entry = registered.get(name);
    if (!entry || !definitionsByName.has(name)) return;
    autoLoaded.add(name);
    enabled.add(name);
    entry.enable();
  };
  const routing = () => ({
    mode,
    directTools:
      mode === 'all'
        ? ('all' as const)
        : [...registered].filter(([, entry]) => entry.enabled).map(([name]) => name).sort(),
    hidden:
      mode === 'all'
        ? 'Every capability is a direct tool.'
        : 'Only directTools can be called by name; call any other capability with tool_call {"name":"<capability>","arguments":{...}} or tools_load it and refresh tools/list.',
    capabilities: definitions.length,
  });
  /** project_context/agent_guide tell the agent which names its client can call directly. */
  const withRouting = (tool: ToolDefinition, result: CallToolResult, fields?: string[]): CallToolResult => {
    if (fields || !['projectContext', 'agentGuide'].includes(tool.method)) return result;
    const value = result.structuredContent;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    const next: Record<string, unknown> = { ...(value as Record<string, unknown>), mcp: routing() };
    return {
      ...result,
      structuredContent: next,
      content: result.content.map((block, index) =>
        index === 0 && (block as { type?: string }).type === 'text'
          ? { type: 'text' as const, text: JSON.stringify(next) }
          : block,
      ),
    };
  };
  const execute = async (
    tool: ToolDefinition,
    args: unknown,
    response: 'compact' | 'full',
    delivery: { fields?: string[]; media?: boolean; via?: 'tool_call' | 'direct' } = {},
  ) => {
    if (app)
      return withChangeOrigin({ kind: 'mcp', client: agent.client, tool: tool.name }, () =>
        invokeTool(tool, args, call, { response, ...delivery, root }),
      );
    try {
      const { via: _via, ...bridged } = delivery;
      return await rpc(root, 'agentToolInvoke', {
        name: tool.name,
        arguments: args,
        response,
        inline: true,
        ...bridged,
        // Only editors that advertise origin support accept the extra field.
        ...(agent.origins
          ? {
              agent: {
                client: agent.client,
                pid: agent.pid,
                ...(agent.sampling !== 'none' ? { sampling: agent.sampling } : {}),
              },
            }
          : {}),
      });
    } catch (e) {
      // Older open editors can still serve their existing capabilities through the bridge.
      if ((e as { code?: string }).code === 'METHOD_NOT_FOUND')
        return invokeTool(tool, args, call, { response, ...delivery, root });
      throw e;
    }
  };
  const register = (tool: ToolDefinition) => {
    const entry = server.registerTool(
      tool.name,
      {
        description: tool.description,
        // Accept any values here; invokeTool's strict validation reports allowed values/examples.
        inputSchema: lenient(tool.schema),
        annotations: toolAnnotations(tool.name, tool),
      },
      async (params) => {
        try {
          await refresh();
          const current = findTool(definitions, tool.name);
          if (current.plugin?.hash !== tool.plugin?.hash)
            throw new VmotionError(
              'PLUGIN_CHANGED',
              'Plugin changed; refresh tools/list or use tool_schema before calling again',
            );
          const result = await execute(tool, params, mode === 'all' ? 'full' : 'compact', {
            via: 'direct',
          });
          await refresh();
          return withRouting(tool, result.result);
        } catch (e) {
          return toolError(e);
        }
      },
    );
    registered.set(tool.name, entry);
    if (!enabled.has(tool.name)) entry.disable();
  };
  let catalogHash: string | undefined, refreshing: Promise<void> | undefined;
  const refresh = () =>
    (refreshing ??= (async () => {
      let catalog: PluginCatalog;
      try {
        catalog = (await call('pluginCatalog', { ifHash: catalogHash })) as PluginCatalog;
      } catch (e) {
        if ((e as { code?: string }).code !== 'METHOD_NOT_FOUND') throw e;
        catalog = {
          catalogHash: '0'.repeat(64),
          plugins: [],
          ...(catalogHash === '0'.repeat(64) ? { notModified: true } : {}),
        };
      }
      if (catalog.notModified) return;
      const next = [...builtinDefinitions, ...projectPluginTools(catalog)],
        nextNames = new Set(next.map((t) => t.name)),
        nextByName = new Map(next.map((t) => [t.name, t]));
      const notify = server.sendToolListChanged;
      let changed = false;
      server.sendToolListChanged = () => {
        changed = true;
      };
      try {
        for (const tool of definitions) {
          const updated = nextByName.get(tool.name);
          if (!updated || updated.plugin?.hash !== tool.plugin?.hash) {
            registered.get(tool.name)?.remove();
            registered.delete(tool.name);
            listCache.delete(tool.name);
            if (!updated) enabled.delete(tool.name);
          }
        }
        definitions = next;
        definitionsByName = nextByName;
        catalogHash = catalog.catalogHash;
        if (mode === 'all') for (const name of nextNames) enabled.add(name);
        for (const tool of next) if (!registered.has(tool.name)) register(tool);
      } finally {
        server.sendToolListChanged = notify;
      }
      if (changed) server.sendToolListChanged();
    })().finally(() => {
      refreshing = undefined;
    }));
  for (const tool of definitions) register(tool);
  await refresh();
  const discoveryNames: string[] = [...metaToolNames];
  const reply = (value: unknown) => ({
    structuredContent: value as Record<string, unknown>,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });
  const loadTools = (raw: unknown) => {
    const selected = selectTools(definitions, raw, enabled);
    let changed = false;
    for (const [name, entry] of registered) {
      if (discoveryNames.includes(name)) continue;
      if (selected.has(name) !== enabled.has(name)) {
        entry.enabled = selected.has(name);
        changed = true;
      }
    }
    enabled = selected;
    for (const name of [...autoLoaded]) if (!enabled.has(name)) autoLoaded.delete(name);
    if (changed) server.sendToolListChanged();
    const names = [...enabled].sort();
    return {
      mode,
      enabled: names,
      permanent: discoveryNames,
      totalAvailable: definitions.length,
      categories: [
        ...new Set(names.flatMap((name) => toolCategories(name, findTool(definitions, name)))),
      ],
      projectChanged: false,
      next: 'Refresh tools/list for direct names, or call tool_call with a capability name.',
    };
  };
  /** Meta handlers shared by the direct entry tools and tool_call {name:'tools_search'|...}. */
  const meta: Record<string, (raw: unknown) => unknown> = {
    tools_search: (raw) => searchTools(definitions, raw, enabled),
    tool_schema: (raw) => {
      const request = parseArguments('tool_schema', toolSchemaRequestSchema, raw);
      const value = toolSchema(definitions, request.name, request);
      if (!enabled.has(request.name) && definitionsByName.has(request.name)) {
        const before = enabled.size;
        autoLoad(request.name);
        if (enabled.size !== before) server.sendToolListChanged();
      }
      return value;
    },
    tools_load: (raw) => loadTools(raw),
  };
  const registerMeta = (
    name: (typeof metaToolNames)[number],
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ) =>
    registered.set(
      name,
      server.registerTool(
        name,
        {
          description: metaToolDescriptions[name],
          inputSchema: lenient(metaToolSchemas[name].shape),
          annotations: metaToolAnnotations[name],
        },
        async (params) => {
          try {
            await refresh();
            return (await handler(params)) as never;
          } catch (e) {
            return toolError(e);
          }
        },
      ),
    );
  registerMeta('tools_search', async (params) => reply(meta.tools_search(params)));
  registerMeta('tool_schema', async (params) => reply(meta.tool_schema(params)));
  registerMeta('tool_call', async (params) => {
    const request = parseArguments('tool_call', toolCallSchema, params);
    if (Object.hasOwn(meta, request.name)) return reply(meta[request.name](request.arguments));
    if (request.name === 'tool_call')
      throw new VmotionError('TOOL_ARGUMENTS', 'tool_call cannot invoke itself; pass the capability name');
    const tool = findTool(definitions, request.name);
    const result = await execute(tool, request.arguments, request.response, {
      fields: request.fields,
      media: request.media,
    });
    const before = enabled.size;
    autoLoad(tool.name);
    if (enabled.size !== before) server.sendToolListChanged();
    await refresh();
    return withRouting(tool, result.result, request.fields);
  });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refresh();
    const tools = [...registered]
      .filter(([, entry]) => entry.enabled)
      .map(([name, entry]) => {
        let cached = listCache.get(name);
        if (!cached || cached.schema !== entry.inputSchema) {
          // Registration shapes are lenient; list the authoritative strict Zod 3 schema.
          const shape =
              definitionsByName.get(name)?.schema ??
              (metaToolSchemas as Record<string, z.AnyZodObject>)[name]?.shape,
            input = shape
              ? z.object(shape).strict()
              : (entry.inputSchema as z.ZodTypeAny | undefined);
          cached = {
            schema: entry.inputSchema,
            json: input
              ? (zodToJsonSchema(input, {
                  $refStrategy: 'root',
                }) as Record<string, unknown>)
              : { type: 'object', properties: {}, additionalProperties: false },
          };
          listCache.set(name, cached);
        }
        return {
          name,
          description:
            mode === 'all'
              ? entry.description
              : entry.description?.split(/\.\s/)[0].slice(0, 200),
          inputSchema: cached.json as { type: 'object' },
          annotations: entry.annotations,
        };
      });
    return { tools };
  });
  registerMeta('tools_load', async (params) => reply(meta.tools_load(params)));
  // A capability that exists but is not loaded in this connection (or an unknown name) gets a
  // structured routing answer instead of the SDK's bare "Tool X disabled/not found".
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const sdkCall = handlers.get('tools/call');
  if (sdkCall)
    handlers.set('tools/call', async (request, extra) => {
      const name = (request as { params?: { name?: unknown } }).params?.name;
      if (typeof name === 'string' && !registered.get(name)?.enabled) {
        await refresh();
        if (!registered.get(name)?.enabled)
          return toolError(
            definitionsByName.has(name)
              ? new VmotionError(
                  'TOOL_NOT_LOADED',
                  `${name} is a Vmotion capability but not a direct tool in this connection; call tool_call {"name":"${name}","arguments":{...}} or tools_load {"names":["${name}"]} and refresh tools/list`,
                  { name, directTools: routing().directTools },
                )
              : toolNotFound(definitions, name),
          );
      }
      return sdkCall(request, extra);
    });
  server.resource('project-guide', 'vmotion://guide', async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: 'The default connection lists 10 compact entry tools. Use tools_search for capabilities, tool_schema for one exact interface, and tool_call {name,arguments} for any named capability; tools_load enables direct names for this connection. Start with project_context and agent_guide for workflow routing. Use matrix3d for geometry and scene3d_render for native color/depth/face-ID evidence. Only tools in tools/list are callable by direct name; use tool_call for the rest. Planners and mode=plan writes return plan.planId (committed:false): project_preflight({planId}) then project_apply({planId}). Inspect media_sample before sequence_plan. Read source ranges through project_file_read. Edits return compact revisions/IDs/diagnostics; response=full or mcp --tools all preserves legacy reads/results. The application contains no AI model integration.',
      },
    ],
  }));
  server.resource('animation-guide', 'vmotion://animation-guide', async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(animationReference, null, 2),
      },
    ],
  }));
  server.resource('canvas-inbox', 'vmotion://inbox', async (uri) => {
    const listed = await call('inboxList', { status: 'open', limit: 20 });
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(listed),
        },
      ],
    };
  });

  // resources/subscribe for vmotion://inbox: pull clients get notifications/resources/updated
  // only after subscribing (MCP spec), instead of unsolicited updates.
  let inboxResourceSubscribed = false;
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    if (req.params.uri === 'vmotion://inbox') inboxResourceSubscribed = true;
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    if (req.params.uri === 'vmotion://inbox') inboxResourceSubscribed = false;
    return {};
  });

  const activeSamplingRuns = new Map<string, AbortController>();
  const replyWaiters = new Map<string, Set<(req: InboxRequest) => void>>();

  // Set when the client advertised sampling but createMessage reported it unsupported; stays
  // 'none' for this connection so the 15 s heartbeat does not re-enable pushes.
  let samplingUnsupported = false;
  const detectSamplingMode = (): SamplingMode => {
    const caps = server.server.getClientCapabilities();
    if (samplingUnsupported || !caps?.sampling) return 'none';
    return caps.sampling.tools ? 'tools' : 'basic';
  };

  const firstTextBlock = (content: unknown): string | undefined => {
    if (!Array.isArray(content)) return undefined;
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text;
      }
    }
    return undefined;
  };

  const callCapability = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<SamplingToolResult> => {
    try {
      await refresh();
      if (Object.hasOwn(meta, name)) {
        const value = meta[name](args);
        return { value, text: JSON.stringify(value), isError: false };
      }
      if (name === 'tool_call') {
        const request = parseArguments('tool_call', toolCallSchema, args);
        if (Object.hasOwn(meta, request.name)) {
          const value = meta[request.name](request.arguments);
          return { value, text: JSON.stringify(value), isError: false };
        }
        const inner = findTool(definitions, request.name);
        const res = await execute(inner, request.arguments, request.response, {
          fields: request.fields,
          media: false,
        });
        const text = firstTextBlock(res.result.content) ?? JSON.stringify(res.value);
        return {
          value: res.result.structuredContent ?? res.value,
          text,
          isError: res.result.isError === true,
        };
      }
      const tool = findTool(definitions, name);
      const res = await execute(tool, args, 'compact', { media: false });
      const text = firstTextBlock(res.result.content) ?? JSON.stringify(res.value);
      return {
        value: res.result.structuredContent ?? res.value,
        text,
        isError: res.result.isError === true,
      };
    } catch (e) {
      const errResult = toolError(e);
      const text =
        firstTextBlock(errResult.content) ?? JSON.stringify({ message: (e as Error).message });
      return {
        value: errResult.structuredContent ?? { message: (e as Error).message },
        text,
        isError: true,
      };
    }
  };

  const waitForReply = (requestId: string, signal: AbortSignal): Promise<InboxRequest> =>
    new Promise<InboxRequest>((resolve, reject) => {
      if (signal.aborted) {
        reject(new VmotionError('INBOX_ABORTED', 'Sampling cancelled'));
        return;
      }
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        signal.removeEventListener('abort', onAbort);
        const set = replyWaiters.get(requestId);
        set?.delete(onUpdate);
        if (set && !set.size) replyWaiters.delete(requestId);
        fn();
      };
      const onUpdate = (req: InboxRequest) => {
        if (req.status !== 'question') done(() => resolve(req));
      };
      const onAbort = () =>
        done(() => reject(new VmotionError('INBOX_ABORTED', 'Sampling cancelled')));
      let set = replyWaiters.get(requestId);
      if (!set) {
        set = new Set();
        replyWaiters.set(requestId, set);
      }
      set.add(onUpdate);
      signal.addEventListener('abort', onAbort, { once: true });
      const poll = setInterval(() => {
        void call('inboxGet', { id: requestId })
          .then((res) => {
            const req = (res as { request?: InboxRequest } | undefined)?.request;
            if (req && req.status !== 'question') onUpdate(req);
          })
          .catch(() => {});
      }, 1500);
      poll.unref();
    });

  const finishSampling = async (
    requestId: string,
    outcome: 'completed' | 'requeue' | 'aborted',
    note?: string,
  ) => {
    try {
      await call('mcpSamplingFinish', {
        sessionId: agent.sessionId,
        requestId,
        outcome,
        ...(note ? { note } : {}),
      });
    } catch {
      /* service closed */
    }
  };

  let unsubscribe: (() => void) | undefined;
  let subscribing: Promise<void> | undefined;

  const onServerEvent = (ev: McpServerEvent) => {
    if (ev.event === 'inboxChanged') {
      if (inboxResourceSubscribed)
        void server.server.sendResourceUpdated({ uri: 'vmotion://inbox' }).catch(() => {});
      const byId = new Map(ev.requests.map((r) => [r.id, r] as const));
      for (const [reqId, controller] of activeSamplingRuns) {
        const latest = byId.get(reqId);
        if (latest && (latest.status === 'cancelled' || latest.status === 'pending')) {
          controller.abort();
        }
      }
      for (const [reqId, waiters] of replyWaiters) {
        const latest = byId.get(reqId);
        if (latest && latest.status !== 'question') {
          for (const w of [...waiters]) w(latest);
        }
      }
      return;
    }
    if (ev.event === 'inboxPush') {
      const req = ev.request;
      if (agent.sampling === 'none') {
        void finishSampling(req.id, 'requeue', '客户端不支持 sampling，已退回待处理');
        return;
      }
      if (activeSamplingRuns.has(req.id)) return;
      const controller = new AbortController();
      activeSamplingRuns.set(req.id, controller);
      void runSamplingRequest({
        mode: agent.sampling,
        request: req,
        root,
        definitions,
        createMessage: (params, reqOpts) => server.server.createMessage(params, reqOpts),
        callCapability,
        waitForReply,
        signal: controller.signal,
      })
        .then(async (res) => {
          activeSamplingRuns.delete(req.id);
          if (res.outcome === 'requeue' && res.unsupported) {
            samplingUnsupported = true;
            agent.sampling = 'none';
            unsubscribe?.();
            unsubscribe = undefined;
            void ensureSubscription();
          }
          await finishSampling(
            req.id,
            res.outcome,
            res.outcome === 'requeue' ? res.note : undefined,
          );
        })
        .catch(async (err) => {
          activeSamplingRuns.delete(req.id);
          await finishSampling(req.id, 'requeue', (err as Error).message);
        });
    }
  };

  const ensureSubscription = () => {
    if (unsubscribe || closing) return Promise.resolve();
    return (subscribing ??= (async () => {
      const hello = {
        sessionId: agent.sessionId,
        client: agent.client,
        pid: agent.pid,
        sampling: agent.sampling,
      };
      if (app) {
        agent.origins = true;
        unsubscribe = app.attachMcpSession(hello, onServerEvent);
        return;
      }
      try {
        const sub = await subscribePipe(root, hello, {
          onEvent: onServerEvent,
          onClose: () => {
            unsubscribe = undefined;
          },
        });
        agent.origins = sub.origins;
        unsubscribe = sub.close;
      } catch {
        /* editor closed or older version without mcpSubscribe */
      }
    })().finally(() => {
      subscribing = undefined;
    }));
  };

  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      for (const c of activeSamplingRuns.values()) c.abort();
      activeSamplingRuns.clear();
      unsubscribe?.();
      unsubscribe = undefined;
      pipe?.close();
      await app?.close();
    })());
  transport.onclose = () => {
    void close();
  };
  // Presence heartbeat + live push subscription so an open Studio can push canvas requests
  // immediately when the client supports MCP sampling, and show "<client> 已连接 · MCP".
  const announce = async () => {
    agent.client ??= server.server.getClientVersion()?.name;
    agent.sampling = detectSamplingMode();
    // Subscribe only after initialize: the hello carries the negotiated sampling mode, and a
    // heartbeat before the handshake would register the session as 'none' for its lifetime.
    if (server.server.getClientCapabilities()) await ensureSubscription();
    if (app) {
      app.noteAgent({ client: agent.client, pid: agent.pid, sampling: agent.sampling });
      return;
    }
    try {
      const pong = await rpc(root, 'ping', {
        agent: { client: agent.client, pid: agent.pid, sampling: agent.sampling },
      });
      agent.origins = pong?.origins === true;
    } catch {
      /* editor closed or older */
    }
  };
  if (app) app.service.defaultOrigin = { kind: 'mcp' };
  server.server.oninitialized = () => void announce();
  const heartbeat = setInterval(() => void announce(), 15_000);
  heartbeat.unref();
  await server.connect(transport);
  process.stdin.on('end', () => {
    clearInterval(heartbeat);
    void server.close();
    void close();
  });
  return server;
}
