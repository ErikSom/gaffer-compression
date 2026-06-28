# Snapshot Compression Implementation in JavaScript

This repository contains a JavaScript implementation of the concepts discussed in the article ["Snapshot Compression"](https://gafferongames.com/post/snapshot_compression/) by Gaffer On Games. This project aims to provide a practical example of how snapshot compression can be achieved in JavaScript, particularly useful for game development and networked applications.

## Installation

Use NPM to install all the necessary dependencies to run the tests.

```bash
npm install
```

## Running the Tests

To ensure that everything is set up correctly and to see how the library works, you can run the provided tests:

```bash
npm run test
```

## Deploying

The app splits into two independently-hosted pieces:

- **Static client** (the Vite build) — host anywhere free, e.g. **Cloudflare Pages**.
- **Game server** (authoritative WebSocket + physics loop) — a single always-on
  stateful process whose baseline cost is set by the box count (4096 bodies at
  40 Hz), independent of player count.

### Server → Oracle Cloud Free (recommended)

The server CPU cost is real and constant. A weak free instance (e.g. Render free's
0.1 vCPU) can't step 4096 bodies at 40 Hz in real time, so the snapshot stream
collapses and play stutters. **Oracle Cloud's Always Free ARM tier** gives a real,
always-on VM that runs the full sim at $0.

See **[deploy/oracle-cloud.md](deploy/oracle-cloud.md)** for the full walkthrough
(VM, firewall, DNS, Docker Compose with Caddy for automatic HTTPS/WSS). The included
[`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml), and
[`Caddyfile`](Caddyfile) deploy the server + TLS in one `docker compose up`.

Concurrent players are capped server-side by `MAX_PLAYERS` (currently 8).

### Server → fly.io (easiest, paid)

Fly runs the [`Dockerfile`](Dockerfile) directly, terminates TLS at its edge, and
gives a `wss://<app>.fly.dev` hostname — no DNS, firewall, or Caddy to configure.
It needs a **dedicated**-CPU machine (`performance-1x`), which is paid (~$0.04/hr,
idling to ~$0 when empty via autostop). See **[deploy/fly.md](deploy/fly.md)**.
Config is in [`fly.toml`](fly.toml). Keep it to a single machine — it's one shared
world.

### Server → Render (free, but limited)

A [`render.yaml`](render.yaml) Blueprint is also included. It's the simplest deploy
(point Render at the repo and it builds the Web Service automatically, binding `$PORT`
with a `/` health check), but the free tier's CPU is too weak for the full-scale
sim — use it only with a much smaller `DYNAMIC_COUNT`, or on a paid plan. The free
tier also sleeps after ~15 min idle and cold-starts (~30–60s); the client covers
that with a loading/"waking" overlay and warms the dyno with a fetch on load.

### Client → Cloudflare Pages

- Build command: `npm run build:client`
- Output directory: `dist/client`
- Environment variable: set **`VITE_WS_URL`** to the Render server's WebSocket URL,
  using the `wss://` scheme — e.g. `wss://gaffer-compression-server.onrender.com`
  (see [`.env.example`](.env.example)).

Without `VITE_WS_URL` the client falls back to a same-origin `/ws` proxy, which is
how local dev (`npm run dev`) and a single ngrok tunnel work.

## Acknowledgements

- Thanks to [Gaffer On Games](https://gafferongames.com/) for the original article and concepts behind this implementation.
