# onchain-pay

A self-hosted cryptocurrency payment gateway supporting **BTC, LTC, and XMR** — no Stripe, no CoinPayments, no custodian. Every deposit is tracked directly on-chain.

Users sign up with a username and password, back up a BIP39 mnemonic, deposit any supported coin, and accumulate a balance. No email, no KYC.

Everything runs inside a local **k3d** (Kubernetes-in-Docker) cluster that simulates a 3-node VPS topology. Zero cloud accounts required.

---

## What's non-trivial here

- **Direct blockchain integration** — BTC and LTC addresses are derived from an xpub using BIP84 (native SegWit). [NBXplorer](https://github.com/dgarage/NBXplorer) indexes the chain and pushes events via long-poll; the API processes `newtransaction` and `newblock` events to track confirmations in real time. No wrapped API, no webhook service.
- **Monero subaddresses** — each invoice gets a fresh subaddress from `monero-wallet-rpc`. Incoming transfers are detected via `get_transfers` (including mempool), confirmed at 10 blocks. XMR daemon connects to remote onion nodes through Tor with automatic failover.
- **Invoice lifecycle** — 30-minute TTL enforced by a cron job; one active invoice per user per currency; overpayments credited in full; underpayments flagged with the shortfall shown in the UI.
- **Privacy by default** — CoinGecko price fetches routed through Tor; XMR daemon traffic never leaves Tor; no third-party payment processor receives transaction data.
- **Production-grade auth** — JWT in an `httpOnly` cookie; BIP39 mnemonic recovery flow with a write-then-verify challenge; rate limiting (global 120 req/min, auth 10 req/15 min); stale unconfirmed accounts auto-deleted after 24 h.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
└─────────────────────┬────────────────────────────────────────────┘
                      │ HTTP :8080
         ┌────────────▼────────────┐
         │  Traefik Ingress (k3d)  │  ← gateway node
         └──────┬──────────┬───────┘
                │          │
   ┌────────────▼──┐   ┌───▼─────────────┐
   │  Astro (web)  │   │  NestJS (api)   │  ← web / api nodes
   │  SSR, Node    │   │  REST + Prisma  │
   └───────────────┘   └──────┬──────────┘
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
 ┌──────▼──────┐   ┌──────────▼───────┐   ┌─────────▼────────┐
 │  PostgreSQL │   │      Redis       │   │   NBXplorer      │
 │  (Prisma)   │   │  (price cache)   │   │  BTC + LTC index │
 └─────────────┘   └──────────────────┘   └──────┬───────────┘
                                                  │
                                     ┌────────────▼───────────┐
                                     │  bitcoind   litecoind  │
                                     │  (pruned mainnet)      │
                                     └────────────────────────┘
        ┌─────────────────────────────────────────────────────┐
        │  monero-wallet-rpc  →  Tor  →  remote onion monerod │
        └─────────────────────────────────────────────────────┘
```

**Nodes (simulated VPS servers)**

| k3d node | role label | workloads |
|---|---|---|
| `k3d-crypto-server-0` | `gateway` | Traefik ingress |
| `k3d-crypto-agent-0` | `web` | Astro SSR |
| `k3d-crypto-agent-1` | `api` | NestJS, PostgreSQL, Redis, blockchain stack |

---

## Features

- **Auth** — username/password signup and login; JWT in an `httpOnly` cookie; mnemonic-based account recovery (no email required)
- **Multi-coin deposits** — BTC and LTC via HD wallet derivation (BIP84 native SegWit) tracked by NBXplorer; XMR via a dedicated subaddress per invoice using monero-wallet-rpc
- **Invoice lifecycle** — 30-minute TTL; one pending invoice per user per currency; expiry enforced by a cron job; invoices show real-time confirmation progress
- **Confirmation thresholds** — BTC: 2 confirmations, LTC: 6, XMR: 10; hardcoded as security parameters (not env-configurable)
- **Underpayment handling** — if less than the invoiced amount is received, the actual received amount is credited and the invoice is marked `underpaid`; the user is shown the shortfall and prompted to create a new deposit
- **Privacy** — CoinGecko price fetches routed through Tor; XMR daemon connects to remote onion nodes with automatic failover; no third-party payment processor
- **Rate limiting** — global 120 req/min; auth endpoints further limited to 10 req/15 min to prevent brute force
- **Balance tracking** — separate balances for satoshis, litoshi, and piconero; live exchange rates from CoinGecko with Redis → Postgres → hardcoded fallback chain
- **Soft delete** — settled transactions can be hidden from the wallet UI; the row is retained with a `deletedAt` timestamp for auditing

---

## Tech stack

| Layer | Technology |
|---|---|
| Monorepo | Turborepo + pnpm workspaces |
| Frontend | Astro 5 (SSR, Node adapter) |
| Styling | Tailwind CSS v4 + DaisyUI v5 |
| Backend | NestJS 10, Passport JWT, `@nestjs/throttler` |
| ORM | Prisma 6, PostgreSQL 16 |
| Cache | Redis 7 |
| BTC / LTC | Bitcoin Core 29 + Litecoin Core 0.21 (pruned mainnet), NBXplorer 2.6 |
| XMR | monero-wallet-rpc 0.18, remote onion monerod via Tor |
| Privacy | Tor (SOCKS5 + Privoxy), HD wallet (no xpub reuse) |
| Orchestration | k3d (k3s in Docker), kubectl |
| Language | TypeScript throughout |

---

## Prerequisites

| Tool | Purpose | Install |
|---|---|---|
| Node.js ≥ 20 | Build + local dev | [nodejs.org](https://nodejs.org) |
| pnpm 9 | Package manager | `npm i -g pnpm@9` |
| Docker Desktop | Everything | [docker.com](https://www.docker.com/products/docker-desktop/) |
| k3d ≥ 5 | k3s cluster in Docker | `winget install k3d` / [k3d.io](https://k3d.io) |
| kubectl | Cluster management | bundled with Docker Desktop |

The folder name does not matter — all paths and Kubernetes resource names are independent of it.

---

## Running locally

There are three ways depending on what you need.

---

### Option 1 — Dev cluster (regtest BTC/LTC + XMR stagenet)

The fastest way to see everything working end-to-end. BTC/LTC run in regtest mode (mine blocks on demand); XMR connects to a public stagenet node. No real funds required.

**1. Install dependencies** (first time only)

```bash
pnpm install
```

**2. Create secrets files** (first time only)

```bash
# Postgres / JWT (edit to set real passwords, or leave changeme for local testing)
cp infra/postgres/secret.env.example infra/postgres/secret.env

# Wallet credentials — example already includes working regtest keys, no changes needed
cp infra/wallet/secret.dev.yaml.example infra/wallet/secret.dev.yaml
```

**3. Start the dev cluster**

```bash
pnpm cluster:up-dev
```

| Service | URL |
|---|---|
| Web | http://localhost:8080 |
| API | http://localhost:8080/api/health |

**4. Test deposits**

- **BTC / LTC** — create a deposit in the UI; the invoice page shows the exact `kubectl exec` command to mine blocks and trigger settlement. No port-forwarding needed.
- **XMR** — you need a Monero stagenet wallet. The invoice page has step-by-step instructions including a link to stagenet faucets.

**5. Tear it down**

```bash
pnpm cluster:down   # deletes the cluster; all data is lost
```

---

### Option 2 — Local dev (recommended for development)

Runs only Postgres + Redis in Docker. API and web run with hot reload via `pnpm dev`. No Kubernetes, no blockchain nodes.

**1. Install dependencies**

```bash
pnpm install
```

**2. Copy environment files** (first time only)

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Both files contain working defaults for local development — no changes needed.

**3. Start the database**

```bash
pnpm db:up
```

**4. Apply migrations** (first time only)

```bash
pnpm db:migrate --name init
```

**5. Start everything in watch mode**

```bash
pnpm dev
```

| Service | URL |
|---|---|
| Web | http://localhost:4321 |
| API | http://localhost:3000 |

The `apps/api/.env` file has working defaults. `BTC_XPUB`, `LTC_XPUB`, and `XMR_DAEMON_NODES` are intentionally left empty — deposit creation for those currencies will fail gracefully, which is fine for auth and UI development.

---

### Option 3 — Full k3d cluster (production simulation)

Runs the complete stack inside a local Kubernetes cluster with real mainnet nodes.

**1. Create your secrets files** (first time only)

```bash
# Postgres / JWT
cp infra/postgres/secret.env.example infra/postgres/secret.env
# Edit secret.env — set POSTGRES_PASSWORD and JWT_SECRET

# Wallet credentials (xpubs, RPC passwords, XMR daemon nodes)
cp infra/wallet/secret.yaml.example infra/wallet/secret.yaml
# Edit secret.yaml — fill in BTC_XPUB, LTC_XPUB, RPC passwords, XMR_DAEMON_NODES
```

**2. Install dependencies and apply migrations** (first time only)

```bash
pnpm install
pnpm db:migrate --name init
```

**3. Start the cluster**

```bash
pnpm cluster:up
```

The script will:
1. Create a 3-node k3d cluster named `crypto`
2. Label nodes with simulated VPS roles (`gateway` / `web` / `api`)
3. Build Docker images for the API and web app
4. Import them into the cluster (no registry needed)
5. Apply all Kubernetes manifests
6. Wait for core services to be ready

| Service | URL |
|---|---|
| Web | http://localhost:8080 |
| API | http://localhost:8080/api/health |

**4. Tear it down**

```bash
pnpm cluster:down   # deletes the cluster; all data is lost
```

**Note on BTC/LTC sync:** On first boot, `bitcoind` and `litecoind` begin syncing the mainnet chain from scratch. This takes **24–48 hours for BTC** and **4–8 hours for LTC**. During this time XMR deposits work immediately; BTC/LTC deposits will fail gracefully until NBXplorer reports `isFullySynched`. Monitor progress:

```bash
kubectl logs -n crypto-demo deploy/nbxplorer -f
```

---

## After code changes (k3d only)

The cluster does not hot-reload. After editing source code, use the targeted redeploy scripts — they rebuild only the affected image and restart that deployment. Only re-run `cluster:up` / `cluster:up-dev` when secrets or infra manifests change.

```bash
pnpm cluster:redeploy-api   # after API (NestJS) changes
pnpm cluster:redeploy-web   # after web (Astro) changes
```

---

## Project structure

```
onchain-pay/
├── apps/
│   ├── api/                    # NestJS application
│   │   ├── prisma/             # schema.prisma + migrations
│   │   └── src/
│   │       ├── auth/           # signup, login, mnemonic recovery, JWT guard
│   │       ├── chain/          # NBXplorer poller, XMR wallet, address derivation
│   │       ├── deposits/       # invoice creation, settlement, balance
│   │       ├── prices/         # CoinGecko → Redis → Postgres rate pipeline
│   │       └── users/          # account deletion
│   └── web/                    # Astro SSR application
│       └── src/pages/          # index, login, signup, deposit, wallet
├── infra/
│   ├── base/                   # Kubernetes manifests (mainnet)
│   │   ├── api/
│   │   ├── web/
│   │   ├── bitcoind/
│   │   ├── litecoind/
│   │   ├── nbxplorer/
│   │   ├── postgres/
│   │   ├── redis/
│   │   ├── tor/
│   │   └── xmr-wallet/
│   ├── overlays/dev/           # Kustomize patches for dev cluster
│   ├── k3d-config.yaml         # cluster definition (3 nodes, port :8080)
│   └── wallet/
│       ├── secret.yaml.example     # mainnet credentials template
│       └── secret.dev.yaml.example # dev credentials (regtest keys included)
├── packages/
│   ├── eslint-config/
│   └── typescript-config/      # base, astro, nestjs tsconfig presets
├── scripts/
│   ├── cluster-up.sh           # one-command cluster bootstrap
│   └── cluster-down.sh
├── docker-compose.yml          # local Postgres + Redis for dev
└── package.json                # root scripts
```

---

## Useful commands

```bash
# Cluster lifecycle
pnpm cluster:up                  # mainnet cluster
pnpm cluster:up-dev              # dev cluster (regtest BTC/LTC + XMR stagenet)
pnpm cluster:down                # delete cluster (data is lost)
pnpm cluster:redeploy-api        # rebuild + restart API after code changes
pnpm cluster:redeploy-web        # rebuild + restart web after code changes

# Database / local dev
pnpm db:up                       # start local Postgres + Redis (docker compose)
pnpm db:down                     # stop local containers
pnpm db:migrate --name <name>    # create + apply a new Prisma migration

# Development
pnpm dev                         # run all apps in watch mode (requires db:up)
pnpm build                       # production build of all apps
pnpm lint                        # ESLint across all packages
pnpm check-types                 # tsc --noEmit across all packages

# Kubernetes (while cluster is running)
kubectl get pods -n crypto-demo -o wide
kubectl logs -n crypto-demo deploy/api -f
kubectl logs -n crypto-demo deploy/bitcoind -f
kubectl logs -n crypto-demo deploy/nbxplorer -f

# Re-apply secrets after editing secret.env
kubectl create secret generic postgres-credentials \
  --from-env-file=infra/postgres/secret.env \
  --namespace=crypto-demo \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/api -n crypto-demo

# Re-apply wallet secret after editing secret.yaml
kubectl apply -f infra/wallet/secret.yaml
kubectl rollout restart deployment/api -n crypto-demo
```
