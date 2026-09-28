#!/usr/bin/env bash
# Prueba la app ya empaquetada: que arranque, liste los modelos y recorte una imagen con el
# modelo General (lo baja si hace falta). La usa .github/workflows/app.yml en cada sistema.
# Uso: empaquetado/probar-app.sh <ejecutable>
set -euo pipefail

app="$1"
export PUERTO="${PUERTO:-5123}"
export BROWSER=true # por las dudas: que nada abra un navegador durante la prueba
url="http://127.0.0.1:$PUERTO"
tmp="$(mktemp -d)"

"$app" --no-abrir > "$tmp/salida.txt" 2>&1 &
pid=$!

terminar() {
  estado=$?
  kill "$pid" 2>/dev/null || true
  if [ "$estado" -ne 0 ]; then
    echo "---- salida de la app ----"
    cat "$tmp/salida.txt" || true
    # Sin consola (Windows) los mensajes van a un archivo en la carpeta de datos.
    [ -n "${LOCALAPPDATA:-}" ] && cat "$LOCALAPPDATA/RecorteDeFotos/registro.txt" 2>/dev/null || true
  fi
}
trap terminar EXIT

for _ in $(seq 1 120); do
  curl -sf -o /dev/null "$url/api/estado" && break
  sleep 1
done
curl -sf "$url/api/estado"
echo

# Como una pestaña abierta: si no, la app se cierra sola al rato.
curl -sN "$url/api/presencia" > /dev/null &

# La primera vez tarda (numba compila pymatting).
curl -sf --max-time 600 "$url/api/modelos" > "$tmp/modelos.json"
python -c "
import json, sys
modelos = json.load(open(sys.argv[1]))['modelos']
assert len(modelos) == 4, modelos
print('Modelos:', ', '.join(m['nombre'] for m in modelos))
" "$tmp/modelos.json"

python -c "
from PIL import Image, ImageDraw
im = Image.new('RGB', (800, 600), (170, 200, 230))
d = ImageDraw.Draw(im)
d.ellipse((320, 120, 480, 280), fill=(200, 60, 50))
d.rectangle((300, 280, 500, 560), fill=(40, 80, 160))
im.save(r'$tmp/prueba.png')
"
curl -sf --max-time 900 -F "imagen=@$tmp/prueba.png" -F modelo=isnet-general-use -F limpiar_bordes=1 \
  -o "$tmp/recorte.png" "$url/api/quitar-fondo"
python -c "
from PIL import Image
im = Image.open(r'$tmp/recorte.png')
alfa = im.getchannel('A').getextrema()
assert im.mode == 'RGBA' and alfa == (0, 255), (im.mode, alfa)
print('Recorte OK:', im.size, 'alfa', alfa)
"

# Ninguna copia extra de la app (multiprocessing relanza el ejecutable para sus ayudantes).
if [ -z "${LOCALAPPDATA:-}" ]; then # en Windows la salida va a registro.txt
  copias=$(grep -c -e "listo en" -e "ya estaba abierta" "$tmp/salida.txt" || true)
  if [ "$copias" -ne 1 ]; then
    echo "Se abrieron $copias copias de la app"
    exit 1
  fi
fi
echo "Prueba completa"
