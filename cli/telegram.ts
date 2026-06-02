import { Command } from "commander";

export const telegramCommand = new Command("link-telegram")
  .description("Generate a one-time code to link Telegram")
  .action(() => {
    // TODO: Call Cloudflare Worker /v1/link/start when Issue #16 is implemented
    const randomBytes = new Uint8Array(4);
    crypto.getRandomValues(randomBytes);
    const code = `LINK-${Array.from(randomBytes).map(b => b.toString(36).padStart(2, '0')).join('').toUpperCase().slice(0, 6)}`;
    console.log("Link code:", code);
    console.log("(expires in 10 minutes)");
    console.log("Send this code to @prism_dlmm_bot");
  });
