#!/usr/bin/env bun
/**
 * Compiles `src/cli.ts` into `release/ompweb-omp-<os>-<arch>`.
 *
 * Cross-compiles from Linux the same way omp's release binaries do
 * (`packages/coding-agent/scripts/compile-binary.ts`): addons come from
 * `packages/natives/native`, already built for the target.
 *
 * Usage: `bun scripts/build-binary.ts [target...]`; with no target it builds the host's.
 */
import * as path from "node:path";
import { $ } from "bun";
import { compileCodingAgent } from "../../coding-agent/scripts/compile-binary";

interface Target {
	readonly platform: string;
	readonly arch: string;
	readonly bun: Bun.Build.CompileTarget;
	readonly outName: string;
}

const TARGETS: Record<string, Target> = {
	"linux-x64": { platform: "linux", arch: "x64", bun: "bun-linux-x64-baseline", outName: "ompweb-omp-linux-x64" },
	"linux-arm64": { platform: "linux", arch: "arm64", bun: "bun-linux-arm64", outName: "ompweb-omp-linux-arm64" },
	"darwin-x64": { platform: "darwin", arch: "x64", bun: "bun-darwin-x64", outName: "ompweb-omp-darwin-x64" },
	"darwin-arm64": { platform: "darwin", arch: "arm64", bun: "bun-darwin-arm64", outName: "ompweb-omp-darwin-arm64" },
	"windows-x64": {
		platform: "win32",
		arch: "x64",
		bun: "bun-windows-x64-baseline",
		outName: "ompweb-omp-windows-x64.exe",
	},
};

const runnerDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(runnerDir, "../..");

const hostId = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const ids = process.argv.length > 2 ? process.argv.slice(2) : [hostId];
for (const id of ids) {
	if (!TARGETS[id]) throw new Error(`unknown target ${id}; expected one of ${Object.keys(TARGETS).join(", ")}`);
}

// Embeds the `omp stats` dashboard the way omp's release does, then restores the checked-in placeholder.
await $`bun run gen:stats`.cwd(repoRoot);
try {
	for (const id of ids) {
		const target = TARGETS[id];
		const outfile = path.join(runnerDir, "release", target.outName);
		console.log(`Building ${path.relative(runnerDir, outfile)}...`);
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(runnerDir, "src", "cli.ts"),
			outfile,
			native: { platform: target.platform, arch: target.arch },
			target: target.bun,
			minifyIdentifiers: true,
			// Type-only modules of several packages (`tui/src/render/types.ts`, `coding-agent/src/dap/types.ts`) emit identical chunks.
			chunkNaming: "chunks/[dir]/[name]-[hash].[ext]",
		});
	}
} finally {
	await $`bun run gen:stats:reset`.cwd(repoRoot);
}
