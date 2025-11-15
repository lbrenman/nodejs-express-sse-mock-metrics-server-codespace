// server.js
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

  const service = pickRandom(services);
  const region = pickRandom(regions);

  return {
    timestamp: new Date().toISOString(),
    service,
    region,
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
  const types = [
    'deploy',
    'autoscaling',
    'incident',
    'slowdown',
    'config-change',
    'recovery'
  ];

  const severity = pickRandom(severities);
  const type = pickRandom(types);

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

  const message = pickRandom(messagesByType[type]) || 'System notification';

  return {
    timestamp: new Date().toISOString(),
    severity,
    type,
    message
  };
}

// Serve static assets (dashboard HTML/CSS/JS)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.send(
    `<h1>SSE Metrics Server</h1>
    <p>Try connecting to <code>/sse/stream</code> with Postman or curl, or open <a href="/dashboard.html">/dashboard.html</a> in your browser.</p>
    <pre>
Env vars:
  PORT=${PORT}
  METRICS_INTERVAL_MS=${METRICS_INTERVAL_MS}
  NOTIFICATION_PROBABILITY=${NOTIFICATION_PROBABILITY}
  HEARTBEAT_INTERVAL_MS=${HEARTBEAT_INTERVAL_MS}
    </pre>`
  );
});

// Simple health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// SSE endpoint
app.get('/sse/stream', (req, res) => {
  // Set SSE-specific headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // flush headers explicitly (if supported)
  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const clientId = req.query.clientId || `client-${Date.now()}`;
  let eventId = 1;

  function sendEvent(eventType, payload) {
    res.write(`id: ${eventId++}\n`);
    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  // Initial "system-info" event so you see something immediately
  sendEvent('system-info', {
    message: 'Connected to live metrics stream',
    clientId,
    config: {
      metricsIntervalMs: METRICS_INTERVAL_MS,
      notificationProbability: NOTIFICATION_PROBABILITY,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
    }
  });

  // Periodic metrics + random notifications
  const metricsTimer = setInterval(() => {
    const metrics = generateMetrics();
    sendEvent('metric', metrics);

    if (Math.random() < NOTIFICATION_PROBABILITY) {
      const notification = generateNotification();
      sendEvent('notification', notification);
    }
  }, METRICS_INTERVAL_MS);

  // Heartbeat to keep idle connections alive
  const heartbeatTimer = setInterval(() => {
    sendEvent('heartbeat', { timestamp: new Date().toISOString() });
  }, HEARTBEAT_INTERVAL_MS);

  // Clean up when client disconnects
  req.on('close', () => {
    clearInterval(metricsTimer);
    clearInterval(heartbeatTimer);
    res.end();
  });
});

app.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
  console.log(`Metrics interval: ${METRICS_INTERVAL_MS} ms`);
  console.log(`Notification probability: ${NOTIFICATION_PROBABILITY}`);
  console.log(`Heartbeat interval: ${HEARTBEAT_INTERVAL_MS} ms`);
});
