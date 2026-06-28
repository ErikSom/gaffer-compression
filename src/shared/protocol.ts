import { BitStream, BitView } from "bit-buffer";
import type { RWBitStream } from "../network/networkInterfaces";
import {
	collectFullSnapshot,
	getNetworkStateFromFullSnapshot,
	getNetworkStateFromRelativeSnapshot,
	collectRelativeSnapshot,
	networkCache,
} from "../network/networkState";
import type { NetworkBodyState } from "../network/networkInterfaces";

export enum MsgType {
	Hello = 0,
	Welcome = 1,
	FullSnapshot = 2,
	DeltaSnapshot = 3,
	Ack = 4,
	Input = 5,
	Config = 6,      // server → client: active physics/snapshot rate
	SetHz = 7,       // client → server: requested physics rate
	ResetBoxes = 8,  // client → server: reset all boxes to their starting piles
}

export interface HelloMsg { type: MsgType.Hello; }
export interface WelcomeMsg { type: MsgType.Welcome; playerId: number; objectCount: number; playerBaseIndex: number; }
export interface AckMsg { type: MsgType.Ack; frame: number; }
export interface InputMsg { type: MsgType.Input; seq: number; move: { x: number; y: number; z: number }; }

// Header layout (little-endian): u8 type, u32 frame, [u32 baseFrame for deltas].
// 32-bit frames match the 31-bit monotonic frame ids and never wrap in practice.
const FULL_HEADER_BYTES = 5;
const DELTA_HEADER_BYTES = 9;

export function packFullSnapshot(frame: number): ArrayBuffer {
	const payload = collectFullSnapshot(frame);
	return prependHeader(MsgType.FullSnapshot, frame, 0, payload);
}

export function packDeltaSnapshot(frame: number, baseFrame: number): ArrayBuffer {
	const payload = collectRelativeSnapshot(frame, baseFrame);
	return prependHeader(MsgType.DeltaSnapshot, frame, baseFrame, payload);
}

function prependHeader(type: MsgType, frame: number, baseFrame: number, payload: ArrayBuffer): ArrayBuffer {
	const hasBase = type === MsgType.DeltaSnapshot;
	const headerBytes = hasBase ? DELTA_HEADER_BYTES : FULL_HEADER_BYTES;
	const out = new ArrayBuffer(headerBytes + payload.byteLength);
	const view = new DataView(out);
	view.setUint8(0, type);
	view.setUint32(1, frame, true);
	if (hasBase) view.setUint32(5, baseFrame, true);

	const payloadView = new Uint8Array(payload);
	new Uint8Array(out, headerBytes).set(payloadView);
	return out;
}

export interface DecodedSnapshot {
	type: MsgType.FullSnapshot | MsgType.DeltaSnapshot;
	frame: number;
	baseFrame: number;
	state: NetworkBodyState[];
}

export function decodePacket(buffer: ArrayBuffer): DecodedSnapshot | { type: MsgType.Ack; frame: number } | { type: MsgType.Input; seq: number; move: { x: number; y: number; z: number } } | { type: MsgType.SetHz; physicsHz: number } | { type: MsgType.ResetBoxes } | null {
	const view = new DataView(buffer);
	const type = view.getUint8(0) as MsgType;

	if (type === MsgType.FullSnapshot) {
		const frame = view.getUint32(1, true);
		const payload = buffer.slice(FULL_HEADER_BYTES);
		const state = getNetworkStateFromFullSnapshot(payload);
		networkCache.networkStates[frame] = state;
		return { type, frame, baseFrame: 0, state };
	}

	if (type === MsgType.DeltaSnapshot) {
		const frame = view.getUint32(1, true);
		const baseFrame = view.getUint32(5, true);
		if (!networkCache.networkStates[baseFrame]) return null;
		const payload = buffer.slice(DELTA_HEADER_BYTES);
		const state = getNetworkStateFromRelativeSnapshot(payload, baseFrame);
		return { type, frame, baseFrame, state };
	}

	if (type === MsgType.Ack) {
		return { type, frame: view.getUint32(1, true) };
	}

	if (type === MsgType.Input) {
		const seq = view.getUint16(1, true);
		const mx = view.getInt8(3) / 127;
		const my = view.getInt8(4) / 127;
		const mz = view.getInt8(5) / 127;
		return { type, seq, move: { x: mx, y: my, z: mz } };
	}

	if (type === MsgType.SetHz) {
		return { type, physicsHz: view.getUint8(1) };
	}

	if (type === MsgType.ResetBoxes) {
		return { type };
	}

	return null;
}

export function encodeAck(frame: number): ArrayBuffer {
	const buf = new ArrayBuffer(5);
	const v = new DataView(buf);
	v.setUint8(0, MsgType.Ack);
	v.setUint32(1, frame, true);
	return buf;
}

export function encodeInput(seq: number, move: { x: number; y: number; z: number }): ArrayBuffer {
	const buf = new ArrayBuffer(6);
	const v = new DataView(buf);
	v.setUint8(0, MsgType.Input);
	v.setUint16(1, seq, true);
	v.setInt8(3, Math.round(clamp(move.x, -1, 1) * 127));
	v.setInt8(4, Math.round(clamp(move.y, -1, 1) * 127));
	v.setInt8(5, Math.round(clamp(move.z, -1, 1) * 127));
	return buf;
}

export function encodeWelcome(playerId: number, objectCount: number, playerBaseIndex: number): ArrayBuffer {
	const buf = new ArrayBuffer(7);
	const v = new DataView(buf);
	v.setUint8(0, MsgType.Welcome);
	v.setUint16(1, playerId, true);
	v.setUint16(3, objectCount, true);
	v.setUint16(5, playerBaseIndex, true);
	return buf;
}

export function decodeWelcome(buffer: ArrayBuffer): WelcomeMsg | null {
	const v = new DataView(buffer);
	if (v.getUint8(0) !== MsgType.Welcome) return null;
	return {
		type: MsgType.Welcome,
		playerId: v.getUint16(1, true),
		objectCount: v.getUint16(3, true),
		playerBaseIndex: v.getUint16(5, true),
	};
}

export function encodeConfig(physicsHz: number, snapshotHz: number): ArrayBuffer {
	const buf = new ArrayBuffer(3);
	const v = new DataView(buf);
	v.setUint8(0, MsgType.Config);
	v.setUint8(1, physicsHz);
	v.setUint8(2, snapshotHz);
	return buf;
}

export function decodeConfig(buffer: ArrayBuffer): { physicsHz: number; snapshotHz: number } | null {
	const v = new DataView(buffer);
	if (v.getUint8(0) !== MsgType.Config) return null;
	return { physicsHz: v.getUint8(1), snapshotHz: v.getUint8(2) };
}

export function encodeSetHz(physicsHz: number): ArrayBuffer {
	const buf = new ArrayBuffer(2);
	const v = new DataView(buf);
	v.setUint8(0, MsgType.SetHz);
	v.setUint8(1, physicsHz);
	return buf;
}

export function encodeResetBoxes(): ArrayBuffer {
	const buf = new ArrayBuffer(1);
	new DataView(buf).setUint8(0, MsgType.ResetBoxes);
	return buf;
}

export function peekType(buffer: ArrayBuffer): MsgType {
	return new DataView(buffer).getUint8(0) as MsgType;
}

function clamp(n: number, lo: number, hi: number): number {
	return n < lo ? lo : n > hi ? hi : n;
}
