#!/bin/bash
set -euo pipefail
pnpm install --frozen-lockfile
echo "Post-merge database push disabled. Backend migrations require backup and explicit operator approval." >&2
echo "Read-only prerequisite check: node scripts/backend-migrate.cjs check" >&2
