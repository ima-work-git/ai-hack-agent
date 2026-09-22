import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
// @ts-expect-error Standalone Node supervisor intentionally has no build step.
import { acquireLock, atomicPrivateWrite, bindLoopback, endpointRecord, extractTunnelOrigin, healthProbe, networkAvailable, PORTS, publishEndpoint, recoveryAction, replaceEnvOrigin, restartDelay, runGh, spawnOwned, stopOwnedChild, supervise, SupervisorError, updateEnvOrigin, validOrigin } from '../scripts/serve-public.mjs';

const ORIGIN = 'https://fixture-chat-master.trycloudflare.com';
const NEXT_ORIGIN = 'https://fixture-restarted.trycloudflare.com';
const NOW = Date.UTC(2026, 8, 23, 5);
const temporary: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'public-supervisor-')); temporary.push(path); return path; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('public endpoint and local secret configuration', () => {
  it('accepts only an exact HTTPS Quick Tunnel origin and discards arbitrary log content', () => {
    expect(extractTunnelOrigin(`untrusted-key=fixture-secret\n| ${ORIGIN} |`)).toBe(ORIGIN);
    expect(extractTunnelOrigin(`${ORIGIN}\n${NEXT_ORIGIN}`)).toBe(NEXT_ORIGIN);
    for (const value of ['http://fixture.trycloudflare.com', `${ORIGIN}/`, `${ORIGIN}?token=fixture`, `${ORIGIN}.evil.test`, 'https://secret@fixture.trycloudflare.com', 'https://fixture.trycloudflare.com:443', 'https://localhost', 'https://a.b.trycloudflare.com']) {
      expect(validOrigin(value)).toBe(false);
      expect(extractTunnelOrigin(`message ${value} ending`)).toBeUndefined();
    }
  });

  it('updates only APP_ORIGIN, preserves other bytes, and rejects ambiguous multiline or duplicate assignments', () => {
    const input = '# settings\r\nAPI_KEY="synthetic-test-value"\r\nexport APP_ORIGIN="http://localhost:4173" # prior\r\nMODEL=fixture\r\n';
    expect(replaceEnvOrigin(input, ORIGIN)).toBe(`# settings\r\nAPI_KEY="synthetic-test-value"\r\nAPP_ORIGIN=${ORIGIN}\r\nMODEL=fixture\r\n`);
    expect(replaceEnvOrigin('API_KEY=synthetic', ORIGIN)).toBe(`API_KEY=synthetic\nAPP_ORIGIN=${ORIGIN}\n`);
    expect(() => replaceEnvOrigin('APP_ORIGIN=a\nAPP_ORIGIN=b\n', ORIGIN)).toThrow();
    expect(() => replaceEnvOrigin('API_KEY="line1\nAPP_ORIGIN=inside-secret\nline3"\n', ORIGIN)).toThrow();
    expect(() => replaceEnvOrigin('APP_ORIGIN="line1\nline2"\n', ORIGIN)).toThrow();
  });

  it('atomically writes private files with mode 0600 and leaves no temporary secrets', async () => {
    const dir = await directory(); const path = join(dir, '.env.local');
    await writeFile(path, 'API_KEY=synthetic\nAPP_ORIGIN=http://localhost:4173\n', { mode: 0o644 });
    await updateEnvOrigin(path, ORIGIN);
    expect(await readFile(path, 'utf8')).toBe(`API_KEY=synthetic\nAPP_ORIGIN=${ORIGIN}\n`);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await atomicPrivateWrite(join(dir, 'status.json'), JSON.stringify({ pid: 123, origin: ORIGIN, updatedAt: new Date(NOW).toISOString() }));
    expect((await stat(join(dir, 'status.json'))).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).some(file => file.includes('.tmp-'))).toBe(false);
  });

  it('publishes exactly the endpoint file on its dedicated branch, via stdin JSON rather than shell interpolation', async () => {
    const execute = vi.fn().mockResolvedValueOnce('a'.repeat(40) + '\n').mockResolvedValueOnce('');
    const record = await publishEndpoint({ repository: 'ima-work-git/ai-hack-agent', origin: ORIGIN, now: NOW, cwd: '/fixture/repo', gh: '/fixture/gh' }, execute);
    expect(record).toEqual({ version: 1, origin: ORIGIN, updatedAt: '2026-09-23T05:00:00.000Z', expiresAt: '2026-09-24T05:00:00.000Z' });
    expect(execute.mock.calls[0]![1]).toEqual(['api', '--method', 'GET', 'repos/ima-work-git/ai-hack-agent/contents/endpoint.json?ref=live-endpoint', '--jq', '.sha']);
    expect(execute.mock.calls[1]![1]).toEqual(['api', '--method', 'PUT', 'repos/ima-work-git/ai-hack-agent/contents/endpoint.json', '--input', '-', '--silent']);
    const body = JSON.parse(execute.mock.calls[1]![2].input);
    expect(body).toMatchObject({ sha: 'a'.repeat(40), branch: 'live-endpoint' });
    expect(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))).toEqual(record);
    expect(Object.keys(record).sort()).toEqual(['expiresAt', 'origin', 'updatedAt', 'version']);
  });

  it('does not create a missing branch or overwrite an endpoint without a validated SHA', async () => {
    const missing = vi.fn().mockRejectedValue(new SupervisorError('ENDPOINT_BRANCH_OR_FILE_MISSING', true));
    await expect(publishEndpoint({ repository: 'owner/repo', origin: ORIGIN }, missing)).rejects.toMatchObject({ fatal: true });
    expect(missing).toHaveBeenCalledTimes(1);
    const invalid = vi.fn().mockResolvedValue('unexpected response');
    await expect(publishEndpoint({ repository: 'owner/repo', origin: ORIGIN }, invalid)).rejects.toMatchObject({ code: 'INVALID_ENDPOINT_SHA' });
    expect(invalid).toHaveBeenCalledTimes(1);
    expect(() => endpointRecord('https://unrelated.test', NOW)).toThrow();
  });
});

describe('health and recovery gates', () => {
  it('uses three failures plus proof of Internet connectivity before restarting a tunnel', () => {
    const failed = { localHealthy: true, tunnelHealthy: false, publicHealthy: false, online: true };
    expect(recoveryAction({ ...failed, failures: 2 })).toBe('wait');
    expect(recoveryAction({ ...failed, failures: 3, online: false })).toBe('offline-wait');
    expect(recoveryAction({ ...failed, failures: 3 })).toBe('restart-tunnel');
    expect(recoveryAction({ ...failed, failures: 3, inGrace: true })).toBe('wait');
    expect(recoveryAction({ ...failed, failures: 3, localHealthy: false })).toBe('restart-app');
    expect(recoveryAction({ localHealthy: true, tunnelHealthy: true, publicHealthy: true, failures: 9 })).toBe('healthy');
    expect([1, 2, 3, 7, 100].map(restartDelay)).toEqual([1000, 2000, 4000, 60000, 60000]);
  });

  it('validates the public status shape, refuses redirects and oversized bodies, and treats GitHub rate limits as reachable', async () => {
    const fetchRequest = vi.fn().mockResolvedValue(json({ liveEnabled: true, version: 'fixture' }));
    expect(await healthProbe(`${ORIGIN}/api/status`, { statusJson: true, fetchRequest })).toBe(true);
    expect(fetchRequest.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
    expect(await healthProbe(`${ORIGIN}/api/status`, { statusJson: true, fetchRequest: async () => json({ unrelated: true }) })).toBe(false);
    expect(await healthProbe(`${ORIGIN}/api/status`, { statusJson: true, fetchRequest: async () => new Response('x'.repeat(16_385)) })).toBe(false);
    expect(await healthProbe(`${ORIGIN}/api/status`, { statusJson: true, fetchRequest: async () => json({}, 503) })).toBe(false);
    expect(await networkAvailable({ fetchRequest: async () => json({}, 403) })).toBe(true);
    expect(await networkAvailable({ fetchRequest: async () => { throw new Error('offline'); } })).toBe(false);
  });

  it('bounds a hanging health request at ten seconds', async () => {
    vi.useFakeTimers();
    const fetchRequest = vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    }));
    const pending = healthProbe(`${ORIGIN}/api/status`, { statusJson: true, fetchRequest });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(false);
  });
});

describe('owned process and lock safety', () => {
  it('refuses another process on the guard port, only probes a stale PID with signal zero, and releases its own lock', async () => {
    const dir = await directory(); const path = join(dir, 'supervisor.lock');
    let bound = false;
    const bind = vi.fn().mockImplementation(async () => {
      if (bound) throw new SupervisorError('LOCAL_PORT_OCCUPIED', true);
      bound = true; return { close: (done: () => void) => { bound = false; done(); } };
    });
    await writeFile(path, JSON.stringify({ pid: 999_999 }));
    const kill = vi.fn().mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    const release = await acquireLock(path, { pid: 987_654, kill, bind });
    try {
      expect(kill).toHaveBeenCalledExactlyOnceWith(999_999, 0);
      await expect(acquireLock(path, { pid: 987_655, kill, bind })).rejects.toMatchObject({ code: 'LOCAL_PORT_OCCUPIED' });
      expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(987_654);
    } finally { await release(); }
    expect(bound).toBe(false);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces a reused numeric PID after acquiring the exclusive guard without signalling it to stop', async () => {
    const dir = await directory(); const path = join(dir, 'supervisor.lock');
    await writeFile(path, JSON.stringify({ pid: 987_654 }));
    const kill = vi.fn();
    const close = vi.fn().mockImplementation((done: () => void) => done());
    const release = await acquireLock(path, { pid: 654_321, kill, bind: async () => ({ close }) });
    try {
      expect(kill).toHaveBeenCalledExactlyOnceWith(987_654, 0);
      expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(654_321);
    } finally { await release(); }
    expect(close).toHaveBeenCalledOnce();
  });

  it('starts without a shell, discards raw app output, and only terminates its own child handle', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = vi.fn().mockImplementation(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
    const spawn = vi.fn().mockReturnValue(child);
    const record = spawnOwned('/fixture/node', ['server/index.ts'], { cwd: '/fixture' }, undefined, spawn);
    expect(spawn.mock.calls[0]![2]).toMatchObject({ shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    await stopOwnedChild(record);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await stopOwnedChild(record);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('runs GitHub through a bounded child pipe and exposes only a fixed error code on missing branch', async () => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
    const spawn = vi.fn().mockImplementation(() => {
      queueMicrotask(() => { child.stderr.write('synthetic credential output must not escape: Not Found (HTTP 404)'); child.emit('close', 1); });
      return child;
    });
    await expect(runGh('gh', ['api', 'fixture'], { spawnProcess: spawn, input: '{}' })).rejects.toMatchObject({ code: 'ENDPOINT_BRANCH_OR_FILE_MISSING', message: 'ENDPOINT_BRANCH_OR_FILE_MISSING', fatal: true });
    expect(spawn.mock.calls[0]![2]).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  });
});

function simulation(overrides: Record<string, unknown> = {}) {
  let now = NOW; let ticks = 0; let tunnels = 0;
  const controller = new AbortController();
  const children: Array<{ alive: boolean; startedAt: number; kind: string }> = [];
  const dependencies = {
    now: () => now,
    sleep: async () => { now += 60_000; if (++ticks >= 7) controller.abort(); },
    healthProbe: vi.fn().mockResolvedValue(true), networkAvailable: vi.fn().mockResolvedValue(true),
    requireFreePort: vi.fn().mockResolvedValue(undefined), updateEnvOrigin: vi.fn().mockResolvedValue(undefined),
    atomicPrivateWrite: vi.fn().mockResolvedValue(undefined), log: vi.fn(),
    publishEndpoint: vi.fn().mockImplementation(async args => endpointRecord(args.origin, args.now)),
    spawnOwned: vi.fn().mockImplementation((binary, _args, _options, output) => {
      const kind = binary === '/fixture/cloudflared' ? 'tunnel' : 'app';
      const child = { alive: true, startedAt: now, kind }; children.push(child);
      if (kind === 'tunnel') output(Buffer.from(`| ${++tunnels === 1 ? ORIGIN : NEXT_ORIGIN} |`));
      return child;
    }),
    stopOwnedChild: vi.fn().mockImplementation(async child => { if (child) child.alive = false; }),
    ...overrides,
  };
  const config = { cwd: '/fixture/repo', cloudflared: '/fixture/cloudflared', repository: 'owner/repo', gh: 'gh', statusPath: '/fixture/status.json', signal: controller.signal };
  return { config, dependencies, controller, children, setTime: (value: number) => { now = value; } };
}

describe('supervisor recovery orchestration without external calls', () => {
  it('keeps children running while offline and restarts a broken tunnel only after connectivity returns', async () => {
    let checks = 0;
    const run = simulation({ healthProbe: vi.fn().mockImplementation(async (url: string) => !url.startsWith('https://') || ++checks === 1 || checks >= 6),
      networkAvailable: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(true) });
    await supervise(run.config, run.dependencies);
    expect(run.children.filter(child => child.kind === 'tunnel')).toHaveLength(2);
    expect(run.children.filter(child => child.kind === 'app')).toHaveLength(2);
    expect(run.dependencies.updateEnvOrigin.mock.calls.map(call => call[1])).toEqual([ORIGIN, NEXT_ORIGIN]);
    expect(run.dependencies.publishEndpoint.mock.calls.map(call => call[0].origin)).toEqual([ORIGIN, NEXT_ORIGIN]);
    expect(run.dependencies.log.mock.calls.flat()).toContain('NETWORK_UNAVAILABLE_WAIT');
    expect(run.children.every(child => !child.alive)).toBe(true);
  });

  it('does not churn children when the machine starts offline', async () => {
    const run = simulation({ networkAvailable: vi.fn().mockResolvedValue(false) });
    await supervise(run.config, run.dependencies);
    expect(run.dependencies.spawnOwned).not.toHaveBeenCalled();
    expect(run.dependencies.publishEndpoint).not.toHaveBeenCalled();
    expect(run.dependencies.networkAvailable.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('uses loopback child settings, publishes only after all health checks pass, and refreshes expiry after twelve hours', async () => {
    let ticks = 0;
    const run = simulation();
    run.dependencies.sleep = async () => { run.setTime(NOW + ++ticks * 12 * 60 * 60_000); if (ticks === 3) run.controller.abort(); };
    await supervise(run.config, run.dependencies);
    expect(run.dependencies.publishEndpoint).toHaveBeenCalledTimes(3);
    expect(run.children.filter(child => child.kind === 'tunnel')).toHaveLength(1);
    const startApp = run.dependencies.spawnOwned.mock.calls.find(call => call[0] !== '/fixture/cloudflared')!;
    expect(startApp[1]).toEqual(['--env-file=.env.local', 'server/index.ts', '--production']);
    expect(startApp[2].env).toMatchObject({ HOST: '127.0.0.1', PORT: '4173', APP_ORIGIN: ORIGIN });
    expect(run.dependencies.spawnOwned.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--metrics', '127.0.0.1:20243', '--no-autoupdate']));
    const status = JSON.parse(run.dependencies.atomicPrivateWrite.mock.calls[0]![1]);
    expect(Object.keys(status).sort()).toEqual(['origin', 'pid', 'updatedAt']);
    expect(status.origin).toBe(ORIGIN);
    expect(PORTS).toEqual({ app: 4173, metrics: 20243, supervisor: 20244 });
  });

  it('stops only its children if the dedicated endpoint branch is missing', async () => {
    const run = simulation({ publishEndpoint: vi.fn().mockRejectedValue(new SupervisorError('ENDPOINT_BRANCH_OR_FILE_MISSING', true)) });
    await expect(supervise(run.config, run.dependencies)).rejects.toMatchObject({ fatal: true });
    expect(run.children).toHaveLength(2);
    expect(run.children.every(child => !child.alive)).toBe(true);
    expect(run.dependencies.atomicPrivateWrite).not.toHaveBeenCalled();
  });

  it('backs off a lost child and refuses to take over an unrelated occupied port', async () => {
    let ticks = 0;
    const run = simulation();
    run.dependencies.sleep = async () => {
      run.setTime(NOW + ++ticks * 1000);
      if (ticks === 1) run.children.find(child => child.kind === 'tunnel')!.alive = false;
      if (ticks >= 5) run.controller.abort();
    };
    await supervise(run.config, run.dependencies);
    expect(run.children.filter(child => child.kind === 'tunnel')).toHaveLength(2);
    expect(run.dependencies.log.mock.calls.flat()).toContain('TUNNEL_CHILD_RESTART_WAIT');
    const occupied = simulation({ requireFreePort: vi.fn().mockRejectedValue(new SupervisorError('LOCAL_PORT_OCCUPIED', true)) });
    await expect(supervise(occupied.config, occupied.dependencies)).rejects.toMatchObject({ code: 'LOCAL_PORT_OCCUPIED' });
    expect(occupied.dependencies.spawnOwned).not.toHaveBeenCalled();
  });
});
