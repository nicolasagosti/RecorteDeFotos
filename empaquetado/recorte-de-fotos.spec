# Receta de PyInstaller para la app instalable (Windows, Mac y Linux).
# La arma GitHub Actions (.github/workflows/app.yml) en cada sistema, porque PyInstaller
# no compila para otro sistema que el propio. Para probarla a mano en esta compu:
#   pip install -r requirements.txt pyinstaller
#   pyinstaller --noconfirm empaquetado/recorte-de-fotos.spec
# Queda en dist/ (en Mac, dist/Recorte de Fotos.app).

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, copy_metadata

RAIZ = Path(SPECPATH).parent
ICONO = str(RAIZ / "empaquetado" / "icono.png")  # PyInstaller lo pasa a .ico / .icns

a = Analysis(
    [str(RAIZ / "app.py")],
    datas=[
        (str(RAIZ / "static"), "static"),
        *collect_data_files("rembg"),
        # Varias dependencias leen su propia versión al importarse (pymatting, por ejemplo).
        *copy_metadata("rembg", recursive=True),
    ],
    # pymatting compila con numba y guarda el resultado en caché; numba solo sabe
    # hacerlo si encuentra el .py de cada función, así que va como código fuente.
    module_collection_mode={"pymatting": "py"},
    excludes=["tkinter", "matplotlib", "IPython"],
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="RecorteDeFotos",
    console=False,  # Windows y Mac: sin ventana de terminal (en Linux no cambia nada)
    icon=ICONO,
)
coll = COLLECT(exe, a.binaries, a.datas, name="RecorteDeFotos")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="Recorte de Fotos.app",
        icon=ICONO,
        bundle_identifier="io.github.nicolasagosti.recortedefotos",
        info_plist={
            "CFBundleDisplayName": "Recorte de Fotos",
            "NSHighResolutionCapable": True,
        },
    )
