#!/bin/bash
# Online notarization ticket lookup with bounded retries. Apple can report a
# submission as Accepted before the ticket is published, so an immediate lookup
# may fail ("code failed to satisfy specified code requirement(s)", exit 3).
# Callers must verify the signature itself first: this check retries any failure.
set -euo pipefail
binary="${1:?Usage: bash scripts/check-macos-notarization.sh <binary>}"

# Seconds to wait before each retry; the default totals 290s (about 5 minutes).
# Tests override this to avoid real waits.
read -r -a delays <<< "${MACOS_NOTARIZATION_RETRY_DELAYS:-5 10 15 20 30 30 60 60 60}"
attempts=$((${#delays[@]} + 1))

for ((attempt = 1; ; attempt++)); do
  echo "Checking notarization ticket (attempt $attempt/$attempts)" >&2
  status=0
  codesign --verify --strict --verbose=4 -R=notarized --check-notarization "$binary" || status=$?
  if [[ "$status" -eq 0 ]]; then
    exit 0
  fi
  if [[ "$attempt" -ge "$attempts" ]]; then
    echo "Error: notarization ticket was not available after $attempts attempts (codesign exit $status)" >&2
    exit "$status"
  fi
  delay="${delays[attempt - 1]}"
  echo "Notarization ticket not available yet (codesign exit $status); retrying in ${delay}s" >&2
  sleep "$delay"
done
