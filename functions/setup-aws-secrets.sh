#!/usr/bin/env bash
# One-time setup: store AWS credentials as Firebase secrets (never commit keys).
# Usage:
#   export AWS_ACCESS_KEY_ID=your_key
#   export AWS_SECRET_ACCESS_KEY=your_secret
#   ./functions/setup-aws-secrets.sh

set -euo pipefail

PROJECT="${FIREBASE_PROJECT:-milkman-ios}"

if [[ -z "${AWS_ACCESS_KEY_ID:-}" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  echo "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY env vars first."
  exit 1
fi

echo "Setting Firebase secrets on project: $PROJECT"
printf '%s' "$AWS_ACCESS_KEY_ID" | npx firebase-tools@latest functions:secrets:set AWS_ACCESS_KEY_ID --project "$PROJECT"
printf '%s' "$AWS_SECRET_ACCESS_KEY" | npx firebase-tools@latest functions:secrets:set AWS_SECRET_ACCESS_KEY --project "$PROJECT"
echo "Done. Deploy with: npx firebase-tools@latest deploy --only functions --project $PROJECT"
