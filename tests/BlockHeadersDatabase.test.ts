import { mkdir } from 'node:fs/promises';

import { expect, test, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import { BlockHeaderMutable } from '../src/BlockHeader';
import { BlockHeadersDatabase } from '../src/BlockHeadersDatabase';
import { Chain, getInvalidBlocks } from '../src/chainProtocol';
import { DEFAULT_DATABASE_PATH } from '../src/constants';
import { getRandomHexString } from '../src/utils/util';

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

// --- Tests for BlockHeadersDatabase ---
describe('BlockHeadersDatabase', () => {
	let db: BlockHeadersDatabase;
	let databasePath: string;

	beforeEach(async (context) => {
		databasePath = getRandomHexString(16);

		await mkdir(databasePath, { recursive: true });

		db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({ databasePath, invalidBlocks: getInvalidBlocks(chain) }));
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
		}
		expect(db.getHeaderTip().height).toBe(headersBeforeReorg.length);
		expect(db.getHeaderTip().hashHex).toBe(headersBeforeReorg.at(-1)?.hashHex);
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
	})
});