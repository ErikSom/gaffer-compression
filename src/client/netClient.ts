import { Quaternion, Vector3 } from "three";
import {
	MsgType,
	decodePacket,
	decodeWelcome,
	decodeConfig,
	encodeAck,
	encodeInput,
	encodeSetHz,
	encodeResetBoxes,
	peekType,
} from "../shared/protocol.js";
import { DirectionalNetSim } from "./netSimulator.js";
import { networkCache } from "../network/networkState.js";
import type { NetworkBodyState } from "../network/networkInterfaces.js";
import { TOTAL_OBJECTS } from "../shared/sceneConfig.js";
import settings from "../settings.js";

interface BufferedSnapshot {
	frame: number;
	state: NetworkBodyState[];
}

export interface NetStats {
	bytesPerSecDown: number;
	packetsPerSecDown: number;
	packetLossPct: number;
	bufferedSnapshots: number;
	lastPacketBytes: number;
	serverFrame: number;
	renderFrame: number;
}

export class NetClient {
	private ws: WebSocket | null = null;
	private url = "";
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	private upSim: DirectionalNetSim;
	private downSim: DirectionalNetSim;

	public playerId = 0;
	public playerBaseIndex = 0;
	public objectCount = 0;
	public connected = false;
	public onWelcome: (() => void) | null = null;

	private snapshotBuffer: BufferedSnapshot[] = [];
	private lastSnapshotFrame = -1;
	private inputSeq = 0;

	// Frame-number render clock: advances at real time in server-frame units and
	// snaps back if it drifts (stall, big jitter, or a server restart). Playback
	// position is a pure function of frame ids, so arrival jitter never warps it.
	private renderFrame = -1;
	private lastClockAt = 0;
	// Driven by the server's Config message — the render clock must advance in the
	// server's actual physics-frame units, which change live when the rate does.
	private physicsHz = settings.physicsHz;
	private physicsDt = 1000 / settings.physicsHz;
	private delayFrames = settings.renderDelayMs / (1000 / settings.physicsHz);
	public onConfig: ((physicsHz: number) => void) | null = null;

	// stats
	private bytesWindow = 0;
	private packetsWindow = 0;
	private lastStatAt = performance.now();
	private bytesPerSec = 0;
	private packetsPerSec = 0;
	private lastPacketBytes = 0;
	private droppedDown = 0;
	private deliveredDown = 0;

	private interpOut: NetworkBodyState[];

	constructor() {
		this.upSim = new DirectionalNetSim((data) => this.rawSend(data));
		this.downSim = new DirectionalNetSim((data) => this.handlePacket(data));
		this.interpOut = this.makeEmptyState();
	}

	private makeEmptyState(): NetworkBodyState[] {
		const arr: NetworkBodyState[] = new Array(TOTAL_OBJECTS);
		for (let i = 0; i < TOTAL_OBJECTS; i++) {
			arr[i] = { position: new Vector3(0, -1000, 0), rotation: new Quaternion(0, 0, 0, 1) };
		}
		return arr;
	}

	connect(url: string) {
		this.url = url;
		this.openSocket();
	}

	private openSocket() {
		const ws = new WebSocket(this.url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			this.connected = true;
			this.resetSyncState();
		};
		ws.onclose = (ev) => {
			this.connected = false;
			// 1013 = "server full"; back off longer so we don't hammer it.
			this.scheduleReconnect(ev && ev.code === 1013 ? 4000 : 500);
		};
		ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
		ws.onmessage = (ev) => {
			if (ev.data instanceof ArrayBuffer) this.downSim.enqueue(ev.data);
		};
	}

	private scheduleReconnect(delayMs = 500) {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.openSocket();
		}, delayMs);
	}

	// Server frames reset to 0 on restart, so a reconnect must discard the old
	// snapshot buffer, render clock, and the decode cache — otherwise stale high
	// frame numbers poison interpolation and delta-baselining.
	private resetSyncState() {
		this.snapshotBuffer = [];
		this.lastSnapshotFrame = -1;
		this.renderFrame = -1;
		this.lastClockAt = 0;
		networkCache.networkStates = [];
		networkCache.relativeNetworkSnapshots = [];
		networkCache.networkSnapshotFrame = null;
		networkCache.networkSnaphot = null;
	}

	setUpSimParams(p: Parameters<DirectionalNetSim["setParams"]>[0]) { this.upSim.setParams(p); }
	setDownSimParams(p: Parameters<DirectionalNetSim["setParams"]>[0]) { this.downSim.setParams(p); }

	private rawSend(data: ArrayBuffer) {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(data);
	}

	private send(data: ArrayBuffer) { this.upSim.enqueue(data); }

	private handlePacket(buffer: ArrayBuffer) {
		this.bytesWindow += buffer.byteLength;
		this.packetsWindow++;
		this.lastPacketBytes = buffer.byteLength;

		const type = peekType(buffer);
		if (type === MsgType.Welcome) {
			const w = decodeWelcome(buffer);
			if (w) {
				this.playerId = w.playerId;
				this.playerBaseIndex = w.playerBaseIndex;
				this.objectCount = w.objectCount;
				this.onWelcome?.();
			}
			return;
		}

		if (type === MsgType.Config) {
			const cfg = decodeConfig(buffer);
			if (cfg) {
				this.physicsHz = cfg.physicsHz;
				this.physicsDt = 1000 / cfg.physicsHz;
				this.delayFrames = settings.renderDelayMs / this.physicsDt;
				this.onConfig?.(cfg.physicsHz);
			}
			return;
		}

		const msg = decodePacket(buffer);
		if (!msg) return;

		if (msg.type === MsgType.FullSnapshot || msg.type === MsgType.DeltaSnapshot) {
			this.snapshotBuffer.push({ frame: msg.frame, state: cloneState(msg.state) });
			this.snapshotBuffer.sort((a, b) => a.frame - b.frame);
			while (this.snapshotBuffer.length > 12) this.snapshotBuffer.shift();
			this.lastSnapshotFrame = msg.frame;
			this.send(encodeAck(msg.frame));
		}
	}

	sendInput(move: { x: number; y: number; z: number }) {
		this.inputSeq = (this.inputSeq + 1) & 0xffff;
		this.send(encodeInput(this.inputSeq, move));
	}

	// Request a server physics rate. Sent raw (bypassing the net sim) so the
	// control responds even with simulated loss/latency cranked up.
	setPhysicsHz(hz: number) {
		this.rawSend(encodeSetHz(hz));
	}

	resetBoxes() {
		this.rawSend(encodeResetBoxes());
	}

	getInterpolatedState(): NetworkBodyState[] {
		const buf = this.snapshotBuffer;
		if (buf.length === 0) return this.interpOut;

		const now = performance.now();
		const newest = buf[buf.length - 1].frame;
		const oldest = buf[0].frame;
		const target = newest - this.delayFrames;

		if (this.renderFrame < 0) {
			this.renderFrame = target;
		} else {
			const dt = now - this.lastClockAt;
			this.renderFrame += dt / this.physicsDt;
			// Gently ease the clock's *rate* toward the target instead of hard-
			// snapping. A hard snap to target jumps backward by delayFrames whenever
			// the clock outruns the newest snapshot (e.g. the server briefly drops
			// below 20Hz), which is exactly the "stutter back and forth" rewind.
			// Easing tracks a slow server smoothly and never moves the clock
			// backward; only a large discontinuity (server restart) hard-resyncs.
			const drift = target - this.renderFrame;
			if (Math.abs(drift) > this.delayFrames * 4) {
				this.renderFrame = target;
			} else {
				this.renderFrame += drift * 0.05;
			}
		}
		this.lastClockAt = now;

		// Sampling clamp only — if starved we hold at the newest snapshot (a brief
		// pause), never rewind.
		const rf = this.renderFrame < oldest ? oldest : this.renderFrame > newest ? newest : this.renderFrame;

		if (buf.length === 1 || rf >= newest) {
			copyStateInto(buf[buf.length - 1].state, this.interpOut);
			return this.interpOut;
		}

		let older = buf[0];
		let newer = buf[buf.length - 1];
		for (let i = 0; i < buf.length - 1; i++) {
			if (buf[i].frame <= rf && buf[i + 1].frame >= rf) {
				older = buf[i];
				newer = buf[i + 1];
				break;
			}
		}
		const span = newer.frame - older.frame;
		const t = span <= 0 ? 1 : clamp01((rf - older.frame) / span);
		lerpStatesInto(older.state, newer.state, t, this.interpOut);
		return this.interpOut;
	}

	updateStats() {
		const now = performance.now();
		const dt = now - this.lastStatAt;
		if (dt >= 500) {
			this.bytesPerSec = (this.bytesWindow * 1000) / dt;
			this.packetsPerSec = (this.packetsWindow * 1000) / dt;
			this.bytesWindow = 0;
			this.packetsWindow = 0;
			this.lastStatAt = now;
			this.droppedDown = this.downSim.droppedPackets;
			this.deliveredDown = this.downSim.deliveredPackets;
		}
	}

	getStats(): NetStats {
		const total = this.droppedDown + this.deliveredDown;
		const loss = total > 0 ? (this.droppedDown / total) * 100 : 0;
		return {
			bytesPerSecDown: this.bytesPerSec,
			packetsPerSecDown: this.packetsPerSec,
			packetLossPct: loss,
			bufferedSnapshots: this.snapshotBuffer.length,
			lastPacketBytes: this.lastPacketBytes,
			serverFrame: this.lastSnapshotFrame,
			renderFrame: this.renderFrame >= 0 ? Math.round(this.renderFrame) : 0,
		};
	}
}

function cloneState(s: NetworkBodyState[]): NetworkBodyState[] {
	const out = new Array(s.length);
	for (let i = 0; i < s.length; i++) {
		out[i] = { position: s[i].position.clone(), rotation: s[i].rotation.clone() };
	}
	return out;
}

function copyStateInto(src: NetworkBodyState[], dst: NetworkBodyState[]) {
	const n = Math.min(src.length, dst.length);
	for (let i = 0; i < n; i++) {
		dst[i].position.copy(src[i].position);
		dst[i].rotation.copy(src[i].rotation);
	}
}

function lerpStatesInto(a: NetworkBodyState[], b: NetworkBodyState[], t: number, dst: NetworkBodyState[]) {
	const n = Math.min(a.length, b.length, dst.length);
	for (let i = 0; i < n; i++) {
		dst[i].position.lerpVectors(a[i].position, b[i].position, t);
		dst[i].rotation.copy(a[i].rotation).slerp(b[i].rotation, t);
	}
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
