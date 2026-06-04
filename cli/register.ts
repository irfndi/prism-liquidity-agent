import { Command } from "commander";
import { pingInstall, prismApiPost, writeCredentials } from "./api.js";

interface RegisterResult {
  user_id: string;
  api_key: string;
  tier: string;
}

export const registerCommand = new Command("register")
  .description("Register with Prism and get an API key")
  .action(async () => {
    const result = await prismApiPost<RegisterResult>("/v1/register", {});

    if (!result.ok || !result.data) {
      console.error("Error: Registration failed");
      if (result.error) console.error(`  ${result.error}`);
      console.error("");
      console.error("If the API is unreachable, set PRISM_API_URL to your local/staging API.");
      process.exit(1);
    }

    const { user_id: userId, api_key: apiKey } = result.data;
    const credentials = {
      apiKey,
      userId,
      createdAt: new Date().toISOString(),
    };
    writeCredentials(credentials);
    await pingInstall("register", { userId });

    console.log("✓ Registration successful");
    console.log(`  User ID: ${userId}`);
    console.log(`  API Key: ${apiKey.slice(0, 12)}...`);
    console.log(`  Saved to: ${process.env.HOME}/.config/prism/credentials.json`);
    console.log("");
    console.log("Next: run 'prism setup' to configure your trading agent");
  });
