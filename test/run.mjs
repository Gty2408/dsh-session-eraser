/**
 * Run every shipped test for `dsh-session-eraser` and report one verdict.
 *
 * The Host-side suites are hermetic (throwaway persistence roots). The `live-*`
 * suites exercise a running DSH app and self-skip when it is unreachable.
 *
 * Usage:
 *   node test/run.mjs
 *   DSH_TEST_ORIGIN=http://127.0.0.1:19387 node test/run.mjs
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = process.env.DSH_TEST_ORIGIN ?? "http://127.0.0.1:19387";

/* Is the live app answering at all? Decides whether to run the live suites. */
async function appReachable() {
	try {
		const response = await fetch(ORIGIN, { redirect: "manual" });
		return response.status > 0;
	} catch {
		return false;
	}
}

const live = await appReachable();
const files = readdirSync(here).filter((name) => name.endsWith(".test.mjs")).sort();

const results = [];
for (const file of files) {
	const isLive = file.startsWith("live-");
	if (isLive && !live) {
		results.push({ file, verdict: "SKIP (app not reachable)" });
		console.log(`\n=== ${file} === SKIP (app not reachable at ${ORIGIN})`);
		continue;
	}
	console.log(`\n=== ${file} ===`);
	try {
		const out = execFileSync(process.execPath, [join(here, file)], {
			encoding: "utf8",
			env: { ...process.env, DSH_TEST_ORIGIN: ORIGIN }
		});
		console.log(out.trim());
		const ok = out.includes("ALL PASS") || out.includes("expected true");
		results.push({ file, verdict: ok ? "PASS" : "FAIL" });
	} catch (error) {
		console.log(((error.stdout ?? "") + (error.stderr ?? "")).trim());
		results.push({ file, verdict: "FAIL" });
	}
}

console.log("\n================ summary ================");
for (const { file, verdict } of results) console.log(`${verdict.padEnd(24)} ${file}`);
const failed = results.filter((r) => r.verdict === "FAIL").length;
const passed = results.filter((r) => r.verdict === "PASS").length;
console.log(`\n${passed} passed, ${failed} failed, ${results.length - passed - failed} skipped`);
process.exit(failed === 0 ? 0 : 1);