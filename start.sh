#!/bin/sh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
 printf '%s\n' 'Install Node.js 22 or later from nodejs.org, then run this again.'
 exit 1
fi
exec node server.mjs --open
