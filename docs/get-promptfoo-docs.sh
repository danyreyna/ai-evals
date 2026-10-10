#!/bin/bash

set -Eeuo pipefail
IFS=$'\n\t'
trap_err() {
  exit_status_before_echo=${?}
  echo >&2 "Error at $(caller): ${BASH_COMMAND}"
  exit ${exit_status_before_echo}
}
trap trap_err ERR

if [ -d "promptfoo" ]; then
    echo "promptfoo directory exists, won't download docs."
    exit 0 
fi

git clone https://github.com/promptfoo/promptfoo.git && cd promptfoo && git checkout 0.124.1 && rm -rf .git && cd ..
echo "Cloned promptfoo repo."
mv promptfoo promptfoo-repo && mv promptfoo-repo/site/docs promptfoo && rm -rf promptfoo-repo
echo "Extracted docs."
