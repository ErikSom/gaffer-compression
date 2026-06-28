# Deploying the game server on Oracle Cloud (Always Free)

The free Render tier (0.1 vCPU) can't simulate 4096 bodies at 40 Hz in real time.
Oracle Cloud's **Always Free** ARM tier gives a real, always-on VM (up to 4 OCPU /
24 GB, $0, never sleeps) that runs the full-scale sim comfortably.

This deploys: the Node game server + **Caddy** for automatic HTTPS/WSS, via Docker
Compose. The static client stays on Cloudflare Pages and points at this server.

**Why TLS is mandatory:** the client is served over HTTPS, so browsers only allow a
`wss://` (secure) WebSocket. A raw `ws://<ip>:8787` is blocked as mixed content.
Caddy gives you `wss://` for free — but it needs a **hostname**, not just the IP.

---

## 1. Create the VM

1. In the OCI Console: **Compute → Instances → Create Instance**.
2. **Image:** Ubuntu 22.04. **Shape:** `VM.Standard.A1.Flex` (Ampere ARM — the
   Always Free one). 2 OCPU / 12 GB is plenty and stays within the free allowance.
3. Add your SSH public key. Create.
4. Note the instance's **public IP**.

## 2. Open the firewall (two layers — both are required)

**a. OCI virtual firewall.** Networking → your VCN → the public subnet's **Security
List** (or the instance's NSG) → add **Ingress Rules**:

| Source CIDR | Protocol | Dest. port |
|-------------|----------|------------|
| `0.0.0.0/0` | TCP      | `80`       |
| `0.0.0.0/0` | TCP      | `443`      |

**b. The OS firewall.** Ubuntu OCI images ship iptables rules that block everything
except SSH. SSH in and run:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Point a hostname at the VM

Caddy needs a DNS name resolving to the public IP.

- **Have a domain?** Add an `A` record, e.g. `gaffer.yourdomain.com → <public IP>`.
- **No domain?** Use a free dynamic-DNS host like [DuckDNS](https://www.duckdns.org):
  create a subdomain (e.g. `yourname-gaffer.duckdns.org`) and set its IP to the VM's.

Confirm it resolves before continuing: `dig +short <your hostname>`.

## 4. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker $USER && newgrp docker   # run docker without sudo
```

## 5. Deploy

```bash
git clone <this repo> gaffer && cd gaffer

# Compose config — values from deploy/.env.example:
cp deploy/.env.example .env
nano .env          # set SITE_ADDRESS to your hostname, ACME_EMAIL to your email

docker compose up -d --build
```

Caddy fetches the TLS cert on first start (a few seconds). Verify:

```bash
curl https://<your hostname>/      # should print: ok
docker compose logs -f server      # should print steady "[f…] clients=… 40Hz up=… kbps"
```

If `curl` fails: check DNS resolves (step 3), both firewall layers are open
(step 2), and `docker compose logs caddy` for ACME errors.

## 6. Point the client at the new server

In **Cloudflare Pages → your project → Settings → Environment variables**, set:

```
VITE_WS_URL = wss://<your hostname>
```

Then trigger a redeploy (Deployments → Retry / push a commit). Done — the client now
talks to the Oracle server over `wss://`.

You can delete the Render service at this point; [`render.yaml`](../render.yaml)
stays in the repo as an alternative but isn't suitable for this workload on the free
tier.

---

## Operations

```bash
docker compose logs -f          # tail logs
docker compose pull && docker compose up -d --build   # update after a git pull
docker compose restart server   # restart just the game server
docker compose down             # stop everything
```

The server is stateless across restarts (the physics world rebuilds from
`sceneConfig.ts`), so restarts/updates just drop players for a moment.
