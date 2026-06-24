#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { VERSION } from "@junction/core"
import { defineCommand, runMain } from "citty"
import { initCommand } from "./commands/init.js"
import { statusCommand } from "./commands/status.js"

const main = defineCommand({
  meta: {
    name: "junction",
    version: VERSION,
    description: "Junction — connect your platforms once, reach them anywhere.",
  },
  subCommands: {
    init: initCommand,
    status: statusCommand,
  },
})

runMain(main)
