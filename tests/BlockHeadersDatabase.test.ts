/// <reference types="node" />
import { mkdir } from 'node:fs/promises';

import { Level } from 'level';
import { expect, test, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import { BlockHeaderMutable, getPrevHashHexFromBuffer, getWorkFromBuffer } from '../src/BlockHeader.js';
import { BlockHeadersDatabase, HEADERS_PER_CHUNK, WORK_CHECKPOINT_INTERVAL } from '../src/BlockHeadersDatabase.js';
import { Chain, getInvalidBlocks } from '../src/chainProtocol.js';
import { DEFAULT_DATABASE_PATH } from '../src/constants.js';
import { sha256sha256 } from '../src/utils/crypto.js';
import { getRandomHexString } from '../src/utils/util.js';

const chain = 'bsv';

const genesisHeader = BlockHeaderMutable.fromHex('0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c');

// Real blocks with valid POW. The value of work is the same for all blocks (+4295032833).
const headersBeforeReorg: BlockHeaderMutable[] = [
	//BlockHeaderMutable.fromHex('0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c'),// 0
	BlockHeaderMutable.fromHex('010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299'),// 1
	BlockHeaderMutable.fromHex('010000004860eb18bf1b1620e37e9490fc8a427514416fd75159ab86688e9a8300000000d5fdcc541e25de1c7a5addedf24858b8bb665c9f36ef744ee42c316022c90f9bb0bc6649ffff001d08d2bd61'),// 2
	BlockHeaderMutable.fromHex('01000000bddd99ccfda39da1b108ce1a5d70038d0a967bacb68b6b63065f626a0000000044f672226090d85db9a9f2fbfe5f0f9609b387af7be5b7fbb7a1767c831c9e995dbe6649ffff001d05e0ed6d'),// 3
	BlockHeaderMutable.fromHex('010000004944469562ae1c2c74d9a535e00b6f3e40ffbad4f2fda3895501b582000000007a06ea98cd40ba2e3288262b28638cec5337c1456aaf5eedc8e9e5a20f062bdf8cc16649ffff001d2bfee0a9'),// 4
	BlockHeaderMutable.fromHex('0100000085144a84488ea88d221c8bd6c059da090e88f8a2c99690ee55dbba4e00000000e11c48fecdd9e72510ca84f023370c9a38bf91ac5cae88019bee94d24528526344c36649ffff001d1d03e477'),// 5
	BlockHeaderMutable.fromHex('01000000fc33f596f822a0a1951ffdbf2a897b095636ad871707bf5d3162729b00000000379dfb96a5ea8c81700ea4ac6b97ae9a9312b2d4301a29580e924ee6761a2520adc46649ffff001d189c4c97'),// 6
	BlockHeaderMutable.fromHex('010000008d778fdc15a2d3fb76b7122a3b5582bea4f21f5a0c693537e7a03130000000003f674005103b42f984169c7d008370967e91920a6a5d64fd51282f75bc73a68af1c66649ffff001d39a59c86'),// 7
	BlockHeaderMutable.fromHex('010000004494c8cf4154bdcc0720cd4a59d9c9b285e4b146d45f061d2b6c967100000000e3855ed886605b6d4a99d5fa2ef2e9b0b164e63df3c4136bebf2d0dac0f1f7a667c86649ffff001d1c4b5666'),// 8
	BlockHeaderMutable.fromHex('01000000c60ddef1b7618ca2348a46e868afc26e3efc68226c78aa47f8488c4000000000c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd37047fca6649ffff001d28404f53'),// 9
];

// Fake blocks with invalid POW. The value of work is the same as all headersBeforeReorg blocks (+4295032833).
const headersReorg: BlockHeaderMutable[] = [
	BlockHeaderMutable.fromHex('010000004494c8cf4154bdcc0720cd4a59d9c9b285e4b146d45f061d2b6c967100000000c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd37047fca6649ffff001d28404f53', true),// 8
	BlockHeaderMutable.fromHex('01000000ad66671ba9f49751942c37e353643a6ff05e7a5a6300cc4b7ae22f38cf1f25ccc997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd37047fca6649ffff001d28404f53', true),// 9
	BlockHeaderMutable.fromHex('0100000040431d727c1b8280a6f14422c695f39a88241621bce3e789fd67f295e658e05ec997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd37047fca6649ffff001d28404f53', true),// 10
];

// Real blocks with valid POW. The value of work is the same for all blocks (+4295032833).
const headersReorg2: BlockHeaderMutable[] = [
	BlockHeaderMutable.fromHex('010000000508085c47cc849eb80ea905cc7800a3be674ffc57263cf210c59d8d00000000112ba175a1e04b14ba9e7ea5f76ab640affeef5ec98173ac9799a852fa39add320cd6649ffff001d1e2de565', true),// 10
	BlockHeaderMutable.fromHex('01000000e915d9a478e3adf3186c07c61a22228b10fd87df343c92782ecc052c000000006e06373c80de397406dc3d19c90d71d230058d28293614ea58d6a57f8f5d32f8b8ce6649ffff001d173807f8', true),// 11
];

const headersAfterReorg: BlockHeaderMutable[] = headersBeforeReorg.slice(0, -2).concat(headersReorg.slice());
expect(headersAfterReorg.length).toBe(10);
expect(headersAfterReorg.at(-1)?.hashHex).toBe(headersReorg.at(-1)?.hashHex);
expect(headersAfterReorg.at(-3)?.hashHex).toBe(headersReorg.at(-3)?.hashHex);
expect(headersAfterReorg.at(-4)?.hashHex).toBe(headersBeforeReorg.at(-3)?.hashHex);

const headersAfterReorg2: BlockHeaderMutable[] = headersBeforeReorg.slice().concat(headersReorg2.slice());
expect(headersAfterReorg2.length).toBe(11);
expect(headersAfterReorg2.at(-1)?.hashHex).toBe(headersReorg2.at(-1)?.hashHex);
expect(headersAfterReorg2.at(-2)?.hashHex).toBe(headersReorg2.at(-2)?.hashHex);
expect(headersAfterReorg2.at(-3)?.hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);

// console.log('headersBeforeReorg:', headersBeforeReorg.length);
// headersBeforeReorg.forEach((header, height) => {
// 	console.log(`  ${height}: ${header.hashHex}`);
// });
// console.log('headersAfterReorg:', headersAfterReorg.length);
// headersAfterReorg.forEach((header, height) => {
// 	console.log(`  ${height}: ${header.hashHex}`);
// });
// console.log('headersAfterReorg2:', headersAfterReorg2.length);
// headersAfterReorg2.forEach((header, height) => {
// 	console.log(`  ${height}: ${header.hashHex}`);
// });

// console.log(`headersBeforeReorg ends with hash: ${headersBeforeReorg.at(-1)?.hashHex}`);
// console.log(`headersReorg ends with hash: ${headersReorg.at(-1)?.hashHex}`);

// headersBeforeReorg: 9
//   0: 00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048
//   1: 000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd
//   2: 0000000082b5015589a3fdf2d4baff403e6f0be035a5d9742c1cae6295464449
//   3: 000000004ebadb55ee9096c9a2f8880e09da59c0d68b1c228da88e48844a1485
//   4: 000000009b7262315dbf071787ad3656097b892abffd1f95a1a022f896f533fc
//   5: 000000003031a0e73735690c5a1ff2a4be82553b2a12b776fbd3a215dc8f778d
//   6: 0000000071966c2b1d065fd446b1e485b2c9d9594acd2007ccbd5441cfc89444
//   7: 00000000408c48f847aa786c2268fc3e6ec2af68e8468a34a28c61b7f1de0dc6
//   8: 000000008d9dc510f23c2657fc4f67bea30078cc05a90eb89e84cc475c080805
// headersAfterReorg: 10
//   0: 00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048
//   1: 000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd
//   2: 0000000082b5015589a3fdf2d4baff403e6f0be035a5d9742c1cae6295464449
//   3: 000000004ebadb55ee9096c9a2f8880e09da59c0d68b1c228da88e48844a1485
//   4: 000000009b7262315dbf071787ad3656097b892abffd1f95a1a022f896f533fc
//   5: 000000003031a0e73735690c5a1ff2a4be82553b2a12b776fbd3a215dc8f778d
//   6: 0000000071966c2b1d065fd446b1e485b2c9d9594acd2007ccbd5441cfc89444
//   7: cc251fcf382fe27a4bcc00635a7a5ef06f3a6453e3372c945197f4a91b6766ad
//   8: 5ee058e695f267fd89e7e3bc211624889af395c62244f1a680821b7c721d4340
//   9: 2b14928f3d59cb1e4185f38f54ad9b9af627432c9f1f055f33d60340aa145565
// headersAfterReorg2: 11
//   0: 00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048
//   1: 000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd
//   2: 0000000082b5015589a3fdf2d4baff403e6f0be035a5d9742c1cae6295464449
//   3: 000000004ebadb55ee9096c9a2f8880e09da59c0d68b1c228da88e48844a1485
//   4: 000000009b7262315dbf071787ad3656097b892abffd1f95a1a022f896f533fc
//   5: 000000003031a0e73735690c5a1ff2a4be82553b2a12b776fbd3a215dc8f778d
//   6: 0000000071966c2b1d065fd446b1e485b2c9d9594acd2007ccbd5441cfc89444
//   7: 00000000408c48f847aa786c2268fc3e6ec2af68e8468a34a28c61b7f1de0dc6
//   8: 000000008d9dc510f23c2657fc4f67bea30078cc05a90eb89e84cc475c080805
//   9: 000000002c05cc2e78923c34df87fd108b22221ac6076c18f3ade378a4d915e9
//   10: 0000000097be56d606cdd9c54b04d4747e957d3608abe69198c661f2add73073
// headersBeforeReorg ends with hash: 000000008d9dc510f23c2657fc4f67bea30078cc05a90eb89e84cc475c080805
// headersReorg ends with hash: 2b14928f3d59cb1e4185f38f54ad9b9af627432c9f1f055f33d60340aa145565

// Helper to create a minimal valid block header buffer for testing.
// prevHashHex is the display-format hash of the parent header.
function createHeaderBuffer(prevHashHex: string, nonce: number, bitsHex: string = 'ffff001d'): Buffer {
	const buf = Buffer.alloc(80);
	buf.writeUInt32LE(1, 0);
	Buffer.from(prevHashHex, 'hex').reverse().copy(buf, 4);
	const merkleBuf = Buffer.alloc(32);
	merkleBuf.writeUInt32LE(nonce, 0);
	merkleBuf.writeUInt32LE(nonce + 1, 4);
	merkleBuf.writeUInt32LE(nonce + 2, 8);
	merkleBuf.reverse();
	merkleBuf.copy(buf, 36);
	buf.writeUInt32LE(1000000000 + nonce, 68);
	Buffer.from(bitsHex, 'hex').copy(buf, 72);
	buf.writeUInt32LE(nonce, 76);
	return buf;
}

// Create a BlockHeaderMutable with skipProofOfWorkCheck = true.
function createHeader(prevHashHex: string, nonce: number, bitsHex: string = 'ffff001d'): BlockHeaderMutable {
	return BlockHeaderMutable.fromBuffer(createHeaderBuffer(prevHashHex, nonce, bitsHex), true);
}

// Build a linear chain of headers on top of an existing parent hash.
function buildChain(parentHashHex: string, count: number, startNonce: number, bitsHex?: string): BlockHeaderMutable[] {
	const headers: BlockHeaderMutable[] = [];
	let prev = parentHashHex;
	for (let i = 0; i < count; i++) {
		const h = createHeader(prev, startNonce + i, bitsHex);
		headers.push(h);
		prev = h.hashHex;
	}
	return headers;
}

// Low-difficulty bits (target 0x7fffff * 2^232) so synthetic headers can satisfy proof of work.
const EASY_BITS_HEX = 'ffff7f20';
// Higher-work variants of EASY_BITS_HEX (roughly 4x and 8x the work) for building winning forks.
const HARDER_BITS_HEX = 'ffff3f20';
const HARDEST_BITS_HEX = 'ffff1f20';
// Compact bits with a target of exactly 2^256 so every hash satisfies proof of work on the
// first nonce (work 1). Used for large chains where mining would otherwise dominate test time.
const ALWAYS_VALID_BITS_HEX = '00000121';
// Compact bits with a target of 2^248 (work 256 per header) for short, heavy winning forks.
const WORK_256_BITS_HEX = '00000120';

// Create a BlockHeaderMutable with a valid proof of work by trying successive nonces.
function createValidHeader(prevHashHex: string, nonce: number, bitsHex: string = EASY_BITS_HEX): BlockHeaderMutable {
	for (let attempt = 0; ; attempt++) {
		try {
			return BlockHeaderMutable.fromBuffer(createHeaderBuffer(prevHashHex, nonce + attempt, bitsHex));// Throws until a nonce produces a valid proof of work.
		} catch { /* Invalid proof of work: try the next nonce. */ }
	}
}

// Build a linear chain of headers with valid proof of work on top of an existing parent hash.
function buildValidChain(parentHashHex: string, count: number, startNonce: number, bitsHex?: string): BlockHeaderMutable[] {
	const headers: BlockHeaderMutable[] = [];
	let prev = parentHashHex;
	for (let i = 0; i < count; i++) {
		const h = createValidHeader(prev, startNonce + i, bitsHex);
		headers.push(h);
		prev = h.hashHex;
	}
	return headers;
}

// A chain long enough to cross the HEADERS_PER_CHUNK boundary. Built once and shared by the
// chunk-boundary tests because the headers are immutable and heights/work totals are
// deterministic, so adding the same objects to different databases yields the same state.
let cachedBulkChain: BlockHeaderMutable[] | undefined;
function getBulkChain(): BlockHeaderMutable[] {
	if (!cachedBulkChain) {
		cachedBulkChain = buildValidChain(genesisHeader.hashHex, HEADERS_PER_CHUNK + 50, 900000, ALWAYS_VALID_BITS_HEX);
	}
	return cachedBulkChain;
}

// Reads the raw height keys stored in the LevelDB header database.
async function getRawDatabaseHeights(databasePath: string): Promise<number[]> {
	const level = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
	await level.open();
	const heights: number[] = [];
	for await (const height of level.keys()) {
		heights.push(height);
	}
	await level.close();
	return heights.sort((a, b) => a - b);
}

// Asserts the internal data-structure invariants that the packed-chunk storage relies on:
// the main chain height/hash bijection, packed buffer continuity, work checkpoints, the tip
// work total, the fork map and the leaf set. Linear in the number of stored headers so tests
// can call it after every mutating operation. packedHashCheckStep lets large-chain tests check
// the packed bytes hash to the stored hash on only every Nth height instead of all of them.
function assertDatabaseInvariants(db: BlockHeadersDatabase, options?: { packedHashCheckStep?: number; checkForkGetters?: boolean }): void {
	const internal = db as any;
	const packedHashCheckStep = options?.packedHashCheckStep ?? 1;
	const checkForkGetters = options?.checkForkGetters ?? true;
	const heightToHash = internal._heightToHash as string[];
	const hashToHeight = internal._hashToHeight as Map<string, number>;
	const forkHeaders = internal._forkHeaders as Map<string, { buffer: Buffer; height: number; workTotal: bigint }>;
	const leafHashes = internal._headersTreeLeafHashes as Set<string>;
	const chunks = internal._chunks as Buffer[];
	const workCheckpoints = internal._workCheckpoints as bigint[];
	const tipHeight = heightToHash.length - 1;

	// Checks that would otherwise run per header are aggregated into a single error so the helper
	// stays fast on chains with tens of thousands of headers.
	let invariantError: string | undefined;
	const recordError = (message: string): void => {
		invariantError ??= message;
	};

	// The main chain hash<->height mappings are bijective.
	expect(hashToHeight.size).toBe(heightToHash.length);
	for (let height = 0; height < heightToHash.length; height++) {
		if (typeof heightToHash[height] !== 'string' || hashToHeight.get(heightToHash[height]) !== height) {
			recordError(`Main chain hash/height mapping is broken at height ${height}.`);
		}
	}

	// Packed chunk buffers hold exactly the main chain headers and work checkpoints hold the
	// cumulative work at each interval boundary.
	expect(chunks.length).toBeGreaterThanOrEqual(Math.floor(tipHeight / HEADERS_PER_CHUNK) + 1);
	expect(workCheckpoints.length).toBe(Math.floor(tipHeight / WORK_CHECKPOINT_INTERVAL) + 1);
	expect(workCheckpoints[0]).toBe(genesisHeader.work);
	let cumulativeWork = workCheckpoints[0];
	for (let height = 1; height <= tipHeight; height++) {
		const buffer = internal._getHeaderBufferFromHeight(height) as Buffer;
		if (getPrevHashHexFromBuffer(buffer) !== heightToHash[height - 1]) {
			recordError(`Packed header continuity is broken at height ${height}.`);
		}
		if ((height % packedHashCheckStep === 0 || height === tipHeight) && sha256sha256(buffer).reverse().toString('hex') !== heightToHash[height]) {
			recordError(`Packed header bytes do not hash to the stored hash at height ${height}.`);
		}
		cumulativeWork += getWorkFromBuffer(buffer);
		if (height % WORK_CHECKPOINT_INTERVAL === 0 && workCheckpoints[height / WORK_CHECKPOINT_INTERVAL] !== cumulativeWork) {
			recordError(`Work checkpoint is wrong at height ${height}.`);
		}
	}

	// Fork headers are disjoint from the main chain and carry the correct buffer size.
	for (const [hashHex, forkHeader] of forkHeaders) {
		if (hashToHeight.has(hashHex)) recordError(`Fork header ${hashHex} is also in the main chain.`);
		if (forkHeader.buffer.length !== 80) recordError(`Fork header ${hashHex} has an invalid buffer length.`);
		if (checkForkGetters) {
			const headerFromHashHex = db.getHeaderFromHashHex(hashHex);
			if (!headerFromHashHex || headerFromHashHex.height !== forkHeader.height || headerFromHashHex.workTotal !== forkHeader.workTotal) {
				recordError(`Fork header getter does not match the stored fork header ${hashHex}.`);
			}
		}
	}
	expect(invariantError).toBeUndefined();

	// The tip work total equals the recomputed cumulative work and is the maximum leaf work.
	expect(db.getHeaderTip().workTotal).toBe(cumulativeWork);
	let maxLeafWorkTotal = 0n;
	for (const leafHashHex of leafHashes) {
		const leafWorkTotal = leafHashHex === heightToHash[tipHeight] ? cumulativeWork : forkHeaders.get(leafHashHex)!.workTotal;
		if (leafWorkTotal > maxLeafWorkTotal) maxLeafWorkTotal = leafWorkTotal;
	}
	expect(cumulativeWork).toBe(maxLeafWorkTotal);

	// The leaf set is exactly the set of known headers with no known children.
	const childCounts = new Map<string, number>();
	for (let height = 1; height <= tipHeight; height++) {
		const prevHashHex = getPrevHashHexFromBuffer(internal._getHeaderBufferFromHeight(height) as Buffer);
		childCounts.set(prevHashHex, (childCounts.get(prevHashHex) ?? 0) + 1);
	}
	for (const forkHeader of forkHeaders.values()) {
		const prevHashHex = getPrevHashHexFromBuffer(forkHeader.buffer);
		childCounts.set(prevHashHex, (childCounts.get(prevHashHex) ?? 0) + 1);
	}
	const expectedLeafHashes = new Set<string>();
	for (const hashHex of heightToHash) if (!childCounts.has(hashHex)) expectedLeafHashes.add(hashHex);
	for (const hashHex of forkHeaders.keys()) if (!childCounts.has(hashHex)) expectedLeafHashes.add(hashHex);
	expect(leafHashes).toEqual(expectedLeafHashes);

	// The main chain tip must always be tracked as a leaf. A positive-work child of the tip
	// always takes over the chain, and zero-work children are impossible because targets above
	// 2^256 are rejected, so only a bookkeeping bug could displace the tip from the leaf set.
	expect(leafHashes.has(heightToHash[tipHeight])).toBe(true);

	// The block locator follows the exponential-backoff height schedule from the tip.
	const expectedLocatorHashes: string[] = [];
	let step = 1;
	for (let height = tipHeight; height > 0; height -= step) {
		if (expectedLocatorHashes.length >= 10) step *= 2;
		expectedLocatorHashes.push(heightToHash[height]);
	}
	expectedLocatorHashes.push(heightToHash[0]);
	expect(db.getBlockLocatorHashBuffers().map(buffer => buffer.toString('hex'))).toEqual(expectedLocatorHashes);

	// Public counts are consistent with the internal structures.
	expect(db.getNumLongestChainHeaders()).toBe(heightToHash.length);
	expect(db.getNumAllHeaders()).toBe(heightToHash.length + forkHeaders.size);
	expect(db.getNumCompetingTips()).toBe(leafHashes.size);
}

// --- Tests for BlockHeadersDatabase ---
describe('BlockHeadersDatabase', () => {
	let db: BlockHeadersDatabase;
	let databasePath: string;

	beforeEach(async (context) => {
		databasePath = `tests/db/headers-${getRandomHexString(16)}`;

		await mkdir(databasePath, { recursive: true });

		db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({ databasePath, invalidBlocks: Array.from(getInvalidBlocks(chain)) }));
	});

	afterEach(async () => {
		if (db) {
			await db.close();
		}
		await removeDirectoryWithRetries(databasePath);
	});

	test('should create and close the database', () => {
		expect(db).toBeInstanceOf(BlockHeadersDatabase);
	});

	test('reorg from height 9 replaced with a new 8 to 10', () => {
		expect(db.getHeaderTip().height).toBe(0);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersBeforeReorg);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(headersBeforeReorg.length);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersReorg);
			expect(headersRemovedFromLongestChain.length).toBe(2);
			expect(headersAddedToLongestChain.length).toBe(3);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(10);
		expect(db.getHeaderTip().hashHex).toBe(headersReorg.at(-1)?.hashHex);
		expect(db.getHeaderTip().hashHex).toBe(headersAfterReorg.at(-1)?.hashHex);
	});

	test('reorg from height 9 replaced with a new 8 to 10 followed by a pruneBranches()', () => {
		expect(db.getHeaderTip().height).toBe(0);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersBeforeReorg);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(headersBeforeReorg.length);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		expect(db.getHeaderFromHashHex(headersBeforeReorg.at(-1)!.hashHex)).toBeDefined();
		expect(db.getHeaderFromHashHex(headersReorg.at(-1)!.hashHex)).toBeUndefined();
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersReorg);
			expect(headersRemovedFromLongestChain.length).toBe(2);
			expect(headersAddedToLongestChain.length).toBe(3);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(10);
		expect(db.getHeaderTip().hashHex).toBe(headersReorg.at(-1)?.hashHex);
		expect(db.getHeaderTip().hashHex).toBe(headersAfterReorg.at(-1)?.hashHex);
		db.pruneBranches();
		expect(db.getHeaderFromHashHex(headersBeforeReorg.at(-1)!.hashHex)).toBeUndefined();
		expect(db.getHeaderFromHashHex(headersReorg.at(-1)!.hashHex)).toBeDefined();
	});

	test('reorg from height 9 replaced with a new 8 to 10 with all headers added 1 at a time', () => {
		expect(db.getHeaderTip().height).toBe(0);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersBeforeReorg);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(headersBeforeReorg.length);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		{// 1st header from headersReorg added to the database. No reorg yet.
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg[0]]);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(0);
		}
		{// 2nd header from headersReorg added to the database. No reorg yet.
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg[1]]);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(0);
		}
		{// 3rd header from headersReorg added to the database. This should reorg.
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg[2]]);
			expect(headersRemovedFromLongestChain.length).toBe(2);
			expect(headersAddedToLongestChain.length).toBe(3);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(10);
		expect(db.getHeaderTip().hashHex).toBe(headersReorg.at(-1)?.hashHex);
		expect(db.getHeaderTip().hashHex).toBe(headersAfterReorg.at(-1)?.hashHex);
	});

	test('adding 2 detached headers should have no effect', () => {
		expect(db.getHeaderTip().height).toBe(0);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersBeforeReorg);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(headersBeforeReorg.length);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		{
			const detachedHeaders = [headersReorg[1], headersReorg[2]];
			expect(db.getHeaderFromHashHex(detachedHeaders[0].hashHex)).toBeUndefined();
			expect(db.getHeaderFromHashHex(detachedHeaders[1].hashHex)).toBeUndefined();
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(detachedHeaders);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(0);
			expect(db.getHeaderFromHashHex(detachedHeaders[0].hashHex)).toBeUndefined();
			expect(db.getHeaderFromHashHex(detachedHeaders[1].hashHex)).toBeUndefined();
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
	});

	test('reorg from height 9 replaced with a new 8 to 10 followed be another re-org with the original chain extended with all headers added 1 at a time', () => {
		expect(db.getHeaderTip().height).toBe(0);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersBeforeReorg);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(headersBeforeReorg.length);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		{// 1st header from headersReorg added to the database. No reorg yet.
			expect(db.getHeaderFromHashHex(headersReorg[0].hashHex)).toBeUndefined();
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg[0]]);
			expect(db.getHeaderFromHashHex(headersReorg[0].hashHex)).toBeDefined();
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(0);
		}
		{// 2nd header from headersReorg added to the database. No reorg yet.
			expect(db.getHeaderFromHashHex(headersReorg[1].hashHex)).toBeUndefined();
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg[1]]);
			expect(db.getHeaderFromHashHex(headersReorg[1].hashHex)).toBeDefined();
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(0);
		}
		{// 3rd header from headersReorg added to the database. This should reorg.
			expect(db.getHeaderFromHashHex(headersBeforeReorg.at(-1)!.hashHex)).toBeDefined();
			expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeUndefined();
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg[2]]);
			expect(db.getHeaderFromHashHex(headersBeforeReorg.at(-1)!.hashHex)).toBeDefined();// Old longest branch still in database.
			expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeDefined();
			expect(headersRemovedFromLongestChain.length).toBe(2);
			expect(headersAddedToLongestChain.length).toBe(3);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(10);
		expect(db.getHeaderTip().hashHex).toBe(headersReorg.at(-1)?.hashHex);
		expect(db.getHeaderTip().hashHex).toBe(headersAfterReorg.at(-1)?.hashHex);
		{// 1st header from headersReorg2 added to the database. No reorg yet.
			expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeDefined();// 1st reorg branch in database.
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg2[0]]);
			expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeDefined();// 1st reorg branch still in database.
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(0);
		}
		{// 2nd header from headersReorg2 added to the database. This should reorg.
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headersReorg2[1]]);
			expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeDefined();// 1st reorg branch still in database after 2nd reorg.
			expect(headersRemovedFromLongestChain.length).toBe(3);
			expect(headersAddedToLongestChain.length).toBe(4);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(11);
		expect(db.getHeaderTip().hashHex).toBe(headersReorg2.at(-1)?.hashHex);
		expect(db.getHeaderTip().hashHex).toBe(headersAfterReorg2.at(-1)?.hashHex);
		expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeDefined();// 1st reorg branch still in database after 2nd reorg.
		db.pruneBranches();
		expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeUndefined();// 1st reorg branch removed database after 2nd reorg followed by pruneBranches().
	});

	test('invalid blocks', async () => {
		if (db) {
			await db.close();
		}
		await removeDirectoryWithRetries(databasePath);
		await mkdir(databasePath);
		const invalidBlocks = [headersReorg[1].hashHex];// Set reorg block 9 as invalid.
		db = BlockHeadersDatabase.fromGenesis({ databasePath, invalidBlocks });

		expect(db.getHeaderTip().height).toBe(0);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersBeforeReorg);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(headersBeforeReorg.length);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersReorg);
			// No reorg because using only the first header (others are invalid) from headersReorg doesn't have more POW than the headersBeforeReorg chain.
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(2);// 9 and 10 of the reorg are invalidated.
			expect(headersInvalidated.map(header => header.hashHex)).toEqual([headersReorg[1].hashHex, headersReorg[2].hashHex]);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		// Invalid headers and their descendants must never be stored, even as forks.
		expect(db.getHeaderFromHashHex(headersReorg[1].hashHex)).toBeUndefined();
		expect(db.getHeaderFromHashHex(headersReorg[2].hashHex)).toBeUndefined();
		assertDatabaseInvariants(db);
	});

	test('2 connected invalid blocks', async () => {
		if (db) {
			await db.close();
		}
		await removeDirectoryWithRetries(databasePath);
		await mkdir(databasePath);
		const invalidBlocks = [headersReorg[1].hashHex, headersReorg[2].hashHex];// Set reorg block 9 and 10 as invalid.
		db = BlockHeadersDatabase.fromGenesis({ databasePath, invalidBlocks });

		expect(db.getHeaderTip().height).toBe(0);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersBeforeReorg);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(headersBeforeReorg.length);
			expect(headersInvalidated.length).toBe(0);
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders(headersReorg);
			// No reorg because using only the first header (others are invalid) from headersReorg doesn't have more POW than the headersBeforeReorg chain.
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(2);// 9 and 10 of the reorg are invalidated.
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
	});

	test('verify work of individual headers', () => {
		// Since all headers have the same work value according to the setup (+4295032833).
		const expectedWork = headersBeforeReorg[0].work;
		for (const header of headersBeforeReorg) {
			expect(header.work).toBe(expectedWork);
		}
		for (const header of headersReorg) {
			expect(header.work).toBe(expectedWork);
		}
	});

	test('workTotal accumulates correctly when adding headers incrementally', () => {
		let expectedWorkTotal = db.getHeaderTip().workTotal;
		for (let i = 0; i < headersBeforeReorg.length; i++) {
			const header = headersBeforeReorg[i];
			expectedWorkTotal += header.work;
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([header]);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(1);
			expect(headersInvalidated.length).toBe(0);
			expect(db.getHeaderTip().workTotal).toBe(expectedWorkTotal);
		}
	});

	test('workTotal updates correctly after reorg', () => {
		const expectedWorkTotalBeforeReorg = BigInt(headersBeforeReorg.length) * BigInt(4295032833) + BigInt(4295032833);
		db.addHeaders(headersBeforeReorg);
		expect(db.getHeaderTip().workTotal).toBe(expectedWorkTotalBeforeReorg);

		const expectedWorkTotalAfterReorg = BigInt(headersAfterReorg.length) * BigInt(4295032833) + BigInt(4295032833);
		db.addHeaders(headersReorg);
		expect(db.getHeaderTip().workTotal).toBe(expectedWorkTotalAfterReorg);
		expect(db.getHeaderTip().workTotal).toBeGreaterThan(expectedWorkTotalBeforeReorg);
	});

	test('workTotal remains unchanged with invalid blocks', async () => {
		if (db) {
			await db.close();
		}
		await removeDirectoryWithRetries(databasePath);
		await mkdir(databasePath);
		const invalidBlocks = [headersReorg[1].hashHex];// Set reorg block 9 as invalid.
		db = BlockHeadersDatabase.fromGenesis({ databasePath, invalidBlocks });

		const expectedWorkTotalBeforeReorg = headersBeforeReorg.at(-1)!.workTotal;
		db.addHeaders(headersBeforeReorg);
		expect(db.getHeaderTip().workTotal).toBe(expectedWorkTotalBeforeReorg);

		db.addHeaders(headersReorg);
		expect(db.getHeaderTip().workTotal).toBe(expectedWorkTotalBeforeReorg);// No change due to invalid blocks.
	});

	test('handles empty header addition', () => {
		const {
			headersRemovedFromLongestChain,
			headersAddedToLongestChain,
			headersInvalidated
		} = db.addHeaders([]);
		expect(headersRemovedFromLongestChain.length).toBe(0);
		expect(headersAddedToLongestChain.length).toBe(0);
		expect(headersInvalidated.length).toBe(0);
		expect(db.getHeaderTip().height).toBe(0);
		expect(db.getHeaderTip().workTotal).toBe(headersBeforeReorg[0].work);
	});

	test('genesis header addition', () => {
		const {
			headersRemovedFromLongestChain,
			headersAddedToLongestChain,
			headersInvalidated
		} = db.addHeaders([genesisHeader]);
		expect(headersRemovedFromLongestChain.length).toBe(0);
		expect(headersAddedToLongestChain.length).toBe(0);
		expect(headersInvalidated.length).toBe(0);
		expect(db.getHeaderTip().height).toBe(0);
		expect(db.getHeaderTip().workTotal).toBe(genesisHeader.work);
	});

	test('rejects headers with missing parents', () => {
		const headerHeight2 = headersBeforeReorg[1];// Height 2, depends on height 1.
		const {
			headersRemovedFromLongestChain,
			headersAddedToLongestChain,
			headersInvalidated
		} = db.addHeaders([headerHeight2]);
		expect(headersRemovedFromLongestChain.length).toBe(0);
		expect(headersAddedToLongestChain.length).toBe(0);
		expect(headersInvalidated.length).toBe(0);
		expect(db.getHeaderTip().height).toBe(0);// Stays at genesis.
		expect(db.getHeaderTip().workTotal).toBe(headersBeforeReorg[0].work);
	});

	test('adds headers out of order and 1 at a time', () => {
		const headerHeight2 = headersBeforeReorg[1];// Height 2, depends on height 1.
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headerHeight2]);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(0);
			expect(headersInvalidated.length).toBe(0);
			expect(db.getHeaderTip().height).toBe(0);// Stays at genesis.
			expect(db.getHeaderTip().workTotal).toBe(headersBeforeReorg[0].work);
		}
		const headerHeight1 = headersBeforeReorg[0];
		{
			const {
				headersRemovedFromLongestChain,
				headersAddedToLongestChain,
				headersInvalidated
			} = db.addHeaders([headerHeight1]);
			expect(headersRemovedFromLongestChain.length).toBe(0);
			expect(headersAddedToLongestChain.length).toBe(1);// Height 2 should have been discarded.
			expect(headersInvalidated.length).toBe(0);
			expect(db.getHeaderTip().height).toBe(1);
			expect(db.getHeaderTip().workTotal).toBe(headerHeight1.workTotal);
		}
	});

	test('maintains chain integrity with duplicate headers', () => {
		const duplicateHeaders = [headersBeforeReorg[0], headersBeforeReorg[0]];// Add height 1 twice.
		const {
			headersRemovedFromLongestChain,
			headersAddedToLongestChain,
			headersInvalidated
		} = db.addHeaders(duplicateHeaders);
		expect(headersRemovedFromLongestChain.length).toBe(0);
		expect(headersAddedToLongestChain.length).toBe(1);// Only one should be added.
		expect(headersInvalidated.length).toBe(0);
		expect(db.getHeaderTip().height).toBe(1);
		expect(db.getHeaderTip().workTotal).toBe(genesisHeader.work + headersBeforeReorg[0].work);
	});

	test('a duplicate ancestor header inside one batch must not corrupt the leaf set', () => {
		const chain = buildChain(db.getHeaderTip().hashHex, 3, 1000);
		const [a, b, c] = chain;

		// A appears again after its descendants appeared in the same batch. The repeat is already
		// known by the time it is reached, so it must be ignored.
		const result = db.addHeaders([a, b, c, a]);
		expect(result.headersRemovedFromLongestChain.length).toBe(0);
		expect(result.headersAddedToLongestChain.length).toBe(3);
		expect(result.headersInvalidated.length).toBe(0);
		expect(db.getHeaderTip().hashHex).toBe(c.hashHex);

		// The repeated A used to be re-added as a leaf even though B is its child, so the database
		// reported a phantom competing tip.
		expect(db.getNumCompetingTips()).toBe(1);

		// The phantom leaf used to make the next addHeaders throw because A was neither the chain
		// tip nor in _forkHeaders.
		const [d] = buildChain(c.hashHex, 1, 2000);
		db.addHeaders([d]);
		expect(db.getHeaderTip().hashHex).toBe(d.hashHex);

		// The phantom leaf also used to fail the pruneBranches leaf-set assertion.
		expect(db.pruneBranches()).toBe(0);
		expect(db.getNumCompetingTips()).toBe(1);
		assertDatabaseInvariants(db);
	});

	test('a duplicate header in the middle of a batch does not stop the later headers from being added', () => {
		const chain = buildChain(db.getHeaderTip().hashHex, 4, 3000);
		const [a, b, c, d] = chain;

		// A repeats in the middle of the batch. All non-duplicate headers must still be added.
		const result = db.addHeaders([a, b, a, c, d]);
		expect(result.headersRemovedFromLongestChain.length).toBe(0);
		expect(result.headersAddedToLongestChain.length).toBe(4);
		expect(result.headersInvalidated.length).toBe(0);
		expect(db.getHeaderTip().hashHex).toBe(d.hashHex);
		expect(db.getNumCompetingTips()).toBe(1);
		assertDatabaseInvariants(db);
	});

	test('getHeaderFromHeight rejects out-of-range and non-integer heights', () => {
		db.addHeaders(buildValidChain(db.getHeaderTip().hashHex, 3, 500));
		expect(db.getHeaderFromHeight(-1)).toBeUndefined();
		expect(db.getHeaderFromHeight(0.5)).toBeUndefined();
		expect(db.getHeaderFromHeight(4)).toBeUndefined();
		expect(db.getHeaderFromHeight(NaN)).toBeUndefined();
		expect(db.getHeaderFromHeight(Infinity)).toBeUndefined();
		expect(db.getHeaderFromHashHex('00'.repeat(32))).toBeUndefined();
	});

	test('getTimeSinceLastChainTipExtensionThisSessionMs only advances on main chain changes', () => {
		expect(db.getTimeSinceLastChainTipExtensionThisSessionMs()).toBeUndefined();

		const mainChain = buildValidChain(db.getHeaderTip().hashHex, 10, 600);
		db.addHeaders(mainChain);
		const lastExtensionMsAfterAdd = (db as any)._lastTimeChainTipExtendedMs as number;
		expect(lastExtensionMsAfterAdd).toBeDefined();

		// A losing fork does not change the longest chain, so the last extension time is unchanged.
		db.addHeaders(buildValidChain(mainChain[5].hashHex, 1, 700));
		expect((db as any)._lastTimeChainTipExtendedMs).toBe(lastExtensionMsAfterAdd);

		// A reorg counts as a main chain change.
		db.addHeaders(buildValidChain(mainChain[5].hashHex, 30, 800, HARDER_BITS_HEX));
		expect((db as any)._lastTimeChainTipExtendedMs).not.toBe(lastExtensionMsAfterAdd);
	});

	describe('leaf hash set invariant', () => {
		test('normal extension: chain tip is the only leaf after full sync', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const chain = buildChain(genesisHashHex, 5, 100);
			db.addHeaders(chain);
			const leavesSet = (db as any)._headersTreeLeafHashes as Set<string>;
			expect(leavesSet.size).toBe(1);
			expect(leavesSet.has(db.getHeaderTip().hashHex)).toBe(true);
		});

		test('two competing forks produce two leaf entries', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const mainChain = buildChain(genesisHashHex, 3, 100);
			db.addHeaders(mainChain);

			const forkParent = mainChain[0].hashHex;
			const forkChain = buildChain(forkParent, 2, 200);// Same work per header, fork is shorter -> less total work.
			db.addHeaders(forkChain);

			const leavesSet = (db as any)._headersTreeLeafHashes as Set<string>;
			expect(leavesSet.size).toBe(2);
			expect(leavesSet.has(mainChain.at(-1)!.hashHex)).toBe(true);
			expect(leavesSet.has(forkChain.at(-1)!.hashHex)).toBe(true);
		});

		test('fork point with 3 children: leaf set includes all 3 leaf tips', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const trunk = buildChain(genesisHashHex, 2, 100);
			db.addHeaders(trunk);

			const branchA = buildChain(trunk.at(-1)!.hashHex, 1, 200);
			const branchB = buildChain(trunk.at(-1)!.hashHex, 1, 300);
			const branchC = buildChain(trunk.at(-1)!.hashHex, 1, 400);
			db.addHeaders(branchA);
			db.addHeaders(branchB);
			db.addHeaders(branchC);

			const leavesSet = (db as any)._headersTreeLeafHashes as Set<string>;
			expect(leavesSet.size).toBe(3);
			expect(leavesSet.has(branchA.at(-1)!.hashHex)).toBe(true);
			expect(leavesSet.has(branchB.at(-1)!.hashHex)).toBe(true);
			expect(leavesSet.has(branchC.at(-1)!.hashHex)).toBe(true);

			// The fork point should NOT be a leaf.
			expect(leavesSet.has(trunk.at(-1)!.hashHex)).toBe(false);
		});

		test('pruneBranches collapses 3-fork back to single leaf', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const trunk = buildChain(genesisHashHex, 2, 100);
			db.addHeaders(trunk);

			const mainExtension = buildChain(trunk.at(-1)!.hashHex, 5, 100);
			db.addHeaders(mainExtension);

			const forkA = buildChain(trunk.at(-1)!.hashHex, 1, 200);
			const forkB = buildChain(trunk.at(-1)!.hashHex, 1, 300);
			db.addHeaders(forkA);
			db.addHeaders(forkB);

			const leavesSet = (db as any)._headersTreeLeafHashes as Set<string>;
			expect(leavesSet.size).toBe(3);
			expect(leavesSet.has(trunk.at(-1)!.hashHex)).toBe(false);

			db.pruneBranches();

			expect(leavesSet.size).toBe(1);
			expect(leavesSet.has(db.getHeaderTip().hashHex)).toBe(true);
			expect(leavesSet.has(mainExtension.at(-1)!.hashHex)).toBe(true);
		});

		test('pruneBranches keeps a parent with a remaining child out of the leaf set', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const trunk = buildChain(genesisHashHex, 2, 100);
			db.addHeaders(trunk);

			const mainBranch = buildChain(trunk.at(-1)!.hashHex, 2, 100);
			db.addHeaders(mainBranch);

			const staleFork = buildChain(trunk.at(-1)!.hashHex, 1, 200);
			db.addHeaders(staleFork);

			const leavesSet = (db as any)._headersTreeLeafHashes as Set<string>;
			expect(leavesSet.size).toBe(2);

			db.pruneBranches();

			expect(leavesSet.size).toBe(1);
			expect(leavesSet.has(mainBranch.at(-1)!.hashHex)).toBe(true);

			// The parent of the pruned fork should not reappear in the leaf set (it still has mainBranch).
			expect(leavesSet.has(trunk.at(-1)!.hashHex)).toBe(false);
		});

		test('Leaf-hash set survives removing and re-adding a child on a single-child parent', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const chain1 = buildChain(genesisHashHex, 2, 100);
			db.addHeaders(chain1);

			const leavesSet = (db as any)._headersTreeLeafHashes as Set<string>;
			expect(leavesSet.size).toBe(1);
			expect(leavesSet.has(chain1.at(-1)!.hashHex)).toBe(true);
			expect(leavesSet.has(genesisHashHex)).toBe(false);
		});

		test('leafCount equals getNumCompetingTips after all operations', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const mainChain = buildChain(genesisHashHex, 3, 100);
			db.addHeaders(mainChain);
			expect(db.getNumCompetingTips()).toBe(1);

			const forkA = buildChain(mainChain[1].hashHex, 2, 200);
			db.addHeaders(forkA);
			expect(db.getNumCompetingTips()).toBe(2);

			const forkB = buildChain(mainChain[1].hashHex, 1, 300);
			db.addHeaders(forkB);
			expect(db.getNumCompetingTips()).toBe(3);

			const forkC = buildChain(mainChain[0].hashHex, 1, 400);
			db.addHeaders(forkC);
			expect(db.getNumCompetingTips()).toBe(4);

			db.pruneBranches();
			expect(db.getNumCompetingTips()).toBe(1);
		});
	});

	describe('chain tip emit invariant', () => {
		// The _syncHeaders loop emits new_chain_tip with headers.at(-1).hashHex.
		// This describe proves that when nAdded > 0, the last header in every
		// batch is always the new chain tip (a linear peer batch always has
		// the maximum workTotal at its tail).

		test('normal extension: last header in batch IS the new chain tip', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const batch = buildChain(genesisHashHex, 5, 100);
			const result = db.addHeaders(batch);

			expect(result.headersAddedToLongestChain.length).toBeGreaterThan(0);
			expect(db.getHeaderTip().hashHex).toBe(batch.at(-1)!.hashHex);
			expect(result.headersAddedToLongestChain.map(h => h.hashHex))
				.toContain(batch.at(-1)!.hashHex);
		});

		test('reorg where fork wins: fork batch last header IS new chain tip', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const mainChain = buildChain(genesisHashHex, 3, 100);
			db.addHeaders(mainChain);

			const forkParent = mainChain[0].hashHex;
			const forkChain = buildChain(forkParent, 4, 200);

			const result = db.addHeaders(forkChain);

			expect(result.headersAddedToLongestChain.length).toBeGreaterThan(0);
			expect(db.getHeaderTip().hashHex).toBe(forkChain.at(-1)!.hashHex);
			expect(result.headersAddedToLongestChain.map(h => h.hashHex))
				.toContain(forkChain.at(-1)!.hashHex);
		});

		test('orphan fork (less work): nAdded = 0, emit would not fire', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const mainChain = buildChain(genesisHashHex, 5, 100);
			db.addHeaders(mainChain);

			const forkParent = mainChain[0].hashHex;
			const forkChain = buildChain(forkParent, 2, 200);

			const result = db.addHeaders(forkChain);

			expect(result.headersAddedToLongestChain.length).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(mainChain.at(-1)!.hashHex);
		});

		test('reorg by extension: extending an existing fork past main chain', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const mainChain = buildChain(genesisHashHex, 5, 100);
			db.addHeaders(mainChain);
			const mainTipBefore = db.getHeaderTip().hashHex;

			const forkParent = mainChain[1].hashHex;
			const forkPart1 = buildChain(forkParent, 2, 200);
			const result1 = db.addHeaders(forkPart1);
			expect(result1.headersAddedToLongestChain.length).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(mainTipBefore);

			const forkPart2 = buildChain(forkPart1.at(-1)!.hashHex, 2, 300);
			const result2 = db.addHeaders(forkPart2);

			expect(result2.headersAddedToLongestChain.length).toBeGreaterThan(0);
			expect(db.getHeaderTip().hashHex).toBe(forkPart2.at(-1)!.hashHex);
			expect(result2.headersAddedToLongestChain.map(h => h.hashHex))
				.toContain(forkPart2.at(-1)!.hashHex);
		});

		test('concurrent extension: batch extending a side branch that now wins', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const mainChain = buildChain(genesisHashHex, 5, 100);
			db.addHeaders(mainChain);

			const forkParentA = mainChain[2].hashHex;
			const forkA = buildChain(forkParentA, 2, 200);
			const resultA = db.addHeaders(forkA);
			expect(resultA.headersAddedToLongestChain.length).toBe(0);

			const forkExt = buildChain(forkA.at(-1)!.hashHex, 2, 300);
			const resultB = db.addHeaders(forkExt);

			expect(resultB.headersAddedToLongestChain.length).toBeGreaterThan(0);
			expect(db.getHeaderTip().hashHex).toBe(forkExt.at(-1)!.hashHex);
			expect(resultB.headersAddedToLongestChain.map(h => h.hashHex))
				.toContain(forkExt.at(-1)!.hashHex);
		});

		test('single-header batch: when nAdded > 0 it IS the chain tip', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const batch1 = buildChain(genesisHashHex, 1, 100);
			const result1 = db.addHeaders(batch1);
			expect(result1.headersAddedToLongestChain.length).toBe(1);
			expect(db.getHeaderTip().hashHex).toBe(batch1[0].hashHex);

			const batch2 = buildChain(batch1[0].hashHex, 1, 101);
			const result2 = db.addHeaders(batch2);
			expect(result2.headersAddedToLongestChain.length).toBe(1);
			expect(db.getHeaderTip().hashHex).toBe(batch2[0].hashHex);
		});

		test('duplicate batch: all headers already known, nAdded = 0', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const batch = buildChain(genesisHashHex, 3, 100);
			db.addHeaders(batch);

			const result = db.addHeaders(batch);
			expect(result.headersAddedToLongestChain.length).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(batch.at(-1)!.hashHex);
		});

		test('extensive: for any batch where nAdded > 0, last header is chain tip', () => {
			const genesisHashHex = db.getHeaderTip().hashHex;
			const mainChain = buildChain(genesisHashHex, 5, 100);
			db.addHeaders(mainChain);

			const fork1 = buildChain(mainChain[1].hashHex, 2, 200);
			db.addHeaders(fork1);
			const fork2 = buildChain(mainChain[2].hashHex, 3, 300);
			db.addHeaders(fork2);
			const fork3 = buildChain(mainChain[0].hashHex, 2, 400);
			db.addHeaders(fork3);

			const testCases: { description: string; batch: BlockHeaderMutable[] }[] = [
				{ description: 'Extend fork1 past main chain', batch: buildChain(fork1.at(-1)!.hashHex, 4, 500) },
				{ description: 'Extend main chain further', batch: buildChain(mainChain.at(-1)!.hashHex, 5, 600) },
				{ description: 'Extend fork2 to be longest', batch: buildChain(fork2.at(-1)!.hashHex, 5, 700) },
				{ description: 'Extend fork3 by a lot', batch: buildChain(fork3.at(-1)!.hashHex, 8, 800) },
			];

			for (const { batch } of testCases) {
				const result = db.addHeaders(batch);
				if (result.headersAddedToLongestChain.length > 0) {
					expect(db.getHeaderTip().hashHex).toBe(batch.at(-1)!.hashHex);
					expect(result.headersAddedToLongestChain.map(h => h.hashHex))
						.toContain(batch.at(-1)!.hashHex);
				}
			}
		});
	});

	describe('fromDatabase persistence', () => {
		test('persists the longest chain and reloads it with identical headers, work totals and locator', async () => {
			expect(db.getHeaderTip().height).toBe(0);
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, 300, 10000);
			db.addHeaders(chainFromGenesis);
			expect(db.getHeaderTip().height).toBe(300);
			expect(db.getHeaderTip().hashHex).toBe(chainFromGenesis.at(-1)!.hashHex);

			const expectedHeaders: { hashHex: string; height: number; workTotal: bigint }[] = [];
			for (let h = 0; h <= db.getHeaderTip().height; h++) {
				const header = db.getHeaderFromHeight(h)!;
				expectedHeaders.push({ hashHex: header.hashHex, height: header.height, workTotal: header.workTotal });
			}
			const expectedNumLongestChainHeaders = db.getNumLongestChainHeaders();
			const expectedLocator = db.getBlockLocatorHashBuffers().map(buffer => buffer.toString('hex'));

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: Array.from(getInvalidBlocks(chain)) });
			await db.open();

			// Only the longest chain is persisted; in-memory forks are not recovered.
			expect(db.getHeaderTip().height).toBe(expectedHeaders.length - 1);
			expect(db.getHeaderTip().hashHex).toBe(expectedHeaders.at(-1)!.hashHex);
			expect(db.getNumLongestChainHeaders()).toBe(expectedNumLongestChainHeaders);
			expect(db.getNumAllHeaders()).toBe(expectedNumLongestChainHeaders);
			expect(db.getNumCompetingTips()).toBe(1);
			for (let h = 0; h < expectedHeaders.length; h++) {
				const header = db.getHeaderFromHeight(h)!;
				expect(header.hashHex).toBe(expectedHeaders[h].hashHex);
				expect(header.height).toBe(expectedHeaders[h].height);
				expect(header.workTotal).toBe(expectedHeaders[h].workTotal);
			}
			expect(db.getBlockLocatorHashBuffers().map(buffer => buffer.toString('hex'))).toEqual(expectedLocator);
		});

		test('persists a reorged longest chain and drops the losing branch on reload', async () => {
			const mainChain = buildValidChain(db.getHeaderTip().hashHex, 5, 20000);
			db.addHeaders(mainChain);
			const forkChain = buildValidChain(mainChain[1].hashHex, 6, 30000);// Longer than the main chain, so it wins.
			db.addHeaders(forkChain);
			expect(db.getHeaderTip().height).toBe(8);
			expect(db.getHeaderTip().hashHex).toBe(forkChain.at(-1)!.hashHex);
			expect(db.getHeaderFromHashHex(mainChain.at(-1)!.hashHex)).toBeDefined();

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(8);
			expect(db.getHeaderTip().hashHex).toBe(forkChain.at(-1)!.hashHex);
			expect(db.getHeaderFromHashHex(mainChain.at(-1)!.hashHex)).toBeUndefined();// The losing branch is not persisted.
			const expectedChain = [genesisHeader, ...mainChain.slice(0, 2), ...forkChain];
			let expectedWorkTotal = genesisHeader.work;
			for (let h = 1; h < expectedChain.length; h++) {
				expectedWorkTotal += expectedChain[h].work;
				const header = db.getHeaderFromHeight(h)!;
				expect(header.hashHex).toBe(expectedChain[h].hashHex);
				expect(header.workTotal).toBe(expectedWorkTotal);
			}
		});

		test('loads an empty database as genesis only', async () => {
			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(genesisHeader.hashHex);
			expect(db.getNumAllHeaders()).toBe(1);
			expect(db.getNumLongestChainHeaders()).toBe(1);
			expect(db.getNumCompetingTips()).toBe(1);
		});

		test('truncates at a chain continuity break, deletes the stale entries and can extend on top afterwards', async () => {
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, 10, 500);
			db.addHeaders(chainFromGenesis);
			expect(db.getHeaderTip().height).toBe(10);
			await db.close();

			// Append stale headers at heights 11 and 12 whose parent does not match the height 10 header.
			const level = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await level.open();
			const disconnectedHeader = createValidHeader('11'.repeat(32), 999999);
			const disconnectedHeader2 = createValidHeader(disconnectedHeader.hashHex, 1000000);
			await level.batch([
				{ type: 'put', key: 11, value: disconnectedHeader.buffer },
				{ type: 'put', key: 12, value: disconnectedHeader2.buffer },
			]);
			await level.close();

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(10);
			expect(db.getHeaderTip().hashHex).toBe(chainFromGenesis.at(-1)!.hashHex);
			expect(db.getHeaderFromHeight(11)).toBeUndefined();
			expect(db.getHeaderFromHashHex(disconnectedHeader.hashHex)).toBeUndefined();
			await db.close();
			expect(await getRawDatabaseHeights(databasePath)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);// Stale entries were deleted.

			// Extending on top of the truncated tip must write heights 11 and 12 again.
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			const extension = buildValidChain(chainFromGenesis.at(-1)!.hashHex, 2, 700);
			const result = db.addHeaders(extension);
			expect(result.headersAddedToLongestChain.length).toBe(2);
			expect(db.getHeaderTip().height).toBe(12);
			await db.close();
			expect(await getRawDatabaseHeights(databasePath)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(12);
			expect(db.getHeaderTip().hashHex).toBe(extension.at(-1)!.hashHex);
		});

		test('enforces invalid blocks on load and deletes the invalid tail', async () => {
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, 9, 40000);
			db.addHeaders(chainFromGenesis);
			await db.close();

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [chainFromGenesis[2].hashHex] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(2);
			expect(db.getHeaderTip().hashHex).toBe(chainFromGenesis[1].hashHex);
			expect(db.getHeaderFromHashHex(chainFromGenesis[2].hashHex)).toBeUndefined();
			await db.close();
			expect(await getRawDatabaseHeights(databasePath)).toEqual([1, 2]);
		});

		test('rejects a database containing a header with a zero target', async () => {
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, 10, 50000);
			db.addHeaders(chainFromGenesis);
			await db.close();

			// A header that chains correctly but has compact bits with a zero coefficient (a zero target).
			const level = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await level.open();
			const zeroTargetHeader = createHeader(chainFromGenesis.at(-1)!.hashHex, 123456, '0000001d');
			await level.put(11, zeroTargetHeader.buffer);
			await level.close();

			await expect(BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] })).rejects.toThrow(/Invalid proof of work in database at height 11/);

			// The failed load must release the LevelDB handle so the database can be reopened.
			const levelAfterFailure = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await levelAfterFailure.open();
			await levelAfterFailure.del(11);
			await levelAfterFailure.close();

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(10);
			expect(db.getHeaderTip().hashHex).toBe(chainFromGenesis.at(-1)!.hashHex);
		});

		test('rejects a database containing a header with an invalid compact target exponent', async () => {
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, 10, 60000);
			db.addHeaders(chainFromGenesis);
			await db.close();

			// A header that chains correctly but has compact bits with an exponent below 3 (fractional target).
			const level = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await level.open();
			const invalidBitsHeader = createHeader(chainFromGenesis.at(-1)!.hashHex, 234567, '01000000');
			await level.put(11, invalidBitsHeader.buffer);
			await level.close();

			await expect(BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] })).rejects.toThrow(/Invalid proof of work in database at height 11/);
		});

		test('truncates at a work-checkpoint boundary and can extend on top afterwards', async () => {
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, WORK_CHECKPOINT_INTERVAL + 36, 1600000);
			db.addHeaders(chainFromGenesis);
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL + 36);
			await db.close();

			// Append a stale header whose parent does not match the height 64 header.
			const level = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await level.open();
			const staleHeader = createValidHeader('11'.repeat(32), 1700000);
			await level.put(WORK_CHECKPOINT_INTERVAL + 1, staleHeader.buffer);
			await level.close();

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL);
			expect(db.getHeaderTip().hashHex).toBe(chainFromGenesis[WORK_CHECKPOINT_INTERVAL - 1].hashHex);
			let expectedWorkTotal = genesisHeader.work;
			for (let height = 1; height <= WORK_CHECKPOINT_INTERVAL; height++) expectedWorkTotal += chainFromGenesis[height - 1].work;
			expect(db.getHeaderTip().workTotal).toBe(expectedWorkTotal);
			assertDatabaseInvariants(db);

			// Extending on top of the truncated tip must rebuild the checkpoint and write the heights again.
			const extension = buildValidChain(chainFromGenesis[WORK_CHECKPOINT_INTERVAL - 1].hashHex, 5, 1800000, HARDER_BITS_HEX);
			db.addHeaders(extension);
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL + 5);
			await db.close();
			expect(await getRawDatabaseHeights(databasePath)).toEqual(Array.from({ length: WORK_CHECKPOINT_INTERVAL + 5 }, (_, index) => index + 1));

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL + 5);
			expect(db.getHeaderTip().hashHex).toBe(extension.at(-1)!.hashHex);
			expectedWorkTotal = genesisHeader.work;
			for (let height = 1; height <= WORK_CHECKPOINT_INTERVAL; height++) expectedWorkTotal += chainFromGenesis[height - 1].work;
			for (const header of extension) expectedWorkTotal += header.work;
			expect(db.getHeaderTip().workTotal).toBe(expectedWorkTotal);
			assertDatabaseInvariants(db);
		}, 30000);

		test('truncates at a chunk boundary and can extend on top afterwards', async () => {
			const chainFromGenesis = getBulkChain();
			db.addHeaders(chainFromGenesis);
			expect(db.getHeaderTip().height).toBe(HEADERS_PER_CHUNK + 50);
			await db.close();

			// Append a stale header whose parent does not match the height 12500 header.
			const level = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await level.open();
			const staleHeader = createValidHeader('22'.repeat(32), 2000000);
			await level.put(HEADERS_PER_CHUNK + 1, staleHeader.buffer);
			await level.close();

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(HEADERS_PER_CHUNK);
			expect(db.getHeaderTip().hashHex).toBe(chainFromGenesis[HEADERS_PER_CHUNK - 1].hashHex);
			expect(db.getHeaderFromHashHex(staleHeader.hashHex)).toBeUndefined();
			assertDatabaseInvariants(db, { packedHashCheckStep: 1000 });

			// Extending on top of the truncated tip must write into the second chunk again.
			const extension = buildValidChain(chainFromGenesis[HEADERS_PER_CHUNK - 1].hashHex, 3, 2100000, HARDER_BITS_HEX);
			db.addHeaders(extension);
			expect(db.getHeaderTip().height).toBe(HEADERS_PER_CHUNK + 3);
			expect(db.getHeaderTip().hashHex).toBe(extension.at(-1)!.hashHex);
			assertDatabaseInvariants(db, { packedHashCheckStep: 1000 });
			await db.close();
			expect(await getRawDatabaseHeights(databasePath)).toEqual(Array.from({ length: HEADERS_PER_CHUNK + 3 }, (_, index) => index + 1));
		}, 30000);

		test('getters return distinct copies so callers cannot mutate stored headers', () => {
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, 3, 70000);
			db.addHeaders(chainFromGenesis);
			const first = db.getHeaderTip();
			const second = db.getHeaderTip();
			const fromHashHex = db.getHeaderFromHashHex(first.hashHex)!;
			expect(first).not.toBe(second);
			expect(fromHashHex).not.toBe(first);
			expect(first.hashHex).toBe(second.hashHex);
			expect(() => first.setHeight(first.height + 100)).toThrow();// Copies reject conflicting mutations like the originals.
		});
	});

	describe('work checkpoints and chunk packing', () => {
		test('work totals survive work-checkpoint and chunk boundaries in-session and across a reload', async () => {
			// The chain crosses the WORK_CHECKPOINT_INTERVAL and HEADERS_PER_CHUNK boundaries.
			const chainLength = HEADERS_PER_CHUNK + 100;
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, chainLength, 900000);
			for (let i = 0; i < chainFromGenesis.length; i += 1000) {
				db.addHeaders(chainFromGenesis.slice(i, i + 1000));
			}
			expect(db.getHeaderTip().height).toBe(chainLength);
			expect(db.getHeaderTip().hashHex).toBe(chainFromGenesis.at(-1)!.hashHex);
			expect(((db as any)._chunks as Buffer[]).length).toBe(Math.floor(chainLength / HEADERS_PER_CHUNK) + 1);

			const heightsToCheck = new Set([
				1,
				WORK_CHECKPOINT_INTERVAL - 1,
				WORK_CHECKPOINT_INTERVAL,
				WORK_CHECKPOINT_INTERVAL + 1,
				2 * WORK_CHECKPOINT_INTERVAL,
				HEADERS_PER_CHUNK - 1,
				HEADERS_PER_CHUNK,
				HEADERS_PER_CHUNK + 1,
				chainLength
			]);
			const expectedWorkTotals = new Map<number, bigint>();
			let workTotal = genesisHeader.work;
			for (let h = 1; h <= chainLength; h++) {
				workTotal += chainFromGenesis[h - 1].work;
				if (heightsToCheck.has(h)) {
					expectedWorkTotals.set(h, workTotal);
				}
			}
			const expectWorkTotals = () => {
				for (const [h, expectedWorkTotal] of expectedWorkTotals) {
					const header = db.getHeaderFromHeight(h)!;
					expect(header.hashHex).toBe(chainFromGenesis[h - 1].hashHex);
					expect(header.workTotal).toBe(expectedWorkTotal);
				}
			};
			expectWorkTotals();
			const middleHeight = 2 * WORK_CHECKPOINT_INTERVAL;
			const middleHeader = db.getHeaderFromHashHex(chainFromGenesis[middleHeight - 1].hashHex)!;
			expect(middleHeader.height).toBe(middleHeight);
			expect(middleHeader.workTotal).toBe(expectedWorkTotals.get(middleHeight));

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(chainLength);
			expectWorkTotals();
		});

		test('reorgs with the divergence at and just below a work-checkpoint boundary keep work totals correct', async () => {
			const mainChain = buildValidChain(db.getHeaderTip().hashHex, WORK_CHECKPOINT_INTERVAL + 104, 100000);
			db.addHeaders(mainChain);
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL + 104);

			// This fork diverges exactly at the work checkpoint height.
			const forkA = buildValidChain(mainChain[WORK_CHECKPOINT_INTERVAL - 1].hashHex, 200, 200000);
			db.addHeaders(forkA);
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL + 200);
			expect(db.getHeaderTip().hashHex).toBe(forkA.at(-1)!.hashHex);

			// This fork diverges below the checkpoint height, forcing that checkpoint to be rebuilt.
			const forkB = buildValidChain(mainChain[WORK_CHECKPOINT_INTERVAL - 2].hashHex, 250, 300000);
			db.addHeaders(forkB);
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL + 249);
			expect(db.getHeaderTip().hashHex).toBe(forkB.at(-1)!.hashHex);

			const workPerHeader = mainChain[0].work;
			const expectedWorkTotal = (h: number) => genesisHeader.work + BigInt(h) * workPerHeader;
			const expectedHashHexAt = (h: number) => h <= WORK_CHECKPOINT_INTERVAL - 1 ? mainChain[h - 1].hashHex : forkB[h - WORK_CHECKPOINT_INTERVAL].hashHex;
			const heightsToCheck = [
				WORK_CHECKPOINT_INTERVAL - 1,
				WORK_CHECKPOINT_INTERVAL,
				WORK_CHECKPOINT_INTERVAL + 1,
				WORK_CHECKPOINT_INTERVAL + 104,
				WORK_CHECKPOINT_INTERVAL + 200,
				WORK_CHECKPOINT_INTERVAL + 249
			];
			for (const h of heightsToCheck) {
				const header = db.getHeaderFromHeight(h)!;
				expect(header.hashHex).toBe(expectedHashHexAt(h));
				expect(header.workTotal).toBe(expectedWorkTotal(h));
			}
			// The previous longest chain is retained as a fork with its work total.
			const forkATip = db.getHeaderFromHashHex(forkA.at(-1)!.hashHex)!;
			expect(forkATip.height).toBe(WORK_CHECKPOINT_INTERVAL + 200);
			expect(forkATip.workTotal).toBe(expectedWorkTotal(WORK_CHECKPOINT_INTERVAL + 200));

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(WORK_CHECKPOINT_INTERVAL + 249);
			expect(db.getHeaderTip().hashHex).toBe(forkB.at(-1)!.hashHex);
			for (const h of heightsToCheck) {
				const header = db.getHeaderFromHeight(h)!;
				expect(header.hashHex).toBe(expectedHashHexAt(h));
				expect(header.workTotal).toBe(expectedWorkTotal(h));
			}
		});

		test('work totals remain correct when difficulty bits vary between headers', async () => {
			const bitsSequence = [EASY_BITS_HEX, 'ffff7f1f'];// Both are easy to mine but have different work values.
			const varyingWorkChain: BlockHeaderMutable[] = [];
			let prevHashHex = db.getHeaderTip().hashHex;
			for (let i = 0; i < 200; i++) {
				const header = createValidHeader(prevHashHex, 500000 + i, bitsSequence[i % bitsSequence.length]);
				varyingWorkChain.push(header);
				prevHashHex = header.hashHex;
			}
			db.addHeaders(varyingWorkChain);
			expect(db.getHeaderTip().height).toBe(200);

			const expectedWorkTotal = (h: number) => genesisHeader.work + varyingWorkChain.slice(0, h).reduce((sum, header) => sum + header.work, 0n);
			const heightsToCheck = [1, 50, 100, 199, 200];
			for (const h of heightsToCheck) {
				expect(db.getHeaderFromHeight(h)!.workTotal).toBe(expectedWorkTotal(h));
			}

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			for (const h of heightsToCheck) {
				expect(db.getHeaderFromHeight(h)!.workTotal).toBe(expectedWorkTotal(h));
			}
		});
	});

	describe('block locator and branch persistence', () => {
		test('getBlockLocatorHashBuffers follows the height schedule down to genesis', () => {
			expect(db.getBlockLocatorHashBuffers().map(buffer => buffer.toString('hex'))).toEqual([genesisHeader.hashBuffer.toString('hex')]);

			const chainFromGenesis = buildChain(db.getHeaderTip().hashHex, 300, 400000);
			db.addHeaders(chainFromGenesis);
			const expectedHashes: Buffer[] = [];
			let step = 1;
			for (let i = 300; i > 0; i -= step) {
				if (expectedHashes.length >= 10) {
					step *= 2;
				}
				expectedHashes.push(chainFromGenesis[i - 1].hashBuffer);
			}
			expectedHashes.push(genesisHeader.hashBuffer);
			expect(db.getBlockLocatorHashBuffers().map(buffer => buffer.toString('hex'))).toEqual(expectedHashes.map(buffer => buffer.toString('hex')));
		});

		test('fork headers are available in-session but are not persisted across a reload', async () => {
			const mainChain = buildValidChain(db.getHeaderTip().hashHex, 4, 600000);
			db.addHeaders(mainChain);
			const forkHeader = buildValidChain(mainChain[1].hashHex, 1, 700000)[0];
			db.addHeaders([forkHeader]);
			expect(db.getHeaderFromHashHex(forkHeader.hashHex)?.height).toBe(3);
			expect(db.getNumAllHeaders()).toBe(6);// Genesis + 4 main chain + 1 fork.
			expect(db.getNumCompetingTips()).toBe(2);

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderFromHashHex(forkHeader.hashHex)).toBeUndefined();
			expect(db.getNumAllHeaders()).toBe(5);
			expect(db.getNumCompetingTips()).toBe(1);
			expect(db.getHeaderTip().hashHex).toBe(mainChain.at(-1)!.hashHex);
		});
	});

	describe('reorg edge cases', () => {
		test('reorg across a chunk boundary rewrites packed chunks and survives a reload', async () => {
			const mainChain = getBulkChain();
			db.addHeaders(mainChain);
			expect(db.getHeaderTip().height).toBe(HEADERS_PER_CHUNK + 50);

			// The fork starts inside the first chunk and extends into the second one.
			const forkParentHeight = HEADERS_PER_CHUNK - 9;
			const forkStartHeight = forkParentHeight + 1;
			const fork = buildValidChain(mainChain[forkParentHeight - 1].hashHex, 20, 1000000, HARDEST_BITS_HEX);
			const result = db.addHeaders(fork);
			expect(result.headersRemovedFromLongestChain.length).toBe(59);
			expect(result.headersAddedToLongestChain.length).toBe(fork.length);
			expect(db.getHeaderTip().hashHex).toBe(fork.at(-1)!.hashHex);
			expect(db.getHeaderTip().height).toBe(forkStartHeight + fork.length - 1);

			const expectedHeaderAtHeight = (height: number) => height < forkStartHeight ? mainChain[height - 1] : fork[height - forkStartHeight];
			const selectedHeights = [1, HEADERS_PER_CHUNK - 10, HEADERS_PER_CHUNK - 9, forkStartHeight, forkStartHeight + 1, HEADERS_PER_CHUNK, HEADERS_PER_CHUNK + 1, db.getHeaderTip().height];
			const selectedHeightsSet = new Set(selectedHeights);
			const expectedWorkTotals = new Map<number, bigint>();
			let expectedWorkTotal = genesisHeader.work;
			for (let height = 1; height <= db.getHeaderTip().height; height++) {
				expectedWorkTotal += expectedHeaderAtHeight(height).work;
				if (selectedHeightsSet.has(height)) expectedWorkTotals.set(height, expectedWorkTotal);
			}
			for (const [height, workTotal] of expectedWorkTotals) {
				const header = db.getHeaderFromHeight(height)!;
				expect(header.hashHex).toBe(expectedHeaderAtHeight(height).hashHex);
				expect(header.workTotal).toBe(workTotal);
			}
			assertDatabaseInvariants(db, { packedHashCheckStep: 1000 });

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().hashHex).toBe(fork.at(-1)!.hashHex);
			expect(db.getHeaderTip().height).toBe(forkStartHeight + fork.length - 1);
			assertDatabaseInvariants(db, { packedHashCheckStep: 1000 });
		}, 30000);

		test('reorg to a shorter but heavier chain keeps heights, work totals and forks correct', async () => {
			const lightChain = buildValidChain(db.getHeaderTip().hashHex, 100, 1100000);
			db.addHeaders(lightChain);
			expect(db.getHeaderTip().height).toBe(100);

			// 60 headers at ~8 work each beat the remaining 95 headers at ~2 work each.
			const heavyChain = buildValidChain(lightChain[4].hashHex, 60, 1200000, HARDEST_BITS_HEX);
			const result = db.addHeaders(heavyChain);
			expect(result.headersRemovedFromLongestChain.length).toBe(95);
			expect(result.headersAddedToLongestChain.length).toBe(heavyChain.length);
			expect(db.getHeaderTip().hashHex).toBe(heavyChain.at(-1)!.hashHex);
			expect(db.getHeaderTip().height).toBe(65);

			let expectedWorkTotal = genesisHeader.work;
			for (let height = 1; height <= 5; height++) {
				expectedWorkTotal += lightChain[height - 1].work;
				expect(db.getHeaderFromHeight(height)!.workTotal).toBe(expectedWorkTotal);
			}
			for (let i = 0; i < heavyChain.length; i++) {
				expectedWorkTotal += heavyChain[i].work;
				const header = db.getHeaderFromHeight(6 + i)!;
				expect(header.hashHex).toBe(heavyChain[i].hashHex);
				expect(header.workTotal).toBe(expectedWorkTotal);
			}
			expect(db.getHeaderFromHeight(66)).toBeUndefined();

			// The losing chain is retained as a fork.
			expect(db.getHeaderFromHashHex(lightChain.at(-1)!.hashHex)?.height).toBe(100);
			assertDatabaseInvariants(db);

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(65);
			expect(db.getHeaderTip().hashHex).toBe(heavyChain.at(-1)!.hashHex);
			expect(db.getHeaderFromHashHex(lightChain.at(-1)!.hashHex)).toBeUndefined();
			assertDatabaseInvariants(db);
		}, 30000);

		test('a longer but lighter fork does not replace the longest chain', () => {
			const mainChain = buildValidChain(db.getHeaderTip().hashHex, 10, 1300000, HARDEST_BITS_HEX);
			db.addHeaders(mainChain);
			expect(db.getHeaderTip().height).toBe(10);

			// This fork is taller (13 headers) but has less total work (13 * 2 < 5 * 8).
			const lighterFork = buildValidChain(mainChain[4].hashHex, 13, 1400000, EASY_BITS_HEX);
			const result = db.addHeaders(lighterFork);
			expect(result.headersRemovedFromLongestChain.length).toBe(0);
			expect(result.headersAddedToLongestChain.length).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(mainChain.at(-1)!.hashHex);
			expect(db.getHeaderTip().height).toBe(10);

			const forkTip = db.getHeaderFromHashHex(lighterFork.at(-1)!.hashHex)!;
			expect(forkTip.height).toBe(18);
			expect(forkTip.workTotal).toBe(db.getHeaderFromHeight(5)!.workTotal + BigInt(lighterFork.length) * lighterFork[0].work);
			// Fork heights beyond the longest chain tip are only reachable by hash, not by height.
			expect(db.getHeaderFromHeight(18)).toBeUndefined();
			expect(db.getNumCompetingTips()).toBe(2);
			assertDatabaseInvariants(db);
		});

		test('reorg divergence sweep around work-checkpoint boundaries keeps all work totals correct', async () => {
			const mainChainLength = 260;
			const mainChain = buildValidChain(genesisHeader.hashHex, mainChainLength, 1500000);
			const divergenceHeights = [63, 64, 65, 255, 256];
			for (const divergenceHeight of divergenceHeights) {
				if (db) {
					await db.close();
				}
				await removeDirectoryWithRetries(databasePath);
				await mkdir(databasePath);
				db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({ databasePath, invalidBlocks: Array.from(getInvalidBlocks(chain)) }));

				// Long enough to win on work despite the main chain being longer.
				const forkLength = Math.ceil((mainChainLength - divergenceHeight) / 4) + 2;
				const fork = buildValidChain(mainChain[divergenceHeight - 1].hashHex, forkLength, 1600000 + divergenceHeight * 10007, HARDEST_BITS_HEX);
				db.addHeaders(mainChain);
				const result = db.addHeaders(fork);
				expect(result.headersRemovedFromLongestChain.length).toBe(mainChainLength - divergenceHeight);
				expect(result.headersAddedToLongestChain.length).toBe(fork.length);
				expect(db.getHeaderTip().hashHex).toBe(fork.at(-1)!.hashHex);
				expect(db.getHeaderTip().height).toBe(divergenceHeight + fork.length);

				// Every height's work total must be correct after the checkpoint at or below the divergence was rebuilt.
				const internal = db as any;
				const heightToHash = internal._heightToHash as string[];
				const expectedWorkTotals = new Map<number, bigint>();
				let expectedWorkTotal = genesisHeader.work;
				for (let height = 1; height <= divergenceHeight; height++) {
					expectedWorkTotal += mainChain[height - 1].work;
					expect(heightToHash[height]).toBe(mainChain[height - 1].hashHex);
					expect(internal._getWorkTotalFromHeight(height)).toBe(expectedWorkTotal);
					expectedWorkTotals.set(height, expectedWorkTotal);
				}
				for (let i = 0; i < fork.length; i++) {
					expectedWorkTotal += fork[i].work;
					expect(heightToHash[divergenceHeight + 1 + i]).toBe(fork[i].hashHex);
					expect(internal._getWorkTotalFromHeight(divergenceHeight + 1 + i)).toBe(expectedWorkTotal);
					expectedWorkTotals.set(divergenceHeight + 1 + i, expectedWorkTotal);
				}
				// The public getter must agree with the internal work totals at the divergence and the tip.
				for (const height of [divergenceHeight, divergenceHeight + 1, db.getHeaderTip().height]) {
					const header = db.getHeaderFromHeight(height)!;
					expect(header.workTotal).toBe(expectedWorkTotals.get(height));
				}
				assertDatabaseInvariants(db);
			}
		}, 60000);

		test('a fork with equal total work does not replace the longest chain and pruneBranches keeps the chain tip', () => {
			const mainChain = buildValidChain(genesisHeader.hashHex, 2, 2300000, ALWAYS_VALID_BITS_HEX);
			db.addHeaders(mainChain);

			// Every header has work 1, so both branches have exactly the same total work.
			const equalFork = buildValidChain(genesisHeader.hashHex, 2, 2400000, ALWAYS_VALID_BITS_HEX);
			const result = db.addHeaders(equalFork);
			expect(result.headersRemovedFromLongestChain.length).toBe(0);
			expect(result.headersAddedToLongestChain.length).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(mainChain.at(-1)!.hashHex);
			expect(db.getNumCompetingTips()).toBe(2);

			expect(db.pruneBranches()).toBe(1);
			expect(db.getNumCompetingTips()).toBe(1);
			expect((db as any)._headersTreeLeafHashes.has(mainChain.at(-1)!.hashHex)).toBe(true);
			assertDatabaseInvariants(db);
		});

		test('releases packed chunks that are no longer needed after a reorg to a shorter chain', () => {
			const mainChain = getBulkChain();
			db.addHeaders(mainChain);
			expect(db.getHeaderTip().height).toBe(HEADERS_PER_CHUNK + 50);
			expect(((db as any)._chunks as Buffer[]).length).toBe(Math.floor((HEADERS_PER_CHUNK + 50) / HEADERS_PER_CHUNK) + 1);

			// This fork starts near the end of the first packed chunk and wins with 2 high work
			// headers, so the new tip is shorter than the second chunk and it must be released.
			const winningFork = buildValidChain(mainChain[HEADERS_PER_CHUNK - 101].hashHex, 2, 2600000, WORK_256_BITS_HEX);
			const result = db.addHeaders(winningFork);
			expect(result.headersRemovedFromLongestChain.length).toBe(HEADERS_PER_CHUNK + 50 - (HEADERS_PER_CHUNK - 100));
			expect(result.headersAddedToLongestChain.length).toBe(winningFork.length);
			expect(db.getHeaderTip().height).toBe(HEADERS_PER_CHUNK - 98);
			expect(((db as any)._chunks as Buffer[]).length).toBe(1);
			assertDatabaseInvariants(db, { packedHashCheckStep: 1000 });
		}, 30000);
	});

	describe('compact target overflow protection', () => {
		test('a zero work header must not exit pruneBranches', () => {
			const zeroWorkHeader = createHeader(genesisHeader.hashHex, 100, 'ffffff21');
			let addError: unknown;
			try {
				db.addHeaders([zeroWorkHeader]);
			} catch (error) {
				addError = error;
			}

			expect(db.getHeaderTip().hashHex).toBe(genesisHeader.hashHex);
			// A zero work child of the chain tip displaces it from the leaf set, so pruning must
			// not assume the chain tip is still tracked as a leaf.
			expect(db.pruneBranches()).toBe(0);
			expect(db.getNumCompetingTips()).toBe(1);
			expect(addError).toBeInstanceOf(Error);
			expect((addError as Error | undefined)?.message).toBe('Invalid target: exceeds the maximum hash');
			assertDatabaseInvariants(db, { checkForkGetters: false });
		});

		test('rejects a database containing a header with a compact target above 2^256', async () => {
			const chainFromGenesis = buildValidChain(db.getHeaderTip().hashHex, 10, 2700000, ALWAYS_VALID_BITS_HEX);
			db.addHeaders(chainFromGenesis);
			await db.close();

			// A header that chains correctly but has compact bits whose target overflows 2^256.
			const level = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await level.open();
			const overflowHeader = createHeader(chainFromGenesis.at(-1)!.hashHex, 567890, 'ffffff21');
			await level.put(11, overflowHeader.buffer);
			await level.close();

			await expect(BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] })).rejects.toThrow(/Invalid proof of work in database at height 11/);

			// The failed load must release the LevelDB handle so the database can be reopened.
			const levelAfterFailure = new Level<number, Buffer>(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
			await levelAfterFailure.open();
			await levelAfterFailure.del(11);
			await levelAfterFailure.close();

			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			expect(db.getHeaderTip().height).toBe(10);
		});
	});

	describe('internal invariants', () => {
		test('hold after creation, normal extension, forks, reorgs and pruneBranches', () => {
			assertDatabaseInvariants(db);
			const mainChain = buildValidChain(db.getHeaderTip().hashHex, 150, 2200000);
			db.addHeaders(mainChain);
			assertDatabaseInvariants(db);

			// A losing fork and a winning fork.
			db.addHeaders(buildValidChain(mainChain[100].hashHex, 5, 2300000));
			assertDatabaseInvariants(db);
			db.addHeaders(buildValidChain(mainChain[50].hashHex, 120, 2400000, HARDER_BITS_HEX));
			assertDatabaseInvariants(db);

			db.pruneBranches();
			assertDatabaseInvariants(db);
			expect(db.getNumCompetingTips()).toBe(1);
			expect(db.getNumAllHeaders()).toBe(db.getNumLongestChainHeaders());
		});

		test('hold across a close and reload', async () => {
			db.addHeaders(buildValidChain(db.getHeaderTip().hashHex, 200, 2500000));
			db.addHeaders(buildValidChain(db.getHeaderFromHeight(100)!.hashHex, 150, 2600000, HARDER_BITS_HEX));
			assertDatabaseInvariants(db);

			await db.close();
			db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
			await db.open();
			assertDatabaseInvariants(db);
			expect(db.getNumCompetingTips()).toBe(1);
		});
	});

	describe('reference model fuzz', () => {
		test('random chains, forks, prunes and reloads keep the database consistent with a reference model', async () => {
			type ReferenceHeader = {
				prevHashHex: string;
				height: number;
				workTotal: bigint;
				childHashes: Set<string>;
			};
			const reference = new Map<string, ReferenceHeader>();
			reference.set(genesisHeader.hashHex, {
				prevHashHex: '0'.repeat(64),
				height: 0,
				workTotal: genesisHeader.work,
				childHashes: new Set()
			});
			const everAddedHashes = new Set<string>([genesisHeader.hashHex]);

			let rngState = 123456789;
			const random = () => {
				rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
				return rngState / 4294967296;
			};
			let nonceCounter = 2200000;
			const bitsOptions = [EASY_BITS_HEX, HARDER_BITS_HEX, HARDEST_BITS_HEX];

			const getReferenceLeaves = (): string[] => {
				const leaves: string[] = [];
				for (const [hashHex, referenceHeader] of reference) {
					if (!referenceHeader.childHashes.size) leaves.push(hashHex);
				}
				return leaves;
			};

			const rebuildReferenceChildren = (): void => {
				for (const referenceHeader of reference.values()) referenceHeader.childHashes.clear();
				for (const [hashHex, referenceHeader] of reference) {
					if (hashHex === genesisHeader.hashHex) continue;
					reference.get(referenceHeader.prevHashHex)!.childHashes.add(hashHex);
				}
			};

			const getReferenceMainChain = (): [string, ReferenceHeader][] => {
				const chain: [string, ReferenceHeader][] = [];
				let hashHex = db.getHeaderTip().hashHex;
				while (true) {
					const referenceHeader = reference.get(hashHex);
					if (!referenceHeader) throw new Error(`Database tip ${hashHex} is not in the reference model`);
					chain.push([hashHex, referenceHeader]);
					if (hashHex === genesisHeader.hashHex) break;
					hashHex = referenceHeader.prevHashHex;
				}
				chain.reverse();
				return chain;
			};

			const validateAgainstReference = (): void => {
				const internal = db as any;
				const heightToHash = internal._heightToHash as string[];
				const mainChain = getReferenceMainChain();
				const leaves = getReferenceLeaves();
				let maxLeafWorkTotal = 0n;
				for (const leafHashHex of leaves) {
					const leafWorkTotal = reference.get(leafHashHex)!.workTotal;
					if (leafWorkTotal > maxLeafWorkTotal) maxLeafWorkTotal = leafWorkTotal;
				}
				expect(db.getHeaderTip().workTotal).toBe(maxLeafWorkTotal);
				expect(db.getHeaderTip().height).toBe(mainChain.length - 1);
				expect(heightToHash.length).toBe(mainChain.length);
				let chainError: string | undefined;
				for (let height = 0; height < mainChain.length; height++) {
					if (heightToHash[height] !== mainChain[height][0]) {
						chainError ??= `Main chain hash is wrong at height ${height}.`;
					}
				}
				expect(chainError).toBeUndefined();
				// Check the work totals and the public getters on a spread of sampled heights.
				const sampledHeights = new Set([0, 1, 2, mainChain.length - 2, mainChain.length - 1]);
				for (let height = 3; height < mainChain.length - 2; height += 32) sampledHeights.add(height);
				for (const height of sampledHeights) {
					if (height < 0 || height >= mainChain.length) continue;
					const [hashHex, referenceHeader] = mainChain[height];
					expect(internal._getWorkTotalFromHeight(height)).toBe(referenceHeader.workTotal);
					const header = db.getHeaderFromHeight(height)!;
					expect(header.hashHex).toBe(hashHex);
					expect(header.height).toBe(height);
					expect(header.workTotal).toBe(referenceHeader.workTotal);
				}
				const mainChainHashes = new Set(mainChain.map(([hashHex]) => hashHex));
				const forkHeaders = internal._forkHeaders as Map<string, { height: number; workTotal: bigint }>;
				let numForkHeaders = 0;
				let forkError: string | undefined;
				let forkGetterCheckCounter = 0;
				for (const [hashHex, referenceHeader] of reference) {
					if (mainChainHashes.has(hashHex)) continue;
					numForkHeaders++;
					const forkRecord = forkHeaders.get(hashHex);
					if (!forkRecord || forkRecord.height !== referenceHeader.height || forkRecord.workTotal !== referenceHeader.workTotal) {
						forkError ??= `Fork header ${hashHex} is missing or inconsistent.`;
					}
					if (forkGetterCheckCounter++ % 16 === 0) {
						const forkHeader = db.getHeaderFromHashHex(hashHex)!;
						expect(forkHeader.height).toBe(referenceHeader.height);
						expect(forkHeader.workTotal).toBe(referenceHeader.workTotal);
					}
				}
				expect(forkError).toBeUndefined();
				expect(db.getNumAllHeaders()).toBe(mainChain.length + numForkHeaders);
				expect(db.getNumCompetingTips()).toBe(leaves.length);
				assertDatabaseInvariants(db, { packedHashCheckStep: 16, checkForkGetters: false });
			};

			const addReferenceHeader = (header: BlockHeaderMutable, parentHashHex: string, parentReferenceHeader: ReferenceHeader): void => {
				reference.set(header.hashHex, {
					prevHashHex: parentHashHex,
					height: parentReferenceHeader.height + 1,
					workTotal: parentReferenceHeader.workTotal + header.work,
					childHashes: new Set()
				});
				parentReferenceHeader.childHashes.add(header.hashHex);
				everAddedHashes.add(header.hashHex);
			};

			// The returned changes must exactly describe the main chain diff that LevelDB persistence
			// and the new_chain_tip emit rely on.
			const expectChainDiffMatches = (result: { headersRemovedFromLongestChain: { hashHex: string }[]; headersAddedToLongestChain: { hashHex: string }[] }, previousMainChainHashes: Set<string>): void => {
				const newMainChainHashes = new Set(getReferenceMainChain().map(([hashHex]) => hashHex));
				const expectedAdded = Array.from(newMainChainHashes).filter(hashHex => !previousMainChainHashes.has(hashHex)).sort();
				const expectedRemoved = Array.from(previousMainChainHashes).filter(hashHex => !newMainChainHashes.has(hashHex)).sort();
				expect(result.headersAddedToLongestChain.map(header => header.hashHex).sort()).toEqual(expectedAdded);
				expect(result.headersRemovedFromLongestChain.map(header => header.hashHex).sort()).toEqual(expectedRemoved);
			};

			const addChain = (parentHashHex: string, length: number, options?: { forcedBitsHex?: string; oneAtATime?: boolean; duplicates?: boolean }): void => {
				const headers: BlockHeaderMutable[] = [];
				let prevHashHex = parentHashHex;
				for (let i = 0; i < length; i++) {
					const bitsHex = options?.forcedBitsHex ?? bitsOptions[Math.floor(random() * bitsOptions.length)];
					const header = createValidHeader(prevHashHex, nonceCounter, bitsHex);
					nonceCounter += 997;
					headers.push(header);
					prevHashHex = header.hashHex;
				}
				if (options?.oneAtATime || options?.duplicates) {
					let currentParentHashHex = parentHashHex;
					for (const header of headers) {
						const parentReferenceHeader = reference.get(currentParentHashHex);
						if (!parentReferenceHeader) {
							// The parent is unknown (for example pruned): the database must ignore this header.
							const ignoredResult = db.addHeaders([header]);
							expect(ignoredResult.headersAddedToLongestChain.length).toBe(0);
							expect(ignoredResult.headersRemovedFromLongestChain.length).toBe(0);
							continue;
						}
						const previousMainChainHashes = new Set(getReferenceMainChain().map(([hashHex]) => hashHex));
						const result = db.addHeaders(options.duplicates ? [header, header] : [header]);
						addReferenceHeader(header, currentParentHashHex, parentReferenceHeader);
						expectChainDiffMatches(result, previousMainChainHashes);
						currentParentHashHex = header.hashHex;
						if (options.oneAtATime) validateAgainstReference();
					}
				} else {
					const previousMainChainHashes = new Set(getReferenceMainChain().map(([hashHex]) => hashHex));
					const result = db.addHeaders(headers);
					let currentParentHashHex = parentHashHex;
					for (const header of headers) {
						const parentReferenceHeader = reference.get(currentParentHashHex);
						if (!parentReferenceHeader) break;
						addReferenceHeader(header, currentParentHashHex, parentReferenceHeader);
						currentParentHashHex = header.hashHex;
					}
					expectChainDiffMatches(result, previousMainChainHashes);
				}
			};

			const prune = (): void => {
				const mainChain = getReferenceMainChain();
				const mainChainHashes = new Set(mainChain.map(([hashHex]) => hashHex));
				const numLeavesBefore = getReferenceLeaves().length;
				for (const hashHex of Array.from(reference.keys())) {
					if (!mainChainHashes.has(hashHex)) reference.delete(hashHex);
				}
				rebuildReferenceChildren();
				expect(db.pruneBranches()).toBe(Math.max(0, numLeavesBefore - 1));
				validateAgainstReference();
			};

			const reload = async (): Promise<void> => {
				const mainChain = getReferenceMainChain();
				const mainChainHashes = new Set(mainChain.map(([hashHex]) => hashHex));
				for (const hashHex of Array.from(reference.keys())) {
					if (!mainChainHashes.has(hashHex)) reference.delete(hashHex);
				}
				rebuildReferenceChildren();
				await db.close();
				db = await BlockHeadersDatabase.fromDatabase({ databasePath, invalidBlocks: [] });
				await db.open();
				validateAgainstReference();
			};

			let prunedHashes: string[] = [];
			const updatePrunedHashes = (): void => {
				prunedHashes = Array.from(everAddedHashes).filter(hashHex => !reference.has(hashHex));
			};

			validateAgainstReference();
			for (let operation = 0; operation < 100; operation++) {
				const roll = random();
				if (roll < 0.5) {
					const hashes = Array.from(reference.keys());
					addChain(hashes[Math.floor(random() * hashes.length)], 1 + Math.floor(random() * 6));
				} else if (roll < 0.6) {
					const hashes = Array.from(reference.keys());
					addChain(hashes[Math.floor(random() * hashes.length)], 1 + Math.floor(random() * 4), { oneAtATime: true });
				} else if (roll < 0.68) {
					const hashes = Array.from(reference.keys());
					addChain(hashes[Math.floor(random() * hashes.length)], 1 + Math.floor(random() * 3), { duplicates: true });
				} else if (roll < 0.76) {
					if (prunedHashes.length) {
						addChain(prunedHashes[Math.floor(random() * prunedHashes.length)], 1 + Math.floor(random() * 3));
					}
				} else if (roll < 0.86) {
					prune();
					updatePrunedHashes();
				} else if (roll < 0.95) {
					await reload();
					updatePrunedHashes();
				} else {
					// Extend an existing fork with high-work headers so it takes over the longest chain.
					const mainChain = getReferenceMainChain();
					const mainChainHashes = new Set(mainChain.map(([hashHex]) => hashHex));
					const forkHashes = Array.from(reference.keys()).filter(hashHex => !mainChainHashes.has(hashHex));
					if (forkHashes.length) {
						addChain(forkHashes[0], 1 + Math.floor(random() * 4), { forcedBitsHex: HARDEST_BITS_HEX });
					} else {
						addChain(mainChain[Math.max(0, mainChain.length - 3)][0], 2, { forcedBitsHex: HARDEST_BITS_HEX });
					}
				}
				validateAgainstReference();
			}
		}, 60000);
	});
});