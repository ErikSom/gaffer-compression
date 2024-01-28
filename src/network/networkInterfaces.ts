import { BitStream } from "bit-buffer";
import { Quaternion, Vector3 } from "three";

export interface RWBitStream extends BitStream {
	isWriting: boolean | undefined;
	isReading: boolean | undefined;
}
export interface Player {
	id: number;
	peerId: string;
	receivedFrame: number | undefined;
}

export interface NetworkBodyState {
	position: Vector3;
	rotation: Quaternion;
}
