/**
 * Exercise the session-eraser Host route's LIVE-session branch.
 *
 * The ordering under test: workspace owners are captured from the filtered
 * `sessionIds` projection BEFORE `replaceHeaderIndex` prunes the id, so the
 * durable accounting slot is still dropped afterwards.
 */
import { mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const plugin = await import("../lib/index.js");

const root = join(tmpdir(), `dsh-session-eraser-live-${process.pid}`);
await rm(root, { recursive: true, force: true });
const project = join(root, "--C-Users-gty-proj--");
const sessionId = "aaaa1111-bbbb-2222-cccc-333344445555";
const dir = join(project, sessionId);
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "log.jsonl.zstd"), "x\n");

const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) console.log(`PASS ${label}`);
	else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
};

const calls = [];
let captured;

const liveSession = { id: sessionId, seq: 4 };
const storeEntry = { id: sessionId, session: liveSession };

// Records every mutation so the ordering assertions can read it.
const events = [];
const persistence = {
	root,
	stat: async (id) => {
		if (id !== sessionId) return void 0;
		try { await stat(dir); } catch { return void 0; }
		return { header: { id, cwd: "C:\\Users\\gty\\proj" } };
	},
	list: async () => []
};

const sessions = {
	get: (id) => (id === sessionId ? liveSession : void 0),
	liveEntryFor: (session) => {
		events.push("liveEntryFor");
		if (session !== liveSession) throw new Error("wrong session");
		return storeEntry;
	},
	detachEntered: (entry) => {
		events.push("detachEntered");
		if (entry !== storeEntry) throw new Error("wrong entry");
	}
};

// Owner membership is gated on the header index, exactly like the real getter.
let indexed = true;
const entity = {
	id: "ws-1",
	get sessionIds() { return indexed ? [sessionId] : []; },
	detachSession: async (id) => { events.push(`detachSession:${id}`); indexed = false; }
};

const workspaces = {
	list: () => { events.push("list"); return [entity]; },
	stopSessionActivity: async (id) => { events.push(`stop:${id}`); },
	replaceHeaderIndex: async (headers) => { events.push("replaceHeaderIndex"); indexed = false; },
	indexLiveSessions: async () => { events.push("indexLiveSessions"); }
};

const warnings = [];
const emitted = [];
const ctx = {
	connection: { fetch: { register: (route) => { captured = route; return async () => {}; } } },
	get(key) {
		if (key === "sessionPersistence") return persistence;
		if (key === "sessions") return sessions;
		if (key === "workspaceRegistry") return workspaces;
		return void 0;
	},
	logger: { warn: (message) => warnings.push(message) },
	emit: (event, ...args) => emitted.push([event, ...args])
};

plugin.apply(ctx);

const response = await captured.fetch({ json: async () => ({ sessionId }) });
const payload = await response.json();

check("live delete 200", response.status === 200, String(response.status));
check("reported live", payload.live === true, JSON.stringify(payload));
check("reported detached", payload.detached === true, JSON.stringify(payload));
check("artifact removed", payload.removed === 1, String(payload.removed));

// The decisive ordering assertion.
const indexAt = events.indexOf("list");
const pruneAt = events.indexOf("replaceHeaderIndex");
const detachAt = events.findIndex((e) => e.startsWith("detachSession:"));
check("owner captured before re-index", indexAt >= 0 && indexAt < pruneAt, JSON.stringify(events));
check("stop preceded detach", events.indexOf(`stop:${sessionId}`) < events.indexOf("detachEntered"), JSON.stringify(events));
check("durable slot dropped after prune", detachAt > pruneAt, JSON.stringify(events));
check("live session detached", events.includes("detachEntered"), JSON.stringify(events));
check("api-session/removed emitted", emitted.some(([e, id]) => e === "api-session/removed" && id === sessionId), JSON.stringify(emitted));
check("no warnings", warnings.length === 0, JSON.stringify(warnings));

let gone = false;
try { await stat(dir); } catch (error) { gone = error.code === "ENOENT"; }
check("session directory gone", gone);

console.log("\nevent order:", events.join(" -> "));
await rm(root, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);