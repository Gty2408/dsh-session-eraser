window.__ModuleLoader__.load({
	id: "dsh-session-eraser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let client_store = require("@deepseek-ai/dsh-client-store");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { jsx, jsxs } = react_jsx_runtime;

		/** Document-relative route the browser addresses (app-route convention). */
		const SESSION_DELETE_ROUTE = "/api/session.delete".slice(1);
		/** Locale namespace owned by this plugin. */
		const NS = "session-eraser";
		/** Simplified-Chinese copy. */
		const zh = {
			"menu.deleteSession": "删除会话",
			"row.deleteSession": "删除会话：{name}",
			"dialog.title": "删除会话",
			"dialog.desc": "确定要永久删除“{title}”吗？此操作无法撤销。",
			"dialog.warning": "该会话的日志、消息与附件引用将从本机永久移除。",
			"dialog.action": "永久删除",
			"cancel": "取消",
			"close": "关闭",
			"guard.menu": "删除会话（当前已打开）",
			"guard.row": "该会话已在主面板中打开，无法删除。请先切换到其他会话。"
		};
		/** English copy. */
		const en = {
			"menu.deleteSession": "Delete session",
			"row.deleteSession": "Delete session: {name}",
			"dialog.title": "Delete session",
			"dialog.desc": "Permanently delete “{title}”? This cannot be undone.",
			"dialog.warning": "This session's log, messages, and attachment references are removed from this machine.",
			"dialog.action": "Delete permanently",
			"cancel": "Cancel",
			"close": "Close",
			"guard.menu": "Delete session (currently open)",
			"guard.row": "This session is open in the main panel and cannot be deleted. Switch to another session first."
		};

		/** The one pending confirmation, or `null`. */
		const deleteRequest = client_store.createSnapshotStore(null);

		/**
		 * Open the confirmation for one session.
		 * @param sessionId - the session to delete.
		 * @param displayTitle - the title to show in the dialog.
		 */
		function requestDelete(sessionId, displayTitle) {
			deleteRequest.set({
				sessionId: String(sessionId),
				displayTitle: typeof displayTitle === "string" && displayTitle !== "" ? displayTitle : String(sessionId)
			});
		}
		/** Dismiss the pending confirmation. */
		function settleDelete() {
			deleteRequest.set(null);
		}
		/**
		 * Run the Host deletion and surface its failure text.
		 * @param sessionId - the session to delete.
		 * @returns the Host response payload.
		 */
		async function confirmDelete(sessionId) {
			const response = await fetch(SESSION_DELETE_ROUTE, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				payload = null;
			}
			if (!response.ok) throw new Error(payload?.error ?? `Delete failed: HTTP ${response.status}`);
			return payload;
		}

		/**
		 * Whether one session is the Session currently open in the main panel.
		 *
		 * The open Session is the one retained by the `mainView` source. It must not
		 * be deleted: the Workspace UI reconciles an *archived* current selection
		 * (`clearArchivedCurrent`) but has no path that reacts to the current
		 * Session being *removed*, so deleting it would leave the main panel
		 * pointing at a Session that no longer exists. Deleting is therefore
		 * refused until the user navigates elsewhere.
		 *
		 * @param useSessionRetainInfo - the standard keyed hook for one Session.
		 * @param sessionId - the Session the row shows.
		 * @returns true when this Session is the open one.
		 */
		function useIsOpenSession(useSessionRetainInfo, sessionId) {
			if (typeof useSessionRetainInfo !== "function") return false;
			return useSessionRetainInfo(sessionId, (info) => (info?.retainedBy?.mainView ?? 0) > 0) === true;
		}

		/** One session-row menu entry; opens the confirmation and closes the menu. */
		function DeleteSessionMenuItem(props) {
			const { sessionId, displayTitle, useMenuOpenState, useSessionRetainInfo, requestDelete: request, t } = props;
			const [, setMenuOpen] = useMenuOpenState();
			const isOpen = useIsOpenSession(useSessionRetainInfo, sessionId);
			return jsx(primitives.MenuItemButton, {
				icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				danger: true,
				separatorBefore: true,
				disabled: isOpen,
				onSelect: () => {
					setMenuOpen(false);
					request(sessionId, displayTitle);
				},
				children: t(isOpen ? "guard.menu" : "menu.deleteSession")
			});
		}

		/**
		 * One hover-revealed session-row icon button; the menu entry's shortcut.
		 *
		 * Renders nothing for the open Session rather than a disabled button: the
		 * slot's catalog prescribes rendering nothing when an action does not apply,
		 * and a natively disabled button fires no pointer events, so its Tooltip
		 * could never explain the refusal.
		 */
		function DeleteSessionRowButton(props) {
			const { sessionId, displayTitle, useSessionRetainInfo, requestDelete: request, t } = props;
			const isOpen = useIsOpenSession(useSessionRetainInfo, sessionId);
			if (isOpen) return null;
			const label = t("row.deleteSession", { name: displayTitle });
			return jsx(primitives.Tooltip, {
				label,
				side: "bottom",
				align: "end",
				delayMs: 500,
				children: jsx(primitives.Button, {
					size: "sm",
					variant: "ghost",
					icon: jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
					className: "dsh-session-eraser-row-button",
					style: { width: 28, padding: 0 },
					"aria-label": label,
					onClick: (event) => {
						event.stopPropagation();
						request(sessionId, displayTitle);
					}
				})
			});
		}

		/** Frame-wide confirmation host; renders nothing while no request is pending. */
		function DeleteSessionConfirmDialog(props) {
			const { useDeleteRequest } = props;
			const request = useDeleteRequest((value) => value);
			if (request === null || request === void 0) return null;
			return jsx(DeleteSessionConfirmForm, {
				...props,
				request,
				key: request.sessionId
			});
		}

		/** The confirmation form itself: local busy/error state, irreversible wording. */
		function DeleteSessionConfirmForm(props) {
			const { request, settleDelete, confirmDelete: confirm, useSessionRetainInfo, t } = props;
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			/* Re-checked here, not only at the row: the dialog is a separate render
			   pass, so the user can open it and then navigate to that very session
			   before confirming. */
			const isOpen = useIsOpenSession(useSessionRetainInfo, request.sessionId);
			const close = () => {
				if (!busy) settleDelete();
			};
			const run = async () => {
				if (isOpen) return;
				setBusy(true);
				setError(null);
				try {
					await confirm(request.sessionId);
					settleDelete();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
					setBusy(false);
				}
			};
			return jsxs(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("close"),
				title: t("dialog.title"),
				description: t("dialog.desc", { title: request.displayTitle }),
				footer: jsxs(react.Fragment, { children: [
					jsx(primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: close,
						children: t("cancel")
					}),
					jsx(primitives.Button, {
						variant: "outline",
						disabled: busy || isOpen,
						style: isOpen ? void 0 : { color: "var(--dsw-alias-state-error-primary)" },
						onClick: run,
						children: t("dialog.action")
					})
				] }),
				children: [
					isOpen
						? jsx("div", { role: "alert", children: t("guard.row") })
						: jsx("div", { role: "status", children: t("dialog.warning") }),
					error === null ? null : jsx("div", { role: "alert", children: error })
				]
			});
		}

		/** Browser plugin owning the delete entry points and their confirmation. */
		const inject = ["slots", "locale"];

		/**
		 * Register the dictionaries, the two row entry points, and the confirmation host.
		 * @param ctx - browser context carrying slots and locale services.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-eraser: dictionaries");
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "session-eraser",
				order: 500,
				locale: NS,
				inject: () => ({ requestDelete })
			}, DeleteSessionMenuItem));
			ctx.slots.inject("sidebar.workspaces.session.row.action", () => ctx.slots.register({
				name: "sidebar.workspaces.session.row.action",
				id: "session-eraser",
				order: 300,
				locale: NS,
				inject: () => ({ requestDelete })
			}, DeleteSessionRowButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "session-eraser-confirm",
				locale: NS,
				inject: () => ({
					hooks: { deleteRequest },
					settleDelete,
					confirmDelete
				})
			}, DeleteSessionConfirmDialog));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "session-eraser";
		return module.exports;
	}
});