import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionMonitor, DEFAULT_timeoutMs, DEFAULT_intervalMs } from '../src/ConnectionMonitor.js';

describe('ConnectionMonitor', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(global, 'fetch');
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

	test('start should call _intervalFunction immediately', async () => {
		const monitor = new ConnectionMonitor();
		const abortController = new AbortController();
		(fetch as any).mockResolvedValue({ ok: true });

		await monitor.start(abortController.signal);

		expect(fetch).toHaveBeenCalledTimes(3);
		await monitor.stop();
	});

	test('interval function should check connection', async () => {
		const monitor = new ConnectionMonitor({ intervalMs: 10000 });
		const abortController = new AbortController();
		(fetch as any).mockResolvedValue({ ok: true });

		await monitor.start(abortController.signal);
		expect(fetch).toHaveBeenCalledTimes(3);

		await vi.advanceTimersByTimeAsync(10000);
		expect(fetch).toHaveBeenCalledTimes(6);

		await vi.advanceTimersByTimeAsync(10000);
		expect(fetch).toHaveBeenCalledTimes(9);

		await monitor.stop();
	});

	test('should update last known connection time on successful fetch', async () => {
		const monitor = new ConnectionMonitor();
		const abortController = new AbortController();
		(fetch as any).mockResolvedValue({ ok: true });

		const timeBefore = monitor.getTimeSinceLastKnownConnectionMs();
		await monitor.start(abortController.signal);
		const timeAfter = monitor.getTimeSinceLastKnownConnectionMs();

		expect(timeAfter).toBeLessThan(timeBefore);
		expect(timeAfter).toBeLessThan(1000);// Should be very recent.

		await monitor.stop();
	});

	test('should not update last known connection time on failed fetch', async () => {
		const monitor = new ConnectionMonitor();
		const abortController = new AbortController();
		(fetch as any).mockRejectedValue(new Error('Network error'));

		const timeBefore = monitor.getTimeSinceLastKnownConnectionMs();
		await monitor.start(abortController.signal);
		const timeAfter = monitor.getTimeSinceLastKnownConnectionMs();

		expect(timeAfter).toBe(timeBefore);

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
			await monitor.start(abortController.signal);// sets initial time.
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
			(fetch as any).mockClear();

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
	});

	describe('connectedToInternetExpensiveAsync', () => {
		test('should resolve true on successful fetch', async () => {
			const monitor = new ConnectionMonitor();
			(fetch as any).mockResolvedValue({ ok: true });
			await expect(monitor.connectedToInternetExpensiveAsync(new AbortController().signal)).resolves.toBe(true);
		});

		test('should resolve false on failed fetch', async () => {
			const monitor = new ConnectionMonitor();
			(fetch as any).mockRejectedValue(new Error('Network error'));
			await expect(monitor.connectedToInternetExpensiveAsync(new AbortController().signal)).resolves.toBe(false);
		});
	});
});