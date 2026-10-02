#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_dir="${project_dir}/release"

mkdir -p "${release_dir}"
docker build \
  --target package \
  --output "type=local,dest=${release_dir}" \
  "${project_dir}"

for artifact in "${release_dir}"/Agentic\ Tiles_*.deb; do
  if [[ -f "${artifact}" ]]; then
    safe_name="$(basename "${artifact}" | sed 's/^Agentic Tiles_/agentic-tiles_/')"
    mv -f "${artifact}" "${release_dir}/${safe_name}"
  fi
done

find "${release_dir}" -maxdepth 1 -type f -name 'agentic-tiles_*.deb' -print
