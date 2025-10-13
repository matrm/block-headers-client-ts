import { sha256sha256 } from './utils/crypto.js';
import { assert } from './utils/util.js';

export const HEADER_BUFFER_LENGTH = 80;
const GENESIS_PREV_HASH_HEX = '0000000000000000000000000000000000000000000000000000000000000000';

function decodeTargetFromBitsBuffer(bitsBuffer: Buffer): bigint {
	const bits = bitsBuffer.readUInt32BE(0);// Read as a 32-bit unsigned integer.
	const exponent = (bits >>> 24) & 0xff;// Extract the first byte (exponent).
	const coefficient = bits & 0xffffff;// Extract the lower 3 bytes (coefficient).
	const target = BigInt(coefficient) * (BigInt(2) ** BigInt(8 * (exponent - 3)));
	return target;
}

function calculateWorkFromTarget(target: bigint): bigint {
	assert(target !== BigInt(0));
	const maxHash = BigInt(2) ** BigInt(256);
	return maxHash / target;
}

function verifyProofOfWork(hashHex: string, target: bigint): boolean {
	assert(!hashHex.startsWith('0x'));
	const hashValue: bigint = BigInt(`0x${hashHex}`);
	return hashValue <= target;
}

// Immutable interface with all properties.
// export interface BlockHeader {
// 	readonly buffer: Buffer;
// 	readonly prevHashHex: string;
// 	readonly hashHex: string;
// 	readonly merkleRootHex: string;
// 	readonly timestamp: number;
// 	readonly bitsBuffer: Buffer;
// 	readonly bitsHex: string;
// 	readonly nonce: number;
// 	readonly hashBuffer: Buffer;
// 	readonly work: bigint;
// 	readonly workHex: string;
// 	readonly workTotal: bigint;
// 	readonly workTotalHex: string;
// 	readonly height: number;
// }

// Immutable minimal interface with all number and string properties.
export type BlockHeader = {
	readonly prevHashHex: string;
	readonly merkleRootHex: string;
	readonly timestamp: number;
	readonly bitsHex: string;
	readonly nonce: number;
	readonly hashHex: string;
	readonly workHex: string;
	readonly workTotalHex: string;
	readonly height: number;
};

export class BlockHeaderMutable implements BlockHeader {
	public readonly buffer: Buffer;
	public readonly prevHashHex: string;
	public readonly hashHex: string;
	private _workTotal?: bigint;
	private _height?: number;

	private constructor(buffer: Buffer, skipProofOfWorkCheck: boolean = false) {
		if (buffer.length !== HEADER_BUFFER_LENGTH) {
			throw new Error(`Invalid buffer length used to construct BlockHeader: ${buffer.length}`);
		}

		this.buffer = buffer;
		this.prevHashHex = Buffer.from(buffer.subarray(4, 36)).reverse().toString('hex');
		this.hashHex = sha256sha256(buffer).reverse().toString('hex');

		if (!skipProofOfWorkCheck) {
			const target = decodeTargetFromBitsBuffer(this.bitsBuffer);
			if (!verifyProofOfWork(this.hashHex, target)) {
				throw new Error('Invalid proof of work');
			}
		}

		if (this.prevHashHex === GENESIS_PREV_HASH_HEX) {
			this.setHeight(0);
			this.setWorkTotal(this.work);
		}
	}

	static fromBuffer(buffer: Buffer, skipProofOfWorkCheck: boolean = false): BlockHeaderMutable {
		return new BlockHeaderMutable(Buffer.from(buffer), skipProofOfWorkCheck);
	}

	static fromHex(hex: string, skipProofOfWorkCheck: boolean = false): BlockHeaderMutable {
		return new BlockHeaderMutable(Buffer.from(hex, 'hex'), skipProofOfWorkCheck);
	}

	toMinimalObject(): BlockHeader {
		return {
			prevHashHex: this.prevHashHex,
			merkleRootHex: this.merkleRootHex,
			timestamp: this.timestamp,
			bitsHex: this.bitsHex,
			nonce: this.nonce,
			hashHex: this.hashHex,
			workHex: this.workHex,
			workTotalHex: this.workTotalHex,
			height: this.height,
		};
	}

	// get versionBuffer(): Buffer {
	// 	return Buffer.from(this.buffer.subarray(0, 4)).reverse();
	// }

	get merkleRootHex(): string {
		return Buffer.from(this.buffer.subarray(36, 68)).reverse().toString('hex');
	}

	get timestamp(): number {
		return this.buffer.readUInt32LE(68);
	}

	get bitsBuffer(): Buffer {
		return Buffer.from(this.buffer.subarray(72, 76)).reverse();
	}

	get bitsHex(): string {
		return this.bitsBuffer.toString('hex');
	}

	get nonce(): number {
		return this.buffer.readUInt32LE(76);
	}

	get hashBuffer(): Buffer {
		return Buffer.from(this.hashHex, 'hex');
	}

	get work(): bigint {
		const target = decodeTargetFromBitsBuffer(this.bitsBuffer);
		return calculateWorkFromTarget(target);
	}

	get workHex(): string {
		return this.work.toString(16);
	}

	setWorkTotal(workTotal: bigint): void {
		if (this._workTotal !== undefined && this._workTotal !== workTotal) {
			throw new Error(`workTotal (${workTotal}) has already been set to another value (${this._workTotal}) for block ${this.hashHex}`);
		}
		this._workTotal = workTotal;
	}

	get workTotal(): bigint {
		if (this._workTotal === undefined) {
			throw new Error('workTotal has not been calculated yet');
		}
		return this._workTotal;
	}

	get workTotalHex(): string {
		return this.workTotal.toString(16);
	}

	setHeight(height: number): void {
		if (this._height !== undefined && this._height !== height) {
			throw new Error(`height (${height}) has already been set to another value (${this._height}) for block ${this.hashHex}`);
		}
		this._height = height;
	}

	get height(): number {
		if (this._height === undefined) {
			throw new Error('height has not been calculated yet');
		}
		return this._height;
	}
}