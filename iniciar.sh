#!/usr/bin/env bash
# Abre Recorte de Fotos en el navegador. Ctrl+C en esta terminal para cerrarlo.
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  mensaje="Falta instalar. Corré primero: ./instalar.sh"
  echo "$mensaje"
  # Abierta desde el menú no hay terminal donde leerlo: mostrarlo como notificación.
  [ -t 1 ] || notify-send "Recorte de Fotos" "$mensaje" 2>/dev/null
  exit 1
fi
exec .venv/bin/python app.py "$@"
