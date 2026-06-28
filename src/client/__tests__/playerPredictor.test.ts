import { Quaternion, Vector3 } from "three";
import { PlayerPredictor } from "../playerPredictor";
import { PLAYER_RADIUS } from "../../shared/sceneConfig";

const ball = (x: number) => new Vector3(x, PLAYER_RADIUS, 0);

test("predicts input movement immediately (no server confirmation needed)", () => {
	const p = new PlayerPredictor();
	p.reset(ball(0), new Quaternion());
	// drive +x for ~1s with no ghost reconciliation
	for (let i = 0; i < 60; i++) p.update(16, 1, 0, new Vector3(), false);
	expect(p.position.x).toBeGreaterThan(0.05);
});

test("reconciles smoothly toward the authoritative ghost", () => {
	const p = new PlayerPredictor();
	p.reset(ball(5), new Quaternion());
	const ghost = ball(0);
	for (let i = 0; i < 120; i++) p.update(16, 0, 0, ghost, true);
	expect(p.position.x).toBeLessThan(0.5); // pulled back to the ghost
});

test("backs off reconciliation while local inputs are still pending", () => {
	const noPending = new PlayerPredictor();
	const pending = new PlayerPredictor();
	noPending.reset(ball(1), new Quaternion());
	pending.reset(ball(1), new Quaternion());
	const ghost = ball(0);

	noPending.update(16, 0, 0, ghost, true, { pendingInputs: 0 });
	pending.update(16, 0, 0, ghost, true, { pendingInputs: 12 });

	expect(pending.position.x).toBeGreaterThan(noPending.position.x);
});

test("reconciliation correction does not create roll jitter", () => {
	const p = new PlayerPredictor();
	const startRot = new Quaternion();
	p.reset(ball(1), startRot);

	for (let i = 0; i < 30; i++) p.update(16, 0, 0, ball(0), true);

	expect(p.rotation.angleTo(startRot)).toBeLessThan(0.001);
});

test("snaps on a large divergence (teleport / desync)", () => {
	const p = new PlayerPredictor();
	p.reset(ball(0), new Quaternion());
	p.update(16, 0, 0, ball(50), true); // >RECON_SNAP_DIST
	expect(p.position.x).toBeCloseTo(50, 0);
});

test("activates from the ghost the first time one is seen", () => {
	const p = new PlayerPredictor();
	expect(p.active).toBe(false);
	p.update(16, 0, 0, ball(3), true);
	expect(p.active).toBe(true);
	expect(p.position.x).toBeCloseTo(3, 0);
});
