import { expect, test, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

import { BlockHeadersClient } from '../src/BlockHeadersClient';
import { getMemoryUsageString } from '../src/utils/util';
import { DEFAULT_DATABASE_PATH } from '../src/constants';

const chain = 'bsv';

test('start', { timeout: 10 * 60 * 1000 }, async () => {
	const timeBeforeLoadingClientMs = performance.now();
	await using client = await BlockHeadersClient.create({
		chain,
		databasePath: DEFAULT_DATABASE_PATH,
		enableConsoleDebugLog: false,
	});
	const timeAfterLoadingClientMs = performance.now();
	console.log(`Time to load client: ${timeAfterLoadingClientMs - timeBeforeLoadingClientMs}ms.`);

	client.on('new_chain_tip', (height: number, hashHex: string) => {
		const unixTime = Math.floor(Date.now() / 1000);
		console.log(`${unixTime} - Received new chain tip ${height}:`, hashHex);
	});

	console.log("#".repeat(40));
	console.log(`Tip height before syncing: ${client.getHeaderTip().height}`);
	console.log(`Tip hashHex before syncing: ${client.getHeaderTip().hashHex}`);
	console.log('Memory usage before syncing:');
	console.log(getMemoryUsageString());
	console.log("#".repeat(40));

	const timeBeforeMs = performance.now();
	await client.start();
	const timeAfterMs = performance.now();
	console.log(`Time to start: ${timeAfterMs - timeBeforeMs}ms.`);
	console.log("#".repeat(40));
	console.log("#".repeat(40));
	console.log("#".repeat(40));
	console.log("#".repeat(15), 'Started', '#'.repeat(15));
	console.log("#".repeat(40));
	console.log("#".repeat(40));
	console.log("#".repeat(40));
	console.log(`Tip height after syncing: ${client.getHeaderTip().height}`);
	console.log(`Tip hashHex after syncing: ${client.getHeaderTip().hashHex}`);
	console.log('Memory usage after syncing:');
	console.log(getMemoryUsageString());
	console.log("#".repeat(40));
});