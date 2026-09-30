/**
 * True end-to-end test of POST /api/session.delete against the LIVE app.
 *
 * Mints a valid browser-session cookie from the readable signing secret (the
 * cookie format is documented in dsh-client-connection: `v1.<body>.<sig>` with
 * an authority-bound payload), then exercises the real HTTP stack: the 401 gate,
 * the /api prefix route, the Fetch bridge, and the plugin's handler.
 *
 * Targets a synthetic session so no real data is at risk.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import zlib from "node:zlib";

const ORIGIN = process.env.DSH_TEST_ORIGIN ?? "http://127.0.0.1:19387";
const AUTHORITY = new URL(ORIGIN).host;
const CREDENTIALS = `${process.env.USERPROFILE ?? process.env.HOME}/.dsh/.credentials.yaml`;
const ROOT = `${process.env.USERPROFILE ?? process.env.HOME}/.dsh/sessions/--C-Users-gty-Documents-deepseek-harness-default-workspace--`;

const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) console.log(`PASS ${label}`);
	else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
};

// --- read the signing secret the Host loaded at activation -------------------
const yaml = readFileSync(CREDENTIALS, "utf8");
const secretLine = yaml.split("\n").find((line) => line.trim().startsWith("secret:"));
const secretB64 = secretLine?.split("secret:")[1]?.trim();
check("read the browser-session signing secret", typeof secretB64 === "string" && secretB64.length > 0, String(secretB64));

const b64url = (buf) => Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(secretB64.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - secretB64.length % 4) % 4), "base64");
check("decoded the signing secret to 32 bytes", secret.byteLength === 32, String(secret.byteLength));

const now = Date.now();
const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400000 };
const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
const sig = b64url(createHmac("sha256", secret).update(body).digest());
const cookieValue = `v1.${body}.${sig}`;

// Cookie name = "dsh-auth-" + base64url(sha256(authority))
const cookieName = "dsh-auth-" + b64url(createHmac ? (await import("node:crypto")).createHash("sha256").update(AUTHORITY).digest() : "");
const cookieHeader = `${cookieName}=${cookieValue}`;
console.log(`     cookie name: ${cookieName}`);

// --- 1. the unauthenticated gate still holds --------------------------------
const noAuth = await fetch(`${ORIGIN}/api/session.delete`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ sessionId: "x" })
});
check("unauthenticated request is refused with 401", noAuth.status === 401, String(noAuth.status));

// --- 2. authenticated, unknown session -> 404 --------------------------------
const unknown = await fetch(`${ORIGIN}/api/session.delete`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie: cookieHeader },
	body: JSON.stringify({ sessionId: "session-does-not-exist-xyz" })
});
check("authenticated cookie is accepted (not 401)", unknown.status !== 401, String(unknown.status));
check("unknown session returns 404", unknown.status === 404, `${unknown.status} ${await unknown.text()}`);

// --- 3. authenticated, malformed body -> 400 --------------------------------
const blank = await fetch(`${ORIGIN}/api/session.delete`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie: cookieHeader },
	body: JSON.stringify({ sessionId: "   " })
});
check("blank sessionId returns 400", blank.status === 400, String(blank.status));

// --- 4. authenticated, real synthetic session -> 200 and artifact gone -------
const id = "session-eeeeeeee-1111-2222-3333-444444444444";
const dir = join(ROOT, id);
const log = join(dir, "session.v4.jsonl.zstd");
if (!existsSync(log)) {
	mkdirSync(dir, { recursive: true });
	const header = { type: "session", version: 4, id, createdAt: Date.now(), cwd: process.env.DSH_TEST_CWD ?? process.cwd(), isSeeded: false, delegationDepth: 0, agentPreset: "standard" };
	writeFileSync(log, zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n", "utf8")));
}
check("synthetic session artifact exists before the call", existsSync(log));

const deleted = await fetch(`${ORIGIN}/api/session.delete`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie: cookieHeader },
	body: JSON.stringify({ sessionId: id })
});
const deletedText = await deleted.text();
check("real deletion returns 200", deleted.status === 200, `${deleted.status} ${deletedText}`);
let deletedBody;
try { deletedBody = JSON.parse(deletedText); } catch { deletedBody = void 0; }
check("response reports ok and at least one removed artifact", deletedBody?.ok === true && deletedBody?.removed >= 1, deletedText);

await new Promise((resolve) => setTimeout(resolve, 400));
check("session directory is gone from disk after the call", !existsSync(dir));
check("the project directory itself survived", existsSync(ROOT));

// --- 5. deleting again -> 404 (the deletion was durable) --------------------
const again = await fetch(`${ORIGIN}/api/session.delete`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie: cookieHeader },
	body: JSON.stringify({ sessionId: id })
});
check("second deletion returns 404", again.status === 404, String(again.status));

// --- 6. the route is registered exactly, and rejects the wrong method -------
const wrongMethod = await fetch(`${ORIGIN}/api/session.delete`, {
	method: "GET",
	headers: { cookie: cookieHeader }
});
check("GET on the delete route does not succeed", wrongMethod.status !== 200, String(wrongMethod.status));

rmSync(dir, { recursive: true, force: true });
console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);