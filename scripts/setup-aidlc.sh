#!/bin/sh
# Install the official pinned release locally; never pushes generated files.
set -eu
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
command -v curl >/dev/null
command -v python3 >/dev/null
command -v codex >/dev/null
version=2.9.0
bootstrap_dir="$repo_dir/work/aidlc-bootstrap"
mkdir -p "$bootstrap_dir"

curl -fSL "https://github.com/awslabs/aidlc-workflows/releases/download/v${version}/install.sh" \
  -o "$bootstrap_dir/install.sh"
# The official installer verifies release provenance (when supported) and checksums.
sh "$bootstrap_dir/install.sh" --version "$version"
aidlc_bin="${AIDLC_BIN_DIR:-$HOME/.local/bin}/aidlc"
PATH="$(dirname "$aidlc_bin"):$PATH"
export PATH

new_config=false
if [ ! -f .codex/config.toml ]; then new_config=true; fi
"$aidlc_bin" config --harness codex --dry-run
"$aidlc_bin" config --harness codex
"$aidlc_bin" config --pin "$version"

# Only adapt a freshly generated config. Never rewrite an existing user's setup.
if [ "$new_config" = true ]; then
  python3 - <<'PY'
from pathlib import Path
p = Path('.codex/config.toml')
s = p.read_text()
lines = s.splitlines(keepends=True)
result = []
in_root = True
skip_bedrock = False
for line in lines:
    stripped = line.strip()
    if stripped.startswith('['):
        in_root = False
        skip_bedrock = stripped.startswith('[model_providers.amazon-bedrock')
    if skip_bedrock:
        continue
    if in_root and any(stripped.startswith(key + ' =') for key in
                       ('model', 'model_provider', 'model_context_window', 'model_reasoning_effort')):
        continue
    result.append(line)
p.write_text('# Team adaptation: inherit each member\'s Codex login and model.\n' + ''.join(result))
for role in ('aidlc-architecture-reviewer-agent', 'aidlc-product-lead-agent'):
    p = Path('.codex/agents') / (role + '.toml')
    p.write_text(''.join(line for line in p.read_text().splitlines(keepends=True)
                         if not line.strip().startswith('model =')))
PY
fi

"$aidlc_bin" doctor
printf '\nNext: launch codex in this directory, inspect /hooks, then run $aidlc --doctor.\n'
printf 'Keep %s on the PATH used by Codex hooks.\n' "$(dirname "$aidlc_bin")"
printf 'No product workflow has started. Review generated files before committing.\n'
