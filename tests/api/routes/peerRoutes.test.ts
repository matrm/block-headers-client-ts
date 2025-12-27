import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../../../src/api/express.js';
import { BlockHeadersClient } from '../../../src/BlockHeadersClient.js';
import http from 'http';

describe('peerRoutes', () => {
	let mockClient: any;
	let server: http.Server;
	let url: string;

	beforeEach(async () => {
		mockClient = {
			getPeersInfoConnected: vi.fn(),
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

	test('should return connected peers info', async () => {
		const mockPeers = [
			{ ip: '1.2.3.4', port: 8333, userAgent: 'test', height: 100 },
			{ ip: '5.6.7.8', port: 8333, userAgent: 'test2', height: 101 },
		];
		mockClient.getPeersInfoConnected.mockReturnValue(mockPeers);
		const res = await fetch(`${url}/peers/connected`);
		expect(res.status).toBe(200);
		const data: any = await res.json();
		expect(data).toEqual(mockPeers);
		expect(mockClient.getPeersInfoConnected).toHaveBeenCalled();
	});
});
