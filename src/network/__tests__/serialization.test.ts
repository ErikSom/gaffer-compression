import { BitStream, BitView } from "bit-buffer";
import { serializeBool, serializeInt, serializeRelativeIndex, serializeRelativeOrientation, serializeRelativePosition, serializeUnsignedRange } from "../serialization"
import { CompressedQuaternion } from "../compressedQuaternion";
import { RWBitStream } from "../networkInterfaces";
import settings from "../../settings";

// test bool serialization
test('bool serialization', () => {

	var buffer = new ArrayBuffer(1);
	var bitView = new BitView(buffer);
	var bitStream = new BitStream(bitView) as RWBitStream;

	bitStream.isWriting = true;
	bitStream.isReading = false;

	serializeBool(bitStream, true);

	expect(bitStream.index).toBe(1);

	bitStream.index = 0;

	bitStream.isWriting = false;
	bitStream.isReading = true;

	const result = serializeBool(bitStream, undefined);

	expect(result).toBe(true);
});

test('serialize integer', () => {
	const buffer = new ArrayBuffer(1);

	const bitView = new BitView(buffer);
	const bitStream = new BitStream(bitView) as RWBitStream;

	bitStream.isWriting = true;
	bitStream.isReading = false;

	serializeInt(bitStream, 3, 0, 10);

	expect(bitStream.index).toBe(4);

	bitStream.index = 0;

	bitStream.isWriting = false;
	bitStream.isReading = true;

	const result = serializeInt(bitStream, undefined, 0, 10);

	expect(result).toBe(3);
});

test('relative index serialization', () => {
	const max = 350;
	const indexes1 = [0, 1, 2, 3, 40, 42, 300, 312, 350];

	const buffer = new ArrayBuffer(10);

	const bitView = new BitView(buffer);
	const bitStream = new BitStream(bitView) as RWBitStream;

	bitStream.isWriting = true;
	bitStream.isReading = false;

	let previous = 0;
	let first = true;

	for (let i = 0; i < indexes1.length; i++) {
		if (first) {
			first = false;
			serializeInt(bitStream, i, 0, max);
			// 4 bits
			previous = i;
			continue;
		} else {
			const current = indexes1[i];
			// 8 bits
			serializeRelativeIndex(bitStream, previous, current);
			previous = current;
		}
	}

	bitStream.index = 0;

	bitStream.isWriting = false;
	bitStream.isReading = true;

	previous = 0;
	first = true;

	const indexes2: number[] = [];

	for (let i = 0; i < indexes1.length; i++) {
		if (first) {
			first = false;
			const result = serializeInt(bitStream, undefined, 0, max);
			previous = result;

			indexes2.push(result);
			continue;
		} else {
			const result = serializeRelativeIndex(bitStream, previous, undefined);
			previous = result;

			indexes2.push(result);
		}
	}

	expect(indexes1).toEqual(indexes2);
});


test('serialize unsigned range', () => {
	const rangeBits = [5, 6, 7];

	const testValues = [
		// Lower Edge Cases
		0,
		// Upper Edge Cases
		31, // Largest for the 5-bit range
		32, // Smallest for the 6-bit range
		63, // Largest for the 6-bit range
		64, // Smallest for the 7-bit range
		127, // Largest for the 7-bit range

		// Middle Cases
		15,  // Some value in the 5-bit range
		45,  // Some value in the 6-bit range
		100, // Some value in the 7-bit range

		// Random Cases
		1, 2, 4, 8, 16, 24, 48, 80, 96
	];

	for (const testValue of testValues) {

		const buffer = new ArrayBuffer(10);

		const bitView = new BitView(buffer);
		const bitStream = new BitStream(bitView) as RWBitStream;

		bitStream.isWriting = true;

		// Serialize the original value
		serializeUnsignedRange(bitStream, testValue, rangeBits.length, rangeBits);

		// Switch to reading mode
		bitStream.isWriting = false;
		bitStream.isReading = true;
		bitStream.index = 0;

		const deserializedValue = serializeUnsignedRange(bitStream, undefined, rangeBits.length, rangeBits);

		// Check if the deserialized value matches the original
		expect(deserializedValue).toBe(testValue);
	}
});

test('CompressedQuaternion compression and decompression', () => {
	// Test instantiation with invalid bits
	expect(() => new CompressedQuaternion(1)).toThrow('Bits must be in the range of 2 to 10');
	expect(() => new CompressedQuaternion(11)).toThrow('Bits must be in the range of 2 to 10');

	// Test instantiation with valid bits
	const bits = 5;
	const compressedQuaternion = new CompressedQuaternion(bits);
	expect(compressedQuaternion).toBeTruthy();

	const testQuaternions = [
		{ x: 0, y: 0, z: 0, w: 1 },								// Identity quaternion
		{ x: 1, y: 0, z: 0, w: 0 },								// 180° rotation around X axis
		{ x: 0, y: 1, z: 0, w: 0 },								// 180° rotation around Y axis
		{ x: 0, y: 0, z: 1, w: 0 },								// 180° rotation around Z axis
		{ x: Math.sqrt(0.5), y: 0, z: 0, w: Math.sqrt(0.5) },	// 90° rotation around X axis
		{ x: 0, y: Math.sqrt(0.5), z: 0, w: Math.sqrt(0.5) },	// 90° rotation around Y axis
		{ x: 0, y: 0, z: Math.sqrt(0.5), w: Math.sqrt(0.5) },	// 90° rotation around Z axis
		{ x: 0.5, y: 0.5, z: 0.5, w: 0.5 },						// Equal parts of all components
		{ x: 0.3, y: 0.4, z: 0.1, w: 0.86 },					// Random rotation
		{ x: 0.5, y: -0.5, z: 0.5, w: -0.5 },					// Negative components
		{ x: 0.3827, y: 0.9239, z: 0, w: 0 },					// 60° rotation around Z axis
		{ x: 0, y: 0, z: 0.9239, w: -0.3827 }					// 60° rotation around X axis
	];

	for (const testQuaternion of testQuaternions) {

		// Test compression and decompression
		compressedQuaternion.load(testQuaternion.x, testQuaternion.y, testQuaternion.z, testQuaternion.w);
		const decompressedQuaternion = compressedQuaternion.save();

		// Check if the decompressed values are close to the original values
		// ! signs can be flipped, e.g. { x: 0, y: -0.7071, z: 0.7071, w: 0 } becomes { x: 0, y: 0.7071, z: -0.7071, w: 0 },
		expect(Math.abs(decompressedQuaternion.x) - Math.abs(testQuaternion.x)).toBeLessThan(0.1);
		expect(Math.abs(decompressedQuaternion.y) - Math.abs(testQuaternion.y)).toBeLessThan(0.1);
		expect(Math.abs(decompressedQuaternion.z) - Math.abs(testQuaternion.z)).toBeLessThan(0.1);
		expect(Math.abs(decompressedQuaternion.w) - Math.abs(testQuaternion.w)).toBeLessThan(0.1);
	}
});

test('Relative position serialization and deserialization with actual vectors', () => {
	// Initialize your stream, current, and baseline positions
	const buffer = new ArrayBuffer(10);

	const bitView = new BitView(buffer);
	const stream = new BitStream(bitView) as RWBitStream;

	const baselinePositions = [
		{ x: 0, y: 0, z: 0 },                    // Origin
		{ x: 10, y: 10, z: 10 },                 // Mid Positive Values
		{ x: -10, y: -10, z: -10 },              // Mid Negative Values
		{ x: 1000, y: 1000, z: 1000 },           // Large Positive Values
		{ x: -1000, y: -1000, z: -1000 },        // Large Negative Values
		{ x: 5.5, y: 5.6, z: 5.7 },              // Non-Integer Positive Values
		{ x: -5.5, y: -5.6, z: -5.7 },           // Non-Integer Negative Values
		{ x: 20, y: 30, z: 40 },                 // Varied Components
		{ x: 0, y: 100, z: 0 },                  // One Dimension Dominates
		{ x: 100, y: 100, z: 100 },              // Moderate Positive Values
		{ x: -100, y: -100, z: -100 },           // Moderate Negative Values
		{ x: 0.1, y: 0.1, z: 0.1 },              // Small Values
		{ x: 5000, y: 5000, z: 5000 },           // Very Large Positive Values
		{ x: -5000, y: -5000, z: -5000 },        // Very Large Negative Values
	];

	const currentPositions = [
		{ x: 1, y: 1, z: 1 },                    // Close Neighbors
		{ x: 9, y: 9, z: 9 },                    // Slight Decrease
		{ x: -9, y: -9, z: -9 },                 // Slight Increase
		{ x: 999, y: 999, z: 999 },              // Close to Large Value
		{ x: -999, y: -999, z: -999 },           // Close to Large Negative Value
		{ x: 5.49, y: 5.59, z: 5.69 },           // Just Below Non-Integer Value
		{ x: -5.51, y: -5.61, z: -5.71 },        // Just Above Non-Integer Negative Value
		{ x: 19, y: 29, z: 39 },                 // Decrease Across All Components
		{ x: 0, y: 101, z: 0 },                  // Increase in One Dominant Dimension
		{ x: 1000, y: 1000, z: 1000 },           // Large Increase from Moderate
		{ x: -1000, y: -1000, z: -1000 },        // Large Decrease from Moderate
		{ x: 500, y: 500, z: 500 },              // Large Increase from Small
		{ x: 10000, y: 10000, z: 10000 },        // Massive Increase from Very Large
		{ x: -10000, y: -10000, z: -10000 },     // Massive Decrease from Very Large
	];

	for (let i = 0; i < baselinePositions.length; i++) {
		// clear stream
		stream.isWriting = true;
		stream.isReading = false;
		stream.index = 0;

		const baselinePosition = baselinePositions[i];
		const currentPosition = currentPositions[i];

		// Serialize the current position relative to the baseline
		const serializedPosition = serializeRelativePosition(
			stream,
			currentPosition.x, currentPosition.y, currentPosition.z,
			baselinePosition.x, baselinePosition.y, baselinePosition.z
		);

		stream.index = 0;
		stream.isWriting = false;
		stream.isReading = true;

		// Deserialize the position relative to the baseline
		const deserialized = serializeRelativePosition(
			stream,
			serializedPosition.x, serializedPosition.y, serializedPosition.z,
			baselinePosition.x, baselinePosition.y, baselinePosition.z
		);

		// Check if the deserialized position values match the original current position values (or very close due to possible floating point precision issues)
		const maxDifference = 1.001; //
		expect(Math.abs(deserialized.x) - Math.abs(currentPosition.x)).toBeLessThan(maxDifference);
		expect(Math.abs(deserialized.y) - Math.abs(currentPosition.y)).toBeLessThan(maxDifference);
		expect(Math.abs(deserialized.z) - Math.abs(currentPosition.z)).toBeLessThan(maxDifference);
	};
});

test('Relative orientation serialization and deserialization with actual quaternions', () => {
	// Initialize your stream, current, and baseline quaternion
	const buffer = new ArrayBuffer(10);

	const bitView = new BitView(buffer);
	const stream = new BitStream(bitView) as RWBitStream;

	const current = new CompressedQuaternion(settings.orientationBits);
	const baseline = new CompressedQuaternion(settings.orientationBits);

	const baselineQuaternions = [
		{ x: 0, y: 0, z: 0, w: 1 },                    			// Small Variations
		{ x: 0.70710678118, y: 0.70710678118, z: 0, w: 0 },     // Inverted Components
		{ x: 0, y: 0, z: 0, w: 1 },                    			// Large Variations
		{ x: 0, y: 1, z: 0, w: 0 },                    			// Small Magnitude
	];

	const currentQuaternions = [
		{ x: 0.005, y: 0, z: 0, w: 0.9999848014 },     			// Small Variations
		{ x: -0.70710678118, y: -0.70710678118, z: 0, w: 0 }, 	// Inverted Components
		{ x: 0.70710678118, y: 0.70710678118, z: 0, w: 0 },  	// Large Variations
		{ x: 0, y: 0.999, z: 0, w: 0.001 },        				// Small Magnitude
	];

	for (let i = 0; i < baselineQuaternions.length; i++) {
		// clear stream
		stream.isWriting = true;
		stream.isReading = false;
		stream.index = 0;

		const baselineQuaternion = baselineQuaternions[i];
		const currentQuaternion = currentQuaternions[i];

		// Load the quaternion values into the compressed format
		baseline.load(baselineQuaternion.x, baselineQuaternion.y, baselineQuaternion.z, baselineQuaternion.w);
		current.load(currentQuaternion.x, currentQuaternion.y, currentQuaternion.z, currentQuaternion.w);

		// Serialize the current orientation relative to the baseline
		serializeRelativeOrientation(stream, current, baseline);

		stream.index = 0;
		stream.isWriting = false;
		stream.isReading = true;

		// Reset stream position or create a new stream for reading
		const deserialized = new CompressedQuaternion(settings.orientationBits);
		serializeRelativeOrientation(stream, deserialized, baseline);

		// Save the deserialized compressed quaternion back to quaternion format
		const deserializedQuaternion = deserialized.save();

		// Check if the deserialized quaternion values match the original current quaternion values (or very close due to possible floating point precision issues)
		expect(Math.abs(deserializedQuaternion.x)).toBeCloseTo(Math.abs(currentQuaternion.x), 1);
		expect(Math.abs(deserializedQuaternion.y)).toBeCloseTo(Math.abs(currentQuaternion.y), 1);
		expect(Math.abs(deserializedQuaternion.z)).toBeCloseTo(Math.abs(currentQuaternion.z), 1);
		expect(Math.abs(deserializedQuaternion.w)).toBeCloseTo(Math.abs(currentQuaternion.w), 1);
	};
});
