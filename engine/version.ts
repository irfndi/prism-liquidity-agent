import pkg from "../package.json" with { type: "json" };

let cachedVersion: string | null = null;

export function getCurrentVersion(): string {
  if (cachedVersion) return cachedVersion;
  cachedVersion = pkg.version ?? "0.0.0";
  return cachedVersion;
}
