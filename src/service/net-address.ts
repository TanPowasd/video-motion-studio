import net from 'node:net';
import os from 'node:os';
import { domainToASCII } from 'node:url';
import { VmotionError } from '../core/model.js';

/**
 * IPv4 / IPv6 / Domain / Domain:Port helpers shared by the HTTP service,
 * the remote coordinator CLI, desktop host controller, and remote client.
 *
 * - `::` binds dual-stack on every platform Node supports (IPv4 clients show up
 *   as `::ffff:a.b.c.d`), unless `ipv6Only` is requested.
 * - IPv6 literals are bracketed in URLs (`http://[2001:db8::1]:4318`).
 * - Link-local addresses with a zone id (`fe80::1%eth0`) can be bound, but the
 *   WHATWG URL parser used by fetch rejects zone ids, so they are not
 *   advertised as connect URLs.
 * - Bare domains (`studio.example.com`), `domain:port` (`ddns.example.com:4318`),
 *   IDN domains (`动效.example.com:4318`), and `http(s)://domain(:port)(/path)`
 *   are normalized consistently.
 */

export type HostFamily = 'ipv4' | 'ipv6' | 'name';

export interface BindTarget {
  host: string;
  port?: number;
}

export function stripBrackets(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

/** Normalizes fullwidth colons (`：`) typed in Chinese IME within URL scheme/authority. */
export function normalizeAuthorityColons(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes('\uff1a')) return trimmed;
  const schemeMatch = /^([a-z][a-z0-9+.-]*)\uff1a(\/\/.*)$/i.exec(trimmed);
  const withScheme = schemeMatch ? `${schemeMatch[1]}:${schemeMatch[2]}` : trimmed;
  const protoEnd = withScheme.indexOf('://');
  const authStart = protoEnd >= 0 ? protoEnd + 3 : withScheme.startsWith('//') ? 2 : 0;
  const slashRel = withScheme.slice(authStart).search(/[/?#]/);
  const authEnd = slashRel >= 0 ? authStart + slashRel : withScheme.length;
  return (
    withScheme.slice(0, authStart) +
    withScheme.slice(authStart, authEnd).replace(/\uff1a/g, ':') +
    withScheme.slice(authEnd)
  );
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
  return bare === 'localhost' || bare === 'localhost.';
}

export function extractRequestHostname(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const trimmed = hostHeader.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  const firstColon = trimmed.indexOf(':');
  if (firstColon >= 0 && trimmed.indexOf(':', firstColon + 1) < 0) {
    return trimmed.slice(0, firstColon);
  }
  return trimmed;
}

const FORWARDED_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'x-forwarded-host',
] as const;

/**
 * True only when the HTTP request arrived directly from the local machine over
 * loopback without reverse-proxy forwarding headers or a non-loopback domain `Host`.
 */
export function isDirectLocalRequest(req: {
  socket: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false;
  for (const h of FORWARDED_HEADERS) {
    const val = req.headers[h];
    if (typeof val === 'string' ? val.trim().length > 0 : Array.isArray(val) && val.length > 0) {
      return false;
    }
  }
  const hostHeader = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host;
  if (hostHeader !== undefined && !isLoopbackAddress(extractRequestHostname(hostHeader))) {
    return false;
  }
  return true;
}

export function isWildcardHost(host: string): boolean {
  const bare = stripBrackets(host);
  return bare === '0.0.0.0' || bare === '::' || bare === '0:0:0:0:0:0:0:0';
}

/** Host part for a URL: brackets IPv6 literals, punycodes IDN domains, percent-encodes zone ids. */
export function formatUrlHost(host: string): string {
  const bare = stripBrackets(host);
  const fam = hostFamily(bare);
  if (fam === 'ipv6') return `[${bare.replace('%', '%25')}]`;
  if (fam === 'name') {
    const ascii = domainToASCII(bare);
    return ascii || bare;
  }
  return bare;
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

function parsePortNumber(portStr: string, original: string): number {
  if (!/^\d+$/.test(portStr)) {
    throw new VmotionError('REMOTE_URL', `Invalid port "${portStr}" in address: ${original}`, {
      address: original,
    });
  }
  const num = Number(portStr);
  if (!Number.isInteger(num) || num < 0 || num > 65535) {
    throw new VmotionError('REMOTE_URL', `Port out of range (0..65535) in address: ${original}`, {
      address: original,
      port: num,
    });
  }
  return num;
}

function normalizeBindHostname(host: string, original: string): string {
  const bare = stripBrackets(host);
  if (hostFamily(bare) !== 'name') return bare;
  if (/[/?#\s]/.test(bare)) {
    throw new VmotionError('REMOTE_URL', `Invalid domain or hostname: ${original}`, {
      host: original,
    });
  }
  const ascii = domainToASCII(bare);
  if (!ascii) {
    throw new VmotionError('REMOTE_URL', `Invalid domain or hostname: ${original}`, {
      host: original,
    });
  }
  return ascii;
}

/**
 * Parses a bind host input that may be a wildcard (`::`, `0.0.0.0`), IPv4/IPv6 literal,
 * hostname/domain (`studio.local`), or `host:port` / `[ipv6]:port` / `http://host:port`.
 */
export function parseBindTarget(
  hostInput: string | undefined,
  fallback = '127.0.0.1',
): BindTarget {
  const raw = normalizeAuthorityColons(hostInput ?? '');
  if (!raw) return { host: fallback };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new VmotionError('REMOTE_URL', `Invalid bind address: ${hostInput}`, {
        host: hostInput,
      });
    }
    const host = normalizeBindHostname(parsed.hostname, hostInput!);
    const port = parsed.port ? parsePortNumber(parsed.port, hostInput!) : undefined;
    return { host, ...(port !== undefined ? { port } : {}) };
  }

  const authority = raw.replace(/\/+$/, '');
  if (authority.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
    if (!m) {
      throw new VmotionError('REMOTE_URL', `Invalid bracketed bind address: ${hostInput}`, {
        host: hostInput,
      });
    }
    const port = m[2] !== undefined ? parsePortNumber(m[2], hostInput!) : undefined;
    return {
      host: normalizeBindHostname(m[1]!, hostInput!),
      ...(port !== undefined ? { port } : {}),
    };
  }

  const colonCount = (authority.match(/:/g) ?? []).length;
  if (colonCount >= 2) {
    return { host: authority };
  }
  if (colonCount === 1) {
    const idx = authority.indexOf(':');
    const hostPart = authority.slice(0, idx).trim();
    const portPart = authority.slice(idx + 1).trim();
    if (!hostPart) {
      throw new VmotionError('REMOTE_URL', `Invalid bind address: ${hostInput}`, {
        host: hostInput,
      });
    }
    const port = parsePortNumber(portPart, hostInput!);
    return { host: normalizeBindHostname(hostPart, hostInput!), port };
  }

  return { host: normalizeBindHostname(authority, hostInput!) };
}

/** Normalises a user supplied bind host (`[::]` → `::`, `studio.local:4318` → `studio.local`). */
export function normalizeBindHost(host: string | undefined, fallback = '127.0.0.1'): string {
  return parseBindTarget(host, fallback).host;
}

function isLinkLocalV6(addr: string): boolean {
  return /^fe[89ab][0-9a-f]:/i.test(addr);
}

/**
 * URLs other machines can try for a server bound to `host`. A wildcard bind
 * lists every interface address of the matching families (loopback first);
 * a concrete IP or hostname/domain bind lists that address.
 */
export function reachableUrls(
  host: string,
  port: number,
  options: {
    ipv6Only?: boolean;
    publicUrls?: string[];
    interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  } = {},
): string[] {
  const bare = stripBrackets(host);
  const extra = options.publicUrls ?? [];
  if (!isWildcardHost(bare)) {
    return [...new Set([...extra, httpUrl(bare, port)])];
  }
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
  return [...new Set([...extra, ...loopback, ...external])];
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
 * Accepts `http(s)://...`, bare domain (`studio.example.com`), `domain:port`
 * (`studio.example.com:4318`, `studio.example.com:443` → `https://`), `ipv4(:port)`,
 * `[v6]:port` and bare IPv4/IPv6 literals (default port 4318), returning a URL string.
 */
export function coerceRemoteUrlInput(input: string): string {
  const value = normalizeAuthorityColons(input);
  if (!value) return value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  if (value.startsWith('//')) {
    const slashIdx = value.indexOf('/', 2);
    const auth = slashIdx >= 0 ? value.slice(2, slashIdx) : value.slice(2);
    return auth.endsWith(':443') ? `https:${value}` : `http:${value}`;
  }

  const slashIdx = value.search(/[/?#]/);
  const authority = slashIdx >= 0 ? value.slice(0, slashIdx) : value;
  const rest = slashIdx >= 0 ? value.slice(slashIdx) : '';

  // Bracketed IPv6 literal with or without `:port`
  const bracketMatch = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (bracketMatch) {
    const hostPart = `[${bracketMatch[1]!.replace('%', '%25')}]`;
    const portPart = bracketMatch[2];
    if (!portPart) return `http://${hostPart}:4318${rest}`;
    if (portPart === '443') return `https://${hostPart}:443${rest}`;
    return `http://${hostPart}:${portPart}${rest}`;
  }

  // Bare IPv6 literal (no brackets, default port 4318)
  if (net.isIPv6(authority.replace(/%.*$/, ''))) {
    return `http://${formatUrlHost(authority)}:4318${rest}`;
  }

  // Bare IPv4 literal (no port, default port 4318)
  if (net.isIPv4(authority)) {
    return `http://${authority}:4318${rest}`;
  }

  // `domain:port` or `ipv4:port`
  const hostPortMatch = /^([^:]+):(\d+)$/.exec(authority);
  if (hostPortMatch) {
    const [, rawHost, portPart] = hostPortMatch;
    const formattedHost = formatUrlHost(rawHost!);
    if (portPart === '443') return `https://${formattedHost}:443${rest}`;
    return `http://${formattedHost}:${portPart}${rest}`;
  }

  // Bare domain name (with optional subpath), e.g. `studio.example.com` or `studio.example.com/vmotion`
  return `http://${formatUrlHost(authority)}${rest}`;
}
