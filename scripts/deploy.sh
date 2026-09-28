#!/usr/bin/env bash
set -euo pipefail

# This legacy Docker path cannot establish the same database/runtime target as
# the reviewed PM2 deployment. Do not mutate a database or stop containers.
echo "BACKEND_LEGACY_DEPLOY_BLOCKED: Docker deployment prerequisites are not validated." >&2
echo "Use the reviewed deploy-vps workflow and its mandatory backend-migrate gate." >&2
echo "No database write/restart performed. See docs/SECURITY-LAYER-REPORT.md." >&2
exit 1
