# Plan: veneko-cli — CLI Personal de Scaffolding

## Context

Necesitás una herramienta CLI personal que elimine el setup repetitivo de proyectos. Cada vez que arrancás un proyecto nuevo (Next.js, NestJS, etc.) tenés que configurar lo mismo: estructura de carpetas, linting, testing, git, DB. `veneko-cli` automatiza todo eso con templates embebidos y arquitecturas sólidas preconfiguradas.

**Resultado esperado**: Correr `veneko create`, responder 5-6 preguntas, y tener un proyecto listo con arquitectura limpia, Biome, Husky, Vitest, git con branches, Docker Compose para DB, y un CLAUDE.md — en menos de 30 segundos.

---

## Decisiones de Arquitectura

| Decisión | Valor | Motivo |
|----------|-------|--------|
| Lenguaje | TypeScript + Node.js (ESM) | Tu stack, ecosistema CLI maduro |
| CLI Framework | Commander + @clack/prompts | Wizard interactivo con UX hermosa |
| Templating | EJS (archivos `.ejs`) | Ligero, suficiente para interpolación simple |
| Build | tsup | Bundle rápido, un solo archivo de salida |
| Distribución | Local (`npm link`) | Herramienta personal, sin publicar |
| Pkg Manager | bun (default) + opción pnpm | Velocidad como prioridad |
| Linting | Biome + Husky | Reemplaza ESLint+Prettier en uno, hooks pre-commit |
| Testing | Vitest | Rápido, compatible Vite, API familiar |
| ORM | Drizzle | SQL-first, type-safe, ligero |
| DB local | Docker Compose | Entorno reproducible |
| Arquitectura frontend | Screaming Architecture | Carpetas por feature/dominio |
| Arquitectura backend | Clean/Hexagonal | Capas explícitas con desacople |

---

## Estructura del CLI

```
veneko-cli/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts                        # Entry point, Commander program
    commands/
      create.ts                     # veneko create
      add.ts                        # veneko add <feature>
    prompts/
      create-prompt.ts              # Wizard interactivo (Clack)
      add-prompt.ts                 # Prompt para agregar features
    generators/
      project-generator.ts          # Orquesta la generación completa
      feature-generator.ts          # Inyecta features en proyectos existentes
      template-renderer.ts          # Motor EJS: walk dir, render o copy
      claude-md-generator.ts        # Genera CLAUDE.md por proyecto
    templates/
      nextjs/
        template.json               # Manifiesto (deps, scripts, metadata)
        base/                        # Archivos del proyecto base
        features/                    # Overlays opcionales (db, auth, testing)
      nuxt/
      vue/
      react-native-expo/
      astro/
      vite/
      nestjs/
      flask/
    types/
      index.ts                      # Interfaces centrales del sistema
    utils/
      fs.ts                         # Operaciones de archivos
      git.ts                        # Init, commit, branches
      package-manager.ts            # Abstracción bun/pnpm
      detect-project.ts             # Detectar framework en proyecto existente
      logger.ts                     # Wrapper de Clack para logs
      paths.ts                      # Resolución de paths (templates dir)
      name-utils.ts                 # Transformaciones de nombres (kebab, pascal, camel)
```

---

## Sistema de Templates

Cada template tiene un `template.json` (manifiesto) + directorio `base/` con los archivos reales del proyecto.

**Template discovery**: automático por filesystem — todo directorio en `src/templates/` con un `template.json` se registra solo. No hay registry manual.

**Rendering**: archivos `.ejs` se procesan con EJS y se escriben sin la extensión. El resto se copia verbatim.

**package.json**: se ensambla PROGRAMÁTICAMENTE (no con EJS) — el generator merge deps del manifiesto base + features seleccionadas + Biome/Husky comunes.

**Feature overlays**: cada feature (`db-postgres`, `auth`, `testing`) tiene su propio `feature.json` con deps adicionales y archivos a copiar. Se superponen sobre el base.

---

## Comandos

### `veneko create`
Wizard interactivo:
1. Nombre del proyecto
2. Template (agrupados: Frontend / Backend)
3. Base de datos? (none / postgres / mysql / sqlite) — solo si el template lo soporta
4. Package manager (bun default / pnpm)
5. Inicializar git con branches? (main, development, staging)
6. Generar CLAUDE.md?
7. Resumen -> Confirmar -> Ejecutar

### `veneko add <feature>`
1. Detecta el framework del proyecto actual (lee `package.json` + lockfiles)
2. Verifica que el feature es compatible
3. Copia archivos del overlay, merge deps, instala
4. Muestra instrucciones post-instalación

Features soportadas: `db`, `auth`, `testing`

---

## Templates

| Template | Categoría | Arquitectura | DB Soportada |
|----------|-----------|-------------|--------------|
| Next.js (App Router) | frontend | Screaming | Si |
| Nuxt 3 | frontend | Screaming | Si |
| Vue (Vite) | frontend | Screaming | No |
| React Native (Expo) | frontend | Screaming | No |
| Astro | frontend | Screaming | No |
| Vite (React) | frontend | Screaming | No |
| NestJS | backend | Clean/Hexagonal | Si |
| Flask (Python) | backend | Clean/Hexagonal | Si |

---

## Dependencias del CLI

```
# Runtime
commander           # Comandos y parsing
@clack/prompts      # Prompts interactivos
ejs                 # Template rendering
picocolors          # Colores en terminal (zero-dep)

# Dev
typescript
tsup
@types/node
@types/ejs
vitest
```

Sin: chalk, fs-extra, execa, globby — usamos alternativas nativas de Node 22+.

---

## Fases de Implementación

### Fase 1: Fundación + Primer Template (Next.js) - COMPLETADA
- Setup del proyecto (package.json, tsconfig, tsup)
- Types centrales (`src/types/index.ts`)
- Utils: fs, paths, logger, package-manager, git, detect-project, name-utils
- Template renderer (motor EJS)
- Comando `create` + prompt wizard
- Project generator
- Template Next.js completo

### Fase 2: Todos los Templates - COMPLETADA
- Templates: Nuxt, Vue, RN/Expo, Astro, Vite, NestJS, Flask
- CLAUDE.md generator
- Git setup con branches

### Fase 3: Features System + Database - PENDIENTE
- Feature overlay system en el generator
- Features de DB: Drizzle + Docker Compose (postgres, mysql, sqlite)
- Comando `add` funcional + prompt
- Feature generator
- `veneko add db` y `veneko add testing`

### Fase 4: Auth + Pulido - PENDIENTE
- Feature de auth para templates aplicables
- Error handling robusto
- Tests para generators y utils

---

## Consideraciones Windows

- Siempre `path.join()` / `path.resolve()`, nunca `/` hardcodeado
- `child_process.execFile` con `{ shell: true }` para encontrar ejecutables en PATH
- `fs.cpSync` nativo (Node 22+)
- `.gitattributes` con `* text=auto eol=lf` en cada template
- Husky v9 maneja permisos de ejecutable automáticamente

---

## Verificación

1. **Build**: `bun run build` -> genera `dist/index.js` + `dist/templates/`
2. **Link**: `npm link` -> `veneko` disponible globalmente
3. **Create**: `veneko create` en un directorio temporal -> proyecto funcional
4. **Run**: El proyecto generado debe hacer `bun dev` sin errores
5. **Git**: El proyecto debe tener branches main, development, staging
6. **CLAUDE.md**: Debe existir con contenido relevante al template elegido
7. **Add**: En el proyecto generado, `veneko add db` debe inyectar Drizzle + Docker Compose
8. **Tests**: `bun test` en veneko-cli debe pasar
