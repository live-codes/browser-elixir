/**
 * A static server for this demo.
 *
 * It exists because `file://` cannot run ES modules or fetch the wasm/bundle, and
 * because the AtomVM runtime expects the document to be cross-origin isolated:
 * the upstream example ships `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`, so this server sets the same.
 *
 *   node serve.js [port] [root] [--no-isolation]
 *
 * `root` defaults to `public/` and is resolved against this file. Pass
 * `--no-isolation` to omit COOP/COEP, which is how we check whether the runtime
 * really needs cross-origin isolation.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const noIsolation = argv.includes('--no-isolation');
const positional = argv.filter((arg) => !arg.startsWith('-'));

const PORT = Number(positional[0] ?? 8125);
const ROOT = resolve(fileURLToPath(new URL('./', import.meta.url)), positional[1] ?? 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.avm': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = normalize(join(ROOT, rel));

  if (!filePath.startsWith(normalize(ROOT))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: /${rel}`);
    return;
  }

  const headers = {
    'Content-Type': TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // The wasm runtime and the Elixir bundle are content-pinned and ~8 MB, so
    // they are worth caching hard: Popcorn recreates its iframe on every boot
    // (and on every heartbeat reload), and those re-fetches must not hit the wire.
    'Cache-Control': rel.startsWith('wasm/') ? 'public, max-age=31536000, immutable' : 'no-store',
  };

  if (!noIsolation) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  res.writeHead(200, headers).end(body);
});

server.listen(PORT, () => {
  console.log(`browser-elixir: http://localhost:${PORT}/`);
  console.log(
    `serving ${ROOT} — cross-origin isolation ${noIsolation ? 'OFF (--no-isolation)' : 'on'}`,
  );
  if (noIsolation) {
    console.log('note: the AtomVM runtime may refuse to boot without COOP/COEP');
  }
  console.log('first load downloads ~8 MB from this origin; later loads come from cache');
  console.log('press Ctrl+C to stop');
});
