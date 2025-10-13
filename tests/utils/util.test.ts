import { expect, test, describe, vi, beforeEach, afterAll, afterEach } from 'vitest';
import {
	assert,
	ipPortToString,
	stringToIpPort,
	combineAbortControllers,
	sleepMs,
	abortableSleepMsNoThrow,
	abortableSleepMsThrow,
} from '../../src/utils/util.js';
import { IpPort } from '../../src/types.js';

describe('util', () => {
	describe('ipPort conversions', () => {
		test('should convert IpPort to string and back', () => {
			const ipPort: IpPort = { ip: '127.0.0.1', port: 8333 };
			const str = ipPortToString(ipPort);
			expect(str).toBe('{"ip":"127.0.0.1","port":8333}');
			const convertedBack = stringToIpPort(str);
			expect(convertedBack).toEqual(ipPort);
		});

		test('should throw on invalid string for stringToIpPort', () => {
			expect(() => stringToIpPort('invalid')).toThrow();
		});
	});

	describe('assert', () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		const error = vi.spyOn(console, 'error').mockImplementation(() => { });

		beforeEach(() => {
			exit.mockClear();
			error.mockClear();
		});

		afterAll(() => {
			exit.mockRestore();
			error.mockRestore();
		});

		test('should do nothing if condition is true', () => {
			assert(true, 'should not fail');
			expect(exit).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		});

		test('should exit process if condition is false', () => {
			assert(false, 'test failure');
			expect(exit).toHaveBeenCalledWith(1);
			expect(error).toHaveBeenCalled();
			expect(error.mock.calls[0][0]).toContain('Assertion failed: test failure');
		});
	});

	describe('combineAbortControllers', () => {
		test('should abort when first signal aborts', () => {
			const ac1 = new AbortController();
			const ac2 = new AbortController();
			const combined = combineAbortControllers(ac1.signal, ac2.signal);
			const onAbort = vi.fn();
			combined.signal.addEventListener('abort', onAbort);

			ac1.abort();
			expect(onAbort).toHaveBeenCalled();
			expect(combined.signal.aborted).toBe(true);
		});

		test('should abort when second signal aborts', () => {
			const ac1 = new AbortController();
			const ac2 = new AbortController();
			const combined = combineAbortControllers(ac1.signal, ac2.signal);
			const onAbort = vi.fn();
			combined.signal.addEventListener('abort', onAbort);

			ac2.abort();
			expect(onAbort).toHaveBeenCalled();
			expect(combined.signal.aborted).toBe(true);
		});

		test('should be aborted if one signal is already aborted', () => {
			const ac1 = new AbortController();
			ac1.abort();
			const ac2 = new AbortController();
			const combined = combineAbortControllers(ac1.signal, ac2.signal);
			expect(combined.signal.aborted).toBe(true);
		});
	});

	describe('sleep functions', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		test('sleepMs should resolve after delay', async () => {
			const promise = sleepMs(1000);
			vi.advanceTimersByTime(1000);
			await expect(promise).resolves.toBeUndefined();
		});

		test('abortableSleepMsNoThrow should resolve on abort', async () => {
			const ac = new AbortController();
			const promise = abortableSleepMsNoThrow(5000, ac.signal);
			ac.abort();
			await expect(promise).resolves.toBeUndefined();
		});

		test('abortableSleepMsThrow should reject on abort', async () => {
			const ac = new AbortController();
			const reason = new Error('aborted');
			const promise = abortableSleepMsThrow(5000, ac.signal);
			ac.abort(reason);
			await expect(promise).rejects.toBe(reason);
		});
	});
});