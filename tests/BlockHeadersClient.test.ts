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
});
