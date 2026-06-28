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
  stateful process; host on **Render** (free Web Service tier).

### Server → Render

A [`render.yaml`](render.yaml) Blueprint is included. Point Render at this repo and
it builds the `gaffer-compression-server` Web Service automatically. The server
binds to Render's `$PORT` and exposes a `/` health check. Note the public URL it
gets (e.g. `https://gaffer-compression-server.onrender.com`).

The free tier sleeps after ~15 min idle and cold-starts (~30–60s) on the next
connection. The client covers this with a loading/"waking" overlay and warms the
dyno with a fetch on load. Concurrent players are capped server-side by
`MAX_PLAYERS` (currently 8).

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
