import { Level } from 'level';

import { IpPort } from './types.js';
import { assert, ipPortToString, stringToIpPort } from './utils/util.js';
import { RedBlackTree } from './utils/RedBlackTree.js';

const MAX_recentPingTimes_LENGTH = 10;
const MAX_recentUnintentionalDisconnectTimesMs_LENGTH = 10;
const MIN_TIME_BETWEEN_RATINGS_UPDATES_MS = 10 * 1000;

export type NodeConnectionMetrics = {
	lastSeenTimeMs: number;// Last time node was seen/handled by the system.
	recentPingTimes: { pingDurationMs: number; pingTimestampMs: number }[];// Time taken to ping with timestamp.
	recentUnintentionalDisconnectBeforeConnectTimesMs: number[];// Unix times when unintentionally disconnecting before a complete connect to this node.
	recentUnintentionalDisconnectAfterConnectTimesMs: number[];// Unix times when unintentionally disconnecting after a complete connect to this node.
	lastConnectTimeMs?: number;// Last time a connect() call succeeded.
	lastConnectAndTestTimeMs?: number;// Last time the post-connection tests succeeded.
	lastDataReceivedTimeMs?: number;// Last time data was received from this node.
	lastOutOfSyncTimeMs?: number;// Last time node was out of sync.
	lastInvalidChainDetectedTimeMs?: number;// Last time node was on invalid chain.
};

function calculateDisconnectAfterConnectScore(timeMs: number, recentUnintentionalDisconnectAfterConnectTimesMs: number[]): number {
	const scaleDays = 7;// A shorter scale makes the penalty decay faster, emphasizing recent events.
	const k = 0.5;// Penalty multiplier.
	const exponent = 5;// A higher exponent punishes frequent (clustered) disconnects much more severely.
	const gapScaleHours = 4;// A scale for frequency penalty. Small value penalizes clustered disconnects more.
	const penaltyScaleFactor = 2.7;// Added to scale the penalty to a reasonable range.

	const scaleMs = scaleDays * 24 * 60 * 60 * 1000;
	const gapScaleMs = gapScaleHours * 60 * 60 * 1000;

	const N = recentUnintentionalDisconnectAfterConnectTimesMs.length;
	if (N === 0) {
		return 1;
	}

	let maxPenalty = 0;
	for (let i = 0; i < N; i++) {
		const t_i = recentUnintentionalDisconnectAfterConnectTimesMs[i];
		const recency = Math.exp(-(timeMs - t_i) / scaleMs);

		let amplification = 0;
		for (let j = 0; j < N; j++) {
			const t_j = recentUnintentionalDisconnectAfterConnectTimesMs[j];
			amplification += Math.exp(-Math.abs(t_i - t_j) / gapScaleMs);
		}

		const penalty_i = recency * amplification;
		if (penalty_i > maxPenalty) {
			maxPenalty = penalty_i;
		}
	}

	return 1 / (1 + k * Math.pow(penaltyScaleFactor * maxPenalty, exponent));
}

/**
 * Calculates the number of days since a given timestamp.
 * @param timestamp - The timestamp in milliseconds.
 * @param now - The current time in milliseconds.
 * @returns The number of days since the timestamp, or null if the timestamp is not provided.
 */
function daysSince(timestamp: number | undefined, now: number): number | null {
	const msPerDay = 1000 * 60 * 60 * 24;
	if (!timestamp) {
		return null;// Represents "never happened" or "infinity".
	}
	// Ensure the difference is non-negative in case of clock drift or future timestamps (though unlikely for these metrics).
	const diff = now - timestamp;
	return Math.max(0, diff / msPerDay);
}

/**
 * Calculates a score based on the recency of a "bad" event.
 * The score is 1 if the event is old or never happened, and approaches 0 if recent.
 * @param daysSinceEvent - The number of days since the event.
 * @param k - The steepness parameter for the sigmoid function.
 * @param midpoint - The midpoint of the sigmoid function in days.
 * @returns A score between 0 and 1.
 */
function badEventRecencyScore(daysSinceEvent: number | null, k: number, midpoint: number): number {
	if (daysSinceEvent === null) {
		return 1;// Event never happened, best score.
	}
	// Sigmoid function: 1 / (1 + exp(-k * (x - midpoint))).
	return 1 / (1 + Math.exp(-k * (daysSinceEvent - midpoint)));
}

/**
 * Calculates a score for a node based on its ping times.
 * @param recentPingTimes - A list of recent ping times.
 * @param now - The current time in milliseconds.
 * @returns A score between 0 and 1.
 */
function calculatePingScore(recentPingTimes: { pingDurationMs: number; pingTimestampMs: number }[], now: number): number {
	const defaultPingScore = 0.25;// Score when no ping data or all pings are very old.
	if (!recentPingTimes.length) {
		return defaultPingScore;
	}

	// Ping score calculation: favors recent and good pings.
	const k = 0.0022;// Steepness parameter for sigmoid.
	const midpoint = 2000;// Ping (ms) where individual score is 0.5.
	const scaleMs = 7 * 24 * 60 * 60 * 1000;// 7 days, decay scale for recency weighting.

	// Compute individual scores for each ping using the original sigmoid.
	const individualScores = recentPingTimes.map(ping => {
		const score = 1 / (1 + Math.exp(k * (ping.pingDurationMs - midpoint)));
		return Math.max(0.1, score);// Minimum score for very high pings.
	});
	// Compute weights based on recency with exponential decay.
	const weights = recentPingTimes.map(ping => Math.exp(-(now - ping.pingTimestampMs) / scaleMs));
	// Weighted average of individual scores.
	const weightedSum = individualScores.reduce((sum, score, i) => sum + weights[i] * score, 0);
	const weightSum = weights.reduce((sum, w) => sum + w, 0);
	return weightSum > 0 ? weightedSum / weightSum : defaultPingScore;
}

/**
 * Calculates a score based on the recency of unintentional disconnects before a connection is fully established.
 * @param recentUnintentionalDisconnectBeforeConnectTimesMs - A list of timestamps of recent disconnects.
 * @param lastSeenTimeMs - The last time the node was seen.
 * @param now - The current time in milliseconds.
 * @returns A score between 0 and 1.
 */
function calculateDisconnectBeforeConnectScore(
	recentUnintentionalDisconnectBeforeConnectTimesMs: number[],
	lastSeenTimeMs: number,
	now: number
): number {
	const lastDisconnectBeforeConnectTime = recentUnintentionalDisconnectBeforeConnectTimesMs.length === 0
		? undefined
		: recentUnintentionalDisconnectBeforeConnectTimesMs.at(-1)!;

	const daysSinceLastDisconnectBeforeConnect = daysSince(lastDisconnectBeforeConnectTime, now);

	// Adjust days since for disconnects before lastSeenTimeMs to reduce penalty.
	let effectiveDaysSince: number | null;
	if (!lastDisconnectBeforeConnectTime) {
		effectiveDaysSince = null;
	} else if (lastDisconnectBeforeConnectTime < lastSeenTimeMs) {
		// Usually-good connections that fail their initial connection are penalized less. We assume they are
		// better connections if they are seen by other successfully connected nodes (which update this node's lastSeenTimeMs).
		const daysToAdd = 10;// Adding 10 days makes it less penalizing; adjust as needed.
		effectiveDaysSince = (daysSinceLastDisconnectBeforeConnect ?? 0) + daysToAdd;
	} else {
		effectiveDaysSince = daysSinceLastDisconnectBeforeConnect;
	}
	// Parameters tuned so that a disconnect before connecting 20 days ago results in a score contribution that helps achieve ~0.25 overall.
	return badEventRecencyScore(effectiveDaysSince, 0.4, 22);
}

/**
 * Calculates a score based on the recency of a successful connection.
 * @param lastConnectTimeMs - The timestamp of the last successful connect.
 * @param lastConnectAndTestTimeMs - The timestamp of the last successful connect and test.
 * @param lastDataReceivedTimeMs - The timestamp of the last data received.
 * @param now - The current time in milliseconds.
 * @returns A score between 0 and 1.
 */
function calculateConnectRecencyScore(
	lastConnectionTime: number,
	now: number
): number {
	const daysSinceEvent = daysSince(lastConnectionTime, now);

	if (daysSinceEvent === null) {
		return 0.5;// Never connected gets a neutral score.
	}
	// Sigmoid function: 1 / (1 + exp(k * (x - midpoint))).
	const k = 0.25;
	const midpoint = 30;// Midpoint at 30 days
	const score = 1 / (1 + Math.exp(k * (daysSinceEvent - midpoint)));
	const floor = 0.8;// A non-zero floor for very old connections.
	// Interpolate between floor and 1, based on the original score.
	return floor + score * (1 - floor);
}

/**
 * Calculates a rating for a node based on its connection metrics.
 * @param nodeConnectionMetrics - The connection metrics for the node.
 * @param latestMetricsUpdateTimeMs - The timestamp of the latest metrics update.
 * @param timeMs - The current time in milliseconds.
 * @returns A rating between 0 and 1, where higher is better.
 */
export function calculateRating(nodeConnectionMetrics: NodeConnectionMetrics, latestMetricsUpdateTimeMs: number, timeMs: number): number {
	const {
		lastSeenTimeMs,
		recentPingTimes,
		recentUnintentionalDisconnectBeforeConnectTimesMs,
		recentUnintentionalDisconnectAfterConnectTimesMs,
		lastConnectTimeMs,
		lastConnectAndTestTimeMs,
		lastDataReceivedTimeMs,
		lastOutOfSyncTimeMs,
		lastInvalidChainDetectedTimeMs
	} = nodeConnectionMetrics;

	const now = timeMs;

	const finalPingScore = calculatePingScore(recentPingTimes, now);

	const disconnectBeforeConnectScore = calculateDisconnectBeforeConnectScore(
		recentUnintentionalDisconnectBeforeConnectTimesMs,
		lastSeenTimeMs,
		now
	);

	const disconnectAfterConnectScore = calculateDisconnectAfterConnectScore(now, recentUnintentionalDisconnectAfterConnectTimesMs);

	const daysSinceLastOutOfSync = daysSince(lastOutOfSyncTimeMs, now);
	// Parameters tuned so that an out-of-sync event 2 days ago contributes to ~0.25 overall.
	const outOfSyncScore = badEventRecencyScore(daysSinceLastOutOfSync, 0.98, 3.0);

	const daysSinceLastInvalidChain = daysSince(lastInvalidChainDetectedTimeMs, now);
	// Parameters tuned so that an invalid chain detected 60 days ago contributes to ~0.25 overall.
	const invalidChainScore = badEventRecencyScore(daysSinceLastInvalidChain, 0.049, 70);

	const connectScore = calculateConnectRecencyScore(
		Math.max(lastConnectTimeMs ?? 0, lastConnectAndTestTimeMs ?? 0, lastDataReceivedTimeMs ?? 0),
		now
	);

	// --- Combine Scores using a weighted product ---
	// The final rating is the product of each individual score raised to a weight.
	// This means if any single factor has a very low score, it will significantly pull down the final rating,
	// depending on its weight. Weights represent the importance of each factor's "goodness".
	const weights = {
		ping: 0.6,
		disconnectBeforeConnect: 0.3,
		disconnectAfterConnect: 0.3,
		outOfSync: 0.38,
		invalidChain: 0.5,
		connect: 0.2,
	};

	// Ensure scores are slightly above zero before taking power to avoid Math.pow(0, weight) which is 0.
	// The sigmoid and min ping score handle this, but a small epsilon adds robustness.
	const epsilon = 1e-6;

	const finalRating =
		Math.pow(Math.max(epsilon, finalPingScore), weights.ping) *
		Math.pow(Math.max(epsilon, disconnectBeforeConnectScore), weights.disconnectBeforeConnect) *
		Math.pow(Math.max(epsilon, disconnectAfterConnectScore), weights.disconnectAfterConnect) *
		Math.pow(Math.max(epsilon, outOfSyncScore), weights.outOfSync) *
		Math.pow(Math.max(epsilon, invalidChainScore), weights.invalidChain) *
		Math.pow(Math.max(epsilon, connectScore), weights.connect);

	// The resulting rating is naturally between 0 and 1.
	return finalRating;
}

/**
 * Gets the highest timestamp from a node's connection metrics.
 * @param metrics - The connection metrics for the node.
 * @returns The highest timestamp in milliseconds.
 */
export function getHighestMetricsTime(metrics: NodeConnectionMetrics): number {
	return Math.max(
		...metrics.recentPingTimes.map((pingTime) => pingTime.pingTimestampMs),
		...metrics.recentUnintentionalDisconnectBeforeConnectTimesMs,
		...metrics.recentUnintentionalDisconnectAfterConnectTimesMs,
		metrics.lastConnectTimeMs ?? 0,
		metrics.lastOutOfSyncTimeMs ?? 0,
		metrics.lastInvalidChainDetectedTimeMs ?? 0,
		metrics.lastSeenTimeMs
	);
}

/**
 * Creates a default set of node connection metrics.
 * @param lastSeenTimeMs - The last time the node was seen.
 * @returns A new NodeConnectionMetrics object.
 */
export function createDefaultNodeConnectionMetrics(lastSeenTimeMs: number): NodeConnectionMetrics {
	return {
		lastSeenTimeMs,
		recentPingTimes: [],
		recentUnintentionalDisconnectBeforeConnectTimesMs: [],
		recentUnintentionalDisconnectAfterConnectTimesMs: [],
		lastConnectTimeMs: undefined,
		lastConnectAndTestTimeMs: undefined,
		lastDataReceivedTimeMs: undefined,
		lastOutOfSyncTimeMs: undefined,
		lastInvalidChainDetectedTimeMs: undefined,
	};
}

/**
 * Creates a threshold for blacklisting nodes based on their rating.
 * Any rating < this number is considered a blacklisted node.
 * @returns A rating threshold.
 */
export function createBlacklistedRatingThreshold(enableConsoleDebugLog?: boolean): number {
	// Create nodes that are considered borderline acceptable and find the highest rating of all those nodes.

	const now = Date.now();

	// Disconnected before connecting 20 days ago.
	const metrics0 = createDefaultNodeConnectionMetrics(now - 20 * 24 * 60 * 60 * 1000);// If seen time is > the disconnect-before-connect time, then it is less penalized (by 10 days).
	metrics0.recentUnintentionalDisconnectBeforeConnectTimesMs = [now - 20 * 24 * 60 * 60 * 1000];
	const rating0 = calculateRating(metrics0, getHighestMetricsTime(metrics0), now);
	enableConsoleDebugLog && console.log('rating0', rating0);

	// Disconnected 3x after connecting within the last 24 hours with a good ping.
	const metrics1 = createDefaultNodeConnectionMetrics(now);
	metrics1.recentUnintentionalDisconnectAfterConnectTimesMs = [
		now - 24 * 60 * 60 * 1000,
		now - 12 * 60 * 60 * 1000,
		now,
	];
	metrics1.recentPingTimes = [{ pingDurationMs: 300, pingTimestampMs: now }];
	metrics1.lastConnectTimeMs = now;
	const rating1 = calculateRating(metrics1, getHighestMetricsTime(metrics1), now);
	enableConsoleDebugLog && console.log('rating1', rating1);

	// Out of sync 2 days ago.
	const metrics2 = createDefaultNodeConnectionMetrics(now);
	metrics2.lastOutOfSyncTimeMs = now - 2 * 24 * 60 * 60 * 1000;
	metrics2.lastConnectTimeMs = metrics2.lastOutOfSyncTimeMs - 1000;
	const rating2 = calculateRating(metrics2, getHighestMetricsTime(metrics2), now);
	enableConsoleDebugLog && console.log('rating2', rating2);

	// 10 second recent ping time.
	const metrics3 = createDefaultNodeConnectionMetrics(now);
	metrics3.recentPingTimes = [{ pingDurationMs: 10 * 1000, pingTimestampMs: now }];
	metrics3.lastConnectTimeMs = now - 90 * 1000;
	const rating3 = calculateRating(metrics3, getHighestMetricsTime(metrics3), now);
	enableConsoleDebugLog && console.log('rating3', rating3);

	// Invalid chain detected 60 days ago.
	const metrics4 = createDefaultNodeConnectionMetrics(now);
	metrics4.lastInvalidChainDetectedTimeMs = now - 60 * 24 * 60 * 60 * 1000;
	metrics4.lastConnectTimeMs = metrics4.lastInvalidChainDetectedTimeMs - 1000;
	const rating4 = calculateRating(metrics4, getHighestMetricsTime(metrics4), now);
	enableConsoleDebugLog && console.log('rating4', rating4);

	return Math.max(rating0, rating1, rating2, rating3, rating4);
}

export class NodesDatabase {
	private static readonly _blacklistedRatingThreshold: number = createBlacklistedRatingThreshold();

	// Databases.
	private _levelDbMetrics: Level<IpPort, NodeConnectionMetrics>;

	// Data structures for quick access.
	// Key is seen time (for sorting by recency), Value is Set of IpPortStrings.
	private _seenTimeToIpPortStringSet: RedBlackTree<number, Set<string>> = new RedBlackTree<number, Set<string>>((a, b) => a - b);
	// Key is rating (for sorting by rating), Value is Set of IpPortStrings.
	private _ratingToIpPortStringSet: RedBlackTree<number, Set<string>> = new RedBlackTree<number, Set<string>>((a, b) => a - b);
	// Key is IpPortString, Value is rating.
	private _ipPortStringToRating: Map<string, number> = new Map();
	// Key is IpPortString, Value is NodeConnectionMetrics.
	private _ipPortStringToMetrics: Map<string, NodeConnectionMetrics> = new Map();
	private _nonBlacklistedIpPortStrings: Set<string> = new Set();

	// Database save queues.
	private _metricsSaveQueue: Promise<void> = Promise.resolve();

	private _timeOfLastRatingsUpdateMs: number = 0;
	private _latestMetricsUpdateTimeMs: number = 0;

	private constructor({ databasePath }: {
		databasePath: string;
	}) {
		this._levelDbMetrics = new Level(databasePath + '/metrics', {
			keyEncoding: 'json', // Key is IpPort.
			valueEncoding: 'json' // Value is NodeConnectionMetrics.
		});
	}

	/**
	 * Creates a new NodesDatabase instance.
	 * @param options - Configuration options for creating the NodesDatabase.
	 * @param options.databasePath - The path to the database.
	 * @param options.timeMs - The current time in milliseconds.
	 * @returns A new NodesDatabase instance.
	 */
	static create = async ({ databasePath, timeMs }: {
		databasePath: string;
		timeMs?: number;
	}): Promise<NodesDatabase> => {
		timeMs = timeMs ?? Date.now();

		const db = new NodesDatabase({ databasePath });

		await db._levelDbMetrics.open();

		// Build data structures of this class for quick access from the single metrics database.
		await db._buildMapsFromMetrics(timeMs);

		return db;
	}

	/**
	 * Opens the database.
	 */
	open = async (): Promise<void> => {
		await this._levelDbMetrics.open();
	}

	/**
	 * Closes the database.
	 */
	close = async (): Promise<void> => {
		// LevelDB .close() doesn't wait for pending writes to finish.
		// So we use a queue to wait for them to finish here.
		await this._metricsSaveQueue;

		await this._levelDbMetrics.close();
	}

	/**
	 * Closes the database.
	 */
	[Symbol.asyncDispose] = async (): Promise<void> => {
		await this.close();
	}

	/**
	 * Clears the entire database.
	 */
	async clear(): Promise<void> {
		// Clear in-memory data structures.
		this._seenTimeToIpPortStringSet.clear();
		this._ratingToIpPortStringSet.clear();
		this._ipPortStringToRating.clear();
		this._ipPortStringToMetrics.clear();
		this._nonBlacklistedIpPortStrings.clear();

		// Reset other state variables.
		this._timeOfLastRatingsUpdateMs = 0;
		this._latestMetricsUpdateTimeMs = 0;

		// Save to database.
		this._metricsSaveQueue = this._metricsSaveQueue.then(async () => {
			await this._levelDbMetrics.clear();
		});
		return this._metricsSaveQueue;
	}

	/**
	 * Clears old nodes from the database based on their lastSeenTimeMs.
	 * @param options - Options for clearing old nodes.
	 * @param options.amount - The number of nodes to clear.
	 * @param options.excludedIpPortStringsMap - A map of IP port strings to exclude from clearing.
	 */
	async clearOld({ amount, excludedIpPortStringsMap }: {
		amount?: number;
		excludedIpPortStringsMap?: Map<string, any>;
	} = {}): Promise<void> {
		amount = amount ?? 1;
		excludedIpPortStringsMap = excludedIpPortStringsMap || new Map();
		const ipPortStringsToDelete: string[] = [];

		// Iterate over this._seenTimeToIpPortStringSet starting with the oldest seen time.
		for (const [seenTime, ipPortSet] of this._seenTimeToIpPortStringSet.entries()) {
			if (ipPortStringsToDelete.length >= amount) {
				break;
			}
			for (const ipPortString of ipPortSet) {
				if (excludedIpPortStringsMap.has(ipPortString)) {
					continue;
				}
				ipPortStringsToDelete.push(ipPortString);
				if (ipPortStringsToDelete.length >= amount) {
					break;
				}
			}
		}

		if (!ipPortStringsToDelete.length) {
			return;
		}

		// Remove from in-memory data structures.
		ipPortStringsToDelete.forEach((ipPortString) => {
			// Remove from seen time set.
			const metrics = this._ipPortStringToMetrics.get(ipPortString)!;
			const seenTime = metrics.lastSeenTimeMs;
			const seenSet = this._seenTimeToIpPortStringSet.get(seenTime);
			if (seenSet) {
				seenSet.delete(ipPortString);
				if (seenSet.size === 0) {
					this._seenTimeToIpPortStringSet.delete(seenTime);
				}
			}
			this._ipPortStringToMetrics.delete(ipPortString);

			// Remove from rating set.
			const rating = this._ipPortStringToRating.get(ipPortString)!;
			const ratingSet = this._ratingToIpPortStringSet.get(rating);
			if (ratingSet) {
				ratingSet.delete(ipPortString);
				if (ratingSet.size === 0) {
					this._ratingToIpPortStringSet.delete(rating);
				}
			}
			this._ipPortStringToRating.delete(ipPortString);

			// Remove from non-blacklisted set if it exists there.
			this._nonBlacklistedIpPortStrings.delete(ipPortString);
		});

		// Update this._latestMetricsUpdateTimeMs.
		this._latestMetricsUpdateTimeMs = 0;
		this._ipPortStringToMetrics.forEach((metrics) => {
			this._latestMetricsUpdateTimeMs = Math.max(this._latestMetricsUpdateTimeMs, getHighestMetricsTime(metrics));
		});

		// Save to database.
		const batch: any[] = [];
		for (const ipPortString of ipPortStringsToDelete) {
			batch.push({
				type: 'del' as const,
				key: stringToIpPort(ipPortString)
			});
		}
		this._metricsSaveQueue = this._metricsSaveQueue.then(async () => {
			await this._levelDbMetrics.batch(batch);
		});
		return this._metricsSaveQueue;
	}

	/**
	 * Clears blacklisted nodes from the database.
	 * @param options - Options for clearing blacklisted nodes.
	 * @param options.amount - The number of nodes to clear.
	 * @param options.excludedIpPortStringsMap - A map of IP port strings to exclude from clearing.
	 */
	async clearBlacklisted({ amount, excludedIpPortStringsMap }: {
		amount?: number;
		excludedIpPortStringsMap?: Map<string, any>;
	} = {}): Promise<void> {
		amount = amount ?? this.getNumNodes();
		excludedIpPortStringsMap = excludedIpPortStringsMap || new Map();
		const ipPortStringsToDelete: string[] = [];

		// Iterate over this._ratingToIpPortStringSet starting with the lowest rating.
		for (const [rating, ipPortSet] of this._ratingToIpPortStringSet.entries()) {
			if (ipPortStringsToDelete.length >= amount) {
				break;
			}
			if (rating >= NodesDatabase._blacklistedRatingThreshold) {
				break;
			}
			for (const ipPortString of ipPortSet) {
				if (excludedIpPortStringsMap.has(ipPortString)) {
					continue;
				}
				ipPortStringsToDelete.push(ipPortString);
				if (ipPortStringsToDelete.length >= amount) {
					break;
				}
			}
		}

		if (!ipPortStringsToDelete.length) {
			return;
		}

		// Remove from in-memory data structures.
		ipPortStringsToDelete.forEach((ipPortString) => {
			// Remove from rating set.
			const rating = this._ipPortStringToRating.get(ipPortString)!;
			const ratingSet = this._ratingToIpPortStringSet.get(rating);
			if (ratingSet) {
				ratingSet.delete(ipPortString);
				if (ratingSet.size === 0) {
					this._ratingToIpPortStringSet.delete(rating);
				}
			}
			this._ipPortStringToRating.delete(ipPortString);

			// Remove from seen time set.
			const metrics = this._ipPortStringToMetrics.get(ipPortString)!;
			const seenTime = metrics.lastSeenTimeMs;
			const seenSet = this._seenTimeToIpPortStringSet.get(seenTime);
			if (seenSet) {
				seenSet.delete(ipPortString);
				if (seenSet.size === 0) {
					this._seenTimeToIpPortStringSet.delete(seenTime);
				}
			}
			this._ipPortStringToMetrics.delete(ipPortString);
		});

		// Update this._latestMetricsUpdateTimeMs.
		this._latestMetricsUpdateTimeMs = 0;
		this._ipPortStringToMetrics.forEach((metrics) => {
			this._latestMetricsUpdateTimeMs = Math.max(this._latestMetricsUpdateTimeMs, getHighestMetricsTime(metrics));
		});

		// Save to database.
		const batch: any[] = [];
		for (const ipPortString of ipPortStringsToDelete) {
			batch.push({
				type: 'del' as const,
				key: stringToIpPort(ipPortString)
			});
		}
		this._metricsSaveQueue = this._metricsSaveQueue.then(async () => {
			await this._levelDbMetrics.batch(batch);
		});
		return this._metricsSaveQueue;
	}

	// Faster single-node version of this._buildRatingsMapsFromMetrics().
	private _recalculateNodeRating(ipPortString: string, timeMs: number): void {
		// Get metrics for the node; exit if none exist.
		const metrics = this._ipPortStringToMetrics.get(ipPortString);
		if (!metrics) return;

		// Calculate new rating based on current metrics.
		const rating = calculateRating(metrics, this._latestMetricsUpdateTimeMs, timeMs);
		const oldRating = this._ipPortStringToRating.get(ipPortString);

		// Skip updates if rating hasn't changed.
		if (oldRating !== undefined && oldRating === rating) return;

		// Remove old rating entries if they exist.
		if (oldRating !== undefined) {
			const oldRatingSet = this._ratingToIpPortStringSet.get(oldRating);
			if (oldRatingSet) {
				oldRatingSet.delete(ipPortString);
				if (oldRatingSet.size === 0) {
					this._ratingToIpPortStringSet.delete(oldRating);// Remove empty rating set.
				}
			}
			// Update blacklist status if transitioning to blacklisted.
			if (oldRating >= NodesDatabase._blacklistedRatingThreshold && rating < NodesDatabase._blacklistedRatingThreshold) {
				this._nonBlacklistedIpPortStrings.delete(ipPortString);
			}
		}

		// Update with new rating.
		this._ipPortStringToRating.set(ipPortString, rating);
		let ratingSet = this._ratingToIpPortStringSet.get(rating);
		if (!ratingSet) {
			ratingSet = new Set<string>();
			this._ratingToIpPortStringSet.set(rating, ratingSet);// Create new set for this rating.
		}
		ratingSet.add(ipPortString);
		// Update blacklist status if non-blacklisted.
		if (rating >= NodesDatabase._blacklistedRatingThreshold) {
			this._nonBlacklistedIpPortStrings.add(ipPortString);
		}
	}

	private _buildRatingsMapsFromMetrics = (timeMs: number): void => {
		if (
			this._ipPortStringToRating.size === this._ipPortStringToMetrics.size &&// Has been updated before and...
			this._timeOfLastRatingsUpdateMs + MIN_TIME_BETWEEN_RATINGS_UPDATES_MS > performance.now()// Updated recently.
		) {
			return;
		}

		// Clear the ratings-related maps to ensure we rebuild them from scratch.
		this._ipPortStringToRating.clear();
		this._ratingToIpPortStringSet.clear();
		this._nonBlacklistedIpPortStrings.clear();

		// Iterate through all metrics and calculate ratings.
		for (const [ipPortString, metrics] of this._ipPortStringToMetrics) {
			assert(this._latestMetricsUpdateTimeMs > 0);
			const rating = calculateRating(metrics, this._latestMetricsUpdateTimeMs, timeMs);

			// Populate IP:Port to rating map.
			this._ipPortStringToRating.set(ipPortString, rating);

			// Populate rating to IP:Port set map.
			let ratingSet = this._ratingToIpPortStringSet.get(rating);
			if (!ratingSet) {
				ratingSet = new Set<string>();
				this._ratingToIpPortStringSet.set(rating, ratingSet);
			}
			ratingSet.add(ipPortString);

			// Populate non-blacklisted set if rating is acceptable.
			if (rating >= NodesDatabase._blacklistedRatingThreshold) {
				this._nonBlacklistedIpPortStrings.add(ipPortString);
			}
		}

		this._timeOfLastRatingsUpdateMs = performance.now();
	}

	// Builds all in-memory maps by iterating through the metrics database.
	private _buildMapsFromMetrics = async (timeMs: number): Promise<void> => {
		this._ipPortStringToMetrics.clear();
		this._seenTimeToIpPortStringSet.clear();

		const iterator = this._levelDbMetrics.iterator();
		try {
			for await (const [ipPort, metrics] of iterator) {
				const ipPortString = ipPortToString(ipPort);
				this._latestMetricsUpdateTimeMs = Math.max(this._latestMetricsUpdateTimeMs, getHighestMetricsTime(metrics));
				// Populate metrics map.
				this._ipPortStringToMetrics.set(ipPortString, metrics);
				// Populate seen time map.
				const seenTime = metrics.lastSeenTimeMs;
				let seenSet = this._seenTimeToIpPortStringSet.get(seenTime);
				if (!seenSet) {
					seenSet = new Set<string>();
					this._seenTimeToIpPortStringSet.set(seenTime, seenSet);
				}
				seenSet.add(ipPortString);
			}
		} catch (error) {
			this._ipPortStringToMetrics.clear();
			this._seenTimeToIpPortStringSet.clear();
			throw error;
		} finally {
			await iterator.close();
		}

		// Build the ratings maps
		//const startTimeMs = performance.now();
		this._buildRatingsMapsFromMetrics(timeMs);
		//const endTimeMs = performance.now();
		//console.log(`Built in-memory ratings maps for ${this._ipPortStringToMetrics.size} nodes in ${endTimeMs - startTimeMs} ms`);
	}

	private _updateMetrics = async (ipPort: IpPort, metrics: NodeConnectionMetrics, timeMs: number): Promise<void> => {
		const ipPortStringToMetrics: Map<string, NodeConnectionMetrics> = new Map();
		ipPortStringToMetrics.set(ipPortToString(ipPort), metrics);
		return this._updateMetricsBatch(ipPortStringToMetrics, timeMs);
	}

	private _updateMetricsBatch = async (ipPortStringToMetrics: Map<string, NodeConnectionMetrics>, timeMs: number): Promise<void> => {
		// Update this._latestMetricsUpdateTimeMs.
		for (const [ipPortString, newMetrics] of ipPortStringToMetrics) {
			const highestMetricsTime = getHighestMetricsTime(newMetrics);
			if (this._latestMetricsUpdateTimeMs < highestMetricsTime) {
				this._latestMetricsUpdateTimeMs = highestMetricsTime;
			}
		}

		// Update in-memory maps.
		for (const [ipPortString, newMetrics] of ipPortStringToMetrics) {
			const oldMetrics = this._ipPortStringToMetrics.get(ipPortString);
			const oldRating = this._ipPortStringToRating.get(ipPortString);
			const oldSeenTime = oldMetrics ? oldMetrics.lastSeenTimeMs : undefined;

			const newRating = calculateRating(newMetrics, this._latestMetricsUpdateTimeMs, timeMs);
			const newSeenTime = newMetrics.lastSeenTimeMs;

			// Update metrics map.
			this._ipPortStringToMetrics.set(ipPortString, newMetrics);

			// Update rating maps (remove old, add new).
			if (oldRating !== undefined) {
				const oldRatingSet = this._ratingToIpPortStringSet.get(oldRating);
				if (oldRatingSet) {
					oldRatingSet.delete(ipPortString);
					if (oldRatingSet.size === 0) {
						this._ratingToIpPortStringSet.delete(oldRating);
					}
				}
			}
			let newRatingSet = this._ratingToIpPortStringSet.get(newRating);
			if (!newRatingSet) {
				newRatingSet = new Set<string>();
				this._ratingToIpPortStringSet.set(newRating, newRatingSet);
			}
			newRatingSet.add(ipPortString);
			this._ipPortStringToRating.set(ipPortString, newRating);

			// Update non-blacklisted set.
			if (oldRating !== undefined) {
				if (oldRating >= NodesDatabase._blacklistedRatingThreshold) {
					this._nonBlacklistedIpPortStrings.delete(ipPortString);
				}
			}
			if (newRating >= NodesDatabase._blacklistedRatingThreshold) {
				this._nonBlacklistedIpPortStrings.add(ipPortString);
			}

			// Update seen time map (remove old, add new).
			if (oldSeenTime !== newSeenTime) {
				// Remove from old position in seen time map if it existed.
				if (oldSeenTime !== undefined) {
					const oldSeenSet = this._seenTimeToIpPortStringSet.get(oldSeenTime);
					if (oldSeenSet) {
						oldSeenSet.delete(ipPortString);
						if (oldSeenSet.size === 0) {
							this._seenTimeToIpPortStringSet.delete(oldSeenTime);
						}
					}
				}

				// Add to new position in seen time map.
				let newSeenSet = this._seenTimeToIpPortStringSet.get(newSeenTime);
				if (!newSeenSet) {
					newSeenSet = new Set<string>();
					this._seenTimeToIpPortStringSet.set(newSeenTime, newSeenSet);
				}
				newSeenSet.add(ipPortString);
			}
		}

		// Save to database.
		const batch: any[] = [];
		for (const [ipPortString, metrics] of ipPortStringToMetrics) {
			batch.push({
				type: 'put' as const,
				key: stringToIpPort(ipPortString),
				value: metrics
			});
		}
		this._metricsSaveQueue = this._metricsSaveQueue.then(async () => {
			await this._levelDbMetrics.batch(batch);
		});
		return this._metricsSaveQueue;
	}

	// Deletes metrics and all associated in-memory entries for a node.
	private _deleteMetrics = async (ipPort: IpPort): Promise<void> => {
		const ipPortString = ipPortToString(ipPort);

		// Get metrics before deleting from map to get lastSeenTimeMs and rating.
		const metricsToDelete = this._ipPortStringToMetrics.get(ipPortString);
		const oldRating = this._ipPortStringToRating.get(ipPortString);

		// Clean up in-memory maps.
		this._ipPortStringToMetrics.delete(ipPortString);

		// Clean up rating maps.
		if (oldRating !== undefined) {
			const oldRatingSet = this._ratingToIpPortStringSet.get(oldRating);
			if (oldRatingSet) {
				oldRatingSet.delete(ipPortString);
				if (oldRatingSet.size === 0) {
					this._ratingToIpPortStringSet.delete(oldRating);
				}
			}
			this._ipPortStringToRating.delete(ipPortString);
		}

		// Clean up seen time map using the seen time from metrics.
		if (metricsToDelete) {
			const seenTime = metricsToDelete.lastSeenTimeMs;
			const seenSet = this._seenTimeToIpPortStringSet.get(seenTime);
			if (seenSet) {
				seenSet.delete(ipPortString);
				if (seenSet.size === 0) {
					this._seenTimeToIpPortStringSet.delete(seenTime);
				}
			}
		}

		// Delete from database (metrics database only).
		this._metricsSaveQueue = this._metricsSaveQueue.then(async () => {
			await this._levelDbMetrics.del(ipPort);
		});
		return this._metricsSaveQueue;
	}

	// Gets metrics for an IP/Port, creating default metrics if not found.
	// If creating, uses the provided timeMs as lastSeenTimeMs and adds to the seen time map.
	// Returns a structured clone of the metrics so it can be modified without affecting the original.
	private _getMetricsCopySetDefault = (ipPort: IpPort, timeMs: number): NodeConnectionMetrics => {
		const ipPortString = ipPortToString(ipPort);
		let metrics = this._ipPortStringToMetrics.get(ipPortString);
		if (!metrics) {
			// If metrics don't exist, create default with the provided timeMs as lastSeenTimeMs.
			metrics = createDefaultNodeConnectionMetrics(timeMs);
			this._ipPortStringToMetrics.set(ipPortString, metrics);

			// Add to seen time map immediately for newly created entries.
			// Subsequent updates to seen time will be handled in _updateMetricsBatch.
			let seenSet = this._seenTimeToIpPortStringSet.get(timeMs);
			if (!seenSet) {
				seenSet = new Set<string>();
				this._seenTimeToIpPortStringSet.set(timeMs, seenSet);
			}
			seenSet.add(ipPortString);

			// Also add to rating maps immediately for newly created entries (default rating).
			// Subsequent rating updates will be handled in _updateMetricsBatch.
			const defaultRating = calculateRating(metrics, this._latestMetricsUpdateTimeMs, timeMs);// Calculate rating for the default metrics.
			let ratingSet = this._ratingToIpPortStringSet.get(defaultRating);
			if (!ratingSet) {
				ratingSet = new Set<string>();
				this._ratingToIpPortStringSet.set(defaultRating, ratingSet);
			}
			ratingSet.add(ipPortString);
			this._ipPortStringToRating.set(ipPortString, defaultRating);

			// Populate non-blacklisted set if rating is acceptable.
			if (defaultRating >= NodesDatabase._blacklistedRatingThreshold) {
				this._nonBlacklistedIpPortStrings.add(ipPortString);
			}
		}
		// For existing metrics, the seen time and rating will be updated in methods.
		// that call _updateMetrics or _updateMetricsBatch.
		return structuredClone(metrics);
	}

	/**
	 * Adds a ping time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param pingTimestampMs - The timestamp of the ping.
	 * @param pingDurationMs - The duration of the ping.
	 */
	addPingTimeMs = async (ipPort: IpPort, pingTimestampMs: number, pingDurationMs: number): Promise<void> => {
		const metrics = this._getMetricsCopySetDefault(ipPort, pingTimestampMs);// Get or create metrics, setting seen time if new.
		metrics.recentPingTimes.push({ pingTimestampMs, pingDurationMs });
		if (metrics.recentPingTimes.length > MAX_recentPingTimes_LENGTH) {
			metrics.recentPingTimes.shift();
		}

		// Update the seen time because this event means the node was seen.
		metrics.lastSeenTimeMs = pingTimestampMs;

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, pingTimestampMs);
	}

	/**
	 * Adds a recent unintentional disconnect time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param disconnectTimeMs - The timestamp of the disconnect.
	 */
	addRecentUnintentionalDisconnectTimesMs = async (ipPort: IpPort, disconnectTimeMs: number): Promise<void> => {
		const metrics = this._getMetricsCopySetDefault(ipPort, disconnectTimeMs);// Get or create metrics, setting seen time if new.

		const connectTimeThreshold = metrics.lastConnectTimeMs ?? -Infinity;
		const latestPingTime = metrics.recentPingTimes.length > 0
			? Math.max(...metrics.recentPingTimes.map(ping => ping.pingTimestampMs))
			: -Infinity;
		const timeThreshold = Math.max(connectTimeThreshold, latestPingTime) + 4 * 7 * 24 * 60 * 60 * 1000;

		if (disconnectTimeMs < timeThreshold) {
			// If disconnected before 4 weeks after last ping/connect, add to recentUnintentionalDisconnectAfterConnectTimesMs.
			metrics.recentUnintentionalDisconnectAfterConnectTimesMs.push(disconnectTimeMs);
			if (metrics.recentUnintentionalDisconnectAfterConnectTimesMs.length > MAX_recentUnintentionalDisconnectTimesMs_LENGTH) {
				metrics.recentUnintentionalDisconnectAfterConnectTimesMs.shift();
			}
		} else {
			// Otherwise, add to recentUnintentionalDisconnectBeforeConnectTimesMs.
			metrics.recentUnintentionalDisconnectBeforeConnectTimesMs.push(disconnectTimeMs);
			if (metrics.recentUnintentionalDisconnectBeforeConnectTimesMs.length > MAX_recentUnintentionalDisconnectTimesMs_LENGTH) {
				metrics.recentUnintentionalDisconnectBeforeConnectTimesMs.shift();
			}
		}

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, disconnectTimeMs);
	}

	/**
	 * Adds the last connect time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param lastConnectTimeMs - The timestamp of the last connect.
	 */
	addLastConnectTimeMs = async (ipPort: IpPort, lastConnectTimeMs: number): Promise<void> => {
		const metrics = this._getMetricsCopySetDefault(ipPort, lastConnectTimeMs);// Get or create metrics, setting seen time if new.
		metrics.lastConnectTimeMs = lastConnectTimeMs;

		// Update the seen time because this event means the node was seen.
		metrics.lastSeenTimeMs = lastConnectTimeMs;

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, lastConnectTimeMs);
	}

	/**
	 * Adds the last connect and test time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param lastConnectAndTestTimeMs - The timestamp of the last connect and test.
	 */
	addLastConnectAndTestTimeMs = async (ipPort: IpPort, lastConnectAndTestTimeMs: number): Promise<void> => {
		const metrics = this._getMetricsCopySetDefault(ipPort, lastConnectAndTestTimeMs);// Get or create metrics, setting seen time if new.
		metrics.lastConnectAndTestTimeMs = lastConnectAndTestTimeMs;

		// Metrics may have been deleted. Make sure it has a lastConnectTimeMs if it has a lastConnectAndTestTimeMs.
		if (!metrics.lastConnectTimeMs) {
			metrics.lastConnectTimeMs = lastConnectAndTestTimeMs;
		}

		// Update the seen time because this event means the node was seen.
		metrics.lastSeenTimeMs = lastConnectAndTestTimeMs;

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, lastConnectAndTestTimeMs);
	}

	/**
	 * Adds the last data received time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param lastDataReceivedTimeMs - The timestamp of the last data received.
	 */
	addLastDataReceivedTimeMs = async (ipPort: IpPort, lastDataReceivedTimeMs: number): Promise<void> => {
		const metrics = this._getMetricsCopySetDefault(ipPort, lastDataReceivedTimeMs);// Get or create metrics, setting seen time if new.
		metrics.lastDataReceivedTimeMs = lastDataReceivedTimeMs;

		// Update the seen time because this event means the node was seen.
		metrics.lastSeenTimeMs = lastDataReceivedTimeMs;

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, lastDataReceivedTimeMs);
	}

	/**
	 * Adds the last out of sync time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param lastOutOfSyncTimeMs - The timestamp of the last out of sync.
	 */
	addLastOutOfSyncTimeMs = async (ipPort: IpPort, lastOutOfSyncTimeMs: number): Promise<void> => {
		const metrics = this._getMetricsCopySetDefault(ipPort, lastOutOfSyncTimeMs);// Get or create metrics, setting seen time if new.
		metrics.lastOutOfSyncTimeMs = lastOutOfSyncTimeMs;

		// Update the seen time because this event means the node was seen.
		metrics.lastSeenTimeMs = lastOutOfSyncTimeMs;

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, lastOutOfSyncTimeMs);
	}

	/**
	 * Adds the last invalid chain detected time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param lastInvalidChainDetectedTimeMs - The timestamp of the last invalid chain detected.
	 */
	addLastInvalidChainDetectedTimeMs = async (ipPort: IpPort, lastInvalidChainDetectedTimeMs: number): Promise<void> => {
		const metrics = this._getMetricsCopySetDefault(ipPort, lastInvalidChainDetectedTimeMs);// Get or create metrics, setting seen time if new.
		metrics.lastInvalidChainDetectedTimeMs = lastInvalidChainDetectedTimeMs;

		// Update the seen time because this event means the node was seen.
		metrics.lastSeenTimeMs = lastInvalidChainDetectedTimeMs;

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, lastInvalidChainDetectedTimeMs);
	}

	/**
	 * Adds a seen time to a node's metrics.
	 * @param ipPort - The IP port of the node.
	 * @param seenTimeMs - The timestamp of when the node was seen.
	 */
	addSeen = async (ipPort: IpPort, seenTimeMs: number): Promise<void> => {
		// _getMetricsCopySetDefault gets existing or creates new metrics, setting seen time and adding to maps if new.
		const metrics = this._getMetricsCopySetDefault(ipPort, seenTimeMs);

		// If the node existed, update its seen time in the metrics object.
		// If it was new, the seen time was already set in _getMetricsCopySetDefault.
		metrics.lastSeenTimeMs = seenTimeMs;

		// _updateMetrics (which calls _updateMetricsBatch) will handle updating all in-memory maps (rating and seen time) and saving to DB.
		return this._updateMetrics(ipPort, metrics, seenTimeMs);
	}

	/**
	 * Adds a seen time to a batch of nodes' metrics.
	 * @param ipPorts - The IP ports of the nodes.
	 * @param seenTimeMs - The timestamp of when the nodes were seen.
	 */
	addSeenBatch = async (ipPorts: IpPort[], seenTimeMs: number): Promise<void> => {
		const ipPortStringToMetricsToUpdate: Map<string, NodeConnectionMetrics> = new Map();

		for (const ipPort of ipPorts) {
			const ipPortString = ipPortToString(ipPort);
			// _getMetricsCopySetDefault gets existing or creates new metrics, setting seen time and adding to maps if new.
			const metrics = this._getMetricsCopySetDefault(ipPort, seenTimeMs);

			// If the node existed, update its seen time in the metrics object.
			// If it was new, the seen time was already set in _getMetricsCopySetDefault.
			metrics.lastSeenTimeMs = seenTimeMs;

			// Add to the batch update map.
			ipPortStringToMetricsToUpdate.set(ipPortString, metrics);
		}

		// _updateMetricsBatch will handle updating all in-memory maps (rating and seen time) and saving to DB for the batch.
		return this._updateMetricsBatch(ipPortStringToMetricsToUpdate, seenTimeMs);
	}

	/**
	 * Deletes a node from the database.
	 * @param ipPort - The IP port of the node to delete.
	 */
	deleteNode = async (ipPort: IpPort): Promise<void> => {
		// _deleteMetrics handles cleanup of all in-memory structures (including seen time)
		// and the metrics database entry.
		return this._deleteMetrics(ipPort);
	}

	/**
	 * Gets the last seen time of a node.
	 * @param ipPort - The IP port of the node.
	 * @returns The last seen time in milliseconds, or undefined if the node is not found.
	 */
	getNodeSeenTimeMs = (ipPort: IpPort): number | undefined => {
		const ipPortString = ipPortToString(ipPort);
		const metrics = this._ipPortStringToMetrics.get(ipPortString);
		// If metrics exist, return the seen time. Otherwise, undefined (node not found).
		return metrics ? metrics.lastSeenTimeMs : undefined;
	}

	/**
	 * Gets the rating of a node.
	 * @param ipPort - The IP port of the node.
	 * @param timeMs - The current time in milliseconds.
	 * @returns The rating of the node, or undefined if the node is not found.
	 */
	getNodeRating = (ipPort: IpPort, timeMs: number): number | undefined => {
		const ipPortString = ipPortToString(ipPort);
		this._recalculateNodeRating(ipPortString, timeMs);
		return this._ipPortStringToRating.get(ipPortString);
	}

	/**
	 * Gets the total number of nodes in the database.
	 * @returns The total number of nodes.
	 */
	getNumNodes = (): number => {
		return this._ipPortStringToMetrics.size;
	}

	/**
	 * Gets the number of non-blacklisted nodes in the database.
	 * @param options - Options for getting the number of non-blacklisted nodes.
	 * @param options.timeMs - The current time in milliseconds.
	 * @param options.excludedIpPortStringsMap - A map of IP port strings to exclude from the count.
	 * @returns The number of non-blacklisted nodes.
	 */
	getNumNodesNonBlacklisted = ({ timeMs, excludedIpPortStringsMap }: {
		timeMs: number;
		excludedIpPortStringsMap?: Map<string, any>;
	}): number => {
		this._buildRatingsMapsFromMetrics(timeMs);
		let numExcluded = 0;
		if (excludedIpPortStringsMap) {
			for (const ipPortString of excludedIpPortStringsMap.keys()) {
				if (this._nonBlacklistedIpPortStrings.has(ipPortString)) {
					numExcluded++;
				}
			}
		}
		return this._nonBlacklistedIpPortStrings.size - numExcluded;
	}

	/**
	 * Gets the most recently seen nodes.
	 * @param options - Options for getting the most recently seen nodes.
	 * @param options.timeMs - The current time in milliseconds.
	 * @param options.amount - The number of nodes to get.
	 * @param options.excludedIpPortStringsMap - A map of IP port strings to exclude from the results.
	 * @param options.allowBlacklisted - Whether to include blacklisted nodes in the results.
	 * @returns An array of the most recently seen nodes.
	 */
	getMostRecentlySeenNodes = ({ timeMs, amount, excludedIpPortStringsMap, allowBlacklisted }: {
		timeMs: number;
		amount?: number;
		excludedIpPortStringsMap?: Map<string, any>;
		allowBlacklisted?: boolean;
	}): IpPort[] => {
		amount = amount ?? 1;
		excludedIpPortStringsMap = excludedIpPortStringsMap ?? new Map<string, any>();
		allowBlacklisted = !!allowBlacklisted;

		if (!allowBlacklisted) {
			this._buildRatingsMapsFromMetrics(timeMs);
		}

		const result: IpPort[] = [];
		// Iterate through the seen time tree in reverse order (most recent first).
		for (const [time, ipPortSet] of this._seenTimeToIpPortStringSet.entriesReversed()) {
			for (const ipPortString of ipPortSet) {
				if (excludedIpPortStringsMap.has(ipPortString)) continue;

				if (!allowBlacklisted && this._ipPortStringToRating.get(ipPortString)! < NodesDatabase._blacklistedRatingThreshold) continue;

				result.push(stringToIpPort(ipPortString));
				if (result.length >= amount) {
					return result;
				}
			}
		}
		return result;
	}

	/**
	 * Gets the top-rated nodes.
	 * @param options - Options for getting the top-rated nodes.
	 * @param options.timeMs - The current time in milliseconds.
	 * @param options.amount - The number of nodes to get.
	 * @param options.excludedIpPortStringsMap - A map of IP port strings to exclude from the results.
	 * @param options.allowBlacklisted - Whether to include blacklisted nodes in the results.
	 * @returns An array of the top-rated nodes.
	 */
	getTopRatedNodes = ({ timeMs, amount, excludedIpPortStringsMap, allowBlacklisted }: {
		timeMs: number;
		amount?: number;
		excludedIpPortStringsMap?: Map<string, any>;
		allowBlacklisted?: boolean;
	}): IpPort[] => {
		amount = amount ?? 1;
		excludedIpPortStringsMap = excludedIpPortStringsMap ?? new Map<string, any>();
		allowBlacklisted = !!allowBlacklisted;

		this._buildRatingsMapsFromMetrics(timeMs);

		const result: IpPort[] = [];
		// Iterate through the rating tree in reverse order (highest rating first).
		for (const [rating, ipPortSet] of this._ratingToIpPortStringSet.entriesReversed()) {
			for (const ipPortString of ipPortSet) {
				if (excludedIpPortStringsMap.has(ipPortString)) continue;
				if (!allowBlacklisted && rating < NodesDatabase._blacklistedRatingThreshold) continue;

				result.push(stringToIpPort(ipPortString));
				if (result.length >= amount) {
					return result;
				}
			}
		}
		return result;
	}

	/**
	 * Checks if a node exists in the database.
	 * @param ipPort - The IP port of the node.
	 * @returns True if the node exists, false otherwise.
	 */
	has = (ipPort: IpPort): boolean => {
		const ipPortString = ipPortToString(ipPort);
		return this._ipPortStringToMetrics.has(ipPortString);
	}

	/**
	 * Checks if a node is blacklisted.
	 * @param ipPort - The IP port of the node.
	 * @param timeMs - The current time in milliseconds.
	 * @returns True if the node is blacklisted, false otherwise.
	 */
	isBlacklisted = (ipPort: IpPort, timeMs: number): boolean => {
		const ipPortString = ipPortToString(ipPort);
		this._recalculateNodeRating(ipPortString, timeMs);
		const rating = this._ipPortStringToRating.get(ipPortString);
		if (rating === undefined) {
			return false;
		}
		return rating < NodesDatabase._blacklistedRatingThreshold;
	}
}