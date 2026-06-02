import { Command } from "commander";

export const telegramCommand = new Command("link-telegram")
  .description("Generate a one-time code to link Telegram")
  .action(() => {
    // TODO: Call Cloudflare Worker /v1/link/start when Issue #16 is implemented
    const code = `LINK-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    console.log("Link code:", code);
    console.log("(expires in 10 minutes)");
    console.log("Send this code to @prism_dlmm_bot");
  });
