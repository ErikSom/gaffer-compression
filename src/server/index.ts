import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three";
import { networkCache, pruneNetworkCacheBefore } from "../network/networkState.js";
import type { NetworkBodyState } from "../network/networkInterfaces.js";
import {
	MsgType,
	packDeltaSnapshot,
	packFullSnapshot,
	decodePacket,
	encodeWelcome,
	encodeConfig,
} from "../shared/protocol.js";
import {
	WORLD_HALF,
	FLOOR_Y,
	GRAVITY_Y,
	DYNAMIC_COUNT,
	SPAWN_LAYERS,
	PILE_GRID,
	BOX_SIZE,
	BOX_LINEAR_DAMPING,
	BOX_ANGULAR_DAMPING,
	PLAYER_RADIUS,
	PLAYER_SPAWN_RADIUS,
	PLAYER_BASE_INDEX,
	MAX_PLAYERS,
	PLAYER_MOVE_FORCE,
	PLAYER_ROLL_TORQUE,
	PLAYER_DENSITY,
	PLAYER_LINEAR_DAMPING,
	PLAYER_ANGULAR_DAMPING,
	PLAYER_FRICTION,
} from "../shared/sceneConfig.js";
import settings from "../settings.js";
import { hasFreshInput, impulseScaleForHz, isNewerInputSeq, newestFrame } from "./simulationControls.js";

// Render (and most PaaS) inject the port to bind via $PORT; fall back to 8787 locally.
const PORT = Number(process.env.PORT) || 8787;

// Don't broadcast to a client whose socket is already this backed up — on a real
// constrained downlink the send buffer grows under TCP backpressure, and piling
// on only deepens the queue. Skip until it drains.
const FLOW_CONTROL_MAX_BYTES = 128 * 1024;

// "Reset boxes" resets the pile for *everyone*, so rate-limit it authoritatively
// here — a client-side guard alone is trivially bypassed.
const RESET_COOLDOWN_MS = 30_000;

interface ClientRec {
	id: number;
	ws: WebSocket;
	slot: number;
	body: RAPIER.RigidBody;
	lastAckedFrame: number | null;
	lastInputSeq: number | null;
	input: { x: number; z: number };
	lastInputAt: number;
	removed: boolean;
}

async function main() {
	await RAPIER.init();

	const world = new RAPIER.World({ x: 0, y: GRAVITY_Y, z: 0 });
	world.timestep = 1 / settings.physicsHz;

	// floor
	world.createCollider(
		RAPIER.ColliderDesc.cuboid(WORLD_HALF, 0.5, WORLD_HALF).setTranslation(0, FLOOR_Y - 0.5, 0)
	);
	// containing walls
	for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
		world.createCollider(
			RAPIER.ColliderDesc.cuboid(nx !== 0 ? 0.5 : WORLD_HALF, 20, nz !== 0 ? 0.5 : WORLD_HALF)
				.setTranslation(nx * WORLD_HALF, 10, nz * WORLD_HALF)
		);
	}

	// Boxes spawn *already resting* in a PILE_GRID×PILE_GRID spread of tall piles,
	// so the scene is calm from the first frame and the ball disturbs only a few
	// piles at a time.
	const dynamicBodies: RAPIER.RigidBody[] = [];
	const spawnPositions: { x: number; y: number; z: number }[] = []; // for "reset boxes"
	const half = BOX_SIZE * 0.5;
	const spacing = BOX_SIZE * 1.04;
	const pileCount = PILE_GRID * PILE_GRID;
	const perPile = Math.ceil(DYNAMIC_COUNT / pileCount);
	const pileSide = Math.max(1, Math.ceil(Math.sqrt(perPile / SPAWN_LAYERS)));
	const pileGap = WORLD_HALF * 0.5;        // distance between adjacent pile centers
	const gridHalf = (PILE_GRID - 1) / 2;
	let spawned = 0;
	for (let gx = 0; gx < PILE_GRID && spawned < DYNAMIC_COUNT; gx++) {
		for (let gz = 0; gz < PILE_GRID && spawned < DYNAMIC_COUNT; gz++) {
			const cx = (gx - gridHalf) * pileGap;
			const cz = (gz - gridHalf) * pileGap;
			let inPile = 0;
			for (let y = 0; y < SPAWN_LAYERS && inPile < perPile && spawned < DYNAMIC_COUNT; y++) {
				for (let x = 0; x < pileSide && inPile < perPile && spawned < DYNAMIC_COUNT; x++) {
					for (let z = 0; z < pileSide && inPile < perPile && spawned < DYNAMIC_COUNT; z++) {
						const px = cx + (x - pileSide / 2) * spacing;
						const pz = cz + (z - pileSide / 2) * spacing;
						const py = FLOOR_Y + half + y * (BOX_SIZE * 1.001);
						const body = world.createRigidBody(
							RAPIER.RigidBodyDesc.dynamic()
								.setTranslation(px, py, pz)
								.setLinearDamping(BOX_LINEAR_DAMPING)
								.setAngularDamping(BOX_ANGULAR_DAMPING)
								.setCanSleep(true)
						);
						world.createCollider(
							RAPIER.ColliderDesc.cuboid(half, half, half)
								.setRestitution(0.1)
								.setFriction(0.8)
								.setDensity(1.0),
							body
						);
						dynamicBodies.push(body);
						spawnPositions.push({ x: px, y: py, z: pz });
						spawned++;
						inPile++;
					}
				}
			}
		}
	}

	const playerBodies: (RAPIER.RigidBody | null)[] = new Array(MAX_PLAYERS).fill(null);

	function spawnPlayerBody(slot: number): RAPIER.RigidBody {
		// Line players up along the +z edge, centered, all facing into the pile.
		const x = (slot - (MAX_PLAYERS - 1) / 2) * (PLAYER_RADIUS * 2.5);
		const body = world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic()
				.setTranslation(x, PLAYER_RADIUS + 0.2, PLAYER_SPAWN_RADIUS)
				.setLinearDamping(PLAYER_LINEAR_DAMPING)
				.setAngularDamping(PLAYER_ANGULAR_DAMPING)
		);
		world.createCollider(
			RAPIER.ColliderDesc.ball(PLAYER_RADIUS)
				.setRestitution(0.2)
				.setFriction(PLAYER_FRICTION)
				.setDensity(PLAYER_DENSITY),
			body
		);
		return body;
	}

	const clients = new Map<number, ClientRec>();
	let nextClientId = 1;

	function claimSlot(): number {
		for (let i = 0; i < MAX_PLAYERS; i++) if (playerBodies[i] === null) return i;
		return -1;
	}

	// Idempotent: safe to call from eviction and from the ws 'close'/'error' handlers.
	function removeClient(rec: ClientRec) {
		if (rec.removed) return;
		rec.removed = true;
		clients.delete(rec.id);
		if (playerBodies[rec.slot] === rec.body) {
			world.removeRigidBody(rec.body);
			playerBodies[rec.slot] = null;
		}
	}

	const totalObjects = DYNAMIC_COUNT + MAX_PLAYERS;

	// Pre-allocated ring of state arrays so the 20Hz collection never allocates —
	// no GC churn and no GC-induced missed physics ticks under heavy motion. The
	// ring must hold more than the number of snapshots kept in history so a slot
	// is never reused while still needed as a delta baseline.
	const snapshotFrames = Math.round(settings.physicsHz / settings.snapshotHz);
	const STATE_POOL_SIZE = Math.ceil(settings.snapshotHistory / snapshotFrames) + 16;
	const statePool: NetworkBodyState[][] = [];
	for (let p = 0; p < STATE_POOL_SIZE; p++) {
		const arr: NetworkBodyState[] = new Array(totalObjects);
		for (let i = 0; i < totalObjects; i++) arr[i] = { position: new Vector3(), rotation: new Quaternion() };
		statePool.push(arr);
	}
	let statePoolCursor = 0;

	function collectState(frame: number) {
		const state = statePool[statePoolCursor];
		statePoolCursor = (statePoolCursor + 1) % STATE_POOL_SIZE;
		for (let i = 0; i < DYNAMIC_COUNT; i++) {
			const t = dynamicBodies[i].translation();
			const r = dynamicBodies[i].rotation();
			state[i].position.set(t.x, t.y, t.z);
			state[i].rotation.set(r.x, r.y, r.z, r.w);
		}
		for (let i = 0; i < MAX_PLAYERS; i++) {
			const b = playerBodies[i];
			const o = state[PLAYER_BASE_INDEX + i];
			if (b) {
				const t = b.translation();
				const r = b.rotation();
				o.position.set(t.x, t.y, t.z);
				o.rotation.set(r.x, r.y, r.z, r.w);
			} else {
				o.position.set(0, -1000, 0);
				o.rotation.set(0, 0, 0, 1);
			}
		}
		networkCache.networkStates[frame] = state;
		networkCache.networkSnapshotFrame = null;
		networkCache.networkSnaphot = null;
	}

	// One impulse per tick (impulse = force / Hz). Rapier consumes and clears
	// impulses each step, so this behaves like a steady force. (addForce/addTorque
	// are *persistent* and would accumulate every tick — that ramping force was
	// what rocketed the ball off-world.)
	function applyInputs(now: number) {
		const impulseScale = impulseScaleForHz(physicsHz);
		for (const c of clients.values()) {
			if (!hasFreshInput(c.lastInputAt, now)) {
				c.input.x = 0;
				c.input.z = 0;
				continue;
			}
			const { x, z } = c.input;
			if (x !== 0 || z !== 0) {
				// Push + roll the ball; it plows the boxes by sheer mass.
				c.body.applyImpulse({ x: x * PLAYER_MOVE_FORCE * impulseScale, y: 0, z: z * PLAYER_MOVE_FORCE * impulseScale }, true);
				c.body.applyTorqueImpulse({ x: z * PLAYER_ROLL_TORQUE * impulseScale, y: 0, z: -x * PLAYER_ROLL_TORQUE * impulseScale }, true);
			}
		}
	}

	function recycleStrayBodies() {
		for (let i = 0; i < dynamicBodies.length; i++) {
			const b = dynamicBodies[i];
			const t = b.translation();
			if (t.y < -5 || Math.abs(t.x) > WORLD_HALF + 2 || Math.abs(t.z) > WORLD_HALF + 2) {
				b.setTranslation({ x: (Math.random() - 0.5) * WORLD_HALF, y: 14, z: (Math.random() - 0.5) * WORLD_HALF }, true);
				b.setLinvel({ x: 0, y: 0, z: 0 }, true);
				b.setAngvel({ x: 0, y: 0, z: 0 }, true);
			}
		}
	}

	// Snap every box back to its starting pile position, at rest. Broadcast to all
	// clients via the normal snapshot stream, so one player's reset resets for all.
	let lastResetAt = 0;
	const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };
	function resetBoxes() {
		for (let i = 0; i < dynamicBodies.length; i++) {
			const b = dynamicBodies[i];
			b.setTranslation(spawnPositions[i], true);
			b.setRotation(IDENTITY_ROT, true);
			b.setLinvel({ x: 0, y: 0, z: 0 }, true);
			b.setAngvel({ x: 0, y: 0, z: 0 }, true);
		}
		console.log("boxes reset");
	}

	function cleanupOldFrames(currentFrame: number) {
		const cutoff = currentFrame - settings.snapshotHistory;
		pruneNetworkCacheBefore(cutoff);
	}

	// Physics steps at physicsHz; state is collected + broadcast at snapshotHz.
	// physicsHz is live-tunable (the F1 panel can A/B 30/40/50/60), so the rate,
	// timestep, and snapshot cadence are mutable.
	let frame = 0;
	let physicsHz = settings.physicsHz;
	let physicsDt = 1000 / physicsHz;
	let snapshotInterval = Math.max(1, Math.round(physicsHz / settings.snapshotHz));
	let bytesSentWindow = 0;
	let statsTimer = Date.now();

	function broadcast(currentFrame: number) {
		// Build the full snapshot lazily — only a freshly-joined client (no valid
		// ack) needs it. In steady state every client gets a small delta, so the
		// ~4097-object full serialization is skipped entirely.
		for (const c of clients.values()) {
			if (c.ws.readyState !== WebSocket.OPEN) continue;
			if (c.ws.bufferedAmount > FLOW_CONTROL_MAX_BYTES) continue; // backed up → let it drain
			let buf: ArrayBuffer | null = null;
			const ack = c.lastAckedFrame;
			if (ack !== null && networkCache.networkStates[ack] !== undefined) {
				try { buf = packDeltaSnapshot(currentFrame, ack, c.lastInputSeq ?? 0); } catch { buf = null; }
			}
			if (buf === null) {
				// The compressed full payload is cached underneath, but the header is
				// client-specific because it echoes that client's latest input seq.
				buf = packFullSnapshot(currentFrame, c.lastInputSeq ?? 0);
			}
			try {
				c.ws.send(buf, { binary: true });
				bytesSentWindow += buf.byteLength;
			} catch { /* dropped; close handler cleans up */ }
		}
	}

	function stepOnce(now: number) {
		applyInputs(now);
		world.step();
		frame = (frame + 1) & settings.maxPackageId;
		if ((frame & 63) === 0) recycleStrayBodies();

		if (frame % snapshotInterval === 0) {
			collectState(frame);
			broadcast(frame);
			cleanupOldFrames(frame);
		}
	}

	// Self-correcting fixed-timestep loop. A plain setInterval steps exactly once
	// per fire, so any late fire (timer jitter, a GC pause, the OS time-slicing
	// the process against the browser) permanently loses a tick — and a snapshot.
	// Instead we accumulate real elapsed time and step however many times are
	// needed to catch up, capped to avoid a spiral after a long stall. Physics has
	// ~2x headroom (≈8.6ms work in a 16.7ms budget), so this keeps real-time 60Hz
	// physics and 20Hz snapshots steady even when fires are jittery.
	const MAX_CATCHUP_STEPS = 4;
	let lastLoopAt = Date.now();
	let accumulator = 0;

	function loop() {
		const now = Date.now();
		let elapsed = now - lastLoopAt;
		lastLoopAt = now;
		if (elapsed > 200) elapsed = 200; // clamp pathological gaps (debugger, sleep)
		accumulator += elapsed;

		let steps = 0;
		while (accumulator >= physicsDt && steps < MAX_CATCHUP_STEPS) {
			stepOnce(now);
			accumulator -= physicsDt;
			steps++;
		}
		if (accumulator >= physicsDt) accumulator = 0; // capped out → drop backlog, don't spiral

		if (now - statsTimer > 1000) {
			const kbps = ((bytesSentWindow * 8) / 1024).toFixed(1);
			console.log(`[f${frame}] clients=${clients.size} ${physicsHz}Hz up=${kbps} kbps`);
			bytesSentWindow = 0;
			statsTimer = now;
		}
	}

	let loopHandle: ReturnType<typeof setInterval> | null = null;
	function startLoop() {
		if (loopHandle) clearInterval(loopHandle);
		lastLoopAt = Date.now();
		accumulator = 0;
		loopHandle = setInterval(loop, physicsDt);
	}

	function setPhysicsHz(hz: number) {
		hz = Math.max(20, Math.min(60, Math.round(hz)));
		if (hz === physicsHz) return;
		physicsHz = hz;
		physicsDt = 1000 / hz;
		world.timestep = 1 / hz;
		snapshotInterval = Math.max(1, Math.round(hz / settings.snapshotHz));
		startLoop();
		const cfg = encodeConfig(physicsHz, settings.snapshotHz);
		for (const c of clients.values()) {
			if (c.ws.readyState === WebSocket.OPEN) { try { c.ws.send(cfg, { binary: true }); } catch { /* ignore */ } }
		}
		console.log(`physics → ${physicsHz}Hz (snapshot interval ${snapshotInterval})`);
	}

	startLoop();

	// Plain HTTP server next to the WS server: gives the host a 200 health check and
	// an endpoint the client can hit to wake a slept free-tier dyno (any inbound
	// request triggers the wake; a fetch avoids the per-attempt WS console noise).
	const httpServer = createServer((req, res) => {
		res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
		res.end("ok");
	});
	const wss = new WebSocketServer({ server: httpServer });
	httpServer.listen(PORT, () => {
		console.log(`server listening on :${PORT} — ${DYNAMIC_COUNT} boxes`);
	});

	wss.on("connection", (ws) => {
		const slot = claimSlot();
		if (slot < 0) { ws.close(1013, "server full"); return; }

		const body = spawnPlayerBody(slot);
		playerBodies[slot] = body;
		const id = nextClientId++;
		const rec: ClientRec = { id, ws, slot, body, lastAckedFrame: null, lastInputSeq: null, input: { x: 0, z: 0 }, lastInputAt: 0, removed: false };
		clients.set(id, rec);

		ws.binaryType = "arraybuffer";
		ws.send(encodeWelcome(id, DYNAMIC_COUNT, PLAYER_BASE_INDEX + slot), { binary: true });
		ws.send(encodeConfig(physicsHz, settings.snapshotHz), { binary: true });
		console.log(`[+] client ${id} joined (slot ${slot})`);

		ws.on("message", (data) => {
			const buf = data instanceof ArrayBuffer
				? data
				: (data as Buffer).buffer.slice((data as Buffer).byteOffset, (data as Buffer).byteOffset + (data as Buffer).byteLength);
			const msg = decodePacket(buf as ArrayBuffer);
			if (!msg) return;
			if (msg.type === MsgType.Ack) {
				rec.lastAckedFrame = newestFrame(rec.lastAckedFrame, msg.frame);
			} else if (msg.type === MsgType.Input) {
				if (!isNewerInputSeq(rec.lastInputSeq, msg.seq)) return;
				rec.lastInputSeq = msg.seq;
				rec.input.x = msg.move.x;
				rec.input.z = msg.move.z;
				rec.lastInputAt = Date.now();
			} else if (msg.type === MsgType.SetHz) {
				setPhysicsHz(msg.physicsHz);
			} else if (msg.type === MsgType.ResetBoxes) {
				const now = Date.now();
				if (now - lastResetAt >= RESET_COOLDOWN_MS) {
					lastResetAt = now;
					resetBoxes();
				} // else: still cooling down — ignore the spam
			}
		});

		ws.on("close", () => { console.log(`[-] client ${id} left`); removeClient(rec); });
		ws.on("error", () => removeClient(rec));
	});
}

main().catch((err) => { console.error(err); process.exit(1); });
