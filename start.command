#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import faster_whisper' >/dev/null 2>&1; then
  .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
fi
echo '請保持此視窗開啟。網站啟動後，以 Chrome 開啟 http://127.0.0.1:8765'
exec .venv/bin/python server.py
