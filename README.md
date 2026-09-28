# Recorte de Fotos

Aplicación para quitarle el fondo a fotos. Las fotos nunca se suben a ningún lado: se procesan
en tu computadora o en tu celular.

Tiene dos formas de usarse, con la misma página:

- **Versión web** (la de Vercel): todo corre dentro del navegador con
  [onnxruntime-web](https://onnxruntime.ai/docs/tutorials/web/). Los modelos se bajan de Hugging Face
  la primera vez y quedan guardados en el navegador. Usa la placa de video (WebGPU) si el navegador
  la ofrece; si no, el procesador (WebAssembly).
- **Versión local** (Python): un servidor en tu compu con [rembg](https://github.com/danielgatis/rembg).
  Es más rápida en computadoras sin WebGPU y acepta más formatos (BMP, TIFF).

La página elige sola: si la sirve `app.py`, usa Python; si no, procesa en el navegador.

## Versión web

Son archivos estáticos en `static/`. Para probarla en tu compu con el servidor local, abrí
<http://127.0.0.1:5123/?motor=navegador>.

### Publicar en Vercel

1. En <https://vercel.com/new>, importá este repositorio de GitHub.
2. Tocá **Deploy** sin cambiar nada: `vercel.json` ya indica que se publique solo `static/`
   (y `.vercelignore` deja afuera la parte de Python, que Vercel no puede correr).

Cada `git push` a `main` vuelve a publicar la página.

| Modelo          | Archivo (Hugging Face)                                                            | Licencia   |
| --------------- | --------------------------------------------------------------------------------- | ---------- |
| General         | [Ko033/isnet-general-use-onnx](https://huggingface.co/Ko033/isnet-general-use-onnx) (ISNet) | Apache-2.0 |
| Alta calidad    | [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) | MIT        |
| Personas        | [Xenova/modnet](https://huggingface.co/Xenova/modnet)                              | Apache-2.0 |
| Dibujos y anime | [skytnt/anime-seg](https://huggingface.co/skytnt/anime-seg)                        | Apache-2.0 |

## Versión local

Desde el menú de aplicaciones: **Gráficos → Recorte de Fotos** (o buscá "Recorte" o "fondo").
Se abre en el navegador y se cierra sola unos segundos después de que cerrás la pestaña.
Si ya está abierta, el ícono solo abre otra pestaña.

Desde la terminal:

```bash
./iniciar.sh
```

Se abre el navegador en <http://127.0.0.1:5123>. Así se cierra con Ctrl+C en la terminal.

Arrastrá fotos, elegilas con un clic o pegalas con Ctrl+V.

- **Cómo recortar:** elegí el modelo según la foto. *General* ya viene descargado; los otros se descargan
  solos la primera vez que los uses (unos 170–210 MB cada uno, quedan en `modelos/`).
- **Limpiar halo de color:** saca el borde del color del fondo viejo alrededor del pelo y los bordes suaves.
  Si cambiás el modelo o esta opción, tocá *Volver a procesar* para aplicarlo a la foto que estás viendo.
- **Fondo nuevo:** transparente, blanco, negro, un color a elección o la misma foto desenfocada.
- **Ajustar al sujeto:** corta los bordes vacíos y deja un margen chico.
- **Descargar PNG** baja la foto que estás viendo; **Descargar todas** baja todas con el fondo y encuadre elegidos.
- Con las flechas ← → del teclado pasás de una foto a otra.

### Instalación (si movés la carpeta a otra compu)

```bash
./instalar.sh
```

Crea el entorno `.venv` e instala las dependencias (`rembg` y `flask`). Necesita Python 3.10 o más nuevo.

### Opciones

- Otro puerto: `PUERTO=8080 ./iniciar.sh`
- Sin abrir el navegador automáticamente: `./iniciar.sh --no-abrir`
- Que se cierre sola al cerrar la pestaña (lo que usa el ícono del menú): `./iniciar.sh --cerrar-solo`

El ícono del menú está en `~/.local/share/applications/recorte-de-fotos.desktop`. Si movés esta
carpeta, actualizá ahí las rutas (o borrá ese archivo para sacar el ícono).
