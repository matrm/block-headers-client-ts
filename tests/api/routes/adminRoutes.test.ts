import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

// Mock config before importing anything else that might use it
vi.mock('../../../src/api/config.js', () => ({
	default: {
		BYPASS_ADMIN_AUTH: true,
		ADMIN_API_KEYS: [],
		CONSOLE_DEBUG_LOG: false,
		PORT: 3000,
	}
}));

import { createApp } from '../../../src/api/express.js';
import { BlockHeadersClient } from '../../../src/BlockHeadersClient.js';

describe('adminRoutes', () => {
	let mockClient: any;
	let server: http.Server;
	let url: string;

	beforeEach(async () => {
		mockClient = {
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			getHeaderTip: vi.fn().mockReturnValue({ height: 0, hashHex: '00' }),
		};
		const app = createApp(mockClient as unknown as BlockHeadersClient);
		server = http.createServer(app);
		await new Promise<void>(resolve => server.listen(0, resolve));
		const address = server.address() as any;
		url = `http://localhost:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
		vi.clearAllMocks();
	});

	test('should start the client', async () => {
		const res = await fetch(`${url}/admin/start`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.message).toBe('started');
		expect(mockClient.start).toHaveBeenCalled();
	});

	test('should stop the client', async () => {
		const res = await fetch(`${url}/admin/stop`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.message).toBe('stopped');
		expect(mockClient.stop).toHaveBeenCalled();
	});
});
