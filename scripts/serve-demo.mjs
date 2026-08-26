#!/usr/bin/env node
/**
 * Zero-dependency static server for tests/demo-app.
 *
 * The demo app exists so `pnpm test` works on a fresh clone with no VPN, no
 * credentials and no external site — useful for onboarding and for CI smoke
 * checks of the framework itself. Point config/env/qa.json at the real
 * application when you test the actual product.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'tests', 'demo', 'demo-app');
const port = Number(process.env.DEMO_APP_PORT ?? 4173);

const server = createServer(async (req, res) => {
  try {
    const html = await readFile(path.join(appDir, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Demo app failed to load: ${error.message}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Demo app listening on http://127.0.0.1:${port}\n`);
});
