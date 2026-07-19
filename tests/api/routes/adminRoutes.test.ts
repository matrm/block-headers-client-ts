/// <reference types="node" />
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

// Mock config via vi.hoisted so individual tests can flip BYPASS_ADMIN_AUTH and
// ADMIN_API_KEYS. The mock Config object is shared across tests; beforeEach resets it.
const { mockConfig } = vi.hoisted(() => ({
	mockConfig: {
		BYPASS_ADMIN_AUTH: true,
		ADMIN_API_KEYS: [] as string[],
		CONSOLE_DEBUG_LOG: false,
		PORT: 3000,
	},
}));

vi.mock('../../../src/api/config.js', () => ({ default: mockConfig }));

import { createApp } from '../../../src/api/express.js';
import { BlockHeadersClient } from '../../../src/BlockHeadersClient.js';

describe('adminRoutes', () => {
	let mockClient: any;
	let server: http.Server;
	let url: string;

	beforeEach(async () => {
		// Default: admin auth bypassed, matching the original test setup.
		mockConfig.BYPASS_ADMIN_AUTH = true;
		mockConfig.ADMIN_API_KEYS = [];
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
		mockConfig.BYPASS_ADMIN_AUTH = true;
		mockConfig.ADMIN_API_KEYS = [];
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

	test('GET /verify with admin auth bypassed returns empty 200 (no key header needed)', async () => {
		const res = await fetch(`${url}/verify`);
		expect(res.status).toBe(200);
		// res.sendStatus(200) sends "OK" as the body, so there is no JSON to parse.
		expect(await res.text()).toBe('OK');
	});

	test('GET /verify with valid admin key returns empty 200', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const res = await fetch(`${url}/verify`, { headers: { 'x-admin-api-key': 'secret' } });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('OK');
	});

	test('GET /verify with bad admin key returns 403', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const res = await fetch(`${url}/verify`, { headers: { 'x-admin-api-key': 'wrong' } });
		expect(res.status).toBe(403);
	});

	test('GET /admin/memory with admin + dashboard header → 200 with memory data', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const res = await fetch(`${url}/admin/memory`, {
			headers: { 'x-dashboard-apis': 'true' },
		});
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(typeof data.rssMB).toBe('number');
		expect(typeof data.heapTotalMB).toBe('number');
		expect(typeof data.heapUsedMB).toBe('number');
		expect(typeof data.externalMB).toBe('number');
		expect(typeof data.arrayBuffersMB).toBe('number');
	});

	test('GET /admin/memory with admin + no dashboard header → 404', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const res = await fetch(`${url}/admin/memory`);
		expect(res.status).toBe(404);
	});

	test('GET /admin/memory with non-admin + dashboard header → 404', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		const res = await fetch(`${url}/admin/memory`, {
			headers: { 'x-dashboard-apis': 'true' },
		});
		expect(res.status).toBe(404);
	});

	test('GET /admin/memory with non-admin + no dashboard header → 404', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		const res = await fetch(`${url}/admin/memory`);
		expect(res.status).toBe(404);
	});

	test('GET /admin/memory with admin key + dashboard header → 200', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const res = await fetch(`${url}/admin/memory`, {
			headers: {
				'x-admin-api-key': 'secret',
				'x-dashboard-apis': 'true',
			},
		});
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(typeof data.rssMB).toBe('number');
	});
});
