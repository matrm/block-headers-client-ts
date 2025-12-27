import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import http from 'http';
import { WebSocket } from 'ws';
import { createWebSocketServer } from '../../src/api/websockets.js';
import { BlockHeadersClient } from '../../src/BlockHeadersClient.js';

class MockClient extends EventEmitter {
	getHeaderTip = vi.fn();
}

describe('websockets', () => {
	let mockClient: MockClient;
	let server: http.Server;
	let wss: any;
	let port: number;

	beforeEach(async () => {
		mockClient = new MockClient() as any;
		server = http.createServer();
		wss = createWebSocketServer(server, mockClient as unknown as BlockHeadersClient);
		await new Promise<void>(resolve => server.listen(0, resolve));
		port = (server.address() as any).port;
	});

	afterEach(async () => {
		await new Promise<void>(resolve => {
			wss.close(() => {
				server.close(() => resolve());
			});
		});
	});

	test('should receive new_chain_tip messages when subscribed', async () => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		await new Promise<void>((resolve, reject) => {
			ws.on('open', resolve);
			ws.on('error', reject);
		});

		ws.send(JSON.stringify({ type: 'subscribe', channel: 'new_chain_tip' }));

		// Wait a bit for the subscription to be processed
		await new Promise(resolve => setTimeout(resolve, 50));

		const tip = {
			height: 100, hashHex: 'abc', prevHashHex: '00', merkleRootHex: '01',
			timestamp: 1234, bitsHex: '02', nonce: 789, workHex: '03', workTotalHex: '04'
		};
		mockClient.getHeaderTip.mockReturnValue(tip);

		const messagePromise = new Promise<string>(resolve => {
			ws.on('message', data => {
				resolve(data.toString());
			});
		});

		mockClient.emit('new_chain_tip', 100, 'abc');

		const message = await messagePromise;
		const parsed = JSON.parse(message);
		expect(parsed.type).toBe('new_chain_tip');
		expect(parsed.data.height).toBe(100);
		expect(parsed.data.hashHex).toBe('abc');

		ws.close();
	});

	test('should NOT receive new_chain_tip messages when NOT subscribed', async () => {
		const ws = new WebSocket(`ws://localhost:${port}`);
		await new Promise<void>(resolve => ws.on('open', resolve));

		const tip = {
			height: 100, hashHex: 'abc', prevHashHex: '00', merkleRootHex: '01',
			timestamp: 1234, bitsHex: '02', nonce: 789, workHex: '03', workTotalHex: '04'
		};
		mockClient.getHeaderTip.mockReturnValue(tip);

		let received = false;
		ws.on('message', () => {
			received = true;
		});

		mockClient.emit('new_chain_tip', 100, 'abc');

		// Wait a bit to ensure nothing is received
		await new Promise(resolve => setTimeout(resolve, 100));
		expect(received).toBe(false);

		ws.close();
	});
});
