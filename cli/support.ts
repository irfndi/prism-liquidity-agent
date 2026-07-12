import { Command } from "commander";
import { prismApiPost, requireRegistered } from "./api.js";

export const issueCommand = new Command("issue")
  .description("Submit an issue to the Prism Cloud feedback store")
  .argument("<text>", "Issue description")
  .action(async (text: string) => {
    try {
      const credentials = await requireRegistered(true);
      const result = await prismApiPost<{ id: string; duplicate?: boolean }>(
        "/v1/issue",
        { title: text, body: text },
        { apiKey: credentials.apiKey },
      );
      if (!result.ok || !result.data) {
        throw new Error(result.error ?? "Issue submission failed");
      }
      const suffix = result.data.duplicate ? " (already tracked)" : "";
      console.log(`✓ Issue stored in Prism Cloud: ${result.data.id}${suffix}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

export const supportCommand = new Command("support")
  .description("Get support contact info")
  .action(() => {
    console.log("Docs: https://github.com/irfndi/prism-liquidity-agent/tree/main/docs");
    console.log('Feedback: prism feedback "describe the problem"');
    console.log("Telegram: @prism_agent_bot");
  });
