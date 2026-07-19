/// <reference types="node" />
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../../src/api/express.js';
import { BlockHeadersClient } from '../../../src/BlockHeadersClient.js';
import { DASHBOARD_APIS_HEADER } from '../../../src/api/middleware/adminAuth.js';
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

describe('headerRoutes', () => {
	let mockClient: any;
	let server: http.Server;
	let url: string;

	beforeEach(async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = [];
		mockClient = {
			getHeaderTip: vi.fn(),
			getHeaderFromHashHex: vi.fn(),
			getHeaderFromHeight: vi.fn(),
			_getHeadersDatabaseInfoForDashboard: vi.fn(),
			getPeersInfoConnected: vi.fn().mockReturnValue([]),
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
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = [];
	});

	function headersWithDashboard() {
		const headers: Record<string, string> = {};
		headers[DASHBOARD_APIS_HEADER] = 'true';
		return headers;
	}

	test('should return 404 for non-existent header height', async () => {
		mockClient.getHeaderFromHeight.mockReturnValue(undefined);
		const res = await fetch(`${url}/header/123`);
		expect(res.status).toBe(404);
	});

	test('should return 404 for non-existent header hash', async () => {
		mockClient.getHeaderFromHashHex.mockReturnValue(undefined);
		const res = await fetch(`${url}/header/0000000000000000000000000000000000000000000000000000000000000000`);
		expect(res.status).toBe(404);
	});

	test('should return 400 for invalid ID', async () => {
		const res = await fetch(`${url}/header/invalid`);
		expect(res.status).toBe(400);
	});

	test('should return tip header', async () => {
		const mockTip = {
			prevHashHex: '00',
			merkleRootHex: '01',
			timestamp: 123456,
			bitsHex: '02',
			nonce: 789,
			hashHex: 'abc',
			workHex: '03',
			workTotalHex: '04',
			height: 100
		};
		mockClient.getHeaderTip.mockReturnValue(mockTip);
		const res = await fetch(`${url}/header/tip`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.height).toBe(100);
		expect(data.hashHex).toBe('abc');
	});

	test('should return header by height', async () => {
		const mockHeader = {
			prevHashHex: '00',
			merkleRootHex: '01',
			timestamp: 123456,
			bitsHex: '02',
			nonce: 789,
			hashHex: 'abc',
			workHex: '03',
			workTotalHex: '04',
			height: 50
		};
		mockClient.getHeaderFromHeight.mockReturnValue(mockHeader);
		const res = await fetch(`${url}/header/50`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.height).toBe(50);
		expect(mockClient.getHeaderFromHeight).toHaveBeenCalledWith(50);
	});

	test('should return header by hash', async () => {
		const hash = '000000000000000000000000000000000000000000000000000000000000d00d';
		const mockHeader = {
			prevHashHex: '00',
			merkleRootHex: '01',
			timestamp: 123456,
			bitsHex: '02',
			nonce: 789,
			hashHex: hash,
			workHex: '03',
			workTotalHex: '04',
			height: 50
		};
		mockClient.getHeaderFromHashHex.mockReturnValue(mockHeader);
		const res = await fetch(`${url}/header/${hash}`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data.hashHex).toBe(hash);
		expect(mockClient.getHeaderFromHashHex).toHaveBeenCalledWith(hash);
	});
});

describe('headerRoutes - /headers/info', () => {
	let mockClient: any;
	let server: http.Server;
	let url: string;

	beforeEach(async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = [];
		mockClient = {
			getHeaderTip: vi.fn().mockReturnValue({ height: 0, hashHex: '00' }),
			getHeaderFromHashHex: vi.fn(),
			getHeaderFromHeight: vi.fn(),
			_getHeadersDatabaseInfoForDashboard: vi.fn(),
			getPeersInfoConnected: vi.fn().mockReturnValue([]),
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
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = [];
	});

	function headersWithDashboard() {
		const headers: Record<string, string> = {};
		headers[DASHBOARD_APIS_HEADER] = 'true';
		return headers;
	}

	function baselineMock() {
		return {
			numLongestChainHeaders: 101,
			longestChainHeight: 100,
			numAllHeaders: 105,
			numOrphanedHeaders: 4,
			numCompetingTips: 5,
			invalidBlocks: [
				'0000000000000000000000000000000000000000000000000000000000000001',
				'0000000000000000000000000000000000000000000000000000000000000002',
			],
			timeSinceLastChainTipExtensionThisSessionMs: 1234,
		};
	}

	test('dashboard header → returns headers info with full invalid-blocks array', async () => {
		const mockInfo = baselineMock();
		mockClient._getHeadersDatabaseInfoForDashboard.mockReturnValue(mockInfo);
		const res = await fetch(`${url}/headers/info`, { headers: headersWithDashboard() });
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockInfo);
		expect(Array.isArray(data.invalidBlocks)).toBe(true);
		expect(data.invalidBlocks.length).toBe(2);
		for (const h of data.invalidBlocks) {
			expect(h).toMatch(/^[0-9a-fA-F]{64}$/);
		}
		expect(mockClient._getHeadersDatabaseInfoForDashboard).toHaveBeenCalled();
	});

	test('no dashboard header → 404', async () => {
		const res = await fetch(`${url}/headers/info`);
		expect(res.status).toBe(404);
		expect(mockClient._getHeadersDatabaseInfoForDashboard).not.toHaveBeenCalled();
	});

	test('admin key without dashboard header → 404 (dashboard header required)', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const res = await fetch(`${url}/headers/info`, { headers: { 'x-admin-api-key': 'secret' } });
		expect(res.status).toBe(404);
		expect(mockClient._getHeadersDatabaseInfoForDashboard).not.toHaveBeenCalled();
	});

	test('admin + dashboard header → still 200 (route is not admin-gated)', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const mockInfo = baselineMock();
		mockClient._getHeadersDatabaseInfoForDashboard.mockReturnValue(mockInfo);
		const res = await fetch(`${url}/headers/info`, { headers: headersWithDashboard() });
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockInfo);
	});

	test('invariants: numAllHeaders >= numLongestChainHeaders and numCompetingTips >= 1', async () => {
		const mockInfo = baselineMock();
		mockClient._getHeadersDatabaseInfoForDashboard.mockReturnValue(mockInfo);
		const res = await fetch(`${url}/headers/info`, { headers: headersWithDashboard() });
		const data: any = await res.json();
		expect(data.numAllHeaders).toBeGreaterThanOrEqual(data.numLongestChainHeaders);
		expect(data.numCompetingTips).toBeGreaterThanOrEqual(1);
		expect(data.numOrphanedHeaders).toBe(data.numAllHeaders - data.numLongestChainHeaders);
		expect(data.numLongestChainHeaders).toBe(data.longestChainHeight + 1);
	});
});
