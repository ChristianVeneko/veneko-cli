import { readFile } from "fs/promises";
import { join } from "path";
import { fileExists } from "./fs.js";
import { detectPackageManager } from "./package-manager.js";
import type { DetectedProject, PackageManager } from "../types/index.js";

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function detectFramework(deps: Record<string, string>): string {
  if ("next" in deps) return "nextjs";
  if ("nuxt" in deps) return "nuxt";
  if ("@nestjs/core" in deps) return "nestjs";
  if ("expo" in deps) return "react-native-expo";
  if ("astro" in deps) return "astro";
  if ("vue" in deps) return "vue";
  if ("vite" in deps) return "vite";
  return "unknown";
}

function hasMarker(deps: Record<string, string>, markers: string[]): boolean {
  return markers.some((m) => m in deps);
}

export async function detectProject(dir: string): Promise<DetectedProject | null> {
  const pkgPath = join(dir, "package.json");

  const hasPyProject = await fileExists(join(dir, "pyproject.toml"));
  if (hasPyProject) {
    const pm = await detectPackageManager(dir);
    return {
      framework: "flask",
      packageManager: pm,
      hasDatabase: false,
      hasAuth: false,
      hasTesting: false,
    };
  }

  if (!(await fileExists(pkgPath))) return null;

  const raw = await readFile(pkgPath, "utf-8");
  const pkg = JSON.parse(raw) as PackageJson;

  const allDeps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  const framework = detectFramework(allDeps);
  const pm = await detectPackageManager(dir);

  const hasDatabase = hasMarker(allDeps, [
    "pg",
    "mysql2",
    "better-sqlite3",
    "@prisma/client",
    "drizzle-orm",
  ]);

  const hasAuth = hasMarker(allDeps, [
    "next-auth",
    "passport",
    "@auth/core",
    "lucia",
    "better-auth",
  ]);

  const hasTesting = hasMarker(allDeps, [
    "vitest",
    "jest",
    "@testing-library/react",
    "playwright",
    "cypress",
  ]);

  return { framework, packageManager: pm, hasDatabase, hasAuth, hasTesting };
}
