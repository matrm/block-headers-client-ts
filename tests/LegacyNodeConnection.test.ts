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

		test('a message handler error disconnects only that peer instead of propagating', async () => {
			const { server, port } = await startHandshakeServer();

			const conn = new LegacyNodeConnection({
				ip: '127.0.0.1',
				port,
				chain,
				blockHeadersDatabase: db,
				connectionMonitor: connMonitor,
			});

			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
			let afterConnectDisconnects = 0;
			conn.on('disconnect_unintentional_after_connect', () => afterConnectDisconnects++);
			conn.on('connect', () => { throw new Error('Simulated listener failure'); });

			// The verack handling emitted 'connect', whose listener threw. The guard must
			// disconnect the peer instead of letting the error escape as an uncaught
			// exception, and connect() must still resolve instead of hanging.
			await conn.connect({ timeoutMs: 3000 });
			await vi.waitFor(() => expect(afterConnectDisconnects).toBe(1));
			expect(conn.connected()).toBe(false);

			errorSpy.mockRestore();
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

			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
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

			errorSpy.mockRestore();
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

			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
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

			errorSpy.mockRestore();
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

			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
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

			errorSpy.mockRestore();
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

			errorSpy.mockRestore();
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

			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
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

			errorSpy.mockRestore();
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

			errorSpy.mockRestore();
			conn[Symbol.dispose]();
		});
	});
});
