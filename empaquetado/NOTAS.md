Quitale el fondo a tus fotos sin subirlas a ningún lado: todo se procesa en tu computadora.

A diferencia de la [versión web](https://recorte-de-fotos.vercel.app), la app no depende del navegador: el modelo **Alta calidad** trabaja con toda la resolución.

## Qué archivo bajar

| Tu compu | Archivo |
| --- | --- |
| Windows 10 u 11 | `RecorteDeFotos-Windows.zip` |
| Mac con chip Apple (M1, M2, M3, M4…) | `RecorteDeFotos-Mac-AppleSilicon.zip` |
| Mac con procesador Intel | `RecorteDeFotos-Mac-Intel.zip` |
| Linux (Ubuntu 22.04, Debian 12, Fedora 36 o más nuevos) | `RecorteDeFotos-Linux.tar.gz` |

¿Tu Mac tiene chip Apple o Intel? Menú  → **Acerca de esta Mac**: dice "Chip Apple M…" o "Procesador Intel…".

## Instalar

### Windows

1. Clic derecho en el zip → **Extraer todo**.
2. Entrá a la carpeta `RecorteDeFotos` y hacé doble clic en `RecorteDeFotos.exe`.
3. La primera vez Windows muestra "Windows protegió su PC": tocá **Más información** → **Ejecutar de todas formas**. Ese aviso aparece con cualquier programa que no esté firmado con un certificado pago.

### Mac

1. Doble clic en el zip y arrastrá **Recorte de Fotos** a **Aplicaciones**.
2. La primera vez macOS la bloquea porque no está firmada por Apple. Andá a **Configuración del Sistema → Privacidad y seguridad**, bajá hasta el aviso sobre "Recorte de Fotos" y tocá **Abrir igualmente**.

### Linux

```bash
tar xzf RecorteDeFotos-Linux.tar.gz
./RecorteDeFotos/RecorteDeFotos
```

## Usarla

- Se abre en tu navegador. La primera vez tarda unos 30 segundos en mostrar los modelos; las siguientes, un par de segundos.
- Cada modelo se descarga la primera vez que lo usás (entre 170 y 210 MB).
- **Alta calidad** necesita unos 7 GB de memoria libre.
- Se cierra sola unos segundos después de que cerrás la pestaña.

## Dónde guarda los modelos

- Windows: `%LOCALAPPDATA%\RecorteDeFotos`
- Mac: `~/Library/Application Support/RecorteDeFotos`
- Linux: `~/.local/share/RecorteDeFotos`

Para desinstalarla, borrá la app y esa carpeta.
