/**
 * Confirm the LIVE app serves the guarded client bundle: mint a valid
 * browser-session cookie, read the boot payload to find the plugin's exact
 * revisioned combo URL, then verify the served bytes carry the guard.
 */
import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";

const ORIGIN = process.env.DSH_TEST_ORIGIN ?? "http://127.0.0.1:19387";
const AUTHORITY = new URL(ORIGIN).host;

const yaml = readFileSync(`${process.env.USERPROFILE ?? process.env.HOME}/.dsh/.credentials.yaml`, "utf8");
const secretB64 = yaml.split("\n").find((l) => l.trim().startsWith("secret:")).split("secret:")[1].trim();
const b64url = (b) => Buffer.from(b).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(secretB64.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - secretB64.length % 4) % 4), "base64");
const now = Date.now();
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400000 }), "utf8"));
const cookie = `dsh-auth-${b64url(createHash("sha256").update(AUTHORITY).digest())}=v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) console.log(`PASS ${label}`);
	else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
};

const index = await fetch(`${ORIGIN}/`, { headers: { cookie } });
check("authenticated index is served", index.status === 200, String(index.status));
const html = await index.text();

// The boot payload advertises the exact revisioned URL for each entry.
const boot = html.match(/__DSH_BOOT__"?\]\s*=\s*(\{.*?\})<\/script>/s)?.[1] ?? html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/s)?.[1];
check("read the boot payload", typeof boot === "string" && boot.length > 0);
let parsed;
try { parsed = JSON.parse(boot); } catch (error) { console.log("   boot parse failed:", error.message); }
const entry = parsed?.entries?.find((e) => e.id === "dsh-session-eraser");
check("boot payload lists dsh-session-eraser", entry !== void 0, JSON.stringify(entry));
console.log(`     url: ${entry?.url}`);
check("entry declares the expected inject list", Array.isArray(entry?.inject) && entry.inject.includes("@deepseek-ai/dsh-client-ui-workspace"));

// Fetch the exact revisioned combo URL the browser would load.
const served = await fetch(`${ORIGIN}/${entry.url}`, { headers: { cookie } });
check("revisioned combo bundle is served", served.status === 200, String(served.status));
const text = await served.text();
console.log(`     served bytes: ${text.length}`);

check("served bundle carries the open-session guard helper", text.includes("useIsOpenSession"));
check("served bundle carries the guarded menu copy", text.includes("guard.menu"));
check("served bundle renders nothing for the open session", text.includes("if (isOpen) return null"));
check("served bundle carries the confirm-time recheck", text.includes("busy || isOpen"));
check("served bundle re-checks retention in the dialog", text.includes("useIsOpenSession(useSessionRetainInfo, request.sessionId)"));
check("served bundle registers all three entry points", text.includes("sidebar.workspaces.session.menu.item") && text.includes("sidebar.workspaces.session.row.action") && text.includes("shell.overlay"));

// A stale revision must be rejected rather than silently serving new bytes.
const stale = await fetch(`${ORIGIN}/plugins/??dsh-session-eraser/client.js&rev=000000000000`, { headers: { cookie } });
check("a stale revision is not served as 200", stale.status !== 200, String(stale.status));

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);