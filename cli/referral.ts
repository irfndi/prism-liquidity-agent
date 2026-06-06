import { Command } from "commander";
import { prismApiPost, prismApiGet, readCredentials } from "./api.js";

export const referralCommand = new Command("referral")
  .description("Manage referrals and earn credits")
  .addCommand(
    new Command("code")
      .description("Get your referral code")
      .action(async () => {
        const creds = readCredentials();
        if (!creds) {
          console.error("Error: Not registered. Run 'prism register' first.");
          process.exit(1);
        }

        const result = await prismApiGet<{ code: string; referralCount: number }>(
          "/v1/referral/code",
          { apiKey: creds.apiKey },
        );

        if (!result.ok || !result.data) {
          console.error("Error: Failed to get referral code");
          if (result.error) console.error(`  ${result.error}`);
          process.exit(1);
        }

        console.log(`Your referral code: ${result.data.code}`);
        console.log(`Referrals: ${result.data.referralCount}`);
        console.log("");
        console.log("Share this code with friends to earn credits:");
        console.log(`  prism referral apply ${result.data.code}`);
      }),
  )
  .addCommand(
    new Command("apply")
      .description("Apply a referral code")
      .argument("<code>", "Referral code")
      .action(async (code) => {
        const creds = readCredentials();
        if (!creds) {
          console.error("Error: Not registered. Run 'prism register' first.");
          process.exit(1);
        }

        const result = await prismApiPost<{ success: boolean; credits: number }>(
          "/v1/referral/apply",
          { code },
          { apiKey: creds.apiKey },
        );

        if (!result.ok || !result.data) {
          console.error("Error: Failed to apply referral code");
          if (result.error) console.error(`  ${result.error}`);
          process.exit(1);
        }

        console.log("Referral applied successfully!");
        console.log(`Credits earned: $${result.data.credits}`);
      }),
  )
  .addCommand(
    new Command("stats")
      .description("Show referral statistics")
      .action(async () => {
        const creds = readCredentials();
        if (!creds) {
          console.error("Error: Not registered. Run 'prism register' first.");
          process.exit(1);
        }

        const result = await prismApiGet<{
          referralCount: number;
          credits: number;
          milestone: string | null;
        }>("/v1/referral/stats", { apiKey: creds.apiKey });

        if (!result.ok || !result.data) {
          console.error("Error: Failed to get referral stats");
          if (result.error) console.error(`  ${result.error}`);
          process.exit(1);
        }

        console.log("Referral Statistics:");
        console.log(`  Referrals: ${result.data.referralCount}`);
        console.log(`  Credits: $${result.data.credits}`);
        if (result.data.milestone) {
          console.log(`  Milestone: ${result.data.milestone}`);
        }
      }),
  );
