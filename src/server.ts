import http, { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { z } from 'zod';
import { clearTestEvents, getKalshiConfig, getTestEvents, handleKalshiTrigger, updateKalshiConfig } from './kalshi.js';

dotenv.config();

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const HEARTBEAT_MS = 15000;

type Role = 'control' | 'display';
type Side = 'home' | 'away' | 'cancel';

const inboundSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('register'),
    role: z.union([z.literal('control'), z.literal('display')])
  }),
  z.object({
    type: z.literal('trigger'),
    side: z.union([z.literal('home'), z.literal('away'), z.literal('cancel')])
  }),
  z.object({
    type: z.literal('ping')
  })
]);

type InboundMessage = z.infer<typeof inboundSchema>;

interface ClientRecord {
  id: string;
  ws: WebSocket;
  role?: Role;
  isAlive: boolean;
}

const clients = new Map<WebSocket, ClientRecord>();

const kalshiConfigPayload = z.object({
  enabled: z.coerce.boolean().optional(),
  moneylineEnabled: z.coerce.boolean().optional(),
  spreadEnabled: z.coerce.boolean().optional(),
  league: z.string().max(32).optional(),
  homeTeam: z.string().max(120).optional(),
  awayTeam: z.string().max(120).optional(),
  homeCode: z.string().max(32).optional(),
  awayCode: z.string().max(32).optional(),
  betUnitSize: z.coerce.number().int().min(1).optional(),
  testMode: z.coerce.boolean().optional()
});

const httpServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/health') {
    res.writeHead(200, defaultJsonHeaders());
    res.end(JSON.stringify({ ok: true, connections: clients.size }));
    return;
  }

  if (url.pathname.startsWith('/config/kalshi')) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/config/kalshi') {
      res.writeHead(200, defaultJsonHeaders());
      res.end(JSON.stringify(getKalshiConfig()));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/config/kalshi/test') {
      res.writeHead(200, defaultJsonHeaders());
      res.end(JSON.stringify({ events: getTestEvents() }));
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/config/kalshi/test') {
      clearTestEvents();
      res.writeHead(204, defaultJsonHeaders());
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/config/kalshi') {
      try {
        const body = await readJsonBody(req);
        const parsed = kalshiConfigPayload.parse(body);
        const next = updateKalshiConfig(parsed);
        res.writeHead(200, defaultJsonHeaders());
        res.end(JSON.stringify(next));
        return;
      } catch (error) {
        res.writeHead(400, defaultJsonHeaders());
        res.end(JSON.stringify({ error: (error as Error).message }));
        return;
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Jester realtime server\n');
});

const wss = new WebSocketServer({ server: httpServer });

const log = (...args: unknown[]) => {
  console.log(new Date().toISOString(), '-', ...args);
};

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const client: ClientRecord = {
    id: crypto.randomUUID(),
    ws,
    isAlive: true
  };
  clients.set(ws, client);

  log('Client connected', client.id, req.socket.remoteAddress);

  const send = (message: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  send({ type: 'welcome', id: client.id });

  ws.on('pong', () => {
    const c = clients.get(ws);
    if (c) {
      c.isAlive = true;
    }
  });

  ws.on('message', (buffer: RawData) => {
    void (async () => {
      let parsed: InboundMessage;

      try {
        parsed = inboundSchema.parse(JSON.parse(buffer.toString()));
      } catch (err) {
        log('Invalid payload from', client.id, err);
        send({ type: 'error', message: 'invalid-payload' });
        return;
      }

      if (parsed.type === 'ping') {
        send({ type: 'pong', at: Date.now() });
        return;
      }

      if (parsed.type === 'register') {
        client.role = parsed.role;
        send({
          type: 'registered',
          role: client.role,
          displayCount: countByRole('display'),
          controlCount: countByRole('control')
        });
        broadcastCounts();
        return;
      }

      if (!client.role) {
        send({ type: 'error', message: 'role-not-registered' });
        return;
      }

      if (parsed.type === 'trigger') {
        if (client.role !== 'control') {
          send({ type: 'error', message: 'not-authorized' });
          return;
        }

        const payload = {
          type: 'flash',
          side: parsed.side,
          at: Date.now(),
          by: client.id
        };
        broadcast(payload, (target) => target.role === 'display');
        send({ type: 'ack', at: payload.at });

        if (parsed.side !== 'cancel') {
          handleKalshiTrigger(parsed.side, log).catch((error) => {
            log('Kalshi integration error', error);
          });
        }
      }
    })();
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (client.role) {
      broadcastCounts();
    }
    log('Client disconnected', client.id);
  });

  ws.on('error', (err: Error) => {
    log('Client error', client.id, err);
  });
});

function countByRole(role: Role) {
  let count = 0;
  for (const record of clients.values()) {
    if (record.role === role) {
      count += 1;
    }
  }
  return count;
}

function broadcast(payload: unknown, filter?: (client: ClientRecord) => boolean) {
  const json = JSON.stringify(payload);
  for (const client of clients.values()) {
    if (client.ws.readyState !== WebSocket.OPEN) {
      continue;
    }
    if (filter && !filter(client)) {
      continue;
    }
    client.ws.send(json);
  }
}

function broadcastCounts() {
  broadcast({
    type: 'status',
    controlCount: countByRole('control'),
    displayCount: countByRole('display')
  });
}

const heartbeat = setInterval(() => {
  for (const record of clients.values()) {
    if (!record.isAlive) {
      log('Terminating stale connection', record.id);
      record.ws.terminate();
      clients.delete(record.ws);
      continue;
    }

    record.isAlive = false;
    record.ws.ping();
  }
}, HEARTBEAT_MS);

heartbeat.unref();

httpServer.listen(PORT, HOST, () => {
  log(`Realtime server listening on http://${HOST}:${PORT}`);
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function defaultJsonHeaders() {
  return {
    ...corsHeaders(),
    'Content-Type': 'application/json'
  };
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8') || '{}';
  return JSON.parse(raw);
}
