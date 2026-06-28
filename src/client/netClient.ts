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
import { PlayerPredictor } from "./playerPredictor.js";
import type { NetworkBodyState } from "../network/networkInterfaces.js";
import { MAX_PLAYERS, PLAYER_BASE_INDEX, TOTAL_OBJECTS } from "../shared/sceneConfig.js";
import settings from "../settings.js";

interface BufferedSnapshot {
	frame: number;
	state: NetworkBodyState[];
}

const MAX_BUFFERED_SNAPSHOTS = 24;
const MAX_ADAPTIVE_EXTRA_DELAY_MS = 180;
// Framerate-independent smoothing time constants (delay rises fast, falls slow).
const DELAY_RISE_TAU_MS = 40;
const DELAY_FALL_TAU_MS = 800;
const MAX_EXTRAPOLATE_MS = 100;
const MAX_EXTRAPOLATE_RATIO = 1.5;
// Rotation overshoots faster than position under extrapolation — cap it tighter.
const MAX_ROT_EXTRAPOLATE_RATIO = 0.5;
// How far past the freshest snapshot the locally-owned ball is dead-reckoned
// toward real time, to shave the interpolation buffer off its perceived input lag.
const OWNED_LEAD_MAX_MS = 70;
const GHOST_SMOOTH_TAU_MS = 90;
const GHOST_SNAP_DIST = 6;
const OWNED_RENDER_SMOOTH_TAU_MS = 35;
const OWNED_RENDER_SNAP_DIST = 4;
// The client only needs recent frames as delta baselines (~RTT), far fewer than
// the server's history. The state pool must exceed this window (counted in
// snapshots) so a recycled slot is always already out of the cache and buffer.
const CLIENT_CACHE_FRAMES = 64;
const STATE_POOL_SIZE = 96;

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
	// Fires once the first authoritative snapshot after a (re)connect has been
	// decoded — i.e. there is renderable state, so a loading overlay can drop.
	public onConnected: (() => void) | null = null;
	// Fires whenever the socket closes (cold-start retries included).
	public onDisconnected: (() => void) | null = null;
	private hadSnapshotSinceConnect = false;

	private snapshotBuffer: BufferedSnapshot[] = [];
	private lastSnapshotFrame = -1;
	private highestDecodedFrame = -1;
	private inputSeq = 0;
	private lastProcessedInputSeq = 0;

	// Frame-number render clock: advances at real time in server-frame units and
	// snaps back if it drifts (stall, big jitter, or a server restart). Playback
	// position is a pure function of frame ids, so arrival jitter never warps it.
	private renderFrame = -1;
	private lastClockAt = -1; // -1 = uninitialised (distinct from a real now of 0)
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

	// Client-side prediction of the locally-owned ball + the authoritative "ghost"
	// it reconciles toward (also drawn, transparent, when the debug flag is on).
	private predictor = new PlayerPredictor();
	private localInputX = 0;
	private localInputZ = 0;
	public readonly ghostPosition = new Vector3();
	public readonly ghostRotation = new Quaternion();
	public ghostActive = false;
	private readonly ghostTargetPosition = new Vector3();
	private readonly ghostTargetRotation = new Quaternion();
	private readonly ghostVelocity = new Vector3();
	private ghostSmoothActive = false;
	private readonly ownedRenderPosition = new Vector3();
	private readonly ownedRenderRotation = new Quaternion();
	private ownedRenderActive = false;

	// Ring of reusable decode targets so steady-state snapshot decoding never
	// allocates a fresh 4104-object state. A slot is the same object the cache and
	// buffer reference, so the pool just has to outlive that window.
	private statePool: NetworkBodyState[][] = [];
	private poolCursor = 0;

	constructor() {
		this.upSim = new DirectionalNetSim((data) => this.rawSend(data));
		this.downSim = new DirectionalNetSim((data) => this.handlePacket(data));
		this.interpOut = this.makeEmptyState();
		for (let i = 0; i < STATE_POOL_SIZE; i++) this.statePool.push(this.makeEmptyState());
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
			this.onDisconnected?.();
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
		this.lastClockAt = -1;
		this.lastSnapshotArrivalAt = 0;
		this.jitterEmaMs = 0;
		this.baseDelayFrames = settings.renderDelayMs / this.physicsDt;
		this.delayFrames = this.baseDelayFrames;
		this.hadSnapshotSinceConnect = false;
		this.predictor.active = false; // re-seed from the next authoritative position
		this.ghostActive = false;
		this.ghostSmoothActive = false;
		this.ownedRenderActive = false;
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

		// Decode into the next pooled slot; only consume it once we know it held a
		// snapshot (a null/non-snapshot decode leaves the slot untouched).
		const out = this.statePool[this.poolCursor];
		const msg = decodePacket(buffer, out);
		if (!msg) return;

		if (msg.type === MsgType.FullSnapshot || msg.type === MsgType.DeltaSnapshot) {
			this.poolCursor = (this.poolCursor + 1) % STATE_POOL_SIZE;
			this.recordSnapshotArrival(msg.frame);
			this.insertSnapshot(msg.frame, msg.state);
			if (msg.frame > this.highestDecodedFrame) {
				this.highestDecodedFrame = msg.frame;
				this.lastSnapshotFrame = msg.frame;
				// Forward-only: never let a reordered older snapshot rewind the echo.
				this.lastProcessedInputSeq = msg.lastProcessedInputSeq;
			}
			this.pruneClientCache();
			this.send(encodeAck(this.highestDecodedFrame));
			if (!this.hadSnapshotSinceConnect) {
				this.hadSnapshotSinceConnect = true;
				this.onConnected?.();
			}
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
		const cutoff = this.highestDecodedFrame - CLIENT_CACHE_FRAMES;
		pruneNetworkCacheBefore(cutoff);
	}

	private updateAdaptiveDelay(dtMs: number) {
		const maxExtraFrames = MAX_ADAPTIVE_EXTRA_DELAY_MS / this.physicsDt;
		const jitterFrames = this.physicsDt > 0 ? this.jitterEmaMs / this.physicsDt : 0;
		const targetDelayFrames = this.baseDelayFrames + clamp(jitterFrames * 2, 0, maxExtraFrames);
		// Time-constant smoothing → adapts at the same wall-clock rate regardless
		// of render fps (a fixed per-call alpha would adapt 2x faster at 120fps).
		const tau = targetDelayFrames > this.delayFrames ? DELAY_RISE_TAU_MS : DELAY_FALL_TAU_MS;
		const alpha = 1 - Math.exp(-dtMs / tau);
		this.delayFrames += (targetDelayFrames - this.delayFrames) * alpha;
		if (this.delayFrames < this.baseDelayFrames) this.delayFrames = this.baseDelayFrames;
	}

	sendInput(move: { x: number; y: number; z: number }) {
		this.inputSeq = (this.inputSeq + 1) & 0xffff;
		this.send(encodeInput(this.inputSeq, move));
	}

	// Latest input, sampled every render frame so client prediction integrates it
	// continuously (sendInput is throttled to the upstream tick rate).
	setLocalInput(x: number, z: number) {
		this.localInputX = x;
		this.localInputZ = z;
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
		// Clamp dt so a backgrounded tab (huge gap) can't rocket the clock or the
		// adaptive delay; the drift resync below handles the resulting catch-up.
		const dtMs = this.lastClockAt >= 0 ? Math.min(now - this.lastClockAt, 250) : this.physicsDt;
		this.updateAdaptiveDelay(dtMs);
		const newest = buf[buf.length - 1].frame;
		const oldest = buf[0].frame;
		const target = newest - this.delayFrames;

		if (this.renderFrame < 0) {
			this.renderFrame = target;
		} else {
			this.renderFrame += dtMs / this.physicsDt;
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
					this.updateOwnedPrediction(buf, now, dtMs);
					return this.interpOut;
				}
			}
		}

		// Sampling clamp after the short extrapolation budget is gone — if starved
		// for longer we hold at the newest snapshot, never rewind.
		const rf = this.renderFrame < oldest ? oldest : this.renderFrame > newest ? newest : this.renderFrame;

		if (buf.length === 1 || rf >= newest) {
			copyStateInto(buf[buf.length - 1].state, this.interpOut);
		} else {
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
		}

		// The locally-owned ball is rendered from client-side prediction (instant
		// response to input), reconciled toward the authoritative ghost. Boxes and
		// other players stay on the delayed interpolated stream.
		this.updateOwnedPrediction(buf, now, dtMs);
		return this.interpOut;
	}

	// Authoritative owned-ball position brought to ~now (extrapolated from the two
	// freshest snapshots): the prediction's reconcile target and the debug ghost.
	private computeGhostNow(buf: BufferedSnapshot[], now: number, dtMs: number, idx: number) {
		this.ghostActive = false;
		this.ghostVelocity.set(0, 0, 0);
		if (buf.length < 1) return;
		const newerSnap = buf[buf.length - 1];
		const newer = newerSnap.state[idx];
		if (!newer || newer.position.y <= -500) {
			this.ghostSmoothActive = false;
			return; // not an active player
		}
		if (buf.length < 2) {
			this.ghostTargetPosition.copy(newer.position);
			this.ghostTargetRotation.copy(newer.rotation);
			this.updateSmoothedGhost(dtMs);
			return;
		}
		const olderSnap = buf[buf.length - 2];
		const older = olderSnap.state[idx];
		const span = newerSnap.frame - olderSnap.frame;
		const spanMs = span * this.physicsDt;
		if (spanMs > 0) this.ghostVelocity.subVectors(newer.position, older.position).multiplyScalar(1000 / spanMs);
		const aheadFrames = (span > 0 && this.lastSnapshotArrivalAt > 0)
			? Math.min((now - this.lastSnapshotArrivalAt) / this.physicsDt, OWNED_LEAD_MAX_MS / this.physicsDt)
			: 0;
		const t = span > 0 ? Math.min(aheadFrames / span, MAX_EXTRAPOLATE_RATIO) : 0;
		const np = newer.position;
		const ap = older.position;
		this.ghostTargetPosition.set(np.x + (np.x - ap.x) * t, np.y + (np.y - ap.y) * t, np.z + (np.z - ap.z) * t);
		this.ghostTargetRotation.copy(older.rotation).slerp(newer.rotation, 1 + Math.min(t, MAX_ROT_EXTRAPOLATE_RATIO));
		this.updateSmoothedGhost(dtMs);
	}

	private updateSmoothedGhost(dtMs: number) {
		if (!this.ghostSmoothActive || this.ghostPosition.distanceTo(this.ghostTargetPosition) > GHOST_SNAP_DIST) {
			this.ghostPosition.copy(this.ghostTargetPosition);
			this.ghostRotation.copy(this.ghostTargetRotation);
			this.ghostSmoothActive = true;
		} else {
			const alpha = 1 - Math.exp(-dtMs / GHOST_SMOOTH_TAU_MS);
			this.ghostPosition.lerp(this.ghostTargetPosition, alpha);
			this.ghostRotation.slerp(this.ghostTargetRotation, alpha);
		}
		this.ghostActive = true;
	}

	private updateOwnedPrediction(buf: BufferedSnapshot[], now: number, dtMs: number) {
		const idx = this.playerBaseIndex;
		if (idx < PLAYER_BASE_INDEX) return; // not welcomed yet
		this.computeGhostNow(buf, now, dtMs, idx);
		this.predictor.update(dtMs, this.localInputX, this.localInputZ, this.ghostPosition, this.ghostActive, {
			pendingInputs: inputSeqDistance(this.lastProcessedInputSeq, this.inputSeq),
			ghostVelocity: this.ghostVelocity,
			ghostRotation: this.ghostRotation,
		});
		if (this.predictor.active) {
			this.updateOwnedRenderSmoothing(dtMs);
			this.interpOut[idx].position.copy(this.ownedRenderPosition);
			this.interpOut[idx].rotation.copy(this.ownedRenderRotation);
		}
	}

	private updateOwnedRenderSmoothing(dtMs: number) {
		if (!this.ownedRenderActive || this.ownedRenderPosition.distanceTo(this.predictor.position) > OWNED_RENDER_SNAP_DIST) {
			this.ownedRenderPosition.copy(this.predictor.position);
			this.ownedRenderRotation.copy(this.predictor.rotation);
			this.ownedRenderActive = true;
			return;
		}
		const alpha = 1 - Math.exp(-dtMs / OWNED_RENDER_SMOOTH_TAU_MS);
		this.ownedRenderPosition.lerp(this.predictor.position, alpha);
		this.ownedRenderRotation.slerp(this.predictor.rotation, alpha);
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
		dst[index].rotation.copy(older.rotation).slerp(newer.rotation, 1 + Math.min(t, MAX_ROT_EXTRAPOLATE_RATIO));
	}
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }
function inputSeqDistance(acked: number, sent: number): number {
	const delta = (sent - acked) & 0xffff;
	return delta < 0x8000 ? delta : 0;
}
