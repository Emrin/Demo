#!/usr/bin/env bash
# Run from the project root or any subdirectory.
# Requires: k3d, kubectl, docker
set -euo pipefail

CLUSTER="crypto"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── helpers ────────────────────────────────────────────────────────────────────
need() { command -v "$1" &>/dev/null || { echo "ERROR: '$1' not found in PATH"; exit 1; }; }
info() { echo "▶ $*"; }

need k3d
need kubectl
need docker

# ── 1. Cluster ─────────────────────────────────────────────────────────────────
if k3d cluster list | grep -q "^${CLUSTER}"; then
  info "Cluster '${CLUSTER}' already exists, skipping creation"
else
  info "Creating k3d cluster '${CLUSTER}' (3 nodes: 1 server + 2 agents)..."
  k3d cluster create --config "${ROOT}/infra/k3d-config.yaml"
fi

# ── 2. Node labels (simulate 3 VPS roles) ──────────────────────────────────────
info "Labeling nodes with VPS roles..."
kubectl label node "k3d-${CLUSTER}-server-0" vps-role=gateway --overwrite
kubectl label node "k3d-${CLUSTER}-agent-0"  vps-role=web     --overwrite
kubectl label node "k3d-${CLUSTER}-agent-1"  vps-role=api     --overwrite

# ── 3. Docker images ────────────────────────────────────────────────────────────
info "Building API image..."
docker build -f "${ROOT}/apps/api/Dockerfile" -t crypto-api:latest "${ROOT}"

info "Building Web image (PUBLIC_API_URL='' for same-origin ingress routing)..."
docker build -f "${ROOT}/apps/web/Dockerfile" \
  --build-arg PUBLIC_API_URL="" \
  -t crypto-web:latest "${ROOT}"

# ── 4. Import images into cluster ──────────────────────────────────────────────
info "Importing images into cluster nodes..."
k3d image import crypto-api:latest crypto-web:latest -c "${CLUSTER}"

# ── 5. Apply manifests ─────────────────────────────────────────────────────────
info "Applying Kubernetes manifests..."
kubectl apply -f "${ROOT}/infra/namespace.yaml"
kubectl apply -f "${ROOT}/infra/redis/"
kubectl apply -f "${ROOT}/infra/api/"
kubectl apply -f "${ROOT}/infra/web/"
kubectl apply -f "${ROOT}/infra/ingress.yaml"

# ── 6. Restart deployments to pick up newly imported images ────────────────────
info "Restarting deployments to pick up new images..."
kubectl rollout restart deployment/api -n crypto-demo
kubectl rollout restart deployment/web -n crypto-demo

# ── 7. Wait for rollout ─────────────────────────────────────────────────────────
info "Waiting for deployments to be ready..."
kubectl rollout status deployment/redis -n crypto-demo --timeout=120s
kubectl rollout status deployment/api -n crypto-demo --timeout=120s
kubectl rollout status deployment/web -n crypto-demo --timeout=120s

# ── 8. Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║         Cluster ready                    ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Web app  →  http://localhost:8080       ║"
echo "║  API      →  http://localhost:8080/api/hello ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Nodes (simulated VPS servers):"
kubectl get nodes -L vps-role
echo ""
echo "Pods:"
kubectl get pods -n crypto-demo -o wide