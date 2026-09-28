// Dónde se quita el fondo:
//  - "servidor": la app local (app.py) procesa con rembg en Python.
//  - "navegador": la versión web (por ejemplo en Vercel) procesa dentro del navegador.
// Se usa el servidor si responde; si no, el navegador. Con ?motor=navegador se fuerza el segundo.

import { MODELOS_WEB, MODELO_WEB_POR_DEFECTO } from "./modelos-web.js";

export async function crearMotor() {
  if (new URLSearchParams(location.search).get("motor") !== "navegador") {
    const servidor = await motorServidor().catch(() => null);
    if (servidor) return servidor;
  }
  return motorNavegador();
}

// ---------- Servidor local ----------

const APP_CERRADA = "La aplicación se cerró. Abrila de nuevo desde el menú (o con ./iniciar.sh) y recargá esta página.";

async function leerError(respuesta) {
  try {
    const datos = await respuesta.json();
    if (datos.error) return datos.error;
  } catch { /* no era JSON */ }
  return `El servidor respondió con un error (${respuesta.status}).`;
}

async function motorServidor() {
  const respuesta = await fetch("/api/modelos");
  if (!respuesta.ok || !respuesta.headers.get("Content-Type")?.includes("json")) return null;
  const datos = await respuesta.json();

  // Mientras esta conexión siga abierta, el servidor sabe que la pestaña está en uso.
  // Abierta desde el menú, la app se cierra sola cuando ya no queda ninguna pestaña.
  new EventSource("/api/presencia");

  return {
    tipo: "servidor",
    modelos: datos.modelos,
    porDefecto: datos.por_defecto,

    async quitarFondo(archivo, { modelo, limpiarBordes, avisar }) {
      const m = datos.modelos.find((x) => x.id === modelo);
      avisar(m && !m.descargado
        ? `Descargando el modelo «${m.nombre}» (${m.mb} MB). Esto pasa solo la primera vez…`
        : "Quitando el fondo…");

      const formulario = new FormData();
      formulario.append("imagen", archivo, archivo.name || "foto.png");
      formulario.append("modelo", modelo);
      formulario.append("limpiar_bordes", limpiarBordes ? "1" : "0");

      let respuesta;
      try {
        respuesta = await fetch("/api/quitar-fondo", { method: "POST", body: formulario });
      } catch {
        throw new Error(APP_CERRADA);
      }
      if (!respuesta.ok) throw new Error(await leerError(respuesta));

      const caja = respuesta.headers.get("X-Caja");
      if (m) m.descargado = true;
      return { blob: await respuesta.blob(), caja: caja ? caja.split(",").map(Number) : null };
    },
  };
}

// ---------- Dentro del navegador ----------

function textoDeProgreso(progreso, modelo) {
  if (progreso.fase === "descargando") {
    const porcentaje = Math.min(99, Math.floor((progreso.recibido / progreso.total) * 100));
    const mb = Math.round(progreso.total / 1e6);
    return `Descargando el modelo «${modelo.nombre}»: ${porcentaje} % de ${mb} MB. Solo pasa la primera vez…`;
  }
  if (progreso.fase === "preparando") return `Preparando el modelo «${modelo.nombre}»…`;
  if (progreso.fase === "bordes") return "Limpiando los bordes…";
  return "Quitando el fondo…";
}

async function motorNavegador() {
  const trabajador = new Worker(new URL("./trabajador.js", import.meta.url), { type: "module" });
  const pendientes = new Map();
  let siguienteId = 1;

  const pedir = (mensaje, transferir = [], alProgresar = null) =>
    new Promise((resolver, rechazar) => {
      const id = siguienteId++;
      pendientes.set(id, { resolver, rechazar, alProgresar });
      trabajador.postMessage({ ...mensaje, id }, transferir);
    });

  trabajador.addEventListener("message", ({ data }) => {
    const pendiente = pendientes.get(data.id);
    if (!pendiente) return;
    if (data.tipo === "progreso") {
      pendiente.alProgresar?.(data);
      return;
    }
    pendientes.delete(data.id);
    if (data.tipo === "error") pendiente.rechazar(new Error(data.mensaje));
    else pendiente.resolver(data);
  });
  trabajador.addEventListener("error", () => {
    const error = new Error("Este navegador no puede procesar fotos. Probá con Chrome, Edge, Firefox o Safari actualizados.");
    for (const pendiente of pendientes.values()) pendiente.rechazar(error);
    pendientes.clear();
  });

  const inicial = await pedir({ tipo: "estado" });
  const modelos = MODELOS_WEB.map((m) => {
    const { mb, descargado } = inicial.modelos.find((x) => x.id === m.id);
    return { id: m.id, nombre: m.nombre, detalle: m.detalle, mb, descargado };
  });

  return {
    tipo: "navegador",
    aceleracion: inicial.backend === "webgpu",
    modelos,
    porDefecto: MODELO_WEB_POR_DEFECTO,

    async quitarFondo(archivo, { modelo, limpiarBordes, avisar }) {
      const m = modelos.find((x) => x.id === modelo);
      avisar(m && !m.descargado ? textoDeProgreso({ fase: "descargando", recibido: 0, total: m.mb * 1e6 }, m) : "Quitando el fondo…");
      let bitmap;
      try {
        bitmap = await createImageBitmap(archivo, { imageOrientation: "from-image" });
      } catch {
        throw new Error("El navegador no puede abrir este formato. Probá con JPG, PNG o WEBP.");
      }
      const resultado = await pedir(
        { tipo: "procesar", bitmap, modelo, limpiarBordes },
        [bitmap],
        (progreso) => avisar(textoDeProgreso(progreso, m)),
      );
      if (m) m.descargado = true;
      return { blob: resultado.blob, caja: resultado.caja };
    },
  };
}
