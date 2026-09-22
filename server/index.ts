import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { readConfig } from './config.ts';
import { createApiHandler } from './http.ts';

const config = readConfig();
const api = createApiHandler(config);
const production = process.argv.includes('--production');
const vite = production ? null : await (await import('vite')).createServer({ server: { middlewareMode: true, fs: { deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/.private/**', '**/server/**', '**/.codex/**', '**/.agents/**', '**/aidlc/**', resolve(config.budget.directory).replaceAll('\\', '/') + '/**'] } }, appType: 'spa' });
const root = resolve('dist');
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (await api.handle(req, res)) return;
    if (vite) { vite.middlewares(req, res); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(req.url || '/', config.origin).pathname);
    let file = resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + sep)) { res.writeHead(404).end(); return; }
    if (pathname === '/' || !extname(file)) file = resolve(root, 'index.html');
    if (!(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https: wss: ws:; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Content-Type', contentTypes[extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '処理を完了できませんでした。接続を確認して再開してください。' }));
  }
});
server.on('upgrade', (req, socket, head) => { if (!api.upgrade(req, socket, head) && production) socket.destroy(); });
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.port, config.host, () => console.info(`会話アシスタント: ${config.origin} (${config.status.liveEnabled ? '実API利用可能' : '体験デモ'})`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { api.close(); void vite?.close(); server.close(() => process.exit(0)); });
