#!/usr/bin/env bash
# Usage: scripts/build.sh <plugin-dir-name>   ->  dist/<plugin>-<version>.xpi
set -euo pipefail
name="${1:?plugin directory name under plugins/}"
src="plugins/$name"
version=$(python3 -c "import json,sys;print(json.load(open('$src/manifest.json'))['version'])")
mkdir -p dist
out="$PWD/dist/$name-$version.xpi"
rm -f "$out"
(cd "$src" && zip -qr "$out" . -x '*.DS_Store')
echo "$out"
