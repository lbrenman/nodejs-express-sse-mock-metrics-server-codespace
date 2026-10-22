# Codespaces SSE Metrics Server

A tiny Node.js server that exposes a **Server-Sent Events (SSE)** stream and a simple **HTML dashboard** so you can demo “live system” behavior from GitHub Codespaces (or locally) and consume it from Postman, curl, or a browser.

It:

- Streams fake **system metrics** every _N_ milliseconds
- Occasionally sends random **notification** events
- Uses SSE **event types**, **IDs**, and **JSON** payloads
- Supports **`Last-Event-ID` resume**: one shared stream with global IDs and a replay buffer
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

  ![Imgur](https://imgur.com/76GR3DA.png)

3. **Get the Codespaces URL**

   Codespaces will expose port 3000 as something like:

   ```text
   https://YOUR-CODESPACE-NAME-3000.app.github.dev
   ```
  ![Imgur](https://imgur.com/xo4N9iY.png)

---

## Endpoints

- **Root**: `GET /`
  - Simple info page + current env config.
- **Health**: `GET /health`
  - Returns `{ "status": "ok", "time": "..." }`.
- **SSE stream**: `GET /sse/stream`
  - Main event stream (metrics, notifications, heartbeat, system-info).
  - Accepts a `Last-Event-ID` header (or `?lastEventId=N` query param) to replay missed events.
- **Stream status**: `GET /sse/status`
  - Current event ID, replay buffer range, and connected client count.
- **Last event**: `GET /sse/last`
  - Returns the most recent buffered event as plain JSON: `{ "id": 1873, "event": "metric", "data": { ... } }`.
  - Optional filters: `?event=notification` (event kind) and `?type=incident,slowdown` (matched against `data.type`).
  - Returns `404` with `{ "error": "not-found", ... }` if nothing in the buffer matches.
- **Kick clients**: `POST /sse/kick`
  - Server closes every SSE connection. Browser `EventSource` clients reconnect on their own and send `Last-Event-ID` automatically.
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

- `replay-gap`
  - Sent on connect when a resume can't be fully satisfied: the requested ID is older than the replay buffer (`buffer-exceeded`, with `lostCount`) or newer than anything the server has issued, usually because the server restarted (`unknown-id`).

Each data event (`metric`, `notification`) is delivered in standard SSE format:

```text
id: 42
event: metric
data: {"timestamp":"...","service":"api-gateway", ...}

```

Control events (`system-info`, `heartbeat`, `replay-gap`) are sent **without** an `id:` line, so they never move the client's last-event-ID cursor and are never replayed.

---

## Event IDs & Resuming with `Last-Event-ID`

All clients share **one stream**: a single generator publishes events to every connected client, and event IDs come from **one global counter** that keeps climbing whether anyone is connected or not. A new connection therefore sees IDs like `1873`, `1874`, … not `1`.

The server keeps the most recent `REPLAY_BUFFER_SIZE` events in memory. When a client connects with a last-seen ID, the server:

1. Sends `system-info` with `resume.requestedLastEventId` and `resume.replayedCount`
2. Sends a `replay-gap` event if some events can't be recovered
3. Replays every buffered event with an ID greater than the requested one, with its **original** ID
4. Continues with live events

The ID is read from the `Last-Event-ID` request header first, then from the `lastEventId` query parameter.

> The buffer is in memory, so a server restart resets the counter to 1 and empties the buffer. A client that resumes with an ID from before the restart gets a `replay-gap` with reason `unknown-id`.

### Try it with curl

```bash
# 1. Connect, note an id, then Ctrl+C
curl -N https://YOUR-CODESPACE-NAME-3000.app.github.dev/sse/stream

# 2. Wait a few seconds, then resume — events after that id replay immediately
curl -N -H "Last-Event-ID: 42" https://YOUR-CODESPACE-NAME-3000.app.github.dev/sse/stream

# 3. Inspect what's in the buffer
curl https://YOUR-CODESPACE-NAME-3000.app.github.dev/sse/status

# 4. Fetch the most recent event (or the most recent incident notification)
curl https://YOUR-CODESPACE-NAME-3000.app.github.dev/sse/last
curl "https://YOUR-CODESPACE-NAME-3000.app.github.dev/sse/last?event=notification&type=incident"
```

### Try it with Postman

1. Run **SSE Metrics Stream**, note the last `id`, then cancel the request.
2. Wait a few seconds.
3. On the **Headers** tab add `Last-Event-ID` with that value and send again.
4. The first events you get are the ones you missed, followed by live ones.

### How browsers do it

`EventSource` remembers the last `id:` it received. If the connection drops (network blip, or the server ends the response), it waits `retry` ms (the server sends `retry: CLIENT_RETRY_MS`) and reconnects **with the `Last-Event-ID` header set automatically**. A brand-new `EventSource` (page reload, or creating a new one in code) starts with no ID, and `EventSource` cannot set custom headers, so manual resumes pass `?lastEventId=` instead.

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

- `REPLAY_BUFFER_SIZE`  
  Number of recent `metric` / `notification` events kept for `Last-Event-ID` replay.  
  Default: `500` (about 15 minutes at the default 2s interval)

- `CLIENT_RETRY_MS`  
  Reconnect delay sent to clients as the SSE `retry:` field.  
  Default: `3000`

Example (in Codespaces terminal):

```bash
export METRICS_INTERVAL_MS=1000
export NOTIFICATION_PROBABILITY=0.4
export HEARTBEAT_INTERVAL_MS=10000
export REPLAY_BUFFER_SIZE=200
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
  - A scrollable **event log** showing each event's SSE **ID** (replayed events in blue, gaps in red)
  - The **last event ID** received
  - Connection **status** + last **heartbeat** time
- Has buttons for experimenting with resume:
  - **Drop** — close the connection client-side (the server keeps generating events)
  - **Resume** — reconnect with `?lastEventId=<last id>` and replay what was missed
  - **Fresh** — reconnect with no ID (live events only)
  - **Server kick** — calls `POST /sse/kick`; the browser reconnects by itself and sends the `Last-Event-ID` header natively

To use:

```text
https://YOUR-CODESPACE-NAME-3000.app.github.dev/dashboard.html
```

Open it in your browser and watch the events roll in.

![Imgur](https://imgur.com/EGqhMv3.png)

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

![Imgur](https://imgur.com/EQWLt27.png)

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
