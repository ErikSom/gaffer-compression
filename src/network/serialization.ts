import { Vector3 } from "three";
import settings from "../settings";
import { CompressedQuaternion } from "./compressedQuaternion";
import { RWBitStream } from "./networkInterfaces";

const maxPositionInUnits = settings.positionBoundsInMeters * settings.unitsPerMeter;

export function countRelativeIdBits(changed: boolean[]): number {
	let bits = 0;
	let first = true;
	let previousIndex = 0;

	for (let i = 0; i < changed.length; i++) {
		const didChange = changed[i];
		if (!didChange)
			continue;

		if (first) {
			bits += 10;
			first = false;
			previousIndex = i;
		}
		else {
			const difference: number = i - previousIndex;

			if (difference == 1) {
				bits += 1;
			}
			else if (difference <= 6) {
				bits += 1 + 1 + 2;
			}
			else if (difference <= 14) {
				bits += 1 + 1 + 1 + 3;
			}
			else if (difference <= 30) {
				bits += 1 + 1 + 1 + 1 + 4;
			}
			else if (difference <= 62) {
				bits += 1 + 1 + 1 + 1 + 1 + 5;
			}
			else if (difference <= 126) {
				bits += 1 + 1 + 1 + 1 + 1 + 1 + 6;
			}
			else {
				bits += 1 + 1 + 1 + 1 + 1 + 1 + 1 + 10;
			}

			previousIndex = i;
		}
	}

	return bits;
}

export function serializeRelativeIndex(stream: RWBitStream, previous: number, current: number | undefined): number {
	let difference: number | undefined;
	let plusOne;

	if (stream.isWriting) {
		difference = current! - previous;
		plusOne = difference === 1;
	}

	// use 1 bit
	plusOne = serializeBool(stream, plusOne);
	if (plusOne) {
		return previous + 1;
	}

	const ranges = [
		{ max: 6, bits: 2, offset: 0 },
		{ max: 14, bits: 3, offset: 7 },
		{ max: 30, bits: 4, offset: 15 },
		{ max: 62, bits: 5, offset: 31 },
		{ max: 126, bits: 6, offset: 63 },
	];

	// progressively use more bits
	for (const range of ranges) {
		let useBits = stream.isWriting ? difference! <= range.max : undefined;
		useBits = serializeBool(stream, useBits);
		if (useBits) {
			difference = serializeInt(stream, difference, range.offset, range.max);
			if (stream.isReading) {
				return previous + difference!;
			}
			return current!;
		}
	}

	// use 10 bits
	difference = serializeInt(stream, difference, 127, settings.maxPhysicsObjects - 1);
	if (stream.isReading) {
		return previous + difference!;
	}

	return 0;
}

export function serializeRelativePosition(stream: RWBitStream, x: number, y: number, z: number, baselineX: number, baselineY: number, baselineZ: number): Vector3 {
	let allSmall: boolean | undefined;
	let tooLarge: boolean | undefined;
	let dx: number | undefined;
	let dy: number | undefined;
	let dz: number | undefined;

	const rangeBits = [5, 6, 7];
	const numRanges = rangeBits.length;

	const smallLimit = 15;
	const largeLimit = unsignedRangeLimit(numRanges, rangeBits);

	const maxDelta = maxPositionInUnits;

	if (stream.isWriting) {
		dx = signedToUnsigned(x - baselineX);
		dy = signedToUnsigned(y - baselineY);
		dz = signedToUnsigned(z - baselineZ);
		allSmall = dx <= smallLimit && dy <= smallLimit && dz <= smallLimit;
		tooLarge = dx >= largeLimit || dy >= largeLimit || dz >= largeLimit;
	}

	allSmall = serializeBool(stream, allSmall);

	if (allSmall) {
		dx = serializeInt(stream, dx, 0, smallLimit);
		dy = serializeInt(stream, dy, 0, smallLimit);
		dz = serializeInt(stream, dz, 0, smallLimit);
	} else {
		tooLarge = serializeBool(stream, tooLarge);

		if (!tooLarge) {
			dx = serializeUnsignedRange(stream, dx, numRanges, rangeBits);
			dy = serializeUnsignedRange(stream, dy, numRanges, rangeBits);
			dz = serializeUnsignedRange(stream, dz, numRanges, rangeBits);
		} else {

			dx = serializeInt(stream, dx, 0, maxDelta);
			dy = serializeInt(stream, dy, 0, maxDelta);
			dz = serializeInt(stream, dz, 0, maxDelta);
		}
	}

	const v = new Vector3(x, y, z);

	if (stream.isReading) {
		const signedDx = unsignedToSigned(dx);
		const signedDy = unsignedToSigned(dy);
		const signedDz = unsignedToSigned(dz);

		v.x = baselineX + signedDx;
		v.y = baselineY + signedDy;
		v.z = baselineZ + signedDz;
	}

	return v;
}

export function serializeRelativeOrientation(stream: RWBitStream, current: CompressedQuaternion, baseline: CompressedQuaternion) {
	const rangeBits = [4, 5, 7];
	const numRanges = rangeBits.length;

	const smallLimit = 3;
	const largeLimit = unsignedRangeLimit(numRanges, rangeBits);

	let allSmall: boolean | undefined;
	let relativeOrientation: boolean | undefined;
	let da: number | undefined, db: number | undefined, dc: number | undefined;

	if (stream.isWriting && current.largest == baseline.largest) {
		da = signedToUnsigned(current.integerA - baseline.integerA);
		db = signedToUnsigned(current.integerB - baseline.integerB);
		dc = signedToUnsigned(current.integerC - baseline.integerC);

		allSmall = da <= smallLimit && db <= smallLimit && dc <= smallLimit;

		relativeOrientation = da < largeLimit && db < largeLimit && dc < largeLimit;
	}

	relativeOrientation = serializeBool(stream, relativeOrientation);

	if (relativeOrientation) {
		allSmall = serializeBool(stream, allSmall);

		if (allSmall) {
			da = serializeInt(stream, da, 0, smallLimit);
			db = serializeInt(stream, db, 0, smallLimit);
			dc = serializeInt(stream, dc, 0, smallLimit);
		} else {
			da = serializeUnsignedRange(stream, da, numRanges, rangeBits);
			db = serializeUnsignedRange(stream, db, numRanges, rangeBits);
			dc = serializeUnsignedRange(stream, dc, numRanges, rangeBits);
		}

		if (stream.isReading) {
			const signedDa = unsignedToSigned(da);
			const signedDb = unsignedToSigned(db);
			const signedDc = unsignedToSigned(dc);

			current.largest = baseline.largest;
			current.integerA = baseline.integerA + signedDa;
			current.integerB = baseline.integerB + signedDb;
			current.integerC = baseline.integerC + signedDc;
		}
	} else {
		current.largest = serializeBits(stream, current.largest, 2);
		current.integerA = serializeBits(stream, current.integerA, settings.orientationBits);
		current.integerB = serializeBits(stream, current.integerB, settings.orientationBits);
		current.integerC = serializeBits(stream, current.integerC, settings.orientationBits);
	}
}


function bitsRequired(min: number, max: number): number {
	const range = max - min;
	return 32 - Math.clz32(range);
}


export function serializeInt(stream: RWBitStream, value: number | undefined, min, max): number {
	if (min >= max) throw new Error('min should be less than max');

	if (stream.isWriting) {
		// Ensure value is within range
		if (value! < min || value! > max) throw new Error(`value out of range ${value} ${min} ${max}`);
		const bits = bitsRequired(min, max);
		const unsignedValue = value! - min;
		stream.writeBits(unsignedValue, bits);

		return value!;
	}

	if (stream.isReading) {
		const bits = bitsRequired(min, max);
		return stream.readBits(bits) + min;
	}

	return 0;
}


export function serializeBits(stream: RWBitStream, value: number | undefined, bits: number): number {
	if (bits <= 0 || bits > 32) throw new Error('bits out of range');

	if (stream.isWriting) {
		stream.writeBits(value!, bits);
		return value!;
	}

	if (stream.isReading) {
		return stream.readBits(bits);
	}

	return 0;
}

export function serializeBool(stream: RWBitStream, value: boolean | undefined): boolean {
	const bit = value === undefined ? undefined : value ? 1 : 0;
	return !!serializeBits(stream, bit, 1);
}

function unsignedRangeLimit(numRanges, rangeBits) {
	let rangeLimit = 0;
	for (let i = 0; i < numRanges; ++i) {
		rangeLimit += (1 << rangeBits[i]);
	}
	return rangeLimit;
}

function signedToUnsigned(n) {
	return (n << 1) ^ (n >> 31);
}

function unsignedToSigned(n) {
	return (n >>> 1) ^ (-(n & 1));
}

export function serializeUnsignedRange(stream: RWBitStream, value: number | undefined, numRanges: number, rangeBits: number[]): number {
	let rangeMin = 0;

	for (let i = 0; i < numRanges - 1; ++i) {
		const rangeMax = rangeMin + ((1 << rangeBits[i]) - 1);
		let inRange = stream.isWriting && value! <= rangeMax;
		inRange = serializeBool(stream, inRange);

		if (inRange) {
			value = serializeInt(stream, value, rangeMin, rangeMax);
			return value;
		}

		rangeMin += (1 << rangeBits[i]);
	}

	value = serializeInt(stream, value, rangeMin, rangeMin + ((1 << rangeBits[numRanges - 1]) - 1));
	return value;
}
