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
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = [];
		mockClient = {
			getPeersInfoConnected: vi.fn(),
			_getPeersInfoConnectedForDashboard: vi.fn(),
			_getNodesSummaryForDashboard: vi.fn(),
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

	function headersWithDashboardAndAdmin() {
		const headers = headersWithDashboard();
		headers['x-admin-api-key'] = 'secret';
		return headers;
	}

	test('admin + experimental header → returns metrics', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const mockPeers = [
			{ ip: '1.2.3.4', port: 8333, rating: 0.5, metrics: { lastSeenTimeMs: 1 } },
		];
		mockClient._getPeersInfoConnectedForDashboard.mockReturnValue(mockPeers);
		const res = await fetch(`${url}/peers/connected`, {
			headers: headersWithDashboard(),
		});
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockPeers);
		expect(mockClient._getPeersInfoConnectedForDashboard).toHaveBeenCalled();
		expect(mockClient.getPeersInfoConnected).not.toHaveBeenCalled();
	});

	test('admin + dashboard header → includes liveState with tipHashHex', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const mockPeers = [
			{
				ip: '1.2.3.4', port: 8333, rating: 0.5, metrics: { lastSeenTimeMs: 1 },
				liveState: {
					tipHashHex: 'abc',
				},
			},
		];
		mockClient._getPeersInfoConnectedForDashboard.mockReturnValue(mockPeers);
		const res = await fetch(`${url}/peers/connected`, { headers: headersWithDashboard() });
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockPeers);
		expect(data[0].liveState).toBeDefined();
		expect(typeof data[0].liveState.tipHashHex).toBe('string');
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
		expect(mockClient._getPeersInfoConnectedForDashboard).not.toHaveBeenCalled();
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
		expect(mockClient._getPeersInfoConnectedForDashboard).not.toHaveBeenCalled();
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
		expect(mockClient._getPeersInfoConnectedForDashboard).not.toHaveBeenCalled();
	});

	test('public response is a subset of the dashboard response', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const dashboardPeers = [
			{
				ip: '1.2.3.4', port: 8333, rating: 0.5, metrics: { lastSeenTimeMs: 1 },
				liveState: {
					tipHashHex: 'abc',
				},
			},
		];
		const publicPeers = [
			{ ip: '1.2.3.4', port: 8333, rating: 0.5 },
		];
		mockClient._getPeersInfoConnectedForDashboard.mockReturnValue(dashboardPeers);
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
			// Invariant: liveState is dashboard-only and absent in the public response.
			expect(dashboardPeer).toHaveProperty('liveState');
			expect(publicPeer).not.toHaveProperty('liveState');
			expect(dashboardPeer).toHaveProperty('metrics');
			expect(publicPeer).not.toHaveProperty('metrics');
		}
	});

	function baselineNodesSummary() {
		return {
			numTotalNodes: 400,
			numNonBlacklistedNodes: 350,
			numBlacklistedNodes: 50,
			blacklistRatingThreshold: 0.2666718900282393,
		};
	}

	test('admin + dashboard header → returns nodes summary via /peers/summary', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const mockSummary = baselineNodesSummary();
		mockClient._getNodesSummaryForDashboard.mockReturnValue(mockSummary);
		const res = await fetch(`${url}/peers/summary`, { headers: headersWithDashboard() });
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockSummary);
		expect(mockClient._getNodesSummaryForDashboard).toHaveBeenCalled();
	});

	test('admin + no dashboard header → 404 for /peers/summary', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const res = await fetch(`${url}/peers/summary`);
		expect(res.status).toBe(404);
		expect(mockClient._getNodesSummaryForDashboard).not.toHaveBeenCalled();
	});

	test('non-admin + dashboard header → 404 for /peers/summary', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		const res = await fetch(`${url}/peers/summary`, { headers: headersWithDashboard() });
		expect(res.status).toBe(404);
		expect(mockClient._getNodesSummaryForDashboard).not.toHaveBeenCalled();
	});

	test('non-admin + no dashboard header → 404 for /peers/summary', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		const res = await fetch(`${url}/peers/summary`);
		expect(res.status).toBe(404);
		expect(mockClient._getNodesSummaryForDashboard).not.toHaveBeenCalled();
	});

	test('admin key + dashboard header → returns nodes summary', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const mockSummary = baselineNodesSummary();
		mockClient._getNodesSummaryForDashboard.mockReturnValue(mockSummary);
		const res = await fetch(`${url}/peers/summary`, { headers: headersWithDashboardAndAdmin() });
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockSummary);
	});

	test('nodes summary invariants hold', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const mockSummary = baselineNodesSummary();
		mockClient._getNodesSummaryForDashboard.mockReturnValue(mockSummary);
		const res = await fetch(`${url}/peers/summary`, { headers: headersWithDashboard() });
		const data: any = await res.json();
		expect(data.numTotalNodes).toBe(data.numNonBlacklistedNodes + data.numBlacklistedNodes);
		expect(data.numTotalNodes).toBeGreaterThanOrEqual(data.numNonBlacklistedNodes);
		expect(data.numNonBlacklistedNodes).toBeGreaterThanOrEqual(0);
		expect(data.numBlacklistedNodes).toBeGreaterThanOrEqual(0);
		expect(typeof data.blacklistRatingThreshold).toBe('number');
		expect(data.blacklistRatingThreshold).toBeGreaterThanOrEqual(0);
		expect(data.blacklistRatingThreshold).toBeLessThanOrEqual(1);
	});
});
