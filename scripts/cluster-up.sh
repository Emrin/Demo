#!/usr/bin/env bash
# Brings up the full k3d cluster.
#
#   bash scripts/cluster-up.sh       → mainnet
#   bash scripts/cluster-up.sh dev   → regtest BTC/LTC + XMR stagenet (no real funds)
#
# Requires: k3d, kubectl, docker
set -eu
# pipefail is bash-only; skip silently if unavailable (e.g. Windows sh)
set -o pipefail 2>/dev/null || true

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
  # Warn if the cluster was created before port 8443 was added to the config
  if ! docker inspect "k3d-${CLUSTER}-serverlb" 2>/dev/null \
      | grep -q '"8443/tcp"'; then
    echo ""
    echo "  WARNING: This cluster does not expose port 8443 (HTTPS)."
    echo "  To enable HTTPS, recreate the cluster:"
    echo "    pnpm cluster:down && pnpm cluster:up${MODE:+ $MODE}"
    echo ""
  fi
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

# ── 5. cert-manager ────────────────────────────────────────────────────────────
if ! kubectl get namespace cert-manager &>/dev/null; then
  info "Installing cert-manager..."
  kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
  info "Waiting for cert-manager webhooks to be ready..."
  kubectl rollout status deployment/cert-manager            -n cert-manager --timeout=120s
  kubectl rollout status deployment/cert-manager-webhook    -n cert-manager --timeout=120s
  kubectl rollout status deployment/cert-manager-cainjector -n cert-manager --timeout=120s
else
  info "cert-manager already installed, skipping"
fi

# ── 6. Secrets ─────────────────────────────────────────────────────────────────
info "Applying secrets..."
kubectl apply -f "${ROOT}/infra/base/namespace.yaml"

kubectl create secret generic postgres-credentials \
  --from-env-file="${ROOT}/infra/postgres/secret.env" \
  --namespace=crypto-demo \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -f "$WALLET_SECRET"

# ── 7. Apply manifests via Kustomize ───────────────────────────────────────────
if [[ "$MODE" == "dev" ]]; then
  info "Applying dev overlay (regtest BTC/LTC + XMR stagenet)..."
  kubectl apply -k "${ROOT}/infra/overlays/dev/"
else
  info "Applying mainnet manifests..."
  kubectl apply -k "${ROOT}/infra/base/"
fi

# ── 8. Restart app deployments to pick up newly imported images ────────────────
info "Restarting app deployments..."
kubectl rollout restart deployment/api -n crypto-demo
kubectl rollout restart deployment/web -n crypto-demo

# ── 9. Wait for core services ──────────────────────────────────────────────────
info "Waiting for core services..."
kubectl rollout status deployment/postgres   -n crypto-demo --timeout=120s
kubectl rollout status deployment/redis      -n crypto-demo --timeout=60s
kubectl rollout status deployment/tor        -n crypto-demo --timeout=60s
kubectl rollout status deployment/xmr-wallet -n crypto-demo --timeout=120s
kubectl rollout status deployment/api        -n crypto-demo --timeout=120s
kubectl rollout status deployment/web        -n crypto-demo --timeout=120s

# ── 10. Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════════╗"
if [[ "$MODE" == "dev" ]]; then
echo "║  Cluster ready  [DEV — regtest BTC/LTC + XMR stagenet]          ║"
else
echo "║  Cluster ready  [MAINNET]                                        ║"
fi
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  HTTP   →  http://localhost:8080                                 ║"
echo "║  HTTPS  →  https://crypto-demo.local:8443  (self-signed cert)   ║"
echo "║  API    →  http://localhost:8080/api/health                      ║"
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  To enable HTTPS add to /etc/hosts (one-time):                   ║"
echo "║    127.0.0.1  crypto-demo.local                                  ║"
if [[ "$MODE" == "mainnet" ]]; then
echo "╠══════════════════════════════════════════════════════════════════╣"
echo "║  BTC/LTC deposits unavailable until nodes finish syncing.        ║"
echo "║  Monitor:  kubectl logs -n crypto-demo deploy/nbxplorer -f       ║"
fi
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
kubectl get pods -n crypto-demo -o wide
