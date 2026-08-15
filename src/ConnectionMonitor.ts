import { abortableSleepMsThrow, assert, combineAbortControllers, unixTime3Decimal } from "./utils/util.js";

export const DEFAULT_timeoutMs = 10000;
export const DEFAULT_intervalMs = 60000;
// How long waitForInternetCheapAsync waiters wait for fresh peer data (invs, headers,
// pongs) before falling back to a ping and, failing that, a fetch. Connected nodes send
// data frequently, so most waiters resolve within this window without any network I/O.
// Concurrent waiters share the same fetch because a fetch completing during a wait is
// reused instead of fetching again. This is a fixed network-behavior constant, intentionally
// independent of the configured interval/timeout: peer data arrival rates do not scale with
// the monitor's polling cadence.
export const DEFAULT_dataWaitMs = 20000;
// After a failed ping, waiters skip pinging for this long and fall back to the shared
// fetch. This is a fixed network-behavior constant (equal to the default interval, but
// intentionally independent of the configured interval/timeout). A failed ping
// disconnects the pinged node (see LegacyNodeConnection.ping), so the cooldown
// rate-limits monitor pings to one per cooldown window and cuts the ping-caused
// disconnect cascade: the disconnect handler's own check would otherwise ping again
// after its data wait. It does not bound other disconnect sources (e.g. the per-node
// scheduled pings in LegacyNodeConnection), which disconnect nodes directly without
// arming the cooldown.
export const DEFAULT_pingCooldownMs = DEFAULT_intervalMs;
// Safety margin added to the worst-case verdict time (data wait + ping timeout + fetch
// timeout) for the timer that guarantees a waitForInternetCheapAsync waiter settles
// even if the ping and fetch both take their full timeouts.
export const DEFAULT_verdictSafetyNetMarginMs = 1000;
// Incoming data must be received this long into the future for the connection to be
// considered active. Must be >= 0.
export const INCOMING_DATA_THRESHOLD_MS = 100;
// After a mass disconnect or an offline check report, peer data must arrive this long
// afterwards before it counts as proof that peers are reachable again. This grace
// period keeps stale or slow data (delayed packets around an outage, or nodes
// reconnecting slowly after one) from reopening rating penalties for nodes that the
// outage disconnected. Derived from the timeout and margin: the grace must exceed the
// time in-flight pre-recovery pings and connect attempts (both bounded by the
// ping/fetch timeout) take to settle after recovery, plus timer jitter.
export const DEFAULT_peersReachableGraceMs = DEFAULT_timeoutMs + DEFAULT_verdictSafetyNetMarginMs;
// While peers are not known to be reachable, waiters only wait this long for peer
// data before falling back to a ping or fetch, instead of the full data wait. Peer
// data is not expected while peers are known to be unreachable, so the full wait only
// delays the verdict. The short wait still gives data a brief chance to arrive first,
// which keeps a healthy cold start fetch-free, because the initial handshakes deliver
// data within about a second.
export const DEFAULT_unreachableDataWaitMs = 2000;
// While peers are known to be unreachable, fetch checks are throttled to at most one
// per this window. Without the throttle, the short unreachable data wait would start
// a new fetch as soon as the previous one settled, which is too frequent during a
// long outage. Waiters inside the window share a single scheduled fetch that runs
// when the window expires, so every waiter still gets fresh evidence from a fetch
// that completed after it registered. The effective window tracks the configured
// timeout (a fetch takes up to the timeout to settle, so the window must be at
// least that long or waiters would schedule a new fetch on top of a settled one);
// this constant is the default window for the default timeout.
export const DEFAULT_unreachableFetchThrottleMs = DEFAULT_timeoutMs;
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
			// The fetch promises escape this callback into Promise.any, so the combined
			// controllers cannot use `using`; dispose each one as its fetch settles.
			combinedAbortController[Symbol.dispose]();
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
	// Time of the most recent fetch check completion (success or failure). Used by
	// waitForInternetCheapAsync to reuse a recent verdict without fetching again.
	private _lastFetchTimeMs: number = INIT_lastKnownConnectionTimeMs;
	// The in-flight fetch check, shared by concurrent waiters so only one fetch runs at
	// a time.
	private _fetchCheckQueue: Promise<boolean> | null = null;
	// The in-flight ping, shared by concurrent waiters so only one node is pinged at a
	// time.
	private _pingQueue: Promise<boolean> | null = null;
	// Waiters skip pinging until this time after the previous ping failed. Reset on
	// start() so a restart does not inherit stale cooldown state.
	private _pingCooldownUntilMs: number = INIT_lastKnownConnectionTimeMs;
	private _started: boolean = false;
	private _intervalMs: number;
	private _timeoutMs: number;
	private _pingIntervalMs: number;
	private readonly _enableConsoleDebugLog: boolean = false;
	private _abortSignal: AbortSignal | null = null;
	// Invoked by waiters at the end of the data wait to ping a connected node (a cheap
	// P2P message) and report whether a pong was received. Returns null when there was no
	// node available to ping (no ping attempted). Set by the host via setPingHandler.
	// Note: a ping that times out disconnects the node (see LegacyNodeConnection.ping),
	// so concurrent pings are combined into a single in-flight ping.
	private _pingHandler: ((timeoutMs: number, signal?: AbortSignal) => Promise<boolean | null>) | null = null;
	private _updateResolvers: Array<{ condition: () => boolean, resolver: () => void }> = [];
	// Optional callback invoked whenever a connectivity check reports a result. The
	// fetch check is the last resort: normally peer data arrivals or pings call
	// updateLastKnownConnectionTime() to signal connectivity, and a fetch only runs when
	// neither happened within the data wait. The callback receives the previous and the
	// new isConnected status so the host can distinguish transitions (online↔offline)
	// from no-op reports (online→online, offline→offline).
	// `_lastReportedStatus` is null until the first check report after a start() or
	// dispose(), but fresh peer data fills it in silently beforehand (see
	// updateLastKnownConnectionTime). The host classifies a null previous status
	// against the assumed-online baseline so every report emits an event.
	private _lastReportedStatus: boolean | null = null;
	private _onCheckResult: ((prev: boolean | null, isConnected: boolean) => void) | null = null;
	// Whether peers are currently considered reachable. Tri-state: null means no
	// evidence yet (a fresh start), false means peers are known unreachable (a mass
	// disconnect marked by the host, or an offline check report), and true means
	// fresh peer data arrived after the grace period. Peers start out unknown: no
	// peer data has arrived yet, but there is also no reason to assume an outage, so
	// arePeersReachable() treats null as reachable (the assumed-online baseline) and
	// the host only skips rating penalties once unreachability is actually known. A
	// successful fetch does not prove peers are reachable, because the peer network
	// may still be blocked while HTTP works.
	private _peersReachable: boolean | null = null;
	// When peers were last known to be unreachable (a mass disconnect or an offline
	// check report). Fresh data only sets _peersReachable back to true once the grace
	// period has passed since this time.
	private _lastPeersUnreachableTimeMs: number = INIT_lastKnownConnectionTimeMs;
	// While peers are unreachable and inside the fetch throttle window, waiters share
	// a single scheduled fetch that runs when the window expires. Waiters get their
	// verdict from that future fetch, which completes after they registered, so the
	// verdict is never based on past data. The schedule collapses concurrent waiters
	// into one fetch.
	private _throttledFetchQueue: Promise<boolean> | null = null;
	private _throttledFetchResolve: ((isConnected: boolean | Promise<boolean>) => void) | null = null;
	private _throttledFetchTimeout: NodeJS.Timeout | null = null;

	constructor({ intervalMs, timeoutMs, pingIntervalMs, enableConsoleDebugLog }: {
		intervalMs?: number;
		timeoutMs?: number;
		pingIntervalMs?: number;
		enableConsoleDebugLog?: boolean;
	} = {}) {
		this._intervalMs = intervalMs ?? DEFAULT_intervalMs;
		this._timeoutMs = timeoutMs ?? DEFAULT_timeoutMs;
		// Pings are the primary mechanism for keeping _lastKnownConnectionTimeMs fresh when
		// peers go quiet: a pong arrives as socket data and updates the time, which resolves
		// waitForInternetCheapAsync waiters and makes shouldSkipForRecentData() suppress
		// the next scheduled ping. The default ping interval must be shorter than the skip
		// window ((intervalMs - timeoutMs) * 0.9) so a successful pong always lands inside
		// it; derive the default from the configured interval/timeout so the invariant holds
		// for any custom config.
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
		this._started = false;
		// Clear the handlers first so in-flight waiters cannot start new checks while
		// dispose awaits the current ones. In-flight checks settle on their own: the
		// fetch is bounded by its per-URL timeouts and the ping by its timeout.
		this._onCheckResult = null;
		this._pingHandler = null;
		if (this._fetchCheckQueue !== null) {
			await this._fetchCheckQueue;
			this._fetchCheckQueue = null;
		}
		if (this._pingQueue !== null) {
			await this._pingQueue;
			this._pingQueue = null;
		}
		// Cancel the throttled fetch schedule and settle its waiters so shutdown never
		// waits for the throttle window.
		if (this._throttledFetchTimeout !== null) {
			clearTimeout(this._throttledFetchTimeout);
			this._throttledFetchTimeout = null;
		}
		if (this._throttledFetchResolve !== null) {
			this._throttledFetchResolve(false);
			this._throttledFetchResolve = null;
			this._throttledFetchQueue = null;
		}
		// Reset so the first check after the next start() is classified fresh instead of
		// comparing against the stale pre-dispose status. The fetch time reset also
		// keeps the previous session's fetch from throttling the first check after a
		// restart, and stops past fetch verdicts from being reused.
		this._lastReportedStatus = null;
		this._lastFetchTimeMs = INIT_lastKnownConnectionTimeMs;
		this._peersReachable = null;
		this._lastPeersUnreachableTimeMs = INIT_lastKnownConnectionTimeMs;
	}

	stop = async (): Promise<void> => {
		await this[Symbol.asyncDispose]();
	}

	start = async (signal: AbortSignal): Promise<void> => {
		if (this._started) {
			if (this._fetchCheckQueue !== null) {
				await this._fetchCheckQueue;
			}
			if (this._pingQueue !== null) {
				await this._pingQueue;
			}
			return;
		}
		// Reset so the first check after start() is classified fresh instead of comparing
		// against a stale pre-dispose status. This only runs on a fresh start after
		// stop()/dispose(): a start() while already started (the reconnection path from
		// BlockHeadersClient) returns above and intentionally keeps the previous status,
		// since the internet state did not reset between reconnections.
		this._lastReportedStatus = null;
		this._pingCooldownUntilMs = INIT_lastKnownConnectionTimeMs;
		this._peersReachable = null;
		this._lastPeersUnreachableTimeMs = INIT_lastKnownConnectionTimeMs;
		this._abortSignal = signal;
		this._started = true;
	}

	// Runs the fetch-based internet check and records the outcome. A successful fetch
	// updates the fetch time and reported status but does NOT mark peers as reachable,
	// because HTTP can work while the peer network is still blocked. An offline report
	// marks peers as unreachable. Returns false if the monitor signal was aborted
	// mid-check (aborted checks record and report nothing).
	private _runCheck = async (signal: AbortSignal): Promise<boolean> => {
		const isConnected = await checkInternetConnection(this._timeoutMs, signal);
		if (signal.aborted) {
			return false;
		}
		this._enableConsoleDebugLog && console.log(unixTime3Decimal(), `- ${isConnected ? 'C' : 'Not c'}onnected to internet.`);
		if (isConnected) {
			// A successful fetch refreshes the data timer so pending waiters settle
			// early and scheduled pings see recent data. It must not mark peers
			// reachable, because the peer network may still be blocked while HTTP
			// works, so the reachability side effect stays in
			// updateLastKnownConnectionTime().
			this._recordLastKnownConnectionTime();
		} else {
			// The internet is down, so treat peers as unreachable too. Fresh peer data
			// after the grace period will mark them reachable again.
			this._lastPeersUnreachableTimeMs = performance.now();
			this._peersReachable = false;
		}
		this._lastFetchTimeMs = performance.now();
		const prev = this._lastReportedStatus;
		this._lastReportedStatus = isConnected;
		this._callOnCheckResult(prev, isConnected);
		return isConnected;
	}

	// Calls the host's check-result callback. A throwing host callback is isolated so
	// that it cannot break the check or reject the shared queues (waiters would misread
	// a rejection as an abort).
	private _callOnCheckResult = (prev: boolean | null, isConnected: boolean): void => {
		if (this._onCheckResult) {
			try {
				this._onCheckResult(prev, isConnected);
			} catch (error) {
				console.error('Connection monitor check result callback error:', error);
			}
		}
	}

	// Runs the fetch check, deduplicating against any in-flight check so concurrent
	// waiters share a single fetch.
	private _runFetchCheck = async (): Promise<boolean> => {
		if (this._fetchCheckQueue !== null) {
			return this._fetchCheckQueue;
		}
		// A waiter's data-wait continuation can run while dispose() is awaiting the
		// in-flight ping/fetch, or after dispose() has returned. Sharing an in-flight
		// check is fine (dispose awaits it too), but starting a fresh check here would
		// leave a zombie that dispose() never awaits. Return false once dispose has begun.
		if (!this._started) {
			return false;
		}
		// While peers are not known to be reachable, throttle fetches to one per
		// throttle window (which tracks the configured timeout). Waiters inside the
		// window share a scheduled future fetch instead of reusing a past verdict, so
		// the fresh-evidence rule is preserved.
		if (this._peersReachable !== true && performance.now() - this._lastFetchTimeMs < this._timeoutMs) {
			return this._getOrCreateThrottledFetch();
		}
		assert(this._abortSignal);
		const signal = this._abortSignal!;
		this._fetchCheckQueue = (async () => {
			const isConnected = await this._runCheck(signal);
			this._fetchCheckQueue = null;
			return isConnected;
		})();
		return this._fetchCheckQueue;
	}

	// Creates (or returns) the single scheduled fetch that runs when the throttle
	// window expires. The fetch uses the monitor-level abort signal, so it aborts
	// instantly when the host stops. dispose() clears the timer and resolves the
	// queue so pending waiters settle immediately on shutdown.
	private _getOrCreateThrottledFetch = (): Promise<boolean> => {
		if (this._throttledFetchQueue !== null) {
			return this._throttledFetchQueue;
		}
		const delayMs = Math.max(0, this._lastFetchTimeMs + this._timeoutMs - performance.now());
		this._throttledFetchQueue = new Promise<boolean>((resolve) => {
			this._throttledFetchResolve = resolve;
			this._throttledFetchTimeout = setTimeout(() => {
				this._throttledFetchTimeout = null;
				const resolveQueue = this._throttledFetchResolve!;
				this._throttledFetchResolve = null;
				this._throttledFetchQueue = null;
				// The window has expired, so this call passes the throttle gate and runs
				// a real fetch. Waiters await this promise, so their verdicts come from
				// the future fetch, never from a past one.
				resolveQueue(this._runFetchCheck());
			}, delayMs);
		});
		return this._throttledFetchQueue;
	}

	// Obtains a verdict by pinging a connected node first, then falls back to the fetch
	// check if the ping fails (or no node was available to ping). Concurrent waiters share
	// a single in-flight ping so at most one node is pinged at a time. The ping runs on the
	// monitor-level abort signal (like the shared fetch) so that cancelling one waiter
	// cannot abort the ping for everyone else.
	private _pingOrFetch = async (): Promise<boolean> => {
		if (this._pingHandler) {
			assert(this._abortSignal);
			if (this._pingQueue === null && performance.now() >= this._pingCooldownUntilMs) {
				this._pingQueue = this._pingHandler(this._timeoutMs, this._abortSignal!)
					.catch(() => false)// A throwing handler is a ping failure, not an abort.
					.then((success) => {
						// A ping timeout disconnects the pinged node (see
						// LegacyNodeConnection.ping), so after a failed ping waiters skip
						// pinging for one cooldown period and fall back to the shared fetch.
						// This rate-limits outage disconnects to one monitor ping per cooldown
						// window. A null result (no node available to ping) arms nothing.
						if (success === false) {
							this._pingCooldownUntilMs = performance.now() + DEFAULT_pingCooldownMs;
						}
						return success === true;
					})
					.finally(() => {
						this._pingQueue = null;
					});
			}
			if (this._pingQueue !== null && await this._pingQueue) {
				return true;
			}
		}
		return this._runFetchCheck();
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
	 * The longest a waitForInternetCheapAsync() verdict can take: the data wait, a
	 * ping timeout, the unreachable fetch throttle window, a fetch timeout, plus a
	 * safety margin for timer jitter. The throttle window is included because it can
	 * sit between the ping and the fetch (see _runFetchCheck); with the window
	 * tracking the configured timeout this is dataWait + 3 * timeout + margin.
	 */
	getDisconnectThresholdMs = (): number => {
		return DEFAULT_dataWaitMs + 3 * this._timeoutMs + DEFAULT_verdictSafetyNetMarginMs;
	}

	/**
	 * Whether an updateLastKnownConnectionTime() call has arrived recently enough for
	 * the per-node ping scheduler (LegacyNodeConnection) to skip its scheduled ping.
	 * This is a global recency window, independent of waitForInternetCheapAsync's
	 * per-waiter fresh-evidence rule.
	 */
	shouldSkipForRecentData = (): boolean => {
		return performance.now() - this._lastKnownConnectionTimeMs < (this._intervalMs - this._timeoutMs) * 0.9;
	}

	/**
	 * Sets a callback invoked whenever a connectivity check reports a new isConnected
	 * status. The callback receives the previous status (or null if this is the first report
	 * after start() or a dispose()) so the host can distinguish transitions from no-op reports.
	 * @param callback - Function receiving (prev, newStatus), or null to clear.
	 */
	// Used by the host (BlockHeadersClient) to re-emit as dashboard-facing events.
	setOnCheckResult = (callback: ((prev: boolean | null, isConnected: boolean) => void) | null): void => {
		this._onCheckResult = callback;
	}

	/**
	 * Sets the handler used to ping a connected node when a waiter needs a verdict and no
	 * peer data arrived during the data wait. Pinging is a P2P message, so it runs before
	 * any internet fetch.
	 * @param handler - Function receiving the ping timeout in ms and an optional abort
	 * signal, or null to clear. Resolves with whether a pong was received, or null when
	 * there was no node available to ping.
	 */
	// Concurrent waiters share a single in-flight ping; the handler is called once with the
	// monitor-level abort signal (not the first waiter's). Note: the host's ping
	// implementation may disconnect a node on timeout, so the ping timeout should be short
	// and the handler should never throw (a rejection is treated as a failed ping).
	setPingHandler = (handler: ((timeoutMs: number, signal?: AbortSignal) => Promise<boolean | null>) | null): void => {
		this._pingHandler = handler;
	}

	// Records fresh evidence and resolves waiting waiters. Called on peer data and,
	// with no reachability side effect, on fetch successes.
	private _recordLastKnownConnectionTime = (): void => {
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

	updateLastKnownConnectionTime = (): void => {
		this._recordLastKnownConnectionTime();
		// Fresh peer data proves that peers are reachable, but only once the grace
		// period has passed since the last mass disconnect or offline report. Stale
		// or slow data (delayed packets around an outage, or nodes reconnecting
		// slowly after one) must not reopen rating penalties for nodes that the
		// outage disconnected.
		if (this._lastKnownConnectionTimeMs - this._lastPeersUnreachableTimeMs >= DEFAULT_peersReachableGraceMs) {
			this._peersReachable = true;
			// Fresh peer data also fills in an unknown reported status as a silent
			// initial value, so a later check report compares against an accurate
			// previous status instead of null. Only null is overwritten: a false
			// status from an offline check report must survive until a check
			// confirms recovery, otherwise data arriving after an outage would
			// silently flip it back to true and the recovery check would emit
			// online_to_online instead of offline_to_online. No callback is called
			// and no event is emitted here: events only ever fire from check
			// reports (failure-triggered checks or fetches).
			if (this._lastReportedStatus === null) {
				this._lastReportedStatus = true;
			}
		}
	}

	getTimeSinceLastKnownConnectionMs = (): number => {
		return performance.now() - this._lastKnownConnectionTimeMs;
	}

	// Marks a mass disconnect (a large portion of the connected peers dropping
	// nearly simultaneously, as detected by the host) and treats peers as
	// unreachable until fresh data after the grace period proves otherwise. Called
	// by the host when its mass-disconnect detection fires. The host still needs to
	// tell the monitor about this event, because a mass disconnect is invisible to
	// the monitor's own data and fetch signals.
	markMassDisconnect = (): void => {
		this._lastPeersUnreachableTimeMs = performance.now();
		this._peersReachable = false;
	}

	// Whether peers are currently considered reachable. A null (unknown) state counts
	// as reachable, matching the assumed-online baseline used for the first check
	// report after a start. The host skips rating penalties and blacklisting for
	// disconnect failures only while peers are known unreachable, since the network
	// is the likely cause.
	arePeersReachable = (): boolean => {
		return this._peersReachable !== false;
	}

	// How long ago peers were last known to be unreachable (a mass disconnect or an
	// offline check report). The host uses this to require an outage-free window
	// before running recoveries like the stuck-detection purge.
	getTimeSincePeersWereUnreachableMs = (): number => {
		return performance.now() - this._lastPeersUnreachableTimeMs;
	}

	/**
	 * Resolves with whether the client is currently connected to the internet. The verdict is
	 * never based on past data: it requires fresh evidence arriving after this call (peer data,
	 * a pong, or a fetch result).
	 * @param signal - Aborts the wait, rejecting this promise.
	 */
	// Waiters first wait up to dataWaitMs for peer data; if none arrives they ping a connected
	// node via the ping handler (a cheap P2P message). With connected nodes, fetches only run
	// when pings fail; without connected nodes, fetches run directly. Concurrent waiters share
	// a single ping and a single fetch: a fetch completing during a wait is reused instead of
	// fetching again.
	waitForInternetCheapAsync = async (signal: AbortSignal): Promise<boolean> => {
		if (!this._started) {
			throw new Error('Not started');
		}
		assert(this._abortSignal);

		const lastKnownConnectionTimeMsBefore = this._lastKnownConnectionTimeMs;
		const lastFetchTimeMsBefore = this._lastFetchTimeMs;

		// Create a promise that is resolved by updateLastKnownConnectionTime() once fresh
		// evidence arrives after this call.
		let updateResolver: () => void;
		const updatePromise = new Promise<void>((resolve) => {
			updateResolver = resolve;
		});

		// Register the condition and resolver.
		const condition = () => lastKnownConnectionTimeMsBefore + INCOMING_DATA_THRESHOLD_MS <= this._lastKnownConnectionTimeMs;
		this._updateResolvers.push({ condition, resolver: updateResolver! });

		// While peers are not known to be reachable (unknown or unreachable), only
		// wait briefly for peer data. Peer data is not expected while peers are known
		// to be unreachable, so the full wait only delays the verdict, and a short
		// outage could end before a check ever ran. The brief wait still lets a
		// healthy cold start resolve from its first handshake data without fetching.
		const dataWaitMs = this._peersReachable === true ? DEFAULT_dataWaitMs : DEFAULT_unreachableDataWaitMs;

		using combinedAbortController = combineAbortControllers(this._abortSignal!, signal);
		try {
			// Tracks whether the verdict came from peer data (as opposed to a ping or a
			// fetch). Peer data inside the reachability grace period does not prove the
			// outage ended (see the report gate below).
			let resolvedByPeerData = false;
			const verdict = await Promise.race([
				updatePromise.then(() => {
					resolvedByPeerData = true;
					return true;
				}),
				abortableSleepMsThrow(dataWaitMs, combinedAbortController.signal).then(async () => {
					// A fetch that completed during the wait is shared evidence, but like peer
					// data it is only trusted once it lands INCOMING_DATA_THRESHOLD_MS past the
					// fetch time observed at registration: a completion that close to the
					// boundary may reflect a check that started before this waiter registered.
					if (lastFetchTimeMsBefore + INCOMING_DATA_THRESHOLD_MS <= this._lastFetchTimeMs) {
						return this._lastReportedStatus === true;
					}
					// A ping to a connected node is cheap; fetch only if it fails (or no
					// nodes are connected, in which case the handler returns false).
					return this._pingOrFetch();
				}),
				// Safety net: the ping takes up to timeoutMs, the throttle window up to
				// timeoutMs, and the fetch up to timeoutMs (see getDisconnectThresholdMs).
				abortableSleepMsThrow(this.getDisconnectThresholdMs(), combinedAbortController.signal).then(() => false)
			]);
			// Successful pings and peer data are fresh evidence of connectivity, so they
			// report the offline-to-online transition here too. The fetch check is the only
			// other source of reports, and it stops running once pings succeed again, so
			// without this the reported status would stay stuck offline after a brief outage.
			// Peer data is exempt while peers are known unreachable: data arriving inside
			// the reachability grace period (delayed packets around an outage, or nodes
			// reconnecting slowly after one) must not flip the status online, or the
			// dashboard would show a false recovery blip that the next check contradicts.
			// updateLastKnownConnectionTime() marks peers reachable again once the grace
			// passes, and then peer-data verdicts report normally.
			if (verdict && this._lastReportedStatus !== true && !(resolvedByPeerData && this._peersReachable === false)) {
				const prev = this._lastReportedStatus;
				this._lastReportedStatus = true;
				this._callOnCheckResult(prev, true);
			}
			return verdict;
		} finally {
			// Cancel the losing race arms: the data-wait sleep would otherwise fire its
			// continuation later and run a check (ping/fetch) on behalf of a waiter that already
			// settled, and the safety-net sleep is moot once a verdict is in.
			combinedAbortController.abort();
			// Clean up the resolver.
			const index = this._updateResolvers.findIndex(r => r.resolver === updateResolver);
			if (index !== -1) {
				this._updateResolvers.splice(index, 1);
			}
		}
	}

	connectedToInternetExpensiveAsync = async (signal: AbortSignal): Promise<boolean> => {
		const abortSignal = this._abortSignal;
		// A missing monitor signal is replaced with a never-aborting signal so the
		// controller is always disposable via `using`.
		using combinedAbortController = combineAbortControllers(abortSignal ?? new AbortController().signal, signal);
		// Await inside the using scope so the abort listeners stay attached for the whole
		// check: an unawaited return would dispose the controller as soon as the body
		// returns, leaving the in-flight fetch unresponsive to aborts.
		// Runs through _runCheck so the fetch reports through the check-result
		// callback (and the host's dashboard events) like every other fetch, and so
		// an abort mid-check records and reports nothing.
		return await this._runCheck(combinedAbortController.signal);
	}
}
