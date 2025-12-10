import http, { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const HEARTBEAT_MS = 15000;

type Role = 'control' | 'display';
type Side = 'home' | 'away';

const inboundSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('register'),
    role: z.union([z.literal('control'), z.literal('display')])
  }),
  z.object({
    type: z.literal('trigger'),
    side: z.union([z.literal('home'), z.literal('away')])
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

const httpServer = http.createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, connections: clients.size }));
    return;
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
    }
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
