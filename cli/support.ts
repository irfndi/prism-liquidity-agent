import { Command } from "commander";

export const issueCommand = new Command("issue")
  .description("File an issue to the Prism GitHub repo")
  .argument("<text>", "Issue description")
  .action((text) => {
    console.log("Filing issue:", text);
    console.log("(GitHub API integration coming in Issue #16)");
  });

export const supportCommand = new Command("support")
  .description("Get support contact info")
  .action(() => {
    console.log("Docs: https://github.com/irfndi/prism-dlmm/tree/main/docs");
    console.log("Issues: https://github.com/irfndi/prism-dlmm/issues");
    console.log("Telegram: @prism_dlmm_bot");
  });
