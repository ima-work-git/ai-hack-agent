#!/usr/bin/env node
// Local supervisor only. Starts no research jobs and logs no child output,
// environment content, GitHub credentials, authentication URLs or API responses.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Resolver } from 'node:dns/promises';
import { safeRequest } from '../server/safe-fetch.ts';

export const PORTS = Object.freeze({ app: 4173, metrics: 20243, supervisor: 20244 });
const BRANCH = 'live-endpoint';
const FILE = 'endpoint.json';
const HEALTH_MS = 60_000;
const PUBLIC_ORIGIN_GRACE_MS = 5 * 60_000;
const REFRESH_MS = 12 * 60 * 60_000;
const ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

export class SupervisorError extends Error {
  constructor(code, fatal = false) { super(code); this.code = code; this.fatal = fatal; }
}
export function validOrigin(value) { return typeof value === 'string' && ORIGIN.test(value); }
export function extractTunnelOrigin(text) {
  const candidates = text.match(/https:\/\/[^\s"'<>|]+/g) ?? [];
  return candidates.findLast(validOrigin);
}
export function restartDelay(failures) { return Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, failures - 1))); }
export function endpointRecord(origin, now = Date.now()) {
  if (!validOrigin(origin)) throw new SupervisorError('INVALID_PUBLIC_ORIGIN', true);
  return { version: 1, origin, updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 60 * 60_000).toISOString() };
}
export function replaceEnvOrigin(source, origin) {
  if (!validOrigin(origin)) throw new SupervisorError('INVALID_PUBLIC_ORIGIN', true);
  const pattern = /^[\t ]*(?:export[\t ]+)?APP_ORIGIN[\t ]*=[^\r\n]*/gm;
  const assignments = [...source.matchAll(pattern)];
  if (assignments.length > 1) throw new SupervisorError('AMBIGUOUS_ENV_ORIGIN', true);
  if (assignments.length === 1) {
    // Fail closed if this apparent assignment is inside another multiline value
    // or APP_ORIGIN itself spans lines. Preserve all other bytes verbatim.
    const parsedLine = parseEnv(assignments[0][0]).APP_ORIGIN;
    if (parsedLine === undefined || parsedLine !== parseEnv(source).APP_ORIGIN) throw new SupervisorError('AMBIGUOUS_ENV_ORIGIN', true);
    return source.replace(pattern, `APP_ORIGIN=${origin}`);
  }
  if (parseEnv(source).APP_ORIGIN !== undefined) throw new SupervisorError('AMBIGUOUS_ENV_ORIGIN', true);
  return `${source}${source && !source.endsWith('\n') ? '\n' : ''}APP_ORIGIN=${origin}\n`;
}

export async function atomicPrivateWrite(path, text) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, path); await chmod(path, 0o600);
  } finally { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export async function updateEnvOrigin(path, origin) {
  if (!(await lstat(path)).isFile()) throw new SupervisorError('ENV_FILE_NOT_REGULAR', true);
  const source = await readFile(path, 'utf8');
  if (source.length > 1_000_000) throw new SupervisorError('ENV_FILE_TOO_LARGE', true);
  await atomicPrivateWrite(path, replaceEnvOrigin(source, origin));
}

export function bindLoopback(port) {
  return new Promise((resolveBound, reject) => {
    const server = createServer(socket => socket.destroy());
    server.once('error', () => reject(new SupervisorError('LOCAL_PORT_OCCUPIED', true)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolveBound(server));
  });
}
const closeServer = server => new Promise(resolveClosed => server.close(resolveClosed));
export async function requireFreePort(port) { const probe = await bindLoopback(port); await closeServer(probe); }

export async function acquireLock(path, { pid = process.pid, kill = process.kill, guardPort = PORTS.supervisor, bind = bindLoopback } = {}) {
  // A kernel-owned loopback socket serializes stale lock recovery as well as
  // live instances. It closes automatically after a crash or machine reboot.
  const guard = await bind(guardPort);
  const owner = JSON.stringify({ pid, startedAt: new Date().toISOString() });
  try {
    try {
      const prior = JSON.parse(await readFile(path, 'utf8'));
      if (!Number.isInteger(prior.pid) || prior.pid <= 1) throw new SupervisorError('INVALID_SUPERVISOR_LOCK', true);
      // The exclusive guard is already ours. A surviving numeric PID can have
      // been reused after reboot; never signal that unrelated process to stop.
      // All current supervisors hold the guard throughout their lifetime.
      try { kill(prior.pid, 0); } catch { /* Dead or inaccessible PID: replace only this lock file. */ }
      await unlink(path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(owner, 'utf8'); await file.sync(); } finally { await file.close(); }
    return async () => {
      try { if (await readFile(path, 'utf8') === owner) await unlink(path); } catch { /* Do not unlink another owner. */ }
      await closeServer(guard);
    };
  } catch (error) { await closeServer(guard); throw error; }
}

export async function stopOwnedChild(record, waitMs = 8000) {
  if (!record || !record.alive) return;
  record.child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([record.exited.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), waitMs); })]);
  clearTimeout(timer);
  if (!stopped && record.alive) {
    record.child.kill('SIGKILL');
    await Promise.race([record.exited, sleep(2000)]);
  }
}

export function spawnOwned(binary, args, options, onOutput, spawnProcess = spawn) {
  const child = spawnProcess(binary, args, { ...options, shell: false, stdio: ['ignore', onOutput ? 'pipe' : 'ignore', onOutput ? 'pipe' : 'ignore'] });
  const record = { child, alive: true, startedAt: Date.now(), exited: null };
  record.exited = new Promise(resolveExit => {
    const done = () => { record.alive = false; resolveExit(); };
    child.once('error', done); child.once('close', done);
  });
  if (onOutput) { child.stdout?.on('data', onOutput); child.stderr?.on('data', onOutput); }
  return record;
}

export async function runGh(binary, args, { cwd, input, signal, spawnProcess = spawn, timeoutMs = 20_000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolveCommand, reject) => {
    const child = spawnProcess(binary, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let failed = false; let forceTimer;
    const fail = code => { failed = true; child.kill('SIGTERM'); forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000); };
    const onAbort = () => fail('GITHUB_CANCELLED');
    const timer = setTimeout(() => fail('GITHUB_TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(0, 16_385); if (stdout.length > 16_384) fail('GITHUB_OUTPUT_LIMIT'); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', onAbort); };
    child.once('error', () => { cleanup(); reject(new SupervisorError('GITHUB_CLI_UNAVAILABLE')); });
    child.once('close', code => {
      cleanup();
      if (failed || code !== 0) reject(new SupervisorError(/HTTP 404\b/.test(stderr) ? 'ENDPOINT_BRANCH_OR_FILE_MISSING' : 'GITHUB_PUBLISH_FAILED', /HTTP 404\b/.test(stderr)));
      else resolveCommand(stdout);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export async function publishEndpoint({ repository, origin, now = Date.now(), gh = 'gh', cwd, signal }, execute = runGh) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new SupervisorError('INVALID_GITHUB_REPOSITORY', true);
  const record = endpointRecord(origin, now);
  const path = `repos/${repository}/contents/${FILE}`;
  const sha = (await execute(gh, ['api', '--method', 'GET', `${path}?ref=${BRANCH}`, '--jq', '.sha'], { cwd, signal })).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new SupervisorError('INVALID_ENDPOINT_SHA', true);
  await execute(gh, ['api', '--method', 'PUT', path, '--input', '-', '--silent'], {
    cwd, signal, input: JSON.stringify({ message: 'Update live endpoint', branch: BRANCH, sha, content: Buffer.from(JSON.stringify(record) + '\n').toString('base64') }),
  });
  return record;
}

function isDnsFailure(error) {
  for (let depth = 0; error && depth < 5; depth++, error = error.cause) {
    if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') return true;
  }
  return false;
}

async function resolveProbeIpv4(hostname, signal) {
  signal.throwIfAborted();
  // An independent resolver bypasses the OS getaddrinfo cache. Cancelling it
  // cannot cancel another caller's DNS requests.
  const resolver = new Resolver({ timeout: 2000, tries: 2 });
  const onAbort = () => resolver.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try { return await resolver.resolve4(hostname); }
  finally { signal.removeEventListener('abort', onAbort); }
}

const validStatusBody = body => body !== null && typeof body === 'object' &&
  typeof body.liveEnabled === 'boolean' && typeof body.version === 'string';

export async function healthProbe(url, { statusJson = false, signal, fetchRequest = fetch, resolve4 = resolveProbeIpv4, request } = {}) {
  const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), 10_000);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    let response;
    try { response = await fetchRequest(url, { redirect: 'error', signal: combined, headers: { Accept: 'application/json' } }); }
    catch (error) {
      const path = '/api/status';
      // Only our exact public status URL can use this fallback. Other hosts,
      // local endpoints, HTTP/TLS errors and non-DNS failures keep failing.
      if (combined.aborted || !statusJson || !isDnsFailure(error) || typeof url !== 'string' ||
          !url.endsWith(path) || !validOrigin(url.slice(0, -path.length))) throw error;
      const fallback = await safeRequest(url, { signal: combined, maxBytes: 16_384, maxRedirects: 0,
        headers: { Accept: 'application/json' } }, {
        resolve: async hostname => (await resolve4(hostname, combined)).map(address => ({ address, family: 4 })),
        request,
      });
      combined.throwIfAborted();
      return fallback.status >= 200 && fallback.status < 300 && validStatusBody(JSON.parse(fallback.body.toString('utf8')));
    }
    if (!response.ok) { await response.body?.cancel(); return false; }
    if (!statusJson) { await response.body?.cancel(); return true; }
    if (Number(response.headers.get('content-length')) > 16_384 || !response.body) { await response.body?.cancel(); return false; }
    const reader = response.body.getReader(); let text = ''; let size = 0;
    const onAbort = () => { void reader.cancel().catch(() => {}); }; combined.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        combined.throwIfAborted(); const { value, done } = await reader.read(); combined.throwIfAborted();
        if (done) break; size += value.byteLength;
        if (size > 16_384) { await reader.cancel(); return false; }
        text += Buffer.from(value).toString('utf8');
      }
    } finally { combined.removeEventListener('abort', onAbort); reader.releaseLock(); }
    const body = JSON.parse(text);
    return validStatusBody(body);
  } catch { return false; } finally { timeout.abort(); clearTimeout(timer); }
}

export async function networkAvailable({ signal, fetchRequest = fetch } = {}) {
  const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), 10_000);
  try {
    const response = await fetchRequest('https://api.github.com/', { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal });
    await response.body?.cancel();
    return response.status >= 200; // A rate-limit response still proves network reachability.
  } catch { return false; } finally { clearTimeout(timer); }
}

export function recoveryAction({ localHealthy, tunnelHealthy, publicHealthy, failures, online, inGrace = false }) {
  if (localHealthy && tunnelHealthy && publicHealthy) return 'healthy';
  if (inGrace || failures < 3) return 'wait';
  if (!localHealthy) return 'restart-app';
  return online ? 'restart-tunnel' : 'offline-wait';
}

export async function supervise(config, dependencies = {}) {
  const clock = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }));
  const probe = dependencies.healthProbe ?? healthProbe;
  const online = dependencies.networkAvailable ?? networkAvailable;
  const launch = dependencies.spawnOwned ?? spawnOwned;
  const stop = dependencies.stopOwnedChild ?? stopOwnedChild;
  const publish = dependencies.publishEndpoint ?? publishEndpoint;
  const updateEnv = dependencies.updateEnvOrigin ?? updateEnvOrigin;
  const write = dependencies.atomicPrivateWrite ?? atomicPrivateWrite;
  const portFree = dependencies.requireFreePort ?? requireFreePort;
  const log = dependencies.log ?? (code => console.info(`[public-supervisor] ${code}`));
  const signal = config.signal;
  let tunnel; let app; let candidate; let origin; let tunnelText = ''; let generation = 0; let nextBootstrapProbe = 0;
  let tunnelFailures = 0; let appFailures = 0; let nextTunnel = 0; let nextApp = 0;
  let failures = 0; let nextHealth = 0; let publishedOrigin; let publishedAt = 0;
  let originStartedAt = 0; let publicConfirmed = false;
  const stopTunnel = async () => { const owned = tunnel; generation++; tunnel = undefined; candidate = undefined; tunnelText = ''; await stop(owned); };
  const stopApp = async () => { const owned = app; app = undefined; await stop(owned); };
  try {
    while (!signal.aborted) {
      let now = clock();
      if (tunnel && !tunnel.alive) { tunnel = undefined; candidate = undefined; nextTunnel = now + restartDelay(++tunnelFailures); log('TUNNEL_CHILD_RESTART_WAIT'); }
      if (app && !app.alive) { app = undefined; nextApp = now + restartDelay(++appFailures); log('APP_CHILD_RESTART_WAIT'); }
      if (!tunnel && now >= nextTunnel) {
        if (!await online({ signal })) { nextTunnel = clock() + HEALTH_MS; log('NETWORK_UNAVAILABLE_WAIT'); }
        else {
          await portFree(PORTS.metrics); tunnelText = ''; const currentGeneration = ++generation;
          tunnel = launch(config.cloudflared, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4173', '--protocol', 'http2', '--edge-ip-version', '4', '--metrics', '127.0.0.1:20243', '--loglevel', 'info', '--grace-period', '5s'], { cwd: config.cwd }, chunk => {
            if (currentGeneration !== generation) return;
            tunnelText = (tunnelText + String(chunk)).slice(-8192);
            const parsed = extractTunnelOrigin(tunnelText); if (parsed) candidate = parsed;
          });
          tunnel.startedAt = clock(); nextBootstrapProbe = clock() + 90_000; log('TUNNEL_STARTING');
        }
      }
      if (candidate && candidate !== origin) {
        await stopApp(); await updateEnv(join(config.cwd, '.env.local'), candidate);
        origin = candidate; nextApp = 0; failures = 0; nextHealth = 0;
        originStartedAt = clock(); publicConfirmed = false;
      }
      if (origin && !app && now >= nextApp) {
        await portFree(PORTS.app);
        app = launch(process.execPath, ['--env-file=.env.local', 'server/index.ts', '--production'], { cwd: config.cwd, env: { ...process.env, HOST: '127.0.0.1', PORT: '4173', APP_ORIGIN: origin } });
        app.startedAt = clock(); nextHealth = 0; log('APP_STARTING');
      }
      now = clock();
      if (app?.alive && tunnel?.alive && origin === candidate && now >= nextHealth) {
        const childInGrace = now - Math.max(app.startedAt, tunnel.startedAt) < 30_000;
        const [localHealthy, tunnelHealthy, publicHealthy] = await Promise.all([
          probe('http://127.0.0.1:4173/api/status', { statusJson: true, signal }),
          probe('http://127.0.0.1:20243/ready', { signal }),
          probe(`${origin}/api/status`, { statusJson: true, signal }),
        ]);
        signal.throwIfAborted();
        if (publicHealthy) publicConfirmed = true;
        // macOS may retain an initial negative DNS answer for a newly generated
        // hostname even after Cloudflare is ready. Do not keep replacing it.
        // This fixed origin deadline is never extended by an app-only restart.
        const publicInGrace = localHealthy && tunnelHealthy && !publicConfirmed &&
          clock() - originStartedAt < PUBLIC_ORIGIN_GRACE_MS;
        const inGrace = childInGrace || publicInGrace;
        const healthy = localHealthy && tunnelHealthy && publicHealthy;
        failures = healthy || inGrace ? 0 : failures + 1;
        const connected = !healthy && failures >= 3 && localHealthy ? await online({ signal }) : false;
        const action = recoveryAction({ localHealthy, tunnelHealthy, publicHealthy, failures, online: connected, inGrace });
        nextHealth = clock() + (inGrace && !healthy ? 3000 : HEALTH_MS);
        if (action === 'restart-app') { await stopApp(); nextApp = clock() + restartDelay(++appFailures); failures = 0; log('APP_HEALTH_RESTART'); }
        else if (action === 'restart-tunnel') { await stopTunnel(); nextTunnel = clock() + restartDelay(++tunnelFailures); failures = 0; log('TUNNEL_HEALTH_RESTART'); }
        else if (action === 'offline-wait') log('NETWORK_UNAVAILABLE_WAIT');
        else if (action === 'healthy') {
          if (now - app.startedAt >= 120_000) appFailures = 0;
          if (now - tunnel.startedAt >= 120_000) tunnelFailures = 0;
          if (publishedOrigin !== origin || clock() - publishedAt >= REFRESH_MS) {
            try {
              const record = await publish({ repository: config.repository, origin, now: clock(), gh: config.gh, cwd: config.cwd, signal });
              await write(config.statusPath, JSON.stringify({ pid: process.pid, origin, updatedAt: record.updatedAt }) + '\n');
              publishedOrigin = origin; publishedAt = Date.parse(record.updatedAt);
              log('PUBLIC_ENDPOINT_UPDATED');
            } catch (error) { if (error.fatal) throw error; log('PUBLIC_ENDPOINT_RETRY_PENDING'); }
          }
        }
      }
      // A child that never announces a URL must not hang startup forever.
      if (tunnel?.alive && !candidate && clock() >= nextBootstrapProbe) {
        nextBootstrapProbe = clock() + HEALTH_MS;
        if (await online({ signal })) { await stopTunnel(); nextTunnel = clock() + restartDelay(++tunnelFailures); log('TUNNEL_START_TIMEOUT'); }
      }
      await pause(1000, signal);
    }
  } catch (error) { if (!signal.aborted) throw error; }
  finally { await Promise.allSettled([stopApp(), stopTunnel()]); }
}

export async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new SupervisorError('NODE_24_REQUIRED', true);
  const cwd = process.cwd(); const cloudflared = process.env.ZATSUDAN_CLOUDFLARED;
  if (!cloudflared || !isAbsolute(cloudflared)) throw new SupervisorError('CLOUDFLARED_ABSOLUTE_PATH_REQUIRED', true);
  await access(cloudflared, constants.X_OK);
  for (const file of ['dist/index.html', 'server/index.ts', '.env.local']) await access(join(cwd, file), constants.R_OK);
  const directory = join(cwd, '.private', 'public-supervisor');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const controller = new AbortController(); const shutdown = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(name, shutdown);
  let release;
  try {
    release = await acquireLock(join(directory, 'supervisor.lock'));
    await requireFreePort(PORTS.app); await requireFreePort(PORTS.metrics);
    await supervise({ cwd, cloudflared, repository: process.env.ZATSUDAN_GH_REPOSITORY ?? 'ima-work-git/ai-hack-agent', gh: process.env.ZATSUDAN_GH_BIN ?? 'gh', statusPath: join(directory, 'status.json'), signal: controller.signal });
  } finally {
    await release?.();
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, shutdown);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never echo an OS/HTTP error message: it could contain a secret path or URL.
    console.error(`[public-supervisor] ${error instanceof SupervisorError ? error.code : 'SUPERVISOR_START_FAILED'}`);
    process.exitCode = 1;
  });
}
