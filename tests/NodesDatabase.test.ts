import { mkdir } from 'node:fs/promises';

import { expect, test, describe, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { removeDirectoryWithRetries, createDbWithRetries } from './testUtils';

import {
	NodesDatabase,
	NodeConnectionMetrics,
	calculateRating,
	createDefaultNodeConnectionMetrics,
	createBlacklistedRatingThreshold,
	getHighestMetricsTime
} from '../src/NodesDatabase';
import { IpPort } from '../src/types';
import { ipPortToString, stringToIpPort } from '../src/utils/util';
import { DEFAULT_DATABASE_PATH } from '../src/constants';
import { getRandomHexString } from '../src/utils/util';

// Function to check if array is sorted in ascending order.
function isSorted(arr: number[]): boolean {
	return arr.every((_, i) => i === 0 || arr[i] >= arr[i - 1]);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const now = Date.now();
const blacklistedRatingThreshold = createBlacklistedRatingThreshold(true);
console.log('Blacklisted rating threshold:', blacklistedRatingThreshold);
{
	const defaultMetrics = createDefaultNodeConnectionMetrics(now);
	console.log('Default rating:', calculateRating(defaultMetrics, getHighestMetricsTime(defaultMetrics), now));
}

const sortedMetricsTests_recentUnintentionalDisconnectAfterConnectTimesMs = [
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now,
			now,
			now,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs-min', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now,
			now,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs-min+1', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 24 * 60 * 60 * 1000,
			now - 20 * 60 * 60 * 1000,
			now - 16 * 60 * 60 * 1000,
			now - 12 * 60 * 60 * 1000,
			now - 8 * 60 * 60 * 1000,
			now - 4 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs-4', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 10 * 60 * 60 * 1000,
			now - 5 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs-3', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 365 * 24 * 60 * 60 * 1000,
			now - 365 * 24 * 60 * 60 * 1000,
			now - 365 * 24 * 60 * 60 * 1000,
			now - 364 * 24 * 60 * 60 * 1000,
			now - 22 * 60 * 60 * 1000,
			now - 11 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs-2', rating);// Slightly lower than metrics used in blacklisted rating calculation.
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 22 * 60 * 60 * 1000,
			now - 11 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs-1', rating);// Slightly lower than metrics used in blacklisted rating calculation.
		return rating;
	})(),
	(() => {
		// Disconnected 3x after connecting within the last 24 hours with a good ping.
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 24 * 60 * 60 * 1000,
			now - 12 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs (should be close to 0.25)', rating);// Same metrics used in blacklisted rating calculation.
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 26 * 60 * 60 * 1000,
			now - 13 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs+1', rating);// Slightly higher than metrics used in blacklisted rating calculation.
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 48 * 60 * 60 * 1000,
			now - 24 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs+2', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 26 * 60 * 60 * 1000,
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs+3', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs+4', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 3 * 24 * 60 * 60 * 1000,
			now - 1 * 24 * 60 * 60 * 1000,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs+5', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 364 * 24 * 60 * 60 * 1000,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs+max-1', rating);
		return rating;
	})(),
	(() => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentUnintentionalDisconnectAfterConnectTimesMs = [
			now - 365 * 24 * 60 * 60 * 1000,
		];
		metrics.recentPingTimes = [{ pingDurationMs: 200, pingTimestampMs: now }];
		metrics.lastConnectTimeMs = now;
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		console.log('rating-recentUnintentionalDisconnectAfterConnectTimesMs+max', rating);
		return rating;
	})(),
];

describe('calculateRating', () => {
	const now = Date.now();

	// Test default metrics.
	test('should return >= 0.1 and <= 1 for default metrics', () => {
		const metrics = createDefaultNodeConnectionMetrics(now);
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		expect(rating).toBeGreaterThanOrEqual(0.1);
		expect(rating).toBeLessThanOrEqual(1);
	});

	// Test obviously bad nodes.
	describe('obviously bad nodes', () => {
		test('should return < 0.9 for high ping and recent disconnect', () => {
			const metrics = createDefaultNodeConnectionMetrics(now);
			metrics.recentPingTimes = [{ pingDurationMs: 20 * 1000, pingTimestampMs: now }];// 20-second ping now.
			metrics.recentUnintentionalDisconnectBeforeConnectTimesMs = [Date.now() - ONE_DAY_MS];// Disconnect 1 day ago.
			const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
			expect(rating).toBeLessThan(0.9);
			// Expected ~0.05 for reference, but using generous threshold.
		});

		test('should return < 0.9 for recent out of sync and invalid chain', () => {
			const metrics = createDefaultNodeConnectionMetrics(now);
			metrics.lastOutOfSyncTimeMs = Date.now() - ONE_DAY_MS;// Out of sync 1 day ago.
			metrics.lastInvalidChainDetectedTimeMs = Date.now() - 5 * ONE_DAY_MS;// Invalid chain 5 days ago.
			const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
			expect(rating).toBeLessThan(0.9);
			// Expected ~0.05 for reference.
		});

		test('should return < 0.9 for multiple recent disconnects and high ping', () => {
			const metrics = createDefaultNodeConnectionMetrics(now);
			metrics.recentUnintentionalDisconnectBeforeConnectTimesMs = [
				Date.now() - 1 * ONE_DAY_MS,
				Date.now() - 2 * ONE_DAY_MS,
				Date.now() - 3 * ONE_DAY_MS,
			];// 3 disconnects in last 3 days.
			metrics.recentPingTimes = [{ pingDurationMs: 15 * 1000, pingTimestampMs: now }];// 15-second ping now.
			const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
			expect(rating).toBeLessThan(0.9);
			// Expected ~0.03 for reference.
		});

		test('should return < 0.9 for all negative metrics', () => {
			const metrics = createDefaultNodeConnectionMetrics(now);
			metrics.recentPingTimes = [{ pingDurationMs: 20 * 1000, pingTimestampMs: now }];// 20-second ping now.
			metrics.recentUnintentionalDisconnectBeforeConnectTimesMs = [
				Date.now() - 1 * ONE_DAY_MS,
				Date.now() - 2 * ONE_DAY_MS,
			];// 2 disconnects.
			metrics.lastOutOfSyncTimeMs = Date.now() - 1 * ONE_DAY_MS;// Out of sync 1 day ago.
			metrics.lastInvalidChainDetectedTimeMs = Date.now() - 5 * ONE_DAY_MS;// Invalid chain 5 days ago.
			const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
			expect(rating).toBeLessThan(0.9);
			// Expected < 0.01 for reference.
		});
	});

	// Test rating bounds.
	test('should clamp rating between 0 and 1', () => {
		// Extreme bad case that could produce negative rating.
		const metrics = createDefaultNodeConnectionMetrics(now);
		metrics.recentPingTimes = [{ pingDurationMs: 1000 * 1000, pingTimestampMs: now }];// Extremely high ping now.
		metrics.recentUnintentionalDisconnectBeforeConnectTimesMs = Array(100).fill(Date.now());// Many disconnects.
		metrics.lastOutOfSyncTimeMs = Date.now();
		metrics.lastInvalidChainDetectedTimeMs = Date.now();
		const rating = calculateRating(metrics, getHighestMetricsTime(metrics), now);
		expect(rating).toBeGreaterThanOrEqual(0);
		expect(rating).toBeLessThanOrEqual(1);
	});

	// test sortedMetricsTests_recentUnintentionalDisconnectAfterConnectTimesMs.
	test('sortedMetricsTests_recentUnintentionalDisconnectAfterConnectTimesMs should be sorted', () => {
		expect(isSorted(sortedMetricsTests_recentUnintentionalDisconnectAfterConnectTimesMs)).toBe(true);
	});
});

// Helper to create IpPort.
const createIpPort = (ip: string, port: number): IpPort => ({ ip, port });

// --- Tests for NodesDatabase ---
describe('NodesDatabase', () => {
	let db: NodesDatabase;
	let databasePath: string;

	const baseIp = '192.168.1.';
	const basePort = 10000;
	// Shared array of ipPorts for all tests. DO NOT MODIFY this array or its elements inside of tests,
	// as it is frozen and reused across tests. The database is reset between tests, so unique
	// ipPorts are not required. If more ipPorts are needed, extend this array.
	const ipPorts = Object.freeze([
		Object.freeze(createIpPort(baseIp + '1', basePort + 1)),
		Object.freeze(createIpPort(baseIp + '2', basePort + 2)),
		Object.freeze(createIpPort(baseIp + '3', basePort + 3)),
		Object.freeze(createIpPort(baseIp + '4', basePort + 4)),
		Object.freeze(createIpPort(baseIp + '5', basePort + 5)),
	]);

	beforeEach(async (context) => {
		databasePath = getRandomHexString(16);

		await mkdir(databasePath, { recursive: true });

		db = await createDbWithRetries(() => NodesDatabase.create({ databasePath }));
	});

	afterEach(async () => {
		if (db) {
			await db.close();
		}
		await removeDirectoryWithRetries(databasePath);
	});

	// Test Cases for NodesDatabase methods.

	test('should create and close the database', async () => {
		expect(db).toBeInstanceOf(NodesDatabase);
	});

	test('should update lastSeenTimeMs when adding an existing node with addSeen', async () => {
		const ipPort = ipPorts[0];
		await db.addSeen(ipPort, Date.now());
		const initialSeenTime = db.getNodeSeenTimeMs(ipPort);
		expect(initialSeenTime).toBeTypeOf('number');

		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeen(ipPort, Date.now());
		const updatedSeenTime = db.getNodeSeenTimeMs(ipPort);

		expect(db.getNumNodes()).toBe(1);
		expect(updatedSeenTime).toBeTypeOf('number');
		expect(updatedSeenTime).toBeGreaterThan(initialSeenTime!);
	});

	test('should update existing nodes and add new ones with addSeenBatch', async () => {
		const existingIpPort = ipPorts[0];
		await db.addSeen(existingIpPort, Date.now());
		const initialSeenTime = db.getNodeSeenTimeMs(existingIpPort);

		const newIpPorts = [ipPorts[1], ipPorts[2]];
		const batchIpPorts = [existingIpPort, ...newIpPorts];

		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeenBatch(batchIpPorts, Date.now());

		expect(db.getNumNodes()).toBe(1 + newIpPorts.length);
		const updatedSeenTime = db.getNodeSeenTimeMs(existingIpPort);
		expect(updatedSeenTime).toBeTypeOf('number');
		expect(updatedSeenTime).toBeGreaterThan(initialSeenTime!);

		for (const ipPort of newIpPorts) {
			expect(db.getNodeSeenTimeMs(ipPort)).toBeTypeOf('number');
		}
	});

	test('should get seen time for an existing node', async () => {
		const ipPort = ipPorts[0];
		const timeMs = Date.now();
		await db.addSeen(ipPort, timeMs);
		const seenTime = db.getNodeSeenTimeMs(ipPort);
		expect(seenTime).toBeTypeOf('number');
		expect(seenTime).toBe(timeMs);
	});

	test('should return undefined for seen time of a non-existing node', () => {
		const ipPort = ipPorts[0];
		const seenTime = db.getNodeSeenTimeMs(ipPort);
		expect(seenTime).toBeUndefined();
	});

	test('should get the correct number of nodes', async () => {
		expect(db.getNumNodes()).toBe(0);
		await db.addSeen(ipPorts[0], Date.now());
		expect(db.getNumNodes()).toBe(1);
		await db.addSeen(ipPorts[1], Date.now());
		expect(db.getNumNodes()).toBe(2);
		await db.deleteNode(ipPorts[0]);
		expect(db.getNumNodes()).toBe(1);
	});

	test('should not throw error when deleting a non-existing node', async () => {
		const ipPort = ipPorts[0];
		await expect(db.deleteNode(ipPort)).resolves.toBeUndefined();
		expect(db.getNumNodes()).toBe(0);
	});

	test('should get most recently seen nodes in correct order', async () => {
		const [ipPort1, ipPort2, ipPort3] = ipPorts;

		await db.addSeen(ipPort1, Date.now());
		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeen(ipPort2, Date.now());
		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeen(ipPort3, Date.now());

		const mostRecent = db.getMostRecentlySeenNodes({ timeMs: Date.now(), amount: 3, allowBlacklisted: true });

		expect(mostRecent.length).toBe(3);
		expect(mostRecent[0]).toEqual(ipPort3);
		expect(mostRecent[1]).toEqual(ipPort2);
		expect(mostRecent[2]).toEqual(ipPort1);
	});

	test('should respect amount parameter in getMostRecentlySeen', async () => {
		const [ipPort1, ipPort2, ipPort3] = ipPorts;

		await db.addSeen(ipPort1, Date.now());
		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeen(ipPort2, Date.now());
		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeen(ipPort3, Date.now());

		const mostRecentTwo = db.getMostRecentlySeenNodes({ timeMs: Date.now(), amount: 2, allowBlacklisted: true });
		expect(mostRecentTwo.length).toBe(2);
		expect(mostRecentTwo[0]).toEqual(ipPort3);
		expect(mostRecentTwo[1]).toEqual(ipPort2);

		const mostRecentOne = db.getMostRecentlySeenNodes({ timeMs: Date.now(), amount: 1, allowBlacklisted: true });
		expect(mostRecentOne.length).toBe(1);
		expect(mostRecentOne[0]).toEqual(ipPort3);
	});

	test('should respect excludedIpPortStringsSet parameter in getMostRecentlySeen', async () => {
		const [ipPort1, ipPort2, ipPort3] = ipPorts;

		await db.addSeen(ipPort1, Date.now());
		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeen(ipPort2, Date.now());
		await new Promise(resolve => setTimeout(resolve, 10));
		await db.addSeen(ipPort3, Date.now());

		const excludedIpPortStringsMap: Map<string, any> = new Map();
		excludedIpPortStringsMap.set(ipPortToString(ipPort2), {});
		const mostRecent = db.getMostRecentlySeenNodes({ timeMs: Date.now(), amount: 3, excludedIpPortStringsMap, allowBlacklisted: true });

		expect(mostRecent.length).toBe(2);
		expect(mostRecent).not.toContainEqual(ipPort2);
		expect(mostRecent).toEqual([ipPort3, ipPort1]);
	});

	test('metrics with a recentUnintentionalDisconnectBeforeConnectTimesMs event should not be higher rated than default metrics over time', () => {
		const timeMs = Date.now();
		const futureTimeMs = Date.now() + 1000 * ONE_DAY_MS;

		const metricsDefault = createDefaultNodeConnectionMetrics(timeMs);
		const ratingDefaultCurrent = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), timeMs);
		const ratingDefaultFuture = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), futureTimeMs);

		const metrics1 = createDefaultNodeConnectionMetrics(timeMs);
		metrics1.recentUnintentionalDisconnectBeforeConnectTimesMs = [timeMs];
		const rating1Current = calculateRating(metrics1, getHighestMetricsTime(metrics1), timeMs);
		const rating1Future = calculateRating(metrics1, getHighestMetricsTime(metrics1), futureTimeMs);

		expect(rating1Current).toBeLessThan(ratingDefaultCurrent);
		expect(rating1Future).toBeLessThanOrEqual(ratingDefaultFuture);
	});

	test('metrics with a recentUnintentionalDisconnectAfterConnectTimesMs event should not be higher rated than default metrics over time', () => {
		const timeMs = Date.now();
		const futureTimeMs = Date.now() + 1000 * ONE_DAY_MS;

		const metricsDefault = createDefaultNodeConnectionMetrics(timeMs);
		const ratingDefaultCurrent = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), timeMs);
		const ratingDefaultFuture = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), futureTimeMs);

		const metrics1 = createDefaultNodeConnectionMetrics(timeMs);
		metrics1.recentUnintentionalDisconnectAfterConnectTimesMs = [timeMs];
		const rating1Current = calculateRating(metrics1, getHighestMetricsTime(metrics1), timeMs);
		const rating1Future = calculateRating(metrics1, getHighestMetricsTime(metrics1), futureTimeMs);

		expect(rating1Current).toBeLessThan(ratingDefaultCurrent);
		expect(rating1Future).toBeLessThanOrEqual(ratingDefaultFuture);
	});

	test('metrics with a lastOutOfSyncTimeMs event should not be higher rated than default metrics over time', () => {
		const timeMs = Date.now();
		const futureTimeMs = Date.now() + 1000 * ONE_DAY_MS;

		const metricsDefault = createDefaultNodeConnectionMetrics(timeMs);
		const ratingDefaultCurrent = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), timeMs);
		const ratingDefaultFuture = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), futureTimeMs);

		const metrics1 = createDefaultNodeConnectionMetrics(timeMs);
		metrics1.lastOutOfSyncTimeMs = timeMs;
		const rating1Current = calculateRating(metrics1, getHighestMetricsTime(metrics1), timeMs);
		const rating1Future = calculateRating(metrics1, getHighestMetricsTime(metrics1), futureTimeMs);

		expect(rating1Current).toBeLessThan(ratingDefaultCurrent);
		expect(rating1Future).toBeLessThanOrEqual(ratingDefaultFuture);
	});

	test('metrics with a lastInvalidChainDetectedTimeMs event should not be higher rated than default metrics over time', () => {
		const timeMs = Date.now();
		const futureTimeMs = Date.now() + 1000 * ONE_DAY_MS;

		const metricsDefault = createDefaultNodeConnectionMetrics(timeMs);
		const ratingDefaultCurrent = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), timeMs);
		const ratingDefaultFuture = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), futureTimeMs);

		const metrics1 = createDefaultNodeConnectionMetrics(timeMs);
		metrics1.lastInvalidChainDetectedTimeMs = timeMs;
		const rating1Current = calculateRating(metrics1, getHighestMetricsTime(metrics1), timeMs);
		const rating1Future = calculateRating(metrics1, getHighestMetricsTime(metrics1), futureTimeMs);

		expect(rating1Current).toBeLessThan(ratingDefaultCurrent);
		expect(rating1Future).toBeLessThanOrEqual(ratingDefaultFuture);
	});

	test('metrics with a lastConnectTimeMs event should not be lower rated than default metrics over time', () => {
		const timeMs = Date.now();
		const futureTimeMs = Date.now() + 1000 * ONE_DAY_MS;

		const metricsDefault = createDefaultNodeConnectionMetrics(timeMs);
		const ratingDefaultCurrent = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), timeMs);
		const ratingDefaultFuture = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), futureTimeMs);

		const metrics1 = createDefaultNodeConnectionMetrics(timeMs);
		metrics1.lastConnectTimeMs = timeMs;
		const rating1Current = calculateRating(metrics1, getHighestMetricsTime(metrics1), timeMs);
		const rating1Future = calculateRating(metrics1, getHighestMetricsTime(metrics1), futureTimeMs);

		expect(rating1Current).toBeGreaterThan(ratingDefaultCurrent);
		expect(rating1Future).toBeGreaterThanOrEqual(ratingDefaultFuture);
	});

	test('metrics with good ping events should not be lower rated than default metrics over time', () => {
		const timeMs = Date.now();
		const futureTimeMs = Date.now() + 1000 * ONE_DAY_MS;

		const metricsDefault = createDefaultNodeConnectionMetrics(timeMs);
		const ratingDefaultCurrent = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), timeMs);
		const ratingDefaultFuture = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), futureTimeMs);

		const metrics1 = createDefaultNodeConnectionMetrics(timeMs);
		metrics1.recentPingTimes = [{ pingDurationMs: 50, pingTimestampMs: timeMs }];
		const rating1Current = calculateRating(metrics1, getHighestMetricsTime(metrics1), timeMs);
		const rating1Future = calculateRating(metrics1, getHighestMetricsTime(metrics1), futureTimeMs);

		expect(rating1Current).toBeGreaterThan(ratingDefaultCurrent);
		expect(rating1Future).toBeGreaterThanOrEqual(ratingDefaultFuture);
	});

	test('metrics with bad ping events should not be higher rated than default metrics over time', () => {
		const timeMs = Date.now();
		const futureTimeMs = Date.now() + 1000 * ONE_DAY_MS;

		const metricsDefault = createDefaultNodeConnectionMetrics(timeMs);
		const ratingDefaultCurrent = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), timeMs);
		const ratingDefaultFuture = calculateRating(metricsDefault, getHighestMetricsTime(metricsDefault), futureTimeMs);

		const metrics1 = createDefaultNodeConnectionMetrics(timeMs);
		metrics1.recentPingTimes = [{ pingDurationMs: 10000, pingTimestampMs: timeMs }];
		const rating1Current = calculateRating(metrics1, getHighestMetricsTime(metrics1), timeMs);
		const rating1Future = calculateRating(metrics1, getHighestMetricsTime(metrics1), futureTimeMs);

		expect(rating1Current).toBeLessThan(ratingDefaultCurrent);
		expect(rating1Future).toBeLessThanOrEqual(ratingDefaultFuture);
	});

	describe('clearOld', () => {
		test('should remove the specified amount of oldest nodes', async () => {
			const [node1, node2, node3, node4] = ipPorts;
			await db.addSeen(node1, Date.now() - 40);// Oldest.
			await db.addSeen(node2, Date.now() - 30);
			await db.addSeen(node3, Date.now() - 20);
			await db.addSeen(node4, Date.now() - 10);// Newest.

			expect(db.getNumNodes()).toBe(4);

			await db.clearOld({ amount: 2 });

			expect(db.getNumNodes()).toBe(2);
			expect(db.has(node1)).toBe(false);// Removed.
			expect(db.has(node2)).toBe(false);// Removed.
			expect(db.has(node3)).toBe(true); // Kept.
			expect(db.has(node4)).toBe(true); // Kept.
		});

		test('should respect excludedIpPortStringsMap', async () => {
			const [node1, node2, node3, node4, node5] = ipPorts;
			await db.addSeen(node1, Date.now() - 50);// Oldest, excluded.
			await db.addSeen(node2, Date.now() - 40);// Should be removed.
			await db.addSeen(node3, Date.now() - 30);// Old, excluded.
			await db.addSeen(node4, Date.now() - 20);// Should be removed.
			await db.addSeen(node5, Date.now() - 10);// Newest, should be kept.

			const excludedIpPortStringsMap = new Map<string, any>([
				[ipPortToString(node1), {}],
				[ipPortToString(node3), {}],
			]);

			expect(db.getNumNodes()).toBe(5);

			await db.clearOld({ amount: 2, excludedIpPortStringsMap });

			expect(db.getNumNodes()).toBe(3);
			expect(db.has(node1)).toBe(true); // Kept (excluded).
			expect(db.has(node2)).toBe(false);// Removed.
			expect(db.has(node3)).toBe(true); // Kept (excluded).
			expect(db.has(node4)).toBe(false);// Removed.
			expect(db.has(node5)).toBe(true); // Kept.
		});

		test('should remove only one node if amount is not specified', async () => {
			const [node1, node2, node3] = ipPorts;
			await db.addSeen(node1, Date.now() - 30);// Oldest.
			await db.addSeen(node2, Date.now() - 20);
			await db.addSeen(node3, Date.now() - 10);

			await db.clearOld({});// Default amount is 1.

			expect(db.getNumNodes()).toBe(2);
			expect(db.has(node1)).toBe(false);
			expect(db.has(node2)).toBe(true);
			expect(db.has(node3)).toBe(true);
		});

		test('should not fail when trying to clear from an empty database', async () => {
			expect(db.getNumNodes()).toBe(0);
			await expect(db.clearOld({ amount: 5 })).resolves.toBeUndefined();
			expect(db.getNumNodes()).toBe(0);
		});

		test('should not remove any nodes if all old nodes are excluded', async () => {
			const [node1, node2] = ipPorts;
			await db.addSeen(node1, Date.now() - 20);
			await db.addSeen(node2, Date.now() - 10);

			const excludedIpPortStringsMap = new Map<string, any>([
				[ipPortToString(node1), {}],
			]);

			await db.clearOld({ amount: 1, excludedIpPortStringsMap });

			await db.clear();
			const [nodeA, nodeB, nodeC] = ipPorts;
			await db.addSeen(nodeA, Date.now() - 30);// Oldest, excluded.
			await db.addSeen(nodeB, Date.now() - 20);// Next oldest, NOT excluded.
			await db.addSeen(nodeC, Date.now() - 10);// Newest.

			const exclusionMap = new Map<string, any>([
				[ipPortToString(nodeA), {}],
			]);

			await db.clearOld({ amount: 1, excludedIpPortStringsMap: exclusionMap });

			expect(db.getNumNodes()).toBe(2);
			expect(db.has(nodeA)).toBe(true);
			expect(db.has(nodeB)).toBe(false);
			expect(db.has(nodeC)).toBe(true);
		});
	});

	describe('clearBlacklisted', () => {
		test('should respect the amount parameter and remove the worst-rated nodes', async () => {
			const timeMs = Date.now();

			// Create 4 blacklisted nodes with very bad metrics.
			const blacklistedNodes = [ipPorts[0], ipPorts[1], ipPorts[2], ipPorts[3]];
			for (const ipPort of blacklistedNodes) {
				await db.addLastInvalidChainDetectedTimeMs(ipPort, timeMs);
			}

			// Create 1 non-blacklisted node.
			const goodNode = ipPorts[4];
			await db.addPingTimeMs(goodNode, timeMs, 50);
			await db.addLastConnectTimeMs(goodNode, timeMs);

			expect(db.getNumNodes()).toBe(5);
			expect(db.isBlacklisted(blacklistedNodes[0], timeMs)).toBe(true);
			expect(db.isBlacklisted(goodNode, timeMs)).toBe(false);

			// Clear 2 of the 4 blacklisted nodes.
			await db.clearBlacklisted({ amount: 2 });

			// Verify that 3 nodes remain: 2 blacklisted and 1 good.
			expect(db.getNumNodes()).toBe(3);

			// Verify the good node still exists.
			expect(db.has(goodNode)).toBe(true);

			// Count remaining blacklisted nodes.
			let remainingBlacklisted = 0;
			for (const ipPort of blacklistedNodes) {
				if (db.has(ipPort)) {
					remainingBlacklisted++;
				}
			}
			expect(remainingBlacklisted).toBe(2);
		});

		test('clearBlacklisted respects excludedIpPortStringsMap', async () => {
			const timeMs = Date.now();
			const threshold = createBlacklistedRatingThreshold();

			// Define nodes.
			const node1 = ipPorts[0];// Blacklisted, not excluded.
			const node2 = ipPorts[1];// Blacklisted, excluded.
			const node3 = ipPorts[2];// Blacklisted, excluded.
			const node4 = ipPorts[3];// Non-blacklisted.

			// Create 3 blacklisted nodes with very bad metrics.
			for (const ipPort of [node1, node2, node3]) {
				await db.addLastInvalidChainDetectedTimeMs(ipPort, timeMs);
			}

			// Set up non-blacklisted node with good metrics.
			await db.addSeen(node4, timeMs);
			await db.addLastConnectTimeMs(node4, timeMs);
			await db.addPingTimeMs(node4, timeMs, 50);// Low ping time.

			// Verify ratings.
			const rating1 = db.getNodeRating(node1, timeMs);
			const rating2 = db.getNodeRating(node2, timeMs);
			const rating3 = db.getNodeRating(node3, timeMs);
			const rating4 = db.getNodeRating(node4, timeMs);

			expect(rating1).toBeLessThan(threshold);
			expect(rating2).toBeLessThan(threshold);
			expect(rating3).toBeLessThan(threshold);
			expect(rating4).toBeGreaterThanOrEqual(threshold);

			// Create excludedIpPortStringsMap with node2 and node3.
			const excludedIpPortStringsMap = new Map<string, any>([
				[ipPortToString(node2), {}],
				[ipPortToString(node3), {}],
			]);

			// Call clearBlacklisted with amount = Infinity (large enough to remove all blacklisted nodes if not excluded).
			await db.clearBlacklisted({ amount: Infinity, excludedIpPortStringsMap });

			// Check that node1 is removed.
			expect(db.has(node1)).toBe(false);

			// Check that node2, node3, and node4 are still present.
			expect(db.has(node2)).toBe(true);
			expect(db.has(node3)).toBe(true);
			expect(db.has(node4)).toBe(true);

			// Check the total number of nodes.
			expect(db.getNumNodes()).toBe(3);
		});
	});
});