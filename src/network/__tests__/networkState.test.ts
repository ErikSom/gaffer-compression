import { NetworkBodyState } from "../networkInterfaces";
import settings from "../../settings";
import { Quaternion, Vector3 } from "three";
import { collectFullSnapshot, collectRelativeSnapshot, getNetworkStateFromFullSnapshot, getNetworkStateFromRelativeSnapshot, networkCache } from "../networkState";

function randomUnitVector() {
	let x, y, z;
	let lengthSquared;
	do {
		x = 2 * Math.random() - 1;
		y = 2 * Math.random() - 1;
		z = 2 * Math.random() - 1;
		lengthSquared = x * x + y * y + z * z;
	} while (lengthSquared >= 1 || lengthSquared === 0);
	let length = Math.sqrt(lengthSquared);
	return { x: x / length, y: y / length, z: z / length };
}

function randomQuaternion() {
	let axis = randomUnitVector();
	let angle = Math.random() * 2 * Math.PI;
	let halfAngle = angle / 2;
	let sinHalfAngle = Math.sin(halfAngle);
	return new Quaternion(
		axis.x * sinHalfAngle,
		axis.y * sinHalfAngle,
		axis.z * sinHalfAngle,
		Math.cos(halfAngle)
	);
}

// Smallest angle between two orientations, in degrees.
function quatAngleDeg(a: Quaternion, b: Quaternion): number {
	const dot = Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w));
	return (2 * Math.acos(dot) * 180) / Math.PI;
}

function randomWorldPosition() {
	const { positionBoundsInMeters } = settings;

	const x = Math.random() * positionBoundsInMeters - positionBoundsInMeters / 2;
	const y = Math.random() * positionBoundsInMeters - positionBoundsInMeters / 2;
	const z = Math.random() * positionBoundsInMeters - positionBoundsInMeters / 2;

	return new Vector3(x, y, z);
}

function generateFakeFullNetworkState(): NetworkBodyState[] {
	const objects = settings.maxPhysicsObjects;
	const state = [] as NetworkBodyState[];
	for (let i = 0; i < objects; i++) {
		const position = randomWorldPosition();
		const rotation = randomQuaternion();
		state.push({ position, rotation });
	}
	return state;
}

test('test full networkstate snapshot serialisation', () => {
	networkCache.networkStates = [generateFakeFullNetworkState()];
	const snapshot = collectFullSnapshot(0);

	console.log("Snapshot bytesize", snapshot.byteLength);
	console.log("Snapshot KB", snapshot.byteLength / 1024);

	const networkState = getNetworkStateFromFullSnapshot(snapshot);

	const state = networkCache.networkStates[0];
	for (let i = 0; i < state.length; i++) {
		const cached = state[i];
		const received = networkState[i];

		const maxAllowedComponentDifference = 1 / settings.unitsPerMeter;

		expect(Math.abs(cached.position.x - received.position.x)).toBeLessThanOrEqual(maxAllowedComponentDifference);
		expect(Math.abs(cached.position.y - received.position.y)).toBeLessThanOrEqual(maxAllowedComponentDifference);
		expect(Math.abs(cached.position.z - received.position.z)).toBeLessThanOrEqual(maxAllowedComponentDifference);

		expect(Math.abs(cached.rotation.x) - Math.abs(received.rotation.x)).toBeLessThan(0.1);
		expect(Math.abs(cached.rotation.y) - Math.abs(received.rotation.y)).toBeLessThan(0.1);
		expect(Math.abs(cached.rotation.z) - Math.abs(received.rotation.z)).toBeLessThan(0.1);
		expect(Math.abs(cached.rotation.w) - Math.abs(received.rotation.w)).toBeLessThan(0.1);

	}
});

function cloneState(baseState) {
	const state = [] as NetworkBodyState[];
	for (let i = 0; i < baseState.length; i++) {
		const cached = baseState[i];
		const position = cached.position.clone();
		const rotation = cached.rotation.clone();
		state.push({ position, rotation });
	}
	return state;
}

// Offset each selected object by an amount guaranteed to exceed the wire
// quantization resolution (1cm position, ~0.3deg orientation at 9 bits), so the
// change detector reliably flags it. Sub-resolution offsets are intentionally
// free now, so the test must perturb above the threshold to exercise the codec.
function offsetState(state, indexesToOffset, maxPosOffset) {
	const sign = () => (Math.random() < 0.5 ? -1 : 1);
	const axisMag = () => 0.03 + Math.random() * Math.max(0, maxPosOffset - 0.03);

	indexesToOffset.forEach(index => {
		const obj = state[index];

		// position: >= 3cm on every axis (well above the 1cm resolution)
		obj.position.x += sign() * axisMag();
		obj.position.y += sign() * axisMag();
		obj.position.z += sign() * axisMag();

		// rotation: a clean 1.5deg..4deg twist, above the ~0.3deg resolution
		const axis = randomUnitVector();
		const angle = (1.5 + Math.random() * 2.5) * Math.PI / 180;
		const s = Math.sin(angle / 2);
		obj.rotation.multiply(new Quaternion(axis.x * s, axis.y * s, axis.z * s, Math.cos(angle / 2)));
	});
}

test('test relative networkstate snapshot serialisation with relative indexing', () => {

	const baseState = generateFakeFullNetworkState();

	// clone base state
	const state = cloneState(baseState);

	// offset 5 random objects
	const indexesToOffset = [5, 10, 15, 20, 25];
	const maxOffsetDelta = 0.1;

	offsetState(state, indexesToOffset, maxOffsetDelta);

	// push states to cache
	networkCache.networkStates = [baseState, state];
	networkCache.relativeNetworkSnapshots = [];

	const snapshot = collectRelativeSnapshot(1, 0);

	console.log("Snapshot bytesize", snapshot.byteLength);
	console.log("Snapshot KB", snapshot.byteLength / 1024);

	const networkState = getNetworkStateFromRelativeSnapshot(snapshot, 0);

	for (let i = 0; i < indexesToOffset.length; i++) {
		const index = indexesToOffset[i];
		const decoded = networkState[index];
		const sent = state[index];
		const base = baseState[index];

		// the offset (supra-resolution) must register as changed from the baseline
		const changed = !decoded.position.equals(base.position) || !decoded.rotation.equals(base.rotation);
		expect(changed).toBeTruthy();

		// ...and round-trip to within the wire quantization of what was sent
		expect(Math.abs(decoded.position.x - sent.position.x)).toBeLessThanOrEqual(1 / settings.unitsPerMeter);
		expect(Math.abs(decoded.position.y - sent.position.y)).toBeLessThanOrEqual(1 / settings.unitsPerMeter);
		expect(Math.abs(decoded.position.z - sent.position.z)).toBeLessThanOrEqual(1 / settings.unitsPerMeter);
		expect(quatAngleDeg(decoded.rotation, sent.rotation)).toBeLessThan(1.0);
	}
});

test('a fully settled scene (nothing changed) costs almost nothing', () => {
	// The headline property: thousands of sleeping bodies whose quantized pose is
	// unchanged collapse to a handful of bytes — just frame id + "0 changed".
	const baseState = generateFakeFullNetworkState();
	const state = cloneState(baseState); // identical: every body asleep

	networkCache.networkStates = [baseState, state];
	networkCache.relativeNetworkSnapshots = [];

	const snapshot = collectRelativeSnapshot(1, 0);
	console.log(`Settled delta for ${settings.maxPhysicsObjects} bodies:`, snapshot.byteLength, "bytes");

	// 4 bytes frame + a couple header bits, rounded up to whole bytes.
	expect(snapshot.byteLength).toBeLessThanOrEqual(8);

	// And it still round-trips to the (unchanged) base state.
	const decoded = getNetworkStateFromRelativeSnapshot(snapshot, 0);
	expect(decoded.length).toBe(baseState.length);
	expect(decoded[0].position.equals(baseState[0].position)).toBeTruthy();
});

test('test relative networkstate snapshot serialisation with absolute indexing', () => {
	const baseState = generateFakeFullNetworkState();

	// clone base state
	const state = cloneState(baseState);

	const indexesToOffset: number[] = [];

	// offset 500 random objects
	let j = 0;
	for (let i = 0; i < 500; i++) {
		indexesToOffset.push(j);
		j += 2;
	}

	const maxOffsetDelta = 0.1;

	offsetState(state, indexesToOffset, maxOffsetDelta);

	// push states to cache
	networkCache.networkStates = [baseState, state];
	networkCache.relativeNetworkSnapshots = [];

	const snapshot = collectRelativeSnapshot(1, 0);

	console.log("Snapshot bytesize", snapshot.byteLength);
	console.log("Snapshot KB", snapshot.byteLength / 1024);

	const networkState = getNetworkStateFromRelativeSnapshot(snapshot, 0);

	for (let i = 0; i < indexesToOffset.length; i++) {
		const index = indexesToOffset[i];
		const decoded = networkState[index];
		const sent = state[index];
		const base = baseState[index];

		// the offset (supra-resolution) must register as changed from the baseline
		const changed = !decoded.position.equals(base.position) || !decoded.rotation.equals(base.rotation);
		expect(changed).toBeTruthy();

		// ...and round-trip to within the wire quantization of what was sent
		expect(Math.abs(decoded.position.x - sent.position.x)).toBeLessThanOrEqual(1 / settings.unitsPerMeter);
		expect(Math.abs(decoded.position.y - sent.position.y)).toBeLessThanOrEqual(1 / settings.unitsPerMeter);
		expect(Math.abs(decoded.position.z - sent.position.z)).toBeLessThanOrEqual(1 / settings.unitsPerMeter);
		expect(quatAngleDeg(decoded.rotation, sent.rotation)).toBeLessThan(1.0);
	}
});
