/// <reference types="node" />
import { mkdir } from 'node:fs/promises';

import { expect, test, describe, beforeEach, afterEach } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import { BlockHeadersDatabase } from '../src/BlockHeadersDatabase';
import { ConnectionMonitor } from '../src/ConnectionMonitor';
import { LegacyNodeConnection } from '../src/LegacyNodeConnection';
import { Chain, getInvalidBlocks } from '../src/chainProtocol';
import { getRandomHexString } from '../src/utils/util';

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
			await new Promise(r => setTimeout(r, 0));
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			conn.syncHeaders({});
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			conn.syncHeaders({});
			expect((conn as any)._numSyncHeadersQueued).toBe(2);
			expect(syncCallCount).toBe(1);

			sync1Deferred.resolve(undefined);
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

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
			await new Promise(r => setTimeout(r, 0));
			expect(syncCallCount).toBe(1);
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			conn.syncHeaders({});
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			sync1Deferred.resolve(undefined);
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

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
			await new Promise(r => setTimeout(r, 0));
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
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

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
			await new Promise(r => setTimeout(r, 0));
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
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

			// Call 1 succeeded.
			expect(call1Rejection).toBeUndefined();
			expect(syncCallCount).toBe(2);

			// Call 2 fires and blocks on sync2Deferred.
			// Call 2 fails.
			sync2Deferred.resolve(undefined);
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

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
			await new Promise(r => setTimeout(r, 0));
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
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

			// Call 1 sees its own error, not call 2's.
			expect(call1Rejection).toBeInstanceOf(Error);
			expect(call1Rejection.message).toBe('Call 1 failed');
			expect(call1Rejection).not.toBe(call2Rejection);

			// Call 2 fires, then fails.
			sync2Deferred.resolve(undefined);
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

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
			await new Promise(r => setTimeout(r, 0));

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
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

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
			await new Promise(r => setTimeout(r, 0));
			expect((conn as any)._numSyncHeadersQueued).toBe(1);

			let c1r2: any; conn.syncHeaders({}).catch((err) => { c1r2 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			let c1r3: any; conn.syncHeaders({}).catch((err) => { c1r3 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			expect(syncCallCount).toBe(1);
			syncDeferreds[0].resolve();
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

			expect(syncCallCount).toBe(2);
			syncDeferreds[1].resolve();
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

			expect((conn as any)._numSyncHeadersQueued).toBe(0);
			expect(c1r1).toBeUndefined();
			expect(c1r2).toBeUndefined();
			expect(c1r3).toBeUndefined();

			// Cycle 2: new calls after drain should work fresh.
			let c2r1: any; conn.syncHeaders({}).catch((err) => { c2r1 = err; });
			await new Promise(r => setTimeout(r, 0));
			expect((conn as any)._numSyncHeadersQueued).toBe(1);
			expect(syncCallCount).toBe(3);

			let c2r2: any; conn.syncHeaders({}).catch((err) => { c2r2 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			let c2r3: any; conn.syncHeaders({}).catch((err) => { c2r3 = err; });
			let c2r4: any; conn.syncHeaders({}).catch((err) => { c2r4 = err; });
			expect((conn as any)._numSyncHeadersQueued).toBe(2);

			expect(syncCallCount).toBe(3);
			syncDeferreds[2].resolve();
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

			expect(syncCallCount).toBe(4);
			syncDeferreds[3].resolve();
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));

			expect((conn as any)._numSyncHeadersQueued).toBe(0);
			expect(c2r1).toBeUndefined();
			expect(c2r2).toBeUndefined();
			expect(c2r3).toBeUndefined();
			expect(c2r4).toBeUndefined();
		});
	});
});
