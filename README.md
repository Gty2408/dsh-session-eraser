# dsh-session-eraser

Delete a session from the DSH sidebar, permanently removing its stored log and
its workspace accounting.

## Install

```sh
dsh plugin --profile desktop add dsh-session-eraser
```

Then **restart DSH**. The command installs the package, applies this package's
`cordis.patch.yml` through the `dsh.bundle.patch` mechanism, and adds the package
to the profile's bundle list — no manual configuration editing.

Without the `dsh` CLI, add the package to the profile's `node_modules` and put
this in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-session-eraser
      name: dsh-session-eraser
```

## What it does

Adds a **Delete session** entry to each session row in the sidebar, in two
places:

- the row's `...` menu, below the shipped **Archive** row;
- a hover-revealed trash button beside the row's other actions.

Either entry opens a confirmation dialog. Confirming removes the session's
stored artifact from disk, detaches it from the Workspace, and tells every
connected client that the session is gone, so the row disappears immediately.

## The open-session guard

Deleting the session that is **currently open in the main panel is refused.**

This is deliberate. The Workspace UI reconciles an *archived* current selection
but has no path that reacts to the current session being *removed*: it exposes no
public close/leave API, and `openSession` can only replace. Deleting the open
session would therefore leave the main panel pointing at a session that no longer
exists, with the composer silently disabled and no way back.

So the guard refuses in four places:

| Entry point | Behaviour when the session is open |
| --- | --- |
| `...` menu row | Rendered disabled, labelled *Delete session (currently open)* |
| Hover trash button | Not rendered at all |
| Dialog confirm button | Disabled, with an inline explanation |
| Dialog confirm action | Re-checks retention and refuses |

The hover button is omitted rather than disabled because a natively disabled
button fires no pointer events, so its tooltip could never explain the refusal —
and the row-action slot's own catalog prescribes rendering nothing when an action
does not apply to the row.

## Host route

`POST /api/session.delete`

```jsonc
// request
{ "sessionId": "session-04e8f277-…" }

// 200
{ "ok": true, "status": "deleted", "live": true, "detached": true, "removed": 1 }
```

| Status | Body | Meaning |
| --- | --- | --- |
| 200 | `{ ok: true, … }` | Deleted, and verified gone from disk |
| 400 | `{ error: "…" }` | Malformed body, or missing/invalid `sessionId` |
| 404 | `{ error: "session not found" }` | No stored artifact and no live session |
| 500 | `{ error: "…" }` | Unexpected failure, **or the artifact survived removal** |

The route never reports success it cannot verify. `rm` fails for real reasons on
Windows — a locked or deny-ACL'd file throws `EPERM`/`EBUSY` — so after removing
the artifact the plugin re-checks the path and answers **500** if anything
survived, leaving the workspace accounting untouched so the sidebar keeps showing
the session that in fact still exists.

The route is served through the connection's Fetch handler, so it sits behind the
same authentication gate as the rest of `/api` and is reachable only from a
trusted origin.

## Deletion sequence

The Host has no session-eraser API, so deletion is composed from public pieces in
a specific order:

1. `workspaces.stopSessionActivity(sessionId)` — request a stop for the session.
2. `sessions.liveEntryFor(live)` + `sessions.detachEntered(entry)` — detach the
   live session, which also dispatches `session/disposed`.
3. Settle the writer. Persistence teardown's `writer.close()` is **not awaited**,
   and `appendLines` opens the log with `open(path, "a")` per batch — which
   **recreates a deleted directory** — so a drain that loses the race would
   resurrect the log. Two mechanisms cover this:
   - `settleWriter(...)` joins the in-flight close directly. It reads an
     undocumented internal (`persistence.tracker.openHandles`) and **fails open**
     if that is ever renamed, so it is an optimization, not the guarantee.
   - `persistence.flush()` — the **public** durability barrier — drains every
     active write handle, and a concurrently-closing handle counts as flushed.
   - When neither could be awaited, the removal is held for a bounded settle
     window, re-removing anything a late drain restores.
4. Remove each located artifact, then **verify** it is gone. Anything that
   survived is reported as a failure rather than a success.
5. Re-index the workspace, **clear the session's archive and pin entries**, and
   detach it from its owning entities.
6. `ctx.emit("api-session/removed", sessionId)` — so cold sessions vanish from
   other clients immediately, not just on the next list refresh.

Step 5's archive/pin cleanup matters because those are registry-global id lists:
deleting the session removes the row they refer to, so nothing in the UI can ever
offer to unarchive or unpin it — the id would dangle permanently. Both removal
APIs skip the session-existence check by design ("an entry whose session is gone
still resolves"), which is exactly this case.

Owners are captured *before* re-indexing, because `entity.sessionIds` is filtered
live by the canonical-cwd header index and re-indexing prunes the id.

## Storage layout

Artifacts live under `~/.dsh/sessions/<encoded-project-dir>/<encoded-id>/`, with
the log at `session.v4.jsonl.zstd`. The plugin mirrors the backend's
`encodeSegment` exactly, so a hostile `sessionId` (traversal sequences, absolute
paths, separators) can only ever resolve to its own escaped directory inside the
root. `test/host-traversal.test.mjs` plants canaries and proves this.

## Tests

```sh
node test/run.mjs
```

The `host-*` suites are hermetic — they use throwaway persistence roots and stub
the services the route touches. The `live-*` suites talk to a running app
(`DSH_TEST_ORIGIN`, default `http://127.0.0.1:19387`) and self-skip when it is
unreachable.

| Suite | Covers |
| --- | --- |
| `host-route.test.mjs` | Cold-session deletion, status codes, artifact removal |
| `host-live.test.mjs` | Live-session branch: stop, detach, settle, owner detach |
| `host-writer-race.test.mjs` | A late writer drain must not resurrect the log |
| `host-race-control.test.mjs` | The same race *without* the fix must fail — proves the fix is load-bearing |
| `host-internals-change.test.mjs` | Deletion stays correct when `tracker.openHandles` is absent |
| `host-bookkeeping.test.mjs` | A deleted session leaves no dangling archive/pin entry |
| `host-partial-failure.test.mjs` | A real `EPERM` from a deny-ACL is reported, not swallowed |
| `host-traversal.test.mjs` | Hostile ids resolve only to escaped in-root directories |
| `client-guard.test.mjs` | Both entry points and the dialog, including the open-session guard |
| `live-end-to-end.test.mjs` | Authenticated HTTP against the running app, including a real deletion |
| `live-bundle.test.mjs` | The running app serves the guarded client bundle at the advertised revision |

`live-*` mints its own auth cookie from the browser-session signing secret in
`~/.dsh/.credentials.yaml`; no browser or cookie jar is involved.

## Known limitations

- **Attachments are not removed.** Deletion removes the session log and its
  workspace accounting; files the session referenced on disk are left in place
  (their references go away with the log). Removing them would require knowing
  which files the session actually created rather than merely read.
- **The open-session guard is client-side only.** The Host has no view-state
  concept — `mainView` retention lives in the browser — so a hand-crafted
  `POST /api/session.delete` for the currently-open session is not refused. The
  route is behind the normal auth gate, so this is reachable only by the user's
  own authenticated client, and the shipped UI never sends it.
- **`settleWriter` reads an internal.** `persistence.tracker.openHandles` is not
  part of the documented seam. The plugin treats it as an optimization: if it
  disappears, the public `flush()` barrier and the bounded settle window still
  produce a correct deletion, and `host-internals-change.test.mjs` pins that.
- **Deletion is not transactional.** If the process dies between removal and
  re-indexing, the artifact is gone but the workspace accounting may still list
  the session until the next index rebuild, which reconciles it.

## Layout

```
lib/index.js    Host half: the delete route and the deletion sequence
lib/client.js   Browser half: menu row, hover button, confirmation dialog
cordis.patch.yml  Registers the bundle
test/           Test suite (see above)
```