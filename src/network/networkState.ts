import { Quaternion, Vector3 } from "three";
import { NetworkBodyState, RWBitStream } from "./networkInterfaces";
import { BitStream, BitView } from "bit-buffer";
import { countRelativeIdBits, serializeBool, serializeInt, serializeRelativeIndex, serializeRelativeOrientation, serializeRelativePosition } from "./serialization";
import settings from "../settings";
import { CompressedQuaternion } from "./compressedQuaternion";

interface NetworkCache {
	// networkState [frame][state]
	networkStates: NetworkBodyState[][];

	networkSnapshotFrame: number | null;
	networkSnaphot: ArrayBuffer | null;

	// relativeNetworkState [frame][arrayBuffer]
	relativeNetworkSnapshots: ArrayBuffer[][];
}

export const networkCache: NetworkCache = {
	networkStates: [],
	networkSnapshotFrame: null,
	networkSnaphot: null,
	relativeNetworkSnapshots: [],
};

export function resetNetworkCache() {
	networkCache.networkStates = [];
	networkCache.networkSnapshotFrame = null;
	networkCache.networkSnaphot = null;
	networkCache.relativeNetworkSnapshots = [];
}

export function pruneNetworkCacheBefore(cutoffFrame: number) {
	for (const k in networkCache.networkStates) {
		if (Number(k) < cutoffFrame) delete networkCache.networkStates[k];
	}
	for (const k in networkCache.relativeNetworkSnapshots) {
		if (Number(k) < cutoffFrame) delete networkCache.relativeNetworkSnapshots[k];
	}
	if (networkCache.networkSnapshotFrame !== null && networkCache.networkSnapshotFrame < cutoffFrame) {
		networkCache.networkSnapshotFrame = null;
		networkCache.networkSnaphot = null;
	}
}

// Worst case is ~14 bytes/object (large absolute position delta + full
// orientation + index bits). 20 bytes/object + slack is comfortably safe and
// scales with the configured body count instead of a fixed 16KB that overflowed
// past ~1500 objects.
const SNAPSHOT_BUFFER_BYTES = settings.maxPhysicsObjects * 20 + 2048;

// Single reusable serialization buffer for the write path (server only). Each
// snapshot writes into it then slices out just the bytes it used, so we churn
// only the final right-sized packet instead of a fresh 84KB ArrayBuffer every
// 20Hz tick. Write calls are synchronous and sequential, so one scratch is safe.
const scratchBuffer = new ArrayBuffer(SNAPSHOT_BUFFER_BYTES);
const scratchView = new BitView(scratchBuffer);

function worldPositionToNetworkPosition(position: Vector3) {
	const networkX = Math.round(position.x * settings.unitsPerMeter);
	const networkY = Math.round(position.y * settings.unitsPerMeter);
	const networkZ = Math.round(position.z * settings.unitsPerMeter);

	return new Vector3(networkX, networkY, networkZ);
}

function networkPositionToWorldPosition(position: Vector3) {
	const x = position.x / settings.unitsPerMeter;
	const y = position.y / settings.unitsPerMeter;
	const z = position.z / settings.unitsPerMeter;

	return new Vector3(x, y, z);
}

export function collectFullSnapshot(frame: number): ArrayBuffer {

	if (networkCache.networkSnapshotFrame === frame && networkCache.networkSnaphot) {
		return networkCache.networkSnaphot;
	}

	const state = networkCache.networkStates[frame];

	const rwBitStream = new BitStream(scratchView) as RWBitStream;
	rwBitStream.isWriting = true;

	serializeInt(rwBitStream, frame, 0, settings.maxPackageId);

	writeFullNetworkSnapshot(rwBitStream, state);

	const trimmedBuffer = scratchBuffer.slice(0, Math.ceil(rwBitStream.index / 8));

	networkCache.networkSnapshotFrame = frame;
	networkCache.networkSnaphot = trimmedBuffer;

	return trimmedBuffer;
}

export function writeFullNetworkSnapshot(stream: RWBitStream, state: NetworkBodyState[]) {
	serializeInt(stream, state.length, 0, settings.maxPhysicsObjects);
	// write all positions relative to 0, 0, 0
	// write all orientations relative to 0, 0, 0, 1

	const stateOrientation = new CompressedQuaternion(settings.orientationBits);

	const q = new Quaternion();
	const originOrientation = new CompressedQuaternion(settings.orientationBits);
	originOrientation.load(q.x, q.y, q.z, q.w);

	state.forEach(object => {
		const { x, y, z } = worldPositionToNetworkPosition(object.position);
		serializeRelativePosition(stream, x, y, z, 0, 0, 0);

		const { x: qx, y: qy, z: qz, w: qw } = object.rotation;
		stateOrientation.load(qx, qy, qz, qw);

		serializeRelativeOrientation(stream, stateOrientation, originOrientation);
	});
}

// `out`, when supplied, is written in place (no per-object allocation) — the
// client passes a pooled state array so steady-state decoding never churns GC.
export function getNetworkStateFromFullSnapshot(buffer: ArrayBuffer, out?: NetworkBodyState[]): NetworkBodyState[] {
	const bitView = new BitView(buffer);
	const rwBitStream = new BitStream(bitView) as RWBitStream;
	rwBitStream.isWriting = false;
	rwBitStream.isReading = true;
	rwBitStream.index = 0;

	serializeInt(rwBitStream, 0, 0, settings.maxPackageId);

	return readFullNetworkSnapshot(rwBitStream, out);
}

function readFullNetworkSnapshot(stream: RWBitStream, out?: NetworkBodyState[]): NetworkBodyState[] {
	const state = out ?? ([] as NetworkBodyState[]);

	// Read the length of the state array first
	const length = serializeInt(stream, 0, 0, settings.maxPhysicsObjects);

	const stateOrientation = new CompressedQuaternion(settings.orientationBits);

	const q = new Quaternion();
	const originOrientation = new CompressedQuaternion(settings.orientationBits);
	originOrientation.load(q.x, q.y, q.z, q.w);

	for (let i = 0; i < length; i++) {
		const networkPosition = serializeRelativePosition(stream, 0, 0, 0, 0, 0, 0);
		const position = networkPositionToWorldPosition(networkPosition);

		serializeRelativeOrientation(stream, stateOrientation, originOrientation);
		const { x: qx, y: qy, z: qz, w: qw } = stateOrientation.save();

		if (out) {
			out[i].position.copy(position);
			out[i].rotation.set(qx, qy, qz, qw);
		} else {
			state.push({ position, rotation: new Quaternion(qx, qy, qz, qw) });
		}
	}

	return state;
}

export function collectRelativeSnapshot(frame: number, baseFrame: number): ArrayBuffer {
	if (networkCache.relativeNetworkSnapshots[frame] && networkCache.relativeNetworkSnapshots[frame][baseFrame]) {
		return networkCache.relativeNetworkSnapshots[frame][baseFrame];
	}

	const state = networkCache.networkStates[frame];
	const baseState = networkCache.networkStates[baseFrame];

	if (!state || !baseState) {
		throw new Error(`Base state for frame ${baseFrame} not found`);
	}

	const rwBitStream = new BitStream(scratchView) as RWBitStream;
	rwBitStream.isWriting = true;

	serializeInt(rwBitStream, frame, 0, settings.maxPackageId);

	writeRelativeNetworkSnapshot(rwBitStream, state, baseState);

	const trimmedBuffer = scratchBuffer.slice(0, Math.ceil(rwBitStream.index / 8));

	if (!networkCache.relativeNetworkSnapshots[frame]) {
		networkCache.relativeNetworkSnapshots[frame] = [];
	}
	networkCache.relativeNetworkSnapshots[frame][baseFrame] = trimmedBuffer;

	return trimmedBuffer;
}

// Change-detection compares the *quantized* values that actually go on the
// wire (cm-resolution position, smallest-three orientation integers), not raw
// floats. Two states that serialize identically are therefore "equal" and cost
// nothing — resting bodies and sub-resolution jitter become free, which is what
// makes a 4096-body scene collapse to a few bytes once it settles.
const _cmpA = new CompressedQuaternion(settings.orientationBits);
const _cmpB = new CompressedQuaternion(settings.orientationBits);
const _writeStateOrientation = new CompressedQuaternion(settings.orientationBits);
const _writeBaseOrientation = new CompressedQuaternion(settings.orientationBits);
const _positionChangedScratch = new Uint8Array(settings.maxPhysicsObjects);
const _rotationChangedScratch = new Uint8Array(settings.maxPhysicsObjects);
const _changedScratch = new Uint8Array(settings.maxPhysicsObjects);

function quantizePos(n: number): number {
	return Math.round(n * settings.unitsPerMeter);
}

function isNetworkStatePositionEqual(state: NetworkBodyState, baseState: NetworkBodyState) {
	return quantizePos(state.position.x) === quantizePos(baseState.position.x)
		&& quantizePos(state.position.y) === quantizePos(baseState.position.y)
		&& quantizePos(state.position.z) === quantizePos(baseState.position.z);
}

function isNetworkStateRotationEqual(state: NetworkBodyState, baseState: NetworkBodyState) {
	_cmpA.load(state.rotation.x, state.rotation.y, state.rotation.z, state.rotation.w);
	_cmpB.load(baseState.rotation.x, baseState.rotation.y, baseState.rotation.z, baseState.rotation.w);
	return _cmpA.largest === _cmpB.largest
		&& _cmpA.integerA === _cmpB.integerA
		&& _cmpA.integerB === _cmpB.integerB
		&& _cmpA.integerC === _cmpB.integerC;
}

function isNetworkStateEqual(state: NetworkBodyState, baseState: NetworkBodyState) {
	return isNetworkStatePositionEqual(state, baseState) && isNetworkStateRotationEqual(state, baseState);
}

function writeRelativeState(stream: RWBitStream, state: NetworkBodyState, baseState: NetworkBodyState, positionDidChange?: boolean, rotationDidChange?: boolean) {
	let positionChanged = positionDidChange ?? !isNetworkStatePositionEqual(state, baseState);
	// write position changed
	positionChanged = serializeBool(stream, positionChanged);

	if (positionChanged) {
		const x = quantizePos(state.position.x);
		const y = quantizePos(state.position.y);
		const z = quantizePos(state.position.z);
		const bx = quantizePos(baseState.position.x);
		const by = quantizePos(baseState.position.y);
		const bz = quantizePos(baseState.position.z);
		// write relative position
		serializeRelativePosition(stream, x, y, z, bx, by, bz);
	}

	let rotationChanged = rotationDidChange ?? !isNetworkStateRotationEqual(state, baseState);
	// write rotation changed
	rotationChanged = serializeBool(stream, rotationChanged);

	if (rotationChanged) {
		const { x: qx, y: qy, z: qz, w: qw } = state.rotation;
		const { x: bx, y: by, z: bz, w: bw } = baseState.rotation;
		_writeStateOrientation.load(qx, qy, qz, qw);
		_writeBaseOrientation.load(bx, by, bz, bw);
		// write relative rotation
		serializeRelativeOrientation(stream, _writeStateOrientation, _writeBaseOrientation);
	}
}

function writeRelativeNetworkSnapshot(stream: RWBitStream, state: NetworkBodyState[], baseState: NetworkBodyState[]) {
	let useIndices = false;
	let numChanged: number | undefined = undefined;

	numChanged = 0;
	for (let i = 0; i < state.length; i++) {
		const positionChanged = !isNetworkStatePositionEqual(state[i], baseState[i]);
		const rotationChanged = !isNetworkStateRotationEqual(state[i], baseState[i]);
		const changed = positionChanged || rotationChanged;
		_positionChangedScratch[i] = positionChanged ? 1 : 0;
		_rotationChangedScratch[i] = rotationChanged ? 1 : 0;
		_changedScratch[i] = changed ? 1 : 0;
		if (changed) {
			numChanged++;
		}
	}

	const relativeBitSize = countRelativeIdBits(_changedScratch.subarray(0, state.length));

	useIndices = relativeBitSize < settings.maxPhysicsObjects;
	// write use indices
	useIndices = serializeBool(stream, useIndices);

	if (useIndices) {

		// write num changed
		serializeInt(stream, numChanged, 0, settings.maxPhysicsObjects - 1);

		let first = true;
		let previousIndex = 0;
		for (let i = 0; i < state.length; i++) {
			const changed = _changedScratch[i] !== 0;

			if (changed) {
				if (first) {
					// write absolute index
					serializeInt(stream, i, 0, settings.maxPhysicsObjects - 1);
					first = false;
				} else {
					// write relative index
					serializeRelativeIndex(stream, previousIndex, i);
				}

				// write relative state
				writeRelativeState(
					stream,
					state[i],
					baseState[i],
					_positionChangedScratch[i] !== 0,
					_rotationChangedScratch[i] !== 0
				);

				previousIndex = i;
			}
		}
	} else {
		for (let i = 0; i < settings.maxPhysicsObjects; i++) {
			let changed = _changedScratch[i] !== 0;
			// write changed
			changed = serializeBool(stream, changed);

			if (changed) {
				// write relative state
				writeRelativeState(
					stream,
					state[i],
					baseState[i],
					_positionChangedScratch[i] !== 0,
					_rotationChangedScratch[i] !== 0
				);
			}
		}
	}
}

export function getNetworkStateFromRelativeSnapshot(buffer: ArrayBuffer, baseFrame: number, out?: NetworkBodyState[]): NetworkBodyState[] {
	const bitView = new BitView(buffer);
	const rwBitStream = new BitStream(bitView) as RWBitStream;
	rwBitStream.isWriting = false;
	rwBitStream.isReading = true;
	rwBitStream.index = 0;

	// read frame
	const frame = serializeInt(rwBitStream, 0, 0, settings.maxPackageId);

	const baseState = networkCache.networkStates[baseFrame];

	let state: NetworkBodyState[];
	if (out) {
		// Reuse the pooled array: copy the baseline in place, then apply the delta.
		for (let i = 0; i < baseState.length; i++) {
			out[i].position.copy(baseState[i].position);
			out[i].rotation.copy(baseState[i].rotation);
		}
		state = out;
	} else {
		state = baseState.map(object => {
			return { position: object.position.clone(), rotation: object.rotation.clone() };
		});
	}

	readRelativeNetworkSnapshot(rwBitStream, state, baseState);

	// store the state in the cache
	networkCache.networkStates[frame] = state;

	return state;
}

function readRelativeState(stream: RWBitStream, state: NetworkBodyState, baseState: NetworkBodyState) {
	let positionChanged = false;
	// read position changed
	positionChanged = serializeBool(stream, positionChanged);

	if (positionChanged) {
		const { x: bx, y: by, z: bz } = worldPositionToNetworkPosition(baseState.position);
		// read relative position
		const networkPosition = serializeRelativePosition(stream, 0, 0, 0, bx, by, bz);
		// Mutate in place so a pooled `out` array keeps its Vector3 instances.
		state.position.copy(networkPositionToWorldPosition(networkPosition));
	}

	let rotationChanged = false;
	// read rotation changed
	rotationChanged = serializeBool(stream, rotationChanged);

	if (rotationChanged) {
		const stateOrientation = new CompressedQuaternion(settings.orientationBits);
		const baseOrientation = new CompressedQuaternion(settings.orientationBits);

		const { x: qx, y: qy, z: qz, w: qw } = state.rotation;
		baseOrientation.load(qx, qy, qz, qw);

		// read relative rotation
		serializeRelativeOrientation(stream, stateOrientation, baseOrientation);

		const { x, y, z, w } = stateOrientation.save();

		state.rotation.set(x, y, z, w);
	}
}

function readRelativeNetworkSnapshot(stream: RWBitStream, readState: NetworkBodyState[], baseState: NetworkBodyState[]) {
	let useIndices = false;
	let numChanged: number | undefined = undefined;

	// read use indices
	useIndices = serializeBool(stream, useIndices);

	if (useIndices) {
		// read num changed
		numChanged = serializeInt(stream, numChanged, 0, settings.maxPhysicsObjects - 1);

		let previousIndex = 0;

		for (let i = 0; i < numChanged!; i++) {
			let index = 0;
			if (i == 0) {
				// read absolute index
				index = serializeInt(stream, i, 0, settings.maxPhysicsObjects - 1);
			} else {
				// read relative index
				index = serializeRelativeIndex(stream, previousIndex, i);
			}

			// read relative state
			readRelativeState(stream, readState[index], baseState[index]);

			previousIndex = index;
		}
	} else {
		for (let i = 0; i < settings.maxPhysicsObjects; i++) {

			let changed = false;
			// read changed
			changed = serializeBool(stream, changed);

			if (changed) {
				// read relative state
				readRelativeState(stream, readState[i], baseState[i]);
			}
		}
	}

	return readState;
}
