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

    // client.isReady() reflects whether the Discord gateway connection is up.
    // The health server itself starts before login finishes, so this can
    // legitimately be false for a few seconds right after boot without the
    // process being unhealthy.
    const discord = client.isReady() ? 'up' : 'connecting';
    const geminiKeys = getKeyPoolStatus();

    if (!DB_PING_ENABLED) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', discord, database: 'skipped', geminiKeys, timestamp: new Date().toISOString() }));
      return;
    }

    try {
      await pingDatabase();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', discord, database: 'up', geminiKeys, timestamp: new Date().toISOString() }));
    } catch (err) {
      if (client.isReady()) {
        await reportError(client, 'health-check', err);
      } else {
        console.error('[health-check] db ping failed and Discord is not ready yet:', err);
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', discord, database: 'down', geminiKeys }));
    }
  });

  server.listen(port, '0.0.0.0' , () => {
    console.log(`Health server listening on port ${port} (GET /health)`);
  });

  return server;
}