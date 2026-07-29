#!/usr/bin/env bun
import { registerEventsCommands } from "@hasna/events/commander";
import { program } from "commander";
import chalk from "chalk";
import { formatCliError } from "../data/config-store.js";
import { pkg } from "./shared.js";
import "./commands-core.js";
import "./commands-profile.js";
import "./commands-session.js";
import "./commands-admin.js";
import "./commands-maintenance.js";

program.version(pkg.version).name("instructions");
registerEventsCommands(program, { source: "configs" });

// Use parseAsync so async action rejections are awaited and routed through a
// single top-level handler.
program.parseAsync(process.argv).catch((error) => {
  console.error(chalk.red(formatCliError(error)));
  process.exit(1);
});
