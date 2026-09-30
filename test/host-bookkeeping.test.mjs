/**
 * Deleting a session must clear the registry-global bookkeeping that names it.
 *
 * A session can be archived and/or pinned. Both are just id lists held by the
 * workspace registry. Deleting the session removes the row those lists refer to,
 * so nothing in the UI can ever offer to unarchive or unpin it — the id dangles
 * forever, and an archived id also keeps the session out of the default sidebar
 * filter's accounting.
 *
 * Both removal APIs skip the session-existence check by design ("an entry whose
 * session is gone still resolves"), which is precisely this case.
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

const root = join(tmpdir(), `dsh-bookkeeping-${process.pid}`);
await rm(root, { recursive: true, force: true });
const project = join(root, "--proj--");
const sessionId = "bookkeep111-2222-3333-4444-55556666";
const dir = join(project, sessionId);
await mkdir(dir, { recursive: true });
const logPath = join(dir, "session.v4.jsonl.zstd");
await writeFile(logPath, "log\n");

/* Registry state that names this session in BOTH lists. */
let archived = [sessionId, "some-other-session"];
let pinned = [sessionId, "another-session"];
const calls = [];

let captured;
const ctx = {
	connection: { fetch: { register: (route) => { captured = route; return async () => {}; } } },
	get(key) {
		if (key === "sessionPersistence") return {
			root,
			tracker: { openHandles: new Set() },
			stat: async (id) => {
				if (id !== sessionId) return void 0;
				try { await stat(dir); } catch { return void 0; }
				return { header: { id } };
			},
			list: async () => []
		};
		if (key === "workspaceRegistry") return {
			list: () => [],
			stopSessionActivity: async () => {},
			replaceHeaderIndex: async () => {},
			indexLiveSessions: async () => {},
			unarchiveSession: async (id) => {
				calls.push(`unarchive:${id}`);
				archived = archived.filter((x) => x !== id);
			},
			unpinSession: async (id) => {
				calls.push(`unpin:${id}`);
				pinned = pinned.filter((x) => x !== id);
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

check("delete succeeded", response.status === 200, `${response.status} ${JSON.stringify(payload)}`);
check("the artifact is gone", !(await stat(logPath).then(() => true, () => false)));

check("the archive list was cleared for this session", !archived.includes(sessionId), JSON.stringify(archived));
check("the pin list was cleared for this session", !pinned.includes(sessionId), JSON.stringify(pinned));
check("unrelated archive entries were left alone", archived.includes("some-other-session"), JSON.stringify(archived));
check("unrelated pin entries were left alone", pinned.includes("another-session"), JSON.stringify(pinned));
check("both removals were actually invoked", calls.length === 2, JSON.stringify(calls));

await rm(root, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);