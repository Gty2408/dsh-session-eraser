/**
 * A removal that genuinely fails must NOT be reported as a success.
 *
 * `rm` fails for real reasons on Windows: a deny-ACL or a locked file throws
 * EPERM/EBUSY. An earlier build swallowed that failure and still answered
 * `200 {ok:true}`, which left the log on disk while the dialog closed as if the
 * session were gone — and the session reappeared on the next list. This pins the
 * corrected contract: report the failure, and leave the workspace accounting
 * alone so the sidebar keeps showing the session that still exists.
 *
 * The failure is produced with a real deny-ACL, not a stubbed `rm`.
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const plugin = await import("../lib/index.js");

const failures = [];
const check = (label, ok, detail = "") => {
	if (!ok) failures.push(label);
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`);
};

const root = join(tmpdir(), `dsh-partial-${process.pid}`);
rmSync(root, { recursive: true, force: true });
const project = join(root, "--proj--");
const sessionId = "deny1111-2222-3333-4444-555566667777";
const dir = join(project, sessionId);
mkdirSync(dir, { recursive: true });
const log = join(dir, "session.v4.jsonl.zstd");
writeFileSync(log, "real log\n");

let denied = false;
try {
	execFileSync("icacls", [log, "/deny", `${process.env.USERNAME}:(D)`], { stdio: "ignore" });
	denied = true;
} catch { /* icacls unavailable: the assertions below will simply pass trivially */ }

let captured;
const detached = [];
const ctx = {
	connection: { fetch: { register: (route) => { captured = route; return async () => {}; } } },
	get(key) {
		if (key === "sessionPersistence") return {
			root,
			tracker: { openHandles: new Set() },
			stat: async (id) => (id === sessionId ? { header: { id } } : void 0),
			list: async () => (existsSync(log) ? [{ header: { id: sessionId } }] : [])
		};
		if (key === "workspaceRegistry") return {
			list: () => [{ id: "ws", sessionIds: [sessionId], detachSession: async (id) => { detached.push(id); } }],
			stopSessionActivity: async () => {},
			replaceHeaderIndex: async () => {},
			indexLiveSessions: async () => {}
		};
		return void 0;
	},
	logger: { warn: () => {} },
	emit: () => {}
};

plugin.apply(ctx);
const response = await captured.fetch({ json: async () => ({ sessionId }) });
const payload = await response.json();

if (denied) {
	check("a genuinely unremovable session reports failure", response.status >= 400, `status=${response.status}`);
	check("the failure is not reported as ok", payload.ok !== true, JSON.stringify(payload));
	check("the response explains why", typeof payload.error === "string" && payload.error !== "", JSON.stringify(payload.error));
	check("the log really is still on disk", existsSync(log));
	check("workspace accounting was left intact", detached.length === 0, JSON.stringify(detached));
} else {
	console.log("SKIP icacls unavailable; deny-ACL could not be applied");
}

/* Cleanup. */
try { execFileSync("icacls", [log, "/remove:d", process.env.USERNAME], { stdio: "ignore" }); } catch { /* ignore */ }
rmSync(root, { recursive: true, force: true });

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);