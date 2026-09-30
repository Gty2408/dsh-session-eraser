/**
 * Session deletion for the DSH desktop profile.
 *
 * Adds one authenticated Host route (`POST /api/session.delete`) that tears a
 * session down and removes its stored artifact:
 *
 *  1. stop running work through the Workspace registry's `workspace/session-stop`
 *     providers (the Agent registry answers it with `agent.cancel`);
 *  2. detach the live session from the Session store, which closes the
 *     persistence write handle and emits `session/disposed` — the Session
 *     controller turns that into `api-session/removed` for the browser — then
 *     await that (fire-and-forget) close so its final drain cannot recreate the
 *     log after deletion;
 *  3. delete the JSONL session directory under the configured persistence root;
 *  4. rebuild the workspace header index and drop the durable accounting slot;
 *  5. emit `api-session/removed` so cold sessions (which never dispose) vanish
 *     from the sidebar immediately instead of waiting for a list refresh.
 *
 * Only Node builtins are imported: the profile resolves `@deepseek-ai/*` through
 * a bootstrap that this plugin deliberately does not depend on.
 */
import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Cordis plugin identity, for logs and the loader row. */
const name = "session-eraser";
/** The Connection service owns the browser-reachable `/api` Fetch registry. */
const inject = ["connection"];
/** Absolute registration path; the browser addresses it document-relative. */
const SESSION_DELETE_PATH = "/api/session.delete";
/** Legacy flat artifact suffixes the JSONL backend still recognises. */
const LEGACY_SUFFIXES = [".jsonl", ".jsonl.zstd"];
/**
 * Re-check window used when the writer close could NOT be awaited. Each attempt
 * waits, re-removes anything a late drain restored, and re-checks.
 */
const SETTLE_ATTEMPTS = 6;
/** Delay between settle re-checks; the window is attempts × delay. */
const SETTLE_DELAY_MS = 150;

/** Wait one bounded settle interval. */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the Connection service off the context without a static import. */
function connectionOf(ctx) {
	return Reflect.get(ctx, "connection");
}

/**
 * Encode one session id into its storage directory name, mirroring the JSONL
 * backend's `encodeSegment` so the artifact can be found without its private
 * API. Session ids are ASCII in practice, but the per-code-unit loop keeps the
 * mapping exact for any input.
 * @param raw - the session id to encode.
 * @returns the directory name the backend stores that id under.
 */
function encodeSegment(raw) {
	if (raw === "") throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let index = 0; index < raw.length; index += 1) {
		const ch = raw[index];
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return out;
}

/**
 * Every physical artifact path this id could own under the persistence root.
 * The id alone locates the artifact, so every project directory is scanned
 * rather than recomputing the backend's project-key encoding.
 * @param root - resolved persistence root.
 * @param sessionId - the session whose artifacts to locate.
 * @returns existing directory and legacy flat-file paths.
 */
async function locateArtifacts(root, sessionId) {
	const target = encodeSegment(sessionId);
	const found = [];
	let projects;
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return found;
		throw error;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = join(root, project.name, target);
		try {
			if ((await stat(dir)).isDirectory()) found.push(dir);
		} catch {
			/* absent in this project directory */
		}
		for (const suffix of LEGACY_SUFFIXES) {
			const flat = join(root, project.name, `${target}${suffix}`);
			try {
				if ((await stat(flat)).isFile()) found.push(flat);
			} catch {
				/* absent */
			}
		}
	}
	return found;
}

/**
 * Await the persistence write handle's close for one session.
 *
 * Detaching a live session makes the backend's `session/disposed` listener call
 * `writer.close()` **without awaiting it**, and that close drains the buffered
 * live events through the still-open storage before releasing the write claim.
 * Deleting the artifact before it settles would let the final drain recreate the
 * log file (and its directory) after the removal. The handle's `close` is
 * idempotent, so awaiting it here joins the listener's in-flight close.
 *
 * @param persistence - the session-persistence service.
 * @param sessionId - the session whose writer to settle.
 * @returns true when a write handle was found and awaited.
 */
async function settleWriter(persistence, sessionId) {
	const tracker = Reflect.get(persistence, "tracker");
	const handles = tracker === void 0 ? void 0 : Reflect.get(tracker, "openHandles");
	if (!(handles instanceof Set)) return false;
	const closing = [];
	for (const handle of [...handles]) {
		if (handle?.id !== sessionId || handle.access !== "write") continue;
		if (typeof handle.close !== "function") continue;
		closing.push(Promise.resolve(handle.close()));
	}
	if (closing.length === 0) return false;
	/* A drain failure must not block the deletion the user asked for. */
	await Promise.allSettled(closing);
	return true;
}

/**
 * Tear one session down and delete its stored artifact.
 * @param ctx - Host context carrying the persistence, session, and workspace services.
 * @param sessionId - the session to delete.
 * @returns a JSON-serializable outcome record.
 */
async function deleteSession(ctx, sessionId) {
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) throw new Error("session deletion is unavailable: no session-persistence service");
	const sessions = ctx.get("sessions");
	const workspaces = ctx.get("workspaceRegistry");

	let stored;
	try {
		stored = await persistence.stat(sessionId);
	} catch (error) {
		throw new Error(`session "${sessionId}" could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	const live = sessions?.get(sessionId);
	if (stored === void 0 && live === void 0) return { status: "not-found" };

	/* Capture the workspaces that still account this session before re-indexing
	   prunes the id out of their filtered `sessionIds` projection. */
	const owners = workspaces === void 0 ? [] : workspaces.list().filter((entity) => entity.sessionIds.includes(sessionId));

	/* Stop running work first: a cancelled turn cannot append after teardown. */
	if (live !== void 0 && workspaces !== void 0) await workspaces.stopSessionActivity(sessionId);

	let detached = false;
	if (live !== void 0 && sessions !== void 0) {
		try {
			const entry = sessions.liveEntryFor(live);
			sessions.detachEntered(entry);
			detached = true;
		} catch (error) {
			ctx.logger.warn(`session-eraser: could not detach live session "${sessionId}": ${String(error)}`);
		}
	}

	const root = Reflect.get(persistence, "root");
	/* Join the fire-and-forget writer close triggered by `session/disposed`
	   before removing anything, so its final drain cannot recreate the log.
	   `settleWriter` reads an undocumented internal (`tracker.openHandles`);
	   when it finds nothing it FAILS OPEN. In that case lean on the persistence
	   service's public durability barrier instead: `flush()` drains every
	   active write handle (and a closing handle drains durably), so it is the
	   documented way to make all late drains land. */
	let settled = false;
	if (detached) {
		try {
			settled = await settleWriter(persistence, sessionId);
		} catch (error) {
			ctx.logger.warn(`session-eraser: could not settle the writer for "${sessionId}": ${String(error)}`);
		}
		if (!settled && typeof persistence.flush === "function") {
			try {
				await persistence.flush();
				settled = true;
			} catch (error) {
				ctx.logger.warn(`session-eraser: persistence flush after detaching "${sessionId}" failed: ${String(error)}`);
			}
		}
	}
	if (typeof root !== "string" || root === "") {
		/* A stored session whose artifact cannot be addressed cannot be deleted
		   or verified. Refuse rather than report a deletion that never happened. */
		if (stored !== void 0) {
			return { status: "unremovable", reason: "the session-persistence root is unavailable" };
		}
		return { status: "deleted", live: live !== void 0, detached, removed: 0 };
	}
	const artifacts = await locateArtifacts(root, sessionId);
	/* Remove, then re-check until the paths stay gone. When the writer close was
	   successfully awaited one pass is enough; when it was not (`settled` is
	   false) a late drain may still land, so keep re-removing across a bounded
	   window. The result then does not depend on the persistence internals
	   keeping the shape this plugin reads today. */
	const removed = [];
	let survivors = [];
	/* One pass when the close was awaited; otherwise hold the paths gone across
	   the whole settle window, so a late drain cannot outlive it. */
	const attempts = settled ? 1 : SETTLE_ATTEMPTS;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (attempt > 0) await delay(SETTLE_DELAY_MS);
		for (const artifact of artifacts) {
			try {
				if (existsSync(artifact)) {
					await rm(artifact, { recursive: true, force: true });
					if (!removed.includes(artifact)) removed.push(artifact);
				}
			} catch (error) {
				ctx.logger.warn(`session-eraser: could not remove "${artifact}": ${String(error)}`);
			}
		}
		survivors = artifacts.filter((artifact) => existsSync(artifact));
	}
	/* `rm` fails for real reasons on Windows — a locked or deny-ACL'd file
	   throws EPERM/EBUSY — so a swallowed failure would leave the log on disk
	   while the caller was told the deletion succeeded, and the session would
	   reappear on the next list. Report that honestly and leave the workspace
	   accounting untouched, so the sidebar keeps showing the session that in
	   fact still exists. */
	if (survivors.length > 0) {
		ctx.logger.warn(`session-eraser: "${sessionId}" survived deletion: ${survivors.join(", ")}`);
		return { status: "unremovable", reason: "the stored session could not be removed from disk" };
	}

	if (workspaces !== void 0) {
		try {
			const headers = (await persistence.list()).map((snapshot) => snapshot.header);
			await workspaces.replaceHeaderIndex(headers);
			await workspaces.indexLiveSessions();
		} catch (error) {
			ctx.logger.warn(`session-eraser: workspace re-index failed: ${String(error)}`);
		}
		/* Drop the registry-global bookkeeping that names this session. A
		   deleted session left in the archive or pin set is a dangling id the
		   UI can never clear: the row it belongs to is gone, so nothing offers
		   to unarchive or unpin it. Both removals skip the session-existence
		   check by design — "an entry whose session is gone still resolves" —
		   which is exactly this case. */
		for (const [label, drop] of [
			["archive", () => workspaces.unarchiveSession?.(sessionId)],
			["pin", () => workspaces.unpinSession?.(sessionId)]
		]) {
			try {
				await drop();
			} catch (error) {
				ctx.logger.warn(`session-eraser: could not clear the ${label} entry for "${sessionId}": ${String(error)}`);
			}
		}
		for (const entity of owners) {
			try {
				await entity.detachSession(sessionId);
			} catch (error) {
				ctx.logger.warn(`session-eraser: could not detach "${sessionId}" from workspace "${entity.id}": ${String(error)}`);
			}
		}
	}

	/* Cold sessions never emit `session/disposed`, so announce the removal here
	   too; the browser treats it as an idempotent optimistic remove. */
	try {
		ctx.emit("api-session/removed", sessionId);
	} catch (error) {
		ctx.logger.warn(`session-eraser: api-session/removed emission failed: ${String(error)}`);
	}

	return {
		status: "deleted",
		live: live !== void 0,
		detached,
		removed: removed.length
	};
}

/**
 * Answer one `POST /api/session.delete` request.
 * @param ctx - Host context.
 * @param request - the Fetch request carrying `{ sessionId }`.
 * @returns the JSON response.
 */
async function sessionDeleteResponse(ctx, request) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return Response.json({ error: "invalid JSON request body" }, { status: 400 });
	}
	const raw = payload?.sessionId;
	const sessionId = typeof raw === "string" ? raw.trim() : "";
	if (sessionId === "") return Response.json({ error: "missing or invalid sessionId" }, { status: 400 });
	try {
		const result = await deleteSession(ctx, sessionId);
		if (result.status === "not-found") return Response.json({ error: "session not found" }, { status: 404 });
		if (result.status === "unremovable") {
			return Response.json({ error: `session could not be deleted: ${result.reason}` }, { status: 500 });
		}
		return Response.json({ ok: true, ...result });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.logger.warn(`session-eraser: deleting "${sessionId}" failed: ${message}`);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * Register the authenticated session-deletion route.
 * @param ctx - Host context carrying the Connection service.
 */
function apply(ctx) {
	connectionOf(ctx).fetch.register({
		path: SESSION_DELETE_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: (request) => sessionDeleteResponse(ctx, request)
	});
}

export { SESSION_DELETE_PATH, apply, inject, name };