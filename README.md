# Codespaces SSE Metrics Server

A tiny Node.js server that exposes a **Server-Sent Events (SSE)** stream and a simple **HTML dashboard** so you can demo “live system” behavior from GitHub Codespaces (or locally) and consume it from Postman, curl, or a browser.

It:

- Streams fake **system metrics** every _N_ milliseconds
- Occasionally sends random **notification** events
- Uses SSE **event types**, **IDs**, and **JSON** payloads
- Has configurable timing & randomness via **environment variables**
- Serves a **browser dashboard** at `/dashboard.html`
- Includes a **Postman collection** pointing at the SSE endpoint

---

## Quick Start (GitHub Codespaces)

1. **Open the repo in Codespaces**

   The `.devcontainer/devcontainer.json` uses the Node devcontainer image and runs:

   ```bash
   npm install
   ```

   automatically after the container is created.

2. **Start the server**

   In the Codespaces terminal:

   ```bash
   npm start
   ```

   By default it listens on port **3000**.

3. **Get the Codespaces URL**

   Codespaces will expose port 3000 as something like:

   ```text
   https://YOUR-CODESPACE-NAME-3000.app.github.dev
   ```

---

## Endpoints

- **Root**: `GET /`
  - Simple info page + current env config.
- **Health**: `GET /health`
  - Returns `{ "status": "ok", "time": "..." }`.
- **SSE stream**: `GET /sse/stream`
  - Main event stream (metrics, notifications, heartbeat, system-info).
- **Dashboard**: `GET /dashboard.html`
  - Tiny HTML dashboard that consumes `/sse/stream` with `EventSource`.

---

## SSE Event Types & Payloads

The SSE endpoint uses **named events** and **IDs**:

- `system-info`
  - Sent once per connection when the client first connects.
  - Example:

    ```json
    {
      "message": "Connected to live metrics stream",
      "clientId": "client-...",
      "config": {
        "metricsIntervalMs": 2000,
        "notificationProbability": 0.25,
        "heartbeatIntervalMs": 15000
      }
    }
    ```

- `metric`
  - Sent periodically (every `METRICS_INTERVAL_MS`).
  - Example:

    ```json
    {
      "timestamp": "2025-01-01T12:00:00.000Z",
      "service": "api-gateway",
      "region": "us-east-1",
      "metrics": {
        "cpuPercent": 63.4,
        "memoryPercent": 76.1,
        "requestRatePerSec": 310,
        "errorRatePerSec": 0.8,
        "latencyMsP95": 220
      }
    }
    ```

- `notification`
  - Sent randomly based on `NOTIFICATION_PROBABILITY` each metrics tick.
  - Example:

    ```json
    {
      "timestamp": "2025-01-01T12:00:05.000Z",
      "severity": "warning",
      "type": "deploy",
      "message": "Canary deployment succeeded in us-east-1"
    }
    ```

- `heartbeat`
  - Sent every `HEARTBEAT_INTERVAL_MS`.
  - Example:

    ```json
    {
      "timestamp": "2025-01-01T12:00:10.000Z"
    }
    ```

Each event is delivered in standard SSE format:

```text
id: 42
event: metric
data: {"timestamp":"...","service":"api-gateway", ...}

```

---

## Configuration (Environment Variables)

All knobs are environment variables (with sane defaults):

- `PORT`  
  Default: `3000`

- `METRICS_INTERVAL_MS`  
  Interval between `metric` events (in milliseconds).  
  Default: `2000`

- `NOTIFICATION_PROBABILITY`  
  Probability (0.0–1.0) that a `notification` event will be sent on each metrics tick.  
  Default: `0.25`

- `HEARTBEAT_INTERVAL_MS`  
  Interval between `heartbeat` events (in milliseconds).  
  Default: `15000`

Example (in Codespaces terminal):

```bash
export METRICS_INTERVAL_MS=1000
export NOTIFICATION_PROBABILITY=0.4
export HEARTBEAT_INTERVAL_MS=10000
export PORT=3000
npm start
```

---

## Dashboard (`/dashboard.html`)

The `public/dashboard.html` page is a self-contained dashboard that:

- Connects to `/sse/stream` using `EventSource`
- Displays:
  - Current **service** & **region**
  - **CPU** & **memory** utilization with horizontal bars
  - **Request** & **error** rate numbers
  - Live **notifications** with severity chips (`info`, `warning`, `critical`)
  - A scrollable **metrics log**
  - Connection **status** + last **heartbeat** time

To use:

```text
https://YOUR-CODESPACE-NAME-3000.app.github.dev/dashboard.html
```

Open it in your browser and watch the events roll in.

---

## Using Postman

This repo includes `postman-sse-collection.json`.

1. Open Postman → **Import** → choose `postman-sse-collection.json`.
2. Open the collection → **Variables**.
3. Update the `codespace_sse_url` variable to your real SSE URL, for example:

   ```text
   https://YOUR-CODESPACE-NAME-3000.app.github.dev/sse/stream
   ```

4. Run the **SSE Metrics Stream** request.
5. Leave the tab open to watch raw SSE events.

---

## Using curl

If you want to quickly test from the command line:

```bash
curl -N https://YOUR-CODESPACE-NAME-3000.app.github.dev/sse/stream
```

The `-N` flag disables curl’s buffering so you see the live stream.

---

## Running Locally (Optional)

You can also run this outside Codespaces:

```bash
npm install
npm start
```

Then hit:

- `http://localhost:3000/`
- `http://localhost:3000/dashboard.html`
- `http://localhost:3000/sse/stream`
