import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../../src/api/express.js';
import { BlockHeadersClient } from '../../../src/BlockHeadersClient.js';
import http from 'http';

describe('headerRoutes', () => {
	let mockClient: any;
	let server: http.Server;
	let url: string;

	beforeEach(async () => {
		mockClient = {
			getHeaderTip: vi.fn(),
			getHeaderFromHashHex: vi.fn(),
			getHeaderFromHeight: vi.fn(),
		};
		const app = createApp(mockClient as unknown as BlockHeadersClient);
		server = http.createServer(app);
		await new Promise<void>(resolve => server.listen(0, resolve));
		const address = server.address() as any;
		url = `http://localhost:${address.port}`;
	});

	afterEach(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

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
