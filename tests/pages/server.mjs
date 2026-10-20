// SPDX-License-Identifier: GPL-3.0-only
// Tiny static server for the login-form corpus. Usage: node tests/pages/server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

export function serve(port = 8411) {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/favicon.ico') return res.writeHead(204).end();
    const f = path.join(dir, path.normalize(u.pathname === '/' ? '/stacked.html' : u.pathname));
    if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r, j) => {
    s.once('error', j);
    s.listen(port, '127.0.0.1', () => r(s));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8411);
  serve(port).then(() => console.log(`corpus on http://127.0.0.1:${port}`));
}
