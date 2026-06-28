import { Quaternion, Vector3 } from "three";
import {
	PLAYER_RADIUS,
	PLAYER_DENSITY,
	PLAYER_MOVE_FORCE,
	PLAYER_LINEAR_DAMPING,
	WORLD_HALF,
	FLOOR_Y,
	GRAVITY_Y,
} from "../shared/sceneConfig.js";

// Client-side prediction for the locally-owned ball. It integrates your input
// immediately (so controls feel instant regardless of latency), then eases toward
// the authoritative "ghost" position so it stays correct. It predicts only the
// free-body motion — input force, gravity, damping, floor and walls — NOT box
// collisions; that divergence is absorbed by the reconciliation ease (which is
// why driving into a pile makes the ball settle back rather than snap).
const RECON_SOFT_TAU_MS = 260; // gentle drift correction → prediction dominates short-term
const RECON_PENDING_TAU_MS = 700; // avoid fighting inputs the server has not processed yet
const RECON_HARD_TAU_MS = 110;  // firmer correction on big divergence (a collision)
const RECON_DEADBAND = 0.08;    // ignore tiny quantization/ghost-filter movement
const RECON_HARD_DIST = 1.5;   // metres of error treated as a collision divergence
const RECON_SNAP_DIST = 12;    // beyond this, snap outright (teleport / respawn / desync)

const _err = new Vector3();
const _rollAxis = new Vector3();
const _deltaQ = new Quaternion();
const _errDir = new Vector3();

export interface PredictionUpdateOptions {
	pendingInputs?: number;
	ghostVelocity?: Vector3;
	ghostRotation?: Quaternion;
}

export class PlayerPredictor {
	readonly position = new Vector3();
	readonly velocity = new Vector3();
	readonly rotation = new Quaternion();
	active = false;

	private readonly accel: number; // m/s^2 at full input (force / mass)

	constructor() {
		const volume = (4 / 3) * Math.PI * PLAYER_RADIUS ** 3;
		const mass = PLAYER_DENSITY * volume;
		this.accel = PLAYER_MOVE_FORCE / mass;
	}

	reset(pos: Vector3, rot: Quaternion, velocity?: Vector3) {
		this.position.copy(pos);
		this.rotation.copy(rot);
		if (velocity) this.velocity.copy(velocity);
		else this.velocity.set(0, 0, 0);
		this.active = true;
	}

	// Advance prediction by dtMs with the current input, then reconcile toward the
	// authoritative ghost (already brought to ~now by the caller).
	update(dtMs: number, inputX: number, inputZ: number, ghost: Vector3, ghostActive: boolean, options: PredictionUpdateOptions = {}) {
		if (!this.active) {
			if (ghostActive) this.reset(ghost, options.ghostRotation ?? this.rotation, options.ghostVelocity);
			return;
		}
		const dt = Math.min(dtMs, 100) / 1000;
		if (dt <= 0) return;

		const prevX = this.position.x;
		const prevZ = this.position.z;

		// Continuous force matching the server's per-tick impulse, plus gravity and
		// linear damping (Rapier's v *= 1/(1 + d·dt) model).
		this.velocity.x += inputX * this.accel * dt;
		this.velocity.z += inputZ * this.accel * dt;
		this.velocity.y += GRAVITY_Y * dt;
		this.velocity.multiplyScalar(1 / (1 + PLAYER_LINEAR_DAMPING * dt));
		this.position.addScaledVector(this.velocity, dt);

		// Floor + walls are the only collisions we predict.
		const floorY = FLOOR_Y + PLAYER_RADIUS;
		if (this.position.y < floorY) {
			this.position.y = floorY;
			if (this.velocity.y < 0) this.velocity.y = 0;
		}
		const lim = WORLD_HALF - PLAYER_RADIUS;
		if (this.position.x < -lim) { this.position.x = -lim; this.velocity.x = 0; }
		else if (this.position.x > lim) { this.position.x = lim; this.velocity.x = 0; }
		if (this.position.z < -lim) { this.position.z = -lim; this.velocity.z = 0; }
		else if (this.position.z > lim) { this.position.z = lim; this.velocity.z = 0; }

		// Roll from simulated motion only. Reconciliation corrections are visual
		// error repair, not physical travel, and using them for roll causes shimmer.
		const dx = this.position.x - prevX;
		const dz = this.position.z - prevZ;
		const horiz = Math.hypot(dx, dz);
		if (horiz > 1e-5) {
			_rollAxis.set(dz, 0, -dx).multiplyScalar(1 / horiz); // up × motion
			_deltaQ.setFromAxisAngle(_rollAxis, horiz / PLAYER_RADIUS);
			this.rotation.premultiply(_deltaQ);
		}

		// Reconcile toward the ghost.
		if (ghostActive) {
			_err.subVectors(ghost, this.position);
			const dist = _err.length();
			if (dist > RECON_SNAP_DIST) {
				this.reset(ghost, options.ghostRotation ?? this.rotation, options.ghostVelocity); // hard desync → snap
			} else if (dist > RECON_DEADBAND) {
				const pending = Math.min(options.pendingInputs ?? 0, 12);
				const pendingMix = pending / 12;
				const softTau = RECON_SOFT_TAU_MS + (RECON_PENDING_TAU_MS - RECON_SOFT_TAU_MS) * pendingMix;
				const tau = dist > RECON_HARD_DIST ? RECON_HARD_TAU_MS : softTau;
				const alpha = 1 - Math.exp(-dtMs / tau);
				const correctionScale = ((dist - RECON_DEADBAND) / dist) * alpha;
				this.position.addScaledVector(_err, correctionScale);

				// If prediction is moving away from the ghost, cancel that component.
				// This damps small collision mismatches without globally killing input.
				_errDir.copy(_err).multiplyScalar(1 / dist);
				const awaySpeed = -this.velocity.dot(_errDir);
				if (awaySpeed > 0) this.velocity.addScaledVector(_errDir, awaySpeed * alpha);

				if (options.ghostVelocity && (dist > RECON_HARD_DIST || pending === 0)) {
					const velAlpha = 1 - Math.exp(-dtMs / (dist > RECON_HARD_DIST ? 120 : 280));
					this.velocity.lerp(options.ghostVelocity, velAlpha);
				}
				if (options.ghostRotation && dist > RECON_HARD_DIST) {
					this.rotation.slerp(options.ghostRotation, Math.min(alpha, 0.2));
				}
			}
		}
	}
}
