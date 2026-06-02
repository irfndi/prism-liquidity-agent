import { Command } from "commander";

export const subscriptionCommand = new Command("subscription")
  .description("Manage subscription")
  .addCommand(
    new Command("status")
      .description("Show current tier and expiry")
      .action(() => {
        console.log("Tier: free");
        console.log("Max profit: 1 SOL/month");
        console.log("Usage: 0 SOL (0%)");
      }),
  )
  .addCommand(
    new Command("renew")
      .description("Renew or upgrade subscription")
      .option("--tier <tier>", "Tier to upgrade to", "pro")
      .action((options) => {
        console.log(`Renewing to tier: ${options.tier}`);
        console.log("(Solana Pay integration coming in Issue #15)");
      }),
  );
