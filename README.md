# crypto-demo

A full-stack Bitcoin deposit platform built as a portfolio demo. Users sign up, authenticate, and deposit real (regtest) Bitcoin — the app tracks balances in satoshis, handles overpayments, and maintains a soft-deleted audit trail of transactions.

Everything runs inside a local **k3d** (Kubernetes-in-Docker) cluster that simulates a 3-node VPS topology. Zero cloud accounts required.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                        │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTP :8080
          ┌────────────▼────────────┐
          │  Traefik Ingress (k3d)  │  ← gateway node
          └──────┬──────────┬───────┘
                 │          │
    ┌────────────▼──┐   ┌───▼─────────────┐
    │  Astro (web)  │   │  NestJS (api)   │  ← web / api nodes
    │  SSR, Node    │   │  REST + Prisma  │
    └───────────────┘   └───────┬─────────┘
                                │
           ┌────────────────────┼──────────────────┐
           │                    │                  │
    ┌──────▼──────┐   ┌─────────▼──────┐   ┌──────▼──────┐
    │  PostgreSQL │   │     Redis      │   │ BtcPayServer│
    │  (Prisma)   │   │  (future use)  │   │  + NBXplorer│
    └─────────────┘   └────────────────┘   │  + Bitcoin  │
                                           │    Core     │
                                           └─────────────┘
```

**Nodes (simulated VPS servers)**

| k3d node | role label | workloads |
|---|---|---|
| `k3d-crypto-server-0` | `gateway` | Traefik ingress |
| `k3d-crypto-agent-0` | `web` | Astro SSR |
| `k3d-crypto-agent-1` | `api` | NestJS, PostgreSQL, Redis, Bitcoin stack |

---

## Features

- **Auth** — email/password signup & login; JWT issued by NestJS, stored as an `httpOnly` cookie in the browser; Astro SSR forwards it as a `Bearer` token to the API
- **Deposits** — users create a Bitcoin invoice via BtcPayServer's Greenfield API; the on-chain address is shown to the user
- **Webhook settlement** — BtcPayServer sends an `InvoiceSettled` webhook; the API verifies the HMAC-SHA256 signature against the raw request body, fetches the actual paid amount (handles overpayment), and atomically credits the user's balance via `prisma.$transaction`
- **Wallet page** — shows current balance, any pending invoice, and full transaction history
- **Soft delete** — users can remove settled transactions from their view; the row is kept in the database with a `deletedAt` timestamp for auditing; pending invoices cannot be deleted
- **1 pending invoice per user** — enforced at the service layer with a `ConflictException` that redirects back to the existing invoice instead of creating a duplicate

---

## Tech stack

| Layer | Technology |
|---|---|
| Monorepo | Turborepo + pnpm workspaces |
| Frontend | Astro 5 (SSR, Node adapter) |
| Styling | Tailwind CSS v4 + DaisyUI v5 (system-default theme) |
| Backend | NestJS 10, Passport JWT |
| ORM | Prisma 6, PostgreSQL 16 |
| Cache | Redis 7 |
| Bitcoin | Bitcoin Core (regtest), NBXplorer, BtcPayServer 2.3.6 |
| Container orchestration | k3d (k3s in Docker), kubectl |
| Language | TypeScript throughout |

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| pnpm | 9 | `npm i -g pnpm@9` |
| Docker Desktop | any recent | [docker.com](https://www.docker.com/products/docker-desktop/) |
| k3d | ≥ 5 | `brew install k3d` / [k3d.io](https://k3d.io/#installation) |
| kubectl | any | bundled with Docker Desktop or `brew install kubectl` |

---

## Quick start

### 1. Clone & install

```bash
git clone https://github.com/Emrin/Demo.git crypto-demo
cd crypto-demo
pnpm install
```

### 2. Create the secrets file

```bash
cp infra/postgres/secret.env.example infra/postgres/secret.env
```

Edit `infra/postgres/secret.env` and set a real `POSTGRES_PASSWORD` and `JWT_SECRET`. Leave the BtcPayServer keys blank for now — you will fill them in after the first boot.

### 3. Start the cluster

```bash
pnpm cluster:up
```

This script:
1. Creates a 3-node k3d cluster named `crypto`
2. Labels nodes with simulated VPS roles (`gateway` / `web` / `api`)
3. Builds Docker images for the API and web app
4. Imports them into the cluster (no registry needed)
5. Applies all Kubernetes manifests (namespace, secrets, PVCs, deployments, services, ingress)
6. Waits for every deployment — including the full Bitcoin stack — to become ready

When the script finishes you will see:

```
╔══════════════════════════════════════════════════════════════════════╗
║         Cluster ready                                                ║
╠══════════════════════════════════════════════════════════════════════╣
║  Web app      →  http://localhost:8080                               ║
║  API          →  http://localhost:8080/api/hello                     ║
║  BtcPayServer →  kubectl port-forward -n crypto-demo service/btcpayserver 14142:14142 ║
╚══════════════════════════════════════════════════════════════════════╝
```

### 4. Run database migrations

```bash
pnpm db:migrate --name init
```

> The `db:migrate` script runs Prisma migrations against the cluster's PostgreSQL. Run it any time you pull changes that include new migrations.

### 5. Configure BtcPayServer

1. Forward the BtcPayServer port:
   ```bash
   kubectl port-forward -n crypto-demo service/btcpayserver 14142:14142
   ```
2. Open `http://localhost:14142` and create an admin account.
3. Create a **Store**, then go to **Wallets → Bitcoin** and generate a new **hot wallet** (the regtest network is selected automatically).
4. Go to **Account → Manage Account → API Keys** and create a key with view invoice and create invoice permissions. Copy the key.
5. Copy the **Store ID** from the store's General Settings page.
6. Go to **Store Settings → Webhooks**, add a webhook pointing to `http://api:3000/api/deposits/webhook`, select the 
   **InvoiceSettled** event, and copy the generated secret.
7. Update `infra/postgres/secret.env` with the three values:
   ```
   BTCPAY_API_KEY=<your key>
   BTCPAY_STORE_ID=<your store id>
   BTCPAY_WEBHOOK_SECRET=<your webhook secret>
   ```
8. Re-apply the secret and restart the API:
   ```bash
   kubectl create secret generic postgres-credentials \
     --from-env-file=infra/postgres/secret.env \
     --namespace=crypto-demo \
     --dry-run=client -o yaml | kubectl apply -f -
   kubectl rollout restart deployment/api -n crypto-demo
   ```

### 6. Done

Open `http://localhost:8080`, sign up, and create a deposit. To simulate a payment in regtest, use the BtcPayServer UI or Bitcoin Core's RPC (`bitcoin-cli generatetoaddress`) to mine blocks to the generated address.

---

## Local development (without Kubernetes)

Auth, balance, and wallet pages work fully in local dev. **Deposit creation requires BtcPayServer**, which only runs inside the k3d cluster — so that flow will error locally unless you forward it from a running cluster (see tip below).

```bash
# Start only the infrastructure (Postgres + Redis)
pnpm db:up

# Run all apps in watch mode (hot reload)
pnpm dev
```

Apply or create migrations locally:

```bash
pnpm db:migrate --name <migration_name>
```

> **Tip — using deposits in local dev:** if your k3d cluster is running, you can forward BtcPayServer to localhost and point the API at it:
> ```bash
> kubectl port-forward -n crypto-demo service/btcpayserver 14142:14142
> ```
> Then set `BTCPAY_URL=http://localhost:14142` in `apps/api/.env` before running `pnpm dev`.

---

## Project structure

```
crypto-demo/
├── apps/
│   ├── api/                  # NestJS application
│   │   ├── prisma/           # schema.prisma + migrations
│   │   └── src/
│   │       ├── auth/         # JWT auth (signup, login, guard, strategy)
│   │       ├── deposits/     # deposit flow, webhook handler, balance
│   │       ├── users/
│   │       └── prisma/       # PrismaService
│   └── web/                  # Astro SSR application
│       └── src/pages/        # index, login, signup, deposit, wallet
├── infra/
│   ├── k3d-config.yaml       # cluster definition (3 nodes, port :8080)
│   ├── namespace.yaml
│   ├── ingress.yaml
│   ├── postgres/             # deployment, service, PVC, secret template
│   ├── redis/
│   ├── api/
│   ├── web/
│   ├── bitcoind/             # Bitcoin Core (regtest)
│   ├── nbxplorer/            # Bitcoin indexer
│   └── btcpayserver/         # BtcPayServer
├── packages/
│   ├── eslint-config/
│   └── typescript-config/    # base, astro, nestjs tsconfig presets
├── scripts/
│   ├── cluster-up.sh         # one-command cluster bootstrap
│   └── cluster-down.sh
├── docker-compose.yml        # local Postgres + Redis for dev
└── package.json              # root scripts
```

---

## Useful commands

```bash
# Cluster lifecycle
pnpm cluster:up               # create cluster, build images, deploy everything
pnpm cluster:down             # delete cluster (data is lost)

# Database
pnpm db:up                    # start local Postgres + Redis via docker compose
pnpm db:down                  # stop local containers
pnpm db:migrate --name <name> # create + apply a new Prisma migration

# Development
pnpm dev                      # run all apps in watch mode (requires db:up)
pnpm build                    # production build of all apps
pnpm lint                     # ESLint across all packages
pnpm check-types              # tsc --noEmit across all packages

# Kubernetes
kubectl get pods -n crypto-demo -o wide
kubectl logs -n crypto-demo deployment/api --tail=50 -f
kubectl logs -n crypto-demo deployment/web --tail=50 -f
kubectl port-forward -n crypto-demo service/btcpayserver 14142:14142

# After updating secrets (e.g. new BTCPAY_* values)
kubectl create secret generic postgres-credentials \
  --from-env-file=infra/postgres/secret.env \
  --namespace=crypto-demo \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart deployment/api -n crypto-demo
```
