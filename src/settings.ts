import { TOTAL_OBJECTS } from "./shared/sceneConfig";

export default {
	// Derived from the scene so network bit-widths track the real body count.
	maxPhysicsObjects: TOTAL_OBJECTS,
	positionBoundsInMeters: 5000,
	// 31-bit monotonic frame ids (~414 days at 60Hz before wrap) instead of the
	// old 16-bit field that wrapped every ~18 minutes and collided array indices.
	maxPackageId: 0x7fffffff,
	unitsPerMeter: 100,
	orientationBits: 9,

	// 40Hz physics (down from 60) widens the per-tick budget 16.7→25ms, which
	// drops step-spike budget overruns from ~52% to ~4% when a heavy ball scatters
	// the whole pile — the difference between a steady and a stuttering snapshot
	// rate. Snapshots stay at 20Hz (every 2nd physics frame).
	physicsHz: 40,
	snapshotHz: 20,
	snapshotHistory: 120,
	renderDelayMs: 120,
}
