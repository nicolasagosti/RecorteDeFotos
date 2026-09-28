// Modelos de la versión web: corren dentro del navegador con onnxruntime-web.
// Se descargan de Hugging Face la primera vez y quedan guardados en el navegador.
// Las revisiones están fijadas para que un cambio en esos repositorios no rompa la app.

const IMAGENET_MEDIA = [0.485, 0.456, 0.406];
const IMAGENET_DESVIO = [0.229, 0.224, 0.225];

// Para cada modelo hay dos archivos: uno liviano en fp16 para placas de video (WebGPU)
// y otro para el procesador (WebAssembly), que no se lleva bien con fp16.
export const MODELOS_WEB = [
  {
    id: "isnet-general-use",
    nombre: "General",
    detalle: "Rápido y bueno para casi todo.",
    repo: "Ko033/isnet-general-use-onnx",
    revision: "5349b617911fd60c619b52f32e2b593517b78df3",
    archivos: {
      webgpu: { ruta: "onnx/model_fp16.onnx", mb: 88 },
      wasm: { ruta: "onnx/model_quantized.onnx", mb: 46 },
    },
    entrada: { tipo: "fijo", ancho: 1024, alto: 1024 },
    escala: "maximo", // como rembg: divide por el píxel más brillante
    media: [0.5, 0.5, 0.5],
    desvio: [1, 1, 1],
    salida: { sigmoide: false, normalizar: true },
  },
  {
    id: "birefnet-general-lite",
    nombre: "Alta calidad",
    detalle: "Bordes más precisos (pelo, detalles). Tarda bastante más.",
    repo: "onnx-community/BiRefNet_lite-ONNX",
    revision: "de15b22ba131738a16dff04aab8bdf8dc32e3ac1",
    archivos: {
      webgpu: { ruta: "onnx/model_fp16.onnx", mb: 115 },
      wasm: { ruta: "onnx/model.onnx", mb: 224 },
    },
    entrada: { tipo: "fijo", ancho: 1024, alto: 1024 },
    escala: "maximo",
    media: IMAGENET_MEDIA,
    desvio: IMAGENET_DESVIO,
    salida: { sigmoide: true, normalizar: true },
  },
  {
    id: "modnet",
    nombre: "Personas",
    detalle: "Retratos y fotos de gente. Liviano y rápido.",
    repo: "Xenova/modnet",
    revision: "fa2fa546052fba4c08921230a26cc69a333fca12",
    archivos: {
      webgpu: { ruta: "onnx/model_fp16.onnx", mb: 13 },
      wasm: { ruta: "onnx/model_quantized.onnx", mb: 7 },
    },
    // Lado corto a 512 px y ambos lados múltiplos de 32, como espera MODNet.
    entrada: { tipo: "lado-corto", lado: 512, multiplo: 32, maximo: 2048 },
    escala: 255,
    media: [0.5, 0.5, 0.5],
    desvio: [0.5, 0.5, 0.5],
    salida: { sigmoide: false, normalizar: false },
  },
  {
    id: "isnet-anime",
    nombre: "Dibujos y anime",
    detalle: "Ilustraciones y personajes dibujados.",
    repo: "skytnt/anime-seg",
    revision: "493cb60893f47441b26ec4fb9a306bce9e342982",
    archivos: {
      webgpu: { ruta: "isnetis.onnx", mb: 176 },
      wasm: { ruta: "isnetis.onnx", mb: 176 },
    },
    entrada: { tipo: "fijo", ancho: 1024, alto: 1024 },
    escala: "maximo",
    media: IMAGENET_MEDIA,
    desvio: [1, 1, 1],
    salida: { sigmoide: false, normalizar: true },
  },
];

export const MODELO_WEB_POR_DEFECTO = "isnet-general-use";

export function urlDeModelo(modelo, archivo) {
  return `https://huggingface.co/${modelo.repo}/resolve/${modelo.revision}/${archivo.ruta}`;
}
