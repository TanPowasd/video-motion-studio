import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Application } from '../service/application.js';
import { existingService, rpc, servePipe } from '../service/ipc.js';
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
} from './discovery.js';
import { invokeTool, toolError, toolCallSchema } from './invoke.js';

export async function startMcp(root: string, options: { tools?: 'compact' | 'all' } = {}) {
  const remote = await existingService(root),
    app = remote ? undefined : await new Application(root).open(),
    pipe = app ? await servePipe(app) : undefined,
    call = (method: string, params?: unknown) =>
      app ? app.dispatch(method, params) : rpc(root, method, params),
    mode = options.tools ?? 'compact',
    server = new McpServer(
      { name: 'vmotion', version: '0.2.0' },
      {
        instructions:
          'Use project_context and agent_guide. tools_search lists concise capabilities; tool_schema gives one exact interface; tool_call executes any capability without loading schemas; tools_load enables direct tools for this connection. Candidate edits still require the shared preflight/apply flow. The application never calls AI models.',
      },
    ),
    definitions = toolDefinitions(),
    registered = new Map<string, RegisteredTool>();
  let enabled = mode === 'all' ? new Set(definitions.map((t) => t.name)) : new Set(coreTools);
  const execute = async (tool: ToolDefinition, args: unknown, response: 'compact' | 'full') => {
    if (app) return invokeTool(tool, args, call, { response });
    try {
      return await rpc(root, 'agentToolInvoke', {
        name: tool.name,
        arguments: args,
        response,
        inline: true,
      });
    } catch (e) {
      // Older open editors can still serve their existing capabilities through the bridge.
      if ((e as { code?: string }).code === 'METHOD_NOT_FOUND')
        return invokeTool(tool, args, call, { response });
      throw e;
    }
  };
  for (const tool of definitions) {
    const entry = server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.schema,
        annotations: toolAnnotations(tool.name),
      },
      async (params) => {
        try {
          return (await execute(tool, params, mode === 'all' ? 'full' : 'compact')).result;
        } catch (e) {
          return toolError(e);
        }
      },
    );
    registered.set(tool.name, entry);
    if (!enabled.has(tool.name)) entry.disable();
  }
  const discoveryNames = ['tools_search', 'tool_schema', 'tool_call', 'tools_load'];
  server.registerTool(
    'tools_search',
    {
      description:
        'Find Vmotion capabilities by query/category with summaries, input field names and read/write hints. No full schemas or project source returned. Supports Chinese/English terms and pagination. Select names, then tool_schema/tool_call or tools_load.',
      inputSchema: toolSearchSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const value = searchTools(definitions, params, enabled);
        return {
          structuredContent: value,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );
  server.registerTool(
    'tool_schema',
    {
      description:
        'Read one exact capability interface. Compact JSON Schema reuses local $refs to avoid repeated fields; expanded resolves the legacy inline representation. Cache schemaHash and pass ifHash on later checks to receive notModified. Use tool_call without loading the whole catalog.',
      inputSchema: toolSchemaRequestSchema.shape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const value = toolSchema(definitions, params.name, params);
        return {
          structuredContent: value,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );
  server.registerTool(
    'tool_call',
    {
      description:
        'Invoke any named Vmotion capability, including tools absent from tools/list. Validates the same exact schema and uses the same project service/transactions. Returns structured JSON and native media. Edits return compact revision/IDs/diagnostics by default; response=full requests legacy results. Use tool_schema first when arguments are unknown; this gateway may mutate the project.',
      inputSchema: toolCallSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const tool = findTool(definitions, params.name);
        return (await execute(tool, params.arguments, params.response)).result;
      } catch (e) {
        return toolError(e);
      }
    },
  );
  server.registerTool(
    'tools_load',
    {
      description:
        'Enable named/category direct tools in this MCP connection. mode=add preserves currently loaded tools; replace returns to essential tools before adding. All capabilities remain callable through tool_call. Does not edit the project or other agent connections. Sends tools/list_changed; clients without dynamic reload should use tool_call.',
      inputSchema: toolLoadSchema.shape,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const selected = selectTools(definitions, params, enabled);
        let changed = false;
        for (const [name, entry] of registered) {
          if (selected.has(name) !== enabled.has(name)) {
            entry.enabled = selected.has(name);
            changed = true;
          }
        }
        enabled = selected;
        if (changed) server.sendToolListChanged();
        const names = [...enabled].sort(),
          value = {
            mode,
            enabled: names,
            permanent: discoveryNames,
            totalAvailable: definitions.length,
            categories: [...new Set(names.flatMap(toolCategories))],
            projectChanged: false,
            next: 'Refresh tools/list for direct names, or call tool_call with a capability name.',
          };
        return {
          structuredContent: value,
          content: [{ type: 'text', text: JSON.stringify(value) }],
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );
  server.resource('project-guide', 'vmotion://guide', async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: 'The default connection lists 10 compact entry tools. Use tools_search for capabilities, tool_schema for one exact interface, and tool_call {name,arguments} for any named capability; tools_load enables direct names for this connection. Start with project_context and agent_guide for workflow routing. Use matrix3d for geometry and scene3d_render for native color/depth/face-ID evidence. Inspect media_sample before sequence_plan; preflight its exact candidate and apply the unchanged payload with assetChecks. Read source ranges through project_file_read. Edits return compact revisions/IDs/diagnostics; response=full or mcp --tools all preserves legacy reads/results. The application contains no AI model integration.',
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
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      pipe?.close();
      await app?.close();
    })());
  transport.onclose = () => {
    void close();
  };
  await server.connect(transport);
  process.stdin.on('end', () => {
    void server.close();
    void close();
  });
  return server;
}
