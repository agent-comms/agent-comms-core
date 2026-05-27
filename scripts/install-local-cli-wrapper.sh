#!/usr/bin/env bash
set -euo pipefail

repo_dir="${AGENT_COMMS_CORE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
bin_dir="${AGENT_COMMS_BIN_DIR:-/opt/homebrew/bin}"
bin_path="${bin_dir}/agent-comms"
cli_path="${repo_dir}/scripts/agent-comms.mjs"

if [[ ! -f "${cli_path}" ]]; then
  printf 'agent-comms CLI source not found at %s\n' "${cli_path}" >&2
  exit 1
fi

mkdir -p "${bin_dir}"
rm -f "${bin_path}"

cat > "${bin_path}" <<EOF
#!/usr/bin/env bash
exec node "${cli_path}" "\$@"
EOF

chmod 0755 "${bin_path}"

printf 'Installed shared local agent-comms wrapper:\n'
printf '  %s -> %s\n' "${bin_path}" "${cli_path}"
printf '\nAll shells on this machine that use %s on PATH will now run the CLI from this repository checkout.\n' "${bin_dir}"
printf 'After pulling a new release into %s, agents automatically see the updated CLI without npm reinstall.\n' "${repo_dir}"
