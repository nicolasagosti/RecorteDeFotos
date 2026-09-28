"""Recorte de Fotos: servidor local que quita el fondo de las fotos con rembg.

Uso:  ./iniciar.sh   (o  .venv/bin/python app.py)
Abre el navegador en http://127.0.0.1:5123. Todo se procesa en esta computadora.

Opciones:
  --no-abrir     no abre el navegador
  --cerrar-solo  se cierra cuando no queda ninguna pestaña de la app abierta
                 (lo usa el ícono del menú, que no tiene terminal para hacer Ctrl+C)

También se distribuye como app para instalar (PyInstaller, ver empaquetado/recorte-de-fotos.spec).
Así siempre se cierra sola, porque se abre con doble clic y no tiene terminal.
"""

import functools
import io
import json
import logging
import os
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

EMPAQUETADA = getattr(sys, "frozen", False)
if EMPAQUETADA:
    import multiprocessing

    # multiprocessing (lo usan numba y tqdm) lanza ayudantes volviendo a ejecutar la app.
    # Esto los reconoce, hace su trabajo y termina; si no, cada uno abriría otra copia de la app.
    multiprocessing.freeze_support()

BASE_DIR = Path(__file__).resolve().parent
# Empaquetada, la página viene adentro de la app (sys._MEIPASS).
RECURSOS = Path(getattr(sys, "_MEIPASS", BASE_DIR))


def carpeta_de_datos():
    if sys.platform == "win32":
        base = Path(os.getenv("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.getenv("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return base / "RecorteDeFotos"


if EMPAQUETADA:
    # La carpeta de la app puede no tener permiso de escritura: modelos y caché van a la del usuario.
    DATOS = carpeta_de_datos()
    DATOS.mkdir(parents=True, exist_ok=True)
    # pymatting (lo usa rembg) compila con numba y por defecto guarda eso junto a su código.
    os.environ.setdefault("NUMBA_CACHE_DIR", str(DATOS / "cache-numba"))
    if sys.stdout is None or sys.stderr is None:  # sin consola (Windows): los mensajes, a un archivo
        registro = open(DATOS / "registro.txt", "w", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or registro
        sys.stderr = sys.stderr or registro
else:
    # Los modelos se guardan dentro del proyecto, no en ~/.rembg.
    DATOS = BASE_DIR
os.environ.setdefault("REMBG_HOME", str(DATOS / "modelos"))

import flask.cli  # noqa: E402
from flask import Flask, Response, jsonify, request, send_file  # noqa: E402
from PIL import Image, UnidentifiedImageError  # noqa: E402


@functools.cache
def rembg():
    # Importarlo tarda: la primera vez en una compu, ~30 s (numba compila pymatting).
    # Por eso no se importa arriba: así la página se abre enseguida (ver main).
    import rembg
    import rembg.sessions

    return rembg

MODELOS = {
    "isnet-general-use": {
        "nombre": "General",
        "detalle": "Rápido y bueno para casi todo.",
        "mb": 170,
    },
    "birefnet-general-lite": {
        "nombre": "Alta calidad",
        "detalle": "Bordes más precisos (pelo, detalles). Tarda un poco más.",
        "mb": 213,
    },
    "u2net_human_seg": {
        "nombre": "Personas",
        "detalle": "Pensado para retratos y fotos de gente.",
        "mb": 167,
    },
    "isnet-anime": {
        "nombre": "Dibujos y anime",
        "detalle": "Ilustraciones y personajes dibujados.",
        "mb": 167,
    },
}
MODELO_POR_DEFECTO = "isnet-general-use"

# Píxeles con alfa por debajo de esto no cuentan para "recortar al sujeto".
UMBRAL_CAJA = 12

app = Flask(__name__, static_folder=str(RECURSOS / "static"), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 60 * 1024 * 1024

_sesiones = {}
_candado_sesiones = threading.Lock()


def esta_descargado(modelo):
    archivo = f"{modelo}.onnx"
    return rembg().sessions.sessions[modelo].resolve_existing(archivo) is not None


def obtener_sesion(modelo):
    # La primera vez descarga el modelo; el candado evita descargarlo dos veces.
    with _candado_sesiones:
        if modelo not in _sesiones:
            _sesiones[modelo] = rembg().new_session(modelo)
        return _sesiones[modelo]


def error(mensaje, codigo=400):
    return jsonify({"error": mensaje}), codigo


@app.get("/")
def inicio():
    return app.send_static_file("index.html")


@app.get("/api/estado")
def estado():
    # Responde enseguida (a diferencia de /api/modelos, que espera a rembg): ver ya_esta_abierta.
    return jsonify({"app": "recorte-de-fotos"})


@app.get("/api/modelos")
def listar_modelos():
    return jsonify(
        {
            "por_defecto": MODELO_POR_DEFECTO,
            "modelos": [
                {"id": id_, **datos, "descargado": esta_descargado(id_)}
                for id_, datos in MODELOS.items()
            ],
        }
    )


@app.post("/api/quitar-fondo")
def quitar_fondo():
    archivo = request.files.get("imagen")
    if archivo is None:
        return error("No llegó ninguna imagen.")

    modelo = request.form.get("modelo", MODELO_POR_DEFECTO)
    if modelo not in MODELOS:
        return error(f"Modelo desconocido: {modelo}")
    limpiar_bordes = request.form.get("limpiar_bordes") == "1"

    try:
        imagen = Image.open(archivo.stream)
        imagen.load()
    except (UnidentifiedImageError, OSError):
        return error(
            "No se pudo abrir el archivo. Probá con JPG, PNG, WEBP, BMP o TIFF."
        )

    if imagen.mode not in ("RGB", "RGBA"):
        imagen = imagen.convert("RGBA" if "A" in imagen.getbands() else "RGB")

    try:
        sesion = obtener_sesion(modelo)
    except Exception as exc:  # sin internet, descarga cortada, etc.
        return error(f"No se pudo cargar el modelo «{MODELOS[modelo]['nombre']}»: {exc}", 503)

    recorte = rembg().remove(imagen, session=sesion, decontaminate=limpiar_bordes)

    alfa = recorte.getchannel("A").point(lambda a: 255 if a >= UMBRAL_CAJA else 0)
    caja = alfa.getbbox()  # None si el modelo no encontró ningún sujeto

    salida = io.BytesIO()
    recorte.save(salida, "PNG")
    salida.seek(0)

    respuesta = send_file(salida, mimetype="image/png")
    if caja:
        x0, y0, x1, y1 = caja
        respuesta.headers["X-Caja"] = f"{x0},{y0},{x1 - x0},{y1 - y0}"
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


@app.errorhandler(413)
def demasiado_grande(_):
    return error("La imagen es demasiado grande (máximo 60 MB).", 413)


@app.after_request
def aislar_pagina(respuesta):
    # Los mismos encabezados que en vercel.json: dejan que la versión web (?motor=navegador)
    # use varios núcleos del procesador.
    respuesta.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    respuesta.headers["Cross-Origin-Embedder-Policy"] = "require-corp"
    return respuesta


# ---------- Cierre automático (--cerrar-solo) ----------
# Cada pestaña mantiene abierta una conexión a /api/presencia. Al cerrarse la pestaña
# (como sea: cerrarla, cerrar el navegador, que se cuelgue) la conexión se corta, y
# cuando no queda ninguna el servidor se cierra y libera la memoria del modelo.

ESPERA_PRIMERA_PESTANA = 90  # segundos para que el navegador llegue a abrir la página
ESPERA_SIN_PESTANAS = 8  # margen por si la página solo se recargó
INTERVALO_PRESENCIA = 3  # cada cuánto se escribe en la conexión (así se nota si se cortó)

_pestanas_abiertas = 0
_candado_pestanas = threading.Lock()


@app.get("/api/presencia")
def presencia():
    def flujo():
        global _pestanas_abiertas
        with _candado_pestanas:
            _pestanas_abiertas += 1
        try:
            yield "retry: 2000\n\n"
            while True:
                time.sleep(INTERVALO_PRESENCIA)
                yield ": sigo acá\n\n"
        finally:  # el servidor cierra el flujo cuando falla la escritura a la pestaña
            with _candado_pestanas:
                _pestanas_abiertas -= 1

    return Response(flujo(), mimetype="text/event-stream", headers={"Cache-Control": "no-store"})


def vigilar_pestanas():
    hubo_pestana = False
    vacio_desde = time.monotonic()
    while True:
        time.sleep(1)
        ahora = time.monotonic()
        with _candado_pestanas:
            hay_pestanas = _pestanas_abiertas > 0
        if hay_pestanas:
            hubo_pestana = True
            vacio_desde = None
            continue
        vacio_desde = vacio_desde or ahora
        espera = ESPERA_SIN_PESTANAS if hubo_pestana else ESPERA_PRIMERA_PESTANA
        if ahora - vacio_desde >= espera:
            print("  No quedan pestañas abiertas: cerrando.", flush=True)
            # No SIGINT: llega ignorada si la app se lanzó en segundo plano, y en Windows no es
            # un Ctrl+C. No hay nada que guardar (las descargas de modelos se escriben aparte).
            os._exit(0)
            return


def ya_esta_abierta(url):
    try:
        with urllib.request.urlopen(f"{url}/api/estado", timeout=2) as respuesta:
            return json.load(respuesta).get("app") == "recorte-de-fotos"
    except Exception:
        return False


def main():
    puerto = int(os.getenv("PUERTO", "5123"))
    url = f"http://127.0.0.1:{puerto}"
    abrir = "--no-abrir" not in sys.argv

    if ya_esta_abierta(url):
        print(f"  Recorte de Fotos ya estaba abierta en {url}", flush=True)
        if abrir:
            webbrowser.open(url)
        return

    # Solo uso local: sin el aviso de "servidor de desarrollo" ni una línea por pedido.
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    flask.cli.show_server_banner = lambda *args: None
    print(f"\n  Recorte de Fotos listo en {url}\n  (Ctrl+C para cerrar)\n", flush=True)
    threading.Thread(target=rembg, daemon=True).start()  # la página espera en /api/modelos
    if "--cerrar-solo" in sys.argv or EMPAQUETADA:
        threading.Thread(target=vigilar_pestanas, daemon=True).start()
    if abrir:
        # daemon: si el puerto está ocupado por otro programa, no abrir el navegador hacia ese programa.
        temporizador = threading.Timer(1.0, webbrowser.open, [url])
        temporizador.daemon = True
        temporizador.start()
    app.run(host="127.0.0.1", port=puerto, threaded=True)


if __name__ == "__main__":
    main()
