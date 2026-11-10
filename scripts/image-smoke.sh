#!/bin/sh
# Runs the built image twice and checks how it refuses to start. Usage:
# scripts/image-smoke.sh <image>
#
# 1. No configuration named: exit 2 and exactly one JSON line.
# 2. A configuration that names no username file: exit 1, one JSON line that
#    names the missing setting, and none of the configuration's own text.
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi
image="$1"

dir="$(mktemp -d)"
trap 'rm -rf "${dir:?}"' EXIT
# The container runs as another user than the runner, so the directory and the
# file have to be readable by anyone. The file holds no secret.
chmod 0755 "$dir"

marker="smoke-marker-origin"
cat > "$dir/config.json" <<EOF
{
  "arachnid": { "baseUrl": "https://$marker.example" },
  "channel": { "signingKeyFile": "/run/smoke/signing.key" },
  "cache": { "negativeTtlMs": 86400000 },
  "audit": { "file": "/run/smoke/audit.log" },
  "hosts": [
    { "id": "smoke-host", "kind": "demo", "safety": { "near": true, "exact": true }, "endpoint": "https://smoke-host.example" }
  ]
}
EOF
chmod 0644 "$dir/config.json"

fail() {
  echo "::error::$1" >&2
  echo "output was: $output" >&2
  exit 1
}

# `docker run` is the verb under test; its exit code is read, not trusted.
run_image() {
  if output="$("$@" 2>&1)"; then code=0; else code=$?; fi
}

one_json_line() {
  [ "$(printf '%s\n' "$output" | wc -l)" -eq 1 ] && printf '%s' "$output" | grep -Eq '^\{.*\}$'
}

run_image docker run --rm "$image"
[ "$code" -eq 2 ] || fail "no configuration: expected exit 2, got $code"
one_json_line || fail "no configuration: expected exactly one JSON line"
printf '%s' "$output" | grep -q '"event":"refused-to-start"' || fail "no configuration: expected a refused-to-start event"

run_image docker run --rm \
  --volume "$dir/config.json:/etc/smoke/config.json:ro" \
  --env SAFETY_SERVICE_CONFIG=/etc/smoke/config.json \
  "$image"
[ "$code" -eq 1 ] || fail "no username file: expected exit 1, got $code"
one_json_line || fail "no username file: expected exactly one JSON line"
printf '%s' "$output" | grep -q 'arachnid.usernameFile' || fail "no username file: the refusal did not name the missing setting, so the configuration may not have been read"
if printf '%s' "$output" | grep -q "$marker"; then
  fail "no username file: the output quoted the configuration's contents"
fi

echo "image smoke: both refusals behave as specified"
