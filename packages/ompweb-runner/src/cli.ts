#!/usr/bin/env bun
/**
 * ompweb's omp: upstream omp's CLI with the root launch command replaced (see `launch.ts`).
 *
 * `--runner-info` is handled here, before `cli-main` imports `@oh-my-pi/pi-coding-agent/cli`.
 * Static imports are hoisted, and a compiled binary starts the CLI as that module's side effect.
 */
import { writeSync } from "node:fs";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { runnerInfoLine } from "./protocol";

if (Bun.isMainThread && process.argv[2] === "--runner-info") {
	writeSync(1, `${runnerInfoLine(VERSION)}\n`);
	process.exit(0);
}

require("./cli-main");
