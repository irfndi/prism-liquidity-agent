import { Command } from "commander";
import { execSync, spawnSync } from "child_process";
import { getCurrentVersion } from "../engine/version.js";
import { compareVersions, isValidVersion, fetchLatestRelease } from "../engine/update-utils.js";
import { Effect } from "effect";

export const updateCommand = new Command("update")
  .description("Check for and apply updates")
  .option("--check-only", "Only check for updates, don't apply")
  .action(async (options) => {
    const current = getCurrentVersion();
    console.log(`Current version: ${current}`);

    try {
      const repo = "irfndi/prism-liquidity-agent";
      const channel = "stable" as const;

      const release = await Effect.runPromise(
        fetchLatestRelease(repo, channel),
      );

      if (!release) {
        console.log("✓ Already up to date");
        return;
      }

      const latest = release.tag_name;

      if (!isValidVersion(latest)) {
        console.error("Error: Invalid version format from GitHub API");
        process.exit(1);
      }

      if (compareVersions(latest, current) <= 0) {
        console.log("✓ Already up to date");
        return;
      }

      console.log(`Update available: ${current} → ${latest}`);
      console.log(`Release notes: ${release.html_url}`);

      if (options.checkOnly) {
        return;
      }

      // Check for local modifications
      try {
        const status = execSync("git status --porcelain", { encoding: "utf-8" });
        if (status.trim()) {
          console.error("Error: Local modifications detected. Commit or stash before updating.");
          process.exit(1);
        }
      } catch {
        console.warn("Warning: git not available, skipping local modification check");
      }

      console.log("Applying update...");
      execSync("git fetch origin", { stdio: "inherit" });
      const checkoutResult = spawnSync("git", ["checkout", latest], { stdio: "inherit" });
      if (checkoutResult.status !== 0) {
        console.error("Error: git checkout failed");
        process.exit(1);
      }
      execSync("bun install", { stdio: "inherit" });

      console.log(`✓ Updated to ${latest}`);
    } catch (err) {
      if (err instanceof Error) {
        console.error("Error:", err.message);
      } else {
        console.error("Error checking for updates:", err);
      }
      process.exit(1);
    }
  });
