/**
 * Exercise the session-eraser Host route against a throwaway persistence root.
 * Imports the installed plugin, captures the route through a stub Connection,
 * then drives it with fake Requests and checks the filesystem outcome.
 */
import { mkdir, readdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const plugin = await import("../lib/index.js");

const root = join(tmpdir(), `dsh-session-eraser-test-${process.pid}`);
await rm(root, { recursive: true, force: true });
const project = join(root, "--C-Users-gty-proj--");
const sessionId = "04e8f277-3694-442a-ac2f-10aae4f9fba5";
const dir = join(project, sessionId);
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "log.jsonl.zstd"), "not really zstd\n");

let captured;
const warnings = [];
const emitted = [];
const stopped = [];
const detachedFrom = [];
const ctx = {
	// `connectionOf(ctx)` uses Reflect.get(ctx, "connection"): the real Cordis Context is a
	// Proxy that resolves services as properties, so the stub must expose one too.
	connection: { fetch: { register: (route) => { captured = route; return async () => {}; } } },
	get(key) {
		if (key === "sessionPersistence") return persistence;
		return void 0; // sessions + workspaceRegistry absent: cold-session path
	},
	logger: { warn: (message) => warnings.push(message) },
	emit: (event, ...args) => emitted.push([event, ...args])
};
const persistence = {
	root,
	// Mirror the real backend: `stat` reports only artifacts that still exist on disk.
	stat: async (id) => {
		if (id !== sessionId) return void 0;
		try { await stat(dir); } catch { return void 0; }
		return { header: { id } };
	},
	list: async () => []
};

plugin.apply(ctx);

const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) console.log(`PASS ${label}`);
	else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
};

check("route path", captured?.path === "/api/session.delete", String(captured?.path));
check("route methods", JSON.stringify(captured?.methods) === '["POST"]', JSON.stringify(captured?.methods));
check("route requestBody", captured?.requestBody === "buffered", String(captured?.requestBody));

const call = (body) => captured.fetch({ json: async () => body });

// 1. unknown session -> 404
const missing = await call({ sessionId: "11111111-2222-3333-4444-555555555555" });
check("unknown session 404", missing.status === 404, String(missing.status));

// 2. malformed body -> 400
const bad = await call({ sessionId: "   " });
check("blank sessionId 400", bad.status === 400, String(bad.status));

// 3. real deletion
const ok = await call({ sessionId });
const payload = await ok.json();
check("delete 200", ok.status === 200, String(ok.status));
check("delete status payload", payload.status === "deleted", JSON.stringify(payload));
check("artifact removed count", payload.removed === 1, String(payload.removed));

let gone = false;
try { await stat(dir); } catch (error) { gone = error.code === "ENOENT"; }
check("session directory gone", gone);

const leftover = await readdir(project);
check("project directory retained", leftover.length === 0, JSON.stringify(leftover));

check("api-session/removed emitted", emitted.some(([event, id]) => event === "api-session/removed" && id === sessionId), JSON.stringify(emitted));
check("no warnings", warnings.length === 0, JSON.stringify(warnings));

// 4. idempotent second call -> 404, no throw
const again = await call({ sessionId });
check("second delete 404", again.status === 404, String(again.status));

await rm(root, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);