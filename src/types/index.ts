export type TemplateCategory = "frontend" | "backend";
export type PackageManager = "bun" | "pnpm";
export type DatabaseOption = "none" | "postgres" | "mysql" | "sqlite";
export type FeatureName = "db-postgres" | "db-mysql" | "db-sqlite" | "auth" | "testing";

export interface TemplateManifest {
  name: string;
  displayName: string;
  category: TemplateCategory;
  description: string;
  architecture: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  dynamicFiles: string[];
  supportedFeatures: FeatureName[];
}

export interface FeatureManifest {
  name: FeatureName;
  displayName: string;
  description: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  files: string[];
  postInstallMessage?: string;
}

export interface CreateConfig {
  projectName: string;
  template: string;
  database: DatabaseOption;
  packageManager: PackageManager;
  initGit: boolean;
  generateClaudeMd: boolean;
  outputDir: string;
}

export interface AddConfig {
  feature: FeatureName;
  projectDir: string;
  detectedTemplate: string;
  packageManager: PackageManager;
}

export interface TemplateContext {
  projectName: string;
  projectNameKebab: string;
  projectNamePascal: string;
  projectNameCamel: string;
  database: DatabaseOption;
  packageManager: PackageManager;
  year: number;
}

export interface DetectedProject {
  framework: string;
  packageManager: PackageManager;
  hasDatabase: boolean;
  hasAuth: boolean;
  hasTesting: boolean;
}
