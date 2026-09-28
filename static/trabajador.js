// Quita el fondo dentro del navegador (versión web, sin servidor).
// Corre en un Worker para que la página no se trabe mientras procesa.

import * as ort from "./vendor/onnxruntime-web-1.30.0/ort.webgpu.bundle.min.mjs";
import { MODELOS_WEB, urlDeModelo } from "./modelos-web.js";

const CACHE_MODELOS = "recorte-de-fotos-modelos";
const UMBRAL_CAJA = 12; // igual que en app.py
const MAXIMO_PARA_LIMPIAR = 16_000_000; // píxeles; más que esto usaría demasiada memoria

ort.env.logLevel = "error";
// Varios hilos solo funcionan con la página aislada (encabezados COOP/COEP).
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8))
  : 1;

let webgpu = null; // null: todavía sin averiguar
const sesiones = new Map(); // id de modelo -> { sesion, backend }

async function hayWebGPU() {
  if (webgpu === null) {
    try {
      const adaptador = await navigator.gpu?.requestAdapter();
      // Los archivos para WebGPU están en fp16.
      webgpu = !!adaptador?.features.has("shader-f16");
    } catch {
      webgpu = false;
    }
  }
  return webgpu;
}

async function abrirCache() {
  try {
    return await caches.open(CACHE_MODELOS);
  } catch {
    return null; // sin Cache API: el modelo se baja cada vez que se abre la página
  }
}

// ---------- Estado inicial ----------

async function describirEstado() {
  const backend = (await hayWebGPU()) ? "webgpu" : "wasm";
  const cache = await abrirCache();
  const modelos = [];
  for (const modelo of MODELOS_WEB) {
    const archivo = modelo.archivos[backend];
    const guardado = await cache?.match(urlDeModelo(modelo, archivo)).catch(() => null);
    modelos.push({ id: modelo.id, mb: archivo.mb, descargado: !!guardado });
  }
  return { backend, hilos: ort.env.wasm.numThreads, modelos };
}

// ---------- Modelos ----------

async function bajarModelo(url, mbAproximados, avisar) {
  const cache = await abrirCache();
  const guardado = await cache?.match(url).catch(() => null);
  if (guardado) return new Uint8Array(await guardado.arrayBuffer());

  let respuesta;
  try {
    respuesta = await fetch(url);
  } catch {
    throw new Error("No se pudo descargar el modelo. Revisá la conexión a internet.");
  }
  if (!respuesta.ok) throw new Error(`No se pudo descargar el modelo (error ${respuesta.status}).`);

  const total = Number(respuesta.headers.get("Content-Length")) || mbAproximados * 1e6;
  const lector = respuesta.body.getReader();
  const partes = [];
  let recibido = 0;
  let ultimoAviso = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    partes.push(value);
    recibido += value.byteLength;
    if (performance.now() - ultimoAviso > 250) {
      ultimoAviso = performance.now();
      avisar({ fase: "descargando", recibido, total });
    }
  }
  const bytes = new Uint8Array(recibido);
  let posicion = 0;
  for (const parte of partes) {
    bytes.set(parte, posicion);
    posicion += parte.byteLength;
  }
  try {
    await cache?.put(url, new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  } catch {
    // Sin espacio para guardarlo: funciona igual, pero se vuelve a bajar la próxima vez.
  }
  return bytes;
}

async function crearSesion(modelo, backend, avisar) {
  const archivo = modelo.archivos[backend];
  const bytes = await bajarModelo(urlDeModelo(modelo, archivo), archivo.mb, avisar);
  avisar({ fase: "preparando" });
  const sesion = await ort.InferenceSession.create(bytes, {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
  });
  return { sesion, backend };
}

async function obtenerSesion(modelo, avisar) {
  if (sesiones.has(modelo.id)) return sesiones.get(modelo.id);
  let resultado = null;
  if (await hayWebGPU()) {
    try {
      resultado = await crearSesion(modelo, "webgpu", avisar);
    } catch (e) {
      console.warn("WebGPU no funcionó, sigo con WebAssembly:", e);
      webgpu = false;
    }
  }
  resultado ??= await crearSesion(modelo, "wasm", avisar);
  sesiones.set(modelo.id, resultado);
  return resultado;
}

// ---------- Conversión fp16 ----------

function aFloat16(valores) {
  if (typeof Float16Array !== "undefined") return new Float16Array(valores);
  const bits = new Uint16Array(valores.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < valores.length; i++) {
    f32[0] = valores[i];
    const x = u32[0];
    const signo = (x >>> 16) & 0x8000;
    const exponente = ((x >>> 23) & 0xff) - 112;
    if (exponente <= 0) bits[i] = signo;
    else if (exponente >= 31) bits[i] = signo | 0x7c00;
    else bits[i] = signo | (exponente << 10) | ((x >>> 13) & 0x3ff);
  }
  return bits;
}

function aFloat32(tensor) {
  const datos = tensor.data;
  if (datos instanceof Float32Array) return datos;
  if (tensor.type !== "float16" || !(datos instanceof Uint16Array)) return Float32Array.from(datos);
  const salida = new Float32Array(datos.length);
  for (let i = 0; i < datos.length; i++) {
    const h = datos[i];
    const signo = h & 0x8000 ? -1 : 1;
    const exponente = (h >> 10) & 0x1f;
    const mantisa = h & 0x3ff;
    salida[i] = exponente === 0
      ? signo * mantisa * 2 ** -24
      : exponente === 31
        ? (mantisa ? NaN : signo * Infinity)
        : signo * (1 + mantisa / 1024) * 2 ** (exponente - 15);
  }
  return salida;
}

// ---------- Entrada y salida del modelo ----------

function tamanoDeEntrada(modelo, ancho, alto) {
  const e = modelo.entrada;
  if (e.tipo === "fijo") return [e.ancho, e.alto];
  let k = e.lado / Math.min(ancho, alto);
  if (Math.max(ancho, alto) * k > e.maximo) k = e.maximo / Math.max(ancho, alto);
  const ajustar = (v) => Math.max(e.multiplo, Math.floor((v * k) / e.multiplo) * e.multiplo);
  return [ajustar(ancho), ajustar(alto)];
}

function prepararEntrada(bitmap, modelo) {
  const [ancho, alto] = tamanoDeEntrada(modelo, bitmap.width, bitmap.height);
  const lienzo = new OffscreenCanvas(ancho, alto);
  const ctx = lienzo.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, ancho, alto);
  const px = ctx.getImageData(0, 0, ancho, alto).data;

  let escala = modelo.escala;
  if (escala === "maximo") {
    escala = 1;
    for (let i = 0; i < px.length; i += 4) {
      escala = Math.max(escala, px[i], px[i + 1], px[i + 2]);
    }
  }
  const n = ancho * alto;
  const datos = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const media = modelo.media[c];
    const desvio = modelo.desvio[c];
    for (let i = 0; i < n; i++) datos[c * n + i] = (px[i * 4 + c] / escala - media) / desvio;
  }
  return { datos, dims: [1, 3, alto, ancho] };
}

function tensorPara(sesion, { datos, dims }) {
  const tipo = sesion.inputMetadata?.[0]?.type ?? "float32";
  return tipo === "float16"
    ? new ort.Tensor("float16", aFloat16(datos), dims)
    : new ort.Tensor("float32", datos, dims);
}

async function inferir(modelo, entrada, avisar) {
  let { sesion, backend } = await obtenerSesion(modelo, avisar);
  avisar({ fase: "procesando", backend });
  try {
    const salidas = await sesion.run({ [sesion.inputNames[0]]: tensorPara(sesion, entrada) });
    return salidas[sesion.outputNames[0]];
  } catch (e) {
    if (backend !== "webgpu") throw e;
    console.warn("WebGPU falló al procesar, reintento con WebAssembly:", e);
    webgpu = false;
    sesiones.delete(modelo.id);
    sesion.release().catch(() => {});
    ({ sesion } = await obtenerSesion(modelo, avisar));
    avisar({ fase: "procesando", backend: "wasm" });
    const salidas = await sesion.run({ [sesion.inputNames[0]]: tensorPara(sesion, entrada) });
    return salidas[sesion.outputNames[0]];
  }
}

// La máscara que devuelve el modelo, como imagen gris opaca (así se escala sin sorpresas).
function imagenDeMascara(tensor, modelo) {
  const alto = tensor.dims.at(-2);
  const ancho = tensor.dims.at(-1);
  const n = ancho * alto;
  const crudos = aFloat32(tensor);
  const valores = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    valores[i] = modelo.salida.sigmoide ? 1 / (1 + Math.exp(-crudos[i])) : crudos[i];
  }
  let minimo = 0;
  let maximo = 1;
  if (modelo.salida.normalizar) {
    minimo = Infinity;
    maximo = -Infinity;
    for (let i = 0; i < n; i++) {
      if (valores[i] < minimo) minimo = valores[i];
      if (valores[i] > maximo) maximo = valores[i];
    }
  }
  const rango = maximo - minimo || 1;
  const gris = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = ((valores[i] - minimo) / rango) * 255;
    gris[i * 4] = gris[i * 4 + 1] = gris[i * 4 + 2] = v;
    gris[i * 4 + 3] = 255;
  }
  return new ImageData(gris, ancho, alto);
}

function escalarMascara(mascara, ancho, alto) {
  const chica = new OffscreenCanvas(mascara.width, mascara.height);
  chica.getContext("2d").putImageData(mascara, 0, 0);
  const grande = new OffscreenCanvas(ancho, alto);
  const ctx = grande.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(chica, 0, 0, ancho, alto);
  return ctx.getImageData(0, 0, ancho, alto).data;
}

// ---------- Limpieza del halo ----------

// Promedio en una ventana de k×k (como cv2.blur); en los bordes promedia lo que hay.
function desenfocar(origen, ancho, alto, k, temporal, destino) {
  const antes = (k - 1) >> 1;
  const despues = k - 1 - antes;
  for (let y = 0; y < alto; y++) {
    const fila = y * ancho;
    let suma = 0;
    for (let x = 0; x <= despues && x < ancho; x++) suma += origen[fila + x];
    for (let x = 0; x < ancho; x++) {
      const x0 = x - antes;
      const x1 = x + despues;
      temporal[fila + x] = suma / ((x1 >= ancho ? ancho - 1 : x1) - (x0 < 0 ? 0 : x0) + 1);
      if (x1 + 1 < ancho) suma += origen[fila + x1 + 1];
      if (x0 >= 0) suma -= origen[fila + x0];
    }
  }
  const sumas = new Float64Array(ancho);
  for (let y = 0; y <= despues && y < alto; y++) {
    for (let x = 0; x < ancho; x++) sumas[x] += temporal[y * ancho + x];
  }
  for (let y = 0; y < alto; y++) {
    const y0 = y - antes;
    const y1 = y + despues;
    const cuenta = (y1 >= alto ? alto - 1 : y1) - (y0 < 0 ? 0 : y0) + 1;
    const fila = y * ancho;
    for (let x = 0; x < ancho; x++) destino[fila + x] = sumas[x] / cuenta;
    if (y1 + 1 < alto) {
      const entra = (y1 + 1) * ancho;
      for (let x = 0; x < ancho; x++) sumas[x] += temporal[entra + x];
    }
    if (y0 >= 0) {
      const sale = y0 * ancho;
      for (let x = 0; x < ancho; x++) sumas[x] -= temporal[sale + x];
    }
  }
  return destino;
}

// Estima el color real del sujeto en los bordes semitransparentes, para que no quede
// mezclado con el fondo viejo ("blur fusion", Forte y Pitié 2021: dos pasadas, 90 y 6 px).
function limpiarHalo(px, ancho, alto) {
  const n = ancho * alto;
  let hayBordes = false;
  const alfa = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3];
    alfa[i] = a / 255;
    if (a > 0 && a < 255) hayBordes = true;
  }
  if (!hayBordes) return;

  const temporal = new Float32Array(n);
  const auxiliar = new Float32Array(n);
  const alfaBorrosa = new Float32Array(n);
  const frente = new Float32Array(n);
  const fondo = new Float32Array(n);
  const frenteBorroso = new Float32Array(n);
  const fondoBorroso = new Float32Array(n);

  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) frente[i] = fondo[i] = px[i * 4 + c] / 255;
    for (const k of [90, 6]) {
      desenfocar(alfa, ancho, alto, k, temporal, alfaBorrosa);
      for (let i = 0; i < n; i++) auxiliar[i] = frente[i] * alfa[i];
      desenfocar(auxiliar, ancho, alto, k, temporal, frenteBorroso);
      for (let i = 0; i < n; i++) auxiliar[i] = fondo[i] * (1 - alfa[i]);
      desenfocar(auxiliar, ancho, alto, k, temporal, fondoBorroso);
      for (let i = 0; i < n; i++) {
        const a = alfa[i];
        const f = frenteBorroso[i] / (alfaBorrosa[i] + 1e-5);
        const b = fondoBorroso[i] / (1 - alfaBorrosa[i] + 1e-5);
        const estimado = f + a * (px[i * 4 + c] / 255 - a * f - (1 - a) * b);
        frente[i] = estimado < 0 ? 0 : estimado > 1 ? 1 : estimado;
        fondo[i] = b;
      }
    }
    for (let i = 0; i < n; i++) {
      const a = px[i * 4 + 3];
      if (a > 0 && a < 255) px[i * 4 + c] = frente[i] * 255;
    }
  }
}

function calcularCaja(px, ancho, alto) {
  let x0 = ancho;
  let y0 = alto;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < alto; y++) {
    const fila = y * ancho * 4;
    for (let x = 0; x < ancho; x++) {
      if (px[fila + x * 4 + 3] >= UMBRAL_CAJA) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
  }
  return x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

// ---------- Proceso completo ----------

async function procesar({ bitmap, modelo: idModelo, limpiarBordes }, avisar) {
  const modelo = MODELOS_WEB.find((m) => m.id === idModelo);
  if (!modelo) throw new Error(`Modelo desconocido: ${idModelo}`);
  const { width: ancho, height: alto } = bitmap;

  const salida = await inferir(modelo, prepararEntrada(bitmap, modelo), avisar);
  const mascara = escalarMascara(imagenDeMascara(salida, modelo), ancho, alto);

  const lienzo = new OffscreenCanvas(ancho, alto);
  const ctx = lienzo.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const imagen = ctx.getImageData(0, 0, ancho, alto);
  const px = imagen.data;
  for (let i = 0; i < ancho * alto; i++) px[i * 4 + 3] = (mascara[i * 4] * px[i * 4 + 3]) / 255;

  if (limpiarBordes && ancho * alto <= MAXIMO_PARA_LIMPIAR) {
    avisar({ fase: "bordes" });
    limpiarHalo(px, ancho, alto);
  }
  ctx.putImageData(imagen, 0, 0);

  return {
    blob: await lienzo.convertToBlob({ type: "image/png" }),
    caja: calcularCaja(px, ancho, alto),
  };
}

function mensajeDeError(e) {
  const texto = String(e?.message || e);
  if (/memory|alloc|Aborted|out of bounds/i.test(texto)) {
    return "Esta foto es demasiado grande para este dispositivo. Probá con una más chica o con el modelo General.";
  }
  return e instanceof Error && !/^\w+Error:|onnx|ort/i.test(texto) ? texto : `No se pudo procesar la foto (${texto}).`;
}

self.addEventListener("message", async ({ data }) => {
  const { id, tipo } = data;
  const avisar = (progreso) => self.postMessage({ id, tipo: "progreso", ...progreso });
  try {
    const respuesta = tipo === "estado" ? await describirEstado() : await procesar(data, avisar);
    self.postMessage({ id, tipo: "listo", ...respuesta });
  } catch (e) {
    console.error(e);
    self.postMessage({ id, tipo: "error", mensaje: mensajeDeError(e) });
  }
});
