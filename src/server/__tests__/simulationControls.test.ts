import { hasFreshInput, impulseScaleForHz, isNewerInputSeq, newestFrame } from "../simulationControls";

test("acked frame tracking is monotonic", () => {
	expect(newestFrame(null, 4)).toBe(4);
	expect(newestFrame(10, 12)).toBe(12);
	expect(newestFrame(10, 8)).toBe(10);
	expect(newestFrame(10, 10)).toBe(10);
});

test("input freshness expires stale movement", () => {
	expect(hasFreshInput(1000, 1100, 250)).toBe(true);
	expect(hasFreshInput(1000, 1300, 250)).toBe(false);
	expect(hasFreshInput(0, 10, 250)).toBe(false);
});

test("impulse scaling follows the active physics rate", () => {
	expect(impulseScaleForHz(20)).toBeCloseTo(1 / 20);
	expect(impulseScaleForHz(40)).toBeCloseTo(1 / 40);
	expect(impulseScaleForHz(60)).toBeCloseTo(1 / 60);
});

test("input sequence ordering rejects stale movement packets and handles wraparound", () => {
	expect(isNewerInputSeq(null, 1)).toBe(true);
	expect(isNewerInputSeq(10, 11)).toBe(true);
	expect(isNewerInputSeq(10, 10)).toBe(false);
	expect(isNewerInputSeq(10, 8)).toBe(false);
	expect(isNewerInputSeq(65534, 1)).toBe(true);
	expect(isNewerInputSeq(1, 65534)).toBe(false);
});
