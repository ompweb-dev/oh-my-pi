/**
 * Replaces omp's launch command, then runs the CLI from source.
 *
 * A compiled binary's entry is `cli.ts`, which loads this module only after handling
 * `--runner-info`. Upstream's `cli.ts` is the process entry when `PI_COMPILED` is set, so
 * this module only mutates the launch command and must not call `runCli` again.
 * Worker threads re-enter `cli.ts`; importing upstream's `cli.ts` dispatches them.
 */
import { runCli } from "@oh-my-pi/pi-coding-agent/cli";
import { commands } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { installSqliteLockShim } from "@oh-my-pi/pi-natives/sqlite-locks";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import Launch from "./launch";

if (Bun.isMainThread) {
	const launch = commands.find(entry => entry.name === "launch");
	if (!launch) throw new Error("omp has no launch command to replace");
	launch.load = async () => Launch;

	if (process.env.PI_COMPILED !== "true") {
		declareWorkerHostEntry();
		installSqliteLockShim();
		postmortem.installProcessHandlers();
		postmortem.registerStdioDisconnectHandling();
		runCli(process.argv.slice(2)).catch(error => postmortem.fatal(error));
	}
}
