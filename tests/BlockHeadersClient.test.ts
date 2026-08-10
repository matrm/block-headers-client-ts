/// <reference types="node" />
import { mkdir } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import { BlockHeaderMutable } from '../src/BlockHeader.js';
import { BlockHeadersClient } from '../src/BlockHeadersClient.js';
import { BlockHeadersDatabase } from '../src/BlockHeadersDatabase.js';
import { NodesDatabase } from '../src/NodesDatabase.js';
import { Chain, getInvalidBlocks } from '../src/chainProtocol.js';
import { getRandomHexString, ipPortToString } from '../src/utils/util.js';
import { IpPort } from '../src/types.js';

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

		// Creates a harness where every connection attempt fails and the stuck-detection
		// path is reached (internet is up, timer is stale). Returns a runWorker() that
		// simulates one failed connection run within the same _connectToNodes().
		async function createStuckDetectionHarness({ workerId, withConnectedNode }: { workerId: string, withConnectedNode: boolean }) {
			const clientAny = client as any;
			const fakeNode = { ip: '1.2.3.4', port: 8333 };
			await nodesDb.addSeen(fakeNode, Date.now());

			// Pretend the internet is up so the stuck path is reached instead of the offline sleep path.
			clientAny._connectionMonitor.connectedToInternetCheapAsync = vi.fn().mockResolvedValue(true);

			const deleteNodesSpy = vi.spyOn(nodesDb, 'deleteNodes');
			vi.spyOn(clientAny, '_addSeedNodesFromEnvAndHardcoded').mockImplementation(() => { });
			vi.spyOn(clientAny, '_addSeedNodesFromExternalApi').mockResolvedValue(new Set<string>());

			const connectedNode = {
				getIpPort: () => fakeNode,
				getIpPortString: () => ipPortToString(fakeNode),
				connect: vi.fn().mockRejectedValue(new Error('simulated connect failure')),
				ping: vi.fn(),
				onValidChain: vi.fn(),
				syncHeaders: vi.fn(),
				getAddr: vi.fn().mockResolvedValue([]),
				removeAllListeners: vi.fn(),
				on: vi.fn(),
				[Symbol.dispose]: vi.fn(),
			};
			clientAny._createNodeConnection = vi.fn().mockImplementation((ipPort: { ip: string, port: number }) => {
				const connection = withConnectedNode
					? connectedNode
					: {
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
					};
				clientAny._nodeConnections.set(ipPortToString(ipPort), connection);
				return connection;
			});
			if (withConnectedNode) {
				clientAny._nodeConnectionsConnected.set(ipPortToString(fakeNode), connectedNode);
			}

			const abort = new AbortController();
			const runWorker = () => {
				// Make the progress timer stale enough to satisfy the timeout for NUM_WORKERS workers.
				clientAny._lastConnectionProgressTime = performance.now() - 100000;
				// Simulate the disconnect callback destroying the failed connection between runs.
				clientAny._nodeConnections.clear();
				return clientAny._createConnectedNodeConnection({
					prioritizeRating: true,
					numTopNodesToRandomlySelect: 1,
					alwaysGetAddr: false,
					workerId,
					numWorkers: 16,
					signal: abort.signal,
					clientStopSignal: abort.signal,
					maxNumAttempts: 2,
				});
			};

			return { clientAny, runWorker, deleteNodesSpy };
		}

		test('the purge fires only once per _connectToNodes() run while connections exist', async () => {
			const { runWorker, deleteNodesSpy } = await createStuckDetectionHarness({ workerId: 'stuck-detection-once-per-start', withConnectedNode: true });

			// First failing run within the same _connectToNodes(): the purge fires.
			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(1);

			// Second failing run within the same _connectToNodes(): the purge is skipped so
			// the client gracefully settles below the target connection count.
			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(1);
		});

		test('with zero connections the purge keeps firing across runs', async () => {
			const { runWorker, deleteNodesSpy } = await createStuckDetectionHarness({ workerId: 'stuck-detection-zero-connections', withConnectedNode: false });

			// With nothing connected, the database is the only hope of finding nodes, so the
			// purge keeps running instead of settling.
			await runWorker();
			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(2);
		});

		test('a zero-connection purge does not consume the once-per-run budget', async () => {
			const { clientAny, runWorker, deleteNodesSpy } = await createStuckDetectionHarness({ workerId: 'stuck-detection-zero-connections-then-connected', withConnectedNode: false });

			// With nothing connected, the purge fires without consuming the budget...
			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(1);
			expect(clientAny._stuckDetectionPurgedThisStart).toBe(false);

			// ...so when a node connects later in the same run and the pool stalls again,
			// the first purge with at least one node connected is still allowed. It consumes
			// the budget for the rest of the run.
			const connectedNode = {
				getIpPort: () => ({ ip: '1.2.3.4', port: 8333 }),
				getIpPortString: () => ipPortToString({ ip: '1.2.3.4', port: 8333 }),
				ping: vi.fn(),
				getAddr: vi.fn().mockResolvedValue([]),
				[Symbol.dispose]: vi.fn(),
			};
			clientAny._nodeConnectionsConnected.set(ipPortToString({ ip: '1.2.3.4', port: 8333 }), connectedNode);

			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(2);
			expect(clientAny._stuckDetectionPurgedThisStart).toBe(true);

			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(2);
		});

		test('a purge aborted mid-way does not consume the once-per-run budget', async () => {
			const { clientAny, runWorker, deleteNodesSpy } = await createStuckDetectionHarness({ workerId: 'stuck-detection-aborted-purge', withConnectedNode: true });

			// A throwing dashboard listener aborts the purge body mid-way.
			vi.spyOn(clientAny._dashboardEmitter, 'emit').mockImplementation(() => {
				throw new Error('listener bug');
			});

			await expect(runWorker()).rejects.toThrow('listener bug');
			expect(deleteNodesSpy).toHaveBeenCalledTimes(1);
			expect(clientAny._stuckDetectionPurgedThisStart).toBe(false);

			// The budget is still available, so the next run retries the purge.
			(clientAny._dashboardEmitter.emit as any).mockRestore();
			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(2);
		});

		test('the purge is skipped while another worker is inside getAddr()', async () => {
			const { runWorker, deleteNodesSpy } = await createStuckDetectionHarness({ workerId: 'stuck-detection-getaddr-in-progress', withConnectedNode: false });
			const clientAny = client as any;
			// getAddr can take minutes, so an in-flight call blocks stuck detection entirely.
			clientAny._nodesCurrentlyRunningGetAddr = 1;

			await runWorker();
			expect(deleteNodesSpy).toHaveBeenCalledTimes(0);
			expect(clientAny._stuckDetectionPurgedThisStart).toBe(false);
		});

		test('the purge is skipped while a seed re-add is in progress', async () => {
			const { runWorker, deleteNodesSpy } = await createStuckDetectionHarness({ workerId: 'stuck-detection-seed-readd-in-progress', withConnectedNode: false });
			const clientAny = client as any;
			let releaseSeedReAdd!: () => void;
			clientAny._seedReAddPromise = new Promise<void>((resolve) => { releaseSeedReAdd = resolve; });

			const workerPromise = runWorker();
			// The worker blocks on the seed re-add await before reaching node selection.
			expect(deleteNodesSpy).toHaveBeenCalledTimes(0);

			releaseSeedReAdd();
			await workerPromise;
			// The purge was skipped even after the re-add completed because _seedReAddPromise
			// stayed non-null through the worker's stuck-detection check.
			expect(deleteNodesSpy).toHaveBeenCalledTimes(0);
		});

		test('a failed internet check resets the progress timer so recovery does not purge immediately', async () => {
			const { runWorker, deleteNodesSpy } = await createStuckDetectionHarness({ workerId: 'stuck-detection-offline-path', withConnectedNode: false });
			const clientAny = client as any;
			// The offline path: the cheap check reports no internet.
			clientAny._connectionMonitor.connectedToInternetCheapAsync = vi.fn().mockResolvedValue(false);

			vi.useFakeTimers();
			try {
				const workerPromise = runWorker();// Attempt fails; the offline sleep begins.
				await vi.advanceTimersByTimeAsync(0);
				expect(deleteNodesSpy).toHaveBeenCalledTimes(0);

				// The worker resets the timer after the offline sleep, so a stale timestamp cannot
				// trigger a database purge the moment connectivity returns.
				await vi.advanceTimersByTimeAsync(1000);
				await workerPromise;
				expect(performance.now() - clientAny._lastConnectionProgressTime).toBeLessThanOrEqual(1000);
				expect(deleteNodesSpy).toHaveBeenCalledTimes(0);
				expect(clientAny._stuckDetectionPurgedThisStart).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	// Helper that creates a mock NodeConnection whose _tipHashHex is updated
	// before block_hashes is emitted, mirroring LegacyNodeConnection's new behavior.
	function createMockConnection(ipPort: IpPort, initialTipHex: string) {
		const ipPortStr = ipPortToString(ipPort);
		let tipHex = initialTipHex;
		const conn = new EventEmitter() as any;
		conn.getIpPort = () => ipPort;
		conn.getIpPortString = () => ipPortStr;
		conn.getTipHashHex = () => tipHex;
		conn.removeAllListeners = vi.fn();
		conn.syncHeaders = vi.fn().mockResolvedValue(undefined);
		// Simulate LegacyNodeConnection: update _tipHashHex before emitting.
		conn.emitBlockHashes = (hashes: Buffer[]) => {
			tipHex = hashes.at(-1)!.toString('hex');
			conn.emit('block_hashes', hashes);
		};
		return conn;
	}

	describe('block_hashes handler tipHashHex staleness', () => {
		test('when lastHashHex matches DB tip, _tipHashHex is updated before the event so the out-of-sync detector does not trip', () => {
			const clientAny = client as any;
			const genesisHashHex = headersDb.getHeaderFromHeight(0)!.hashHex;

			const block1Hex = '010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299';
			const block1 = BlockHeaderMutable.fromHex(block1Hex);
			headersDb.addHeaders([block1]);
			const dbTipHashHex = headersDb.getHeaderTip().hashHex;
			expect(dbTipHashHex).not.toBe(genesisHashHex);

			const mockConn = createMockConnection({ ip: '1.1.1.1', port: 8333 }, genesisHashHex);

			const signal = new AbortController().signal;
			clientAny._setupNodeConnectionCallbacks(mockConn, signal);

			const dbTipHashBuffer = Buffer.from(dbTipHashHex, 'hex');
			mockConn.emitBlockHashes([dbTipHashBuffer]);

			expect(mockConn.syncHeaders).not.toHaveBeenCalled();
			expect(mockConn.getTipHashHex()).toBe(dbTipHashHex);
		});

		test('when lastHashHex is in the DB but not the chain tip, _tipHashHex is still updated', () => {
			const clientAny = client as any;
			const genesisHashHex = headersDb.getHeaderFromHeight(0)!.hashHex;

			const block1Hex = '010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299';
			const block2Hex = '010000004860eb18bf1b1620e37e9490fc8a427514416fd75159ab86688e9a8300000000d5fdcc541e25de1c7a5addedf24858b8bb665c9f36ef744ee42c316022c90f9bb0bc6649ffff001d08d2bd61';
			const block1 = BlockHeaderMutable.fromHex(block1Hex);
			const block2 = BlockHeaderMutable.fromHex(block2Hex);
			headersDb.addHeaders([block1, block2]);
			const dbTipHashHex = headersDb.getHeaderTip().hashHex;
			const block1HashHex = block1.hashHex;
			expect(block1HashHex).not.toBe(dbTipHashHex);

			const mockConn = createMockConnection({ ip: '2.2.2.2', port: 8333 }, genesisHashHex);

			const signal = new AbortController().signal;
			clientAny._setupNodeConnectionCallbacks(mockConn, signal);

			const block1HashBuffer = Buffer.from(block1HashHex, 'hex');
			mockConn.emitBlockHashes([block1HashBuffer]);

			expect(mockConn.syncHeaders).not.toHaveBeenCalled();
			expect(mockConn.getTipHashHex()).toBe(block1HashHex);
		});

		test('_tipHashHex is correct when dashboard reads it during peer_block_hashes_received', () => {
			const clientAny = client as any;
			const genesisHashHex = headersDb.getHeaderFromHeight(0)!.hashHex;

			const block1Hex = '010000006fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000982051fd1e4ba744bbbe680e1fee14677ba1a3c3540bf7b1cdb606e857233e0e61bc6649ffff001d01e36299';
			const block1 = BlockHeaderMutable.fromHex(block1Hex);
			const block1HashHex = block1.hashHex;

			const mockConn = createMockConnection({ ip: '3.3.3.3', port: 8333 }, genesisHashHex);

			const signal = new AbortController().signal;
			clientAny._setupNodeConnectionCallbacks(mockConn, signal);

			// Listen to the dashboard emitter and verify that when it fires,
			// getTipHashHex() already returns the new hash -- no race condition.
			let dashboardTipAtEmit: string | undefined;
			const onPeerBlockHashes = (ipPort: IpPort, lastHashHex: string) => {
				if (ipPort.ip === '3.3.3.3') {
					dashboardTipAtEmit = mockConn.getTipHashHex();
				}
			};
			clientAny._dashboardEmitter.on('peer_block_hashes_received', onPeerBlockHashes);

			const block1HashBuffer = Buffer.from(block1HashHex, 'hex');
			mockConn.emitBlockHashes([block1HashBuffer]);

			expect(mockConn.syncHeaders).toHaveBeenCalledTimes(1);
			expect(mockConn.getTipHashHex()).toBe(block1HashHex);
			expect(dashboardTipAtEmit).toBe(block1HashHex);

			clientAny._dashboardEmitter.off('peer_block_hashes_received', onPeerBlockHashes);
		});
	});

	describe('_pingHandler', () => {
		function createConnectedNodeMock(ip: string, port: number) {
			const node = { ip, port };
			return {
				node,
				connection: {
					getIpPortString: () => ipPortToString(node),
					ping: vi.fn().mockResolvedValue(1),
					[Symbol.dispose]: vi.fn(),
				}
			};
		}

		test('pings the connected node that was pinged least recently (round-robin)', async () => {
			const clientAny = client as any;
			const mockA = createConnectedNodeMock('1.1.1.1', 8333);
			const mockB = createConnectedNodeMock('2.2.2.2', 8333);
			clientAny._nodeConnectionsConnected.set(ipPortToString(mockA.node), mockA.connection);
			clientAny._nodeConnectionsConnected.set(ipPortToString(mockB.node), mockB.connection);

			// A successful ping marks the node, so the next call moves on to the other one.
			expect(await clientAny._pingHandler(5000)).toBe(true);
			expect(mockA.connection.ping).toHaveBeenCalledTimes(1);
			expect(mockB.connection.ping).toHaveBeenCalledTimes(0);

			expect(await clientAny._pingHandler(5000)).toBe(true);
			expect(mockB.connection.ping).toHaveBeenCalledTimes(1);
			expect(mockA.connection.ping).toHaveBeenCalledTimes(1);
		});

		test('rotates through every connected node with three nodes', async () => {
			const clientAny = client as any;
			const mocks = ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map(ip => createConnectedNodeMock(ip, 8333));
			mocks.forEach(mock => clientAny._nodeConnectionsConnected.set(ipPortToString(mock.node), mock.connection));

			// Each call pings the least recently pinged node: A, then B, then C.
			for (const mock of mocks) {
				expect(await clientAny._pingHandler(5000)).toBe(true);
				expect(mock.connection.ping).toHaveBeenCalledTimes(1);
			}
		});

		test('passes the timeout and abort signal to the ping', async () => {
			const clientAny = client as any;
			const mock = createConnectedNodeMock('1.1.1.1', 8333);
			const signal = new AbortController().signal;
			clientAny._nodeConnectionsConnected.set(ipPortToString(mock.node), mock.connection);

			expect(await clientAny._pingHandler(1234, signal)).toBe(true);
			expect(mock.connection.ping).toHaveBeenCalledWith({ timeoutMs: 1234, signal });
		});

		test('returns null without pinging when no connected nodes exist', async () => {
			const clientAny = client as any;
			clientAny._nodeConnectionsConnected.clear();
			expect(await clientAny._pingHandler(5000)).toBeNull();
		});

		test('returns false when the ping rejects', async () => {
			const clientAny = client as any;
			const mock = createConnectedNodeMock('1.1.1.1', 8333);
			mock.connection.ping = vi.fn().mockRejectedValue(new Error('Ping timed out'));
			clientAny._nodeConnectionsConnected.set(ipPortToString(mock.node), mock.connection);

			expect(await clientAny._pingHandler(5000)).toBe(false);
			expect(mock.connection.ping).toHaveBeenCalledTimes(1);
		});

		test('prunes last-ping entries for disconnected nodes', async () => {
			const clientAny = client as any;
			const mockA = createConnectedNodeMock('1.1.1.1', 8333);
			const mockB = createConnectedNodeMock('2.2.2.2', 8333);
			clientAny._nodeConnectionsConnected.set(ipPortToString(mockA.node), mockA.connection);
			clientAny._nodeConnectionsConnected.set(ipPortToString(mockB.node), mockB.connection);
			await clientAny._pingHandler(5000);// Marks connA as pinged.

			// connA disconnects; the next handler call prunes its entry and pings connB.
			clientAny._nodeConnectionsConnected.delete(ipPortToString(mockA.node));

			expect(await clientAny._pingHandler(5000)).toBe(true);
			expect(mockB.connection.ping).toHaveBeenCalledTimes(1);
			expect(clientAny._lastPingTimesMs.has(ipPortToString(mockA.node))).toBe(false);
			expect(clientAny._lastPingTimesMs.has(ipPortToString(mockB.node))).toBe(true);
		});
	});

	describe('stuck-detection purge budget reset', () => {
		test('_stuckDetectionPurgedThisStart resets at the start of a fresh _connectToNodes() run', async () => {
			const clientAny = client as any;
			clientAny._addedSeedNodesFromExternalAPI = true;
			clientAny._addedSeedNodesFromEnvAndHardcoded = true;
			clientAny._stuckDetectionPurgedThisStart = true;// Budget consumed by a previous run.

			let workerCount = 0;
			clientAny._createConnectedNodeConnection = vi.fn().mockImplementation(async () => {
				workerCount++;
			});

			const abort = new AbortController();
			await clientAny._connectToNodes({ clientStopSignal: abort.signal });

			// The workers launched, and the fresh run re-armed the once-per-run purge budget.
			expect(workerCount).toBeGreaterThan(0);
			expect(clientAny._stuckDetectionPurgedThisStart).toBe(false);
		});
	});

	describe('connection monitor check-result classification', () => {
		test('classifies check results into the four dashboard events and stays silent for the first report', async () => {
			const clientAny = client as any;
			clientAny._connectionMonitor.start = async () => { };
			clientAny._launchNodeConnectionsHealthMonitor = () => { };
			clientAny._nodesDatabase.open = async () => { };
			clientAny._blockHeadersDatabase.open = async () => { };
			clientAny._connectToNodes = async () => { };

			await clientAny._start();

			const events: string[] = [];
			clientAny._dashboardEmitter.on('connection_monitor_online_to_online', () => events.push('online_to_online'));
			clientAny._dashboardEmitter.on('connection_monitor_online_to_offline', () => events.push('online_to_offline'));
			clientAny._dashboardEmitter.on('connection_monitor_offline_to_online', () => events.push('offline_to_online'));
			clientAny._dashboardEmitter.on('connection_monitor_offline_to_offline', () => events.push('offline_to_offline'));

			const onCheckResult = clientAny._connectionMonitor._onCheckResult;
			expect(typeof onCheckResult).toBe('function');

			onCheckResult(null, true);// First report: status was unknown, so nothing is emitted.
			expect(events).toEqual([]);

			onCheckResult(true, true);
			expect(events).toEqual(['online_to_online']);

			onCheckResult(true, false);
			expect(events).toEqual(['online_to_online', 'online_to_offline']);

			onCheckResult(false, true);
			expect(events).toEqual(['online_to_online', 'online_to_offline', 'offline_to_online']);

			onCheckResult(false, false);
			expect(events).toEqual(['online_to_online', 'online_to_offline', 'offline_to_online', 'offline_to_offline']);
		});
	});
});
