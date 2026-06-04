import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const INSTALL_ID_FILE = path.join(os.homedir(), ".config", "prism", "install-id");

let cachedId: string | null = null;

export function getOrCreateInstallId(): string {
  if (cachedId) return cachedId;
  try {
    if (fs.existsSync(INSTALL_ID_FILE)) {
      const existing = fs.readFileSync(INSTALL_ID_FILE, "utf-8").trim();
      if (existing.length >= 8 && existing.length <= 128) {
        cachedId = existing;
        return cachedId;
      }
    }
  } catch {
    // fall through to generate a new one
  }
  const id = randomUUID();
  try {
    const dir = path.dirname(INSTALL_ID_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(INSTALL_ID_FILE, id, { mode: 0o600 });
    fs.chmodSync(INSTALL_ID_FILE, 0o600);
  } catch {
    // keep the id in memory for this session even if persistence failed
  }
  cachedId = id;
  return id;
}
