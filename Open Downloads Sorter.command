#!/bin/zsh
cd -- "${0:A:h}" || exit 1
sorter_node="$(command -v node)"
if [[ -z "$sorter_node" && -x /opt/homebrew/bin/node ]]; then sorter_node=/opt/homebrew/bin/node; fi
if [[ -z "$sorter_node" && -x /usr/local/bin/node ]]; then sorter_node=/usr/local/bin/node; fi
if [[ -z "$sorter_node" ]]; then
  print 'Install Node.js 22 or later from nodejs.org, then reopen this file.'
  read -r '?Press Return to close.'
  exit 1
fi
"$sorter_node" server.mjs --open
if [[ $? != 0 ]]; then read -r '?Press Return to close.'; fi
