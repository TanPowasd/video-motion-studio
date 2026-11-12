import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { BuiltinPluginHost } from './types.js';
export interface RpcHandler<I = unknown, R = unknown> {
  schema: z.ZodTypeAny;
  run: (host: BuiltinPluginHost, raw: unknown) => Promise<R>;
  readonly _input?: (input: I) => void;
}
export function inlineRpcSchema<S extends z.ZodTypeAny>(
  schema: S,
): z.ZodType<
  z.output<S> & { inline?: boolean } & Record<string, unknown>,
  z.ZodTypeDef,
  z.input<S> & { inline?: boolean } & Record<string, unknown>
> {
  return z
    .object((schema as unknown as z.AnyZodObject).shape)
    .extend({ inline: z.boolean().optional() })
    .passthrough() as unknown as z.ZodType<
    z.output<S> & { inline?: boolean } & Record<string, unknown>,
    z.ZodTypeDef,
    z.input<S> & { inline?: boolean } & Record<string, unknown>
  >;
}
export function passthroughRpcSchema<S extends z.ZodTypeAny>(
  schema: S,
): z.ZodType<
  z.output<S> & Record<string, unknown>,
  z.ZodTypeDef,
  z.input<S> & Record<string, unknown>
> {
  return z.object((schema as unknown as z.AnyZodObject).shape).passthrough() as unknown as z.ZodType<
    z.output<S> & Record<string, unknown>,
    z.ZodTypeDef,
    z.input<S> & Record<string, unknown>
  >;
}
export type SimplifyRpcInput<T> = T extends object ? { [K in keyof T]: T[K] } : T;
export function defineRpcHandler<S extends z.ZodTypeAny, R>(
  schema: S,
  run: (host: BuiltinPluginHost, params: z.output<S>) => Promise<R>,
): RpcHandler<SimplifyRpcInput<z.input<S>>, R> {
  return {
    schema,
    async run(host, raw) {
      return await run(host, schema.parse(raw));
    },
  };
}
export function invokeRpcHandler(
  handlers: Record<string, { run: (host: BuiltinPluginHost, raw: unknown) => Promise<unknown> }>,
  host: BuiltinPluginHost,
  method: string,
  raw: unknown,
) {
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
  if (!handler) throw new VmotionError('METHOD_NOT_FOUND', `No RPC handler for ${method}`);
  return handler.run(host, raw);
}
