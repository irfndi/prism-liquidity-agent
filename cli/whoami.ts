import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";

const CREDENTIALS_FILE = path.join(os.homedir(), ".config", "prism", "credentials.json");

export const whoamiCommand = new Command("whoami")
  .description("Show current user info")
  .action(() => {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      console.error("Error: Not registered. Run 'prism register' first.");
      process.exit(1);
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));

    console.log("User ID:", credentials.userId);
    console.log("API Key:", `${credentials.apiKey.slice(0, 12)}...`);
    console.log("Created:", credentials.createdAt);
    console.log("Tier: free (not yet implemented)");
    console.log("Telegram: not linked");
  });
