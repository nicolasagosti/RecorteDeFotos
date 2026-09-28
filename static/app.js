import { crearMotor } from "./motor.js";

const $ = (id) => document.getElementById(id);

const FONDOS = {
  transparente: "Transparente",
  blanco: "Blanco",
  negro: "Negro",
  desenfocado: "Foto original desenfocada",
  color: "Color propio",
};
const COLORES_FIJOS = { blanco: "#ffffff", negro: "#000000" };
const CLAVE_PREFERENCIAS = "recorte-de-fotos:preferencias";

const estado = {
  motor: null, // ver motor.js: servidor local o dentro del navegador
  modelos: [],
  modelo: null,
  limpiarBordes: true,
  fondo: "transparente",
  color: "#3b82f6",
  recortar: false,
  vista: "resultado",
  fotos: [],
  seleccionada: null,
  ocupado: false,
  dims: null, // tamaño en píxeles de lo que muestra el visor
};

let siguienteId = 1;
let pegadas = 0;

// ---------- Preferencias (solo comodidad; si falla, se usan las de fábrica) ----------

function cargarPreferencias() {
  try {
    const p = JSON.parse(localStorage.getItem(CLAVE_PREFERENCIAS) || "{}");
    if (typeof p.modelo === "string") estado.modelo = p.modelo;
    if (typeof p.limpiarBordes === "boolean") estado.limpiarBordes = p.limpiarBordes;
    if (p.fondo in FONDOS) estado.fondo = p.fondo;
    if (/^#[0-9a-f]{6}$/i.test(p.color)) estado.color = p.color;
    if (typeof p.recortar === "boolean") estado.recortar = p.recortar;
    if (p.vista === "resultado" || p.vista === "comparar") estado.vista = p.vista;
  } catch { /* sin almacenamiento disponible */ }
}

function guardarPreferencias() {
  const { modelo, limpiarBordes, fondo, color, recortar, vista } = estado;
  try {
    localStorage.setItem(CLAVE_PREFERENCIAS, JSON.stringify({ modelo, limpiarBordes, fondo, color, recortar, vista }));
  } catch { /* sin almacenamiento disponible */ }
}

// ---------- Utilidades ----------

function cargarImagen(url) {
  return new Promise((resolver, rechazar) => {
    const img = new Image();
    img.onload = () => resolver(img);
    img.onerror = () => rechazar(new Error("No se pudo mostrar la imagen."));
    img.src = url;
  });
}

function nombreBase(nombre) {
  const base = (nombre || "").replace(/\.[^.]+$/, "").trim();
  return base || "foto";
}

function esImagen(archivo) {
  return archivo.type.startsWith("image/") || /\.(jpe?g|png|webp|bmp|tiff?|gif)$/i.test(archivo.name);
}

let temporizadorAviso;
function mostrarAviso(texto) {
  const aviso = $("aviso");
  aviso.textContent = texto;
  aviso.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => (aviso.hidden = true), 6000);
}

const actual = () => estado.fotos.find((f) => f.id === estado.seleccionada) || null;
const modeloPorId = (id) => estado.modelos.find((m) => m.id === id);

// ---------- Modelos ----------

async function iniciarMotor() {
  try {
    estado.motor = await crearMotor();
    estado.modelos = estado.motor.modelos;
    if (!modeloPorId(estado.modelo)) estado.modelo = estado.motor.porDefecto;
  } catch (e) {
    mostrarAviso(e.message);
  }
  pintarModelos();
}
const motorListo = iniciarMotor();

function pintarModelos() {
  const nota = $("nota-modelos");
  const web = estado.motor?.tipo === "navegador";
  nota.hidden = !web;
  if (web) {
    nota.textContent = "Se descargan una sola vez y quedan guardados en este navegador." +
      (estado.motor.aceleracion ? "" : " Sin aceleración gráfica (WebGPU) en este navegador: va a tardar un poco más.");
  }

  const contenedor = $("modelos");
  contenedor.replaceChildren();
  for (const m of estado.modelos) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "modelo";
    boton.setAttribute("role", "radio");
    boton.setAttribute("aria-checked", String(m.id === estado.modelo));
    boton.innerHTML =
      '<span class="modelo-cabeza"><span class="modelo-nombre"></span><span class="modelo-estado"></span></span>' +
      '<span class="modelo-detalle"></span>';
    boton.querySelector(".modelo-nombre").textContent = m.nombre;
    boton.querySelector(".modelo-detalle").textContent = m.detalle;
    const etiqueta = boton.querySelector(".modelo-estado");
    etiqueta.textContent = m.descargado ? "✓ Listo" : `↓ ${m.mb} MB`;
    etiqueta.title = m.descargado ? "Ya está descargado" : "Se descarga la primera vez que lo uses";
    etiqueta.classList.toggle("listo", m.descargado);
    boton.addEventListener("click", () => {
      estado.modelo = m.id;
      guardarPreferencias();
      pintarModelos();
      actualizarReprocesar();
    });
    contenedor.append(boton);
  }
}

// ---------- Carga y procesamiento ----------

function agregarArchivos(lista) {
  const imagenes = [...lista].filter(esImagen);
  if (!imagenes.length) {
    if (lista.length) mostrarAviso("Eso no parece una imagen. Probá con JPG, PNG o WEBP.");
    return;
  }
  const primera = siguienteId;
  for (const archivo of imagenes) {
    estado.fotos.push({
      id: siguienteId++,
      archivo,
      nombre: nombreBase(archivo.name),
      urlOriginal: URL.createObjectURL(archivo),
      original: null,
      blobResultado: null,
      urlResultado: null,
      resultado: null,
      caja: null,
      estado: "en-cola",
      mensaje: "",
      error: "",
      modelo: null,
      limpiarBordes: null,
    });
  }
  seleccionar(primera);
  bombear();
}

async function bombear() {
  if (estado.ocupado) return;
  estado.ocupado = true;
  let foto;
  while ((foto = estado.fotos.find((f) => f.estado === "en-cola"))) {
    await procesar(foto);
  }
  estado.ocupado = false;
}

// Cambia solo el texto del aviso: redibujar todo el visor en cada avance sería caro.
function mostrarProgreso(foto, texto) {
  foto.mensaje = texto;
  if (foto.id === estado.seleccionada && foto.estado === "procesando") $("estado-texto").textContent = texto;
}

async function procesar(foto) {
  await motorListo;
  foto.estado = "procesando";
  foto.modelo = estado.modelo;
  foto.limpiarBordes = estado.limpiarBordes;
  foto.mensaje = "Quitando el fondo…";
  refrescar(foto);

  try {
    if (!estado.motor) throw new Error("No se pudo iniciar el procesamiento. Recargá la página.");
    if (!foto.original) {
      // Algunos formatos (TIFF) los procesa el servidor pero el navegador no los muestra.
      foto.original = await cargarImagen(foto.urlOriginal).catch(() => null);
      refrescar(foto);
    }

    const { blob, caja } = await estado.motor.quitarFondo(foto.archivo, {
      modelo: foto.modelo,
      limpiarBordes: foto.limpiarBordes,
      avisar: (texto) => mostrarProgreso(foto, texto),
    });
    const url = URL.createObjectURL(blob);
    const resultado = await cargarImagen(url);

    if (!estado.fotos.includes(foto)) { // la quitaron mientras se procesaba
      URL.revokeObjectURL(url);
      return;
    }
    if (foto.urlResultado) URL.revokeObjectURL(foto.urlResultado);
    Object.assign(foto, {
      blobResultado: blob,
      urlResultado: url,
      resultado,
      caja,
      estado: "listo",
      error: "",
    });
    pintarModelos(); // el modelo ya quedó descargado
    if (!foto.caja) mostrarAviso(`No se encontró ningún sujeto en «${foto.nombre}». Probá con otro modelo.`);
  } catch (e) {
    foto.estado = "error";
    foto.error = e.message;
  }
  refrescar(foto);
}

function reprocesar(foto) {
  if (!foto || foto.estado === "procesando" || foto.estado === "en-cola") return;
  foto.estado = "en-cola";
  refrescar(foto);
  bombear();
}

function quitarFoto(id) {
  const i = estado.fotos.findIndex((f) => f.id === id);
  if (i < 0) return;
  const [foto] = estado.fotos.splice(i, 1);
  URL.revokeObjectURL(foto.urlOriginal);
  if (foto.urlResultado) URL.revokeObjectURL(foto.urlResultado);
  if (estado.seleccionada === id) {
    const vecina = estado.fotos[Math.min(i, estado.fotos.length - 1)];
    estado.seleccionada = vecina ? vecina.id : null;
  }
  pintarMiniaturas();
  pintarVisor();
}

// ---------- Dibujo ----------

function colorDeFondo() {
  if (estado.fondo === "color") return estado.color;
  return COLORES_FIJOS[estado.fondo] || null;
}

// Zona de la imagen a mostrar/exportar, en píxeles del resultado: [x, y, ancho, alto].
function encuadre(foto) {
  const W = foto.resultado.naturalWidth;
  const H = foto.resultado.naturalHeight;
  if (!estado.recortar || !foto.caja) return [0, 0, W, H];
  const [x, y, w, h] = foto.caja;
  const margen = Math.round(Math.max(w, h) * 0.04);
  const x0 = Math.max(0, x - margen);
  const y0 = Math.max(0, y - margen);
  const x1 = Math.min(W, x + w + margen);
  const y1 = Math.min(H, y + h + margen);
  return [x0, y0, x1 - x0, y1 - y0];
}

function dibujarOriginal(ctx, foto, [x, y, w, h], dx = 0, dy = 0, dw = w, dh = h) {
  const o = foto.original;
  if (!o) return;
  const base = foto.resultado || o;
  const sx = o.naturalWidth / base.naturalWidth;
  const sy = o.naturalHeight / base.naturalHeight;
  ctx.drawImage(o, x * sx, y * sy, w * sx, h * sy, dx, dy, dw, dh);
}

// Fondo desenfocado a baja resolución (es borroso igual, y así es rápido con fotos grandes).
function fondoDesenfocado(foto, caja) {
  const [x, y, w, h] = caja;
  const escala = Math.min(1, 800 / Math.max(w, h));
  const aw = Math.max(1, Math.round(w * escala));
  const ah = Math.max(1, Math.round(h * escala));
  const radio = Math.max(2, Math.round(Math.max(aw, ah) * 0.025));
  const m = radio * 2;

  // El fondo con un hueco donde está el sujeto: así el sujeto no deja un halo claro al desenfocar.
  const hueco = document.createElement("canvas");
  hueco.width = aw;
  hueco.height = ah;
  const ch = hueco.getContext("2d");
  dibujarOriginal(ch, foto, caja, 0, 0, aw, ah);
  ch.globalCompositeOperation = "destination-out";
  ch.drawImage(foto.resultado, x, y, w, h, 0, 0, aw, ah);

  const salida = document.createElement("canvas");
  salida.width = aw;
  salida.height = ah;
  const cs = salida.getContext("2d");
  cs.filter = `blur(${radio}px)`;
  // Base: la foto entera, un poco agrandada para que los bordes no queden transparentes.
  dibujarOriginal(cs, foto, caja, -m, -m, aw + 2 * m, ah + 2 * m);
  // Encima, el fondo sin sujeto varias veces para tapar casi todo el halo de la base.
  for (let i = 0; i < 4; i++) cs.drawImage(hueco, 0, 0);
  cs.filter = "none";
  return salida;
}

function componer(foto, lienzo, caja) {
  const [x, y, w, h] = caja;
  lienzo.width = w;
  lienzo.height = h;
  const ctx = lienzo.getContext("2d");
  const color = colorDeFondo();
  const desenfocado = estado.fondo === "desenfocado" && foto.original;

  if (desenfocado) {
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(fondoDesenfocado(foto, caja), 0, 0, w, h);
  } else if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(foto.resultado, x, y, w, h, 0, 0, w, h);
  lienzo.classList.toggle("tablero", !color && !desenfocado);
}

function pintarAntes(foto, caja) {
  const lienzo = $("lienzo-antes");
  lienzo.width = caja[2];
  lienzo.height = caja[3];
  dibujarOriginal(lienzo.getContext("2d"), foto, caja);
}

function ajustarMarco() {
  if (!estado.dims) return;
  const [w, h] = estado.dims;
  const escena = $("escena");
  const k = Math.min(escena.clientWidth / w, escena.clientHeight / h, 2);
  const marco = $("marco");
  marco.style.width = `${Math.max(1, Math.floor(w * k))}px`;
  marco.style.height = `${Math.max(1, Math.floor(h * k))}px`;
}

// ---------- Interfaz ----------

function refrescar(foto) {
  pintarMiniaturas();
  if (foto.id === estado.seleccionada) pintarVisor();
}

function seleccionar(id) {
  estado.seleccionada = id;
  pintarMiniaturas();
  pintarVisor();
  const nodo = nodosMiniatura.get(id);
  if (nodo) nodo.scrollIntoView({ block: "nearest", inline: "nearest" });
}

const nodosMiniatura = new Map();
const ICONO_QUITAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function crearMiniatura(foto) {
  const li = document.createElement("li");
  li.innerHTML =
    '<button type="button" class="miniatura-boton"><img alt=""></button>' +
    '<span class="miniatura-marca"></span>' +
    `<button type="button" class="miniatura-quitar" aria-label="Quitar foto">${ICONO_QUITAR}</button>`;
  const img = li.querySelector("img");
  img.addEventListener("error", () => (img.hidden = true)); // formato que el navegador no muestra
  img.addEventListener("load", () => (img.hidden = false));
  li.querySelector(".miniatura-boton").addEventListener("click", () => seleccionar(foto.id));
  li.querySelector(".miniatura-quitar").addEventListener("click", () => quitarFoto(foto.id));
  return li;
}

function pintarMiniaturas() {
  const lista = $("miniaturas");
  const vivas = new Set(estado.fotos.map((f) => f.id));
  for (const [id, nodo] of nodosMiniatura) {
    if (!vivas.has(id)) {
      nodo.remove();
      nodosMiniatura.delete(id);
    }
  }
  for (const foto of estado.fotos) {
    let li = nodosMiniatura.get(foto.id);
    if (!li) {
      li = crearMiniatura(foto);
      nodosMiniatura.set(foto.id, li);
      lista.append(li);
    }
    li.className = `miniatura ${foto.estado}${foto.id === estado.seleccionada ? " seleccionada" : ""}`;
    const img = li.querySelector("img");
    const src = foto.urlResultado && foto.estado === "listo" ? foto.urlResultado : foto.urlOriginal;
    if (img.getAttribute("src") !== src) img.src = src;
    const marca = li.querySelector(".miniatura-marca");
    marca.innerHTML = foto.estado === "procesando" ? '<span class="girador"></span>' : foto.estado === "error" ? "!" : "";
    const textos = { "en-cola": "en espera", procesando: "procesando", listo: "lista", error: "con error" };
    li.querySelector(".miniatura-boton").setAttribute("aria-label", `${foto.nombre} (${textos[foto.estado]})`);
  }

  const hay = estado.fotos.length > 0;
  $("zona-vacia").hidden = hay;
  $("escenario").hidden = !hay;
  document.querySelector(".tira").hidden = !hay;

  const listas = estado.fotos.filter((f) => f.estado === "listo").length;
  const todas = $("descargar-todas");
  todas.hidden = listas < 2;
  todas.textContent = `Descargar todas (${listas})`;
}

function pintarVisor() {
  const foto = actual();
  const marco = $("marco");
  if (!foto) {
    estado.dims = null;
    $("descargar").disabled = true;
    $("tamano").textContent = "";
    actualizarReprocesar();
    return;
  }

  $("nombre-actual").textContent = foto.archivo.name || foto.nombre;
  const listo = foto.estado === "listo";
  marco.classList.toggle("comparar", listo && estado.vista === "comparar" && !!foto.original);
  marco.classList.toggle("procesando", foto.estado === "procesando" || foto.estado === "en-cola");
  marco.classList.toggle("con-error", foto.estado === "error");

  $("estado-foto").hidden = listo;
  $("estado-texto").textContent =
    foto.estado === "en-cola" ? "En espera…" : foto.estado === "procesando" ? foto.mensaje : foto.error;
  $("reintentar").hidden = foto.estado !== "error";

  if (listo) {
    const caja = encuadre(foto);
    componer(foto, $("lienzo-despues"), caja);
    pintarAntes(foto, caja);
    estado.dims = [caja[2], caja[3]];
    $("tamano").textContent = `${caja[2]} × ${caja[3]} px`;
  } else if (foto.original) {
    const { naturalWidth: w, naturalHeight: h } = foto.original;
    pintarAntes(foto, [0, 0, w, h]);
    estado.dims = [w, h];
    $("tamano").textContent = "";
  } else {
    // Todavía cargando, o un archivo que el navegador no puede mostrar.
    $("lienzo-antes").width = 1;
    $("lienzo-antes").height = 1;
    estado.dims = [800, 600];
    $("tamano").textContent = "";
  }
  $("escena").style.setProperty("--aspecto", `${estado.dims[0]} / ${estado.dims[1]}`);
  ajustarMarco();

  $("descargar").disabled = !listo;
  actualizarReprocesar();
}

function actualizarReprocesar() {
  const foto = actual();
  const boton = $("reprocesar");
  const disponible = foto && (foto.estado === "listo" || foto.estado === "error");
  boton.hidden = !disponible;
  const cambio = disponible && foto.estado === "listo" &&
    (foto.modelo !== estado.modelo || foto.limpiarBordes !== estado.limpiarBordes);
  boton.classList.toggle("destacado", !!cambio);
  boton.title = cambio ? "Cambiaste el modelo o la limpieza de bordes: tocá para aplicarlo a esta foto." : "";
}

function pintarFondos() {
  for (const boton of document.querySelectorAll("[data-fondo]")) {
    boton.setAttribute("aria-checked", String(boton.dataset.fondo === estado.fondo));
  }
  const muestraColor = document.querySelector(".muestra-color");
  muestraColor.classList.toggle("activa", estado.fondo === "color");
  muestraColor.style.setProperty("--m", estado.color);
  $("color-propio").value = estado.color;
  $("fondo-nombre").textContent =
    estado.fondo === "color" ? `Color propio (${estado.color})` : FONDOS[estado.fondo];
}

function pintarVista() {
  for (const boton of document.querySelectorAll("[data-vista]")) {
    boton.setAttribute("aria-checked", String(boton.dataset.vista === estado.vista));
  }
}

// ---------- Descargas ----------

async function blobParaDescargar(foto) {
  const caja = encuadre(foto);
  const sinCambios = estado.fondo === "transparente" && caja[2] === foto.resultado.naturalWidth &&
    caja[3] === foto.resultado.naturalHeight;
  if (sinCambios) return foto.blobResultado; // el PNG tal cual salió del servidor
  const lienzo = document.createElement("canvas");
  componer(foto, lienzo, caja);
  return new Promise((resolver) => lienzo.toBlob(resolver, "image/png"));
}

function bajarArchivo(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function descargar(foto) {
  bajarArchivo(await blobParaDescargar(foto), `${foto.nombre}-sin-fondo.png`);
}

async function descargarTodas() {
  const boton = $("descargar-todas");
  boton.disabled = true;
  const listas = estado.fotos.filter((f) => f.estado === "listo");
  const usados = new Map();
  for (const foto of listas) {
    // Evita que dos fotos con el mismo nombre se pisen.
    const n = (usados.get(foto.nombre) || 0) + 1;
    usados.set(foto.nombre, n);
    const sufijo = n > 1 ? `-${n}` : "";
    bajarArchivo(await blobParaDescargar(foto), `${foto.nombre}${sufijo}-sin-fondo.png`);
    await new Promise((r) => setTimeout(r, 350));
  }
  boton.disabled = false;
}

// ---------- Eventos ----------

function enlazarEventos() {
  const selector = $("selector");
  $("zona-vacia").addEventListener("click", () => selector.click());
  $("agregar").addEventListener("click", () => selector.click());
  selector.addEventListener("change", () => {
    agregarArchivos(selector.files);
    selector.value = "";
  });

  // Arrastrar y soltar en cualquier parte de la ventana.
  const soltar = $("soltar");
  const conArchivos = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  let arrastres = 0;
  addEventListener("dragenter", (e) => {
    if (!conArchivos(e)) return;
    e.preventDefault();
    arrastres++;
    soltar.hidden = false;
  });
  addEventListener("dragover", (e) => { if (conArchivos(e)) e.preventDefault(); });
  addEventListener("dragleave", (e) => {
    if (!conArchivos(e)) return;
    arrastres = Math.max(0, arrastres - 1);
    if (!arrastres) soltar.hidden = true;
  });
  addEventListener("drop", (e) => {
    if (!conArchivos(e)) return;
    e.preventDefault();
    arrastres = 0;
    soltar.hidden = true;
    agregarArchivos(e.dataTransfer.files);
  });

  addEventListener("paste", (e) => {
    const archivos = [...(e.clipboardData?.items || [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean)
      .map((f) => new File([f], `pegada-${++pegadas}.${(f.type.split("/")[1] || "png")}`, { type: f.type }));
    if (archivos.length) {
      e.preventDefault();
      agregarArchivos(archivos);
    }
  });

  addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select") || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = estado.fotos.findIndex((f) => f.id === estado.seleccionada);
    const siguiente = estado.fotos[i + (e.key === "ArrowRight" ? 1 : -1)];
    if (siguiente) {
      e.preventDefault();
      seleccionar(siguiente.id);
    }
  });

  for (const boton of document.querySelectorAll("[data-vista]")) {
    boton.addEventListener("click", () => {
      estado.vista = boton.dataset.vista;
      guardarPreferencias();
      pintarVista();
      pintarVisor();
    });
  }

  $("deslizador").addEventListener("input", (e) => {
    $("marco").style.setProperty("--pos", `${e.target.value}%`);
  });

  for (const boton of document.querySelectorAll("[data-fondo]")) {
    boton.addEventListener("click", () => cambiarFondo(boton.dataset.fondo));
  }
  const colorPropio = $("color-propio");
  colorPropio.addEventListener("click", () => cambiarFondo("color"));
  colorPropio.addEventListener("input", () => {
    estado.color = colorPropio.value;
    cambiarFondo("color");
  });

  $("limpiar-bordes").addEventListener("change", (e) => {
    estado.limpiarBordes = e.target.checked;
    guardarPreferencias();
    actualizarReprocesar();
  });
  $("recortar").addEventListener("change", (e) => {
    estado.recortar = e.target.checked;
    guardarPreferencias();
    pintarVisor();
  });

  $("reprocesar").addEventListener("click", () => reprocesar(actual()));
  $("reintentar").addEventListener("click", () => reprocesar(actual()));
  $("descargar").addEventListener("click", () => { const f = actual(); if (f?.estado === "listo") descargar(f); });
  $("descargar-todas").addEventListener("click", descargarTodas);

  new ResizeObserver(ajustarMarco).observe($("escena"));
}

function cambiarFondo(fondo) {
  estado.fondo = fondo;
  guardarPreferencias();
  pintarFondos();
  pintarVisor();
}

function iniciar() {
  cargarPreferencias();
  $("limpiar-bordes").checked = estado.limpiarBordes;
  $("recortar").checked = estado.recortar;
  pintarFondos();
  pintarVista();
  pintarMiniaturas();
  enlazarEventos();
}

iniciar();
