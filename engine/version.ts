import pkg from "../package.json" with { type: "json" };

let cachedVersion: string | null = null;

export function getCurrentVersion(): string {
  if (cachedVersion) return cachedVersion;
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
  ) {
    cachedVersion = pkg.version;
    return cachedVersion;
  }
  return "0.0.0";
}
