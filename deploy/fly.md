# Deploying the game server on fly.io

Fly runs the [Dockerfile](../Dockerfile) directly, terminates TLS at its edge, and
gives you a `wss://<app>.fly.dev` hostname — no Caddy, DNS, or firewall config
needed (unlike the Oracle/VPS route). The catch: it needs a **dedicated**-CPU
machine (`performance-1x`), which is paid — a shared machine would be throttled by
the same continuous-load problem that sank the Render free tier.

**Cost:** `performance-1x` is ~$0.04/hr while running. With `auto_stop_machines`
(set in [fly.toml](../fly.toml)) it idles to ~$0 when no one's connected and wakes
on the next connection — so a bursty hobby demo costs little. Fly requires a card on
file regardless.

---

## 1. Install flyctl and sign in

```bash
curl -L https://fly.io/install.sh | sh   # or: brew install flyctl
fly auth signup                          # or: fly auth login
```

## 2. Create the app

The app name in [fly.toml](../fly.toml) (`gaffer-compression-server`) must be
globally unique. Pick your own and keep it in sync:

```bash
# from the repo root
fly apps create your-unique-name
# then edit fly.toml: set  app = "your-unique-name"
```

## 3. Deploy

```bash
fly deploy
```

This builds the Dockerfile, boots the machine, and provisions TLS for
`https://your-unique-name.fly.dev`.

## 4. Pin to a single machine

This is a single-shared-world server — every player must hit the *same* process.
Make sure exactly one machine exists:

```bash
fly scale count 1
fly status            # confirm: 1 machine
```

(Never run 2+ — each would simulate its own divergent world and split players.)

## 5. Verify

```bash
curl https://your-unique-name.fly.dev/      # should print: ok
fly logs                                    # steady "[f…] clients=… 40Hz up=… kbps"
```

## 6. Point the client at it

In **Cloudflare Pages → your project → Settings → Environment variables**:

```
VITE_WS_URL = wss://your-unique-name.fly.dev
```

Trigger a redeploy. Done — the client now talks to fly over `wss://`.

---

## Operations

```bash
fly deploy                 # ship changes (re-run after a git pull / edit)
fly logs                   # tail logs
fly status                 # machine state (running/stopped)
fly machine restart <id>   # restart the server
fly scale vm performance-2x   # bump to 2 dedicated vCPUs if you raise box count
```

### Always-on (no cold start)

Cold starts are only a few seconds and the client's loading overlay covers them. If
you'd rather never cold-start, edit [fly.toml](../fly.toml):

```toml
  min_machines_running = 1
```

and `fly deploy`. This keeps the machine running 24/7 (~$30/mo for performance-1x).
