/**
 * Verify the writer-settlement fix: a delayed (fire-and-forget) writer drain
 * that finishes AFTER the rm must not leave the session log behind.
 */
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pluginPath = process.env.DSH_SESSION_DELETE_MODULE ?? new URL("../lib/index.js", import.meta.url).href;
const plugin = await import(pluginPath);

const root = join(tmpdir(), `dsh-session-eraser-race-${process.pid}`);
await rm(root, { recursive: true, force: true });
const project = join(root, "--C-Users-gty-proj--");
const sessionId = "race1111-2222-3333-4444-555566667777";
const dir = join(project, sessionId);
await mkdir(dir, { recursive: true });
const logPath = join(dir, "session.v4.jsonl.zstd");
await writeFile(logPath, "original\n");

const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) console.log(`PASS ${label}`);
	else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
};

const events = [];
let captured;

/** Stands in for the backend write handle: close() drains late, recreating the log. */
let closing;
const handle = {
	id: sessionId,
	access: "write",
	// Mirrors the real handle's `this.closing ??= (...)`: idempotent, same promise.
	close() {
		return closing ??= (async () => {
			events.push("close:start");
			await new Promise((resolve) => setTimeout(resolve, 60));
			// The final drain writes through storage, recreating dir + log.
			await mkdir(dir, { recursive: true });
			await writeFile(logPath, "drained-late\n");
			events.push("close:end");
		})();
	}
};

const persistence = {
	root,
	tracker: { openHandles: new Set([handle]) },
	stat: async (id) => {
		if (id !== sessionId) return void 0;
		try { await stat(dir); } catch { return void 0; }
		return { header: { id } };
	},
	list: async () => []
};

const liveSession = { id: sessionId };
const ctx = {
	connection: { fetch: { register: (route) => { captured = route; return async () => {}; } } },
	get(key) {
		if (key === "sessionPersistence") return persistence;
		if (key === "sessions") return {
			get: (id) => (id === sessionId ? liveSession : void 0),
			liveEntryFor: () => ({ id: sessionId, session: liveSession }),
			// Mirrors the real teardown: the backend's session/disposed listener
			// calls writer.close() WITHOUT awaiting it.
			detachEntered: () => {
				events.push("detach");
				handle.close().catch(() => {});
			}
		};
		return void 0;
	},
	logger: { warn: (message) => console.log("   warn:", message) },
	emit: () => {}
};

plugin.apply(ctx);
const response = await captured.fetch({ json: async () => ({ sessionId }) });
const payload = await response.json();

check("delete succeeded", response.status === 200, String(response.status));
check("detach triggered the writer close", events.includes("close:start"), JSON.stringify(events));
check("writer close settled before removal", events.includes("close:end"), JSON.stringify(events));

// Let any still-running late drain finish before judging the filesystem, so the
// outcome is decided by the fix rather than by test timing.
await Promise.allSettled([handle.close()]);

let present = true;
try { await stat(logPath); } catch (error) { present = error.code !== "ENOENT"; }
check("log stays deleted after the late drain", present === false, present ? "log was recreated" : "");

let dirPresent = true;
try { await stat(dir); } catch { dirPresent = false; }
check("session directory stays deleted", dirPresent === false);

console.log("\nevents:", events.join(" -> "));
await rm(root, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);