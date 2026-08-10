/// <reference types="node" />
import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionMonitor, DEFAULT_timeoutMs, DEFAULT_intervalMs, DEFAULT_dataWaitMs, DEFAULT_pingCooldownMs, INCOMING_DATA_THRESHOLD_MS } from '../src/ConnectionMonitor.js';
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

		const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

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

	describe('connectedToInternetCheapAsync', () => {
		test('resolves true from peer data arriving during the wait, without pinging or fetching', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

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
			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal).then((result) => {
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
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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
			const cheapCheck = monitor.connectedToInternetCheapAsync(waiterAbortController.signal);
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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const firstCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(firstCheck).resolves.toBe(false);

			// The next waiter skips the ping while the cooldown is active.
			const secondCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(secondCheck).resolves.toBe(false);

			// After the cooldown elapses, a waiter pings again.
			await vi.advanceTimersByTimeAsync(DEFAULT_pingCooldownMs);
			const thirdCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const firstCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(firstCheck).resolves.toBe(true);

			const secondCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const firstCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(firstCheck).resolves.toBe(false);

			// Nothing was pinged, so no cooldown was armed: the next waiter pings again
			// instead of falling back to the fetch.
			const secondCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const cheapChecks = [0, 1, 2].map(() => monitor.connectedToInternetCheapAsync(new AbortController().signal));
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

			const cheapChecks = [0, 1, 2].map(() => monitor.connectedToInternetCheapAsync(new AbortController().signal));
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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const cheapChecks = [0, 1, 2].map(() => monitor.connectedToInternetCheapAsync(new AbortController().signal));
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
			const cheapCheckA = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(1000);
			const cheapCheckB = monitor.connectedToInternetCheapAsync(new AbortController().signal);

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

			// This boundary cannot arise from real monitor flows (fetches are serialized
			// and at least a data wait apart), so drive the internals directly: a verdict
			// recorded shortly before registration...
			const recentFetchTimeMs = performance.now() - 50;
			(monitor as any)._lastFetchTimeMs = recentFetchTimeMs;
			(monitor as any)._lastReportedStatus = true;

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

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
			const cheapCheckA = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(cheapCheckA).resolves.toBe(true);
			(fetch as any).mockClear();

			// B's wait elapses with no new fetch during it, so it fetches for its own verdict.
			const cheapCheckB = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

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

		test('peer data after a failed check reports the offline-to-online transition', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);

			// No ping handler: the fetch fails and the status becomes offline.
			const check1 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(callback).toHaveBeenLastCalledWith(null, false);

			// Fresh peer data resolves the next waiter and reports the transition back online.
			const check2 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();
			await expect(check2).resolves.toBe(true);
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
			const check1 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check1).resolves.toBe(false);
			expect(callback).toHaveBeenLastCalledWith(null, false);

			// The failed ping arms the cooldown; wait it out before pings resume.
			await vi.advanceTimersByTimeAsync(DEFAULT_pingCooldownMs);

			// Pings succeed again: the next waiter reports the transition back online.
			pingHandler.mockResolvedValue(true);
			const check2 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check2).resolves.toBe(true);
			expect(callback).toHaveBeenLastCalledWith(false, true);
			expect(fetch).toHaveBeenCalledTimes(3);// Still only the first check's fetch.
			await monitor.stop();
		});

		test('peer data does not re-report when the status is already online', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);

			const check1 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			monitor.updateLastKnownConnectionTime();
			await expect(check1).resolves.toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);// First evidence reports the initial status.

			const check2 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			// A same-tick update is not fresh evidence under the INCOMING_DATA_THRESHOLD_MS
			// rule (it is indistinguishable from pre-registration data), so advance the
			// clock past the threshold before reporting the new peer data.
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS);
			monitor.updateLastKnownConnectionTime();
			await expect(check2).resolves.toBe(true);
			expect(callback).toHaveBeenCalledTimes(1);// Already online: no re-report.
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
			const waiter1 = monitor.connectedToInternetCheapAsync(waiter1AbortController.signal);
			const waiter2 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Ping in flight.

			// The safety net fires at dataWait + 2 * timeoutMs + margin = 23000 even though the
			// ping never settles, so the waiter cannot hang forever. No fetch has started because
			// the waiter is still awaiting the ping.
			await vi.advanceTimersByTimeAsync(2 * 1000 + 1000);
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

		test('one updateLastKnownConnectionTime() resolves every registered waiter and empties the resolver list', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();
			const pingHandler = vi.fn().mockResolvedValue(true);
			monitor.setPingHandler(pingHandler as any);

			const cheapChecks = [0, 1, 2].map(() => monitor.connectedToInternetCheapAsync(new AbortController().signal));
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
			const check1 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(INCOMING_DATA_THRESHOLD_MS / 2);
			monitor.updateLastKnownConnectionTime();
			await vi.advanceTimersByTimeAsync(0);
			expect(pingHandler).toHaveBeenCalledTimes(0);// Still waiting, not resolved.
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);
			await expect(check1).resolves.toBe(true);

			// Data landing past the threshold window after registration is fresh evidence.
			const check2 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			// A real fetch only fails when its timeout or signal aborts it.
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				}));

			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);// Fetch in flight.
			expect((monitor as any)._fetchCheckQueue).not.toBeNull();

			abortController.abort();// The monitor-level signal aborts the fetch mid-flight.

			await expect(check).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(0);
			// An aborted check records and reports nothing.
			expect((monitor as any)._fetchCheckQueue).toBeNull();
			expect(callback).toHaveBeenCalledTimes(0);
			expect((monitor as any)._lastReportedStatus).toBeNull();
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
			const cheapCheckA = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			expect(fetch).toHaveBeenCalledTimes(3);

			// B registers while A's fetch is in flight and its own wait expires before it
			// settles. There was no fetch completion during B's wait, so B shares the
			// in-flight fetch instead of starting another one.
			const cheapCheckB = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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
			const cheapCheck = monitor.connectedToInternetCheapAsync(abortController.signal);

			abortController.abort();

			await expect(cheapCheck).rejects.toThrow();
			await monitor.stop();
		});

		test('should throw if the monitor has not been started', async () => {
			const monitor = new ConnectionMonitor();
			await expect(monitor.connectedToInternetCheapAsync(new AbortController().signal)).rejects.toThrow('Not started');
		});
	});

	describe('lifecycle', () => {
		test('stop() then start() resets the check classification', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			const callback = vi.fn();

			await monitor.start(abortController.signal);
			monitor.setOnCheckResult(callback);
			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(true);
			expect(callback).toHaveBeenCalledWith(null, true);

			await monitor.stop();
			// stop() clears the callback and ping handler, so the host must re-register them.
			monitor.setOnCheckResult(callback);

			const restartAbortController = new AbortController();
			await monitor.start(restartAbortController.signal);
			// After the restart, the first check is classified fresh: prev is null again.
			const check2 = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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
			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const firstCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs + DEFAULT_timeoutMs);
			expect(pingHandler).toHaveBeenCalledTimes(1);// The failed ping arms the cooldown.
			await expect(firstCheck).resolves.toBe(false);

			await monitor.stop();
			// stop() cleared the handlers; the host re-registers them on the next start.
			monitor.setPingHandler(pingHandler);
			const restartAbortController = new AbortController();
			await monitor.start(restartAbortController.signal);

			// The stale cooldown from the previous session is reset, so the first waiter pings.
			const secondCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			await expect(monitor.connectedToInternetCheapAsync(new AbortController().signal)).rejects.toThrow();
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

		test('an abort mid-flight cancels the in-flight fetch and settles false', async () => {
			const monitor = new ConnectionMonitor();
			// A real fetch only fails when its timeout aborts it.
			(fetch as any).mockImplementation((_url: string, options: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener('abort', () => reject(new Error('aborted')));
				}));
			const abortController = new AbortController();
			const check = monitor.connectedToInternetExpensiveAsync(abortController.signal);
			abortController.abort();
			await expect(check).resolves.toBe(false);
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
			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
			await vi.advanceTimersByTimeAsync(DEFAULT_dataWaitMs);
			await expect(check).resolves.toBe(false);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(null, false);
			await monitor.stop();
		});

		test('null clears the callback', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			const callback = vi.fn();
			monitor.setOnCheckResult(callback);
			await monitor.start(abortController.signal);

			monitor.setOnCheckResult(null);
			const check = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);
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
