import { abortableSleepMsThrow } from "./utils/util.js";
import { assert, unixTime3Decimal, combineAbortControllers } from "./utils/util.js";

export const DEFAULT_timeoutMs = 10000;
export const DEFAULT_intervalMs = 60000;
export const INIT_TIME_MS = performance.now();
export const INIT_lastKnownConnectionTimeMs: number = Number.MIN_SAFE_INTEGER / 2;

// URLs used to test for internet connectivity.
const urls = [
	'https://cloudflare.com/cdn-cgi/trace',
	'https://api.github.com',
	'https://jsonplaceholder.typicode.com/todos/1'
] as const;

// This function should never throw.
async function checkInternetConnection(timeoutMs: number = DEFAULT_timeoutMs, abortSignal: AbortSignal): Promise<boolean> {
	const abortControllers = urls.map(() => new AbortController());

	const connectionChecks = urls.map((url, index) => {
		const controller = abortControllers[index];
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
		const combinedAbortController = combineAbortControllers(controller.signal, abortSignal);

		return fetch(url, {
			mode: 'no-cors',// Avoid CORS issues.
			cache: 'no-store',// Prevent caching.
			signal: combinedAbortController.signal
		}).finally(() => {
			clearTimeout(timeoutId);
		});
	});

	try {
		await Promise.any(connectionChecks);
		abortControllers.forEach(abortController => abortController.abort());
		return true;
	} catch {
		return false;
	}
}

export class ConnectionMonitor {
	private _lastKnownConnectionTimeMs: number = INIT_lastKnownConnectionTimeMs;
	private _intervalFunctionQueue: Promise<void> | null = null;
	private _intervalId: NodeJS.Timeout | null = null;
	private _intervalMs: number;
	private _timeoutMs: number;
	private _pingIntervalMs: number;
	private readonly _enableConsoleDebugLog: boolean = false;
	private _abortSignal: AbortSignal | null = null;
	private _updateResolvers: Array<{ condition: () => boolean, resolver: () => void }> = [];
	// Optional callback invoked whenever the fallback probe (checkInternetConnection) runs.
	// The probe is a fallback: normally node data arrivals call updateLastKnownConnectionTime()
	// to signal connectivity. If no data arrives within (intervalMs - timeoutMs) * 0.9, the
	// fallback fires. Nodes don't always send data reliably within that window even when the
	// internet is connected, so this probe may fire during normal operation.
	// The callback receives the previous and the new isConnected status so the host can
	// distinguish transitions (online↔offline) from no-op probes (online→online, offline→offline).
	// `_lastReportedStatus` is null until the first probe completes; the host treats null as
	// "no transition yet" and emits the matching no-op classification.
	private _lastReportedStatus: boolean | null = null;
	private _onProbeResult: ((prev: boolean | null, isConnected: boolean) => void) | null = null;

	constructor({ intervalMs, timeoutMs, pingIntervalMs, enableConsoleDebugLog }: {
		intervalMs?: number;
		timeoutMs?: number;
		pingIntervalMs?: number;
		enableConsoleDebugLog?: boolean;
	} = {}) {
		this._intervalMs = intervalMs ?? DEFAULT_intervalMs;
		this._timeoutMs = timeoutMs ?? DEFAULT_timeoutMs;
		// Pings are the primary mechanism for keeping _lastKnownConnectionTimeMs fresh when
		// peers go quiet. They must fire more often than the fallback-check's "recent data"
		// skip window ((intervalMs - timeoutMs) * 0.9) so that a successful pong lands inside
		// each window and suppresses the fallback. Derive the default from the configured
		// interval/timeout so the invariant holds for any custom config.
		this._pingIntervalMs = pingIntervalMs ?? Math.floor((this._intervalMs - this._timeoutMs) * 0.9 / 2);
		this._enableConsoleDebugLog = !!enableConsoleDebugLog;

		if (this._intervalMs <= 0) {
			throw new Error('Interval must be greater than 0');
		}
		if (this._intervalMs < this._timeoutMs) {
			throw new Error('Interval must not be less than timeout');
		}
		if (this._pingIntervalMs <= 0) {
			throw new Error('Ping interval must be greater than 0');
		}
	}

	[Symbol.asyncDispose] = async (): Promise<void> => {
		if (this._intervalId !== null) {
			clearInterval(this._intervalId);
			this._intervalId = null;
		}
		if (this._intervalFunctionQueue !== null) {
			await this._intervalFunctionQueue;
			this._intervalFunctionQueue = null;
		}
		// Reset so the next start() emits a fresh probe classification instead of comparing
		// against the stale pre-dispose status.
		this._lastReportedStatus = null;
		this._onProbeResult = null;
	}

	stop = async (): Promise<void> => {
		await this[Symbol.asyncDispose]();
	}

	start = async (signal: AbortSignal): Promise<void> => {
		if (this._intervalId) {
			if (this._intervalFunctionQueue !== null) {
				await this._intervalFunctionQueue;
			}
			return;
		}
		// Reset so the next probe emits a fresh classification instead of comparing
		// against a stale pre-start status. The reconnection path calls _start() from
		// BlockHeadersClient without an intervening dispose(), so the null collapse
		// documented on the connection_monitor_* events must happen here.
		this._lastReportedStatus = null;
		this._abortSignal = signal;
		this._intervalId = setInterval(this._intervalFunction, this._intervalMs);
		// No immediate probe here: the first interval tick fires at intervalMs, and
		// _lastKnownConnectionTimeMs starts at INIT_lastKnownConnectionTimeMs so
		// shouldSkipForRecentData() returns false until the first peer data arrives.
		// Callers that need a fresh baseline (connectedToInternetCheapAsync) wait
		// lazily on the next updateLastKnownConnectionTime() call rather than on a
		// startup fetch. This avoids an unconditional fetch on every start().
	}

	private _intervalFunction = async (): Promise<void> => {
		if (this.shouldSkipForRecentData()) {
			// Updated recently from updateLastKnownConnectionTime(). No need to check again until next interval.
			return;
		}
		if (this._intervalFunctionQueue !== null) {
			return this._intervalFunctionQueue;
		}
		assert(this._abortSignal);
		const signal = this._abortSignal;
		this._intervalFunctionQueue = (async () => {
			const isConnected = await checkInternetConnection(this._timeoutMs, signal!);
			if (signal!.aborted) {
				this._intervalFunctionQueue = null;
				clearInterval(this._intervalId!);
				this._intervalId = null;
				return;
			}
			this._enableConsoleDebugLog && console.log(unixTime3Decimal(), `- ${isConnected ? 'C' : 'Not c'}onnected to internet.`);
			if (isConnected) {
				this.updateLastKnownConnectionTime();
			}
			if (this._onProbeResult) {
				const prev = this._lastReportedStatus;
				this._lastReportedStatus = isConnected;
				this._onProbeResult(prev, isConnected);
			}
			this._intervalFunctionQueue = null;
		})();
		return this._intervalFunctionQueue;
	}

	getDisconnectThresholdMs = (): number => {
		return 3 * this._intervalMs + this._timeoutMs;
	}

	getIntervalMs = (): number => {
		return this._intervalMs;
	}

	getTimeoutMs = (): number => {
		return this._timeoutMs;
	}

	getPingIntervalMs = (): number => {
		return this._pingIntervalMs;
	}

	/**
	 * Whether any updateLastKnownConnectionTime() call has arrived recently enough to
	 * suppress the fallback check. This is the same condition _intervalFunction uses to
	 * skip the fetch, exposed so callers (e.g. LegacyNodeConnection's ping scheduler) share
	 * the definition of "recent peer data" with the fallback check rather than inventing
	 * their own.
	 */
	shouldSkipForRecentData = (): boolean => {
		return performance.now() - this._lastKnownConnectionTimeMs < (this._intervalMs - this._timeoutMs) * 0.9;
	}

	/**
	 * Sets a callback invoked whenever an active probe runs and reports a new isConnected
	 * status. The callback receives the previous status (or null if this is the first probe
	 * after start() or a dispose()) so the host can distinguish transitions from no-op probes.
	 * Used by the host (BlockHeadersClient) to re-emit as dashboard-facing events.
	 * @param callback - Function receiving (prev, newStatus), or null to clear.
	 */
	setOnProbeResult = (callback: ((prev: boolean | null, isConnected: boolean) => void) | null): void => {
		this._onProbeResult = callback;
	}

	updateLastKnownConnectionTime = (): void => {
		this._lastKnownConnectionTimeMs = performance.now();

		// Check and resolve any waiting promises.
		this._updateResolvers = this._updateResolvers.filter(({ condition, resolver }) => {
			if (condition()) {
				resolver();
				return false;// Remove from the list.
			}
			return true;// Keep in the list.
		});
	}

	getTimeSinceLastKnownConnectionMs = (): number => {
		return performance.now() - this._lastKnownConnectionTimeMs;
	}

	// Sleeps up to disconnectThresholdMs until this._lastKnownConnectionTimeMs is updated.
	connectedToInternetCheapAsync = async (signal: AbortSignal): Promise<boolean> => {
		if (!this._intervalId) {
			throw new Error('Not started');
		}
		assert(this._abortSignal);

		const lastKnownConnectionTimeMsBefore = this._lastKnownConnectionTimeMs;
		const disconnectThresholdMs = this.getDisconnectThresholdMs();

		// Create a promise that is resolved by updateLastKnownConnectionTime().
		let updateResolver: () => void;
		const updatePromise = new Promise<void>((resolve) => {
			updateResolver = resolve;
		});

		// Incoming data must be received this long into the future for the connection to be considered active. Must be >= 0.
		const INCOMING_DATA_THRESHOLD_MS = 100;

		// Register the condition and resolver.
		const condition = () => lastKnownConnectionTimeMsBefore + INCOMING_DATA_THRESHOLD_MS <= this._lastKnownConnectionTimeMs;
		this._updateResolvers.push({ condition, resolver: updateResolver! });

		const abortSignal = this._abortSignal!;
		const combinedAbortController = combineAbortControllers(abortSignal, signal);
		try {
			await Promise.race([
				abortableSleepMsThrow(disconnectThresholdMs, combinedAbortController.signal),
				updatePromise
			]);
			return lastKnownConnectionTimeMsBefore + INCOMING_DATA_THRESHOLD_MS <= this._lastKnownConnectionTimeMs;
		} catch (error) {
			// Abort signal triggered.
			throw error;
		} finally {
			// Clean up the resolver.
			const index = this._updateResolvers.findIndex(r => r.resolver === updateResolver);
			if (index !== -1) {
				this._updateResolvers.splice(index, 1);
			}
		}
	}

	connectedToInternetExpensiveAsync = async (signal: AbortSignal): Promise<boolean> => {
		const abortSignal = this._abortSignal;
		const combinedAbortController = abortSignal ? combineAbortControllers(abortSignal, signal) : undefined;
		const combinedAbortControllerSignal = combinedAbortController?.signal;
		return checkInternetConnection(this._timeoutMs, combinedAbortControllerSignal ?? signal);
	}
}