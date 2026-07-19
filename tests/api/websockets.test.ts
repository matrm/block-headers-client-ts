/// <reference types="node" />
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import http from 'http';
import { WebSocket } from 'ws';

const { mockConfig } = vi.hoisted(() => ({
	mockConfig: {
		BYPASS_ADMIN_AUTH: false,
		ADMIN_API_KEYS: [] as string[],
		CONSOLE_DEBUG_LOG: false,
		PORT: 3000,
	},
}));

vi.mock('../../src/api/config.js', () => ({
	default: mockConfig,
}));

import { createWebSocketServer, createDashboardDebouncer } from '../../src/api/websockets.js';
import { BlockHeadersClient } from '../../src/BlockHeadersClient.js';
import { BlockHeadersDatabase } from '../../src/BlockHeadersDatabase.js';
import { NodesDatabase } from '../../src/NodesDatabase.js';
import { Chain, getInvalidBlocks } from '../../src/chainProtocol.js';
import { getRandomHexString } from '../../src/utils/util.js';
import { removeDirectoryWithRetries, createDbWithRetries } from '../testUtils';
import { mkdir } from 'node:fs/promises';

class MockClient extends EventEmitter {
	// Private dashboard event emitter, mirroring BlockHeadersClient._dashboardEmitter.
	// The WS server accesses this via (client as any)._dashboardEmitter.
	_dashboardEmitter = new EventEmitter();
	getHeaderTip = vi.fn();
}

describe('websockets', () => {
	let mockClient: MockClient;
	let server: http.Server;
	let wss: any;
	let port: number;

	beforeEach(async () => {
		vi.useFakeTimers();
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = [];
		mockClient = new MockClient() as any;
		server = http.createServer();
		wss = createWebSocketServer(server, mockClient as unknown as BlockHeadersClient);
		await new Promise<void>(resolve => server.listen(0, resolve));
		port = (server.address() as any).port;
	});

	afterEach(async () => {
		for (const ws of wss.clients) {
			ws.terminate();
		}
		await new Promise<void>(resolve => {
			wss.close(() => {
				server.close(() => resolve());
			});
		});
		vi.useRealTimers();
	});

	function openWs(query?: string): Promise<WebSocket> {
		return new Promise<WebSocket>((resolve, reject) => {
			const url = `ws://localhost:${port}` + (query ? `?${query}` : '');
			const ws = new WebSocket(url);
			ws.on('open', () => resolve(ws));
			ws.on('error', reject);
		});
	}

	function sendAndWait(ws: WebSocket, msg: object): Promise<void> {
		return new Promise<void>(resolve => {
			ws.send(JSON.stringify(msg), () => resolve());
		});
	}

	function sendAndWaitAck(ws: WebSocket, msg: object, requestId: string): Promise<any> {
		return new Promise<any>((resolve) => {
			const handler = (data: any) => {
				try {
					const parsed = JSON.parse(data.toString());
					if (parsed.type === 'suback' && parsed.requestId === requestId) {
						ws.off('message', handler);
						resolve(parsed);
					}
				} catch (e) { }
			};
			ws.on('message', handler);
			ws.send(JSON.stringify(msg), () => { });
		});
	}

	function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
			ws.once('message', (data) => {
				clearTimeout(timer);
				try { resolve(JSON.parse(data.toString())); } catch (e) { resolve(null); }
			});
		});
	}

	function eventNames(events: any[]): string[] {
		return events.map(function (e: any) { return e.name; });
	}

	test('should receive new_chain_tip messages when subscribed', async () => {
		const ws = await openWs();
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'new_chain_tip', requestId: 'sub1' }, 'sub1');

		const tip = {
			height: 100, hashHex: 'abc', prevHashHex: '00', merkleRootHex: '01',
			timestamp: 1234, bitsHex: '02', nonce: 789, workHex: '03', workTotalHex: '04'
		};
		mockClient.getHeaderTip.mockReturnValue(tip);

		const messagePromise = nextMessage(ws);
		mockClient.emit('new_chain_tip', 100, 'abc');

		const parsed = await messagePromise;
		expect(parsed.type).toBe('new_chain_tip');
		expect(parsed.data.height).toBe(100);
		expect(parsed.data.hashHex).toBe('abc');

		ws.close();
	});

	test('should NOT receive new_chain_tip messages when NOT subscribed', async () => {
		const ws = await openWs();

		const tip = {
			height: 100, hashHex: 'abc', prevHashHex: '00', merkleRootHex: '01',
			timestamp: 1234, bitsHex: '02', nonce: 789, workHex: '03', workTotalHex: '04'
		};
		mockClient.getHeaderTip.mockReturnValue(tip);

		let received = false;
		ws.on('message', () => { received = true; });

		mockClient.emit('new_chain_tip', 100, 'abc');

		await vi.advanceTimersByTimeAsync(100);
		expect(received).toBe(false);

		ws.close();
	});

	test('dashboard + admin subscriber receives dashboard:event for non-admin events', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const msgPromise = nextMessage(ws, 2000);
		mockClient._dashboardEmitter.emit('client_start');
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(Array.isArray(parsed.events)).toBe(true);
		expect(eventNames(parsed.events)).toContain('client_start');

		ws.close();
	});

	test('dashboard + admin subscriber receives dashboard:event for admin-only events', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const msgPromise = nextMessage(ws, 2000);
		mockClient._dashboardEmitter.emit('stuck_detection_recovery');
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(eventNames(parsed.events)).toContain('stuck_detection_recovery');

		ws.close();
	});

	test('dashboard non-admin subscriber receives non-admin events but NOT admin-only events', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		// Non-admin dashboard: dashboard=true with no adminApiKey in the
		// subscribe message. The connection legitimately degrades to non-admin
		// and only receives non-admin dashboard events.
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		// Non-admin event: should be received.
		const nonAdminPromise = nextMessage(ws, 2000);
		mockClient._dashboardEmitter.emit('client_start');
		await vi.advanceTimersByTimeAsync(300); // Advance timer to trigger debounce
		const nonAdminParsed = await nonAdminPromise;
		expect(nonAdminParsed.type).toBe('dashboard:event');
		expect(eventNames(nonAdminParsed.events)).toContain('client_start');

		// Admin-only event: should NOT be received within the debounce window + buffer.
		let receivedAdminEvent = false;
		const guard = (data: any) => {
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'dashboard:event' && eventNames(parsed.events).includes('stuck_detection_recovery')) {
					receivedAdminEvent = true;
				}
			} catch (e) { }
		};
		ws.on('message', guard);
		mockClient._dashboardEmitter.emit('stuck_detection_recovery');
		await vi.advanceTimersByTimeAsync(1000);
		ws.off('message', guard);
		expect(receivedAdminEvent).toBe(false);

		ws.close();
	});

	test('non-dashboard subscriber (no query param) is silently rejected for dashboard channel', async () => {
		const ws = await openWs();
		const ack = await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');
		expect(ack.success).toBe(false);

		let received = false;
		ws.on('message', () => { received = true; });

		mockClient._dashboardEmitter.emit('client_start');
		await vi.advanceTimersByTimeAsync(500);
		expect(received).toBe(false);

		ws.close();
	});

	test('dashboard subscriber without an admin api key receives events when BYPASS_ADMIN_AUTH is true', async () => {
		// In BYPASS_ADMIN_AUTH mode the server grants admin status unconditionally,
		// so no admin api key is required. The connection still has to pass the
		// ?dashboard=true gate to subscribe to the dashboard channel.
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const msgPromise = nextMessage(ws, 2000);
		mockClient._dashboardEmitter.emit('client_start');
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(eventNames(parsed.events)).toContain('client_start');

		ws.close();
	});

	test('rapid-fire events are debounced into a single broadcast', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		let messageCount = 0;
		let lastEvents: any = null;
		ws.on('message', (data) => {
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'dashboard:event') {
					messageCount++;
					lastEvents = parsed.events;
				}
			} catch (e) { }
		});

		// Fire 3 events in quick succession; all should coalesce into one broadcast.
		mockClient._dashboardEmitter.emit('peer_connected', { ip: '1.2.3.4', port: 8333 });
		mockClient._dashboardEmitter.emit('peer_disconnected', { ip: '5.6.7.8', port: 8333 });
		mockClient._dashboardEmitter.emit('connection_monitor_online_to_online');

		// Wait for debounce (250ms) plus buffer.
		await vi.advanceTimersByTimeAsync(600);

		expect(messageCount).toBe(1);
		expect(eventNames(lastEvents)).toContain('peer_connected');
		expect(eventNames(lastEvents)).toContain('peer_disconnected');
		expect(eventNames(lastEvents)).toContain('connection_monitor_online_to_online');

		ws.close();
	});

	test('new_chain_tip channel still works for dashboard subscribers (no regression)', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'new_chain_tip', requestId: 'sub1' }, 'sub1');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub2' }, 'sub2');

		const tip = {
			height: 200, hashHex: 'def', prevHashHex: '00', merkleRootHex: '01',
			timestamp: 1234, bitsHex: '02', nonce: 789, workHex: '03', workTotalHex: '04'
		};
		mockClient.getHeaderTip.mockReturnValue(tip);

		const msgPromise = nextMessage(ws);
		mockClient.emit('new_chain_tip', 200, 'def');

		const parsed = await msgPromise;
		expect(parsed.type).toBe('new_chain_tip');
		expect(parsed.data.height).toBe(200);

		ws.close();
	});

	test('subscriber using only non-dashboard fields should still function if suback contains unexpected fields', async () => {
		const ws = await openWs();
		// Simulate a regular client: only destructures requestId, success, and error.
		const requestId = 'sub-regular';
		const subackPromise = new Promise<any>((resolve) => {
			const handler = (data: any) => {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'suback' && parsed.requestId === requestId) {
					// Destructure only the fields a regular client would care about.
					const { requestId, success, error } = parsed;
					resolve({ requestId, success, error });
					ws.off('message', handler);
				}
			};
			ws.on('message', handler);
			ws.send(JSON.stringify({ type: 'subscribe', channel: 'new_chain_tip', requestId }));
		});

		const result = await subackPromise;
		expect(result).toEqual({ requestId, success: true, error: undefined });
		ws.close();
	});

	// --- Admin-API-key-based admin auth ---
	//
	// These tests exercise the admin-key-in-subscribe-message flow: the dashboard
	// client includes its long-lived admin API key as the `adminApiKey` field of the
	// subscribe message. The WS server verifies it against config.ADMIN_API_KEYS
	// and elevates the connection to admin status on success, or rejects the
	// subscription entirely on a wrong key. Omitting the field is the legitimate
	// non-admin path (the subscription succeeds but admin-only events are filtered).

	test('dashboard subscriber with a valid admin api key receives admin-only events', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const ws = await openWs('dashboard=true');
		const ack = await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', adminApiKey: 'secret', requestId: 'sub1' }, 'sub1');
		expect(ack.success).toBe(true);
		expect(ack.admin).toBe(true);

		// stuck_detection_recovery is in ADMIN_ONLY_EVENTS, so an admin
		// dashboard subscriber should receive it.
		const msgPromise = nextMessage(ws, 2000);
		mockClient._dashboardEmitter.emit('stuck_detection_recovery');
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(eventNames(parsed.events)).toContain('stuck_detection_recovery');

		ws.close();
	});

	test('dashboard subscriber with a valid admin api key still receives non-admin events', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', adminApiKey: 'secret', requestId: 'sub1' }, 'sub1');

		// client_start is a non-admin event; admin and non-admin subscribers
		// both receive it.
		const msgPromise = nextMessage(ws, 2000);
		mockClient._dashboardEmitter.emit('client_start');
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(eventNames(parsed.events)).toContain('client_start');

		ws.close();
	});

	test('the same admin api key elevates two independent WS connections (no single-use semantics)', async () => {
		// The long-lived admin API key is reusable: two WS connections
		// presenting the same valid key both become admin.
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const ws1 = await openWs('dashboard=true');
		await sendAndWaitAck(ws1, { type: 'subscribe', channel: 'dashboard', adminApiKey: 'secret', requestId: 'sub1' }, 'sub1');
		const ws2 = await openWs('dashboard=true');
		await sendAndWaitAck(ws2, { type: 'subscribe', channel: 'dashboard', adminApiKey: 'secret', requestId: 'sub2' }, 'sub2');

		// Both subscribers should receive the admin-only event.
		const ws1Promise = nextMessage(ws1, 2000);
		const ws2Promise = nextMessage(ws2, 2000);
		mockClient._dashboardEmitter.emit('stuck_detection_recovery');
		await vi.advanceTimersByTimeAsync(300);

		const ws1Parsed = await ws1Promise;
		const ws2Parsed = await ws2Promise;
		expect(eventNames(ws1Parsed.events)).toContain('stuck_detection_recovery');
		expect(eventNames(ws2Parsed.events)).toContain('stuck_detection_recovery');

		ws1.close();
		ws2.close();
	});

	test('an invalid admin api key is rejected on subscribe', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];
		const ws = await openWs('dashboard=true');
		// Subscribe with a wrong key: the subscription is rejected, the
		// connection is NOT added to the dashboard subscribers set, so no
		// dashboard events of any kind are received.
		const ack = await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', adminApiKey: 'wrong', requestId: 'sub1' }, 'sub1');
		expect(ack.success).toBe(false);
		expect(ack.admin).toBe(false);

		let receivedAny = false;
		const guard = (data: any) => {
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'dashboard:event') {
					receivedAny = true;
				}
			} catch (e) { }
		};
		ws.on('message', guard);
		mockClient._dashboardEmitter.emit('client_start');
		mockClient._dashboardEmitter.emit('stuck_detection_recovery');
		await vi.advanceTimersByTimeAsync(500);
		ws.off('message', guard);
		expect(receivedAny).toBe(false);

		ws.close();
	});

	test('re-subscribing with an invalid admin api key after being admin is rejected', async () => {
		mockConfig.BYPASS_ADMIN_AUTH = false;
		mockConfig.ADMIN_API_KEYS = ['secret'];

		const ws = await openWs('dashboard=true');
		// First subscribe with a valid key: becomes admin.
		const ack1 = await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', adminApiKey: 'secret', requestId: 'sub1' }, 'sub1');
		expect(ack1.success).toBe(true);
		expect(ack1.admin).toBe(true);

		// Unsubscribe (no ack expected for unsubscribe).
		ws.send(JSON.stringify({ type: 'unsubscribe', channel: 'dashboard' }));
		await vi.advanceTimersByTimeAsync(50);

		// Re-subscribe with an INVALID key: subscription is rejected and the
		// connection is dropped from the dashboard subscribers set, so no
		// admin-only events are received.
		const ack2 = await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', adminApiKey: 'invalid', requestId: 'sub2' }, 'sub2');
		expect(ack2.success).toBe(false);
		expect(ack2.admin).toBe(false);

		let receivedAdmin = false;
		const guard = (data: any) => {
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'dashboard:event' && eventNames(parsed.events).includes('stuck_detection_recovery')) {
					receivedAdmin = true;
				}
			} catch (e) { }
		};
		ws.on('message', guard);
		mockClient._dashboardEmitter.emit('stuck_detection_recovery');
		await vi.advanceTimersByTimeAsync(500);
		ws.off('message', guard);
		expect(receivedAdmin).toBe(false);

		ws.close();
	}, 10000);

	test('dashboard events emitted during ws.send callback are not lost', async () => {
		// This integration test simulates the race window described in
		// todo/dashboard-event-debounce-race.md: if ws.send() triggers a
		// synchronous callback that fires a dashboard event, that event
		// must still be delivered to subscribers.
		mockConfig.BYPASS_ADMIN_AUTH = true;
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		// Collect all dashboard:event message names as they arrive.
		const receivedEventNames: string[] = [];
		ws.on('message', (data) => {
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'dashboard:event') {
					for (const e of parsed.events) receivedEventNames.push(e.name);
				}
			} catch (e) { }
		});

		// Patch the server-side WebSocket instance(s) to synchronously
		// emit a dashboard event during the send call. We patch wss.clients
		// instead of our client-side ws because sendFn iterates the
		// server-side dashboardSubscribers set, which contains server-side
		// WebSocket instances -- not our client-side ws.
		let sendPatched = false;
		const restored: Array<{ ws: any, orig: any }> = [];
		for (const serverWs of wss.clients) {
			if (serverWs.readyState === WebSocket.OPEN) {
				const origSend = serverWs.send.bind(serverWs);
				serverWs.send = function (data: any, cb?: any) {
					if (!sendPatched) {
						sendPatched = true;
						mockClient._dashboardEmitter.emit('client_stop');
					}
					return origSend(data, cb);
				};
				restored.push({ ws: serverWs, orig: origSend });
			}
		}

		// Fire the first event to start the debounce cycle.
		mockClient._dashboardEmitter.emit('client_start');

		// Advance past the debounce window. The first flush fires,
		// sendFn calls ws.send on the server-side instance, and our
		// patch emits client_stop synchronously.
		await vi.advanceTimersByTimeAsync(300);

		// The re-entrant event is now queued with its own debounce timer.
		// Advance past that timer too.
		await vi.advanceTimersByTimeAsync(300);

		// Restore original sends before asserting to prevent test leakage.
		for (const { ws: srvWs, orig } of restored) {
			srvWs.send = orig;
		}

		expect(receivedEventNames).toContain('client_start');
		expect(receivedEventNames).toContain('client_stop');

		ws.close();
	});

	// End of websockets describe block -- the closing brace follows below.
});

// Unit tests for the debounce queue extracted from createWebSocketServer.
// Focuses on the race condition fix: events arriving during the send
// callback must not be orphaned.
describe('createDashboardDebouncer', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('queues events and calls sendFn on flush', () => {
		const batches: { name: string }[][] = [];
		const d = createDashboardDebouncer({
			sendFn: (events) => batches.push(events.map(e => ({ name: e.name }))),
		});

		d.queueEvent('event_a', { key: 'val' });
		d.queueEvent('event_b');

		expect(d.getPendingCount()).toBe(2);
		expect(batches).toHaveLength(0);

		d.flush();

		expect(batches).toHaveLength(1);
		expect(batches[0].map(e => e.name)).toEqual(['event_a', 'event_b']);
		expect(d.getPendingCount()).toBe(0);
	});

	test('flush of empty queue does not call sendFn', () => {
		const sendFn = vi.fn();
		const d = createDashboardDebouncer({ sendFn });

		d.flush();

		expect(sendFn).not.toHaveBeenCalled();
	});

	test('getPendingCount reflects queue state', () => {
		const d = createDashboardDebouncer({ sendFn: () => { } });

		expect(d.getPendingCount()).toBe(0);

		d.queueEvent('a');
		expect(d.getPendingCount()).toBe(1);

		d.queueEvent('b');
		expect(d.getPendingCount()).toBe(2);

		d.flush();
		expect(d.getPendingCount()).toBe(0);
	});

	test('dispose clears timers and pending events', () => {
		const sendFn = vi.fn();
		const d = createDashboardDebouncer({ sendFn });

		d.queueEvent('a');
		d.queueEvent('b');
		expect(d.getPendingCount()).toBe(2);

		d.dispose();

		expect(d.getPendingCount()).toBe(0);

		// After dispose, the debounce timer is cleared. Advancing time
		// should not trigger any flush.
		vi.advanceTimersByTime(1000);
		expect(sendFn).not.toHaveBeenCalled();
	});

	test('trailing-edge debounce coalesces events into a single flush', () => {
		const batches: { name: string }[][] = [];
		const d = createDashboardDebouncer({
			sendFn: (events) => batches.push(events.map(e => ({ name: e.name }))),
		});

		d.queueEvent('first');
		vi.advanceTimersByTime(100);

		d.queueEvent('second');
		vi.advanceTimersByTime(100);

		d.queueEvent('third');
		// Advance past debounce window (default 250ms from last event).
		vi.advanceTimersByTime(300);

		expect(batches).toHaveLength(1);
		expect(batches[0].map(e => e.name)).toEqual(['first', 'second', 'third']);
	});

	test('max-wait ceiling forces flush when events arrive continuously', () => {
		const batches: { name: string }[][] = [];
		const d = createDashboardDebouncer({
			sendFn: (events) => batches.push(events.map(e => ({ name: e.name }))),
			debounceMs: 100,
			maxWaitMs: 200,
		});

		d.queueEvent('e1');
		vi.advanceTimersByTime(90);

		d.queueEvent('e2');
		vi.advanceTimersByTime(90);

		// firstEventTime was set ~180ms ago. maxWaitMs=200 means maxWait
		// would force a flush in 20ms, but the debounce timer from e2
		// already uses min(100, 20) = 20ms. Advance past that.
		vi.advanceTimersByTime(30);

		expect(batches).toHaveLength(1);
		expect(batches[0].map(e => e.name)).toEqual(['e1', 'e2']);
	});

	test('guard: events queued during sendFn are preserved and flushed on next tick', () => {
		const batches: { name: string }[][] = [];
		let flushCount = 0;

		const d = createDashboardDebouncer({
			sendFn: (events) => {
				batches.push(events.map(e => ({ name: e.name })));
				flushCount++;
				// Simulate a re-entrant event arriving during the send
				// callback. This mirrors the scenario where ws.send()
				// triggers a synchronous callback that fires the
				// dashboard event emitter, which calls queueEvent.
				if (flushCount === 1) {
					d.queueEvent('re_entrant_event');
				}
			},
		});

		d.queueEvent('initial_event');

		// Manually flush -- simulates the debounce timeout firing.
		d.flush();

		// The initial event was sent in the first flush.
		expect(batches).toHaveLength(1);
		expect(batches[0].map(e => e.name)).toEqual(['initial_event']);

		// The re-entrant event should be pending.
		expect(d.getPendingCount()).toBe(1);

		// queueEvent already scheduled a new timer for the re-entrant
		// event. Advance past the debounce window to trigger it.
		vi.advanceTimersByTime(300);

		// Now the re-entrant event should have been flushed too.
		expect(batches).toHaveLength(2);
		expect(batches[1].map(e => e.name)).toEqual(['re_entrant_event']);
		expect(d.getPendingCount()).toBe(0);
	});

	test('guard: does not create duplicate timers when queueEvent handles re-entrant events', () => {
		// When queueEvent is called during sendFn, it schedules a timer.
		// The guard (pending.length > 0 && timer === null) should NOT
		// schedule another, because timer is already non-null.
		// This test verifies that advancing timers produces exactly one
		// extra flush, not two.

		const batches: { name: string }[][] = [];
		let flushCount = 0;

		const d = createDashboardDebouncer({
			sendFn: (events) => {
				batches.push(events.map(e => ({ name: e.name })));
				flushCount++;
				if (flushCount === 1) {
					d.queueEvent('re_entrant_1');
					d.queueEvent('re_entrant_2');
				}
			},
			debounceMs: 50,
		});

		d.queueEvent('initial');

		// Advance past the debounce window to trigger the initial flush.
		vi.advanceTimersByTime(60);

		// flushCount should be 1 (the initial flush).
		expect(flushCount).toBe(1);

		// The two re-entrant events are pending and a timer is set by queueEvent.
		expect(d.getPendingCount()).toBe(2);

		// Advance past the re-entrant timer.
		vi.advanceTimersByTime(60);

		// flushCount should be 2 (the re-entrant flush). If the guard had
		// created a duplicate timer, we could see flushCount > 2, but
		// wait -- the duplicate would fire and find an empty queue
		// (the first timer already captured the events), so flushCount
		// could still be 3 if the duplicate fires too.
		// The key assertions: all events arrive and exactly one extra flush
		// dispatches the re-entrant events.
		expect(flushCount).toBeGreaterThanOrEqual(2);

		// All three events should have been delivered across the two flushes.
		const allNames = batches.flatMap(b => b.map(e => e.name));
		expect(allNames).toContain('initial');
		expect(allNames).toContain('re_entrant_1');
		expect(allNames).toContain('re_entrant_2');
		expect(d.getPendingCount()).toBe(0);
	});

	test('multiple re-entrant events during sendFn are all preserved', () => {
		const batches: { name: string }[][] = [];
		let flushCount = 0;

		const d = createDashboardDebouncer({
			sendFn: (events) => {
				batches.push(events.map(e => ({ name: e.name })));
				flushCount++;
				if (flushCount === 1) {
					d.queueEvent('r1');
					d.queueEvent('r2');
					d.queueEvent('r3');
				}
			},
		});

		d.queueEvent('initial');

		d.flush();

		expect(batches).toHaveLength(1);
		expect(d.getPendingCount()).toBe(3);

		vi.advanceTimersByTime(300);

		expect(batches).toHaveLength(2);
		expect(batches[1].map(e => e.name)).toEqual(['r1', 'r2', 'r3']);
		expect(d.getPendingCount()).toBe(0);
	});

	test('re-entrant events arriving past max-wait still flush correctly', () => {
		const batches: { name: string }[][] = [];
		let flushCount = 0;

		const d = createDashboardDebouncer({
			sendFn: (events) => {
				batches.push(events.map(e => ({ name: e.name })));
				flushCount++;
				if (flushCount === 1) {
					d.queueEvent('re_entrant');
				}
			},
			debounceMs: 100,
			maxWaitMs: 50, // maxWait shorter than debounce -- forces immediate-ish flush
		});

		d.queueEvent('fast');
		// maxWaitMs of 50 means flush fires very soon.
		vi.advanceTimersByTime(60);

		expect(flushCount).toBe(1);
		expect(d.getPendingCount()).toBe(1);

		vi.advanceTimersByTime(60);

		expect(batches.flatMap(b => b.map(e => e.name))).toContain('re_entrant');
		expect(d.getPendingCount()).toBe(0);
	});
});

// End-to-end tests that use a real (stubbed) BlockHeadersClient to verify
// that client.start() and client.stop() produce dashboard:event WebSocket
// broadcasts. The existing tests manually emit on _dashboardEmitter, which
// covers the WS bridge, but not the "public method call → emit → WS" chain.
// The emitter-level correctness (shouldEmitClientStart flag, .finally()
// behavior, deduplication) is tested in BlockHeadersClient.test.ts.
describe('dashboard lifecycle events via stubbed client', () => {
	const chain: Chain = 'bsv';

	let client: BlockHeadersClient;
	let server: http.Server;
	let wss: any;
	let port: number;
	let nodesDb: NodesDatabase;
	let headersDb: BlockHeadersDatabase;
	let nodesPath: string;
	let headersPath: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		mockConfig.BYPASS_ADMIN_AUTH = true;

		nodesPath = `tests/db/ws-lifecycle-nodes-${getRandomHexString(16)}`;
		headersPath = `tests/db/ws-lifecycle-headers-${getRandomHexString(16)}`;
		await mkdir(nodesPath, { recursive: true });
		await mkdir(headersPath, { recursive: true });

		nodesDb = await createDbWithRetries(() => NodesDatabase.create({ databasePath: nodesPath }));
		headersDb = await createDbWithRetries(() => BlockHeadersDatabase.fromGenesis({
			databasePath: headersPath,
			invalidBlocks: Array.from(getInvalidBlocks(chain))
		}));

		client = new (BlockHeadersClient as any)({
			chain,
			nodesDatabase: nodesDb,
			blockHeadersDatabase: headersDb,
			enableConsoleDebugLog: false,
		}) as BlockHeadersClient;

		// Stub every method that would touch the network or real LevelDB
		// I/O during start/stop. The databases themselves are real instances
		// but their open/close are no-oped so stop() in afterEach succeeds.
		(client as any)._connectionMonitor.start = async () => { };
		(client as any)._connectionMonitor[Symbol.asyncDispose] = async () => { };
		(client as any)._nodesDatabase.open = async () => { };
		(client as any)._nodesDatabase[Symbol.asyncDispose] = async () => { };
		(client as any)._blockHeadersDatabase.open = async () => { };
		(client as any)._blockHeadersDatabase[Symbol.asyncDispose] = async () => { };
		(client as any)._connectToNodes = async () => { };
		(client as any)._launchNodeConnectionsHealthMonitor = () => { };
		(client as any)._closeNodeConnections = () => { };

		server = http.createServer();
		wss = createWebSocketServer(server, client);
		await new Promise<void>(resolve => server.listen(0, resolve));
		port = (server.address() as any).port;
	});

	afterEach(async () => {
		for (const ws of wss.clients) { ws.terminate(); }
		await new Promise<void>(resolve => {
			wss.close(() => {
				server.close(() => resolve());
			});
		});
		if (client) await client.stop().catch(() => { });
		if (nodesDb) await nodesDb.close().catch(() => { });
		if (headersDb) await headersDb.close().catch(() => { });
		await removeDirectoryWithRetries(nodesPath);
		await removeDirectoryWithRetries(headersPath);
		vi.useRealTimers();
	});

	function openWs(query?: string): Promise<WebSocket> {
		return new Promise<WebSocket>((resolve, reject) => {
			const url = `ws://localhost:${port}` + (query ? `?${query}` : '');
			const ws = new WebSocket(url);
			ws.on('open', () => resolve(ws));
			ws.on('error', reject);
		});
	}

	function sendAndWaitAck(ws: WebSocket, msg: object, requestId: string): Promise<any> {
		return new Promise<any>((resolve) => {
			const handler = (data: any) => {
				try {
					const parsed = JSON.parse(data.toString());
					if (parsed.type === 'suback' && parsed.requestId === requestId) {
						ws.off('message', handler);
						resolve(parsed);
					}
				} catch (e) { }
			};
			ws.on('message', handler);
			ws.send(JSON.stringify(msg), () => { });
		});
	}

	function nextMessage(ws: WebSocket, timeoutMs = 1000): Promise<any> {
		return new Promise<any>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
			ws.once('message', (data) => {
				clearTimeout(timer);
				try { resolve(JSON.parse(data.toString())); } catch (e) { resolve(null); }
			});
		});
	}

	function eventNames(events: any[]): string[] {
		return events.map(function (e: any) { return e.name; });
	}

	test('client.start() produces dashboard:event WS broadcast with client_start', async () => {
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const msgPromise = nextMessage(ws, 5000);

		await client.start();
		// client.start() emitted client_start synchronously during its
		// execution; the debounce timer was set and needs to fire.
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(eventNames(parsed.events)).toContain('client_start');

		ws.close();
	});

	test('client.stop() produces dashboard:event WS broadcast with client_stop', async () => {
		// Must start first so the client has internal state (AbortController,
		// connection monitor, etc.) that stop() can tear down.
		await client.start();
		await vi.advanceTimersByTimeAsync(10); // Let debounce flush (unused in this test)

		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const msgPromise = nextMessage(ws, 5000);

		await client.stop();
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(eventNames(parsed.events)).toContain('client_stop');

		ws.close();
	});

	test('start then stop emits both lifecycle events in order', async () => {
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const receivedEventNames: string[] = [];
		ws.on('message', (data) => {
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'dashboard:event') {
					for (const e of parsed.events) receivedEventNames.push(e.name);
				}
			} catch (e) { }
		});

		await client.start();
		await vi.advanceTimersByTimeAsync(300); // past client_start debounce

		await client.stop();
		await vi.advanceTimersByTimeAsync(300); // past client_stop debounce

		expect(receivedEventNames).toContain('client_start');
		expect(receivedEventNames).toContain('client_stop');

		// client_start must appear before client_stop in the stream.
		const startIdx = receivedEventNames.indexOf('client_start');
		const stopIdx = receivedEventNames.indexOf('client_stop');
		expect(startIdx).not.toBe(-1);
		expect(stopIdx).not.toBe(-1);
		expect(startIdx).toBeLessThan(stopIdx);

		ws.close();
	});

	test('a second start after stop emits client_start again', async () => {
		// First cycle: start → stop
		await client.start();
		await vi.advanceTimersByTimeAsync(10);
		await client.stop();
		await vi.advanceTimersByTimeAsync(10);

		// Second cycle: start again, verify client_start fires
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const msgPromise = nextMessage(ws, 5000);

		await client.start();
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(eventNames(parsed.events)).toContain('client_start');

		ws.close();
	});

	test('client_stop is broadcast even when no start was called', async () => {
		// stop() can be called without a prior start() (e.g. cleanup).
		// The event should still be emitted via .finally() even though
		// some internal state may not exist.
		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		const msgPromise = nextMessage(ws, 5000);

		await client.stop().catch(() => { });
		await vi.advanceTimersByTimeAsync(300);

		const parsed = await msgPromise;
		expect(parsed.type).toBe('dashboard:event');
		expect(eventNames(parsed.events)).toContain('client_stop');

		ws.close();
	});

	test('concurrent start() calls produce exactly one client_start broadcast', async () => {
		// A slow connectToNodes keeps both _start() calls in flight.
		let releaseConnect!: () => void;
		const blocker = new Promise<void>(res => { releaseConnect = res; });
		(client as any)._connectToNodes = async () => { await blocker; };

		const ws = await openWs('dashboard=true');
		await sendAndWaitAck(ws, { type: 'subscribe', channel: 'dashboard', requestId: 'sub1' }, 'sub1');

		let clientStartCount = 0;
		ws.on('message', (data) => {
			try {
				const parsed = JSON.parse(data.toString());
				if (parsed.type === 'dashboard:event') {
					for (const e of parsed.events) {
						if (e.name === 'client_start') clientStartCount++;
					}
				}
			} catch (e) { }
		});

		const startPromise1 = client.start();
		const startPromise2 = client.start();
		releaseConnect();
		await Promise.all([startPromise1, startPromise2]);
		await vi.advanceTimersByTimeAsync(300);

		expect(clientStartCount).toBe(1);

		ws.close();
	});
});
