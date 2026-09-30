/**
 * Exercise the client half's open-session guard by loading the real bundle with
 * stubbed module-table words, then rendering both entry points.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const BUNDLE = new URL("../lib/client.js", import.meta.url);
const source = readFileSync(BUNDLE, "utf8");

const failures = [];
const check = (label, condition, detail = "") => {
	if (condition) console.log(`PASS ${label}`);
	else { failures.push(label); console.log(`FAIL ${label} ${detail}`); }
};

// Minimal element shim: enough to inspect the tree these components build.
const elements = [];
const jsx = (type, props, key) => {
	const el = { type, props: props ?? {}, key };
	elements.push(el);
	return el;
};
const jsxs = jsx;

const rendered = [];
const primitives = {
	MenuItemButton: "MenuItemButton",
	Button: "Button",
	Tooltip: "Tooltip",
	IconTrashOutlineRegular: "IconTrash",
	Modal: "Modal"
};

const store = {
	createSnapshotStore: (init) => {
		let value = init;
		const listeners = new Set();
		return {
			getSnapshot: () => value,
			subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
			set: (next) => { value = next; for (const fn of listeners) fn(); },
			update: (fn) => { value = fn(value); for (const fn of listeners) fn(); }
		};
	}
};

// React shim: hooks are called in order during a single render pass.
let hookIndex = 0;
let hookState = [];
const react = {
	useState: (init) => {
		const i = hookIndex++;
		if (hookState[i] === void 0) hookState[i] = init;
		return [hookState[i], (next) => { hookState[i] = next; }];
	},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn,
	useEffect: () => {},
	useRef: () => ({ current: null }),
	Fragment: "Fragment",
	createElement: jsx
};

const requireShim = (spec) => {
	if (spec === "react") return react;
	if (spec === "react/jsx-runtime") return { jsx, jsxs };
	if (spec === "@deepseek-ai/dsh-client-store") return store;
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${spec}`);
};

// Load the bundle exactly as the module table would.
let registration;
globalThis.window = {
	__ModuleLoader__: { load: (entry) => { registration = entry; } }
};
const module = { exports: {} };
// eslint-disable-next-line no-new-func
new Function("require", "module", "exports", source)(requireShim, module, module.exports);
check("bundle registered under its package name", registration.id === "dsh-session-eraser", registration.id);

const plugin = registration.factory(requireShim);
check("plugin exports apply", typeof plugin.apply === "function");
check("plugin exports inject", Array.isArray(plugin.inject), JSON.stringify(plugin.inject));

// Capture registrations and the injected faces.
const registrations = [];
const effects = [];
const ctx = {
	effect: (fn) => { effects.push(fn()); },
	locale: { register: () => () => {} },
	slots: {
		inject: (name, cb) => { cb(); },
		register: (options, component) => { registrations.push({ options, component }); return () => {}; }
	}
};
plugin.apply(ctx);
check("registered three entries", registrations.length === 3, String(registrations.length));

const find = (name, id) => registrations.find((r) => r.options.name === name && r.options.id === id);
const menuReg = find("sidebar.workspaces.session.menu.item", "session-eraser");
const rowReg = find("sidebar.workspaces.session.row.action", "session-eraser");
const dialogReg = find("shell.overlay", "session-eraser-confirm");
check("menu entry registered", menuReg !== void 0);
check("row entry registered", rowReg !== void 0);
check("dialog registered", dialogReg !== void 0);
check("menu order 500", menuReg.options.order === 500);
check("row order 300", rowReg.options.order === 300);

const t = (key, params) => (params?.name !== void 0 ? `${key}:${params.name}` : key);

/** Render one component with a given retain-info snapshot. */
function render(component, { sessionId, retainedBy, extra = {} }) {
	hookIndex = 0;
	hookState = [];
	rendered.length = 0;
	const useSessionRetainInfo = (key, selector) => selector({ referenceCount: 1, retainedBy });
	const useMenuOpenState = () => [false, () => {}];
	const props = {
		sessionId,
		displayTitle: "My session",
		useSessionRetainInfo,
		useMenuOpenState,
		t,
		requestDelete: () => { props.requested = true; },
		...extra
	};
	const out = component(props);
	return { out, props };
}

// 1. A session NOT open in the main view: both entry points are offered.
const closedInfo = { retainedBy: { mainView: 0 } };
const menuClosed = render(menuReg.component, { sessionId: "s-closed", retainedBy: closedInfo.retainedBy });
check("menu offers delete for a closed session", menuClosed.out.props.disabled === false || menuClosed.out.props.disabled === void 0, String(menuClosed.out.props.disabled));
check("menu uses the normal label", menuClosed.out.props.children === "menu.deleteSession", menuClosed.out.props.children);

const rowClosed = render(rowReg.component, { sessionId: "s-closed", retainedBy: closedInfo.retainedBy });
check("row button renders for a closed session", rowClosed.out !== null && rowClosed.out !== void 0);

// 2. The session open in the main view: the guard refuses.
const openInfo = { retainedBy: { mainView: 1 } };
const menuOpen = render(menuReg.component, { sessionId: "s-open", retainedBy: openInfo.retainedBy });
check("menu disables delete for the open session", menuOpen.out.props.disabled === true, String(menuOpen.out.props.disabled));
check("menu explains the refusal", menuOpen.out.props.children === "guard.menu", menuOpen.out.props.children);

const rowOpen = render(rowReg.component, { sessionId: "s-open", retainedBy: openInfo.retainedBy });
check("row button renders nothing for the open session", rowOpen.out === null, JSON.stringify(rowOpen.out));

// 3. Missing retain info must not hide the action (fail open, not closed).
const rowUnknown = render(rowReg.component, { sessionId: "s-unknown", retainedBy: void 0 });
check("row button still renders without retain info", rowUnknown.out !== null && rowUnknown.out !== void 0);

// 4. The hook may be absent entirely (older host): must not crash.
const rowNoHook = render(rowReg.component, { sessionId: "s-nohook", retainedBy: void 0, extra: { useSessionRetainInfo: void 0 } });
check("row button survives a missing standard hook", rowNoHook.out !== null && rowNoHook.out !== void 0);

// 5. The confirmation dialog re-checks at confirm time, because it is a separate
//    render pass: the user can open it and then navigate to that session.
function renderDialog({ retainedBy }) {
	const useDeleteRequest = (selector) => selector({ sessionId: "s-open", displayTitle: "My session" });
	const settled = [];
	let confirmed = 0;
	const useSessionRetainInfo = (key, selector) => selector({ referenceCount: 1, retainedBy });
	hookIndex = 0;
	hookState = [];
	rendered.length = 0;
	const props = {
		useDeleteRequest,
		useSessionRetainInfo,
		settleDelete: () => settled.push(true),
		confirmDelete: async () => { confirmed += 1; },
		t
	};
	const out = dialogReg.component(props);
	// The dialog renders the form; render that form too.
	const form = out;
	const formProps = {
		request: { sessionId: "s-open", displayTitle: "My session" },
		settleDelete: props.settleDelete,
		confirmDelete: props.confirmDelete,
		useSessionRetainInfo,
		t
	};
	hookIndex = 0;
	hookState = [];
	const formOut = form.type(formProps);
	return { formOut, settled, get confirmed() { return confirmed; } };
}

const openDialog = renderDialog({ retainedBy: { mainView: 1 } });
const confirmButton = openDialog.formOut.props.footer.props.children[1];
check("dialog confirm is disabled while the session is open", confirmButton.props.disabled === true, String(confirmButton.props.disabled));
const bodyWhenOpen = openDialog.formOut.props.children[0];
check("dialog explains why it is blocked", bodyWhenOpen.props.children === "guard.row", String(bodyWhenOpen.props.children));

const closedDialog = renderDialog({ retainedBy: { mainView: 0 } });
const confirmClosed = closedDialog.formOut.props.footer.props.children[1];
check("dialog confirm is enabled once the session is closed", confirmClosed.props.disabled === false, String(confirmClosed.props.disabled));
check("dialog shows the irreversible warning normally", closedDialog.formOut.props.children[0].props.children === "dialog.warning");

console.log(failures.length === 0 ? "\nALL PASS" : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);