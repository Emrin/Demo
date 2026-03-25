#!/usr/bin/env bash
set -euo pipefail

CLUSTER="crypto"

echo "Deleting k3d cluster '${CLUSTER}'..."
k3d cluster delete "${CLUSTER}"
echo "Done."