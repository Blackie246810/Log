import http from 'node:http';
import { pingDatabase } from './db.js';
import { reportError } from './errorReporter.js';
import { getKeyPoolStatus } from './ai/gemini.js';

const DB_PING_ENABLED = process.env.HEALTH_CHECK_DB !== 'false';

export function startHealthServer(client, port) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'not_found' }));
      return;
    }

    const geminiKeys = getKeyPoolStatus();

    if (!DB_PING_ENABLED) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', database: 'skipped', geminiKeys, timestamp: new Date().toISOString() }));
      return;
    }

    try {
      await pingDatabase();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', database: 'up', geminiKeys, timestamp: new Date().toISOString() }));
    } catch (err) {
      await reportError(client, 'health-check', err);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', database: 'down', geminiKeys }));
    }
  });

  server.listen(port, '0.0.0.0' , () => {
    console.log(`Health server listening on port ${port} (GET /health)`);
  });

  return server;
}