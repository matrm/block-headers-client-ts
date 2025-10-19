import { BlockHeadersClient } from '../BlockHeadersClient.js';
import { getMemoryUsageString } from '../utils/util.js';
import config from './config.js';

export const startClient = async (client: BlockHeadersClient) => {
	const timeBeforeMs = performance.now();
	await client.start();
	const timeAfterMs = performance.now();
	if (config.CONSOLE_DEBUG_LOG) {
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
	}
	console.log('Started.');
};