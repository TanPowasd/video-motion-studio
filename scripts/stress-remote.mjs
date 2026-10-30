#!/usr/bin/env node
// Stress test for `vmotion remote serve`: one coordinator process, many simulated peers.
//
//   node scripts/stress-remote.mjs [--clients 1,10,50,100,200] [--duration 25] [--think 200]
//        [--scenario mixed|disjoint|conflict|viewer] [--procs 1] [--out stress.json]
//   --cpu-prof <dir> writes a V8 .cpuprofile of the coordinator per tier; --keep keeps the temp projects.
//   node scripts/stress-remote.mjs --merge a.json,b.json [--out all.json]   # combine separate runs
//
// Each tier starts a fresh temporary project + coordinator child process
// (`node dist/cli/index.mjs remote serve`), then runs N simulated peers as concurrent
// async loops (optionally split across --procs worker threads). Every peer posts presence,
// keeps an SSE /api/remote/events stream open and loops:
//   disjoint editor: pull -> edit its own node (own scene file or own node in a shared scene) -> push
//   conflict editor: pull -> edit the same property of one shared node -> push, retry on 409
//   viewer:          alternate GET /api/remote/status and incremental POST /api/remote/pull (viewer token)
// Requires `npm run build` first. Uses only Node built-ins.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { cpus, totalmem, tmpdir, arch, platform, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(repo, 'dist/cli/index.mjs');
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- project setup

const SCENE_COUNT = 20;
const sceneFile = (sid) => `scenes/${sid}.json`;

function rectNode(id, x, y) {
  return { id, type: 'rect', name: id, x, y, width: 40, height: 40, fill: '#5b8cff' };
}

/** Role plan for one tier. Indices are global client numbers. */
function planRoles(n, scenario) {
  const roles = [];
  for (let i = 0; i < n; i++) {
    if (scenario === 'disjoint') roles.push('disjoint');
    else if (scenario === 'conflict') roles.push('conflict');
    else if (scenario === 'viewer') roles.push(i === 0 ? 'disjoint' : 'viewer');
    else {
      // mixed: ~60% disjoint editors, ~20% conflict editors, ~20% viewers (at least one disjoint).
      const r = i % 5;
      roles.push(n === 1 || r <= 2 ? 'disjoint' : r === 3 ? 'conflict' : 'viewer');
    }
  }
  return roles;
}

/** Disjoint editor i owns node `n<i>` in scene `s<i % SCENE_COUNT>`: same-file node-level merges plus cross-file merges. */
const ownSceneOf = (i) => `s${i % SCENE_COUNT}`;

function prepareProject(dir, n, env) {
  const init = spawnSync(process.execPath, [cli, 'init', '-p', dir, '--name', 'stress'], {
    env,
    encoding: 'utf8',
  });
  if (init.status !== 0) throw new Error(`vmotion init failed: ${init.stderr || init.stdout}`);
  const manifestPath = path.join(dir, 'project.vmotion.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const scenes = {};
  for (let s = 0; s < SCENE_COUNT; s++) scenes[`s${s}`] = [];
  for (let i = 0; i < Math.max(n, 1); i++) {
    scenes[ownSceneOf(i)].push(rectNode(`n${i}`, (i * 37) % 1800, (i * 53) % 1000));
  }
  scenes.hot = [rectNode('hot', 960, 540)];
  for (const [sid, nodes] of Object.entries(scenes)) {
    const scene = { id: sid, name: sid, duration: 300, background: '#101525', nodes };
    writeFileSync(path.join(dir, sceneFile(sid)), JSON.stringify(scene, null, 2) + '\n');
    if (!manifest.scenes.includes(sceneFile(sid))) manifest.scenes.push(sceneFile(sid));
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function validateProject(dir, env) {
  const r = spawnSync(process.execPath, [cli, 'validate', '-p', dir], {
    env,
    encoding: 'utf8',
    timeout: 120_000,
  });
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = undefined;
  }
  const errors = (parsed?.diagnostics ?? []).filter((d) => d.severity === 'error');
  return {
    valid: r.status === 0 && parsed?.valid !== false,
    exitCode: r.status,
    errors: errors.slice(0, 5),
  };
}

// ---------------------------------------------------------------- coordinator process

async function startCoordinator(dir, port, token, viewerToken, env, cpuProfDir) {
  const child = spawn(
    process.execPath,
    [
      ...(cpuProfDir ? ['--cpu-prof', `--cpu-prof-dir=${cpuProfDir}`] : []),
      cli,
      'remote',
      'serve',
      '-p',
      dir,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--token',
      token,
      '--viewer-token',
      viewerToken,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (d) => (log = (log + d).slice(-4000)));
  child.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`coordinator exited early: ${log}`);
    try {
      const r = await rawRequest({
        port,
        method: 'GET',
        route: '/api/remote/status',
        token,
        timeoutMs: 2000,
      });
      if (r.status === 200) return { child, getLog: () => log };
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  child.kill('SIGKILL');
  throw new Error(`coordinator did not become ready: ${log}`);
}

/** Samples RSS (VmRSS / VmHWM) and CPU (utime+stime) from /proc. */
function startProcSampler(pid, intervalMs = 500) {
  const ticks = 100; // USER_HZ on Linux
  const samples = [];
  let last;
  const read = () => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const rss = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024;
      const hwm = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cpuS = (Number(fields[11]) + Number(fields[12])) / ticks;
      const t = now();
      if (last)
        samples.push({ t, rss, hwm, cpuPct: ((cpuS - last.cpuS) / ((t - last.t) / 1000)) * 100 });
      last = { t, cpuS };
    } catch {
      /* process gone */
    }
  };
  read();
  const timer = setInterval(read, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      read();
      const cpu = samples.map((s) => s.cpuPct);
      return {
        rssPeakMB: round(Math.max(0, ...samples.map((s) => Math.max(s.rss, s.hwm)))),
        rssEndMB: round(samples.at(-1)?.rss ?? 0),
        cpuAvgPct: round(cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : 0),
        cpuPeakPct: round(Math.max(0, ...cpu)),
      };
    },
  };
}

// ---------------------------------------------------------------- HTTP client

const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

function rawRequest({ port, method, route, token, body, peer, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.byteLength;
    }
    if (peer) {
      headers['X-Vmotion-Peer'] = peer.peerId;
      headers['X-Vmotion-Peer-Name'] = encodeURIComponent(peer.name);
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: route, headers, agent, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json, bytes: text.length });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Opens a long-lived SSE stream; parses only small events, counts the rest. */
function openSse(port, token, peer, state) {
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'GET',
    path: '/api/remote/events',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
      'X-Vmotion-Peer': peer.peerId,
      'X-Vmotion-Peer-Name': encodeURIComponent(peer.name),
    },
  });
  state.opened = true;
  req.on('response', (res) => {
    state.status = res.statusCode;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      state.bytes += chunk.length;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!block.startsWith('data: ')) continue;
        const t = now();
        // Avoid JSON.parse of large peers/locks payloads; sniff kind from the prefix.
        const kind = /^data: \{"kind":"([a-z]+)"/.exec(block)?.[1];
        state.events[kind] = (state.events[kind] ?? 0) + 1;
        if (kind === 'ready') {
          state.ready = true;
          state.readyAt = t;
        } else if (kind === 'change') {
          const rev = /"revision":"([a-f0-9]{64})"/.exec(block)?.[1];
          if (rev) state.changes.push([rev, t]);
        }
      }
    });
    res.on('close', () => {
      if (!state.closing) state.droppedAt = now();
      state.alive = false;
    });
    state.alive = true;
  });
  req.on('error', (e) => {
    if (!state.closing) state.error = e.message;
    state.alive = false;
  });
  req.end();
  return () => {
    state.closing = true;
    req.destroy();
  };
}

// ---------------------------------------------------------------- simulated peers

function makeClient(index, role, cfg) {
  const peer = { peerId: `stress-${role}-${index}`, name: `${role} ${index}` };
  return {
    index,
    role,
    peer,
    token: role === 'viewer' ? cfg.viewerToken : cfg.token,
    files: {},
    hashes: {},
    revision: undefined,
    lastCommitted: undefined, // value of own node x after the last committed push (disjoint)
    sse: { opened: false, alive: false, ready: false, bytes: 0, events: {}, changes: [] },
  };
}

function record(stats, key, ms) {
  (stats.lat[key] ??= []).push(ms);
}
function countCode(stats, route, code) {
  const k = `${route} ${code}`;
  stats.codes[k] = (stats.codes[k] ?? 0) + 1;
}

async function call(cfg, stats, client, method, route, body) {
  const t0 = now();
  try {
    const r = await rawRequest({
      port: cfg.port,
      method,
      route,
      token: client.token,
      body,
      peer: client.peer,
    });
    const ms = now() - t0;
    const code = r.status === 200 ? 'OK' : (r.json?.error?.code ?? `HTTP_${r.status}`);
    countCode(stats, route.replace('/api/remote/', ''), code);
    return { ...r, ms, code, t0, t1: t0 + ms };
  } catch (e) {
    const ms = now() - t0;
    const code = e.message === 'TIMEOUT' ? 'CLIENT_TIMEOUT' : `NET_${e.code ?? e.message}`;
    countCode(stats, route.replace('/api/remote/', ''), code);
    return { status: 0, ms, code, t0, t1: t0 + ms };
  }
}

async function pull(cfg, stats, client) {
  const r = await call(cfg, stats, client, 'POST', '/api/remote/pull', {
    peerId: client.peer.peerId,
    knownFileHashes: client.hashes,
  });
  if (r.status !== 200) return r;
  record(stats, client.role === 'viewer' ? 'viewerPull' : 'editorPull', r.ms);
  const { files, fileHashes, revision } = r.json;
  for (const name of Object.keys(client.files))
    if (!(name in fileHashes)) delete client.files[name];
  Object.assign(client.files, files);
  client.hashes = fileHashes;
  client.revision = revision;
  return r;
}

function editNode(client, sid, nodeId, value) {
  const file = sceneFile(sid);
  const scene = JSON.parse(client.files[file]);
  const node = scene.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`node ${nodeId} missing in ${file}`);
  node.x = value;
  return { [file]: JSON.stringify(scene, null, 2) + '\n' };
}

async function editorIteration(cfg, stats, client, seq, stopAt) {
  const conflict = client.role === 'conflict';
  const sid = conflict ? 'hot' : ownSceneOf(client.index);
  const nodeId = conflict ? 'hot' : `n${client.index}`;
  const value = client.index * 100_000 + seq;
  const tEdit = now();
  for (let attempt = 1; attempt <= cfg.maxRetries + 1; attempt++) {
    if (attempt > 1 && now() > stopAt) {
      // Measurement window closed while still retrying: not a convergence failure, just cut off.
      stats.cutoff[client.role === 'conflict' ? 'conflict' : 'disjoint']++;
      return;
    }
    const p = await pull(cfg, stats, client);
    if (p.status !== 200) {
      await sleep(50);
      continue;
    }
    const patch = editNode(client, sid, nodeId, value);
    const r = await call(cfg, stats, client, 'POST', '/api/remote/push', {
      peerId: client.peer.peerId,
      name: client.peer.name,
      baseRevision: client.revision,
      files: patch,
      message: `stress ${client.peer.peerId} #${seq}`,
    });
    const group = conflict ? 'conflict' : 'disjoint';
    stats.push[group].attempts++;
    record(stats, 'pushAll', r.ms);
    if (r.status === 200 && r.json?.committed) {
      record(stats, 'pushCommitted', r.ms);
      stats.push[group].committed++;
      stats.attemptsToCommit[group].push(attempt);
      stats.editLatency.push(now() - tEdit);
      // Update local mirror: theirs = base + patch, then the coordinator's delta.
      Object.assign(client.files, patch);
      for (const [f, v] of Object.entries(r.json.deltaForClient ?? {})) {
        if (v === null) delete client.files[f];
        else client.files[f] = v;
      }
      client.hashes = Object.fromEntries(
        Object.entries(client.files).map(([f, v]) => [f, sha256(v)]),
      );
      client.revision = r.json.revision;
      if (!conflict) client.lastCommitted = value;
      stats.commits.push([r.json.revision, r.t1, client.index]);
      return;
    }
    if (r.status === 409) {
      stats.push[group][r.code] = (stats.push[group][r.code] ?? 0) + 1;
      // Small randomized backoff before retrying on the fresh base.
      await sleep(Math.random() * 20 * attempt);
      continue;
    }
    stats.push[group].otherErrors++;
    await sleep(100);
  }
  stats.abandoned[client.role === 'conflict' ? 'conflict' : 'disjoint']++;
}

async function viewerIteration(cfg, stats, client, seq) {
  if (seq % 2 === 0) {
    const r = await call(cfg, stats, client, 'GET', '/api/remote/status');
    if (r.status === 200) record(stats, 'viewerStatus', r.ms);
  } else {
    await pull(cfg, stats, client);
  }
}

async function runClientLoop(cfg, stats, client, stopAt) {
  // Presence + SSE subscription (long-lived).
  const pr = await call(cfg, stats, client, 'POST', '/api/remote/presence', {
    peerId: client.peer.peerId,
    name: client.peer.name,
    sceneId: client.role === 'conflict' ? 'hot' : ownSceneOf(client.index),
    client: 'stress-remote',
  });
  if (pr.status === 200) record(stats, 'presence', pr.ms);
  client.closeSse = openSse(cfg.port, client.token, client.peer, client.sse);
  let lastPresence = now();
  await pull(cfg, stats, client);
  let seq = 0;
  while (now() < stopAt) {
    seq++;
    if (client.role === 'viewer') await viewerIteration(cfg, stats, client, seq);
    else await editorIteration(cfg, stats, client, seq, stopAt);
    if (now() - lastPresence > cfg.presenceMs) {
      lastPresence = now();
      const r = await call(cfg, stats, client, 'POST', '/api/remote/presence', {
        peerId: client.peer.peerId,
        frame: seq % 300,
      });
      if (r.status === 200) record(stats, 'presence', r.ms);
    }
    if (cfg.think > 0) await sleep(cfg.think * (0.5 + Math.random()));
  }
}

function emptyStats() {
  return {
    lat: {},
    codes: {},
    push: {
      disjoint: { attempts: 0, committed: 0, otherErrors: 0 },
      conflict: { attempts: 0, committed: 0, otherErrors: 0 },
    },
    attemptsToCommit: { disjoint: [], conflict: [] },
    abandoned: { disjoint: 0, conflict: 0 },
    cutoff: { disjoint: 0, conflict: 0 },
    editLatency: [],
    commits: [],
  };
}

/** Runs a slice of clients in this thread; returns raw records for the main thread to merge. */
async function runSlice(cfg, slice) {
  const stats = emptyStats();
  const clients = slice.map(([i, role]) => makeClient(i, role, cfg));
  const stopAt = cfg.startAt + cfg.duration * 1000;
  while (now() < cfg.startAt) await sleep(5);
  // Stagger start over 1s so presence/SSE do not all land in the same tick.
  await Promise.all(
    clients.map(async (c, k) => {
      await sleep((k / Math.max(clients.length, 1)) * 1000);
      await runClientLoop(cfg, stats, c, stopAt);
    }),
  );
  // Quiesce, then final incremental pull so each peer reports what it converged to.
  await sleep(1500);
  const finals = [];
  for (const c of clients) {
    const alive = c.sse.alive;
    const r = await pull(cfg, stats, c);
    const ok =
      r.status === 200 &&
      Object.keys(c.files).length === Object.keys(c.hashes).length &&
      Object.entries(c.files).every(([f, v]) => sha256(v) === c.hashes[f]);
    finals.push({
      index: c.index,
      role: c.role,
      revision: c.revision,
      mirrorOk: ok,
      lastCommitted: c.lastCommitted,
      sse: {
        opened: c.sse.opened,
        ready: c.sse.ready,
        readyAt: c.sse.readyAt,
        closedAt: c.sse.droppedAt,
        aliveAtEnd: alive,
        dropped: !!c.sse.droppedAt,
        error: c.sse.error,
        bytes: c.sse.bytes,
        events: c.sse.events,
        changes: c.sse.changes,
      },
    });
    c.closeSse?.();
  }
  return { stats, finals };
}

// ---------------------------------------------------------------- aggregation

function round(v, d = 1) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function pct(values) {
  if (!values.length) return { n: 0 };
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    p50: round(q(50)),
    p95: round(q(95)),
    p99: round(q(99)),
    max: round(s.at(-1)),
  };
}

function mergeStats(parts) {
  const out = emptyStats();
  for (const s of parts) {
    for (const [k, v] of Object.entries(s.lat)) (out.lat[k] ??= []).push(...v);
    for (const [k, v] of Object.entries(s.codes)) out.codes[k] = (out.codes[k] ?? 0) + v;
    for (const g of ['disjoint', 'conflict']) {
      for (const [k, v] of Object.entries(s.push[g])) out.push[g][k] = (out.push[g][k] ?? 0) + v;
      out.attemptsToCommit[g].push(...s.attemptsToCommit[g]);
      out.abandoned[g] += s.abandoned[g];
      out.cutoff[g] += s.cutoff[g];
    }
    out.editLatency.push(...s.editLatency);
    out.commits.push(...s.commits);
  }
  return out;
}

function summarizeTier({ n, roles, cfg, stats, finals, server, serverStatus, validation, wallS }) {
  const commitTime = new Map(stats.commits.map(([rev, t]) => [rev, t]));
  const sseLag = [];
  let delivered = 0;
  let expected = 0;
  for (const f of finals) {
    if (!f.sse.readyAt) continue;
    // A stream can only see commits that happened after its `ready` event (and before it dropped).
    const end = f.sse.closedAt ?? Infinity;
    const visible = new Set(
      stats.commits.filter(([, t]) => t > f.sse.readyAt + 5 && t < end).map(([rev]) => rev),
    );
    expected += visible.size;
    const seen = new Set();
    for (const [rev, t] of f.sse.changes) {
      const tc = commitTime.get(rev);
      if (tc === undefined || seen.has(rev)) continue;
      seen.add(rev);
      sseLag.push(t - tc);
      if (visible.has(rev)) delivered++;
    }
  }
  const sseClients = finals.filter((f) => f.sse.opened).length;
  const totalCommits = stats.commits.length;
  const attempts = stats.push.disjoint.attempts + stats.push.conflict.attempts;
  const conflict409 = (g) =>
    (stats.push[g].REMOTE_CONFLICT ?? 0) + (stats.push[g].REVISION_CONFLICT ?? 0);
  const serverRev = serverStatus?.revision;
  // Lost-update check: each disjoint editor's own node must hold its last committed value.
  let lostUpdates = 0;
  let checkedOwners = 0;
  if (serverStatus?.files) {
    const scenes = {};
    for (const f of finals) {
      if (f.role !== 'disjoint' || f.lastCommitted === undefined) continue;
      const sid = ownSceneOf(f.index);
      scenes[sid] ??= JSON.parse(serverStatus.files[sceneFile(sid)]);
      const node = scenes[sid].nodes.find((x) => x.id === `n${f.index}`);
      checkedOwners++;
      if (node?.x !== f.lastCommitted) lostUpdates++;
    }
  }
  const sseLagPositive = sseLag.map((v) => Math.max(0, v));
  return {
    clients: n,
    roles: {
      disjoint: roles.filter((r) => r === 'disjoint').length,
      conflict: roles.filter((r) => r === 'conflict').length,
      viewer: roles.filter((r) => r === 'viewer').length,
    },
    durationS: cfg.duration,
    wallS: round(wallS),
    push: {
      attempts,
      committed: totalCommits,
      throughputPerS: round(totalCommits / cfg.duration, 2),
      attemptsPerS: round(attempts / cfg.duration, 2),
      latencyAllMs: pct(stats.lat.pushAll ?? []),
      latencyCommittedMs: pct(stats.lat.pushCommitted ?? []),
      editEndToEndMs: pct(stats.editLatency),
      disjoint: {
        ...stats.push.disjoint,
        conflictRate: round(
          stats.push.disjoint.attempts ? conflict409('disjoint') / stats.push.disjoint.attempts : 0,
          3,
        ),
        attemptsToCommit: pct(stats.attemptsToCommit.disjoint),
        abandoned: stats.abandoned.disjoint,
        cutoffAtDeadline: stats.cutoff.disjoint,
      },
      conflict: {
        ...stats.push.conflict,
        conflictRate: round(
          stats.push.conflict.attempts ? conflict409('conflict') / stats.push.conflict.attempts : 0,
          3,
        ),
        attemptsToCommit: pct(stats.attemptsToCommit.conflict),
        abandoned: stats.abandoned.conflict,
        cutoffAtDeadline: stats.cutoff.conflict,
      },
    },
    pull: {
      editorMs: pct(stats.lat.editorPull ?? []),
      viewerMs: pct(stats.lat.viewerPull ?? []),
      viewerStatusMs: pct(stats.lat.viewerStatus ?? []),
      presenceMs: pct(stats.lat.presence ?? []),
      viewerOpsPerS: round(
        ((stats.lat.viewerPull?.length ?? 0) + (stats.lat.viewerStatus?.length ?? 0)) /
          cfg.duration,
        1,
      ),
    },
    codes: stats.codes,
    sse: {
      clients: sseClients,
      ready: finals.filter((f) => f.sse.ready).length,
      aliveAtEnd: finals.filter((f) => f.sse.aliveAtEnd).length,
      dropped: finals.filter((f) => f.sse.dropped).length,
      errors: [...new Set(finals.map((f) => f.sse.error).filter(Boolean))].slice(0, 3),
      changeDelivered: delivered,
      changeExpected: expected,
      deliveryRatio: round(expected ? delivered / expected : 1, 4),
      lagAfterPushResponseMs: pct(sseLagPositive),
      lagRawNegativeShare: round(
        sseLag.length ? sseLag.filter((v) => v < 0).length / sseLag.length : 0,
        3,
      ),
      peersEventsPerClient: round(
        finals.reduce((a, f) => a + (f.sse.events.peers ?? 0), 0) / Math.max(sseClients, 1),
      ),
      mbPerClient: round(
        finals.reduce((a, f) => a + f.sse.bytes, 0) / Math.max(sseClients, 1) / 1e6,
        2,
      ),
      mbTotal: round(finals.reduce((a, f) => a + f.sse.bytes, 0) / 1e6, 1),
    },
    server,
    final: {
      serverRevision: serverRev,
      peersListed: serverStatus?.peers ?? null,
      clientsAtServerRevision: finals.filter((f) => f.revision === serverRev).length,
      mirrorsOk: finals.filter((f) => f.mirrorOk).length,
      consistent: finals.every((f) => f.revision === serverRev && f.mirrorOk),
      lostUpdates,
      checkedOwners,
      serverConflicts: serverStatus?.conflicts ?? null,
      serverPendingFiles: serverStatus?.pendingFiles ?? null,
      validate: validation,
    },
  };
}

// ---------------------------------------------------------------- tier driver

async function runTier(n, opts, env) {
  const dir = mkdtempSync(path.join(tmpdir(), `vm-stress-${n}-`));
  const project = path.join(dir, 'project');
  const roles = planRoles(n, opts.scenario);
  prepareProject(project, n, env);
  const token = randomBytes(18).toString('base64url');
  const viewerToken = randomBytes(18).toString('base64url');
  const port = opts.port + (n % 1000);
  const { child, getLog } = await startCoordinator(
    project,
    port,
    token,
    viewerToken,
    env,
    opts.cpuProf ? path.resolve(opts.cpuProf, `tier-${n}`) : undefined,
  );
  const sampler = startProcSampler(child.pid);
  const selfSampler = startProcSampler(process.pid);
  const cfg = {
    port,
    token,
    viewerToken,
    duration: opts.duration,
    think: opts.think,
    maxRetries: opts.maxRetries,
    presenceMs: 10_000,
    startAt: now() + 300,
  };
  const t0 = now();
  const indexed = roles.map((r, i) => [i, r]);
  let results;
  const watchdogMs = (opts.duration + 120) * 1000;
  let watchdog;
  const withWatchdog = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error(`tier ${n} exceeded ${watchdogMs / 1000}s watchdog`)),
          watchdogMs,
        );
      }),
    ]).finally(() => clearTimeout(watchdog));
  try {
    if (opts.procs > 1 && n > 1) {
      const slices = Array.from({ length: Math.min(opts.procs, n) }, () => []);
      indexed.forEach((c, k) => slices[k % slices.length].push(c));
      results = await withWatchdog(
        Promise.all(
          slices.map(
            (slice) =>
              new Promise((resolve, reject) => {
                const w = new Worker(fileURLToPath(import.meta.url), {
                  workerData: { cfg, slice },
                });
                w.once('message', resolve);
                w.once('error', reject);
              }),
          ),
        ),
      );
    } else {
      results = [await withWatchdog(runSlice(cfg, indexed))];
    }
  } catch (e) {
    sampler.stop();
    selfSampler.stop();
    child.kill('SIGKILL');
    return {
      clients: n,
      crashed: true,
      error: e.message,
      coordinatorAlive: child.exitCode === null,
      log: getLog().slice(-1500),
      project,
    };
  }
  const wallS = (now() - t0) / 1000;
  const server = { ...sampler.stop(), coordinatorAlive: child.exitCode === null };
  const loadgen = selfSampler.stop();
  // Coordinator view after the run: revision + full files (editor pull without known hashes).
  let serverStatus;
  const st = await rawRequest({ port, method: 'GET', route: '/api/remote/status', token }).catch(
    () => undefined,
  );
  const full = await rawRequest({
    port,
    method: 'POST',
    route: '/api/remote/pull',
    token,
    body: {},
  }).catch(() => undefined);
  if (st?.status === 200 && full?.status === 200) {
    serverStatus = {
      revision: full.json.revision,
      files: full.json.files,
      peers: st.json.peers.length,
      conflicts: st.json.conflicts,
      pendingFiles: st.json.pendingFiles,
    };
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    sleep(opts.cpuProf ? 30_000 : 5000),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
  const validation = validateProject(project, env);
  const stats = mergeStats(results.map((r) => r.stats));
  const finals = results.flatMap((r) => r.finals);
  const summary = summarizeTier({
    n,
    roles,
    cfg,
    stats,
    finals,
    server,
    serverStatus,
    validation,
    wallS,
  });
  summary.loadgen = loadgen;
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  else summary.project = project;
  return summary;
}

function fmt(v) {
  return v === undefined || v === null ? '-' : String(v);
}

function printTable(tiers) {
  const head = [
    'clients',
    'd/c/v',
    'push/s',
    'push p50',
    'p95',
    'p99',
    'pull p50',
    'p95',
    'view ops/s',
    'conflict% (hot)',
    '409% (disj)',
    'abandon',
    'errors',
    'SSE alive',
    'SSE deliv',
    'SSE lag p95',
    'RSS MB',
    'CPU avg/peak',
    'consistent',
    'valid',
  ];
  const rows = tiers.map((t) => {
    if (t.crashed) return [t.clients, 'CRASH', t.error];
    const errs = Object.entries(t.codes)
      .filter(
        ([k]) =>
          !k.endsWith(' OK') && !k.endsWith('REMOTE_CONFLICT') && !k.endsWith('REVISION_CONFLICT'),
      )
      .reduce((a, [, v]) => a + v, 0);
    return [
      t.clients,
      `${t.roles.disjoint}/${t.roles.conflict}/${t.roles.viewer}`,
      t.push.throughputPerS,
      fmt(t.push.latencyAllMs.p50),
      fmt(t.push.latencyAllMs.p95),
      fmt(t.push.latencyAllMs.p99),
      fmt(t.pull.editorMs.p50),
      fmt(t.pull.editorMs.p95),
      t.pull.viewerOpsPerS,
      `${round(t.push.conflict.conflictRate * 100)}%`,
      `${round(t.push.disjoint.conflictRate * 100)}%`,
      t.push.disjoint.abandoned + t.push.conflict.abandoned,
      errs,
      `${t.sse.aliveAtEnd}/${t.sse.clients}`,
      `${round(t.sse.deliveryRatio * 100)}%`,
      fmt(t.sse.lagAfterPushResponseMs.p95),
      t.server.rssPeakMB,
      `${t.server.cpuAvgPct}/${t.server.cpuPeakPct}`,
      t.final.consistent && t.final.lostUpdates === 0 ? 'yes' : `NO (lost ${t.final.lostUpdates})`,
      t.final.validate.valid ? 'yes' : 'NO',
    ];
  });
  const all = [head, ...rows].map((r) => r.map(String));
  const widths = head.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  for (const [k, r] of all.entries()) {
    console.log(r.map((c, i) => c.padEnd(widths[i])).join(' | '));
    if (k === 0) console.log(widths.map((w) => '-'.repeat(w)).join('-|-'));
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      clients: { type: 'string', default: '1,10,50,100,200' },
      duration: { type: 'string', default: '25' },
      think: { type: 'string', default: '200' },
      scenario: { type: 'string', default: 'mixed' },
      procs: { type: 'string', default: '1' },
      port: { type: 'string', default: '47000' },
      'max-retries': { type: 'string', default: '30' },
      out: { type: 'string' },
      merge: { type: 'string' },
      'cpu-prof': { type: 'string' },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.merge) {
    // Combine per-tier JSON reports (e.g. tiers run as separate invocations) into one table/report.
    const reports = values.merge.split(',').map((f) => JSON.parse(readFileSync(f.trim(), 'utf8')));
    const tiers = reports.flatMap((r) => r.tiers).sort((a, b) => a.clients - b.clients);
    const merged = {
      ...reports[0],
      at: new Date().toISOString(),
      merged: values.merge.split(','),
      tiers,
    };
    if (values.out) writeFileSync(values.out, JSON.stringify(merged, null, 2) + '\n');
    printTable(tiers);
    return;
  }
  if (values.help) {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 17)
        .join('\n'),
    );
    return;
  }
  const opts = {
    clients: values.clients
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => v > 0),
    duration: Number(values.duration),
    think: Number(values.think),
    scenario: values.scenario,
    procs: Math.max(1, Number(values.procs)),
    port: Number(values.port),
    maxRetries: Number(values['max-retries']),
    keep: values.keep,
    cpuProf: values['cpu-prof'],
  };
  if (!['mixed', 'disjoint', 'conflict', 'viewer'].includes(opts.scenario))
    throw new Error(`unknown --scenario ${opts.scenario}`);
  const env = { ...process.env, VMOTION_REMOTE_TOKEN: '' };
  const machine = {
    platform: `${platform()} ${release()}`,
    arch: arch(),
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    memGB: round(totalmem() / 2 ** 30, 1),
    node: process.version,
  };
  console.error(`[stress-remote] ${JSON.stringify({ ...opts, machine })}`);
  const tiers = [];
  let failures = 0;
  for (const n of opts.clients) {
    console.error(`[stress-remote] tier ${n} clients: running ${opts.duration}s ...`);
    let tier = await runTier(n, opts, env);
    if (tier.crashed) {
      failures++;
      console.error(`[stress-remote] tier ${n} failed (${tier.error}); retrying once`);
      tier = await runTier(n, opts, env);
      if (tier.crashed) failures++;
    }
    tiers.push(tier);
    console.error(
      `[stress-remote] tier ${n}: ${tier.crashed ? `CRASH ${tier.error}` : `${tier.push.throughputPerS} push/s, p95 ${tier.push.latencyAllMs.p95}ms, RSS ${tier.server.rssPeakMB}MB`}`,
    );
    if (tier.crashed) {
      console.error('[stress-remote] tier crashed twice; stopping escalation');
      break;
    }
  }
  const report = {
    tool: 'scripts/stress-remote.mjs',
    at: new Date().toISOString(),
    options: opts,
    machine,
    failures,
    tiers,
  };
  if (values.out) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  }
  printTable(tiers);
  if (!values.out) console.log(JSON.stringify(report, null, 2));
  agent.destroy();
}

if (isMainThread) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  runSlice(workerData.cfg, workerData.slice).then((r) => {
    parentPort.postMessage(r);
    agent.destroy();
  });
}
