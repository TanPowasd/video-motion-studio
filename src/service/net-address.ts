import net from 'node:net';
import os from 'node:os';

/**
 * IPv4 / IPv6 helpers shared by the HTTP service, the remote coordinator CLI
 * and the remote client.
 *
 * - `::` binds dual-stack on every platform Node supports (IPv4 clients show up
 *   as `::ffff:a.b.c.d`), unless `ipv6Only` is requested.
 * - IPv6 literals are bracketed in URLs (`http://[2001:db8::1]:4318`).
 * - Link-local addresses with a zone id (`fe80::1%eth0`) can be bound, but the
 *   WHATWG URL parser used by fetch rejects zone ids, so they are not
 *   advertised as connect URLs.
 */

export type HostFamily = 'ipv4' | 'ipv6' | 'name';

export function stripBrackets(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

export function hostFamily(host: string): HostFamily {
  const bare = stripBrackets(host).replace(/%.*$/, '');
  const kind = net.isIP(bare);
  return kind === 4 ? 'ipv4' : kind === 6 ? 'ipv6' : 'name';
}

/** Unwraps `::ffff:a.b.c.d` (IPv4-mapped IPv6) to `a.b.c.d`. */
export function unmapIpv4(addr: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  return match ? match[1] : addr;
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const bare = unmapIpv4(stripBrackets(addr).replace(/%.*$/, '').toLowerCase());
  if (net.isIPv4(bare)) return bare.startsWith('127.');
  if (net.isIPv6(bare)) return bare === '::1' || bare === '0:0:0:0:0:0:0:1';
  return bare === 'localhost';
}

export function isWildcardHost(host: string): boolean {
  const bare = stripBrackets(host);
  return bare === '0.0.0.0' || bare === '::' || bare === '0:0:0:0:0:0:0:0';
}

/** Host part for a URL: brackets IPv6 literals and percent-encodes a zone id. */
export function formatUrlHost(host: string): string {
  const bare = stripBrackets(host);
  if (hostFamily(bare) !== 'ipv6') return bare;
  return `[${bare.replace('%', '%25')}]`;
}

export function httpUrl(host: string, port: number): string {
  return `http://${formatUrlHost(host)}:${port}`;
}

/** Address a same-machine client should use to reach a server bound to `host`. */
export function localConnectHost(host: string): string {
  const bare = stripBrackets(host);
  if (bare === '0.0.0.0') return '127.0.0.1';
  if (isWildcardHost(bare)) return '::1';
  return bare;
}

/** Normalises a user supplied bind host (`[::]` → `::`). */
export function normalizeBindHost(host: string | undefined, fallback = '127.0.0.1'): string {
  const value = host?.trim();
  if (!value) return fallback;
  return stripBrackets(value);
}

function isLinkLocalV6(addr: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(addr);
}

/**
 * URLs other machines can try for a server bound to `host`. A wildcard bind
 * lists every interface address of the matching families (loopback first);
 * a concrete bind lists just that address.
 */
export function reachableUrls(
  host: string,
  port: number,
  options: { ipv6Only?: boolean; interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]> } = {},
): string[] {
  const bare = stripBrackets(host);
  if (!isWildcardHost(bare)) return [httpUrl(bare, port)];
  const wantV4 = bare === '0.0.0.0' || !options.ipv6Only;
  const wantV6 = bare !== '0.0.0.0';
  const loopback: string[] = [];
  const external: string[] = [];
  const interfaces = options.interfaces ?? os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const v6 = entry.family === 'IPv6' || (entry.family as unknown) === 6;
      if (v6 ? !wantV6 : !wantV4) continue;
      if (v6 && (isLinkLocalV6(entry.address) || entry.address.includes('%'))) continue;
      (entry.internal ? loopback : external).push(httpUrl(entry.address, port));
    }
  }
  if (!loopback.length) loopback.push(httpUrl(localConnectHost(bare), port));
  return [...new Set([...loopback, ...external])];
}

/** Origin check for the browser editor: loopback hosts only, IPv4 or IPv6. */
export function isLocalEditorOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:') return false;
    return isLoopbackAddress(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Accepts `http(s)://...`, `host:port`, `[v6]:port` and a bare IPv6 literal
 * (`2001:db8::1`, port 4318 assumed) and returns a URL string.
 */
export function coerceRemoteUrlInput(input: string): string {
  const value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (net.isIPv6(value.replace(/%.*$/, ''))) return `http://${formatUrlHost(value)}:4318`;
  return `http://${value}`;
}
