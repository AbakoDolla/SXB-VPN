#!/usr/bin/env bash
set -euo pipefail

echo "BACKEND_LEGACY_UPDATE_BLOCKED: migrate deploy does not discover the required manual DDL." >&2
echo "Use the reviewed deploy-vps workflow and its mandatory backend-migrate gate." >&2
echo "No database write/restart performed. See docs/SECURITY-LAYER-REPORT.md." >&2
exit 1
