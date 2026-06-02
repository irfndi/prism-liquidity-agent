#!/usr/bin/env bun
import { Command } from "commander";
import { setupCommand } from "./setup.js";
import { registerCommand } from "./register.js";
import { loginCommand } from "./login.js";
import { whoamiCommand } from "./whoami.js";
import { walletCommand } from "./wallet.js";
import { telegramCommand } from "./telegram.js";
import { subscriptionCommand } from "./subscription.js";
import { issueCommand, supportCommand } from "./support.js";
import { devCommand } from "./dev.js";
import { backtestCommand } from "./backtest.js";
import { updateCommand } from "./update.js";
import { versionCommand } from "./version.js";
import { getCurrentVersion } from "../engine/version.js";

const program = new Command();

program
  .name("prism")
  .description("Prism — autonomous liquidity agent")
  .version(getCurrentVersion());

program.addCommand(setupCommand);
program.addCommand(registerCommand);
program.addCommand(loginCommand);
program.addCommand(whoamiCommand);
program.addCommand(walletCommand);
program.addCommand(telegramCommand);
program.addCommand(subscriptionCommand);
program.addCommand(issueCommand);
program.addCommand(supportCommand);
program.addCommand(devCommand);
program.addCommand(backtestCommand);
program.addCommand(updateCommand);
program.addCommand(versionCommand);

await program.parseAsync();
