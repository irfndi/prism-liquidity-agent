import { config } from "dotenv";
import { ensurePrismConfigDir, getPrismEnvPath } from "./paths.js";

ensurePrismConfigDir();
config({ path: getPrismEnvPath() });
