/**
 * Prove the writer-settlement fix is load-bearing.
 *
 * Runs the race scenario twice: once against a build with the settle + re-remove
 * logic stripped, and once against the real build. The stripped variant is
 * written to a throwaway directory and addressed through
 * `DSH_SESSION_DELETE_MODULE`, so the installed plugin is never modified.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const SRC = new URL("../lib/index.js", import.meta.url);
const RACE = new URL("./host-writer-race.test.mjs", import.meta.url);

const original = readFileSync(SRC, "utf8");

/* Strip the writer-settlement mechanism, leaving the naive delete: the
   settleWriter join, the public-flush fallback, and the re-remove window. */
let stripped = original.replace(
	/\tlet settled = false;\n\tif \(detached\) \{\n[\s\S]*?\n\t\}\n(?=\tif \(typeof root)/,
	"\tconst settled = false;\n"
);
stripped = stripped.replace(
	/\tconst removed = \[\];\n\tlet survivors = \[\];\n[\s\S]*?\n\t\}\n(?=\t\/\* `rm` fails)/,
	"\tconst removed = [];\n\tlet survivors = [];\n\tfor (const artifact of artifacts) {\n\t\ttry {\n\t\t\tawait rm(artifact, { recursive: true, force: true });\n\t\t\tremoved.push(artifact);\n\t\t} catch (error) {\n\t\t\tctx.logger.warn(`could not remove \"${artifact}\": ${String(error)}`);\n\t\t}\n\t}\n\tsurvivors = artifacts.filter((artifact) => existsSync(artifact));\n"
);

if (stripped === original) {
	console.log("STRIP FAILED - patterns did not match");
	process.exit(2);
}

/* Stage the stripped build somewhere disposable; the plugin stays untouched. */
const stage = join(tmpdir(), `dsh-session-eraser-control-${process.pid}`);
mkdirSync(stage, { recursive: true });
const strippedPath = join(stage, "index.js");
writeFileSync(strippedPath, stripped);

const run = (label, moduleUrl) => {
	console.log(`\n=== ${label} ===`);
	try {
		const out = execFileSync(process.execPath, [fileURLToPath(RACE)], {
			encoding: "utf8",
			env: { ...process.env, DSH_SESSION_DELETE_MODULE: moduleUrl }
		});
		console.log(out.trim());
		return out.includes("ALL PASS");
	} catch (error) {
		console.log(((error.stdout ?? "") + (error.stderr ?? "")).trim());
		return false;
	}
};

const controlPassed = run("WITHOUT the fix (control)", pathToFileURL(strippedPath).href);
const fixedPassed = run("WITH the fix", SRC.href);

rmSync(stage, { recursive: true, force: true });

console.log("\n--- verdict ---");
console.log("control (no fix) passed:", controlPassed, "-> expected false");
console.log("fixed passed:", fixedPassed, "-> expected true");
process.exit(!controlPassed && fixedPassed ? 0 : 1);