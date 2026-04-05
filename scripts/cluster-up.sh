#!/usr/bin/env bash
# Brings up the full k3d cluster.
#
#   bash scripts/cluster-up.sh       → mainnet
#   bash scripts/cluster-up.sh dev   → regtest BTC/LTC + XMR stagenet (no real funds)
#
# Requires: k3d, kubectl, docker
set -euo pipefail

CLUSTER="crypto"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-mainnet}"

# ── helpers ────────────────────────────────────────────────────────────────────
need() { command -v "$1" &>/dev/null || { echo "ERROR: '$1' not found in PATH"; exit 1; }; }
info() { echo "▶ $*"; }

need k3d
need kubectl
need docker

if [[ "$MODE" != "mainnet" && "$MODE" != "dev" ]]; then
  echo "Usage: $0 [mainnet|dev]"
  exit 1
fi

# ── Secret file checks ─────────────────────────────────────────────────────────
if [[ ! -f "${ROOT}/infra/postgres/secret.env" ]]; then
  echo "ERROR: infra/postgres/secret.env not found."
  echo "  cp infra/postgres/secret.env.example infra/postgres/secret.env"
  exit 1
fi

WALLET_SECRET="${ROOT}/infra/wallet/secret.yaml"
WALLET_EXAMPLE="${ROOT}/infra/wallet/secret.yaml.example"
if [[ "$MODE" == "dev" ]]; then
  WALLET_SECRET="${ROOT}/infra/wallet/secret.dev.yaml"
  WALLET_EXAMPLE="${ROOT}/infra/wallet/secret.dev.yaml.example"
fi

if [[ ! -f "$WALLET_SECRET" ]]; then
  echo "ERROR: $(basename "$WALLET_SECRET") not found."
  echo "  cp $(basename "$WALLET_EXAMPLE") $(basename "$WALLET_SECRET") and fill in your values."
  exit 1
fi

info "Mode: ${MODE}"

# ── 1. Cluster ─────────────────────────────────────────────────────────────────
if k3d cluster list | grep -q "^${CLUSTER}"; then
  info "Cluster '${CLUSTER}' already exists, skipping creation"
else
  info "Creating k3d cluster '${CLUSTER}'..."
  k3d cluster create --config "${ROOT}/infra/k3d-config.yaml"
fi

# ── 2. Node labels ──────────────────────────────────────────────────────────────
info "Labeling nodes..."
kubectl label node "k3d-${CLUSTER}-server-0" vps-role=gateway --overwrite
kubectl label node "k3d-${CLUSTER}-agent-0"  vps-role=web     --overwrite
kubectl label node "k3d-${CLUSTER}-agent-1"  vps-role=api     --overwrite

# ── 3. Docker images ────────────────────────────────────────────────────────────
info "Building API image..."
docker build -f "${ROOT}/apps/api/Dockerfile" -t crypto-api:latest "${ROOT}"

info "Building Web image..."
docker build -f "${ROOT}/apps/web/Dockerfile" \
  --build-arg PUBLIC_API_URL="" \
  -t crypto-web:latest "${ROOT}"

# ── 4. Import images ───────────────────────────────────────────────────────────
info "Importing images into cluster..."
k3d image import crypto-api:latest crypto-web:latest -c "${CLUSTER}"

# ── 5. Secrets ─────────────────────────────────────────────────────────────────
info "Applying secrets..."
kubectl apply -f "${ROOT}/infra/base/namespace.yaml"

kubectl create secret generic postgres-credentials \
  --from-env-file="${ROOT}/infra/postgres/secret.env" \
  --namespace=crypto-demo \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f "$WALLET_SECRET"

# ── 6. Apply manifests via Kustomize ───────────────────────────────────────────
if [[ "$MODE" == "dev" ]]; then
  info "Applying dev overlay (regtest BTC/LTC + XMR stagenet)..."
  kubectl apply -k "${ROOT}/infra/overlays/dev/"
else
  info "Applying mainnet manifests..."
  kubectl apply -k "${ROOT}/infra/base/"
fi

# ── 7. Restart app deployments to pick up newly imported images ────────────────
info "Restarting app deployments..."
kubectl rollout restart deployment/api -n crypto-demo
kubectl rollout restart deployment/web -n crypto-demo

# ── 8. Wait for core services ──────────────────────────────────────────────────
info "Waiting for core services..."
kubectl rollout status deployment/postgres   -n crypto-demo --timeout=120s
kubectl rollout status deployment/redis      -n crypto-demo --timeout=60s
kubectl rollout status deployment/tor        -n crypto-demo --timeout=60s
kubectl rollout status deployment/xmr-wallet -n crypto-demo --timeout=120s
kubectl rollout status deployment/api        -n crypto-demo --timeout=120s
kubectl rollout status deployment/web        -n crypto-demo --timeout=120s

# ── 9. Dev: create regtest wallets so getnewaddress works in confirmation blocks ─
if [[ "$MODE" == "dev" ]]; then
  info "Creating regtest wallets..."

  _btc_cli() {
    kubectl exec -n crypto-demo deployment/bitcoind -- \
      bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=changeme "$@" 2>/dev/null
  }
  _ltc_cli() {
    kubectl exec -n crypto-demo deployment/litecoind -- \
      litecoin-cli -regtest -rpcuser=litecoin -rpcpassword=changeme "$@" 2>/dev/null
  }

  # Wait for bitcoind RPC to be ready (up to 60 s)
  info "  Waiting for bitcoind RPC..."
  for i in $(seq 1 30); do
    _btc_cli getblockcount &>/dev/null && break || true
    sleep 2
  done

  # Wait for litecoind RPC to be ready (up to 60 s)
  info "  Waiting for litecoind RPC..."
  for i in $(seq 1 30); do
    _ltc_cli getblockcount &>/dev/null && break || true
    sleep 2
  done

  # createwallet is idempotent — safe to run on re-deploy.
  # The wallet is only needed so getnewaddress works when mining confirmation blocks.
  # Payments use generatetoaddress (no wallet required) so no pre-funding is needed.
  _btc_cli createwallet "default" 2>/dev/null || true
  _ltc_cli createwallet "default" 2>/dev/null || true

  info "  Regtest wallets ready."
fi

# ── 10. Summary ────────────────────────────────────────────────────────────────
echo ""
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
if [[ "$MODE" == "dev" ]]; then
echo "║  Cluster ready  [DEV — regtest BTC/LTC + XMR stagenet]          ║"
else
echo "║  Cluster ready  [MAINNET]                                       ║"
fi
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  Web app  →  http://localhost:8080                               ║"
echo "║  API      →  http://localhost:8080/api/health                    ║"
if [[ "$MODE" == "mainnet" ]]; then
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  BTC/LTC deposits unavailable until nodes finish syncing.        ║"
echo "║  Monitor:  kubectl logs -n crypto-demo deploy/nbxplorer -f       ║"
fi
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
kubectl get pods -n crypto-demo -o wide
