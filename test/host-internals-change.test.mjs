/**
 * Deletion must be correct even when the persistence internals it reads change
 * shape.
 *
 * `settleWriter` finds the write handle through `persistence.tracker.openHandles`
 * — an undocumented internal. If that is renamed or removed, the helper finds
 * nothing and returns false (it fails OPEN), leaving the backend's
 * fire-and-forget `writer.close()` drain free to recreate the log after the
 * removal. This drives exactly that scenario with the internal absent, and
 * asserts the deletion still ends with the log gone.
 */
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const plugin = await import("../lib/index.js");

const failures = [];
const check = (label, ok, detail = "") => {
	if (!ok) failures.push(label);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
};

const root = join(tmpdir(), `dsh-internals-${process.pid}`);
await rm(root, { recursive: true, force: true });
const project = join(root, "--proj--");
const sessionId = "internals111-2222-3333-4444-55556666";
const dir = join(project, sessionId);
await mkdir(dir, { recursive: true });
const logPath = join(dir, "session.v4.jsonl.zstd");
await writeFile(logPath, "original\n");

/* A writer whose drain lands late, exactly as the real fire-and-forget close
   does. Its handle is NOT reachable through `openHandles` — the internal the
   helper reads is gone. */
const events = [];
const handle = {
	id: sessionId,
	access: "write",
	close: () => {
		if (handle.closing !== void 0) return handle.closing;
		handle.closing = (async () => {
			events.push("close:start");
			await new Promise((resolve) => setTimeout(resolve, 250));
			await mkdir(dir, { recursive: true });
			await writeFile(logPath, "drained-late\n");
			events.push("close:end");
		})();
		return handle.closing;
	}
};

let captured;
const persistence = {
	root,
	/* Deliberately the WRONG shape: no `tracker`, so settleWriter cannot find
	   the handle and returns false. */
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
			detachEntered: () => {
				events.push("detach");
				handle.close().catch(() => {});
			}
		};
		return void 0;
	},
	logger: { warn: () => {} },
	emit: () => {}
};

plugin.apply(ctx);
const response = await captured.fetch({ json: async () => ({ sessionId }) });
const payload = await response.json();

check("delete succeeded", response.status === 200, String(response.status));
check("the late drain did run", events.includes("close:start"), JSON.stringify(events));

/* Let the late drain land, then judge. The plugin's bounded re-check window
   must have absorbed it. */
await Promise.allSettled([handle.close()]);

let present = false;
try { await stat(logPath); present = true; } catch { /* gone */ }
check("the log is gone despite the internal being absent", present === false, present ? "log was recreated" : "");

let dirPresent = true;
try { await stat(dir); } catch { dirPresent = false; }
check("the session directory is gone too", dirPresent === false);

check("the caller was not told a lie", payload.ok === true && present === false, JSON.stringify(payload));

await rm(root, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);