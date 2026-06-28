export interface NetSimParams {
	latencyMs: number;
	jitterMs: number;
	lossPct: number;
	bandwidthKbps: number;
}

export const BANDWIDTH_STEPS: { label: string; kbps: number }[] = [
	{ label: "off", kbps: 0 },
	{ label: "56k", kbps: 56 },
	{ label: "128k", kbps: 128 },
	{ label: "256k", kbps: 256 },
	{ label: "512k", kbps: 512 },
	{ label: "1M", kbps: 1024 },
	{ label: "2M", kbps: 2048 },
	{ label: "5M", kbps: 5120 },
	{ label: "10M", kbps: 10240 },
	{ label: "25M", kbps: 25600 },
	{ label: "50M", kbps: 51200 },
	{ label: "100M", kbps: 102400 },
	{ label: "250M", kbps: 256000 },
	{ label: "500M", kbps: 512000 },
	{ label: "1G", kbps: 1048576 },
	{ label: "unlim", kbps: 0 },
	{ label: "unlim", kbps: 0 },
	{ label: "unlim", kbps: 0 },
	{ label: "unlim", kbps: 0 },
	{ label: "unlim", kbps: 0 },
	{ label: "unlim", kbps: 0 },
];

// Max queueing delay the simulated link buffer will hold before dropping — a
// realistic finite buffer. Bounds latency on a saturated link instead of letting
// it spiral.
const MAX_QUEUE_MS = 250;

export class DirectionalNetSim {
	private params: NetSimParams = { latencyMs: 0, jitterMs: 0, lossPct: 0, bandwidthKbps: 0 };
	private linkFreeAt = 0;
	public droppedPackets = 0;
	public deliveredPackets = 0;
	public deliveredBytes = 0;

	constructor(private deliver: (data: ArrayBuffer) => void) {}

	setParams(p: NetSimParams) { this.params = { ...p }; }

	enqueue(data: ArrayBuffer) {
		if (this.params.lossPct > 0 && Math.random() * 100 < this.params.lossPct) {
			this.droppedPackets++;
			return;
		}

		const now = performance.now();
		const jitter = this.params.jitterMs > 0 ? (Math.random() * 2 - 1) * this.params.jitterMs : 0;
		const latency = Math.max(0, this.params.latencyMs + jitter);

		let bandwidthDelay = 0;
		if (this.params.bandwidthKbps > 0) {
			const bytesPerMs = this.params.bandwidthKbps * 1024 / 8 / 1000;
			const serviceMs = data.byteLength / bytesPerMs;
			// Finite link buffer: if the queue is already this deep, drop instead of
			// queueing forever. Real links/routers drop when their buffer fills;
			// without this, a saturated link's latency grows without bound — the
			// "3G lags harder and harder" bufferbloat death spiral.
			const queueDelay = Math.max(0, this.linkFreeAt - now);
			if (queueDelay > MAX_QUEUE_MS) {
				this.droppedPackets++;
				return;
			}
			this.linkFreeAt = Math.max(this.linkFreeAt, now) + serviceMs;
			bandwidthDelay = Math.max(0, this.linkFreeAt - now);
		} else {
			this.linkFreeAt = now;
		}

		const totalDelay = latency + bandwidthDelay;

		const copy = data.slice(0);
		this.deliveredPackets++;
		this.deliveredBytes += data.byteLength;

		if (totalDelay <= 0.5) {
			this.deliver(copy);
		} else {
			setTimeout(() => this.deliver(copy), totalDelay);
		}
	}
}
