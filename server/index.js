// Local server: the same app as the Vercel function, plus a built-in timer for price checks.
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { config } from './config.js';
import { createRuntime } from './runtime.js';

if (!config.databaseUrl) mkdirSync(config.dataDir, { recursive: true });

const runtime = await createRuntime(config);
const server = http.createServer(runtime.handler);
const tick = () => runtime.monitor.run().catch((error) => console.error('Monitor run failed:', error));
const timer = setInterval(tick, config.pollSeconds * 1000);

server.listen(config.port, config.host, () => {
  console.log(`Undercut running at http://${config.host}:${config.port}`);
  console.log(`Price source: ${runtime.provider.label}, checked every ${config.pollSeconds}s`);
  tick();
});

function shutdown() {
  clearInterval(timer);
  server.close(async () => {
    await runtime.close();
    process.exit(0);
  });
  server.closeAllConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
