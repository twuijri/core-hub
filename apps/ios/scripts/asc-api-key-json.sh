#!/usr/bin/env bash
# Writes the App Store Connect API key as the JSON file fastlane reads (`--api_key_path`), in the
# runner's temp folder, and names it in $GITHUB_ENV as ASC_API_KEY_JSON. The key never reaches the
# log or the repository; the workflow removes the file when it ends.
# Takes ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_P8 (the .p8 as downloaded, or the same
# base64-encoded — as .github/workflows/ios-signed.yml accepts it).
set -euo pipefail
for name in ASC_API_KEY_ID ASC_API_ISSUER_ID ASC_API_KEY_P8; do
  if [ -z "${!name:-}" ]; then
    echo "::error::$name is not set"
    exit 1
  fi
done
umask 077
dir="${RUNNER_TEMP:?}/asc"
mkdir -p "$dir"
key="$dir/AuthKey.p8"
if [[ "$ASC_API_KEY_P8" == *"BEGIN PRIVATE KEY"* ]]; then
  printf '%s\n' "$ASC_API_KEY_P8" > "$key"
else
  printf %s "$ASC_API_KEY_P8" | base64 --decode > "$key"
fi
json="$dir/api_key.json"
jq -n --arg key_id "$ASC_API_KEY_ID" --arg issuer_id "$ASC_API_ISSUER_ID" --rawfile key "$key" \
  '{key_id: $key_id, issuer_id: $issuer_id, key: $key, in_house: false, duration: 1200}' > "$json"
rm -f "$key"
echo "ASC_API_KEY_JSON=$json" >> "${GITHUB_ENV:?}"
