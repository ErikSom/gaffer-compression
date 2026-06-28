export const INPUT_TIMEOUT_MS = 250;

export function newestFrame(currentFrame: number | null, receivedFrame: number): number {
	if (currentFrame === null || receivedFrame > currentFrame) return receivedFrame;
	return currentFrame;
}

export function hasFreshInput(lastInputAt: number, now: number, timeoutMs = INPUT_TIMEOUT_MS): boolean {
	return lastInputAt > 0 && now - lastInputAt <= timeoutMs;
}

export function impulseScaleForHz(physicsHz: number): number {
	return 1 / Math.max(1, physicsHz);
}

export function isNewerInputSeq(currentSeq: number | null, receivedSeq: number): boolean {
	if (currentSeq === null) return true;
	const delta = (receivedSeq - currentSeq) & 0xffff;
	return delta !== 0 && delta < 0x8000;
}
