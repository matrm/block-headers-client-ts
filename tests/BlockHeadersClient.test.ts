/// <reference types="node" />
import { mkdir } from 'node:fs/promises';

import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import { BlockHeadersClient } from '../src/BlockHeadersClient.js';
import { BlockHeadersDatabase } from '../src/BlockHeadersDatabase.js';
import { NodesDatabase } from '../src/NodesDatabase.js';
import { Chain, getInvalidBlocks } from '../src/chainProtocol.js';
import { getRandomHexString, ipPortToString } from '../src/utils/util.js';

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
			vi.useFakeTimers();
			try {
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
					await vi.advanceTimersByTimeAsync(0);
				}
				expect((client as any)._startQueue).not.toBeNull();

				const stopPromise = client.stop();

				rejectConnect(new Error('Simulated connect failure after abort'));

				await startPromise.catch(() => { });
				await stopPromise;

				expect((client as any)._stopQueue).toBeNull();
			} finally {
				vi.useRealTimers();
			}
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

		test('stop() emits client_stop even when the stop body rejects', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._connectionMonitor[Symbol.asyncDispose] = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };
			(client as any)._nodesDatabase.open = async () => { };
			(client as any)._nodesDatabase[Symbol.asyncDispose] = async () => {
				throw new Error('Simulated database dispose failure');
			};
			(client as any)._blockHeadersDatabase.open = async () => { };
			(client as any)._blockHeadersDatabase[Symbol.asyncDispose] = async () => { };
			(client as any)._closeNodeConnections = () => { };

			let stopCount = 0;
			(client as any)._dashboardEmitter.on('client_stop', () => { stopCount++; });

			await expect(client.stop()).rejects.toThrow('Simulated database dispose failure');
			// The emit fires unconditionally (via .finally) so the dashboard still learns the
			// client is mostly stopped despite a database error during dispose.
			expect(stopCount).toBe(1);
			expect((client as any)._stopQueue).toBeNull();
		});

		test('concurrent stop() calls share a single client_stop emit', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._connectionMonitor[Symbol.asyncDispose] = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };
			(client as any)._nodesDatabase.open = async () => { };
			(client as any)._nodesDatabase[Symbol.asyncDispose] = async () => { };
			(client as any)._blockHeadersDatabase.open = async () => { };
			(client as any)._blockHeadersDatabase[Symbol.asyncDispose] = async () => { };
			(client as any)._closeNodeConnections = () => { };

			let releaseConnect!: () => void;
			const blocker = new Promise<void>(res => { releaseConnect = res; });
			(client as any)._connectToNodes = async () => { await blocker; };

			let stopCount = 0;
			(client as any)._dashboardEmitter.on('client_stop', () => { stopCount++; });

			const stopPromise1 = client.stop();
			const stopPromise2 = client.stop();

			expect((client as any)._stopQueue).not.toBeNull();
			releaseConnect();
			await Promise.all([stopPromise1, stopPromise2]);

			expect(stopCount).toBe(1);
			expect((client as any)._stopQueue).toBeNull();
		});

		test('public start() emits client_start exactly once per concurrent batch', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };
			(client as any)._nodesDatabase.open = async () => { };
			(client as any)._blockHeadersDatabase.open = async () => { };

			let releaseConnect!: () => void;
			const blocker = new Promise<void>(res => { releaseConnect = res; });
			(client as any)._connectToNodes = async () => { await blocker; };

			let startCount = 0;
			(client as any)._dashboardEmitter.on('client_start', () => { startCount++; });

			// Two concurrent public start() calls.
			const startPromise1 = client.start();
			const startPromise2 = client.start();
			releaseConnect();
			await Promise.all([startPromise1, startPromise2]);

			expect(startCount).toBe(1);
		});

		test('public start() does NOT emit client_start when _start() rejects', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };
			(client as any)._nodesDatabase.open = async () => { };
			(client as any)._blockHeadersDatabase.open = async () => { throw new Error('boom'); };

			let startCount = 0;
			(client as any)._dashboardEmitter.on('client_start', () => { startCount++; });

			await expect(client.start()).rejects.toThrow('boom');

			// The client did not actually start, so no dashboard event should fire.
			expect(startCount).toBe(0);
			// The queue is cleared by the .finally() in _start(), so a later start() can retry.
			expect((client as any)._startQueue).toBeNull();
		});

		test('concurrent start() calls during an in-flight stop produce a single client_start emit', async () => {
			(client as any)._connectionMonitor.start = async () => { };
			(client as any)._launchNodeConnectionsHealthMonitor = () => { };
			(client as any)._nodesDatabase.open = async () => { };
			(client as any)._blockHeadersDatabase.open = async () => { };
			(client as any)._connectToNodes = async () => { };

			let releaseStop!: () => void;
			const stopBlocker = new Promise<void>(res => { releaseStop = res; });
			(client as any)._stopQueue = stopBlocker;

			let startCount = 0;
			(client as any)._dashboardEmitter.on('client_start', () => { startCount++; });

			const startPromise1 = client.start();
			const startPromise2 = client.start();

			// Both start() calls are now awaiting _stopQueue. Release it.
			releaseStop();

			await Promise.all([startPromise1, startPromise2]);

			// Only one start() built a new chain, so only one client_start should fire.
			expect(startCount).toBe(1);
			expect((client as any)._startQueue).toBeNull();
		});
	});

	describe('_closeNodeConnections', () => {
		test('emits peer_disconnected for connected peers, not for pending-only ones, and disposes all', () => {
			const clientAny = client as any;
			const disposed: string[] = [];
			const makeConn = (ip: string, port: number) => {
				const ipPort = { ip, port };
				return {
					getIpPort: () => ipPort,
					getIpPortString: () => ipPortToString(ipPort),
					[Symbol.dispose]: () => { disposed.push(ipPortToString(ipPort)); },
				};
			};
			// Two connections that completed the handshake.
			const connA = makeConn('1.1.1.1', 8333);
			const connB = makeConn('2.2.2.2', 8333);
			// One connection still in the handshake (in _nodeConnections but not _nodeConnectionsConnected).
			const connPending = makeConn('3.3.3.3', 8333);
			clientAny._nodeConnections.set('1.1.1.1:8333', connA);
			clientAny._nodeConnections.set('2.2.2.2:8333', connB);
			clientAny._nodeConnections.set('3.3.3.3:8333', connPending);
			clientAny._nodeConnectionsConnected.set('1.1.1.1:8333', connA);
			clientAny._nodeConnectionsConnected.set('2.2.2.2:8333', connB);

			const emitted: string[] = [];
			clientAny._dashboardEmitter.on('peer_disconnected', (ipPort: any) => emitted.push(ipPortToString(ipPort)));

			clientAny._closeNodeConnections();

			// peer_disconnected emitted for the connected peers only (alphabetical order is
			// not guaranteed by Map iteration; sort for a stable comparison).
			expect(emitted.sort()).toEqual([
				JSON.stringify({ ip: '1.1.1.1', port: 8333 }),
				JSON.stringify({ ip: '2.2.2.2', port: 8333 }),
			]);

			// All three connections were disposed, including the pending handshake.
			expect(disposed.sort()).toEqual([
				JSON.stringify({ ip: '1.1.1.1', port: 8333 }),
				JSON.stringify({ ip: '2.2.2.2', port: 8333 }),
				JSON.stringify({ ip: '3.3.3.3', port: 8333 }),
			]);

			// Both maps are cleared.
			expect(clientAny._nodeConnections.size).toBe(0);
			expect(clientAny._nodeConnectionsConnected.size).toBe(0);
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

	describe('stuck detection', () => {
		test('when no progress has been made for the timeout, failed connection attempts purge non-connected nodes and re-add seeds', async () => {
			const clientAny = client as any;
			const fakeNode = { ip: '1.2.3.4', port: 8333 };
			await nodesDb.addSeen(fakeNode, Date.now());

			// Pretend the internet is up so the stuck path is reached instead of the offline sleep path.
			clientAny._connectionMonitor.connectedToInternetCheapAsync = vi.fn().mockResolvedValue(true);

			const deleteNodesSpy = vi.spyOn(nodesDb, 'deleteNodes');
			const addSeedEnvSpy = vi.spyOn(clientAny, '_addSeedNodesFromEnvAndHardcoded').mockImplementation(() => { });
			const addSeedApiSpy = vi.spyOn(clientAny, '_addSeedNodesFromExternalApi').mockResolvedValue(new Set<string>());

			const createFakeConnection = (ipPort: { ip: string, port: number }) => ({
				getIpPort: () => ipPort,
				getIpPortString: () => ipPortToString(ipPort),
				connect: vi.fn().mockRejectedValue(new Error('simulated connect failure')),
				ping: vi.fn(),
				onValidChain: vi.fn(),
				syncHeaders: vi.fn(),
				getAddr: vi.fn(),
				removeAllListeners: vi.fn(),
				on: vi.fn(),
				[Symbol.dispose]: vi.fn(),
			});

			clientAny._createNodeConnection = vi.fn().mockImplementation((ipPort: { ip: string, port: number }) => {
				const connection = createFakeConnection(ipPort);
				clientAny._nodeConnections.set(ipPortToString(ipPort), connection);
				return connection;
			});

			// Make the progress timer stale enough to satisfy the timeout for NUM_WORKERS workers.
			clientAny._lastConnectionProgressTime = performance.now() - 100000;

			const abort = new AbortController();
			await clientAny._createConnectedNodeConnection({
				prioritizeRating: true,
				numTopNodesToRandomlySelect: 1,
				alwaysGetAddr: false,
				workerId: 'stuck-detection-test',
				numWorkers: 16,
				signal: abort.signal,
				clientStopSignal: abort.signal,
				maxNumAttempts: 2,
			});

			expect(deleteNodesSpy).toHaveBeenCalledTimes(1);
			expect(deleteNodesSpy).toHaveBeenCalledWith({ excludedIpPortStringsMap: clientAny._nodeConnections });
			expect(addSeedEnvSpy).toHaveBeenCalledTimes(1);
			expect(addSeedApiSpy).toHaveBeenCalledTimes(1);
			expect(clientAny._seedReAddPromise).toBeNull();
		});
	});
});
