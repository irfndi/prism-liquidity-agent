import { Command } from "commander";
import { getCurrentVersion } from "../engine/version.js";

export const versionCommand = new Command("version")
  .description("Show current version")
  .action(() => {
    console.log(getCurrentVersion());
  });
