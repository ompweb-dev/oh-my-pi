import { describe, expect, it } from "bun:test";
import { RUNNER_PROTOCOL, runnerInfoLine } from "../src/protocol";

describe("runner protocol", () => {
	it("prints the contract line", () => {
		expect(RUNNER_PROTOCOL).toBe(1);
		expect(runnerInfoLine("18.22.0-int.202611171027.gec3956c")).toBe(
			'{"protocol":1,"omp":"18.22.0-int.202611171027.gec3956c"}',
		);
	});
});
