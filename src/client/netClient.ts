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
import { pruneNetworkCacheBefore, resetNetworkCache } from "../network/networkState.js";
import type { NetworkBodyState } from "../network/networkInterfaces.js";
import { MAX_PLAYERS, PLAYER_BASE_INDEX, TOTAL_OBJECTS } from "../shared/sceneConfig.js";
import settings from "../settings.js";

interface BufferedSnapshot {
	frame: number;
	state: NetworkBodyState[];
}

const MAX_BUFFERED_SNAPSHOTS = 24;
const MAX_ADAPTIVE_EXTRA_DELAY_MS = 180;
const DELAY_RISE_ALPHA = 0.35;
const DELAY_FALL_ALPHA = 0.02;
const MAX_EXTRAPOLATE_MS = 100;
const MAX_EXTRAPOLATE_RATIO = 1.5;

export interface NetStats {
	bytesPerSecDown: number;
	packetsPerSecDown: number;
	packetLossPct: number;
	bufferedSnapshots: number;
	lastPacketBytes: number;
	serverFrame: number;
	renderFrame: number;
	lastProcessedInputSeq: number;
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
	private highestDecodedFrame = -1;
	private inputSeq = 0;
	private lastProcessedInputSeq = 0;

	// Frame-number render clock: advances at real time in server-frame units and
	// snaps back if it drifts (stall, big jitter, or a server restart). Playback
	// position is a pure function of frame ids, so arrival jitter never warps it.
	private renderFrame = -1;
	private lastClockAt = 0;
	// Driven by the server's Config message — the render clock must advance in the
	// server's actual physics-frame units, which change live when the rate does.
	private physicsHz = settings.physicsHz;
	private physicsDt = 1000 / settings.physicsHz;
	private snapshotHz = settings.snapshotHz;
	private baseDelayFrames = settings.renderDelayMs / (1000 / settings.physicsHz);
	private delayFrames = this.baseDelayFrames;
	private lastSnapshotArrivalAt = 0;
	private jitterEmaMs = 0;
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
		this.highestDecodedFrame = -1;
		this.lastProcessedInputSeq = 0;
		this.renderFrame = -1;
		this.lastClockAt = 0;
		this.lastSnapshotArrivalAt = 0;
		this.jitterEmaMs = 0;
		this.baseDelayFrames = settings.renderDelayMs / this.physicsDt;
		this.delayFrames = this.baseDelayFrames;
		resetNetworkCache();
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
				this.setServerTiming(cfg.physicsHz, cfg.snapshotHz);
				this.onConfig?.(cfg.physicsHz);
			}
			return;
		}

		const msg = decodePacket(buffer);
		if (!msg) return;

		if (msg.type === MsgType.FullSnapshot || msg.type === MsgType.DeltaSnapshot) {
			this.recordSnapshotArrival(msg.frame);
			this.lastProcessedInputSeq = msg.lastProcessedInputSeq;
			this.insertSnapshot(msg.frame, msg.state);
			if (msg.frame > this.highestDecodedFrame) {
				this.highestDecodedFrame = msg.frame;
				this.lastSnapshotFrame = msg.frame;
			}
			this.pruneClientCache();
			this.send(encodeAck(this.highestDecodedFrame));
		}
	}

	private setServerTiming(physicsHz: number, snapshotHz: number) {
		this.physicsHz = physicsHz;
		this.physicsDt = 1000 / physicsHz;
		this.snapshotHz = snapshotHz;
		this.baseDelayFrames = settings.renderDelayMs / this.physicsDt;
		this.delayFrames = Math.max(this.delayFrames, this.baseDelayFrames);
	}

	private recordSnapshotArrival(frame: number) {
		if (frame <= this.highestDecodedFrame) return;
		const now = performance.now();
		if (this.highestDecodedFrame >= 0 && this.lastSnapshotArrivalAt > 0) {
			const expectedMs = (frame - this.highestDecodedFrame) * this.physicsDt;
			const actualMs = now - this.lastSnapshotArrivalAt;
			const jitterSample = Math.abs(actualMs - expectedMs);
			this.jitterEmaMs = this.jitterEmaMs === 0 ? jitterSample : this.jitterEmaMs * 0.85 + jitterSample * 0.15;
		}
		this.lastSnapshotArrivalAt = now;
	}

	private insertSnapshot(frame: number, state: NetworkBodyState[]) {
		for (const s of this.snapshotBuffer) {
			if (s.frame === frame) return;
		}
		this.snapshotBuffer.push({ frame, state });
		this.snapshotBuffer.sort((a, b) => a.frame - b.frame);
		while (this.snapshotBuffer.length > MAX_BUFFERED_SNAPSHOTS) this.snapshotBuffer.shift();
	}

	private pruneClientCache() {
		if (this.highestDecodedFrame < 0) return;
		const cutoff = this.highestDecodedFrame - settings.snapshotHistory;
		pruneNetworkCacheBefore(cutoff);
	}

	private updateAdaptiveDelay() {
		const maxExtraFrames = MAX_ADAPTIVE_EXTRA_DELAY_MS / this.physicsDt;
		const jitterFrames = this.physicsDt > 0 ? this.jitterEmaMs / this.physicsDt : 0;
		const targetDelayFrames = this.baseDelayFrames + clamp(jitterFrames * 2, 0, maxExtraFrames);
		const alpha = targetDelayFrames > this.delayFrames ? DELAY_RISE_ALPHA : DELAY_FALL_ALPHA;
		this.delayFrames += (targetDelayFrames - this.delayFrames) * alpha;
		if (this.delayFrames < this.baseDelayFrames) this.delayFrames = this.baseDelayFrames;
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
		this.updateAdaptiveDelay();
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
			if (Math.abs(drift) > Math.max(this.delayFrames * 4, 4)) {
				this.renderFrame = target;
			} else {
				this.renderFrame += drift * 0.05;
			}
		}
		this.lastClockAt = now;

		if (this.renderFrame > newest && buf.length >= 2) {
			const newer = buf[buf.length - 1];
			const older = buf[buf.length - 2];
			const span = newer.frame - older.frame;
			if (span > 0) {
				const maxExtraFrames = MAX_EXTRAPOLATE_MS / this.physicsDt;
				const extraFrames = Math.min(this.renderFrame - newest, maxExtraFrames);
				if (extraFrames > 0) {
					extrapolatePlayersInto(older.state, newer.state, span, extraFrames, this.interpOut);
					return this.interpOut;
				}
			}
		}

		// Sampling clamp after the short extrapolation budget is gone — if starved
		// for longer we hold at the newest snapshot, never rewind.
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
			lastProcessedInputSeq: this.lastProcessedInputSeq,
		};
	}
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

function extrapolatePlayersInto(a: NetworkBodyState[], b: NetworkBodyState[], spanFrames: number, extraFrames: number, dst: NetworkBodyState[]) {
	// Start from the newest authoritative snapshot. Collision-heavy boxes stay
	// clamped there; only player bodies get a short visual extrapolation.
	copyStateInto(b, dst);
	const t = Math.min(extraFrames / spanFrames, MAX_EXTRAPOLATE_RATIO);
	for (let i = 0; i < MAX_PLAYERS; i++) {
		const index = PLAYER_BASE_INDEX + i;
		if (index >= a.length || index >= b.length || index >= dst.length) break;
		const older = a[index];
		const newer = b[index];
		if (newer.position.y <= -500) continue;
		const ap = older.position;
		const bp = newer.position;
		dst[index].position.set(
			bp.x + (bp.x - ap.x) * t,
			bp.y + (bp.y - ap.y) * t,
			bp.z + (bp.z - ap.z) * t
		);
		dst[index].rotation.copy(older.rotation).slerp(newer.rotation, 1 + t);
	}
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
