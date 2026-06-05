import * as p from "@clack/prompts";
import { cancelAndExit } from "../utils/logger.js";
import type { AddConfig, DetectedProject, FeatureName } from "../types/index.js";

const FEATURE_LABELS: Record<FeatureName, string> = {
  "db-postgres": "PostgreSQL (Drizzle ORM + Docker Compose)",
  "db-mysql": "MySQL (Drizzle ORM + Docker Compose)",
  "db-sqlite": "SQLite (Drizzle ORM)",
  auth: "Authentication",
  testing: "Testing setup (Vitest)",
};

export async function runAddPrompt(
  detected: DetectedProject,
  supportedFeatures: FeatureName[],
  requestedFeature?: string
): Promise<AddConfig> {
  let feature: FeatureName;

  if (requestedFeature) {
    if (!supportedFeatures.includes(requestedFeature as FeatureName)) {
      p.log.error(
        `Feature "${requestedFeature}" is not supported for ${detected.framework}. ` +
          `Supported: ${supportedFeatures.join(", ")}`
      );
      cancelAndExit();
    }
    feature = requestedFeature as FeatureName;
  } else {
    const options = supportedFeatures.map((f) => ({
      value: f,
      label: FEATURE_LABELS[f] ?? f,
    }));

    const selected = await p.select({
      message: "Which feature do you want to add?",
      options,
    });

    if (p.isCancel(selected)) cancelAndExit();
    feature = selected as FeatureName;
  }

  const confirmed = await p.confirm({
    message: `Add ${FEATURE_LABELS[feature] ?? feature} to your ${detected.framework} project?`,
  });

  if (p.isCancel(confirmed) || !confirmed) cancelAndExit();

  return {
    feature,
    projectDir: process.cwd(),
    detectedTemplate: detected.framework,
    packageManager: detected.packageManager,
  };
}
