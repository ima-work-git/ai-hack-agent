import { mkdir, writeFile, access, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.ima-work-git.zatsudan-master';
const tunnel = process.env.ZATSUDAN_CLOUDFLARED;
if (process.platform !== 'darwin' || !tunnel || !tunnel.startsWith('/')) throw new Error('macOS and absolute ZATSUDAN_CLOUDFLARED are required');
await access(tunnel);
await access(resolve(root, 'dist/index.html'));
await access(resolve(root, '.env.local'));
const state = resolve(root, '.private/public-supervisor');
await mkdir(state, { recursive: true, mode: 0o700 });
const xml = value => String(value).replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(resolve(root, 'scripts/serve-public.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
<key>ZATSUDAN_CLOUDFLARED</key><string>${xml(tunnel)}</string>
<key>ZATSUDAN_GH_BIN</key><string>${xml(process.env.ZATSUDAN_GH_BIN || '/opt/homebrew/bin/gh')}</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(resolve(state, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(state, 'service.log'))}</string>
</dict></plist>
`;
const outIndex = process.argv.indexOf('--output');
const destination = outIndex >= 0 ? resolve(process.argv[outIndex + 1] || '') : resolve(homedir(), 'Library/LaunchAgents', `${label}.plist`);
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
await writeFile(destination, plist, { mode: 0o600 });
await chmod(destination, 0o600);
if (outIndex >= 0) {
  console.log(JSON.stringify({ prepared: true, path: destination, label }));
} else {
  const domain = `gui/${process.getuid()}`;
  spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  const result = spawnSync('/bin/launchctl', ['bootstrap', domain, destination], { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Service bootstrap failed (${result.status}); inspect launchctl for ${label}`);
  console.log(JSON.stringify({ installed: true, label, path: destination }));
}
