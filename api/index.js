// Vercel function: every /api/* request and /healthz is rewritten here (see vercel.json).
// Static files in public/ are served by Vercel directly.
import { config as appConfig } from '../server/config.js';
import { createRuntime } from '../server/runtime.js';

let runtime;

export default async function handler(req, res) {
  runtime ??= createRuntime(appConfig).catch((error) => {
    runtime = undefined;
    throw error;
  });
  try {
    const { handler: app } = await runtime;
    return await app(req, res);
  } catch (error) {
    console.error('Startup failed:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'Undercut could not start.' }));
    }
    return undefined;
  }
}
