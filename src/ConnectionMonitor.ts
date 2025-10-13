import { abortableSleepMsThrow } from "./utils/util.js";
import { assert, unixTime3Decimal, combineAbortControllers } from "./utils/util.js";

export const DEFAULT_timeoutMs = 10000;
export const DEFAULT_intervalMs = DEFAULT_timeoutMs * 2;
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
	private readonly _enableConsoleDebugLog: boolean = false;
	private _abortSignal: AbortSignal | null = null;
	private _updateResolvers: Array<{ condition: () => boolean, resolver: () => void }> = [];

	constructor({ intervalMs, timeoutMs, enableConsoleDebugLog }: {
		intervalMs?: number;
		timeoutMs?: number;
		enableConsoleDebugLog?: boolean;
	} = {}) {
		this._intervalMs = intervalMs ?? DEFAULT_intervalMs;
		this._timeoutMs = timeoutMs ?? DEFAULT_timeoutMs;
		this._enableConsoleDebugLog = !!enableConsoleDebugLog;

		if (this._intervalMs <= 0) {
			throw new Error('Interval must be greater than 0');
		}
		if (this._intervalMs < this._timeoutMs) {
			throw new Error('Interval must not be less than timeout');
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
		this._abortSignal = signal;
		this._intervalId = setInterval(this._intervalFunction, this._intervalMs);
		// Allows the user to guarentee that this._lastKnownConnectionTimeMs has been set at least once.
		await this._intervalFunction();
	}

	private _intervalFunction = async (): Promise<void> => {
		if (performance.now() - this._lastKnownConnectionTimeMs < (this._intervalMs - this._timeoutMs) * 0.9) {
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
			this._enableConsoleDebugLog && console.log(unixTime3Decimal(), `- ${isConnected ? 'C' : 'Not c'}onnected to internet.`);
			if (isConnected) {
				this._lastKnownConnectionTimeMs = performance.now();
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