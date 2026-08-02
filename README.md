<div align="center">

```
██╗   ██╗███████╗███╗   ██╗███████╗██╗  ██╗ ██████╗
██║   ██║██╔════╝████╗  ██║██╔════╝██║ ██╔╝██╔═══██╗
██║   ██║█████╗  ██╔██╗ ██║█████╗  █████╔╝ ██║   ██║
╚██╗ ██╔╝██╔══╝  ██║╚██╗██║██╔══╝  ██╔═██╗ ██║   ██║
 ╚████╔╝ ███████╗██║ ╚████║███████╗██║  ██╗╚██████╔╝
  ╚═══╝  ╚══════╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝
```

**Andamiá proyectos con arquitectura hexagonal y corré herramientas con IA, todo desde la terminal.**

[![Licencia MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)
[![Node 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![macOS · Linux · Windows](https://img.shields.io/badge/plataformas-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-lightgrey.svg)](#instalación)

</div>

---

## Qué es veneko

Una CLI que hace dos cosas bien:

1. **Genera proyectos** ya estructurados —arquitectura hexagonal, base de datos elegida, git inicializado y dependencias instaladas— en vez de arrancar de un template vacío.
2. **Convierte y descarga cosas** desde la terminal: documentos a Markdown, PDFs escaneados a Markdown usando un modelo de visión, y video o audio de cientos de sitios.

Todo se maneja desde un menú interactivo. Si preferís comandos directos, también están.

---

## Instalación

> [!NOTE]
> veneko necesita **Node.js 22 o superior** en cualquier plataforma. El instalador lo verifica y te dice cómo instalarlo si falta. Mirá [Requisitos](#requisitos) antes de arrancar.

### macOS y Linux

```bash
curl -fsSL https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/install.ps1 | iex
```

Eso es todo. Abrí una terminal nueva y escribí `veneko`.

### Qué hace el instalador, paso a paso

No es una caja negra. Estos son los nueve pasos que vas a ver en pantalla:

| # | Paso | Qué hace |
|---|------|----------|
| 1 | Verifica la máquina | Sistema operativo, Node.js 22+, npm. Si algo falta, corta ahí y te da el comando exacto para tu sistema. |
| 2 | Resuelve la versión | Consulta el último release publicado en GitHub. Si todavía no hay ninguno, usa la rama por defecto. |
| 3 | Descarga | Baja el código fuente del release y lo extrae en una carpeta temporal. |
| 4 | Instala dependencias JS | `npm ci` con el lockfile del repo, así la instalación es reproducible. |
| 5 | Compila | Genera el bundle con tsup y descarta las dependencias de build. |
| 6 | Instala | Mueve todo a su lugar definitivo y escribe el lanzador. |
| 7 | Configura el PATH | Agrega el lanzador a tu shell (zsh, bash, fish) o al PATH de usuario en Windows. |
| 8 | Herramientas de Python | Instala `markitdown` y `yt-dlp` de forma aislada con pipx. |
| 9 | ffmpeg | Lo instala con Homebrew o winget si lo autorizás; si no, te deja el comando. |

Si algo falla, el instalador te dice **en qué paso** fue, muestra las últimas líneas del log, deja el log completo en disco y **restaura la instalación anterior**. Nunca te deja a medio camino.

### Dónde queda todo

| | macOS y Linux | Windows |
|---|---|---|
| Aplicación | `~/.veneko/app` | `%LOCALAPPDATA%\veneko\app` |
| Lanzador | `~/.local/bin/veneko` | `%LOCALAPPDATA%\veneko\bin\veneko.cmd` |
| Configuración | `~/.veneko/config.json` | `%USERPROFILE%\.veneko\config.json` |

Nada se escribe fuera de tu carpeta de usuario y **ningún paso pide `sudo`**.

### Opciones del instalador

Si preferís descargar el script y correrlo con opciones:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/install.sh -o install.sh
bash install.sh --help
```

| Opción | Para qué sirve |
|--------|----------------|
| `-y`, `--yes` | No pregunta nada; toma el valor por defecto en cada decisión. |
| `--version TAG` | Instala un release puntual, por ejemplo `--version v1.2.0`. |
| `--prefix DIR` | Cambia la carpeta de instalación. |
| `--bin-dir DIR` | Cambia dónde queda el lanzador. |
| `--no-python` | Se saltea markitdown y yt-dlp. |
| `--no-ffmpeg` | Se saltea ffmpeg. |
| `--no-path` | No toca la configuración de tu shell. |
| `--verbose` | Muestra la salida completa de cada comando. |

En Windows son las mismas con sintaxis de PowerShell: `-Yes`, `-Release`, `-Prefix`, `-NoPython`, `-NoFfmpeg`, `-NoPath`, `-ShowOutput`.

#### Con el one-liner

Un comando con pipe no puede recibir flags, así que **cada opción también se lee del entorno**:

| Variable | Equivale a |
|----------|-----------|
| `VENEKO_HOME` | `--prefix` |
| `VENEKO_BIN_DIR` | `--bin-dir` |
| `VENEKO_VERSION` | `--version` |
| `VENEKO_YES=1` | `--yes` |
| `VENEKO_NO_PYTHON=1` | `--no-python` |
| `VENEKO_NO_FFMPEG=1` | `--no-ffmpeg` |
| `VENEKO_NO_PATH=1` | `--no-path` |
| `VENEKO_VERBOSE=1` | `--verbose` |

```bash
# macOS / Linux — instalar sin tocar Python
curl -fsSL https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/install.sh | VENEKO_NO_PYTHON=1 bash
```

```powershell
# Windows — lo mismo
$env:VENEKO_NO_PYTHON = '1'
irm https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/install.ps1 | iex
```

### Instalar desde el ZIP del release

En cada [release](https://github.com/ChristianVeneko/veneko-cli/releases) GitHub adjunta el **Source code (zip)**. Si lo descargaste a mano:

```bash
unzip veneko-cli-1.0.0.zip && cd veneko-cli-1.0.0
bash scripts/install.sh          # macOS / Linux
```

```powershell
Expand-Archive veneko-cli-1.0.0.zip -DestinationPath . ; cd veneko-cli-1.0.0
.\scripts\install.ps1            # Windows
```

---

## Requisitos

### Obligatorio

**Node.js 22 o superior** y **npm** (viene con Node).

| Sistema | Cómo instalarlo |
|---------|-----------------|
| macOS | `brew install node` o desde [nodejs.org](https://nodejs.org) |
| Debian / Ubuntu | `sudo apt install nodejs npm` |
| Fedora | `sudo dnf install nodejs` |
| Arch | `sudo pacman -S nodejs npm` |
| Windows | `winget install OpenJS.NodeJS.LTS` |

> [!WARNING]
> El paquete `nodejs` de Debian y Ubuntu suele venir varias versiones atrás. Si `node -v` te da menos de 22, usá [nvm](https://github.com/nvm-sh/nvm) o el repositorio de [NodeSource](https://github.com/nodesource/distributions).

¿Por qué 22 y no 20? La herramienta de PDFs escaneados usa `pdfjs-dist`, que necesita una API de `ArrayBuffer` que recién apareció en Node 21. Y Node 20 llegó a fin de vida en abril de 2026.

### Opcional, según qué herramienta uses

| Herramienta | Lo necesitás para | Cómo instalarlo |
|-------------|-------------------|-----------------|
| **Python 3.10+** | Las dos herramientas de abajo | `brew install python` · `sudo apt install python3` · `winget install Python.Python.3.12` |
| **markitdown** | Convertir documentos a Markdown | `pipx install 'markitdown[all]'` |
| **yt-dlp** | Descargar video y audio | `brew install yt-dlp` · `pipx install yt-dlp` · `winget install yt-dlp.yt-dlp` |
| **ffmpeg** | Extraer audio y unir video de alta calidad | `brew install ffmpeg` · `sudo apt install ffmpeg` · `winget install Gyan.FFmpeg` |

El instalador se encarga de todo esto por vos. Y si algo queda faltando, `veneko doctor` te lo dice con el comando exacto para tu sistema.

---

## Uso

Escribí `veneko` sin argumentos y se abre el menú interactivo:

```
┌  veneko v1.0.3
│
◆  What do you want to do?
│  ● Create a new project    scaffold from a template
│  ○ Add a feature           extend an existing project
│  ○ Tools                   AI-powered utilities
│  ○ Configuration           credentials and defaults
│  ○ Doctor                  check this machine's setup
│  ○ Update                  install the latest release
│  ○ Exit
└
```

### Comandos

| Comando | Qué hace |
|---------|----------|
| `veneko` | Abre el menú interactivo. |
| `veneko create` | Genera un proyecto nuevo desde un template. |
| `veneko add` | Agrega una feature a un proyecto existente. |
| `veneko tools` | Abre el menú de herramientas. |
| `veneko config` | Gestiona credenciales de IA y el modelo por defecto. |
| `veneko doctor` | Revisa Node, Python, herramientas y configuración. |
| `veneko update` | Busca un release nuevo en GitHub y lo instala. |
| `veneko --version` | Muestra la versión instalada. |

---

## Generar proyectos

`veneko create` te pregunta el nombre, el template, la base de datos y el gestor de paquetes; después genera la estructura, inicializa git e instala las dependencias.

### Templates disponibles

**Frontend:** Vite · Vue · Nuxt · Astro · Next.js · React Native (Expo)
**Backend:** NestJS · Flask

Todos vienen con **arquitectura hexagonal** ya armada: `domain/` con entidades, puertos y casos de uso; `adapters/` con la API y la persistencia; `infrastructure/` con lo que toca el mundo exterior.

### Features que podés agregar

`veneko add` detecta qué proyecto tenés y te ofrece lo que corresponde:

- **Base de datos** — PostgreSQL, MySQL o SQLite, con Drizzle en Node o SQLAlchemy en Python, más el `docker-compose.yml`.
- **Autenticación**
- **Testing** — Vitest o pytest, ya configurado.

### Gestor de paquetes

El prompt te ofrece **solo los que tenés instalados**, con npm siempre disponible porque viene con Node. Si un proyecto ya tiene lockfile, ese manda.

---

## Herramientas

`veneko tools` abre este menú:

### Documento a Markdown

Convierte PDF, DOCX, PPTX, XLSX, EPUB, HTML, CSV y bastante más a Markdown limpio, usando [markitdown](https://github.com/microsoft/markitdown). Sin IA de por medio: es extracción directa, rápida y gratis.

### PDF escaneado a Markdown

Para PDFs que son **imágenes de páginas** y no tienen capa de texto. Renderiza cada página y se la manda a un modelo de visión para que la transcriba. Necesita una API key configurada.

### Descargar video y audio

Envoltorio sobre [yt-dlp](https://github.com/yt-dlp/yt-dlp) con progreso en vivo, velocidad y ETA. Podés elegir:

- Video hasta la resolución que quieras, en MP4 o MKV
- Audio en MP3, M4A, Opus, FLAC o WAV
- Playlists completas o un rango de items
- Subtítulos, metadata, capítulos y miniatura embebida
- Saltear segmentos patrocinados con SponsorBlock
- Usar las cookies de tu navegador para contenido restringido

Cuando algo falla, el error te dice **qué hacer**: si el video es privado, si necesita sesión iniciada, si está geobloqueado o si yt-dlp quedó viejo.

---

## Configuración

`veneko config` gestiona las credenciales de los proveedores de IA.

### Proveedores soportados

| Proveedor | Variable de entorno |
|-----------|---------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Google | `GOOGLE_API_KEY` |
| xAI | `XAI_API_KEY` |

Las keys se guardan en `~/.veneko/config.json` con permisos `0600` (solo tu usuario puede leerlo). Si preferís no guardarlas en disco, definí la variable de entorno correspondiente: veneko la usa igual.

También podés fijar un **modelo por defecto** para que las herramientas de IA no te pregunten cada vez.

---

## Actualizaciones

```bash
veneko update
```

Consulta el último release en GitHub, te muestra las notas de la versión y, si aceptás, corre el instalador para dejarte en la última.

| Opción | Qué hace |
|--------|----------|
| `veneko update --check` | Solo te dice si hay una versión nueva, no instala nada. |
| `veneko update --yes` | Instala sin preguntar. |
| `veneko update --force` | Reinstala aunque ya estés en la última. |

---

## Desinstalar

### macOS y Linux

```bash
curl -fsSL https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/uninstall.sh | bash
```

### Windows

```powershell
irm https://raw.githubusercontent.com/ChristianVeneko/veneko-cli/main/scripts/uninstall.ps1 | iex
```

Tu configuración y tus API keys **se conservan**. Agregá `--purge` (o `-Purge` en Windows) si también querés borrarlas.

markitdown, yt-dlp y ffmpeg quedan instalados a propósito: sirven por su cuenta y probablemente no los instalaste solo por veneko.

---

## Algo no funciona

Antes que nada:

```bash
veneko doctor
```

Te revisa todo y te da el comando exacto para lo que falte.

| Síntoma | Qué pasa |
|---------|----------|
| `veneko: command not found` | La terminal todavía tiene el PATH viejo. Abrí una nueva, o corré `source ~/.zshrc`. |
| El instalador dice que no encuentra el repositorio | GitHub limitó tu IP por cantidad de pedidos. Esperá unos minutos. |
| `markitdown: not installed` | Instalalo con `pipx install 'markitdown[all]'`. Necesita Python 3.10+. |
| El audio no se descarga | Falta ffmpeg. `brew install ffmpeg` en macOS, `winget install Gyan.FFmpeg` en Windows. |
| yt-dlp falla en YouTube | YouTube cambió su reproductor. Actualizá con `pipx upgrade yt-dlp`. |
| `externally-managed-environment` al usar pip | Es correcto que falle: usá **pipx**, que instala aislado sin romper el Python del sistema. |

Si nada de esto lo resuelve, [abrí un issue](https://github.com/ChristianVeneko/veneko-cli/issues) con la salida de `veneko doctor` y el log del instalador.

---

## Desarrollo

```bash
git clone https://github.com/ChristianVeneko/veneko-cli.git
cd veneko-cli
npm install
npm run build
npm link          # deja `veneko` apuntando a tu copia local
```

| Script | Qué hace |
|--------|----------|
| `npm run build` | Compila a `dist/` y copia los templates. |
| `npm run dev` | Igual, pero en modo watch. |
| `npm run typecheck` | Corre TypeScript sin emitir. |
| `npm test` | Corre la suite con Vitest. |

### Estructura

```
src/
├── ai/            clientes de los proveedores de IA
├── commands/      un archivo por comando de la CLI
├── config/        credenciales y modelo por defecto
├── generators/    generación de proyectos y features
├── prompts/       los flujos interactivos
├── templates/     los templates que se copian al proyecto nuevo
├── tools/         markitdown, yt-dlp, PDF escaneado
└── utils/         PATH, filesystem, git, plataforma
scripts/           instaladores y desinstaladores
tests/             la suite de Vitest
```

Las dependencias externas se resuelven en `src/utils/binaries.ts`, que también maneja las diferencias de Windows: el stub de Microsoft Store y los wrappers `.cmd` que Node no puede ejecutar directo.

---

## Licencia

[MIT](LICENSE) © Christian Veneko
