/// <reference types="node" />
import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionMonitor, DEFAULT_timeoutMs, DEFAULT_intervalMs } from '../src/ConnectionMonitor.js';

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

	test('start should not call _intervalFunction immediately; first fetch is at the first tick', async () => {
		const monitor = new ConnectionMonitor();
		const abortController = new AbortController();
		(fetch as any).mockResolvedValue({ ok: true });

		await monitor.start(abortController.signal);
		// No fetch fires synchronously during start().
		expect(fetch).toHaveBeenCalledTimes(0);

		// First fetch fires at the first interval tick (DEFAULT_intervalMs).
		await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
		expect(fetch).toHaveBeenCalledTimes(3);

		await monitor.stop();
	});

	test('interval function should check connection', async () => {
		// pingIntervalMs is explicit here because intervalMs === timeoutMs would make the
		// derived default (skip window / 2) zero. This test is about fallback-check cadence,
		// not pings, so any positive pingIntervalMs that satisfies the invariant is fine.
		const monitor = new ConnectionMonitor({ intervalMs: 10000, pingIntervalMs: 1000 });
		const abortController = new AbortController();
		(fetch as any).mockResolvedValue({ ok: true });

		await monitor.start(abortController.signal);
		// start() no longer fires an immediate fetch; _lastKnownConnectionTimeMs is still INIT
		// so the first tick will not skip.
		expect(fetch).toHaveBeenCalledTimes(0);

		await vi.advanceTimersByTimeAsync(10000);
		expect(fetch).toHaveBeenCalledTimes(3);

		await vi.advanceTimersByTimeAsync(10000);
		expect(fetch).toHaveBeenCalledTimes(6);

		await monitor.stop();
	});

	test('should update last known connection time on successful fetch', async () => {
		const monitor = new ConnectionMonitor();
		const abortController = new AbortController();

		const timeBefore = monitor.getTimeSinceLastKnownConnectionMs();
		await monitor.start(abortController.signal);
		// start() no longer fetches immediately; advance to the first tick to fire the fetch.
		await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
		const timeAfter = monitor.getTimeSinceLastKnownConnectionMs();

		expect(timeAfter).toBeLessThan(timeBefore);
		expect(timeAfter).toBeLessThan(1000);// Should be very recent.

		await monitor.stop();
	});

	test('should not update last known connection time on failed fetch', async () => {
		const monitor = new ConnectionMonitor();
		const abortController = new AbortController();
		(fetch as any).mockRejectedValue(new Error('Network error'));

		await monitor.start(abortController.signal);
		const timeBefore = monitor.getTimeSinceLastKnownConnectionMs();
		// Advance to the first tick to fire the (rejected) fetch.
		await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
		const timeAfter = monitor.getTimeSinceLastKnownConnectionMs();

		// _lastKnownConnectionTimeMs was not updated by the failed fetch; the only change
		// in timeSince is the elapsed fake-clock time (DEFAULT_intervalMs).
		expect(timeAfter - timeBefore).toBeGreaterThanOrEqual(DEFAULT_intervalMs);
		expect(timeAfter - timeBefore).toBeLessThan(DEFAULT_intervalMs + 1000);

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
		test('should resolve true if connection time is updated', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			// start() no longer initializes _lastKnownConnectionTimeMs (no immediate fetch);
			// it stays at INIT until peer data arrives via updateLastKnownConnectionTime().
			(fetch as any).mockClear();

			vi.advanceTimersByTime(1000);

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

			vi.advanceTimersByTime(500);
			monitor.updateLastKnownConnectionTime();

			await expect(cheapCheck).resolves.toBe(true);
			await monitor.stop();
		});

		test('should resolve false if timeout is reached without update', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);
			(fetch as any).mockRejectedValue(new Error('Persistent network error'));

			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal);

			const disconnectThreshold = monitor.getDisconnectThresholdMs();
			await vi.advanceTimersByTimeAsync(disconnectThreshold + 100);

			await expect(cheapCheck).resolves.toBe(false);
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

		test('a successful probe resolves a pending waiter before the disconnect threshold (internet up, no peer data)', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockResolvedValue({ ok: true });
			await monitor.start(abortController.signal);

			let settled: boolean | null = null;
			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal).then((result) => {
				settled = result;
			});

			// No peer data arrives, so the waiter is resolved by the first tick's successful probe.
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
			expect(fetch).toHaveBeenCalledTimes(3);
			await vi.advanceTimersByTimeAsync(0);
			expect(settled).toBe(true);
			await expect(cheapCheck).resolves.toBeUndefined();
			await monitor.stop();
		});

		test('a single update resolves all concurrent waiters', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			await monitor.start(abortController.signal);

			const cheapChecks = [0, 1, 2].map(() => monitor.connectedToInternetCheapAsync(new AbortController().signal));

			monitor.updateLastKnownConnectionTime();

			await expect(Promise.all(cheapChecks)).resolves.toEqual([true, true, true]);
			await monitor.stop();
		});

		test('failed probes do not resolve waiters; the full disconnect threshold is required (outage)', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await monitor.start(abortController.signal);
			(fetch as any).mockClear();

			let settled: boolean | null = null;
			const cheapCheck = monitor.connectedToInternetCheapAsync(new AbortController().signal).then((result) => {
				settled = result;
			});

			const disconnectThreshold = monitor.getDisconnectThresholdMs();
			// Two failing probes fire before the disconnect threshold; neither resolves the waiter.
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs * 2);
			expect(fetch).toHaveBeenCalledTimes(6);
			expect(settled).toBeNull();

			// The waiter resolves only once the full disconnect threshold has elapsed.
			await vi.advanceTimersByTimeAsync(disconnectThreshold - DEFAULT_intervalMs * 2 + 100);
			expect(fetch).toHaveBeenCalledTimes(9);
			expect(settled).toBe(false);
			await expect(cheapCheck).resolves.toBeUndefined();
			await monitor.stop();
		});
	});

	describe('start/stop and interval lifecycle', () => {
		test('stop() then start() re-arms the interval and resets the probe classification', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockResolvedValue({ ok: true });
			const callback = vi.fn();

			await monitor.start(abortController.signal);
			monitor.setOnProbeResult(callback);
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
			expect(callback).toHaveBeenCalledWith(null, true);

			await monitor.stop();
			expect((monitor as any)._intervalId).toBeNull();

			const restartAbortController = new AbortController();
			await monitor.start(restartAbortController.signal);
			// stop() clears the callback, so the host must re-register it.
			monitor.setOnProbeResult(callback);
			// The restart classifies the probe fresh: prev is null again.
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
			expect(callback).toHaveBeenCalledWith(null, true);

			await monitor.stop();
		});

		test('start() while already started keeps a single interval and awaits the in-flight probe', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockImplementation((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			}));
			await monitor.start(abortController.signal);
			const intervalIdBefore = (monitor as any)._intervalId;

			// First tick fires a probe that stays in flight until its per-URL timeout aborts it.
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
			expect((monitor as any)._intervalFunctionQueue).not.toBeNull();

			let restarted = false;
			const restartPromise = monitor.start(new AbortController().signal).then(() => {
				restarted = true;
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(restarted).toBe(false);// start() is still awaiting the in-flight probe.
			expect((monitor as any)._intervalId).toBe(intervalIdBefore);// No second interval.

			// The per-URL timeout (DEFAULT_timeoutMs after the tick) aborts the probe, which
			// completes and lets the re-entrant start() return.
			await vi.advanceTimersByTimeAsync(DEFAULT_timeoutMs + 1);
			expect(restarted).toBe(true);
			await restartPromise;

			await monitor.stop();
		});

		test('aborting the monitor signal mid-probe clears the interval and stops further probes', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockImplementation((_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			}));
			await monitor.start(abortController.signal);

			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);// Probe in flight.
			expect((monitor as any)._intervalFunctionQueue).not.toBeNull();

			abortController.abort();
			await vi.advanceTimersByTimeAsync(0);
			expect((monitor as any)._intervalId).toBeNull();
			expect((monitor as any)._intervalFunctionQueue).toBeNull();

			// No probes fire after the abort.
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs * 2);
			expect(fetch).toHaveBeenCalledTimes(3);

			await monitor.stop();
		});

		test('a slow probe dedups subsequent ticks; the next tick after completion fires a fresh probe', async () => {
			const monitor = new ConnectionMonitor({ intervalMs: 60000, timeoutMs: 60000, pingIntervalMs: 1000 });
			const abortController = new AbortController();
			let resolveFetch: ((value?: unknown) => void) | null = null;
			(fetch as any).mockImplementation(() => new Promise((resolve) => {
				resolveFetch = resolve;
			}));
			await monitor.start(abortController.signal);

			await vi.advanceTimersByTimeAsync(60000);// Tick 1: probe in flight (fetch never settles on its own).
			expect((monitor as any)._intervalFunctionQueue).not.toBeNull();

			// Tick 2 at t=120s: the in-flight probe is re-used instead of starting a new one.
			await vi.advanceTimersByTimeAsync(60000);
			expect(fetch).toHaveBeenCalledTimes(3);
			expect((monitor as any)._intervalFunctionQueue).not.toBeNull();

			// Completing the probe unblocks the queue.
			resolveFetch!();
			await vi.advanceTimersByTimeAsync(0);
			expect((monitor as any)._intervalFunctionQueue).toBeNull();

			// Tick 3 at t=180s starts a fresh probe.
			await vi.advanceTimersByTimeAsync(60000);
			expect(fetch).toHaveBeenCalledTimes(6);
			expect((monitor as any)._intervalFunctionQueue).not.toBeNull();

			// Settle the second probe so stop() has no in-flight queue to await.
			resolveFetch!();
			await vi.advanceTimersByTimeAsync(0);
			expect((monitor as any)._intervalFunctionQueue).toBeNull();

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
	});

	describe('setOnProbeResult', () => {
		test('fires on initial probe at the first interval tick', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockResolvedValue({ ok: true });
			const callback = vi.fn();
			monitor.setOnProbeResult(callback);
			await monitor.start(abortController.signal);
			// start() no longer fires a probe; the callback fires at the first tick.
			expect(callback).toHaveBeenCalledTimes(0);
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(null, true);
			await monitor.stop();
		});

		test('fires on failed probe', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			const callback = vi.fn();
			monitor.setOnProbeResult(callback);
			await monitor.start(abortController.signal);
			expect(callback).toHaveBeenCalledTimes(0);
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(null, false);
			await monitor.stop();
		});

		test('null clears the callback', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockResolvedValue({ ok: true });
			const callback = vi.fn();
			monitor.setOnProbeResult(callback);
			await monitor.start(abortController.signal);
			// start() no longer fires a probe; clear the callback before the first tick
			// to verify the tick does not invoke it after the clear.
			expect(callback).toHaveBeenCalledTimes(0);
			monitor.setOnProbeResult(null);
			await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs);
			expect(callback).toHaveBeenCalledTimes(0);
			await monitor.stop();
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

		test('shares the same skip logic used by _intervalFunction (recent update suppresses the fetch on the next tick)', async () => {
			// intervalMs=30000, timeoutMs=10000 -> skip window = (30-10)*0.9 = 18s, ticks every 30s.
			// Ping interval (default-derived or explicit) plays no role here; we feed peer-data
			// updates manually to test the fetch's skip behavior.
			const monitor = new ConnectionMonitor({ intervalMs: 30000, timeoutMs: 10000, pingIntervalMs: 5000 });
			const abortController = new AbortController();
			(fetch as any).mockResolvedValue({ ok: true });
			await monitor.start(abortController.signal);
			// start() does not fire a probe; no fetches until the first interval tick.
			expect(fetch).toHaveBeenCalledTimes(0);

			// Advance to the first 30s tick. _lastKnownConnectionTimeMs is still INIT (ancient),
			// so the fetch fires and (on success) updates _lastKnownConnectionTimeMs to ~30s.
			await vi.advanceTimersByTimeAsync(30000);
			expect(fetch).toHaveBeenCalledTimes(3);
			(fetch as any).mockClear();

			// Advance 20s more (to t=50s, between ticks) and feed a fresh "peer data" update.
			// _lastKnownConnectionTimeMs is now ~50s. The next tick at t=60s sees data ~10s old
			// (< 18s skip window) -> skip.
			await vi.advanceTimersByTimeAsync(20000);
			monitor.updateLastKnownConnectionTime();
			await vi.advanceTimersByTimeAsync(10000); // lands on the t=60s tick
			expect(monitor.shouldSkipForRecentData()).toBe(true);
			expect(fetch).toHaveBeenCalledTimes(0);

			// Advance to the t=90s tick. lastKnown (at t=50s) is now 40s old, beyond the 18s window,
			// so the tick fires the fetch (which in turn updates lastKnown once it resolves).
			await vi.advanceTimersByTimeAsync(30000);
			expect(fetch).toHaveBeenCalledTimes(3);

			await monitor.stop();
		});

		test('continuous peer data suppresses the fallback fetch indefinitely across many ticks', async () => {
			const monitor = new ConnectionMonitor();
			const abortController = new AbortController();
			(fetch as any).mockResolvedValue({ ok: true });
			await monitor.start(abortController.signal);
			expect(fetch).toHaveBeenCalledTimes(0);

			// Peer data arrives before every tick, keeping the skip window fresh.
			const skipWindow = (DEFAULT_intervalMs - DEFAULT_timeoutMs) * 0.9;
			const numTicks = 10;
			for (let i = 0; i < numTicks; i++) {
				await vi.advanceTimersByTimeAsync(DEFAULT_intervalMs - skipWindow / 2);
				monitor.updateLastKnownConnectionTime();
				await vi.advanceTimersByTimeAsync(skipWindow / 2);// Lands on the interval tick.
				expect(monitor.shouldSkipForRecentData()).toBe(true);
				expect(fetch).toHaveBeenCalledTimes(0);
			}

			await monitor.stop();
		});
	});
});