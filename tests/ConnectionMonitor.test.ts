/// <reference types="node" />
import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionMonitor, DEFAULT_timeoutMs, DEFAULT_intervalMs, DEFAULT_dataWaitMs, DEFAULT_pingCooldownMs, DEFAULT_peersReachableGraceMs, DEFAULT_unreachableDataWaitMs, DEFAULT_unreachableFetchThrottleMs, DEFAULT_verdictSafetyNetMarginMs, INCOMING_DATA_THRESHOLD_MS } from '../src/ConnectionMonitor.js';
import { abortableSleepMsThrow } from '../src/utils/util.js';

describe('ConnectionMonitor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(global, 'fetch').mockImplementation(async () => ({ ok: true } as Response));
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('should initialize with default values', () => {
		const monitor = new ConnectionMonitor();
		expect(monitor.getIntervalMs()).toBe(DEFAULT_intervalMs);
		expect(monitor.getTimeoutMs()).toBe(DEFAULT_timeoutMs);
	});

	test('should initialize with custom values', () => {
		const monitor = new ConnectionMonitor({ intervalMs: 5000, timeoutMs: 2000 });
		expect(monitor.getIntervalMs()).toBe(5000);
		expect(monitor.getTimeoutMs()).toBe(2000);
	});

	test('a slow ping and a slow fetch still settle inside the disconnect threshold', async () => {
		const monitor = new ConnectionMonitor({ timeoutMs: 1000 });
		const abortController = new AbortController();
		await monitor.start(abortController.signal);
		// A real fetch only fails when its timeout aborts it.
		(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener('abort', () => reject(new Error('aborted')));
			}));
		const pingHandler = vi.fn().mockImplementation((timeoutMs: number, signal: AbortSignal) =>
			abortableSleepMsThrow(timeoutMs, signal).then(() => false)
		);
		monitor.setPingHandler(pingHandler as any);

		const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);

		// The data wait elapses, then the ping takes its full timeout, then the fetch
		// takes its full timeout: the worst case short of the safety net itself.
		await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		// The verdict lands at dataWait + 2 * timeoutMs = 22000, still inside the
		// 23000ms threshold (dataWait + 2 * timeoutMs + safety margin).
		await expect(cheapCheck).resolves.toBe(false);
		expect(pingHandler).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledTimes(3);
		await monitor.stop();
	});

	test('updateLastKnownConnectionTime should update the time', () => {
		const monitor = new ConnectionMonitor();
		const timeBefore = monitor.getTimeSinceLastKnownConnectionMs();
		vi.advanceTimersByTime(1000);
		monitor.updateLastKnownConnectionTime();
		const timeAfter = monitor.getTimeSinceLastKnownConnectionMs();
		expect(timeAfter).toBeLessThan(timeBefore);
		expect(timeAfter).toBeLessThan(1000);
	});

	describe('waitForInternetCheapAsync', () => {
		test('resolves true from peer data arriving during the wait, without pinging or fetching', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);

			// Data arriving after registration resolves the waiter within the data wait.
			monitor.updateLastKnownConnectionTime();

			await expect(cheapCheck).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(0);
			expect(pingHandler).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('past data does not resolve a waiter: recent pre-query data still waits, then pings, then fetches (drop regression)', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(false);
			monitor.setPingHandler(pingHandler as any);

			// Peer data arrived before the query.
			monitor.updateLastKnownConnectionTime();

			let settled: boolean | null = null;
			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal).then((result) => {
				settled = result;
			});

			// The recent past data must not resolve the waiter...
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBeNull();
			expect(pingHandler).toHaveBeenCalledTimes(0);
			expect(fetch).toHaveBeenCalledTimes(0);

			// ...the ping runs only after the data wait elapses, and its failure leads to
			// a fetch whose failure is the verdict.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(settled).toBe(false);
			await expect(cheapCheck).resolves.toBeUndefined();
			await monitor.stop();
		});

		test('waits the full data wait before pinging or fetching', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			// Fresh peer data makes peers reachable, so the full data wait applies.
			monitor.updateLastKnownConnectionTime();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);

			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs - 1);
			expect(pingHandler).toHaveBeenCalledTimes(0);
			expect(fetch).toHaveBeenCalledTimes(0);

			await vi.advanceTimersByTimeAsync(1);
			expect(pingHandler).toHaveBeenCalledTimes(1);

			await expect(cheapCheck).resolves.toBe(true);
			await monitor.stop();
		});

		test('a successful ping resolves true without fetching', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			await expect(cheapCheck).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('the ping handler receives the monitor-level abort signal, not the waiter signal', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const waiterAbortController = new AbortController();
			const cheapCheck = monitor.waitForInternetCheapAsync(waiterAbortController.signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			await expect(cheapCheck).resolves.toBe(true);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			expect(pingHandler.mock.calls[0][0]).toBe(DEFAULT_timeoutMs);
			expect(pingHandler.mock.calls[0][1]).toBe(abortController.signal);
			expect(pingHandler.mock.calls[0][1]).not.toBe(waiterAbortController.signal);
			await monitor.stop();
		});

		test('a failed ping falls back to a fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			const pingHandler = vi.fn().mockResolvedValue(false);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			await expect(cheapCheck).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('a failed ping suppresses further pings during the cooldown; waiters fall back to the fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(false);
			monitor.setPingHandler(pingHandler as any);

			const firstCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(firstCheck).resolves.toBe(false);

			// The next waiter skips the ping while the cooldown is active.
			const secondCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(secondCheck).resolves.toBe(false);

			// After the cooldown elapses, a waiter pings again.
			await vi.advanceTimersByTimeAsync(DEFAULT_pingCooldownMs);
			const thirdCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(2);
			await expect(thirdCheck).resolves.toBe(false);
			await monitor.stop();
		});

		test('a successful ping does not set the cooldown', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const firstCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(firstCheck).resolves.toBe(true);

			const secondCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(2);
			await expect(secondCheck).resolves.toBe(true);
			await monitor.stop();
		});

		test('a null ping result (no node available) does not set the cooldown', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			const pingHandler = vi.fn().mockResolvedValue(null);
			monitor.setPingHandler(pingHandler as any);

			const firstCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(firstCheck).resolves.toBe(false);

			// Nothing was pinged, so no cooldown was armed: the next waiter pings again
			// instead of falling back to the fetch.
			const secondCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(2);
			await expect(secondCheck).resolves.toBe(false);
			await monitor.stop();
		});

		test('a rejecting ping handler resolves false and falls back to a fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockRejectedValue(new Error('handler bug'));
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			await expect(cheapCheck).resolves.toBe(true);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('concurrent waiters share a single ping', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			let resolvePing: ((value: boolean) => void) | null = null;
			const pingHandler = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolvePing = resolve; }));
			monitor.setPingHandler(pingHandler as any);

			const cheapChecks = [0, 1, 2].map(() => monitor.waitForInternetCheapAsync(new AbortController().signal));
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			// All three waiters share a single in-flight ping.
			expect(pingHandler).toHaveBeenCalledTimes(1);

			resolvePing!(true);
			await expect(Promise.all(cheapChecks)).resolves.toEqual([true, true, true]);
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('a failed shared ping falls back to a single shared fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			let resolvePing: ((value: boolean) => void) | null = null;
			const pingHandler = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolvePing = resolve; }));
			monitor.setPingHandler(pingHandler as any);

			const cheapChecks = [0, 1, 2].map(() => monitor.waitForInternetCheapAsync(new AbortController().signal));
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			expect(pingHandler).toHaveBeenCalledTimes(1);
			resolvePing!(false);

			// The three waiters fall back to a single shared fetch.
			await expect(Promise.all(cheapChecks)).resolves.toEqual([true, true, true]);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('with no ping handler (or no connected nodes) it fetches after the wait', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			await expect(cheapCheck).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('returns false when the fetch fails', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(cheapCheck).resolves.toBe(false);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('a single fetch resolves concurrent waiters', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			let resolveFetch: ((value?: unknown) => void) | null = null;
			(fetch as any).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
			await monitor.start(abortController.signal);

			const cheapChecks = [0, 1, 2].map(() => monitor.waitForInternetCheapAsync(new AbortController().signal));
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			// The three waiters share a single in-flight fetch.
			expect(fetch).toHaveBeenCalledTimes(3);

			resolveFetch!();
			await expect(Promise.all(cheapChecks)).resolves.toEqual([true, true, true]);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('a fetch completing during the wait is reused without a new fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			let resolveFetch: ((value?: unknown) => void) | null = null;
			(fetch as any).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
			await monitor.start(abortController.signal);

			// Waiter A registers first; waiter B registers 1s later. A's wait expires first
			// and its fetch completes before B's wait expires.
			const cheapCheckA = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(1000);
			const cheapCheckB = monitor.waitForInternetCheapAsync(new AbortController().signal);

			// A's wait expires: one fetch in flight.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs - 1000);
			expect(fetch).toHaveBeenCalledTimes(3);

			// A's fetch completes; B's wait is still active.
			resolveFetch!();
			await vi.advanceTimersByTimeAsync(1000);
			await expect(cheapCheckA).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(3);

			// B's wait expires and reuses A's during-wait fetch verdict without fetching.
			await vi.advanceTimersByTimeAsync(0);
			await expect(cheapCheckB).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('a fetch completing within INCOMING_DATA_THRESHOLD_MS of registration is not reused (still pings or fetches)', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			// Fresh peer data makes peers reachable, so the unreachable fetch throttle
			// does not interfere with this boundary test.
			monitor.updateLastKnownConnectionTime();

			// This boundary cannot arise from real monitor flows (fetches are serialized
			// and at least a data wait apart), so drive the internals directly: a verdict
			// recorded shortly before registration...
			const recentFetchTimeMs = performance.now() - 50;
			(monitor as any)._lastFetchTimeMs = recentFetchTimeMs;
			(monitor as any)._lastReportedStatus = true;

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);

			// ...followed by a completion landing inside the threshold window.
			(monitor as any)._lastFetchTimeMs = recentFetchTimeMs + INCOMING_DATA_THRESHOLD_MS / 2;

			// The during-wait completion is not trusted, so the waiter pings or fetches
			// for its own verdict instead of reusing it.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);
			await expect(cheapCheck).resolves.toBe(true);
			await monitor.stop();
		});

		test('a fetch completing past INCOMING_DATA_THRESHOLD_MS is reused without a new fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();

			const recentFetchTimeMs = performance.now() - 50;
			(monitor as any)._lastFetchTimeMs = recentFetchTimeMs;
			(monitor as any)._lastReportedStatus = true;

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);

			// A completion landing past the threshold is trusted fresh evidence and reused.
			(monitor as any)._lastFetchTimeMs = recentFetchTimeMs + INCOMING_DATA_THRESHOLD_MS * 1.5;

			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(0);
			await expect(cheapCheck).resolves.toBe(true);
			await monitor.stop();
		});

		test('a fetch completed before registration is not reused (still fetches)', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);

			// Waiter A's fetch completes successfully before waiter B registers.
			const cheapCheckA = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(cheapCheckA).resolves.toBe(true);
			(fetch as any).mockClear();

			// B's wait elapses with no new fetch during it, so it fetches for its own verdict.
			const cheapCheckB = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);
			await expect(cheapCheckB).resolves.toBe(true);
			await monitor.stop();
		});

		test('a waiter resolved by peer data leaves no zombie ping or fetch behind', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();// Resolve early via peer data.
			await expect(cheapCheck).resolves.toBe(true);
			expect(pingHandler).toHaveBeenCalledTimes(0);
			expect(fetch).toHaveBeenCalledTimes(0);

			// The abandoned data-wait timer must not start a check for the settled waiter.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + 100);
			expect(pingHandler).toHaveBeenCalledTimes(0);
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('peer data arriving in the same tick the data wait expires leaves no zombie ping', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			// Fresh peer data makes peers reachable, so the full data wait applies.
			monitor.updateLastKnownConnectionTime();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);

			// The data wait is about to expire; peer data lands in the same tick as the
			// timer. The waiter settles via the data, so no ping or fetch may start.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs - 1);
			monitor.updateLastKnownConnectionTime();
			await vi.advanceTimersByTimeAsync(1);

			await expect(cheapCheck).resolves.toBe(true);
			expect(pingHandler).toHaveBeenCalledTimes(0);
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('peer data after a failed check reports the offline-to-online transition only once the reachability grace passes', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);

			// No ping handler: the fetch fails and the status becomes offline.
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(callback).toHaveBeenLastCalledWith(null, false);

			// Peer data resolves the next waiter, but inside the reachability grace
			// period it must not report the transition: the data may be stale, and the
			// next check would immediately contradict a recovery report.
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();
			await expect(check2).resolves.toBe(true);
			expect(callback).toHaveBeenLastCalledWith(null, false);
			expect((monitor as any)._lastReportedStatus).toBe(false);

			// Once the grace has passed, peer data proves recovery and reports the
			// offline-to-online transition.
			await vi.advanceTimersByTimeAsync(DEFAULT_peersReachableGraceMs + 1);
			monitor.updateLastKnownConnectionTime();// Grace passed: peers become reachable.
			expect(monitor.arePeersReachable()).toBe(true);
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS + 1);
			const check3 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();
			await expect(check3).resolves.toBe(true);
			expect(callback).toHaveBeenLastCalledWith(false, true);
			await monitor.stop();
		});

		test('peer data inside the reachability grace period does not report offline-to-online; only data after the grace does', async () => {
			// Regression test: the waiter report path in waitForInternetCheapAsync
			// must respect the reachability grace like updateLastKnownConnectionTime
			// does. Peer data arriving while peers are known unreachable (delayed
			// packets around an outage, or nodes reconnecting slowly after one) must
			// not flip the reported status online, or the dashboard would show a false
			// recovery blip that the next check contradicts. Penalties were always
			// gated separately via _peersReachable; this fixes the report itself.
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);

			// The failed fetch reports offline and marks peers unreachable.
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(callback).toHaveBeenLastCalledWith(null, false);
			expect(monitor.arePeersReachable()).toBe(false);

			// Peer data lands inside the grace period: peers must stay unreachable
			// and the waiter must not report the offline-to-online transition.
			await vi.advanceTimersByTimeAsync(1000);
			expect(monitor.getTimeSincePeersWereUnreachableMs()).toBeLessThan(DEFAULT_peersReachableGraceMs);
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();
			await expect(check2).resolves.toBe(true);
			expect(monitor.arePeersReachable()).toBe(false);
			expect(callback).toHaveBeenLastCalledWith(null, false);
			expect((monitor as any)._lastReportedStatus).toBe(false);

			// A later offline fetch report is a no-op status-wise: no false
			// recovery blip ever happened.
			await monitor.connectedToInternetExpensiveAsync(new AbortController().signal);
			expect(callback).toHaveBeenLastCalledWith(false, false);
			expect(monitor.arePeersReachable()).toBe(false);

			// Fresh data after the grace period proves peers reachable again, and
			// the next peer-data verdict reports the transition.
			await vi.advanceTimersByTimeAsync(DEFAULT_peersReachableGraceMs + 1);
			monitor.updateLastKnownConnectionTime();
			expect(monitor.arePeersReachable()).toBe(true);
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS + 1);
			const check3 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();
			await expect(check3).resolves.toBe(true);
			expect(callback).toHaveBeenLastCalledWith(false, true);
			await monitor.stop();
		});

		test('a successful ping after a failed check reports the offline-to-online transition', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			const pingHandler = vi.fn().mockResolvedValue(false);
			monitor.setPingHandler(pingHandler as any);

			// The ping fails and so does the fetch: the status becomes offline.
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(callback).toHaveBeenLastCalledWith(null, false);

			// The failed ping arms the cooldown; wait it out before pings resume.
			await vi.advanceTimersByTimeAsync(DEFAULT_pingCooldownMs);

			// Pings succeed again: the next waiter reports the transition back online.
			pingHandler.mockResolvedValue(true);
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check2).resolves.toBe(true);
			expect(callback).toHaveBeenLastCalledWith(false, true);
			expect(fetch).toHaveBeenCalledTimes(3);// Still only the first check's fetch.
			await monitor.stop();
		});

		test('peer data fills the status silently; data alone never reports', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);

			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();
			await expect(check1).resolves.toBe(true);
			// Peer data alone never reports: it silently fills in the unknown status so a
			// later check report compares against an accurate previous status.
			expect(callback).toHaveBeenCalledTimes(0);
			expect((monitor as any)._lastReportedStatus).toBe(true);

			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			// A same-tick update is not fresh evidence under the INCOMING_DATA_THRESHOLD_MS
			// rule (it is indistinguishable from pre-registration data), so advance the
			// clock past the threshold before reporting the new peer data.
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS);
			monitor.updateLastKnownConnectionTime();
			await expect(check2).resolves.toBe(true);
			expect(callback).toHaveBeenCalledTimes(0);// Already silently online: no report.
			await monitor.stop();
		});

		test('aborting one waiter does not abort the shared ping', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			let resolvePing: ((value: boolean) => void) | null = null;
			const pingHandler = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolvePing = resolve; }));
			monitor.setPingHandler(pingHandler as any);

			const waiter1AbortController = new AbortController();
			const waiter1 = monitor.waitForInternetCheapAsync(waiter1AbortController.signal);
			const waiter2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);

			// Waiter 1 is cancelled mid-ping; the shared ping must survive for waiter 2.
			waiter1AbortController.abort();
			await expect(waiter1).rejects.toThrow();

			resolvePing!(true);
			await vi.advanceTimersByTimeAsync(0);
			await expect(waiter2).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('the safety net settles a waiter while the ping is hung, and the abandoned check leaves no zombies', async () => {
			const monitor = new ConnectionMonitor({ timeoutMs: 1000 });
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				}));
			let resolvePing: ((value: boolean) => void) | null = null;
			const pingHandler = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolvePing = resolve; }));
			monitor.setPingHandler(pingHandler as any);

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Ping in flight.

			// The safety net fires at the disconnect threshold (dataWait + 3 * timeoutMs
			// + margin = 24000 with timeoutMs 1000) even though the ping never settles,
			// so the waiter cannot hang forever. No fetch has started because
			// the waiter is still awaiting the ping.
			await vi.advanceTimersByTimeAsync(monitor.getDisconnectThresholdMs() - DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(false);
			expect(fetch).toHaveBeenCalledTimes(0);
			expect((monitor as any)._pingQueue).not.toBeNull();

			// The hung ping settles later; the shared queue clears itself.
			resolvePing!(false);
			await vi.advanceTimersByTimeAsync(0);
			expect((monitor as any)._pingQueue).toBeNull();

			// The waiter's abandoned continuation runs one bounded fetch whose verdict nobody
			// consumes; it times out and clears the queue instead of hanging around.
			await vi.advanceTimersByTimeAsync(1000);
			expect((monitor as any)._fetchCheckQueue).toBeNull();
			await monitor.stop();
		});

		test('the disconnect threshold includes the unreachable fetch throttle window, so the safety net never truncates the natural verdict chain', async () => {
			// Regression test: getDisconnectThresholdMs() is the worst-case bound for
			// a waitForInternetCheapAsync() verdict, and the natural verdict chain can
			// include the unreachable fetch throttle window between the ping and the
			// fetch. The threshold must cover the whole chain: in the transitional
			// state (a waiter registered while peers were reachable, a mass disconnect
			// during its data wait, and a fetch completed recently) the chain is data
			// wait + ping timeout + throttle window + fetch timeout, and the safety
			// net would otherwise answer false mid-chain.
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			// A real fetch only fails when its timeout aborts it.
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				}));
			const pingHandler = vi.fn().mockImplementation((timeoutMs: number, signal: AbortSignal) =>
				abortableSleepMsThrow(timeoutMs, signal).then(() => false)
			);
			monitor.setPingHandler(pingHandler as any);

			// The waiter registers while peers are reachable, so it picks the full 20s
			// data wait.
			(monitor as any)._peersReachable = true;

			let settledAtMs: number | null = null;
			const check = monitor.waitForInternetCheapAsync(new AbortController().signal).then((verdict) => {
				settledAtMs = performance.now();
				return verdict;
			});

			// The data wait elapses at t=20000: the ping starts and takes the full 10s.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			expect((monitor as any)._pingQueue).not.toBeNull();

			// Mid-ping the host marks a mass disconnect and a fetch completed just now:
			// when the ping fails, the throttle gate will block the fallback fetch.
			await vi.advanceTimersByTimeAsync(5000);
			monitor.markMassDisconnect();
			(monitor as any)._lastFetchTimeMs = performance.now();

			// The ping fails at t=30000: the fetch check hits the throttle gate and
			// schedules the shared future fetch for t=35000 instead of running one now.
			await vi.advanceTimersByTimeAsync(5000);
			expect((monitor as any)._throttledFetchQueue).not.toBeNull();
			expect(fetch).toHaveBeenCalledTimes(0);

			// The throttle window expires: the real fetch starts at t=35000.
			await vi.advanceTimersByTimeAsync(5000);
			expect(fetch).toHaveBeenCalledTimes(3);

			// The natural chain settles at t=45000 (data wait + ping timeout + throttle
			// delay + fetch timeout), inside the threshold: the safety net must not
			// have fired first, and the verdict is the chain's, not a truncated false.
			await vi.advanceTimersByTimeAsync(DEFAULT_timeoutMs);
			await expect(check).resolves.toBe(false);
			expect(settledAtMs).toBe(DEFAULT_dataWaitMs + DEFAULT_timeoutMs + 5000 + DEFAULT_timeoutMs);
			expect((monitor as any)._fetchCheckQueue).toBeNull();// The chain completed on its own.

			// The mathematical crux: the threshold covers the full chain including the
			// throttle window (dataWait + 3 * timeout + margin), so a verdict never
			// gets truncated by the safety net.
			expect(monitor.getDisconnectThresholdMs()).toBe(DEFAULT_dataWaitMs + 3 * DEFAULT_timeoutMs + DEFAULT_verdictSafetyNetMarginMs);
			expect(DEFAULT_dataWaitMs + 2 * DEFAULT_timeoutMs + DEFAULT_unreachableFetchThrottleMs).toBeLessThan(monitor.getDisconnectThresholdMs());
			await monitor.stop();
		});

		test('one updateLastKnownConnectionTime() resolves every registered waiter and empties the resolver list', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapChecks = [0, 1, 2].map(() => monitor.waitForInternetCheapAsync(new AbortController().signal));
			expect((monitor as any)._updateResolvers.length).toBe(3);

			// Fresh data arriving past the threshold resolves all three waiters at once.
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS);
			monitor.updateLastKnownConnectionTime();

			await expect(Promise.all(cheapChecks)).resolves.toEqual([true, true, true]);
			expect((monitor as any)._updateResolvers.length).toBe(0);
			expect(fetch).toHaveBeenCalledTimes(0);
			expect(pingHandler).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('peer data inside INCOMING_DATA_THRESHOLD_MS of registration is not fresh evidence; past it is', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			// Baseline data so the freshness rule compares against a real last-known time.
			monitor.updateLastKnownConnectionTime();

			// Data landing inside the threshold window after registration is not fresh evidence,
			// so the waiter stays in its data wait and then runs its own check.
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS / 2);
			monitor.updateLastKnownConnectionTime();
			await vi.advanceTimersByTimeAsync(0);
			expect(pingHandler).toHaveBeenCalledTimes(0);// Still waiting, not resolved.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(check1).resolves.toBe(true);

			// Data landing past the threshold window after registration is fresh evidence.
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS * 1.5);
			monitor.updateLastKnownConnectionTime();
			await expect(check2).resolves.toBe(true);
			expect(pingHandler).toHaveBeenCalledTimes(1);// No second ping.
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('a fetch aborted by the monitor signal records no check result', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			// Fresh peer data makes peers reachable, so the full data wait applies and
			// the fetch starts when the test advances DEFAULT_dataWaitMs.
			monitor.updateLastKnownConnectionTime();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			// A real fetch only fails when its timeout or signal aborts it.
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				}));

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Fetch in flight.
			expect((monitor as any)._fetchCheckQueue).not.toBeNull();

			abortController.abort();// The monitor-level signal aborts the fetch mid-flight.

			await expect(check).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(0);
			// An aborted check records and reports nothing: the callback never fires
			// and the status stays at the silent value the earlier peer data set.
			expect((monitor as any)._fetchCheckQueue).toBeNull();
			expect(callback).toHaveBeenCalledTimes(0);
			expect((monitor as any)._lastReportedStatus).toBe(true);
			expect((monitor as any)._lastFetchTimeMs).toBeLessThan(0);// Still the INIT sentinel.
			await monitor.stop();
		});

		test('a waiter whose wait expires while a fetch is in flight shares that fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			let resolveFetch: ((value?: unknown) => void) | null = null;
			(fetch as any).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

			// A's wait expires first and starts a fetch.
			const cheapCheckA = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);

			// B registers while A's fetch is in flight and its own wait expires before it
			// settles. There was no fetch completion during B's wait, so B shares the
			// in-flight fetch instead of starting another one.
			const cheapCheckB = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);

			resolveFetch!();
			await expect(Promise.all([cheapCheckA, cheapCheckB])).resolves.toEqual([true, true]);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('a mixed fetch outcome (one URL fails, another succeeds) reports connected', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockImplementation((url: string) => {
				if (url.includes('cloudflare')) {
					return Promise.reject(new Error('Network error'));
				}
				return Promise.resolve({ ok: true } as Response);
			});

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			await expect(cheapCheck).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('should throw if aborted', async () => {
			const monitor = new ConnectionMonitor();
			const startAbortController = new AbortController();
			await monitor.start(startAbortController.signal);
			(fetch as any).mockClear();

			const abortController = new AbortController();
			const cheapCheck = monitor.waitForInternetCheapAsync(abortController.signal);

			abortController.abort();

			await expect(cheapCheck).rejects.toThrow();
			await monitor.stop();
		});

		test('should throw if the monitor has not been started', async () => {
			const monitor = new ConnectionMonitor();
			await expect(monitor.waitForInternetCheapAsync(new AbortController().signal)).rejects.toThrow('Not started');
		});
	});

	describe('peer reachability', () => {
		test('arePeersReachable treats an unknown start as reachable; a mass disconnect proves unreachable; fresh data makes it reachable again', () => {
			const monitor = new ConnectionMonitor();
			// No evidence yet: the assumed-online baseline counts as reachable, so a
			// cold start does not silently exempt failures from penalties.
			expect(monitor.arePeersReachable()).toBe(true);
			monitor.markMassDisconnect();
			expect(monitor.arePeersReachable()).toBe(false);
			// Fresh data inside the grace period does not reopen reachability...
			monitor.updateLastKnownConnectionTime();
			expect(monitor.arePeersReachable()).toBe(false);
			// ...data after the grace proves it again.
			vi.advanceTimersByTime(DEFAULT_peersReachableGraceMs + 1);
			monitor.updateLastKnownConnectionTime();
			expect(monitor.arePeersReachable()).toBe(true);
		});

		test('fresh data within the grace period does not mark peers reachable; data after the grace does', () => {
			const monitor = new ConnectionMonitor();
			monitor.markMassDisconnect();
			expect(monitor.arePeersReachable()).toBe(false);

			// Stale or slow data arriving inside the grace period must not reopen penalties.
			vi.advanceTimersByTime(DEFAULT_peersReachableGraceMs - 1000);
			monitor.updateLastKnownConnectionTime();
			expect(monitor.arePeersReachable()).toBe(false);

			// Fresh data after the grace period proves peers are reachable again.
			vi.advanceTimersByTime(1000);
			monitor.updateLastKnownConnectionTime();
			expect(monitor.arePeersReachable()).toBe(true);
		});

		test('a failed fetch check marks peers unreachable', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(false);
			expect(monitor.arePeersReachable()).toBe(false);
			await monitor.stop();
		});

		test('a successful fetch check does not mark peers reachable', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check).resolves.toBe(true);
			// HTTP works again, but the peer network may still be blocked, so peers
			// stay unreachable until fresh data arrives.
			expect(monitor.arePeersReachable()).toBe(false);
			await monitor.stop();
		});

		test('a successful fetch check refreshes the data timer and recent-data skip without marking peers reachable', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();
			expect(monitor.shouldSkipForRecentData()).toBe(false);

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check).resolves.toBe(true);

			// The fetch refreshed the data timer, so scheduled pings see recent data...
			expect(monitor.shouldSkipForRecentData()).toBe(true);
			// ...but peers stay unreachable, because a fetch is not peer evidence.
			expect(monitor.arePeersReachable()).toBe(false);
			await monitor.stop();
		});

		test('a waiter registered before a shared fetch completes settles at fetch completion without data', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			let resolveFetch: ((value?: unknown) => void) | null = null;
			(fetch as any).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

			// The first check starts the shared fetch (peers start unreachable).
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			expect((monitor as any)._fetchCheckQueue).not.toBeNull();

			// A second waiter registers while the fetch is in flight. It has not yet
			// passed its own data wait, so it is still pending.
			let settled2: boolean | null = null;
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal).then((result) => {
				settled2 = result;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(settled2).toBeNull();

			// The fetch completes successfully and resolves the second waiter
			// immediately, before its own data wait would have expired.
			resolveFetch!();
			await vi.advanceTimersByTimeAsync(0);
			expect(settled2).toBe(true);
			await expect(check1).resolves.toBe(true);
			await expect(check2).resolves.toBeUndefined();
			await monitor.stop();
		});

		test('a fresh start after dispose is not throttled by the previous session fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();

			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(fetch).toHaveBeenCalledTimes(3);

			await monitor.stop();
			(fetch as any).mockClear();
			const restartAbortController = new AbortController();
			await monitor.start(restartAbortController.signal);

			// The previous session's fetch must not throttle the first check here.
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check2).resolves.toBe(false);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('stop() resets peers to unknown (treated as reachable)', async () => {
			const monitor = new ConnectionMonitor();
			monitor.updateLastKnownConnectionTime();
			expect(monitor.arePeersReachable()).toBe(true);
			await monitor.stop();
			// A restart starts with no evidence, so the assumed-online baseline applies
			// again until fresh data or an unreachable report resolves the state.
			expect(monitor.arePeersReachable()).toBe(true);
		});

		test('getTimeSincePeersWereUnreachableMs starts huge and resets on markMassDisconnect', () => {
			const monitor = new ConnectionMonitor();
			expect(monitor.getTimeSincePeersWereUnreachableMs()).toBeGreaterThan(DEFAULT_peersReachableGraceMs);
			monitor.markMassDisconnect();
			vi.advanceTimersByTime(5000);
			expect(monitor.getTimeSincePeersWereUnreachableMs()).toBe(5000);
		});

		test('while peers are unreachable, a waiter waits only the short data wait and then fetches', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();
			(fetch as any).mockClear();

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);

			// Well before the full data wait, nothing has happened yet...
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs - 1);
			expect(fetch).toHaveBeenCalledTimes(0);

			// ...but after the short unreachable wait, the fetch runs and fails fast.
			await vi.advanceTimersByTimeAsync(1);
			await expect(cheapCheck).resolves.toBe(false);
			expect(fetch).toHaveBeenCalledTimes(3);
			await monitor.stop();
		});

		test('while peers are unreachable, fetch checks are throttled by sharing a single scheduled future fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();
			(fetch as any).mockClear();

			// The first check fetches and reports offline.
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(fetch).toHaveBeenCalledTimes(3);

			// A second check inside the throttle window shares a scheduled future
			// fetch. It must not settle from the past verdict, so it stays pending
			// until the window expires and the shared fetch runs.
			await vi.advanceTimersByTimeAsync(1000);
			let settled2: boolean | null = null;
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal).then((result) => {
				settled2 = result;
			});
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			expect(settled2).toBeNull();// Still awaiting the future fetch, not reusing the past verdict.
			expect(fetch).toHaveBeenCalledTimes(3);

			// When the window expires, the shared future fetch runs and resolves the waiter.
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableFetchThrottleMs);
			expect(fetch).toHaveBeenCalledTimes(6);
			expect(settled2).toBe(false);
			await expect(check2).resolves.toBeUndefined();
			await monitor.stop();
		});

		test('the unreachable fetch throttle window tracks the configured timeout', async () => {
			// Regression test: the throttle gate (_runFetchCheck) and the scheduled
			// future fetch (_getOrCreateThrottledFetch) use the configured _timeoutMs.
			// A fetch takes up to the timeout to settle, so the window must be at
			// least that long or waiters would schedule a new fetch on top of a
			// settled one; with a 30s timeout the window is 30s, not the 10s default
			// constant.
			const monitor = new ConnectionMonitor({ timeoutMs: 30000 });
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();
			// A fetch completed just now, so the throttle window is active.
			(monitor as any)._lastFetchTimeMs = performance.now();
			const completionTimeMs: number = (monitor as any)._lastFetchTimeMs;
			const fetchStartTimes: number[] = [];
			// A real fetch only fails when its 30s timeout aborts it.
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) => {
				fetchStartTimes.push(performance.now());
				return new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				});
			});

			// The waiter's short unreachable data wait elapses 2s after the
			// completion, inside the window: it schedules the shared future fetch.
			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(0);
			expect((monitor as any)._throttledFetchQueue).not.toBeNull();

			// The window expires 30s after the completion (the configured timeout):
			// the real fetch starts at +30s, not at the 10s default.
			await vi.advanceTimersByTimeAsync(30000 - DEFAULT_unreachableDataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(fetchStartTimes.every((startTimeMs) => startTimeMs - completionTimeMs === 30000)).toBe(true);

			// The fetch settles on its 30s timeout and the waiter gets its verdict.
			await vi.advanceTimersByTimeAsync(30000);
			await expect(cheapCheck).resolves.toBe(false);
			await monitor.stop();
		});

		test('fetches stay serialized during an outage even while one fetch is still settling when the window expires', async () => {
			// Fetches are serialized because _runFetchCheck deduplicates against the
			// in-flight _fetchCheckQueue BEFORE the throttle gate, and the queue is
			// only cleared after the fetch completes: a waiter hitting the check
			// while a fetch is in flight shares it instead of starting a new one.
			// This test pins the serialization, so no two fetches ever overlap.
			const monitor = new ConnectionMonitor({ timeoutMs: 30000 });
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();
			(monitor as any)._lastFetchTimeMs = performance.now();
			const fetchStartTimes: number[] = [];
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) => {
				fetchStartTimes.push(performance.now());
				return new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				});
			});

			// Waiter 1's data wait expires inside the window: shared future fetch.
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			expect((monitor as any)._throttledFetchQueue).not.toBeNull();

			// The window expires 30s after the completion: the shared future fetch runs.
			await vi.advanceTimersByTimeAsync(30000 - DEFAULT_unreachableDataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);
			const firstFetchStartTimeMs = fetchStartTimes[0];

			// Waiter 2 registers while the fetch is in flight; its wait expires 2s
			// later. The throttle gate would pass, but the dedup check runs first and
			// shares the in-flight fetch: no second fetch starts, even though each
			// fetch takes 30s to settle.
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);

			// The in-flight fetch settles on its 30s timeout; both waiters get its
			// verdict, and the total is still one fetch check, not two.
			await vi.advanceTimersByTimeAsync(30000 - DEFAULT_unreachableDataWaitMs);
			await expect(check1).resolves.toBe(false);
			await expect(check2).resolves.toBe(false);
			expect(fetchStartTimes.length).toBe(3);
			expect(fetchStartTimes.every((startTimeMs) => startTimeMs === firstFetchStartTimeMs)).toBe(true);
			await monitor.stop();
		});

		test('dispose() cancels the throttled fetch schedule and settles pending waiters immediately', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			monitor.markMassDisconnect();
			(fetch as any).mockClear();

			// The first check fetches offline, which opens the throttle window.
			const check1 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(fetch).toHaveBeenCalledTimes(3);

			// A second check schedules the future fetch.
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs);
			expect((monitor as any)._throttledFetchQueue).not.toBeNull();

			// Shutdown settles the waiter immediately and cancels the schedule.
			await monitor.stop();
			await expect(check2).resolves.toBe(false);

			// No fetch fires after shutdown, even past the would-be window expiry.
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableFetchThrottleMs * 2);
			expect(fetch).toHaveBeenCalledTimes(3);
		});

		test('while peers are unreachable, peer data inside the short wait resolves without fetching', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();

			// A healthy cold start begins with peers unreachable, but the first
			// handshake data arrives inside the short wait, so no fetch is needed.
			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_unreachableDataWaitMs - 1000);
			monitor.updateLastKnownConnectionTime();

			await expect(cheapCheck).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});
	});

	describe('lifecycle', () => {
		test('stop() then start() resets the check classification', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			const callback = vi.fn();

			await monitor.start(abortController.signal);
			monitor.setOnCheckResult(callback);
			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(true);
			expect(callback).toHaveBeenCalledWith(null, true);

			await monitor.stop();
			// stop() clears the callback and ping handler, so the host must re-register them.
			monitor.setOnCheckResult(callback);

			const restartAbortController = new AbortController();
			await monitor.start(restartAbortController.signal);
			// After the restart, the first check is classified fresh: prev is null again.
			const check2 = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check2).resolves.toBe(true);
			expect(callback).toHaveBeenLastCalledWith(null, true);

			await monitor.stop();
		});

		test('start() while already started awaits the in-flight fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			let resolveFetch: ((value?: unknown) => void) | null = null;
			(fetch as any).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
			await monitor.start(abortController.signal);

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Fetch in flight.
			expect((monitor as any)._fetchCheckQueue).not.toBeNull();

			let restarted = false;
			const restartPromise = monitor.start(new AbortController().signal).then(() => {
				restarted = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(restarted).toBe(false);// start() is still awaiting the in-flight fetch.

			resolveFetch!();
			await vi.advanceTimersByTimeAsync(0);
			expect(restarted).toBe(true);
			await restartPromise;
			await expect(check).resolves.toBe(true);

			await monitor.stop();
		});

		test('start() while already started awaits an in-flight ping too', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			let resolvePing: ((value: boolean) => void) | null = null;
			const pingHandler = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolvePing = resolve; }));
			monitor.setPingHandler(pingHandler as any);

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Ping in flight.
			expect((monitor as any)._pingQueue).not.toBeNull();

			let restarted = false;
			const restartPromise = monitor.start(new AbortController().signal).then(() => {
				restarted = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(restarted).toBe(false);// start() is still awaiting the in-flight ping.

			resolvePing!(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(restarted).toBe(true);
			await restartPromise;
			await expect(check).resolves.toBe(true);

			await monitor.stop();
		});

		test('stop() does not hang while a waiter is mid-data-wait and no checks run after the host aborts', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			// The waiter is still in its data wait when the host stops.
			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await monitor.stop();// Must not wait for the pending data-wait waiter.

			// The host contract (BlockHeadersClient.stop) aborts the monitor signal,
			// which settles the waiter without ever probing.
			abortController.abort();
			await expect(cheapCheck).rejects.toThrow();

			// No zombie check may run after stop().
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + 100);
			expect(pingHandler).toHaveBeenCalledTimes(0);
			expect(fetch).toHaveBeenCalledTimes(0);
		});

		test('stop() awaits an in-flight fetch and the waiter settles from it', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			let resolveFetch: ((value?: unknown) => void) | null = null;
			(fetch as any).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Fetch in flight.
			expect((monitor as any)._fetchCheckQueue).not.toBeNull();

			let stopped = false;
			const stopPromise = monitor.stop().then(() => { stopped = true; });
			await vi.advanceTimersByTimeAsync(0);
			expect(stopped).toBe(false);// stop() awaits the in-flight fetch.

			resolveFetch!();
			await vi.advanceTimersByTimeAsync(0);
			expect(stopped).toBe(true);
			await stopPromise;
			await expect(check).resolves.toBe(true);
			expect(fetch).toHaveBeenCalledTimes(3);

			// A second stop() is a no-op: the queues were already drained.
			await monitor.stop();
		});

		test('a waiter falling through after a failed ping during stop() starts no zombie fetch', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			let resolvePing: ((value: boolean) => void) | null = null;
			const pingHandler = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { resolvePing = resolve; }));
			monitor.setPingHandler(pingHandler as any);

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Ping in flight.
			expect((monitor as any)._pingQueue).not.toBeNull();

			const stopPromise = monitor.stop();// Disposes while the ping is in flight.
			await vi.advanceTimersByTimeAsync(0);

			// The ping fails after dispose has begun. The waiter's _pingOrFetch() resumes with
			// _started === false, so its fall-through cannot start a fetch behind dispose's back.
			resolvePing!(false);

			await expect(check).resolves.toBe(false);
			await stopPromise;
			expect(fetch).toHaveBeenCalledTimes(0);
			expect((monitor as any)._fetchCheckQueue).toBeNull();
			await monitor.stop();
		});

		test('a fresh start() resets the ping cooldown armed by a previous failed ping', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockRejectedValue(new Error('Network error'));
			const pingHandler = vi.fn().mockResolvedValue(false);
			monitor.setPingHandler(pingHandler as any);

			const firstCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);// The failed ping arms the cooldown.
			await expect(firstCheck).resolves.toBe(false);

			await monitor.stop();
			// stop() cleared the handlers; the host re-registers them on the next start.
			monitor.setPingHandler(pingHandler);
			const restartAbortController = new AbortController();
			await monitor.start(restartAbortController.signal);

			// The stale cooldown from the previous session is reset, so the first waiter pings.
			const secondCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(2);
			await expect(secondCheck).resolves.toBe(false);
			await monitor.stop();
		});

		test('start() with an already-aborted signal rejects waiters without ever fetching', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			abortController.abort();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();

			await expect(monitor.waitForInternetCheapAsync(new AbortController().signal)).rejects.toThrow();
			expect(fetch).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});
	});

	describe('connectedToInternetExpensiveAsync', () => {
		test('should resolve true on successful fetch', async () => {
			const monitor = new ConnectionMonitor();

			await expect(monitor.connectedToInternetExpensiveAsync(new AbortController().signal)).resolves.toBe(true);
		});

		test('should resolve false on failed fetch', async () => {
			const monitor = new ConnectionMonitor();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await expect(monitor.connectedToInternetExpensiveAsync(new AbortController().signal)).resolves.toBe(false);
		});

		test('a successful check reports through the check-result callback', async () => {
			const monitor = new ConnectionMonitor();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			await monitor.start(new AbortController().signal);

			await expect(monitor.connectedToInternetExpensiveAsync(new AbortController().signal)).resolves.toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(null, true);
			await monitor.stop();
		});

		test('a failed check reports offline through the check-result callback', async () => {
			const monitor = new ConnectionMonitor();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			await monitor.start(new AbortController().signal);

			await expect(monitor.connectedToInternetExpensiveAsync(new AbortController().signal)).resolves.toBe(false);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(null, false);
			await monitor.stop();
		});

		test('an abort mid-flight cancels the in-flight fetch and settles false', async () => {
			const monitor = new ConnectionMonitor();
			// A real fetch only fails when its timeout aborts it.
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				}));
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			const abortController = new AbortController();
			const check = monitor.connectedToInternetExpensiveAsync(abortController.signal);
			abortController.abort();
			await expect(check).resolves.toBe(false);
			// An aborted check records and reports nothing.
			expect(callback).toHaveBeenCalledTimes(0);
		});
	});

	describe('setOnCheckResult', () => {
		test('fires when a waiter-driven fetch check runs', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			await monitor.start(abortController.signal);

			expect(callback).toHaveBeenCalledTimes(0);
			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(null, true);
			await monitor.stop();
		});

		test('fires when the check fails', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			await monitor.start(abortController.signal);

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(false);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(null, false);
			await monitor.stop();
		});

		test('peer data fills in an unknown status silently; the callback is not called', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			const callback = vi.fn();
			await monitor.start(abortController.signal);
			monitor.setOnCheckResult(callback);

			// The grace has passed since INIT, so the first peer data fills in the
			// reported status as a silent initial value without reporting anything.
			monitor.updateLastKnownConnectionTime();
			expect(callback).not.toHaveBeenCalled();
			expect((monitor as any)._lastReportedStatus).toBe(true);

			// A false status from an offline report is never overwritten silently:
			// data must not steal the recovery transition event from the next check.
			(fetch as any).mockRejectedValue(new Error('Network error'));
			const failingCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(failingCheck).resolves.toBe(false);
			expect(callback).toHaveBeenLastCalledWith(true, false);
			expect((monitor as any)._lastReportedStatus).toBe(false);
			monitor.updateLastKnownConnectionTime();// Data arrives after the offline report.
			expect(callback).toHaveBeenCalledTimes(1);// No silent flip, no extra report.
			expect((monitor as any)._lastReportedStatus).toBe(false);

			await monitor.stop();
		});

		test('a fetch after peer data reports with the previous status set by the data', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			const callback = vi.fn();
			await monitor.start(abortController.signal);
			monitor.setOnCheckResult(callback);
			// Fresh peer data makes peers reachable and silently fills in the status.
			monitor.updateLastKnownConnectionTime();

			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(true, true);
			await monitor.stop();
		});

		test('null clears the callback', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			await monitor.start(abortController.signal);

			monitor.setOnCheckResult(null);
			const check = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(true);
			expect(callback).toHaveBeenCalledTimes(0);
			await monitor.stop();
		});

		test('a throwing callback does not reject the check or its waiters', async () => {
			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			const throwingCallback = vi.fn(() => { throw new Error('host bug'); });
			monitor.setOnCheckResult(throwingCallback);

			const cheapCheck = monitor.waitForInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);

			await expect(cheapCheck).resolves.toBe(true);
			expect(throwingCallback).toHaveBeenCalledTimes(1);
			expect((monitor as any)._fetchCheckQueue).toBeNull();
			await monitor.stop();
			consoleErrorSpy.mockRestore();
		});
	});

	describe('getPingIntervalMs', () => {
		test('default is half the skip window derived from DEFAULT_intervalMs and DEFAULT_timeoutMs', () => {
			const monitor = new ConnectionMonitor();
			const expected = Math.floor((DEFAULT_intervalMs - DEFAULT_timeoutMs) * 0.9 / 2);
			expect(monitor.getPingIntervalMs()).toBe(expected);
		});

		test('honors an explicitly provided pingIntervalMs', () => {
			const monitor = new ConnectionMonitor({ pingIntervalMs: 25000 });
			expect(monitor.getPingIntervalMs()).toBe(25000);
		});

		test('derives the default from a custom intervalMs/timeoutMs config', () => {
			// Custom config: intervalMs=40000, timeoutMs=10000 -> skip window = (40-10)*0.9 = 27s
			// -> derived default ping interval = floor(27000 / 2) = 13500ms.
			const monitor = new ConnectionMonitor({ intervalMs: 40000, timeoutMs: 10000 });
			expect(monitor.getPingIntervalMs()).toBe(13500);
		});

		test('throws on non-positive pingIntervalMs', () => {
			expect(() => new ConnectionMonitor({ pingIntervalMs: 0 })).toThrow();
			expect(() => new ConnectionMonitor({ pingIntervalMs: -1 })).toThrow();
		});
	});

	describe('shouldSkipForRecentData', () => {
		test('returns false before any updateLastKnownConnectionTime() call (lastKnown is INIT_lastKnownConnectionTimeMs)', () => {
			const monitor = new ConnectionMonitor();
			// No updateLastKnownConnectionTime() yet; time since last known is huge -> not recent.
			expect(monitor.shouldSkipForRecentData()).toBe(false);
		});

		test('returns true immediately after updateLastKnownConnectionTime()', () => {
			const monitor = new ConnectionMonitor();
			monitor.updateLastKnownConnectionTime();
			expect(monitor.shouldSkipForRecentData()).toBe(true);
		});

		test('returns false once the skip window has elapsed since the last update', () => {
			const monitor = new ConnectionMonitor({ intervalMs: 60000, timeoutMs: 10000 });
			// skip window = (60000 - 10000) * 0.9 = 45000ms
			monitor.updateLastKnownConnectionTime();
			expect(monitor.shouldSkipForRecentData()).toBe(true);
			vi.advanceTimersByTime(45000);
			expect(monitor.shouldSkipForRecentData()).toBe(false);
		});
	});
});
