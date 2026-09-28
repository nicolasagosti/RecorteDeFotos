#!/usr/bin/env bash
# Crea el entorno de Python (.venv) e instala las dependencias.
set -e
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  if ! python3 -m venv .venv 2>/dev/null; then
    # Sin el paquete python3-venv completo (falta ensurepip): entorno sin pip propio.
    rm -rf .venv
    python3 -m venv --without-pip .venv
  fi
fi

if .venv/bin/python -m pip --version >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements.txt
else
  python3 -m pip --python .venv/bin/python install -r requirements.txt
fi

echo
echo "Listo. Para abrir la aplicación: ./iniciar.sh"
