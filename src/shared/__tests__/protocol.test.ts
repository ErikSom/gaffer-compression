import { Quaternion, Vector3 } from "three";
import { decodePacket, MsgType, packDeltaSnapshot, packFullSnapshot } from "../protocol";
import { networkCache, resetNetworkCache } from "../../network/networkState";
import type { NetworkBodyState } from "../../network/networkInterfaces";

function stateAt(x: number): NetworkBodyState[] {
	return [{ position: new Vector3(x, 0, 0), rotation: new Quaternion(0, 0, 0, 1) }];
}

test("full snapshots echo the last processed input sequence", () => {
	resetNetworkCache();
	networkCache.networkStates[5] = stateAt(5);
	const packet = packFullSnapshot(5, 123);

	resetNetworkCache();
	const msg = decodePacket(packet);

	expect(msg).not.toBeNull();
	expect(msg!.type).toBe(MsgType.FullSnapshot);
	if (msg && msg.type === MsgType.FullSnapshot) {
		expect(msg.frame).toBe(5);
		expect(msg.lastProcessedInputSeq).toBe(123);
		expect(msg.state[0].position.x).toBeCloseTo(5);
	}
});

test("delta snapshots echo input sequence without shifting the base-frame header", () => {
	const base = stateAt(0);
	const next = stateAt(1);

	resetNetworkCache();
	networkCache.networkStates[2] = base;
	networkCache.networkStates[4] = next;
	const packet = packDeltaSnapshot(4, 2, 456);

	resetNetworkCache();
	networkCache.networkStates[2] = base;
	const msg = decodePacket(packet);

	expect(msg).not.toBeNull();
	expect(msg!.type).toBe(MsgType.DeltaSnapshot);
	if (msg && msg.type === MsgType.DeltaSnapshot) {
		expect(msg.frame).toBe(4);
		expect(msg.baseFrame).toBe(2);
		expect(msg.lastProcessedInputSeq).toBe(456);
		expect(msg.state[0].position.x).toBeCloseTo(1);
	}
});
