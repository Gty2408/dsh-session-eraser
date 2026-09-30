/**
 * Security: a hostile sessionId must never let the delete escape the
 * persistence root, and must never remove a file it does not own.
 */
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const plugin = await import("../lib/index.js");

const root = join(tmpdir(), `dsh-session-eraser-sec-${process.pid}`);
await rm(root, { recursive: true, force: true });

const project = join(root, "--proj--");
const victimDir = join(project, "victim");
await mkdir(victimDir, { recursive: true });
const canary = join(victimDir, "keep.txt");
await writeFile(canary, "must survive\n");

// A sibling file outside the root that traversal would target.
const outside = join(tmpdir(), `dsh-session-eraser-canary-${process.pid}.txt`);
await writeFile(outside, "must survive\n");

const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) console.log(`PASS ${label}`);
	else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
};

let captured;
const ctx = {
	connection: { fetch: { register: (route) => { captured = route; } } },
	get(key) {
		if (key === "sessionPersistence") {
			return {
				root,
				// Filesystem-accurate, mirroring the backend's encodeSegment exactly
				// (including the `.` / `..` special cases): only an existing artifact
				// directory reports a header.
				stat: async (id) => {
					if (id === "") return void 0;
					let encoded;
					if (id === ".") encoded = "~002E";
					else if (id === "..") encoded = "~002E~002E";
					else {
						encoded = "";
						for (const ch of id) {
							encoded += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)
								? ch
								: `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
						}
					}
					try { await stat(join(project, encoded)); } catch { return void 0; }
					return { header: { id } };
				},
				list: async () => []
			};
		}
		return void 0;
	},
	logger: { warn: (m) => console.log("   warn:", m) },
	emit: () => {}
};
plugin.apply(ctx);

const hostile = [
	"../../../etc/passwd",
	"..",
	".",
	"../../victim",
	"a/../../victim",
	"..\\..\\victim",
	"/absolute/path",
	"C:\\Windows\\System32",
	"~",
	"",
	"   "
];

// Plant a real directory at each hostile id's ESCAPED name inside the project.
// If encoding were wrong, a delete would resolve outside the root instead; if it
// is right, it can only ever touch these in-root directories.
for (const id of hostile) {
	if (id === "") continue;
	let encoded;
	if (id === ".") encoded = "~002E";
	else if (id === "..") encoded = "~002E~002E";
	else {
		encoded = "";
		for (const ch of id) {
			encoded += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)
				? ch
				: `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
		}
	}
	const dir = join(project, encoded);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "session.v4.jsonl.zstd"), "log\n");
}

for (const id of hostile) {
	let status;
	try {
		const response = await captured.fetch({ json: async () => ({ sessionId: id }) });
		const payload = await response.json();
		status = `${response.status}${payload.error !== void 0 ? `:${payload.error}` : ""}`;
	} catch (error) {
		status = `threw:${error.message}`;
	}
	check(`hostile id ${JSON.stringify(id)} did not delete anything`, true, status);
	console.log(`     -> ${status}`);
}

// The real assertions: nothing outside the intended artifact was removed.
let canaryAlive = true;
try { await stat(canary); } catch { canaryAlive = false; }
check("unrelated file inside the project survived", canaryAlive);

let outsideAlive = true;
try { await stat(outside); } catch { outsideAlive = false; }
check("file outside the persistence root survived", outsideAlive);

// A legitimate id deletes only its own directory.
const goodDir = join(project, "good-session");
await mkdir(goodDir, { recursive: true });
await writeFile(join(goodDir, "session.v4.jsonl.zstd"), "log\n");
const goodResponse = await captured.fetch({ json: async () => ({ sessionId: "good-session" }) });
const goodPayload = await goodResponse.json();
check("legitimate id deleted", goodResponse.status === 200, JSON.stringify(goodPayload));

let goodGone = false;
try { await stat(goodDir); } catch { goodGone = true; }
check("legitimate session directory removed", goodGone);

let canaryStill = true;
try { await stat(canary); } catch { canaryStill = false; }
check("sibling directory untouched by the legitimate delete", canaryStill);

await rm(root, { recursive: true, force: true });
await rm(outside, { force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);