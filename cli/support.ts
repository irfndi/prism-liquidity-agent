import { Command } from "commander";
import { createLogger } from "../engine/logger.js";

const log = createLogger("Support");

export const issueCommand = new Command("issue")
  .description("File an issue to the Prism GitHub repo")
  .argument("<text>", "Issue description")
  .action((text) => {
    log.info(`Filing issue: ${text}`);
    log.info("(GitHub API integration coming in Issue #16)");
  });

export const supportCommand = new Command("support")
  .description("Get support contact info")
  .action(() => {
    log.info("Docs: https://github.com/irfndi/prism-liquidity-agent/tree/main/docs");
    log.info("Issues: https://github.com/irfndi/prism-liquidity-agent/issues");
    log.info("Telegram: @prism_agent_bot");
  });
