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

function offsetState(state, indexesToOffset, maxOffsetDelta) {
	indexesToOffset.forEach(index => {

		let posChanged = false;

		// randomly offset position
		if (Math.random() > 0.5) {
			const cached = state[index];
			const position = cached.position;
			position.x += maxOffsetDelta * 2 * Math.random() - maxOffsetDelta;
			position.y += maxOffsetDelta * 2 * Math.random() - maxOffsetDelta;
			position.z += maxOffsetDelta * 2 * Math.random() - maxOffsetDelta;
			posChanged = true;
		}

		// randomly offset rotation, or always offset if position was not changed
		if (!posChanged || Math.random() > 0.5) {
			// offset rotation with maxOffsetDelta degrees
			const cached = state[index];
			const rotation = cached.rotation;

			// Generate a random rotation axis
			let axis = randomUnitVector();

			// Create a small rotation angle within maxOffsetDelta range
			let smallAngle = (Math.random() * 2 - 1) * maxOffsetDelta * Math.PI / 180; // Convert to radians
			let smallRotation = new Quaternion(
				axis.x * Math.sin(smallAngle / 2),
				axis.y * Math.sin(smallAngle / 2),
				axis.z * Math.sin(smallAngle / 2),
				Math.cos(smallAngle / 2)
			);

			// Apply the small rotation to the current rotation
			rotation.multiply(smallRotation);
		}
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

	const baseCached = networkCache.networkStates[0];

	for (let i = 0; i < indexesToOffset.length; i++) {
		const index = indexesToOffset[i];
		const cached = networkState[index];
		const baseCachedObject = baseCached[index];

		// expect that either position or rotation is different
		const positionChanged = !cached.position.equals(baseCachedObject.position);
		const rotationChanged = !cached.rotation.equals(baseCachedObject.rotation);
		expect(positionChanged || rotationChanged).toBeTruthy();

		const maxAllowedComponentDifference = 1 / settings.unitsPerMeter + maxOffsetDelta;

		expect(Math.abs(cached.position.x - baseCachedObject.position.x)).toBeLessThanOrEqual(maxAllowedComponentDifference);
		expect(Math.abs(cached.position.y - baseCachedObject.position.y)).toBeLessThanOrEqual(maxAllowedComponentDifference);
		expect(Math.abs(cached.position.z - baseCachedObject.position.z)).toBeLessThanOrEqual(maxAllowedComponentDifference);

		const maxAllowedRotationDifference = 1 / settings.unitsPerMeter;

		expect(Math.abs(cached.rotation.x) - Math.abs(baseCachedObject.rotation.x)).toBeLessThan(maxAllowedRotationDifference);
		expect(Math.abs(cached.rotation.y) - Math.abs(baseCachedObject.rotation.y)).toBeLessThan(maxAllowedRotationDifference);
		expect(Math.abs(cached.rotation.z) - Math.abs(baseCachedObject.rotation.z)).toBeLessThan(maxAllowedRotationDifference);
		expect(Math.abs(cached.rotation.w) - Math.abs(baseCachedObject.rotation.w)).toBeLessThan(maxAllowedRotationDifference);
	}
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

	const baseCached = networkCache.networkStates[0];

	for (let i = 0; i < indexesToOffset.length; i++) {
		const index = indexesToOffset[i];
		const cached = networkState[index];
		const baseCachedObject = baseCached[index];

		// expect that either position or rotation is different
		const positionChanged = !cached.position.equals(baseCachedObject.position);
		const rotationChanged = !cached.rotation.equals(baseCachedObject.rotation);
		expect(positionChanged || rotationChanged).toBeTruthy();

		const maxAllowedComponentDifference = 1 / settings.unitsPerMeter + maxOffsetDelta;

		expect(Math.abs(cached.position.x - baseCachedObject.position.x)).toBeLessThanOrEqual(maxAllowedComponentDifference);
		expect(Math.abs(cached.position.y - baseCachedObject.position.y)).toBeLessThanOrEqual(maxAllowedComponentDifference);
		expect(Math.abs(cached.position.z - baseCachedObject.position.z)).toBeLessThanOrEqual(maxAllowedComponentDifference);

		const maxAllowedRotationDifference = 1 / settings.unitsPerMeter;
		expect(Math.abs(cached.rotation.x) - Math.abs(baseCachedObject.rotation.x)).toBeLessThan(maxAllowedRotationDifference);
		expect(Math.abs(cached.rotation.y) - Math.abs(baseCachedObject.rotation.y)).toBeLessThan(maxAllowedRotationDifference);
		expect(Math.abs(cached.rotation.z) - Math.abs(baseCachedObject.rotation.z)).toBeLessThan(maxAllowedRotationDifference);
		expect(Math.abs(cached.rotation.w) - Math.abs(baseCachedObject.rotation.w)).toBeLessThan(maxAllowedRotationDifference);
	}
});
