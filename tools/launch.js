import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // .env is optional. Demo mode is the default.
}

const url = `http://localhost:${process.env.PORT || '8787'}`;
const shouldOpen = !process.argv.includes('--no-open');

async function isRunning() {
  try {
    const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

function openBrowser() {
  if (!shouldOpen) return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

if (await isRunning()) {
  console.log(`Undercut is already running at ${url}`);
  openBrowser();
  process.exit(0);
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
  cwd: root,
  stdio: 'inherit',
});
server.on('exit', (code) => process.exit(code ?? 0));

for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await isRunning()) {
    console.log('Keep this window open to keep price alerts running.');
    openBrowser();
    break;
  }
  if (attempt === 59) {
    console.error('Undercut could not start.');
    server.kill();
    process.exit(1);
  }
  await sleep(250);
}
