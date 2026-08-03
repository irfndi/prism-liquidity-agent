import { Command } from "commander";
import { readCredentials } from "./api.js";
import {
  getTelemetryPreferencePath,
  readTelemetryPreference,
  writeTelemetryPreference,
} from "../engine/telemetry-preference.js";

function isEnabled(): boolean {
  return process.env.PRISM_ERROR_REPORTING !== "false" && readTelemetryPreference().enabled;
}

const statusCommand = new Command("status")
  .description("Show telemetry configuration")
  .action(() => {
    const preference = readTelemetryPreference();
    console.log("Prism telemetry");
    console.log(`  Enabled:       ${isEnabled() ? "yes" : "no"}`);
    console.log(`  Local opt-out: ${preference.enabled ? "no" : "yes"}`);
    console.log(`  Env override:  ${process.env.PRISM_ERROR_REPORTING ?? "default-on"}`);
    console.log(`  Registered:    ${readCredentials() ? "yes" : "no"}`);
    console.log(`  Preference:    ${getTelemetryPreferencePath()}`);
  });

const disableCommand = new Command("disable")
  .description("Disable client error telemetry")
  .action(() => {
    const result = writeTelemetryPreference(false);
    if (!result.ok) {
      console.error(`Failed to write telemetry preference: ${result.error ?? "unknown error"}`);
      process.exitCode = 1;
      return;
    }
    console.log("Telemetry disabled. Run 'prism telemetry enable' to re-enable it.");
  });

const enableCommand = new Command("enable")
  .description("Enable client error telemetry")
  .action(() => {
    const result = writeTelemetryPreference(true);
    if (!result.ok) {
      console.error(`Failed to write telemetry preference: ${result.error ?? "unknown error"}`);
      process.exitCode = 1;
      return;
    }
    console.log("Telemetry enabled for registered clients.");
  });

export const telemetryCommand = new Command("telemetry")
  .description("Inspect or control Prism client error telemetry")
  .addCommand(statusCommand)
  .addCommand(disableCommand)
  .addCommand(enableCommand);
