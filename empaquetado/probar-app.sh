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
# En Windows (Git Bash), una ruta que entiendan también Python y curl: C:/Users/.../tmp.xxx
if command -v cygpath > /dev/null; then tmp="$(cygpath -m "$tmp")"; fi
registro="${LOCALAPPDATA:-}/RecorteDeFotos/registro.txt" # sin consola (Windows) la salida va ahí
paso="arrancar la app"

"$app" --no-abrir > "$tmp/salida.txt" 2>&1 &
pid=$!

# En GitHub Actions, los errores como anotación: se pueden leer sin iniciar sesión.
anotar() {
  [ -n "${GITHUB_ACTIONS:-}" ] && [ -s "$2" ] || return 0
  python - "$1" "$2" <<'EOF'
import sys
texto = open(sys.argv[2], encoding="utf-8", errors="replace").read()[-3000:].replace("\r", "")
print(f"::error title={sys.argv[1]}::" + texto.replace("%", "%25").replace("\n", "%0A"))
EOF
}

terminar() {
  estado=$?
  kill "$pid" 2>/dev/null || true
  if [ "$estado" -ne 0 ]; then
    echo "Falló al $paso"
    echo "---- salida de la app ----"
    cat "$tmp/salida.txt" 2>/dev/null || true
    cat "$registro" 2>/dev/null || true
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Falló la prueba::al $paso"
    anotar "Salida de la app" "$tmp/salida.txt"
    [ "$paso" = "recortar la imagen" ] && anotar "Respuesta al recortar" "$tmp/recorte.png"
    [ -n "${LOCALAPPDATA:-}" ] && anotar "registro.txt de la app" "$registro"
  fi
}
trap terminar EXIT

paso="esperar que responda"
for _ in $(seq 1 120); do
  curl -sf -o /dev/null "$url/api/estado" && break
  sleep 1
done
curl -sf "$url/api/estado"
echo

# Como una pestaña abierta: si no, la app se cierra sola al rato.
curl -sN "$url/api/presencia" > /dev/null &

paso="listar los modelos" # la primera vez tarda (numba compila pymatting)
curl -sf --max-time 600 "$url/api/modelos" -o "$tmp/modelos.json"
python - "$tmp/modelos.json" <<'EOF'
import json, sys
modelos = json.load(open(sys.argv[1]))["modelos"]
assert len(modelos) == 4, modelos
print("Modelos:", ", ".join(m["nombre"] for m in modelos))
EOF

paso="crear la imagen de prueba"
python - "$tmp/prueba.png" <<'EOF'
import sys
from PIL import Image, ImageDraw
im = Image.new("RGB", (800, 600), (170, 200, 230))
d = ImageDraw.Draw(im)
d.ellipse((320, 120, 480, 280), fill=(200, 60, 50))
d.rectangle((300, 280, 500, 560), fill=(40, 80, 160))
im.save(sys.argv[1])
EOF

paso="recortar la imagen"
curl -sS --fail-with-body --max-time 900 -F "imagen=@$tmp/prueba.png" -F modelo=isnet-general-use \
  -F limpiar_bordes=1 -o "$tmp/recorte.png" "$url/api/quitar-fondo"
python - "$tmp/recorte.png" <<'EOF'
import sys
from PIL import Image
im = Image.open(sys.argv[1])
alfa = im.getchannel("A").getextrema()
assert im.mode == "RGBA" and alfa == (0, 255), (im.mode, alfa)
print("Recorte OK:", im.size, "alfa", alfa)
EOF

# Ninguna copia extra de la app (multiprocessing relanza el ejecutable para sus ayudantes).
paso="contar las copias de la app"
salida="$tmp/salida.txt"
[ -s "$registro" ] && salida="$registro"
copias=$(grep -c -e "listo en" -e "ya estaba abierta" "$salida" || true)
if [ "$copias" -ne 1 ]; then
  echo "Se abrieron $copias copias de la app"
  exit 1
fi
echo "Prueba completa"
