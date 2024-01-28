export class CompressedQuaternion {
	public largest: number;
	public integerA: number;
	public integerB: number;
	public integerC: number;

	private maxValue: number;

	private minimum: number = -1.0 / 1.414214; // 1.0 / sqrt(2)
	private maximum: number = 1.0 / 1.414214;

	constructor(bits) {
		if (bits <= 1 || bits > 10) {
			throw new Error('Bits must be in the range of 2 to 10');
		}

		this.maxValue = (1 << bits) - 1;

		this.largest = 0;
		this.integerA = 0;
		this.integerB = 0;
		this.integerC = 0;
	}

	load(x, y, z, w) {
		const scale = this.maxValue;

		const abs_x = Math.abs(x);
		const abs_y = Math.abs(y);
		const abs_z = Math.abs(z);
		const abs_w = Math.abs(w);

		this.largest = 0;
		let largest_value = abs_x;

		if (abs_y > largest_value) {
			this.largest = 1;
			largest_value = abs_y;
		}

		if (abs_z > largest_value) {
			this.largest = 2;
			largest_value = abs_z;
		}

		if (abs_w > largest_value) {
			this.largest = 3;
			largest_value = abs_w;
		}

		let a = 0, b = 0, c = 0;

		switch (this.largest) {
			case 0:
				a = x >= 0 ? y : -y;
				b = x >= 0 ? z : -z;
				c = x >= 0 ? w : -w;
				break;
			case 1:
				a = y >= 0 ? x : -x;
				b = y >= 0 ? z : -z;
				c = y >= 0 ? w : -w;
				break;
			case 2:
				a = z >= 0 ? x : -x;
				b = z >= 0 ? y : -y;
				c = z >= 0 ? w : -w;
				break;
			case 3:
				a = w >= 0 ? x : -x;
				b = w >= 0 ? y : -y;
				c = w >= 0 ? z : -z;
				break;
			default:
				throw new Error('Unexpected largest value index');
		}

		this.integerA = Math.floor((a - this.minimum) / (this.maximum - this.minimum) * scale + 0.5);
		this.integerB = Math.floor((b - this.minimum) / (this.maximum - this.minimum) * scale + 0.5);
		this.integerC = Math.floor((c - this.minimum) / (this.maximum - this.minimum) * scale + 0.5);
	}

	save() {
		const inverse_scale = 1.0 / this.maxValue;

		const a = this.integerA * inverse_scale * (this.maximum - this.minimum) + this.minimum;
		const b = this.integerB * inverse_scale * (this.maximum - this.minimum) + this.minimum;
		const c = this.integerC * inverse_scale * (this.maximum - this.minimum) + this.minimum;

		let x = 0, y = 0, z = 0, w = 0;
		switch (this.largest) {
			case 0:
				x = Math.sqrt(1 - a * a - b * b - c * c);
				y = a;
				z = b;
				w = c;
				break;
			case 1:
				x = a;
				y = Math.sqrt(1 - a * a - b * b - c * c);
				z = b;
				w = c;
				break;
			case 2:
				x = a;
				y = b;
				z = Math.sqrt(1 - a * a - b * b - c * c);
				w = c;
				break;
			case 3:
				x = a;
				y = b;
				z = c;
				w = Math.sqrt(1 - a * a - b * b - c * c);
				break;
			default:
				throw new Error('Unexpected largest value index');
		}

		return { x, y, z, w };
	}
}
