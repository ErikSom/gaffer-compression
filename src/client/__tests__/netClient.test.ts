import { Quaternion, Vector3 } from "three";
import { NetClient } from "../netClient";
import { decodePacket, MsgType, packFullSnapshot } from "../../shared/protocol";
import { networkCache, resetNetworkCache } from "../../network/networkState";
import type { NetworkBodyState } from "../../network/networkInterfaces";
import settings from "../../settings";
import { PLAYER_BASE_INDEX } from "../../shared/sceneConfig";

function oneBodyState(x: number): NetworkBodyState[] {
	return [{ position: new Vector3(x, 0, 0), rotation: new Quaternion(0, 0, 0, 1) }];
}

function fullSnapshot(frame: number, x: number, lastProcessedInputSeq = 0): ArrayBuffer {
	resetNetworkCache();
	networkCache.networkStates[frame] = oneBodyState(x);
	const packet = packFullSnapshot(frame, lastProcessedInputSeq);
	resetNetworkCache();
	return packet;
}

function stateWithBoxAndPlayer(boxX: number, playerX: number): NetworkBodyState[] {
	const state: NetworkBodyState[] = [];
	for (let i = 0; i <= PLAYER_BASE_INDEX; i++) {
		state.push({ position: new Vector3(boxX, 0, 0), rotation: new Quaternion(0, 0, 0, 1) });
	}
	state[PLAYER_BASE_INDEX].position.x = playerX;
	return state;
}

test("client ACKs never move backward when snapshots arrive out of order", () => {
	const newer = fullSnapshot(10, 10);
	const older = fullSnapshot(8, 8);
	const client = new NetClient() as any;
	const ackedFrames: number[] = [];

	client.send = (buffer: ArrayBuffer) => {
		const msg = decodePacket(buffer);
		if (msg && msg.type === MsgType.Ack) ackedFrames.push(msg.frame);
	};

	client.handlePacket(newer);
	client.handlePacket(older);

	expect(ackedFrames).toEqual([10, 10]);
	expect(client.lastSnapshotFrame).toBe(10);
	expect(client.highestDecodedFrame).toBe(10);
});

test("client snapshot decode prunes old cache frames", () => {
	const frame = settings.snapshotHistory + 10;
	const packet = fullSnapshot(frame, 1);
	const client = new NetClient() as any;

	networkCache.networkStates[1] = oneBodyState(-1);
	networkCache.relativeNetworkSnapshots[1] = [];
	client.send = () => undefined;

	client.handlePacket(packet);

	expect(networkCache.networkStates[1]).toBeUndefined();
	expect(networkCache.relativeNetworkSnapshots[1]).toBeUndefined();
	expect(networkCache.networkStates[frame]).toBeDefined();
});

test("client stores the server-echoed processed input sequence", () => {
	const packet = fullSnapshot(10, 1, 42);
	const client = new NetClient() as any;
	client.send = () => undefined;

	client.handlePacket(packet);

	expect(client.lastProcessedInputSeq).toBe(42);
	expect(client.getStats().lastProcessedInputSeq).toBe(42);
});

test("client briefly extrapolates players but clamps boxes when snapshots are starved", () => {
	const nowSpy = jest.spyOn(performance, "now");
	nowSpy.mockReturnValue(0);

	const client = new NetClient() as any;
	client.physicsDt = 50;
	client.baseDelayFrames = 2;
	client.delayFrames = 2;
	client.snapshotBuffer = [
		{ frame: 0, state: stateWithBoxAndPlayer(0, 0) },
		{ frame: 2, state: stateWithBoxAndPlayer(2, 2) },
	];

	const initial = client.getInterpolatedState();
	expect(initial[0].position.x).toBeCloseTo(0);
	expect(initial[PLAYER_BASE_INDEX].position.x).toBeCloseTo(0);

	nowSpy.mockReturnValue(200);
	const starved = client.getInterpolatedState();
	const box = starved[0].position.x;
	const player = starved[PLAYER_BASE_INDEX].position.x;

	expect(box).toBeCloseTo(2);
	expect(player).toBeGreaterThan(2);
	expect(player).toBeLessThanOrEqual(5);

	nowSpy.mockRestore();
});

test("an out-of-order older snapshot does not rewind the echoed input seq", () => {
	const newer = fullSnapshot(10, 10, 42);
	const older = fullSnapshot(8, 8, 7);
	const client = new NetClient() as any;
	client.send = () => undefined;

	client.handlePacket(newer);
	client.handlePacket(older);

	expect(client.highestDecodedFrame).toBe(10);
	expect(client.lastProcessedInputSeq).toBe(42); // not rewound to the older 7
});

test("pooled decode stays correct after the state pool wraps", () => {
	const client = new NetClient() as any;
	client.send = () => undefined;

	// Decode well past STATE_POOL_SIZE so slots are recycled.
	for (let f = 0; f < 130; f++) {
		client.handlePacket(fullSnapshot(f, f)); // position.x encodes the frame
	}

	// Every still-buffered snapshot must hold its own frame's data — i.e. a
	// recycled pool slot never clobbered a state still referenced by the buffer.
	expect(client.snapshotBuffer.length).toBeGreaterThan(0);
	for (const snap of client.snapshotBuffer) {
		expect(snap.state[0].position.x).toBeCloseTo(snap.frame, 1);
	}
});

test("the owned ball is rendered ahead of the delayed world", () => {
	const nowSpy = jest.spyOn(performance, "now").mockReturnValue(100);
	const client = new NetClient() as any;
	client.playerBaseIndex = PLAYER_BASE_INDEX; // welcomed as slot 0
	client.physicsDt = 50;
	client.baseDelayFrames = 2;
	client.delayFrames = 2;
	client.lastSnapshotArrivalAt = 50; // now(100) − 50 = 50ms since the freshest snapshot
	client.snapshotBuffer = [
		{ frame: 0, state: stateWithBoxAndPlayer(0, 0) },
		{ frame: 2, state: stateWithBoxAndPlayer(2, 2) },
	];

	const out = client.getInterpolatedState();
	// The world (a box) renders at the delayed frame 0; the owned ball is led
	// forward toward real time, past the newest snapshot's position.
	expect(out[0].position.x).toBeCloseTo(0);
	expect(out[PLAYER_BASE_INDEX].position.x).toBeGreaterThan(2);

	nowSpy.mockRestore();
});
