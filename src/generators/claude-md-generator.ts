import { getRunCommand } from "../utils/package-manager.js";
import type { CreateConfig, TemplateManifest } from "../types/index.js";

export function generateClaudeMd(
  config: CreateConfig,
  manifest: TemplateManifest
): string {
  const { projectName, packageManager, database } = config;
  const { displayName, architecture, scripts } = manifest;

  const pmRun = getRunCommand(packageManager);

  const architectureSection =
    architecture === "screaming"
      ? `## Architecture: Screaming Architecture

This project uses **Screaming Architecture** — the folder structure reflects business domains, not technical layers.

### Folder Conventions

\`\`\`
src/
  features/         # Business domain modules (one folder per feature)
  shared/
    components/     # Reusable UI components
    hooks/          # Reusable React hooks
    utils/          # Shared utility functions
  app/              # Next.js app directory (routing only)
\`\`\`

Each feature folder under \`src/features/\` is self-contained:
- \`components/\` — UI components specific to this feature
- \`hooks/\` — hooks specific to this feature
- \`services/\` or \`api/\` — data-fetching and business logic
- \`types.ts\` — local types`
      : `## Architecture: Clean / Hexagonal Architecture

This project uses **Hexagonal (Ports & Adapters) Architecture** — business logic is isolated from infrastructure.

### Folder Conventions

\`\`\`
src/
  domain/           # Pure business logic — no framework dependencies
    entities/
    use-cases/
    ports/          # Interfaces / contracts
  adapters/         # Implementations of domain ports
    api/
    db/
  infrastructure/   # Framework-specific wiring (Next.js, Express, etc.)
  shared/
    utils/
    types/
\`\`\``;

  const databaseSection =
    database !== "none"
      ? `
## Database

Configured database: **${database}**

- ORM / query builder goes under \`src/adapters/db/\`
- Schema definitions go under \`src/domain/\` or \`prisma/\` depending on your ORM
- Never import database clients directly in domain/use-case files — go through a port interface
`
      : "";

  const allScripts = { ...scripts };

  const scriptLines = Object.entries(allScripts)
    .map(([name, cmd]) => `- \`${pmRun} ${name}\` — \`${cmd}\``)
    .join("\n");

  return `# ${projectName}

Scaffolded with [veneko-cli](https://github.com/your-org/veneko-cli) using the **${displayName}** template.

## Stack

- Framework: ${displayName}
- Package Manager: ${packageManager}
- Language: TypeScript (strict)
- Formatter / Linter: Biome
- Testing: Vitest
${database !== "none" ? `- Database: ${database}` : ""}

${architectureSection}
${databaseSection}
## Available Scripts

${scriptLines}
- \`${pmRun} lint\` — check code with Biome
- \`${pmRun} lint:fix\` — auto-fix lint issues
- \`${pmRun} format\` — format all files with Biome
- \`${pmRun} test\` — run tests with Vitest

## Code Conventions

- **TypeScript**: strict mode enabled, no \`any\`
- **Modules**: ESM only (\`import\`/\`export\`, \`.js\` extensions in local imports)
- **Formatting**: Biome handles both formatting and linting — do not mix with Prettier/ESLint
- **Git hooks**: Husky runs \`${pmRun} lint\` on every commit via \`.husky/pre-commit\`
- **Naming**: \`kebab-case\` for files, \`PascalCase\` for components and classes, \`camelCase\` for variables and functions

## Testing

Tests use **Vitest**. Place test files next to the code they test as \`*.test.ts\` or \`*.spec.ts\`.

\`\`\`ts
import { describe, it, expect } from "vitest";
\`\`\`

Run tests with \`${pmRun} test\`.
`;
}
