/// <reference types="node" />
import { mkdir } from 'node:fs/promises';

import { expect, test, describe, beforeEach, afterEach } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import { BlockHeadersClient } from '../src/BlockHeadersClient';
import { BlockHeadersDatabase } from '../src/BlockHeadersDatabase';
import { NodesDatabase } from '../src/NodesDatabase';
import { Chain, getInvalidBlocks } from '../src/chainProtocol';
import { getRandomHexString } from '../src/utils/util';

const chain: Chain = 'bsv';

describe('BlockHeadersClient queue recovery', () => {
	let client: BlockHeadersClient;
	let nodesDb: NodesDatabase;
	let headersDb: BlockHeadersDatabase;
	let nodesPath: string;
	let headersPath: string;

	beforeEach(async () => {
		nodesPath = `tests/db/client-nodes-${getRandomHexString(16)}`;
		headersPath = `tests/db/client-headers-${getRandomHexString(16)}`;
		await mkdir(nodesPath, { recursive: true });
		await mkdir(headersPath, { recursive: true });

		nodesDb = await createDbWithRetries(() => NodesDatabase.create({ databasePath: nodesPath }));
		headersDb = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({
			databasePath: headersPath,
			invalidBlocks: Array.from(getInvalidBlocks(chain))
		}));

		// Construct via type-cast (constructor is private).
		client = new (BlockHeadersClient as any)({
			chain,
			nodesDatabase: nodesDb,
			blockHeadersDatabase: headersDb,
			enableConsoleDebugLog: false,
		}) as BlockHeadersClient;
	});

	afterEach(async () => {
		if (client) await client.stop().catch(() => { });
		if (nodesDb) await nodesDb.close().catch(() => { });
		if (headersDb) await headersDb.close().catch(() => { });
		await removeDirectoryWithRetries(nodesPath);
		await removeDirectoryWithRetries(headersPath);
	});

	describe('_startQueue', () => {
		test('after _connectToNodes throws, _startQueue resets and second _start works', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };

			(client as any)._connectToNodes = async () => {
				throw new Error('Simulated connect failure');
			};

			expect((client as any)._startQueue).toBeNull();

			const failedPromise = (client as any)._start();
			await expect(failedPromise).rejects.toThrow('Simulated connect failure');

			expect((client as any)._startQueue).toBeNull();

			(client as any)._connectToNodes = async () => { };
			const successPromise = (client as any)._start();
			await expect(successPromise).resolves.toBeUndefined();
		});

		test('concurrent _start calls return promises that resolve together', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };

			let connectCallCount = 0;
			(client as any)._connectToNodes = async () => {
				connectCallCount++;
			};

			const p1 = (client as any)._start();
			const p2 = (client as any)._start();

			await p1;
			await p2;
			expect(connectCallCount).toBe(1);
			expect((client as any)._startQueue).toBeNull();
		});

		test('stop() while _start() is failing completes cleanup without throw', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._connectionMonitor[Symbol.asyncDispose] = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };
			(client as any)._nodesDatabase.open = async () => { };
			(client as any)._nodesDatabase[Symbol.asyncDispose] = async () => { };
			(client as any)._blockHeadersDatabase.open = async () => { };
			(client as any)._blockHeadersDatabase[Symbol.asyncDispose] = async () => { };
			(client as any)._closeNodeConnections = () => { };

			let rejectConnect!: (err: Error) => void;
			const connectBlocker = new Promise<void>((_res, rej) => { rejectConnect = rej; });

			let connectCalled = false;
			(client as any)._connectToNodes = async () => {
				connectCalled = true;
				await connectBlocker;
			};

			const startPromise = (client as any)._start();

			// Wait for the IIFE to reach _connectToNodes.
			while (!connectCalled) {
				await new Promise(r => setTimeout(r, 0));
			}
			expect((client as any)._startQueue).not.toBeNull();

			const stopPromise = client.stop();

			rejectConnect(new Error('Simulated connect failure after abort'));

			await startPromise.catch(() => { });
			await stopPromise;

			expect((client as any)._stopQueue).toBeNull();
		});

		test('stop() succeeds after _start() already rejected and _startQueue was cleared', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._connectionMonitor[Symbol.asyncDispose] = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };
			(client as any)._nodesDatabase.open = async () => { };
			(client as any)._nodesDatabase[Symbol.asyncDispose] = async () => { };
			(client as any)._blockHeadersDatabase.open = async () => { };
			(client as any)._blockHeadersDatabase[Symbol.asyncDispose] = async () => { };
			(client as any)._closeNodeConnections = () => { };

			(client as any)._connectToNodes = async () => {
				throw new Error('Simulated connect failure');
			};

			await (client as any)._start().catch(() => { });
			expect((client as any)._startQueue).toBeNull();

			await client.stop();
			expect((client as any)._stopQueue).toBeNull();
		});
	});

	describe('_nodeConnectionsHealthMonitorQueue', () => {
		test('when queue is a rejected promise, guard returns it', async () => {
			const abort = new AbortController();
			abort.abort();

			const rejected = Promise.reject(new Error('simulated prior failure'));
			rejected.catch(() => { });
			(client as any)._nodeConnectionsHealthMonitorQueue = rejected;

			const result = (client as any)._launchNodeConnectionsHealthMonitor(abort.signal);
			await expect(result).rejects.toThrow('simulated prior failure');
		});

		test('when queue is null, a fresh monitor launches and cleans up', async () => {
			(client as any)._nodeConnectionsHealthMonitorQueue = null;

			const abort = new AbortController();
			abort.abort();

			await (client as any)._launchNodeConnectionsHealthMonitor(abort.signal);

			expect((client as any)._nodeConnectionsHealthMonitorQueue).toBeNull();
		});

		test('monitor sets queue to null after the while loop exits', async () => {
			(client as any)._nodeConnectionsHealthMonitorQueue = null;

			const abort = new AbortController();
			abort.abort();
			(client as any)._connectionMonitor.start = async () => { };

			await (client as any)._launchNodeConnectionsHealthMonitor(abort.signal);

			expect((client as any)._nodeConnectionsHealthMonitorQueue).toBeNull();
		});

		test('after reset to null, subsequent launch creates a fresh monitor', async () => {
			(client as any)._nodeConnectionsHealthMonitorQueue = null;

			const abort1 = new AbortController();
			abort1.abort();
			(client as any)._connectionMonitor.start = async () => { };
			await (client as any)._launchNodeConnectionsHealthMonitor(abort1.signal);
			// First monitor exited and reset the queue to null.
			expect((client as any)._nodeConnectionsHealthMonitorQueue).toBeNull();

			// Launch again with a fresh aborted signal. The null guard allows a new monitor.
			const abort2 = new AbortController();
			abort2.abort();
			await (client as any)._launchNodeConnectionsHealthMonitor(abort2.signal);
			expect((client as any)._nodeConnectionsHealthMonitorQueue).toBeNull();
		});

		test('iteration error caught by safeguard, queue stays healthy for fresh launch', async () => {
			// Simulate one iteration failing via a non-getConnectable operation.
			(client as any)._nodeConnectionsHealthMonitorQueue = Promise.resolve();

			let clearOldCalled = false;
			(client as any)._nodesDatabase.getNumNodes = () => 100000;
			(client as any)._nodesDatabase.clearOld = () => {
				clearOldCalled = true;
				throw new Error('Simulated clearOld failure');
			};

			// Chain an iteration that will fail (mirroring the health monitor pattern).
			(client as any)._nodeConnectionsHealthMonitorQueue = (client as any)._nodeConnectionsHealthMonitorQueue
				.then(async () => {
					const numBefore = (client as any)._nodesDatabase.getNumNodes();
					if (numBefore > 10) {
						(client as any)._nodesDatabase.clearOld({ amount: numBefore - 10 });
					}
				})
				.catch(() => { /* safeguard */ });

			await (client as any)._nodeConnectionsHealthMonitorQueue;
			expect(clearOldCalled).toBe(true);

			// Queue resolved despite the error. Reset and verify fresh launch works.
			(client as any)._nodeConnectionsHealthMonitorQueue = null;
			(client as any)._nodesDatabase.clearOld = () => { };

			const abort = new AbortController();
			abort.abort();
			(client as any)._connectionMonitor.start = async () => { };
			await (client as any)._launchNodeConnectionsHealthMonitor(abort.signal);

			expect((client as any)._nodeConnectionsHealthMonitorQueue).toBeNull();
		});
	});
});
