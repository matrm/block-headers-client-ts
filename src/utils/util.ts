import { IpPort } from '../types.js';

export const assert = (condition: any, message?: string): void => {
	if (!condition) {
		const error = new Error();
		if (message) {
			console.error(`Assertion failed: ${message}`);
		} else {
			console.error('Assertion failed.');
		}
		console.error(error);
		process.exit(1);// Exit with a non-zero exit code to indicate an error.
	}
};

export const stringToIpPort = (ipPortString: string): IpPort => {
	if (!ipPortString.includes('{') || !ipPortString.includes('}')) {
		throw new Error(`Invalid ipPortString: ${ipPortString}`);
	}
	return JSON.parse(ipPortString);
};

export const ipPortToString = ({ ip, port }: IpPort): string => {
	return JSON.stringify({ ip, port });
};

export const unixTime = () => Math.floor(Date.now() / 1000);
export const unixTime3Decimal = () => Math.floor(Date.now()) / 1000;
export const unixTimeMs = () => Date.now();
export const unixTimeMs3Decimal = () => Math.floor(Date.now() * 1000) / 1000;

export const sleepMs = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));

export const combineAbortControllers = (signal1: AbortSignal, signal2: AbortSignal): AbortController => {
	const controller = new AbortController();

	// If a signal is already aborted, abort the new controller immediately.
	if (signal1.aborted) {
		controller.abort(signal1.reason);
		return controller;
	}
	if (signal2.aborted) {
		controller.abort(signal2.reason);
		return controller;
	}

	const onAbort = () => {
		controller.abort();
		signal1.removeEventListener('abort', onAbort);
		signal2.removeEventListener('abort', onAbort);
	};

	signal1.addEventListener('abort', onAbort);
	signal2.addEventListener('abort', onAbort);

	return controller;
}

export const getMemoryUsageMB = (memoryUsage?: NodeJS.MemoryUsage) => {
	memoryUsage = memoryUsage ?? process.memoryUsage();
	return {
		rssMB: memoryUsage.rss / 1000000,
		heapTotalMB: memoryUsage.heapTotal / 1000000,
		heapUsedMB: memoryUsage.heapUsed / 1000000,
		externalMB: memoryUsage.external / 1000000,
		arrayBuffersMB: memoryUsage.arrayBuffers / 1000000,
	};
}

export const getMemoryUsageString = (memoryUsage?: NodeJS.MemoryUsage) => {
	const memoryUsageMb = getMemoryUsageMB(memoryUsage);
	const rssStringMB = memoryUsageMb.rssMB.toFixed(3);
	const heapTotalStringMB = memoryUsageMb.heapTotalMB.toFixed(3);
	const heapUsedStringMB = memoryUsageMb.heapUsedMB.toFixed(3);
	const externalStringMB = memoryUsageMb.externalMB.toFixed(3);
	const arrayBuffersStringMB = memoryUsageMb.arrayBuffersMB.toFixed(3);
	return `  RSS: ${rssStringMB} MB\n  Heap Total: ${heapTotalStringMB} MB\n  Heap Used: ${heapUsedStringMB} MB\n  External: ${externalStringMB} MB\n  Array Buffers: ${arrayBuffersStringMB} MB`;
}

export const abortableSleepMsNoThrow = (
	delayMs: number,
	signal?: AbortSignal
): Promise<void> => {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();// Resolve immediately if already aborted.
			return;
		}

		const timeout = setTimeout(resolve, delayMs);

		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timeout);// Prevent resolve after abort.
				resolve();// Resolve on abort.
			},
			{ once: true }
		);
	});
};

export const abortableSleepMsThrow = (
	delayMs: number,
	signal?: AbortSignal
): Promise<void> => {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);// Reject immediately if already aborted.
			return;
		}

		const timeout = setTimeout(resolve, delayMs);

		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timeout);// Prevent resolve after abort.
				reject(signal.reason);// Reject with the abort reason.
			},
			{ once: true }
		);
	});
};

export const stringifyWithTabs = (value: any): string => {
	return JSON.stringify(value, null, '\t');
};

export const getRandomHexString = (numBytes: number): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(numBytes));
	return Array.from(bytes)
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}