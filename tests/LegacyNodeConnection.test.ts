/// <reference types="node" />
import * as net from 'node:net';
import { mkdir } from 'node:fs/promises';

import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import { BlockHeaderMutable } from '../src/BlockHeader.js';
import { BlockHeadersDatabase } from '../src/BlockHeadersDatabase.js';
import { ConnectionMonitor } from '../src/ConnectionMonitor.js';
import { LegacyNodeConnection } from '../src/LegacyNodeConnection.js';
import { Chain, getInvalidBlocks, getMagic } from '../src/chainProtocol.js';
import { buildMessage, parseMessages } from '../src/p2p/messages.js';
import { getRandomHexString } from '../src/utils/util.js';

const chain: Chain = 'bsv';

// Creates a deferred promise whose resolution we control externally.
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

describe('LegacyNodeConnection', () => {
	// Restores spies even when an assertion fails before an inline mockRestore() call.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('syncHeaders queue behavior (limit 2)', () => {
		let db: BlockHeadersDatabase;
		let databasePath: string;
		let connMonitor: ConnectionMonitor;

		beforeEach(async () => {
			vi.useFakeTimers();
			databasePath = `tests/db/node-connection-${getRandomHexString(16)}`;
			await mkdir(databasePath, { recursive: true });
			db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({
				databasePath,
				invalidBlocks: Array.from(getInvalidBlocks(chain))
			}));

			connMonitor = new ConnectionMonitor({ intervalMs: 20000, timeoutMs: 10000 });
		});

		afterEach(async () => {
			if (db) await db.close();
			await removeDirectoryWithRetries(databasePath);
			vi.useRealTimers();
		});

		test('queue depth of at most 2: running + 1 queued, 3rd caller waits for tail', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const sync1Deferred = deferred<void>();
			let syncCallCount = 0;
			let thirdSyncStarted = false;

			(conn as any)._syncHeaders = async () => {
				const callNum = ++syncCallCount;
				if (callNum === 1) {
					await sync1Deferred.promise;
				} else if (callNum === 3) {
					thirdSyncStarted = true;
				}
			};

			conn.syncHeaders({});
			await vi.advanceTimersByTimeAsync(0);
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			conn.syncHeaders({});
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			conn.syncHeaders({});
			expect((conn as any)._numSyncHeadersQueued).toBe(2);
			expect(syncCallCount).toBe(1);

			sync1Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			expect(syncCallCount).toBe(2);
			expect(thirdSyncStarted).toBe(false);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);
		});

		test('while only 1 sync running, a second call queues a follow-up sync', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.2',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const sync1Deferred = deferred<void>();
			let syncCallCount = 0;
			let secondSyncStarted = false;

			(conn as any)._syncHeaders = async () => {
				const callNum = ++syncCallCount;
				if (callNum === 1) {
					await sync1Deferred.promise;
				} else {
					secondSyncStarted = true;
				}
			};

			conn.syncHeaders({});
			await vi.advanceTimersByTimeAsync(0);
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			conn.syncHeaders({});
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			sync1Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			expect(syncCallCount).toBe(2);
			expect(secondSyncStarted).toBe(true);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);
		});

		test('when not already syncing, queue resets and fresh calls always chain', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.3',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			let syncCallCount = 0;
			(conn as any)._syncHeaders = async () => {
				syncCallCount++;
			};

			await conn.syncHeaders({});
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);

			await conn.syncHeaders({});
			expect(syncCallCount).toBe(2);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);
		});

		test('rejection recovery: queue resets after failed syncs, fresh calls work', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.4',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			let syncCallCount = 0;
			(conn as any)._syncHeaders = async () => {
				syncCallCount++;
				throw new Error('Simulated failure');
			};

			await conn.syncHeaders({}).catch(() => { /* expected */ });
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);

			await conn.syncHeaders({}).catch(() => { /* expected */ });
			expect(syncCallCount).toBe(2);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);
		});

		test('failed sync does not skip the next queued item; depth-limited callers continue normally', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.5',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const sync1Deferred = deferred<void>();
			let syncCallCount = 0;

			(conn as any)._syncHeaders = async () => {
				const callNum = ++syncCallCount;
				if (callNum === 1) {
					await sync1Deferred.promise;
					throw new Error('First sync failed');
				}
				// Second call succeeds.
			};

			// Start first sync (blocks on deferred).
			let call1Rejection: any;
			conn.syncHeaders({}).catch((err) => { call1Rejection = err; });
			await vi.advanceTimersByTimeAsync(0);
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			// Queue second sync while first is pending.
			let call2Rejection: any;
			conn.syncHeaders({}).catch((err) => { call2Rejection = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			// Depth-limited callers share call 2's promise and must not see call 1's error.
			let call3Rejection: any;
			conn.syncHeaders({}).catch((err) => { call3Rejection = err; });
			let call4Rejection: any;
			conn.syncHeaders({}).catch((err) => { call4Rejection = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			// Resolve first sync (it will throw).
			sync1Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			// First caller sees the error.
			expect(call1Rejection).toBeInstanceOf(Error);
			expect(call1Rejection.message).toBe('First sync failed');
			// Second queued item still ran independently and succeeded.
			expect(call2Rejection).toBeUndefined();
			// Depth-limited callers shared call 2's promise and also succeeded with no error from call 1.
			expect(call3Rejection).toBeUndefined();
			expect(call4Rejection).toBeUndefined();
			expect(syncCallCount).toBe(2);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);
		});

		test('depth-limited callers share the last queued callers promise (success and error)', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.6',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const sync1Deferred = deferred<void>();
			const sync2Deferred = deferred<void>();
			let syncCallCount = 0;

			(conn as any)._syncHeaders = async () => {
				const callNum = ++syncCallCount;
				if (callNum === 1) {
					await sync1Deferred.promise;
				} else {
					await sync2Deferred.promise;
					throw new Error('Call 2 failed');
				}
			};

			// Call 1 starts (blocks on deferred).
			let call1Rejection: any;
			conn.syncHeaders({}).catch((err) => { call1Rejection = err; });
			await vi.advanceTimersByTimeAsync(0);
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			// Call 2 queues while call 1 is pending.
			let call2Rejection: any;
			conn.syncHeaders({}).catch((err) => { call2Rejection = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			// Call 3 is depth-limited and shares call 2's promise.
			let call3Rejection: any;
			conn.syncHeaders({}).catch((err) => { call3Rejection = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);
			expect(syncCallCount).toBe(1);

			// Call 4 is also depth-limited and shares call 2's promise.
			let call4Rejection: any;
			conn.syncHeaders({}).catch((err) => { call4Rejection = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			// Resolve call 1 (succeeds).
			sync1Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			// Call 1 succeeded.
			expect(call1Rejection).toBeUndefined();
			expect(syncCallCount).toBe(2);

			// Call 2 fires and blocks on sync2Deferred.
			// Call 2 fails.
			sync2Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			// Call 2 sees the error.
			expect(call2Rejection).toBeInstanceOf(Error);
			expect(call2Rejection.message).toBe('Call 2 failed');
			// Call 3 and 4 share call 2's promise and receive the same error.
			expect(call3Rejection).toBe(call2Rejection);
			expect(call4Rejection).toBe(call2Rejection);
			expect(syncCallCount).toBe(2);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);
		});

		test('both running and queued fail; depth-limited callers see the queued items error', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.7',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const sync1Deferred = deferred<void>();
			const sync2Deferred = deferred<void>();
			let syncCallCount = 0;

			(conn as any)._syncHeaders = async () => {
				const callNum = ++syncCallCount;
				if (callNum === 1) {
					await sync1Deferred.promise;
					throw new Error('Call 1 failed');
				}
				await sync2Deferred.promise;
				throw new Error('Call 2 failed');
			};

			// Call 1 starts.
			let call1Rejection: any;
			conn.syncHeaders({}).catch((err) => { call1Rejection = err; });
			await vi.advanceTimersByTimeAsync(0);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			// Call 2 queues.
			let call2Rejection: any;
			conn.syncHeaders({}).catch((err) => { call2Rejection = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			// Calls 3-5 are depth-limited and share call 2's promise.
			let call3Rejection: any;
			conn.syncHeaders({}).catch((err) => { call3Rejection = err; });
			let call4Rejection: any;
			conn.syncHeaders({}).catch((err) => { call4Rejection = err; });
			let call5Rejection: any;
			conn.syncHeaders({}).catch((err) => { call5Rejection = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			// Call 1 fails.
			sync1Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			// Call 1 sees its own error, not call 2's.
			expect(call1Rejection).toBeInstanceOf(Error);
			expect(call1Rejection.message).toBe('Call 1 failed');
			expect(call1Rejection).not.toBe(call2Rejection);

			// Call 2 fires, then fails.
			sync2Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			// Call 2 sees its error.
			expect(call2Rejection).toBeInstanceOf(Error);
			expect(call2Rejection.message).toBe('Call 2 failed');
			// Depth-limited callers share call 2's promise, receiving the same error instead of call 1's.
			expect(call3Rejection).toBe(call2Rejection);
			expect(call4Rejection).toBe(call2Rejection);
			expect(call5Rejection).toBe(call2Rejection);
			expect(syncCallCount).toBe(2);
			expect((conn as any)._numSyncHeadersQueued).toBe(0);
		});

		test('many depth-limited callers all share the same tail promise', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.8',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const sync1Deferred = deferred<void>();
			(conn as any)._syncHeaders = async () => {
				await sync1Deferred.promise;
			};

			// Call 1 starts.
			let call1Rejection: any;
			conn.syncHeaders({}).catch((err) => { call1Rejection = err; });
			await vi.advanceTimersByTimeAsync(0);

			// Call 2 queues.
			let call2Rejection: any;
			conn.syncHeaders({}).catch((err) => { call2Rejection = err; });

			// 10 depth-limited calls all share the same tail promise.
			const depthLimitedPromises: Promise<void>[] = [];
			for (let i = 0; i < 10; i++) {
				depthLimitedPromises.push(conn.syncHeaders({}));
			}
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			sync1Deferred.resolve(undefined);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			expect(call1Rejection).toBeUndefined();
			expect(call2Rejection).toBeUndefined();

			const results = await Promise.allSettled(depthLimitedPromises);
			for (const result of results) {
				expect(result.status).toBe('fulfilled');
			}
		});

		test('queue drains and refills correctly across multiple cycles', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.9',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			let syncDeferreds: { promise: Promise<void>; resolve: () => void }[] = [];
			let syncCallCount = 0;

			(conn as any)._syncHeaders = async () => {
				const i = syncCallCount++;
				const d = deferred<void>();
				syncDeferreds.push(d);
				await d.promise;
			};

			// Cycle 1: fill and drain.
			let c1r1: any; conn.syncHeaders({}).catch((err) => { c1r1 = err; });
			await vi.advanceTimersByTimeAsync(0);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			let c1r2: any; conn.syncHeaders({}).catch((err) => { c1r2 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			let c1r3: any; conn.syncHeaders({}).catch((err) => { c1r3 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			expect(syncCallCount).toBe(1);
			syncDeferreds[0].resolve();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			expect(syncCallCount).toBe(2);
			syncDeferreds[1].resolve();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			expect((conn as any)._numSyncHeadersQueued).toBe(0);
			expect(c1r1).toBeUndefined();
			expect(c1r2).toBeUndefined();
			expect(c1r3).toBeUndefined();

			// Cycle 2: new calls after drain should work fresh.
			let c2r1: any; conn.syncHeaders({}).catch((err) => { c2r1 = err; });
			await vi.advanceTimersByTimeAsync(0);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);
			expect(syncCallCount).toBe(3);

			let c2r2: any; conn.syncHeaders({}).catch((err) => { c2r2 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			let c2r3: any; conn.syncHeaders({}).catch((err) => { c2r3 = err; });
			let c2r4: any; conn.syncHeaders({}).catch((err) => { c2r4 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			expect(syncCallCount).toBe(3);
			syncDeferreds[2].resolve();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			expect(syncCallCount).toBe(4);
			syncDeferreds[3].resolve();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(0);

			expect((conn as any)._numSyncHeadersQueued).toBe(0);
			expect(c2r1).toBeUndefined();
			expect(c2r2).toBeUndefined();
			expect(c2r3).toBeUndefined();
			expect(c2r4).toBeUndefined();
		});
	});

	describe('_setPingInterval (skip behavior)', () => {
		let db: BlockHeadersDatabase;
		let databasePath: string;
		let connMonitor: ConnectionMonitor;

		beforeEach(async () => {
			vi.useFakeTimers();
			databasePath = `tests/db/node-connection-ping-${getRandomHexString(16)}`;
			await mkdir(databasePath, { recursive: true });
			db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({
				databasePath,
				invalidBlocks: Array.from(getInvalidBlocks(chain))
			}));
			// Use a tight config so ping cadence under test is short.
			// intervalMs=20000, timeoutMs=10000 -> skip window = 9000ms, derived ping = 4500ms.
			connMonitor = new ConnectionMonitor({ intervalMs: 20000, timeoutMs: 10000 });
		});

		afterEach(async () => {
			if (db) await db.close();
			await removeDirectoryWithRetries(databasePath);
			vi.useRealTimers();
		});

		// Helper: create a connection with `connected` mocked true and `ping` capturing calls.
		// The `refreshOnPing` flag controls whether the mock ping calls updateLastKnownConnectionTime
		// (default false so the cadence tests observe raw tick-by-tick pinging without the skip
		// path suppressing them).
		function makeConnectedConn(ip: string, refreshOnPing = false) {
			const conn = new LegacyNodeConnection({
				ip, port: 8333, chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});
			// Override connected(): the real one checks _socket && !_pendingConnect; we bypass that.
			(conn as any).connected = () => true;
			(conn as any).ping = vi.fn(async () => {
				if (refreshOnPing) connMonitor.updateLastKnownConnectionTime();
				return 0;
			});
			return conn;
		}

		// Cleanup helper that bypasses [Symbol.dispose] (which would try to tear down a real
		// socket we never created). Stops the ping timer and removes the static IP-dedup entry.
		function teardownConn(conn: LegacyNodeConnection) {
			(conn as any)._clearPingInterval();
			(LegacyNodeConnection as any).existingNodeConnectionsStrings.delete(conn.getIpPortString());
		}

		test('first ping fires on the first pingIntervalMs tick, then on a fixed cadence', async () => {
			// Derived pingIntervalMs for this config = floor((20000-10000)*0.9/2) = 4500ms.
			// refreshOnPing=false so subsequent ticks aren't skipped by the recent-data rule.
			const conn = makeConnectedConn('127.0.0.10');
			(conn as any)._setPingInterval();

			// setInterval does not fire on tick 0; the first ping is at the first pingIntervalMs mark.
			expect((conn as any)._pingIntervalId).not.toBeNull();
			expect((conn as any).ping).toHaveBeenCalledTimes(0);

			await vi.advanceTimersByTimeAsync(4500);
			expect((conn as any).ping).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(4500);
			expect((conn as any).ping).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(4500);
			expect((conn as any).ping).toHaveBeenCalledTimes(3);

			teardownConn(conn);
		});

		test('ping tick is skipped when shouldSkipForRecentData() is true (recent peer data)', async () => {
			// refreshOnPing=true so the first ping refreshes lastKnown; subsequent ticks within the
			// skip window must suppress the ping.
			const conn = makeConnectedConn('127.0.0.12', true);
			(conn as any)._setPingInterval();

			// First ping at the first tick (4500ms); the mock ping calls updateLastKnownConnectionTime
			// -> shouldSkipForRecentData() becomes true for the next 9000ms (skip window).
			await vi.advanceTimersByTimeAsync(4500);
			expect((conn as any).ping).toHaveBeenCalledTimes(1);
			expect(connMonitor.shouldSkipForRecentData()).toBe(true);

			// Next pingIntervalMs (4500ms) tick: lastKnown is 4.5s old; skip window = 9s -> within
			// window -> ping tick is skipped.
			await vi.advanceTimersByTimeAsync(4500);
			expect((conn as any).ping).toHaveBeenCalledTimes(1);
			expect(connMonitor.shouldSkipForRecentData()).toBe(true);

			teardownConn(conn);
		});

		test('30-minute floor still forces a ping even when shouldSkipForRecentData() is true', async () => {
			// refreshOnPing=false so the skip path doesn't auto-trigger from pings themselves.
			// We feed external updateLastKnownConnectionTime() calls to simulate other peer data
			// arriving, keeping shouldSkipForRecentData() true across many ping ticks.
			const conn = makeConnectedConn('127.0.0.13', false);
			(conn as any)._setPingInterval();

			const pingIntervalMs = connMonitor.getPingIntervalMs(); // 4500ms
			// First ping fires at the first tick (4500ms) since lastPingIntervalTimeMs is INIT and
			// shouldSkipForRecentData() is false (no peer data yet). Capture its time as the floor
			// reference.
			await vi.advanceTimersByTimeAsync(pingIntervalMs);
			const firstPingTimeMs = performance.now();
			expect((conn as any).ping).toHaveBeenCalledTimes(1);

			const floorMs = 30 * 60 * 1000;
			// Tick the ping interval, supplying fresh peer data each time, until JUST BEFORE the
			// 30-minute floor would trigger on a tick. ticksBeforeFloor = ceil(1800000/4500) - 1 = 399.
			// After 399 more ticks (1795500ms past firstPingTime), the next tick crosses the 1800000ms floor.
			const ticksBeforeFloor = Math.ceil(floorMs / pingIntervalMs) - 1; // 399
			for (let i = 0; i < ticksBeforeFloor; i++) {
				connMonitor.updateLastKnownConnectionTime();
				await vi.advanceTimersByTimeAsync(pingIntervalMs);
			}
			// State check: total elapsed since the initial ping is still < 30 min -> no floor yet.
			expect(performance.now() - firstPingTimeMs).toBeLessThan(floorMs);
			// Pings should still have been skipped across all those ticks (only the initial fired)
			// because each external refresh keeps shouldSkipForRecentData() true.
			expect((conn as any).ping).toHaveBeenCalledTimes(1);

			// Now feed one more fresh update and advance one more tick: the floor forces a ping
			// even though data is still recent.
			connMonitor.updateLastKnownConnectionTime(); // data still recent
			await vi.advanceTimersByTimeAsync(pingIntervalMs);
			expect((conn as any).ping).toHaveBeenCalledTimes(2);

			teardownConn(conn);
		});

		test('_clearPingInterval clears the interval id', async () => {
			const conn = makeConnectedConn('127.0.0.14');
			(conn as any)._setPingInterval();
			expect((conn as any)._pingIntervalId).not.toBeNull();

			(conn as any)._clearPingInterval();
			expect((conn as any)._pingIntervalId).toBeNull();
			// Advancing time past the would-be first tick fires nothing.
			await vi.advanceTimersByTimeAsync(5000);
			expect((conn as any).ping).toHaveBeenCalledTimes(0);

			teardownConn(conn);
		});

		test('_setPingInterval is idempotent (no double-scheduling if already started)', () => {
			const conn = makeConnectedConn('127.0.0.15');
			(conn as any)._setPingInterval();
			const intervalIdBefore = (conn as any)._pingIntervalId;
			(conn as any)._setPingInterval(); // no-op
			expect((conn as any)._pingIntervalId).toBe(intervalIdBefore);
			teardownConn(conn);
		});

		test('ping tick is skipped when the node is not connected', async () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.16',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});
			(conn as any).connected = () => false;
			(conn as any).ping = vi.fn(async () => 0);
			(conn as any)._setPingInterval();

			// Several ping intervals pass without a connected socket; no pings are sent.
			await vi.advanceTimersByTimeAsync(connMonitor.getPingIntervalMs() * 3);
			expect((conn as any).ping).toHaveBeenCalledTimes(0);

			teardownConn(conn);
		});

		test('a failed ping tick does not stop the interval; subsequent ticks keep pinging', async () => {
			const conn = makeConnectedConn('127.0.0.17');
			(conn as any).ping = vi.fn().mockRejectedValue(new Error('Ping timed out'));
			(conn as any)._setPingInterval();

			// The first tick fails (e.g. a quiet-node timeout during an outage).
			await vi.advanceTimersByTimeAsync(connMonitor.getPingIntervalMs());
			expect((conn as any).ping).toHaveBeenCalledTimes(1);

			// The catch in the tick keeps the interval alive: the next tick pings again.
			await vi.advanceTimersByTimeAsync(connMonitor.getPingIntervalMs());
			expect((conn as any).ping).toHaveBeenCalledTimes(2);

			teardownConn(conn);
		});
	});

	describe('_syncHeaders with a losing fork taller than the longest chain', () => {
		let db: BlockHeadersDatabase;
		let databasePath: string;
		let connMonitor: ConnectionMonitor;

		beforeEach(async () => {
			databasePath = `tests/db/node-connection-fork-${getRandomHexString(16)}`;
			await mkdir(databasePath, { recursive: true });
			db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({
				databasePath,
				invalidBlocks: Array.from(getInvalidBlocks(chain))
			}));
			connMonitor = new ConnectionMonitor({ intervalMs: 20000, timeoutMs: 10000 });
		});

		afterEach(async () => {
			if (db) await db.close();
			await removeDirectoryWithRetries(databasePath);
		});

		// Low difficulty bits so test headers can be mined without a network connection. The
		// values are approximately 8 work and 2 work per header respectively.
		const HARDEST_BITS_HEX = 'ffff1f20';
		const EASY_BITS_HEX = 'ffff7f20';

		function createValidHeader(prevHashHex: string, nonce: number, bitsHex: string): BlockHeaderMutable {
			for (let attempt = 0; ; attempt++) {
				const buffer = Buffer.alloc(80);
				buffer.writeUInt32LE(1, 0);
				Buffer.from(prevHashHex, 'hex').reverse().copy(buffer, 4);
				buffer.writeUInt32LE(nonce + attempt, 68);
				Buffer.from(bitsHex, 'hex').copy(buffer, 72);
				buffer.writeUInt32LE(nonce + attempt, 76);
				try {
					return BlockHeaderMutable.fromBuffer(buffer);
				} catch { /* Invalid proof of work: try the next nonce. */ }
			}
		}

		test('does not throw when the downloaded tip is a losing fork taller than the longest chain', async () => {
			const mainChain: BlockHeaderMutable[] = [];
			let prevHashHex = db.getHeaderTip().hashHex;
			for (let i = 0; i < 4; i++) {
				const header = createValidHeader(prevHashHex, 100000 + i * 13, HARDEST_BITS_HEX);
				mainChain.push(header);
				prevHashHex = header.hashHex;
			}
			db.addHeaders(mainChain);
			expect(db.getHeaderTip().height).toBe(4);

			// This fork is taller (11 headers) but has less total work (11 * 2 < 4 * 8), so it
			// never becomes the longest chain and its tip is taller than the chain tip.
			const fork: BlockHeaderMutable[] = [];
			prevHashHex = mainChain[0].hashHex;
			for (let i = 0; i < 11; i++) {
				const header = createValidHeader(prevHashHex, 200000 + i * 13, EASY_BITS_HEX);
				fork.push(header);
				prevHashHex = header.hashHex;
			}

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.18',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});
			(conn as any).connected = () => true;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return getHeadersCallCount === 1 ? fork : [];
			};

			await expect((conn as any)._syncHeaders()).resolves.toBeUndefined();
			expect(db.getHeaderTip().hashHex).toBe(mainChain.at(-1)!.hashHex);
			expect(db.getHeaderFromHashHex(fork.at(-1)!.hashHex)?.height).toBe(12);
			conn[Symbol.dispose]();
		});
	});

	describe('_syncHeaders early stop and out-of-sync behavior', () => {
		let db: BlockHeadersDatabase;
		let databasePath: string;
		let connMonitor: ConnectionMonitor;

		beforeEach(async () => {
			databasePath = `tests/db/node-connection-duplicate-${getRandomHexString(16)}`;
			await mkdir(databasePath, { recursive: true });
			db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({
				databasePath,
				invalidBlocks: Array.from(getInvalidBlocks(chain))
			}));
			connMonitor = new ConnectionMonitor({ intervalMs: 20000, timeoutMs: 10000 });
		});

		afterEach(async () => {
			if (db) await db.close();
			await removeDirectoryWithRetries(databasePath);
		});

		const HARDEST_BITS_HEX = 'ffff1f20';
		const EASY_BITS_HEX = 'ffff7f20';

		function createValidHeader(prevHashHex: string, nonce: number, bitsHex: string = HARDEST_BITS_HEX): BlockHeaderMutable {
			for (let attempt = 0; ; attempt++) {
				const buffer = Buffer.alloc(80);
				buffer.writeUInt32LE(1, 0);
				Buffer.from(prevHashHex, 'hex').reverse().copy(buffer, 4);
				buffer.writeUInt32LE(nonce + attempt, 68);
				Buffer.from(bitsHex, 'hex').copy(buffer, 72);
				buffer.writeUInt32LE(nonce + attempt, 76);
				try {
					return BlockHeaderMutable.fromBuffer(buffer);
				} catch { /* Invalid proof of work: try the next nonce. */ }
			}
		}

		function createChain(length: number): BlockHeaderMutable[] {
			const headers: BlockHeaderMutable[] = [];
			let prevHashHex = db.getHeaderTip().hashHex;
			for (let i = 0; i < length; i++) {
				const header = createValidHeader(prevHashHex, 100000 + i * 13);
				headers.push(header);
				prevHashHex = header.hashHex;
			}
			return headers;
		}

		test('stops when the batch reaches the announced tip even if another connection added the header first', async () => {
			const chainHeaders = createChain(3);
			db.addHeaders(chainHeaders.slice(0, 2));
			const newTipHeader = chainHeaders.at(-1)!;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.21',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			// The inv handler sets _tipHashHex to the announced header before syncing.
			(conn as any)._tipHashHex = newTipHeader.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				if (getHeadersCallCount > 1) {
					return [];
				}
				// Another connection adds the header while this request is in flight, so this
				// connection downloads it as a duplicate.
				db.addHeaders([newTipHeader]);
				return [newTipHeader];
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);
			let newChainTipCount = 0;
			conn.on('new_chain_tip', () => newChainTipCount++);

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(1);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(outOfSyncCount).toBe(0);
			expect(newChainTipCount).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(newTipHeader.hashHex);
			conn[Symbol.dispose]();
		});

		test('stops without an extra request when this connection downloads the announced tip', async () => {
			const chainHeaders = createChain(3);
			db.addHeaders(chainHeaders.slice(0, 2));
			const newTipHeader = chainHeaders.at(-1)!;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.24',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = newTipHeader.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return [newTipHeader];
			};
			let newChainTipCount = 0;
			conn.on('new_chain_tip', () => newChainTipCount++);
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(1);
			expect(newChainTipCount).toBe(1);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(outOfSyncCount).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(newTipHeader.hashHex);
			conn[Symbol.dispose]();
		});

		test('keeps fetching when an inv for the batch tail arrives mid-request and the peer has more headers', async () => {
			const chainHeaders = createChain(7);
			db.addHeaders(chainHeaders.slice(0, 1));
			const announcedTip = chainHeaders[4];

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.41',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				if (getHeadersCallCount === 1) {
					// The inv for the batch's last header arrives while the request is in flight.
					(conn as any)._tipHashHex = announcedTip.hashHex;
					return chainHeaders.slice(1, 5);
				}
				if (getHeadersCallCount === 2) {
					// The peer has more headers after the announced tip.
					return chainHeaders.slice(5, 7);
				}
				return [];
			};
			const chainTips: string[] = [];
			conn.on('new_chain_tip', (_height: number, hashHex: string) => chainTips.push(hashHex));

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(3);
			expect(chainTips).toEqual([announcedTip.hashHex, chainHeaders[6].hashHex]);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(db.getHeaderTip().hashHex).toBe(chainHeaders[6].hashHex);
			conn[Symbol.dispose]();
		});

		test('still emits out_of_sync when the early stop happens for a peer far behind on a fork', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);
			const forkHeader = createValidHeader(mainChain[0].hashHex, 200000, EASY_BITS_HEX);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.25',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = forkHeader.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return [forkHeader];
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(1);
			expect(outOfSyncCount).toBe(1);
			expect(warnSpy).not.toHaveBeenCalled();
			conn[Symbol.dispose]();
		});

		test('breaks immediately when the peer returns a batch ending at the first requested hash', async () => {
			const chainHeaders = createChain(3);
			db.addHeaders(chainHeaders);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.22',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			// A peer that ignores the "from" position and returns the same batch every time.
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return chainHeaders;
			};

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(1);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			conn[Symbol.dispose]();
		});

		test('breaks when a peer that ignores the "from" position repeats a batch that does not end at the first requested hash', async () => {
			const chainHeaders = createChain(3);
			db.addHeaders(chainHeaders);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.23',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			// The first response ends at chainHeaders[0], which is not the hash the first request
			// was made from, so the guard breaks on the next request that repeats it.
			(conn as any).getHeaders = async () => [chainHeaders[0]];

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(warnSpy).toHaveBeenCalledTimes(1);
			conn[Symbol.dispose]();
		});

		test('a newer tip announced while the request is in flight is fetched by the follow-up sync', async () => {
			const chainHeaders = createChain(4);
			db.addHeaders(chainHeaders.slice(0, 2));
			const tip1 = chainHeaders[2];
			const tip2 = chainHeaders[3];

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.26',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = tip1.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				if (getHeadersCallCount === 1) {
					// The inv for the newer tip arrives while this request is in flight.
					(conn as any)._tipHashHex = tip2.hashHex;
					return [tip1];
				}
				if (getHeadersCallCount === 2) {
					return [tip2];
				}
				return [];
			};
			const chainTips: string[] = [];
			conn.on('new_chain_tip', (_height: number, hashHex: string) => chainTips.push(hashHex));

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			// The first sync only trusts the tip it knew when it asked.
			await conn.syncHeaders({});
			expect(getHeadersCallCount).toBe(1);
			expect((conn as any)._tipHashHex).toBe(tip1.hashHex);
			expect(db.getHeaderTip().hashHex).toBe(tip1.hashHex);

			// The inv for the newer tip queued a follow-up sync, which fetches it.
			await conn.syncHeaders({});
			expect(getHeadersCallCount).toBe(3);
			expect(chainTips).toEqual([tip1.hashHex, tip2.hashHex]);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(db.getHeaderTip().hashHex).toBe(tip2.hashHex);
			conn[Symbol.dispose]();
		});

		test('keeps asking when the response covers a tip announced mid-request', async () => {
			const chainHeaders = createChain(4);
			db.addHeaders(chainHeaders.slice(0, 2));
			const tip1 = chainHeaders[2];
			const tip2 = chainHeaders[3];

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.27',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = tip1.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				if (getHeadersCallCount > 1) {
					return [];
				}
				// The inv for the newer tip arrives while this request is in flight, and the
				// response already contains both headers.
				(conn as any)._tipHashHex = tip2.hashHex;
				return [tip1, tip2];
			};
			const chainTips: string[] = [];
			conn.on('new_chain_tip', (_height: number, hashHex: string) => chainTips.push(hashHex));

			await (conn as any)._syncHeaders();
			// The response went past the tip known when the request was sent, so the sync asks
			// once more and stops on the empty response.
			expect(getHeadersCallCount).toBe(2);
			expect(chainTips).toEqual([tip2.hashHex]);
			expect(db.getHeaderTip().hashHex).toBe(tip2.hashHex);
			conn[Symbol.dispose]();
		});

		test('keeps syncing across multiple batches until the announced tip is reached', async () => {
			const chainHeaders = createChain(6);
			db.addHeaders(chainHeaders.slice(0, 1));
			const announcedTip = chainHeaders.at(-1)!;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.28',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = announcedTip.hashHex;
			const requestedTips: string[] = [];
			const requestedFroms: string[] = [];
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async ({ from }: { from: Buffer[] }) => {
				getHeadersCallCount++;
				requestedTips.push((conn as any)._tipHashHex);
				requestedFroms.push(from[0].toString('hex'));
				if (getHeadersCallCount === 1) {
					return chainHeaders.slice(1, 3);
				}
				if (getHeadersCallCount === 2) {
					return chainHeaders.slice(3, 6);
				}
				return [];
			};

			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(3);
			expect(requestedTips[0]).toBe(announcedTip.hashHex);
			// After the first request, _tipHashHex is overwritten by each batch's last header and
			// `from` starts at that same header, so the reached-tip stop degenerates into the
			// "from" check and cannot fire mid-sync. The second batch reaches the announced tip
			// and the sync still ends on the empty response.
			expect(requestedTips.slice(1)).toEqual(requestedFroms.slice(1));
			expect(requestedTips[1]).not.toBe(announcedTip.hashHex);
			expect(db.getHeaderTip().hashHex).toBe(announcedTip.hashHex);
			conn[Symbol.dispose]();
		});

		test('stops at a capped first response that ends at the announced tip and continues on the next sync', async () => {
			const chainHeaders = createChain(2010);
			db.addHeaders(chainHeaders.slice(0, 1));
			const announcedTip = chainHeaders[2000];

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.42',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = announcedTip.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				if (getHeadersCallCount === 1) {
					// The peer's response limit is reached exactly at the announced tip even
					// though it has more headers behind it.
					return chainHeaders.slice(1, 2001);
				}
				if (getHeadersCallCount === 2) {
					return chainHeaders.slice(2001, 2010);
				}
				return [];
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			await (conn as any)._syncHeaders();
			// The sync stops at the announced tip. The headers behind the capped response arrive
			// with the next inv or the health-monitor sync, which is simulated here.
			expect(getHeadersCallCount).toBe(1);
			expect(db.getHeaderTip().hashHex).toBe(announcedTip.hashHex);
			expect(outOfSyncCount).toBe(0);

			await conn.syncHeaders({});
			expect(getHeadersCallCount).toBe(3);
			expect(db.getHeaderTip().hashHex).toBe(chainHeaders[2009].hashHex);
			conn[Symbol.dispose]();
		});

		test('a follow-up sync starts from the updated tip and fetches the next announced block', async () => {
			const chainHeaders = createChain(4);
			db.addHeaders(chainHeaders.slice(0, 2));
			const tip1 = chainHeaders[2];
			const tip2 = chainHeaders[3];

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.29',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = tip1.hashHex;
			const requestedFromTips: string[] = [];
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async ({ from }: { from: Buffer[] }) => {
				getHeadersCallCount++;
				requestedFromTips.push(from[0].toString('hex'));
				if (getHeadersCallCount === 1) {
					return [tip1];
				}
				if (getHeadersCallCount === 2) {
					return [tip2];
				}
				return [];
			};

			await conn.syncHeaders({});
			expect(getHeadersCallCount).toBe(1);
			expect(db.getHeaderTip().hashHex).toBe(tip1.hashHex);

			// The inv for the next tip arrives after the first sync stopped.
			(conn as any)._tipHashHex = tip2.hashHex;
			await conn.syncHeaders({});

			expect(getHeadersCallCount).toBe(2);
			expect(requestedFromTips).toEqual([chainHeaders[1].hashHex, tip1.hashHex]);
			expect(db.getHeaderTip().hashHex).toBe(tip2.hashHex);
			conn[Symbol.dispose]();
		});

		test('still emits out_of_sync from an empty response when the connection tip is far behind', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.30',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = mainChain[0].hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return [];
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(1);
			expect(outOfSyncCount).toBe(1);
			conn[Symbol.dispose]();
		});

		test('does not emit out_of_sync when the tip last seen was announced but not downloaded yet', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);
			// A header that is not in the database, like a peer's new tip announced while a
			// getheaders request is in flight.
			const announcedHeader = createValidHeader(mainChain.at(-1)!.hashHex, 600000);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.40',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any).getHeaders = async () => {
				// The inv for the peer's new tip is processed before the awaited continuation
				// resumes, so _tipHashHex points at a header that is not in the database.
				(conn as any)._tipHashHex = announcedHeader.hashHex;
				return [];
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			await (conn as any)._syncHeaders();
			expect(outOfSyncCount).toBe(0);
			conn[Symbol.dispose]();
		});

		test('does not emit out_of_sync when the connection tip is exactly the allowed distance behind', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.31',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			// mainChain[3] is at height 4, exactly 100 behind the chain tip at height 104.
			(conn as any)._tipHashHex = mainChain[3].hashHex;
			(conn as any).getHeaders = async () => [];
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			await (conn as any)._syncHeaders();
			expect(outOfSyncCount).toBe(0);
			conn[Symbol.dispose]();
		});

		test('does not emit out_of_sync when the connection tip is its starting tip', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.32',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			// _tipHashHex defaults to the starting tip, which is excluded from the check.
			(conn as any).getHeaders = async () => [];
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			await (conn as any)._syncHeaders();
			expect(outOfSyncCount).toBe(0);
			conn[Symbol.dispose]();
		});

		test('waits for the chain tip to stop being extended before resetting the locator when far behind', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.33',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = mainChain[0].hashHex;
			const tipsAtRequest: string[] = [];
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				tipsAtRequest.push((conn as any)._tipHashHex);
				if (getHeadersCallCount === 1) {
					// A batch that ends far behind the chain tip.
					return mainChain.slice(40, 45);
				}
				return [];
			};
			// The first read is recent, the read after the sleep is old enough.
			const timeSpy = vi.spyOn(db, 'getTimeSinceLastChainTipExtensionThisSessionMs')
				.mockReturnValueOnce(0)
				.mockReturnValue(6000);

			vi.useFakeTimers();
			try {
				const syncPromise = (conn as any)._syncHeaders();
				await vi.advanceTimersByTimeAsync(0);
				await vi.advanceTimersByTimeAsync(500);
				await syncPromise;
			} finally {
				vi.useRealTimers();
			}

			expect(timeSpy).toHaveBeenCalledTimes(2);
			expect(getHeadersCallCount).toBe(2);
			expect(tipsAtRequest).toEqual([mainChain[0].hashHex, (conn as any)._startingTipHashHex]);
			conn[Symbol.dispose]();
		});

		test('throws when the downloaded batch ends at a header that was not added to the database', async () => {
			const chainHeaders = createChain(2);
			db.addHeaders(chainHeaders);
			// An orphan header whose parent is not in the database.
			const orphanHeader = createValidHeader('11'.repeat(32), 300000);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.34',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = orphanHeader.hashHex;
			(conn as any).getHeaders = async () => [orphanHeader];

			await expect(conn.syncHeaders({})).rejects.toThrow('Downloading headers out of order');
			expect((conn as any)._tipHashHex).toBe((conn as any)._startingTipHashHex);
			conn[Symbol.dispose]();
		});

		test('stops after one batch when the announced tip wins a reorg', async () => {
			const mainChain = createChain(2);
			db.addHeaders(mainChain);
			// A longer fork from mainChain[0] has more work, so it becomes the longest chain.
			const fork: BlockHeaderMutable[] = [];
			let prevHashHex = mainChain[0].hashHex;
			for (let i = 0; i < 3; i++) {
				const header = createValidHeader(prevHashHex, 400000 + i * 13);
				fork.push(header);
				prevHashHex = header.hashHex;
			}
			const forkTip = fork.at(-1)!;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.35',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = forkTip.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return fork;
			};
			let newChainTipCount = 0;
			conn.on('new_chain_tip', () => newChainTipCount++);
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(1);
			expect(newChainTipCount).toBe(1);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(outOfSyncCount).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(forkTip.hashHex);
			conn[Symbol.dispose]();
		});

		test('emits out_of_sync when a peer that ignores the "from" position is far behind', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.36',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			let getHeadersCallCount = 0;
			// Every response ends at the header at height 3, more than 100 blocks behind the chain tip.
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return [mainChain[2]];
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			// The undefined wait check makes the loop continue without sleeping after the first
			// batch, so the second request repeats the batch and the "from" guard breaks.
			const timeSpy = vi.spyOn(db, 'getTimeSinceLastChainTipExtensionThisSessionMs').mockReturnValue(undefined);
			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(2);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(outOfSyncCount).toBe(1);
			expect(timeSpy).toHaveBeenCalledTimes(1);
			conn[Symbol.dispose]();
		});

		test('does not emit out_of_sync when the early stop tip is exactly the allowed distance behind', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);
			// A fork from mainChain[0] with easier bits stays off the longest chain and its tip
			// at height 4 is exactly 100 blocks behind the chain tip at height 104.
			const fork: BlockHeaderMutable[] = [];
			let prevHashHex = mainChain[0].hashHex;
			for (let i = 0; i < 3; i++) {
				const header = createValidHeader(prevHashHex, 500000 + i * 13, EASY_BITS_HEX);
				fork.push(header);
				prevHashHex = header.hashHex;
			}
			const forkTip = fork.at(-1)!;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.37',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = forkTip.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				return fork;
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			expect(getHeadersCallCount).toBe(1);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(outOfSyncCount).toBe(0);
			expect(db.getHeaderFromHashHex(forkTip.hashHex)?.height).toBe(4);
			expect(db.getHeaderTip().hashHex).toBe(mainChain.at(-1)!.hashHex);
			conn[Symbol.dispose]();
		});

		test('emits out_of_sync when a later sync early-stops on a stale announced tip', async () => {
			const mainChain = createChain(104);
			db.addHeaders(mainChain);

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.38',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = mainChain.at(-1)!.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				if (getHeadersCallCount === 1) {
					return [];
				}
				return [mainChain.at(-1)!];
			};
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			await conn.syncHeaders({});
			expect(getHeadersCallCount).toBe(1);
			expect(outOfSyncCount).toBe(0);

			// The chain advances through other connections while this connection stays quiet.
			db.addHeaders(createChain(101));

			// The stale announced tip is now more than 100 blocks behind the chain tip.
			await conn.syncHeaders({});
			expect(getHeadersCallCount).toBe(2);
			expect(outOfSyncCount).toBe(1);
			expect(db.getHeaderTip().height).toBe(205);
			conn[Symbol.dispose]();
		});

		test('keeps syncing to the real tip when an older inv arrives while the request is in flight', async () => {
			const chainHeaders = createChain(4);
			db.addHeaders(chainHeaders.slice(0, 2));
			const announcedTip = chainHeaders[3];
			const olderHeader = chainHeaders[1];

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.39',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
				enableConsoleDebugLog: true,
			});
			(conn as any).connected = () => true;
			(conn as any)._tipHashHex = announcedTip.hashHex;
			let getHeadersCallCount = 0;
			(conn as any).getHeaders = async () => {
				getHeadersCallCount++;
				if (getHeadersCallCount === 1) {
					// An inv for an older block arrives while this request is in flight.
					(conn as any)._tipHashHex = olderHeader.hashHex;
					return [chainHeaders[2], announcedTip];
				}
				return [];
			};
			const chainTips: string[] = [];
			conn.on('new_chain_tip', (_height: number, hashHex: string) => chainTips.push(hashHex));
			let outOfSyncCount = 0;
			conn.on('out_of_sync', () => outOfSyncCount++);

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
			await (conn as any)._syncHeaders();
			// The older inv must not extend the sync: the response already reached the tip
			// known when the request was sent.
			expect(getHeadersCallCount).toBe(1);
			expect(chainTips).toEqual([announcedTip.hashHex]);
			expect(warnSpy).not.toHaveBeenCalled();
			expect(outOfSyncCount).toBe(0);
			expect(db.getHeaderTip().hashHex).toBe(announcedTip.hashHex);
			conn[Symbol.dispose]();
		});
	});

	describe('message handling safety', () => {
		let db: BlockHeadersDatabase;
		let databasePath: string;
		let connMonitor: ConnectionMonitor;

		beforeEach(async () => {
			databasePath = `tests/db/node-connection-safety-${getRandomHexString(16)}`;
			await mkdir(databasePath, { recursive: true });
			db = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({
				databasePath,
				invalidBlocks: Array.from(getInvalidBlocks(chain))
			}));
			connMonitor = new ConnectionMonitor({ intervalMs: 20000, timeoutMs: 10000 });
		});

		afterEach(async () => {
			if (db) await db.close();
			await removeDirectoryWithRetries(databasePath);
		});

		// Starts a fake node that completes the handshake, replies to pings, and then stays connected.
		async function startHandshakeServer(): Promise<{ server: net.Server; port: number }> {
			const magic = getMagic(chain);
			const server = net.createServer((socket) => {
				let buffer: Buffer = Buffer.alloc(0);
				let sentVersion = false;
				socket.on('data', (data) => {
					buffer = Buffer.concat([buffer, typeof data === 'string' ? Buffer.from(data) : data]);
					const parsed = parseMessages(buffer, magic);
					buffer = parsed.remaining;
					for (const message of parsed.messages) {
						if (message.command === 'version' && !sentVersion) {
							sentVersion = true;
							socket.write(buildMessage(magic, 'version', Buffer.alloc(0)));
						} else if (message.command === 'verack') {
							socket.write(buildMessage(magic, 'verack', Buffer.alloc(0)));
						} else if (message.command === 'ping') {
							socket.write(buildMessage(magic, 'pong', message.payload));
						}
					}
				});
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			return { server, port: (server.address() as net.AddressInfo).port };
		}

		test('replying to a ping while a connect is pending does not throw', () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.19',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const writes: Buffer[] = [];
			(conn as any)._socket = {
				write: (buffer: Buffer) => { writes.push(buffer); return true; },
				removeAllListeners: () => { },
				destroy: () => { },
			};
			(conn as any)._pendingConnect = {
				promise: Promise.resolve(),
				resolve: () => { },
				reject: () => { },
				timeout: setTimeout(() => { }, 10000),
			};

			const payload = Buffer.from('0011223344556677', 'hex');
			expect(() => (conn as any)._handleMessage({ command: 'ping', payload })).not.toThrow();
			expect(writes).toHaveLength(1);

			const { messages } = parseMessages(writes[0], getMagic(chain));
			expect(messages).toHaveLength(1);
			expect(messages[0].command).toBe('pong');
			expect(messages[0].payload.equals(payload)).toBe(true);

			conn[Symbol.dispose]();
		});

		test('a peer sending version then ping without verack cannot crash the client', async () => {
			const magic = getMagic(chain);
			const server = net.createServer((socket) => {
				socket.once('data', () => {
					const versionMessage = buildMessage(magic, 'version', Buffer.alloc(0));
					const pingMessage = buildMessage(magic, 'ping', Buffer.from('0011223344556677', 'hex'));
					socket.write(Buffer.concat([versionMessage, pingMessage]));
				});
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const port = (server.address() as net.AddressInfo).port;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const disconnects: string[] = [];
			conn.on('disconnect_unintentional_before_connect', () => disconnects.push('before'));
			conn.on('disconnect_unintentional_after_connect', () => disconnects.push('after'));

			// The peer never sends verack, so connect() must time out cleanly. Before the
			// fix the ping reply threw and escaped the socket data handler as an uncaught
			// exception, crashing the process.
			await expect(conn.connect({ timeoutMs: 1000 })).rejects.toThrow('Connection timed out');
			expect(disconnects).toEqual(['before']);

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('a peer declaring an oversized message length before the handshake cannot crash the client', async () => {
			const magic = getMagic(chain);
			const server = net.createServer((socket) => {
				socket.once('data', () => {
					// 24-byte message header that lies about its payload size without
					// sending any payload. Before the fix the client kept buffering the
					// rest of the connection's data until it ran out of memory.
					const message = buildMessage(magic, 'inv', Buffer.alloc(0));
					message.writeUInt32LE(0xffffffff, 16);
					socket.write(message);
				});
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const port = (server.address() as net.AddressInfo).port;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			vi.spyOn(console, 'error').mockImplementation(() => { });
			const disconnects: string[] = [];
			conn.on('disconnect_unintentional_before_connect', () => disconnects.push('before'));
			conn.on('disconnect_unintentional_after_connect', () => disconnects.push('after'));

			// The oversized message is a protocol violation, so the peer must be
			// disconnected instead of the client buffering the declared payload.
			await expect(conn.connect({ timeoutMs: 3000 })).rejects.toThrow('closed during a pending connect');
			expect(disconnects).toEqual(['before']);
			expect(conn.connected()).toBe(false);

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('a message handler error disconnects only that peer instead of propagating', async () => {
			const { server, port } = await startHandshakeServer();

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			vi.spyOn(console, 'error').mockImplementation(() => { });
			let afterConnectDisconnects = 0;
			conn.on('disconnect_unintentional_after_connect', () => afterConnectDisconnects++);
			conn.on('connect', () => { throw new Error('Simulated listener failure'); });

			// The verack handling emitted 'connect', whose listener threw. The guard must
			// disconnect the peer instead of letting the error escape as an uncaught
			// exception, and connect() must still resolve instead of hanging.
			await conn.connect({ timeoutMs: 3000 });
			await vi.waitFor(() => expect(afterConnectDisconnects).toBe(1));
			expect(conn.connected()).toBe(false);

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('connect() resolves before a throwing connect listener can hang it and listeners still run first', async () => {
			const { server, port } = await startHandshakeServer();

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			vi.spyOn(console, 'error').mockImplementation(() => { });
			const order: string[] = [];
			conn.on('connect', () => {
				order.push('listener');
				throw new Error('Simulated listener failure');
			});

			await conn.connect({ timeoutMs: 3000 });
			order.push('await');

			// resolve() runs before emit('connect'), so the throwing listener cannot leave
			// the promise pending. Promise continuations are microtasks, so the listener
			// still observes the event before the awaiting caller resumes.
			expect(order).toEqual(['listener', 'await']);

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('a throwing pong listener cannot strand the ping promise and only disconnects that peer', async () => {
			const { server, port } = await startHandshakeServer();

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			vi.spyOn(console, 'error').mockImplementation(() => { });
			let afterConnectDisconnects = 0;
			conn.on('disconnect_unintentional_after_connect', () => afterConnectDisconnects++);
			await conn.connect({ timeoutMs: 3000 });
			conn.on('pong', () => { throw new Error('Simulated pong listener failure'); });

			// The pong handling resolves the ping promise before emitting, so the throwing
			// listener disconnects the peer instead of stranding the ping forever after
			// its timeout was cleared and its pending entry was deleted.
			const durationMs = await conn.ping({ timeoutMs: 3000 });
			expect(typeof durationMs).toBe('number');
			await vi.waitFor(() => expect(afterConnectDisconnects).toBe(1));
			expect(conn.connected()).toBe(false);

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('a listener that disconnects and then throws does not report an unintentional disconnect', async () => {
			const { server, port } = await startHandshakeServer();

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			vi.spyOn(console, 'error').mockImplementation(() => { });
			let disconnects = 0;
			let unintentionalDisconnects = 0;
			conn.on('disconnect', () => disconnects++);
			conn.on('disconnect_unintentional_before_connect', () => unintentionalDisconnects++);
			conn.on('disconnect_unintentional_after_connect', () => unintentionalDisconnects++);
			conn.on('connect', () => {
				conn.disconnect();
				throw new Error('Simulated listener failure');
			});

			await conn.connect({ timeoutMs: 3000 });
			await vi.waitFor(() => expect(disconnects).toBe(1));

			// disconnect() already reported the intentional close, so the message-handler
			// guard must not emit a spurious unintentional disconnect event.
			expect(unintentionalDisconnects).toBe(0);
			expect(conn.connected()).toBe(false);

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('a throwing unintentional disconnect listener cannot escape the connect timeout', async () => {
			// Accepts the TCP connection but never completes the handshake. Draining the
			// socket lets it close when the client times out and destroys its side.
			const server = net.createServer((socket) => { socket.resume(); });
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const port = (server.address() as net.AddressInfo).port;

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
			conn.on('disconnect_unintentional_before_connect', () => { throw new Error('Simulated disconnect listener failure'); });

			// The disconnect event is emitted from a timer callback, so a throwing listener
			// must be swallowed there instead of escaping as an uncaught exception.
			await expect(conn.connect({ timeoutMs: 1000 })).rejects.toThrow('Connection timed out');
			expect(errorSpy).toHaveBeenCalled();

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('a listener that disconnects and reconnects before throwing leaves the new connection alone', async () => {
			const { server, port } = await startHandshakeServer();

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			vi.spyOn(console, 'error').mockImplementation(() => { });
			let unintentionalDisconnects = 0;
			conn.on('disconnect_unintentional_before_connect', () => unintentionalDisconnects++);
			conn.on('disconnect_unintentional_after_connect', () => unintentionalDisconnects++);

			await conn.connect({ timeoutMs: 3000 });

			let reconnectPromise: Promise<void> | undefined;
			conn.on('pong', () => {
				conn.disconnect();
				reconnectPromise = conn.connect({ timeoutMs: 3000 });
				throw new Error('Simulated listener failure');
			});

			await conn.ping({ timeoutMs: 3000 });
			expect(reconnectPromise).toBeDefined();
			await reconnectPromise;

			// The message-handler guard must leave a connection that replaced the failing
			// socket untouched instead of tearing it down with a spurious involuntary
			// disconnect event.
			expect(conn.connected()).toBe(true);
			expect(unintentionalDisconnects).toBe(0);

			conn[Symbol.dispose]();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});

		test('a throwing disconnect listener cannot escape a manual disconnect', () => {
			const conn = new LegacyNodeConnection({
				ip: '127.0.0.19',
				port: 8333,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
			conn.on('disconnect', () => { throw new Error('Simulated disconnect listener failure'); });

			// disconnect() is called by the connect-abort path, where a throwing listener
			// would otherwise escape the abort callback as an uncaught exception.
			expect(() => conn.disconnect()).not.toThrow();
			expect(errorSpy).toHaveBeenCalled();

			conn[Symbol.dispose]();
		});
	});
});
