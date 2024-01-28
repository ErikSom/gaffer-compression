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

	if (networkCache.networkSnapshotFrame === frame) {
		return networkCache.networkSnaphot!;
	}

	const state = networkCache.networkStates[frame];

	const buffer = new ArrayBuffer(16 * 1024); // start with 16kb buffer 8 * 1024
	const bitView = new BitView(buffer);
	const rwBitStream = new BitStream(bitView) as RWBitStream;
	rwBitStream.isWriting = true;

	serializeInt(rwBitStream, frame, 0, settings.maxPackageId);

	writeFullNetworkSnapshot(rwBitStream, state);

	const trimmedBuffer = buffer.slice(0, Math.ceil(rwBitStream.index / 8));

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

export function getNetworkStateFromFullSnapshot(buffer: ArrayBuffer): NetworkBodyState[] {
	const bitView = new BitView(buffer);
	const rwBitStream = new BitStream(bitView) as RWBitStream;
	rwBitStream.isWriting = false;
	rwBitStream.isReading = true;
	rwBitStream.index = 0;

	serializeInt(rwBitStream, 0, 0, settings.maxPackageId);

	return readFullNetworkSnapshot(rwBitStream);
}

function readFullNetworkSnapshot(stream: RWBitStream): NetworkBodyState[] {
	const state = [] as NetworkBodyState[];

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
		const rotation = new Quaternion(qx, qy, qz, qw);

		state.push({ position, rotation });
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

	const buffer = new ArrayBuffer(8192); // start with 8kb buffer 8 * 1024
	const bitView = new BitView(buffer);
	const rwBitStream = new BitStream(bitView) as RWBitStream;
	rwBitStream.isWriting = true;

	serializeInt(rwBitStream, frame, 0, settings.maxPackageId);

	writeRelativeNetworkSnapshot(rwBitStream, state, baseState);

	const trimmedBuffer = buffer.slice(0, Math.ceil(rwBitStream.index / 8));

	if (!networkCache.relativeNetworkSnapshots[frame]) {
		networkCache.relativeNetworkSnapshots[frame] = [];
	}
	networkCache.relativeNetworkSnapshots[frame][baseFrame] = trimmedBuffer;

	return trimmedBuffer;
}

function isNetworkStateEqual(state: NetworkBodyState, baseState: NetworkBodyState) {
	return state.position.equals(baseState.position) && state.rotation.equals(baseState.rotation);
}

function isNetworkStatePositionEqual(state: NetworkBodyState, baseState: NetworkBodyState) {
	return state.position.equals(baseState.position);
}

function isNetworkStateRotationEqual(state: NetworkBodyState, baseState: NetworkBodyState) {
	return state.rotation.equals(baseState.rotation);
}

function writeRelativeState(stream: RWBitStream, state: NetworkBodyState, baseState: NetworkBodyState) {
	let positionChanged = !isNetworkStatePositionEqual(state, baseState);
	// write position changed
	positionChanged = serializeBool(stream, positionChanged);

	if (positionChanged) {
		const { x, y, z } = worldPositionToNetworkPosition(state.position);
		const { x: bx, y: by, z: bz } = worldPositionToNetworkPosition(baseState.position);
		// write relative position
		serializeRelativePosition(stream, x, y, z, bx, by, bz);
	}

	let rotationChanged = !isNetworkStateRotationEqual(state, baseState);
	// write rotation changed
	rotationChanged = serializeBool(stream, rotationChanged);

	if (rotationChanged) {
		const { x: qx, y: qy, z: qz, w: qw } = state.rotation;
		const { x: bx, y: by, z: bz, w: bw } = baseState.rotation;
		const stateOrientation = new CompressedQuaternion(settings.orientationBits);
		const originOrientation = new CompressedQuaternion(settings.orientationBits);
		stateOrientation.load(qx, qy, qz, qw);
		originOrientation.load(bx, by, bz, bw);
		// write relative rotation
		serializeRelativeOrientation(stream, stateOrientation, originOrientation);
	}
}

function writeRelativeNetworkSnapshot(stream: RWBitStream, state: NetworkBodyState[], baseState: NetworkBodyState[]) {
	let useIndices = false;
	let numChanged: number | undefined = undefined;

	const changedArray: boolean[] = [];

	numChanged = 0;
	for (let i = 0; i < state.length; i++) {
		const changed = !isNetworkStateEqual(state[i], baseState[i]);
		changedArray.push(changed);
		if (changed) {
			numChanged++;
		}
	}

	const relativeBitSize = countRelativeIdBits(changedArray);

	useIndices = relativeBitSize < settings.maxPhysicsObjects;
	// write use indices
	useIndices = serializeBool(stream, useIndices);

	if (useIndices) {

		// write num changed
		serializeInt(stream, numChanged, 0, settings.maxPhysicsObjects - 1);

		let first = true;
		let previousIndex = 0;
		for (let i = 0; i < state.length; i++) {
			const changed = !isNetworkStateEqual(state[i], baseState[i]);

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
				writeRelativeState(stream, state[i], baseState[i]);

				previousIndex = i;
			}
		}
	} else {
		for (let i = 0; i < settings.maxPhysicsObjects; i++) {
			let changed = !isNetworkStateEqual(state[i], baseState[i]);
			// write changed
			changed = serializeBool(stream, changed);

			if (changed) {
				// write relative state
				writeRelativeState(stream, state[i], baseState[i]);
			}
		}
	}
}

export function getNetworkStateFromRelativeSnapshot(buffer: ArrayBuffer, baseFrame: number): NetworkBodyState[] {
	const bitView = new BitView(buffer);
	const rwBitStream = new BitStream(bitView) as RWBitStream;
	rwBitStream.isWriting = false;
	rwBitStream.isReading = true;
	rwBitStream.index = 0;

	// read frame
	const frame = serializeInt(rwBitStream, 0, 0, settings.maxPackageId);

	const baseState = networkCache.networkStates[baseFrame];

	const state = baseState.map(object => {
		return { position: object.position.clone(), rotation: object.rotation.clone() };
	})

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
		state.position = networkPositionToWorldPosition(networkPosition);
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

