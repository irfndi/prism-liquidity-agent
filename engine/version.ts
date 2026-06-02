import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

let cachedVersion: string | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function getCurrentVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const content = readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content) as unknown;

    if (
      typeof pkg === "object" &&
      pkg !== null &&
      "version" in pkg &&
      typeof (pkg as Record<string, unknown>).version === "string"
    ) {
      cachedVersion = (pkg as Record<string, unknown>).version as string;
      return cachedVersion;
    }

    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}
