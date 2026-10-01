/** Lokaler Server (auch Render, Fly.io, Docker): statische Dateien, API, WebSocket für sofortige Updates. */
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { getDb } from './db.js';
import { userFromToken } from './auth.js';
import { seedDemo } from './seed.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const wss = new WebSocketServer({ noServer: true });
function broadcast(type, data = {}) {
  const msg = JSON.stringify({ type, data, at: new Date().toISOString() });
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

const app = createApp({ onChange: broadcast });
app.use(express.static(path.join(moduleDir, '..', 'public'), { etag: true, maxAge: 0 }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(moduleDir, '..', 'public', 'index.html')));

const server = http.createServer(app);
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const user = await userFromToken(url.searchParams.get('token')).catch(() => null);
  if (!user) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });
});
setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 30000);

await getDb();
if (process.env.DEMO === '1' && await seedDemo()) console.log('Demodaten eingespielt. Anmeldung: Hans / demo, Grete / demo, Karl / demo');
server.listen(PORT, () => console.log(`RevierApp läuft auf http://localhost:${PORT}`));
