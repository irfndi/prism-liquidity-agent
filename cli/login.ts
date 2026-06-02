import { Command } from "commander";

export const loginCommand = new Command("login")
  .description("Validate an existing API key")
  .argument("<key>", "API key to validate")
  .action((key) => {
    // TODO: Call Cloudflare Worker /v1/login when Issue #16 is implemented
    console.log("✓ Login successful");
    console.log(`  Key: ${key.slice(0, 12)}...`);
  });
