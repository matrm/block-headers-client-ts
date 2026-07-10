/// <reference types="node" />
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

const { mockConfig } = vi.hoisted(() => ({
	mockConfig: {
		BYPASS_ADMIN_AUTH: false,
		ADMIN_API_KEYS: [] as string[],
		CONSOLE_DEBUG_LOG: false,
		PORT: 3000,
	},
}));

vi.mock('../../../src/api/config.js', () => ({
	default: mockConfig,
}));

import { createApp } from '../../../src/api/express.js';
import { BlockHeadersClient } from '../../../src/BlockHeadersClient.js';
import { DASHBOARD_APIS_HEADER } from '../../../src/api/middleware/adminAuth.js';

describe('peerRoutes', () => {
	let mockClient: any;
	let server: http.Server;
	let url: string;

	beforeEach(async () => {
		mockClient = {
			getPeersInfoConnected: vi.fn(),
			_getPeersInfoConnectedWithMetrics: vi.fn(),
		};
		const app = createApp(mockClient as unknown as BlockHeadersClient);
		server = http.createServer(app);
		await new Promise<void>(resolve => server.listen(0, resolve));
		const address = server.address() as any;
		url = `http://localhost:${address.port}`;
	});

	afterEach(async () => {
		vi.clearAllMocks();
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = [];
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	function headersWithDashboard() {
		const headers: Record<string, string> = {};
		headers[DASHBOARD_APIS_HEADER] = 'true';
		return headers;
	}

	test('admin + experimental header → returns metrics', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const mockPeers = [
			{ ip: '1.2.3.4', port: 8333, rating: 0.5, metrics: { lastSeenTimeMs: 1 } },
		];
		mockClient._getPeersInfoConnectedWithMetrics.mockReturnValue(mockPeers);
		const res = await fetch(`${url}/peers/connected`, {
			headers: headersWithDashboard(),
		});
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockPeers);
		expect(mockClient._getPeersInfoConnectedWithMetrics).toHaveBeenCalled();
		expect(mockClient.getPeersInfoConnected).not.toHaveBeenCalled();
	});

	test('admin + no experimental header → returns basic', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const mockPeers = [
			{ ip: '1.2.3.4', port: 8333, rating: 0.5 },
		];
		mockClient.getPeersInfoConnected.mockReturnValue(mockPeers);
		const res = await fetch(`${url}/peers/connected`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockPeers);
		expect(mockClient.getPeersInfoConnected).toHaveBeenCalled();
		expect(mockClient._getPeersInfoConnectedWithMetrics).not.toHaveBeenCalled();
	});

	test('non-admin + experimental header → returns basic', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		const mockPeers = [
			{ ip: '5.6.7.8', port: 8333, rating: 0.8 },
		];
		mockClient.getPeersInfoConnected.mockReturnValue(mockPeers);
		const res = await fetch(`${url}/peers/connected`, {
			headers: headersWithDashboard(),
		});
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockPeers);
		expect(mockClient.getPeersInfoConnected).toHaveBeenCalled();
		expect(mockClient._getPeersInfoConnectedWithMetrics).not.toHaveBeenCalled();
	});

	test('non-admin + no experimental header → returns basic', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		const mockPeers = [
			{ ip: '1.1.1.1', port: 8333, rating: 0.3 },
		];
		mockClient.getPeersInfoConnected.mockReturnValue(mockPeers);
		const res = await fetch(`${url}/peers/connected`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockPeers);
		expect(mockClient.getPeersInfoConnected).toHaveBeenCalled();
		expect(mockClient._getPeersInfoConnectedWithMetrics).not.toHaveBeenCalled();
	});

	test('public response is a subset of the dashboard response', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const dashboardPeers = [
			{ ip: '1.2.3.4', port: 8333, rating: 0.5, metrics: { lastSeenTimeMs: 1 } },
		];
		const publicPeers = [
			{ ip: '1.2.3.4', port: 8333, rating: 0.5 },
		];
		mockClient._getPeersInfoConnectedWithMetrics.mockReturnValue(dashboardPeers);
		mockClient.getPeersInfoConnected.mockReturnValue(publicPeers);
		const resDashboard = await fetch(`${url}/peers/connected`, {
			headers: headersWithDashboard(),
		});
		const resPublic = await fetch(`${url}/peers/connected`);
		expect(resDashboard.status).toBe(200);
		expect(resPublic.status).toBe(200);
		const dataDashboard: any = await resDashboard.json();
		const dataPublic: any = await resPublic.json();
		for (let i = 0; i < dataPublic.length; i++) {
			const publicPeer = dataPublic[i];
			const dashboardPeer = dataDashboard[i];
			for (const key of Object.keys(publicPeer)) {
				expect(dashboardPeer).toHaveProperty(key);
				expect(dashboardPeer[key]).toEqual(publicPeer[key]);
			}
		}
	});
});
