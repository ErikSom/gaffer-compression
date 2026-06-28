import { NetClient } from "./netClient.js";
import { Renderer } from "./renderer.js";
import { DebugPanel } from "./debugPanel.js";
import { TouchControls } from "./touchControls.js";
import { LoadingOverlay } from "./loadingOverlay.js";
import { DYNAMIC_COUNT, PLAYER_BASE_INDEX, MAX_PLAYERS } from "../shared/sceneConfig.js";

const hud = document.getElementById("hud")!;
const renderer = new Renderer(document.body);
const net = new NetClient();
const debug = new DebugPanel();

debug.onChange = (p) => {
	net.setUpSimParams(p);
	net.setDownSimParams(p);
};

// Live physics-rate A/B (F1 panel). The button requests a rate; the server
// applies it and echoes the active rate back via Config, which highlights it.
debug.onSetHz = (hz) => net.setPhysicsHz(hz);
net.onConfig = (hz) => debug.setActiveHz(hz);
debug.onReset = () => net.resetBoxes();

// Debug: draw the authoritative "ghost" of your ball so you can see prediction
// lead and reconciliation against the server truth.
let ghostVisible = false;
debug.onGhostToggle = (v) => { ghostVisible = v; };

const touch = new TouchControls();

const keys = new Set<string>();
window.addEventListener("keydown", (e) => {
	keys.add(e.code);
	if (e.code.startsWith("Arrow")) e.preventDefault();
	if (e.code === "KeyC") renderer.toggleMode();
});
window.addEventListener("keyup", (e) => { keys.delete(e.code); });

// WS endpoint resolution:
//  - VITE_WS_URL (baked in at build time) points the static client at a remote
//    game server — e.g. wss://gaffer-server.onrender.com — when the page and the
//    server are hosted separately (Cloudflare Pages + Render).
//  - Otherwise fall back to the same origin's /ws, which Vite proxies to
//    ws://localhost:8787 in dev (and rides a single ngrok tunnel over HTTPS).
const wsUrl = resolveWsUrl();

const loading = new LoadingOverlay();
loading.show();
let everConnected = false;

net.onWelcome = () => {
	renderer.setOwnedPlayerIndex(net.playerBaseIndex);
};
net.onConnected = () => { everConnected = true; loading.hide(); };
net.onDisconnected = () => { if (everConnected) loading.reconnecting(); };
net.connect(wsUrl);

// A slept free-tier dyno wakes on any inbound request. The WS reconnect loop
// would wake it eventually, but a plain fetch kicks the boot in parallel without
// the per-attempt WS console noise.
warmServer(wsUrl);

function resolveWsUrl(): string {
	const configured = (import.meta as any).env?.VITE_WS_URL as string | undefined;
	if (configured) return configured;
	const wsProto = location.protocol === "https:" ? "wss" : "ws";
	return `${wsProto}://${location.host}/ws`;
}

function warmServer(url: string) {
	// Only a cross-origin remote server can be asleep; the dev proxy has nothing
	// to wake, so skip warming unless VITE_WS_URL was set.
	if (!(import.meta as any).env?.VITE_WS_URL) return;
	try {
		const httpUrl = url.replace(/^ws/, "http").replace(/\/ws$/, "/");
		void fetch(httpUrl, { mode: "no-cors", cache: "no-store" }).catch(() => {});
	} catch { /* ignore */ }
}

const inputTickMs = 1000 / 30;
let lastInputAt = 0;

function computeMove(): { x: number; y: number; z: number } {
	// Touch joystick takes over when a finger is down; otherwise keyboard.
	if (touch.active) {
		const m = touch.getMove();
		return { x: m.x, y: 0, z: m.z };
	}
	let mx = 0, mz = 0;
	if (keys.has("ArrowUp") || keys.has("KeyW")) mz -= 1;
	if (keys.has("ArrowDown") || keys.has("KeyS")) mz += 1;
	if (keys.has("ArrowLeft") || keys.has("KeyA")) mx -= 1;
	if (keys.has("ArrowRight") || keys.has("KeyD")) mx += 1;
	const len = Math.hypot(mx, mz);
	if (len > 1) { mx /= len; mz /= len; }
	return { x: mx, y: 0, z: mz };
}


let lastFpsAt = performance.now();
let frames = 0;
let fps = 0;

// Cap rendering to ~60fps. At 120fps the browser (4096 instanced boxes + a
// 256KB/frame matrix upload) starves the Node physics server of CPU on the same
// machine, dropping it below 20Hz snapshots. 60fps is plenty smooth and leaves
// the server its headroom. Input is still sampled every animation frame.
const renderIntervalMs = 1000 / 60;
let lastRenderAt = 0;

function frame(now: number) {
	requestAnimationFrame(frame);

	// Sample input every animation frame: it feeds client prediction continuously,
	// and is sent upstream at the throttled tick rate.
	const move = computeMove();
	net.setLocalInput(move.x, move.z);
	if (net.connected && now - lastInputAt >= inputTickMs) {
		lastInputAt = now;
		net.sendInput(move);
	}

	if (now - lastRenderAt < renderIntervalMs - 1) return;
	lastRenderAt = now;

	const state = net.getInterpolatedState();
	renderer.applyState(state);
	renderer.updateGhost(ghostVisible && net.ghostActive, net.ghostPosition, net.ghostRotation);
	renderer.render();

	net.updateStats();
	frames++;
	if (now - lastFpsAt > 500) {
		fps = (frames * 1000) / (now - lastFpsAt);
		frames = 0;
		lastFpsAt = now;
		updateHud();
	}
}

function updateHud() {
	const s = net.getStats();
	const kbps = (s.bytesPerSecDown * 8) / 1024;
	const connStr = net.connected ? "connected" : "connecting…";
	const st = net.getInterpolatedState();
	let players = 0;
	for (let i = 0; i < MAX_PLAYERS; i++) if (st[PLAYER_BASE_INDEX + i].position.y > -500) players++;
	hud.textContent =
		`${connStr}\n` +
		`players    ${players}\n` +
		`boxes      ${DYNAMIC_COUNT}\n` +
		`↓ traffic  ${kbps.toFixed(1)} kbps · ${s.packetsPerSecDown.toFixed(0)} pkt/s\n` +
		`last pkt   ${s.lastPacketBytes} B\n` +
		`loss       ${s.packetLossPct.toFixed(1)}%\n` +
		`fps        ${fps.toFixed(0)}`;

	debug.updateStats([
		`down:  <b>${kbps.toFixed(1)} kbps</b> · ${s.packetsPerSecDown.toFixed(0)} pkt/s`,
		`last packet: ${s.lastPacketBytes} B`,
		`loss: ${s.packetLossPct.toFixed(1)}%`,
		`snapshots buffered: ${s.bufferedSnapshots}`,
		`fps: ${fps.toFixed(0)}`,
	]);
}

requestAnimationFrame(frame);
