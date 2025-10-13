import { expect, test, describe } from 'vitest';
import { BlockHeaderMutable } from '../src/BlockHeader.js';

const GENESIS_HEADER_HEX = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const GENESIS_HASH_HEX = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const GENESIS_MERKLE_ROOT_HEX = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
const GENESIS_PREV_HASH_HEX = '0000000000000000000000000000000000000000000000000000000000000000';

describe('BlockHeader', () => {
	test('should create a BlockHeader from hex', () => {
		const header = BlockHeaderMutable.fromHex(GENESIS_HEADER_HEX);
		expect(header).toBeInstanceOf(BlockHeaderMutable);
		expect(header.hashHex).toBe(GENESIS_HASH_HEX);
	});

	test('should create a BlockHeader from buffer', () => {
		const buffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		const header = BlockHeaderMutable.fromBuffer(buffer);
		expect(header).toBeInstanceOf(BlockHeaderMutable);
		expect(header.hashHex).toBe(GENESIS_HASH_HEX);
	});

	test('should have correct properties for genesis block', () => {
		const header = BlockHeaderMutable.fromHex(GENESIS_HEADER_HEX);
		expect(header.prevHashHex).toBe(GENESIS_PREV_HASH_HEX);
		expect(header.merkleRootHex).toBe(GENESIS_MERKLE_ROOT_HEX);
		expect(header.timestamp).toBe(1231006505);// 0x495FAB29.
		expect(header.bitsHex).toBe('1d00ffff');
		expect(header.nonce).toBe(2083236893);// 0x7C2BAC1D.
		expect(header.height).toBe(0);
		expect(header.work).toBe(BigInt(4295032833));
		expect(header.workTotal).toBe(header.work);
	});

	test('should throw error for invalid buffer length', () => {
		const shortBuffer = Buffer.from('01000000', 'hex');
		expect(() => BlockHeaderMutable.fromBuffer(shortBuffer)).toThrow('Invalid buffer length used to construct BlockHeader: 4');
	});

	test('should throw error for invalid proof of work', () => {
		// Create a header with a valid structure but incorrect nonce (invalid PoW).
		const invalidPowHeaderHex = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d00000000';
		expect(() => BlockHeaderMutable.fromHex(invalidPowHeaderHex)).toThrow('Invalid proof of work');
	});

	test('should skip proof of work check if specified', () => {
		const invalidPowHeaderHex = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d00000000';
		const header = BlockHeaderMutable.fromHex(invalidPowHeaderHex, true);
		expect(header).toBeInstanceOf(BlockHeaderMutable);
	});

	test('should set and get height', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		header.setHeight(100);
		expect(header.height).toBe(100);
	});

	test('should throw when setting height to a different value', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		header.setHeight(100);
		expect(() => header.setHeight(101)).toThrow(/height \(101\) has already been set to another value \(100\)/);
	});

	test('should not throw when setting height to the same value', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		header.setHeight(100);
		expect(() => header.setHeight(100)).not.toThrow();
	});

	test('should throw when getting height if not set', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);// makes prevHashHex non-zero.
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		expect(() => header.height).toThrow('height has not been calculated yet');
	});

	test('should set and get workTotal', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		const workTotal = BigInt(12345);
		header.setWorkTotal(workTotal);
		expect(header.workTotal).toBe(workTotal);
		expect(header.workTotalHex).toBe(workTotal.toString(16));
	});

	test('should throw when setting workTotal to a different value', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		header.setWorkTotal(BigInt(12345));
		expect(() => header.setWorkTotal(BigInt(54321))).toThrow(/workTotal \(54321\) has already been set to another value \(12345\)/);
	});

	test('should not throw when setting workTotal to the same value', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		header.setWorkTotal(BigInt(12345));
		expect(() => header.setWorkTotal(BigInt(12345))).not.toThrow();
	});

	test('should throw when getting workTotal if not set', () => {
		const nonGenesisHeaderBuffer = Buffer.from(GENESIS_HEADER_HEX, 'hex');
		nonGenesisHeaderBuffer.writeUInt8(1, 4);// makes prevHashHex non-zero.
		const header = BlockHeaderMutable.fromBuffer(nonGenesisHeaderBuffer, true);
		expect(() => header.workTotal).toThrow('workTotal has not been calculated yet');
	});
});