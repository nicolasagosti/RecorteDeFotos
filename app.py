"""Recorte de Fotos: servidor local que quita el fondo de las fotos con rembg.

Uso:  ./iniciar.sh   (o  .venv/bin/python app.py)
Abre el navegador en http://127.0.0.1:5123. Todo se procesa en esta computadora.

Opciones:
  --no-abrir     no abre el navegador
  --cerrar-solo  se cierra cuando no queda ninguna pestaña de la app abierta
                 (lo usa el ícono del menú, que no tiene terminal para hacer Ctrl+C)
"""

import io
import json
import logging
import os
import signal
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
# Los modelos se guardan dentro del proyecto, no en ~/.rembg.
os.environ.setdefault("REMBG_HOME", str(BASE_DIR / "modelos"))

import flask.cli  # noqa: E402
from flask import Flask, Response, jsonify, request, send_file  # noqa: E402
from PIL import Image, UnidentifiedImageError  # noqa: E402
from rembg import new_session, remove  # noqa: E402
from rembg.sessions import sessions as SESIONES_REMBG  # noqa: E402

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

app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 60 * 1024 * 1024

_sesiones = {}
_candado_sesiones = threading.Lock()


def esta_descargado(modelo):
    archivo = f"{modelo}.onnx"
    return SESIONES_REMBG[modelo].resolve_existing(archivo) is not None


def obtener_sesion(modelo):
    # La primera vez descarga el modelo; el candado evita descargarlo dos veces.
    with _candado_sesiones:
        if modelo not in _sesiones:
            _sesiones[modelo] = new_session(modelo)
        return _sesiones[modelo]


def error(mensaje, codigo=400):
    return jsonify({"error": mensaje}), codigo


@app.get("/")
def inicio():
    return app.send_static_file("index.html")


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

    recorte = remove(imagen, session=sesion, decontaminate=limpiar_bordes)

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
            os.kill(os.getpid(), signal.SIGINT)  # igual que Ctrl+C: cierre ordenado
            return


def ya_esta_abierta(url):
    try:
        with urllib.request.urlopen(f"{url}/api/modelos", timeout=1) as respuesta:
            return "modelos" in json.load(respuesta)
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
    if "--cerrar-solo" in sys.argv:
        threading.Thread(target=vigilar_pestanas, daemon=True).start()
    if abrir:
        threading.Timer(1.0, webbrowser.open, [url]).start()
    app.run(host="127.0.0.1", port=puerto, threaded=True)


if __name__ == "__main__":
    main()
