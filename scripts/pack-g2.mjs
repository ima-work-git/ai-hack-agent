import { mkdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const output = 'work/conversation-assistant.ehpk';
mkdirSync('work', { recursive: true });
rmSync(output, { force: true });
const result = spawnSync('node_modules/.bin/evenhub', ['pack', 'app.json', 'dist', '-o', output], { stdio: 'inherit' });
// The pinned CLI can exit 0 on an output-write error; check the artifact itself.
try { if (result.status !== 0 || statSync(output).size === 0) process.exit(1); }
catch { process.exit(1); }
