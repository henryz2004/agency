// server.js — zero-dependency HTTP server for Agency.
// Serves the static frontend and a single /api/state endpoint that fuses live
// running sessions with historical usage stats and stable agent identities.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUsage } from './lib/usage.js';
import { getLive } from './lib/live.js';
import { identityFor } from './lib/roster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4313;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function buildState() {
  const usage = getUsage();
  const live = getLive();

  // Attach a stable identity to each live agent.
  const agents = live.agents.map((a) => {
    const ident = identityFor(a.sessionId, a.model, a.startedAt);
    return { ...a, ...ident };
  });

  return {
    generatedAt: Date.now(),
    live: { agents, teams: live.teams, now: live.now },
    usage,
  };
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, urlPath));
  if (filePath !== PUBLIC && !filePath.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    if (req.url.split('?')[0] === '/api/state') {
      sendJSON(res, 200, buildState());
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    sendJSON(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, HOST, () => {
  // Warm the usage cache so the first request is fast.
  try {
    getUsage();
  } catch {
    /* ignore */
  }
  console.log(`\n  🏢  Agency is open for business.`);
  console.log(`      → http://${HOST}:${PORT}\n`);
});
