import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";
import { prismApiGet } from "./api.js";

const CREDENTIALS_FILE = path.join(os.homedir(), ".config", "prism", "credentials.json");

// Tier display info
const TIER_INFO: Record<
  string,
  { name: string; maxProfit: string; monthlyFee: string; features: string[] }
> = {
  free: {
    name: "Free",
    maxProfit: "1 SOL/month",
    monthlyFee: "0 SOL",
    features: [
      "Paper trading",
      "Basic pool monitoring",
      "Community support",
    ],
  },
  pro: {
    name: "Pro",
    maxProfit: "10 SOL/month",
    monthlyFee: "0.5 SOL",
    features: [
      "Live trading",
      "Advanced analytics",
      "Priority support",
      "10% performance fee",
    ],
  },
  fund: {
    name: "Fund",
    maxProfit: "Unlimited",
    monthlyFee: "2 SOL",
    features: [
      "Live trading",
      "Full analytics suite",
      "Dedicated support",
      "20% performance fee",
      "Custom strategies",
    ],
  },
};

function getCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch (err) {
    console.error("Error: Failed to parse credentials file. Run 'prism register' first.");
    process.exit(1);
  }
}

export const subscriptionCommand = new Command("subscription")
  .description("Manage subscription")
  .addCommand(
    new Command("status")
      .description("Show current tier and usage")
      .action(async () => {
        const creds = getCredentials();
        if (!creds) {
          console.error("Error: Not registered. Run 'prism register' first.");
          process.exit(1);
        }

        const result = await prismApiGet<{
          tier: string;
          walletSol: number;
          referralCount: number;
          credits: number;
          platformFeeRate: number;
        }>("/v1/subscription/status", { apiKey: creds.apiKey });

        if (!result.ok || !result.data) {
          console.error("Error: Failed to fetch subscription status");
          if (result.error) console.error(`  ${result.error}`);
          process.exit(1);
        }

        const { tier, walletSol, referralCount, credits, platformFeeRate } = result.data;
        const info = TIER_INFO[tier] ?? TIER_INFO.free;

        console.log(`Tier: ${info.name}`);
        console.log(`Wallet: ${walletSol.toFixed(2)} SOL`);
        console.log(`Referrals: ${referralCount}`);
        console.log(`Credits: $${credits}`);
        console.log(`Platform fee: ${(platformFeeRate * 100).toFixed(0)}%`);
        console.log("");
        console.log("Features:");
        info.features.forEach((f) => { console.log(`  • ${f}`); });
      }),
  )
  .addCommand(
    new Command("upgrade")
      .description("Upgrade to a higher tier")
      .argument("<tier>", "Tier to upgrade to (pro|fund)")
      .action((tier) => {
        const creds = getCredentials();
        if (!creds) {
          console.error("Error: Not registered. Run 'prism register' first.");
          process.exit(1);
        }

        if (!TIER_INFO[tier]) {
          console.error(`Error: Unknown tier '${tier}'. Available: pro, fund`);
          process.exit(1);
        }

        const info = TIER_INFO[tier];

        console.log(`Upgrade to ${info.name}`);
        console.log(`Monthly fee: ${info.monthlyFee}`);
        console.log("");
        console.log("Features:");
        info.features.forEach((f) => { console.log(`  • ${f}`); });
        console.log("");

        // Generate Solana Pay URL
        const feeWallet = process.env.FEE_WALLET_ADDRESS;
        if (!feeWallet) {
          console.log("(Solana Pay integration coming soon)");
          console.log(`Please send ${info.monthlyFee} to the fee wallet`);
          return;
        }

        const solanaPayUrl = `solana:${feeWallet}?amount=${info.monthlyFee.replace(
          " SOL",
          "",
        )}&label=Prism%20${info.name}&message=Monthly%20subscription`;

        console.log("Solana Pay URL:");
        console.log(solanaPayUrl);
        console.log("");
        console.log("Scan this QR code with your Solana wallet:");
        console.log(
          `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(
            solanaPayUrl,
          )}`,
        );
      }),
  )
  .addCommand(
    new Command("tiers")
      .description("List all available tiers")
      .action(() => {
        console.log("Available Tiers\n");
        Object.entries(TIER_INFO).forEach(([key, info]) => {
          console.log(`${info.name} (${key})`);
          console.log(`  Max profit: ${info.maxProfit}`);
          console.log(`  Monthly fee: ${info.monthlyFee}`);
          console.log("  Features:");
        info.features.forEach((f) => { console.log(`  • ${f}`); });
          console.log("");
        });
      }),
  )
  .addCommand(
    new Command("calculate-fees")
      .description("Calculate fees for a given NAV and holding period")
      .option("--nav <amount>", "Current NAV in SOL", "10")
      .option("--days <days>", "Days held", "30")
      .option("--tier <tier>", "Tier (free|pro|fund)", "pro")
      .action((options) => {
        const nav = parseFloat(options.nav);
        const days = parseInt(options.days, 10);

        if (Number.isNaN(nav) || nav < 0) {
          console.error("Error: --nav must be a valid non-negative number");
          process.exit(1);
        }

        if (Number.isNaN(days) || days < 0) {
          console.error("Error: --days must be a valid non-negative integer");
          process.exit(1);
        }

        const tierName = options.tier;

        // Import revenue service
        import("../engine/revenue-service.js").then(({ TIERS }) => {
          const tier = TIERS[tierName];
          if (!tier) {
            console.error(`Error: Unknown tier '${tierName}'`);
            process.exit(1);
          }

          const managementFee = nav * tier.managementFeeRate * (days / 365);
          const performanceFee = Math.max(0, nav - tier.maxFreeSol) * tier.performanceFeeRate;
          const totalFee = managementFee + performanceFee;

          console.log(`Tier: ${tier.name}`);
          console.log(`NAV: ${nav} SOL`);
          console.log(`Days held: ${days}`);
          console.log("");
          console.log(`Management fee: ${managementFee.toFixed(6)} SOL`);
          console.log(`Performance fee: ${performanceFee.toFixed(6)} SOL`);
          console.log(`Total fee: ${totalFee.toFixed(6)} SOL`);
        });
      }),
  );
