/** Protocol this runner speaks. Bump only when an older ompweb server cannot speak it. */
export const RUNNER_PROTOCOL = 1;

/** One JSON line printed by `ompweb-omp --runner-info`. */
export function runnerInfoLine(omp: string): string {
	return JSON.stringify({ protocol: RUNNER_PROTOCOL, omp });
}
