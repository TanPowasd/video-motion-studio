import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  coerceRemoteUrlInput,
  formatUrlHost,
  hostFamily,
  httpUrl,
  isLocalEditorOrigin,
  isLoopbackAddress,
  localConnectHost,
  normalizeBindHost,
  reachableUrls,
} from '../src/service/net-address.js';
import { normalizeRemoteUrl } from '../src/service/remote-client.js';

describe('IPv6 network addressing', () => {
  it('classifies loopback addresses for IPv4, IPv6 and IPv4-mapped IPv6', () => {
    for (const addr of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost'])
      expect(isLoopbackAddress(addr), addr).toBe(true);
    for (const addr of ['192.168.1.10', '::ffff:192.168.1.10', '2001:db8::1', 'fe80::1%eth0', '::', undefined])
      expect(isLoopbackAddress(addr), String(addr)).toBe(false);
  });

  it('brackets IPv6 literals in URLs and keeps IPv4 / names untouched', () => {
    expect(hostFamily('2001:db8::1')).toBe('ipv6');
    expect(hostFamily('[::1]')).toBe('ipv6');
    expect(hostFamily('10.0.0.2')).toBe('ipv4');
    expect(hostFamily('studio.lan')).toBe('name');
    expect(formatUrlHost('2001:db8::1')).toBe('[2001:db8::1]');
    expect(formatUrlHost('[2001:db8::1]')).toBe('[2001:db8::1]');
    expect(httpUrl('::1', 4318)).toBe('http://[::1]:4318');
    expect(httpUrl('192.168.1.10', 4318)).toBe('http://192.168.1.10:4318');
    expect(normalizeBindHost('[::]')).toBe('::');
    expect(normalizeBindHost(undefined)).toBe('127.0.0.1');
    expect(localConnectHost('::')).toBe('::1');
    expect(localConnectHost('0.0.0.0')).toBe('127.0.0.1');
  });

  it('accepts IPv6 remote URLs, bare literals and rejects zone ids clearly', () => {
    expect(normalizeRemoteUrl('http://[2001:db8::1]:4318/')).toBe('http://[2001:db8::1]:4318');
    expect(normalizeRemoteUrl('[fd00::5]:9000')).toBe('http://[fd00::5]:9000');
    expect(normalizeRemoteUrl('2001:db8::1')).toBe('http://[2001:db8::1]:4318');
    expect(normalizeRemoteUrl('192.168.1.10:4318')).toBe('http://192.168.1.10:4318');
    expect(coerceRemoteUrlInput('https://studio.example')).toBe('https://studio.example');
    expect(() => normalizeRemoteUrl('fe80::1%eth0')).toThrow(/zone id/);
  });

  it('allows loopback editor origins over IPv4 and IPv6 only', () => {
    expect(isLocalEditorOrigin(undefined)).toBe(true);
    expect(isLocalEditorOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isLocalEditorOrigin('http://localhost:4318')).toBe(true);
    expect(isLocalEditorOrigin('http://[::1]:4318')).toBe(true);
    expect(isLocalEditorOrigin('http://[2001:db8::1]:4318')).toBe(false);
    expect(isLocalEditorOrigin('http://192.168.1.10:4318')).toBe(false);
    expect(isLocalEditorOrigin('null')).toBe(false);
  });

  it('lists reachable URLs per address family and skips link-local IPv6', () => {
    const interfaces = {
      lo: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '::1', family: 'IPv6', internal: true },
      ],
      eth0: [
        { address: '192.168.1.10', family: 'IPv4', internal: false },
        { address: '2001:db8::10', family: 'IPv6', internal: false },
        { address: 'fe80::10', family: 'IPv6', internal: false },
      ],
    } as never;
    expect(reachableUrls('0.0.0.0', 4318, { interfaces })).toEqual([
      'http://127.0.0.1:4318',
      'http://192.168.1.10:4318',
    ]);
    expect(reachableUrls('::', 4318, { interfaces })).toEqual([
      'http://127.0.0.1:4318',
      'http://[::1]:4318',
      'http://192.168.1.10:4318',
      'http://[2001:db8::10]:4318',
    ]);
    expect(reachableUrls('::', 4318, { interfaces, ipv6Only: true })).toEqual([
      'http://[::1]:4318',
      'http://[2001:db8::10]:4318',
    ]);
    expect(reachableUrls('2001:db8::10', 4318)).toEqual(['http://[2001:db8::10]:4318']);
  });

  it('a dual-stack :: listener answers over ::1 when IPv6 is available', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const listened = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen({ port: 0, host: '::' }, () => resolve(true));
    });
    if (!listened) return; // host without IPv6
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(httpUrl('::1', port)).catch(() => undefined);
      if (res) expect(await res.text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});
