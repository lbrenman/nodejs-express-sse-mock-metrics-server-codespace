// server.js
//
// SSE mock metrics server with proper Last-Event-ID resume support.
//
// Key design points:
//  - ONE shared event stream for all clients (a global generator broadcasts to every
//    connected client), so "missed events" is a meaningful concept.
//  - ONE global, monotonically increasing event ID counter (not per connection).
//  - A ring buffer of recent events. When a client (re)connects with a
//    `Last-Event-ID` header (or `?lastEventId=` query param), every buffered event
//    with an ID greater than that value is replayed before live events resume.
//  - `system-info`, `replay-gap` and `heartbeat` events are per-connection control
//    messages and are sent WITHOUT an `id:` line, so they never move the client's
//    last-event-ID cursor and are never replayed.

const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// How often to send metric events (ms)
const METRICS_INTERVAL_MS = parseInt(process.env.METRICS_INTERVAL_MS || '2000', 10);

// Probability (0.0–1.0) that a notification event will be sent each metrics tick
const NOTIFICATION_PROBABILITY = parseFloat(process.env.NOTIFICATION_PROBABILITY || '0.25');

// How often to send a heartbeat event (ms) so idle connections stay alive
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || '15000', 10);

// How many recent events to keep for replay on reconnect
const REPLAY_BUFFER_SIZE = parseInt(process.env.REPLAY_BUFFER_SIZE || '500', 10);

// Reconnect delay suggested to EventSource clients (ms), sent as `retry:`
const CLIENT_RETRY_MS = parseInt(process.env.CLIENT_RETRY_MS || '3000', 10);

// ---------------------------------------------------------------------------
// Fake data generators
// ---------------------------------------------------------------------------

function randFloat(min, max, decimals = 2) {
  const val = Math.random() * (max - min) + min;
  return parseFloat(val.toFixed(decimals));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(list) {
  return list[randInt(0, list.length - 1)];
}

function generateMetrics() {
  const services = ['api-gateway', 'payments', 'users', 'orders', 'notifications'];
  const regions = ['us-east-1', 'us-west-2', 'eu-central-1'];

  return {
    timestamp: new Date().toISOString(),
    service: pickRandom(services),
    region: pickRandom(regions),
    metrics: {
      cpuPercent: randFloat(5, 95),
      memoryPercent: randFloat(20, 95),
      requestRatePerSec: randInt(50, 600),
      errorRatePerSec: randFloat(0, 10),
      latencyMsP95: randInt(40, 700)
    }
  };
}

function generateNotification() {
  const severities = ['info', 'warning', 'critical'];
  const types = ['deploy', 'autoscaling', 'incident', 'slowdown', 'config-change', 'recovery'];

  const messagesByType = {
    deploy: [
      'New backend release rolled out to 10% of traffic',
      'Canary deployment succeeded in us-east-1',
      'Rolling restart initiated for api-gateway'
    ],
    autoscaling: [
      'Autoscaling group added 3 new instances',
      'Scaled down 2 nodes due to low load',
      'Burst capacity enabled for payments service'
    ],
    incident: [
      'Elevated 500 errors detected on orders service',
      'Partial outage in eu-central-1',
      'Third-party dependency latency is spiking'
    ],
    slowdown: [
      'p95 latency above SLO for users service',
      'Cache hit rate is dropping',
      'Database write queue is growing'
    ],
    'config-change': [
      'Feature flag "new-checkout" enabled for 5% of users',
      'Rate limit for /v1/checkout increased',
      'Log level raised to DEBUG for notifications service'
    ],
    recovery: [
      'All regions are healthy again',
      'Error rate returned to baseline',
      'Backlog has been drained'
    ]
  };

  const type = pickRandom(types);
  return {
    timestamp: new Date().toISOString(),
    severity: pickRandom(severities),
    type,
    message: pickRandom(messagesByType[type]) || 'System notification'
  };
}

// ---------------------------------------------------------------------------
// Shared event stream: global ID counter, replay buffer, connected clients
// ---------------------------------------------------------------------------

let lastIssuedId = 0;          // last ID handed out; next event gets lastIssuedId + 1
const eventBuffer = [];        // [{ id, event, data }] oldest → newest
const clients = new Set();     // Set<{ id, res }>

function formatEvent({ id, event, data }) {
  let out = '';
  if (id !== undefined) out += `id: ${id}\n`;
  out += `event: ${event}\n`;
  out += `data: ${JSON.stringify(data)}\n\n`;
  return out;
}

// Publish an event to every client and remember it for replay
function publish(event, data) {
  const entry = { id: ++lastIssuedId, event, data };
  eventBuffer.push(entry);
  if (eventBuffer.length > REPLAY_BUFFER_SIZE) eventBuffer.shift();

  const chunk = formatEvent(entry);
  for (const client of clients) client.res.write(chunk);
}

// Send a control message to one client (no id → not replayable, doesn't move the cursor)
function sendControl(res, event, data) {
  res.write(formatEvent({ event, data }));
}

// Global generator: runs whether or not anyone is connected, so a disconnected
// client genuinely misses events and can recover them via Last-Event-ID.
setInterval(() => {
  publish('metric', generateMetrics());
  if (Math.random() < NOTIFICATION_PROBABILITY) {
    publish('notification', generateNotification());
  }
}, METRICS_INTERVAL_MS);

// Heartbeats are per-connection control messages (no id)
setInterval(() => {
  const payload = { timestamp: new Date().toISOString(), currentEventId: lastIssuedId };
  for (const client of clients) sendControl(client.res, 'heartbeat', payload);
}, HEARTBEAT_INTERVAL_MS);

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send(
    `<h1>SSE Metrics Server</h1>
    <p>Try connecting to <code>/sse/stream</code> with Postman or curl, or open <a href="/dashboard.html">/dashboard.html</a> in your browser.</p>
    <p>Resume after a disconnect by sending a <code>Last-Event-ID</code> header (or <code>?lastEventId=N</code>). Buffer state: <a href="/sse/status">/sse/status</a></p>
    <pre>
Env vars:
  PORT=${PORT}
  METRICS_INTERVAL_MS=${METRICS_INTERVAL_MS}
  NOTIFICATION_PROBABILITY=${NOTIFICATION_PROBABILITY}
  HEARTBEAT_INTERVAL_MS=${HEARTBEAT_INTERVAL_MS}
  REPLAY_BUFFER_SIZE=${REPLAY_BUFFER_SIZE}
  CLIENT_RETRY_MS=${CLIENT_RETRY_MS}
    </pre>`
  );
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Inspect the replay buffer — handy when experimenting with Last-Event-ID
app.get('/sse/status', (req, res) => {
  res.json({
    currentEventId: lastIssuedId,
    bufferSize: eventBuffer.length,
    bufferCapacity: REPLAY_BUFFER_SIZE,
    oldestBufferedId: eventBuffer.length ? eventBuffer[0].id : null,
    newestBufferedId: eventBuffer.length ? eventBuffer[eventBuffer.length - 1].id : null,
    connectedClients: clients.size
  });
});

// Server-side drop of every connection. Browser EventSource clients will auto-reconnect
// after `retry` ms and automatically send the Last-Event-ID header — the native way
// to see resume working without writing any client code.
app.post('/sse/kick', (req, res) => {
  const count = clients.size;
  for (const client of clients) client.res.end();
  clients.clear();
  console.log(`[kick] closed ${count} connection(s)`);
  res.json({ kicked: count, currentEventId: lastIssuedId });
});

// CORS preflight: Last-Event-ID is not a CORS-safelisted header, so a cross-origin
// client that sets it will send an OPTIONS request first.
app.options('/sse/stream', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Last-Event-ID, Cache-Control, Content-Type'
  });
  res.sendStatus(204);
});

// Parse the resume cursor from the header (standard) or query string (fallback for
// clients that can't set headers, e.g. a manually created browser EventSource)
function parseLastEventId(req) {
  const raw = req.get('Last-Event-ID') ?? req.query.lastEventId;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

app.get('/sse/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();

  // Tell EventSource how long to wait before reconnecting
  res.write(`retry: ${CLIENT_RETRY_MS}\n\n`);

  const clientId = req.query.clientId || `client-${Date.now()}`;
  const lastEventId = parseLastEventId(req);

  // Work out what to replay
  let replay = [];
  let gap = null;
  if (lastEventId !== null) {
    replay = eventBuffer.filter((e) => e.id > lastEventId);
    const oldest = eventBuffer.length ? eventBuffer[0].id : lastIssuedId + 1;
    if (lastEventId > lastIssuedId) {
      gap = {
        reason: 'unknown-id',
        message: 'Last-Event-ID is ahead of the server (server probably restarted). Resuming live only.',
        requestedLastEventId: lastEventId,
        currentEventId: lastIssuedId
      };
    } else if (oldest > lastEventId + 1) {
      gap = {
        reason: 'buffer-exceeded',
        message: 'Some events were older than the replay buffer and are lost.',
        requestedLastEventId: lastEventId,
        firstAvailableId: oldest,
        lostCount: oldest - lastEventId - 1
      };
    }
  }

  sendControl(res, 'system-info', {
    message: 'Connected to live metrics stream',
    clientId,
    currentEventId: lastIssuedId,
    resume: {
      requestedLastEventId: lastEventId,
      replayedCount: replay.length
    },
    config: {
      metricsIntervalMs: METRICS_INTERVAL_MS,
      notificationProbability: NOTIFICATION_PROBABILITY,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      replayBufferSize: REPLAY_BUFFER_SIZE
    }
  });

  if (gap) sendControl(res, 'replay-gap', gap);

  // Replay missed events with their ORIGINAL ids, then join the live broadcast.
  // (Node is single-threaded, so no live event can slip in between these steps.)
  for (const entry of replay) res.write(formatEvent(entry));

  const client = { id: clientId, res };
  clients.add(client);
  console.log(
    `[connect] ${clientId} lastEventId=${lastEventId ?? '-'} replayed=${replay.length} clients=${clients.size}`
  );

  req.on('close', () => {
    clients.delete(client);
    console.log(`[disconnect] ${clientId} clients=${clients.size}`);
    res.end();
  });
});

app.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
  console.log(`Metrics interval: ${METRICS_INTERVAL_MS} ms`);
  console.log(`Notification probability: ${NOTIFICATION_PROBABILITY}`);
  console.log(`Heartbeat interval: ${HEARTBEAT_INTERVAL_MS} ms`);
  console.log(`Replay buffer size: ${REPLAY_BUFFER_SIZE}`);
});
