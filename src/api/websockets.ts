import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { BlockHeadersClient } from '../BlockHeadersClient.js';
import type { IpPort } from '../types.js';
import { unixTime3Decimal } from '../utils/util.js';
import config from './config.js';
import { toBlockHeaderPresented, BlockHeaderPresented } from './presenters.js';

// Extend the WebSocket type to include our custom properties.
interface ExtendedWebSocket extends WebSocket {
	isAlive: boolean;
	subscriptions: Set<string>;
	isDashboard: boolean;
	isAdmin: boolean;
}

const createNewChainTipMessage = (header: BlockHeaderPresented): string => {
	return JSON.stringify({ type: 'new_chain_tip', data: header });
};

const DASHBOARD_CHANNEL = 'dashboard';
const DASHBOARD_DEBOUNCE_MS = 250;
const DASHBOARD_MAX_WAIT_MS = 2000;

// An event object that carries an optional data payload. Events with no payload
// (e.g. connection_monitor_online_to_online) only have { name }. Events with a
// payload (e.g. peer_connected with { ip, port }) include a data field so the
// dashboard can update the DOM directly without an extra HTTP round-trip.
interface DashboardEvent {
	name: string;
	data?: any;
}

// Public interface for the debounce queue. Extracted from createWebSocketServer's
// closure so it can be unit-tested in isolation. The sendFn is called synchronously
// with the coalesced batch of events when the debounce timer fires.
export interface DashboardDebouncer {
	// Push an event into the debounce queue. Resets the debounce timer.
	queueEvent: (eventName: string, data?: any) => void;
	// Synchronously flush pending events through sendFn. Typically called by the
	// debounce timeout; exposed for testing and dispose.
	flush: () => void;
	// Clean up timers and discard pending events.
	dispose: () => void;
	// Number of events currently waiting in the debounce queue.
	getPendingCount: () => number;
}

export const createDashboardDebouncer = (options: {
	sendFn: (events: DashboardEvent[]) => void;
	debounceMs?: number;
	maxWaitMs?: number;
}): DashboardDebouncer => {
	const debounceMs = options.debounceMs ?? DASHBOARD_DEBOUNCE_MS;
	const maxWaitMs = options.maxWaitMs ?? DASHBOARD_MAX_WAIT_MS;
	const sendFn = options.sendFn;

	let pending: DashboardEvent[] = [];
	let timer: NodeJS.Timeout | null = null;
	let firstEventTime: number | null = null;

	const flush = (): void => {
		timer = null;
		firstEventTime = null;
		const events = pending;
		pending = [];
		if (events.length === 0) return;
		sendFn(events);
		// Defensive guard: if a re-entrant callback during sendFn pushed
		// events into a new pending array and did NOT schedule a timer (e.g.
		// a synchronous push that bypassed queueEvent), schedule a fresh flush
		// so those events are not orphaned. If queueEvent was called during
		// sendFn it already set timer, so we check timer === null to avoid
		// creating a duplicate timeout.
		if (pending.length > 0 && timer === null) {
			const now = Date.now();
			if (firstEventTime === null) {
				firstEventTime = now;
			}
			const remaining = maxWaitMs - (now - firstEventTime);
			const delay = Math.max(0, Math.min(remaining, debounceMs));
			timer = setTimeout(flush, delay);
		}
	};

	const queueEvent = (eventName: string, data?: any): void => {
		pending.push(data ? { name: eventName, data } : { name: eventName });
		const now = Date.now();
		if (firstEventTime === null) {
			firstEventTime = now;
		}
		if (timer !== null) {
			clearTimeout(timer);
		}
		const remaining = maxWaitMs - (now - firstEventTime);
		const delay = Math.max(0, Math.min(remaining, debounceMs));
		timer = setTimeout(flush, delay);
	};

	const dispose = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		pending = [];
		firstEventTime = null;
	};

	return { queueEvent, flush, dispose, getPendingCount: () => pending.length };
};

// Parse dashboard/auth from the WebSocket upgrade URL's query string.
// The browser WebSocket API does not allow custom headers on the upgrade request, so
// the dashboard subscriber flag flows through a query param:
//   - ?dashboard=true marks the connection as a dashboard subscriber.
//   - Admin authentication flows through the `subscribe` message payload as the
//     `adminApiKey` field. The browser sends the same long-lived admin API key it
//     already sends in the `x-admin-api-key` HTTP header for REST calls; this never
//     touches a URL query string (which reverse proxies routinely log) because it
//     travels inside an encrypted WS frame. BYPASS_ADMIN_AUTH=true skips admin-key
//     verification entirely (every dashboard connection is admin-privileged).
//   - isAdmin is always false at connection time; the true admin resolution happens
//     in handleSubscribe, which reads config.BYPASS_ADMIN_AUTH and validates any
//     adminApiKey from the subscribe payload.
const parseConnectionAuth = (req: http.IncomingMessage): { isDashboard: boolean, isAdmin: boolean } => {
	const url = new URL(req.url || '', 'http://localhost');
	const isDashboard = url.searchParams.get('dashboard') === 'true';
	const isAdmin = false;
	return { isDashboard, isAdmin };
};

// --- WebSocket Server ---

export const createWebSocketServer = (server: http.Server, client: BlockHeadersClient) => {
	// Track dashboard subscribers so the debounce send callback can iterate without
	// touching the full wss.clients set. Maintained by the 'connection' / subscribe / close
	// handlers.
	const dashboardSubscribers: Set<ExtendedWebSocket> = new Set();

	// Debounce queue: events arriving within DASHBOARD_DEBOUNCE_MS coalesce into a single
	// broadcast via trailing-edge debounce with a max-wait ceiling.
	const debouncer = createDashboardDebouncer({
		sendFn: (events: DashboardEvent[]): void => {
			const nonAdminEvents = events.filter((e) => !ADMIN_ONLY_EVENTS.has(e.name));
			// Send one consolidated message per subscriber class:
			//   - admin subscribers receive all events
			//   - non-admin subscribers receive only non-admin events
			const adminMsg = JSON.stringify({ type: 'dashboard:event', events });
			const nonAdminMsg = nonAdminEvents.length ? JSON.stringify({ type: 'dashboard:event', events: nonAdminEvents }) : null;
			for (const ws of dashboardSubscribers) {
				if (ws.readyState !== WebSocket.OPEN) continue;
				if (ws.isAdmin) {
					ws.send(adminMsg, (err) => { if (err) console.error('WebSocket send error:', err); });
				} else {
					if (nonAdminMsg) ws.send(nonAdminMsg, (err) => { if (err) console.error('WebSocket send error:', err); });
				}
			}
		},
	});
	const queueDashboardEvent = debouncer.queueEvent;

	// Dashboard-facing events. Each entry registers a listener on the private
	// _dashboardEmitter and classifies the event as admin-only or available to all
	// dashboard subscribers. Defined inside the closure so the listeners reference
	// the per-instance queueDashboardEvent.
	const DASHBOARD_EVENTS: Array<{ name: string, adminOnly: boolean, listener: (...args: any[]) => void }> = [
		{ name: 'peer_connected', adminOnly: false, listener: (ipPort: IpPort) => queueDashboardEvent('peer_connected', { ip: ipPort.ip, port: ipPort.port }) },
		{ name: 'peer_disconnected', adminOnly: false, listener: (ipPort: IpPort) => queueDashboardEvent('peer_disconnected', { ip: ipPort.ip, port: ipPort.port }) },
		{ name: 'peer_reconnected', adminOnly: true, listener: (ipPort: IpPort) => queueDashboardEvent('peer_reconnected', { ip: ipPort.ip, port: ipPort.port }) },
		{ name: 'peer_out_of_sync', adminOnly: true, listener: (ipPort: IpPort) => queueDashboardEvent('peer_out_of_sync', { ip: ipPort.ip, port: ipPort.port }) },
		{ name: 'peer_invalid_blocks', adminOnly: true, listener: (ipPort: IpPort) => queueDashboardEvent('peer_invalid_blocks', { ip: ipPort.ip, port: ipPort.port }) },
		{ name: 'peer_unintentional_disconnect_before_connect', adminOnly: true, listener: (ipPort: IpPort) => queueDashboardEvent('peer_unintentional_disconnect_before_connect', { ip: ipPort.ip, port: ipPort.port }) },
		{ name: 'peer_unintentional_disconnect_after_connect', adminOnly: true, listener: (ipPort: IpPort) => queueDashboardEvent('peer_unintentional_disconnect_after_connect', { ip: ipPort.ip, port: ipPort.port }) },
		{ name: 'peer_addr_discovered', adminOnly: true, listener: (ipPort: IpPort, count: number) => queueDashboardEvent('peer_addr_discovered', { ip: ipPort.ip, port: ipPort.port, count }) },
		{
			name: 'peer_block_hashes_received', adminOnly: true,
			listener: (ipPort: IpPort, hashHex: string) => queueDashboardEvent('peer_block_hashes_received', { ip: ipPort.ip, port: ipPort.port, hashHex }),
		},
		{ name: 'peer_pong_received', adminOnly: true, listener: (ipPort: IpPort, durationMs: number) => queueDashboardEvent('peer_pong_received', { ip: ipPort.ip, port: ipPort.port, durationMs }) },
		// peer_data_received is commented out: it spams the WS channel on every data packet.
		// {
		// 	name: 'peer_data_received', adminOnly: false,
		// 	listener: (ipPort: IpPort, timeMs: number) => queueDashboardEvent('peer_data_received', { ip: ipPort.ip, port: ipPort.port, timeMs }),
		// },
		// The four connection-monitor classifications cover both pieces of information,
		// which are whether a connectivity check ran at all and whether the status
		// transitioned. Every reported check result emits one of these four events,
		// including a first report after start or dispose (prev === null), which is
		// classified against the assumed-online baseline. No payload is carried because
		// the event name encodes the status.
		{ name: 'connection_monitor_online_to_online', adminOnly: true, listener: () => queueDashboardEvent('connection_monitor_online_to_online') },
		{ name: 'connection_monitor_online_to_offline', adminOnly: false, listener: () => queueDashboardEvent('connection_monitor_online_to_offline') },
		{ name: 'connection_monitor_offline_to_online', adminOnly: false, listener: () => queueDashboardEvent('connection_monitor_offline_to_online') },
		{ name: 'connection_monitor_offline_to_offline', adminOnly: true, listener: () => queueDashboardEvent('connection_monitor_offline_to_offline') },
		{ name: 'stuck_detection_purge', adminOnly: true, listener: () => queueDashboardEvent('stuck_detection_purge') },
		{ name: 'stuck_detection_recovery', adminOnly: true, listener: () => queueDashboardEvent('stuck_detection_recovery') },
		{ name: 'client_start', adminOnly: false, listener: () => queueDashboardEvent('client_start') },
		{ name: 'client_stop', adminOnly: false, listener: () => queueDashboardEvent('client_stop') },
	];
	// Derive the admin-only set from the registry so the classification lives inline
	// with each event definition. The set is used by the debounce send callback to
	// partition the broadcast per subscriber auth level.
	const ADMIN_ONLY_EVENTS = new Set<string>(DASHBOARD_EVENTS.filter(e => e.adminOnly).map(e => e.name));

	// --- Message Handlers ---

	const handleSubscribe = (ws: ExtendedWebSocket, channel: string, adminApiKey?: string, requestId?: string) => {
		if (typeof channel !== 'string') return;
		if (channel === DASHBOARD_CHANNEL) {
			// Only connections that identified themselves as dashboard clients (via the
			// `dashboard=true` query param) may subscribe.
			if (!ws.isDashboard) {
				if (requestId) {
					ws.send(JSON.stringify({ type: 'suback', requestId, success: false, error: 'not a dashboard connection' }));
				}
				return;
			}

			// Admin auth: an explicit adminApiKey is verified against the configured
			// admin keys. A wrong key rejects the subscription entirely (the caller
			// is claiming admin privilege and is wrong). Omitting the key is the
			// legitimate non-admin path: the subscription still succeeds, but the
			// connection only receives non-admin dashboard events. BYPASS_ADMIN_AUTH
			// skips verification and grants admin unconditionally.
			let isAdmin = config.BYPASS_ADMIN_AUTH;
			if (!config.BYPASS_ADMIN_AUTH) {
				if (adminApiKey !== undefined) {
					if (!config.ADMIN_API_KEYS.includes(adminApiKey)) {
						if (config.CONSOLE_DEBUG_LOG) {
							console.log(unixTime3Decimal(), `- WebSocket dashboard subscription rejected: invalid admin api key.`);
						}
						ws.isAdmin = false;
						if (requestId) {
							ws.send(JSON.stringify({ type: 'suback', requestId, success: false, error: 'invalid admin api key', admin: false }));
						}
						return;
					}
					isAdmin = true;
				} else {
					isAdmin = false;
				}
			}

			ws.isAdmin = isAdmin;
			ws.subscriptions.add(channel);
			dashboardSubscribers.add(ws);
			if (config.CONSOLE_DEBUG_LOG) {
				console.log(unixTime3Decimal(), `- WebSocket dashboard subscriber added (admin=${ws.isAdmin}).`);
			}
			if (requestId) {
				ws.send(JSON.stringify({ type: 'suback', requestId, success: true, admin: ws.isAdmin }));
			}
			return;
		}
		ws.subscriptions.add(channel);
		if (config.CONSOLE_DEBUG_LOG) {
			console.log(unixTime3Decimal(), `- WebSocket client subscribed to channel: ${channel}`);
		}
		if (requestId) {
			ws.send(JSON.stringify({ type: 'suback', requestId, success: true }));
		}
	};

	const handleUnsubscribe = (ws: ExtendedWebSocket, channel: string) => {
		if (typeof channel !== 'string') return;
		if (channel === DASHBOARD_CHANNEL) {
			ws.subscriptions.delete(channel);
			dashboardSubscribers.delete(ws);
			if (config.CONSOLE_DEBUG_LOG) {
				console.log(unixTime3Decimal(), `- WebSocket dashboard subscriber removed.`);
			}
			return;
		}
		ws.subscriptions.delete(channel);
		if (config.CONSOLE_DEBUG_LOG) {
			console.log(unixTime3Decimal(), `- WebSocket client unsubscribed from channel: ${channel}`);
		}
	};

	const handleMessage = (ws: ExtendedWebSocket, message: string) => {
		try {
			const parsed = JSON.parse(message);
			if (typeof parsed !== 'object' || parsed === null) return;

			switch (parsed.type) {
				case 'subscribe':
					handleSubscribe(ws, parsed.channel, parsed.adminApiKey, parsed.requestId);
					break;
				case 'unsubscribe':
					handleUnsubscribe(ws, parsed.channel);
					break;
			}
		} catch (e) {
			// Ignore invalid JSON messages.
		}
	};

	const wss = new WebSocketServer({ server });

	const broadcastNewChainTip = () => {
		const tip = client.getHeaderTip();
		const message = createNewChainTipMessage(toBlockHeaderPresented(tip));

		wss.clients.forEach((ws) => {
			const extWs = ws as ExtendedWebSocket;
			if (extWs.readyState === WebSocket.OPEN && extWs.subscriptions.has('new_chain_tip')) {
				extWs.send(message, (err) => {
					if (err) {
						console.error('WebSocket send error:', err);
					}
				});
			}
		});
	};

	client.on('new_chain_tip', broadcastNewChainTip);

	// Subscribe the WS server to all dashboard-facing BlockHeadersClient events
	// via the private _dashboardEmitter. Library consumers do not see or receive
	// these events; they are only accessible through (client as any) casting.
	const dashboardEmitter = (client as any)._dashboardEmitter;
	const dashboardCleanupFns: Array<() => void> = [];
	for (const { name, listener } of DASHBOARD_EVENTS) {
		dashboardEmitter.on(name, listener);
		dashboardCleanupFns.push(() => dashboardEmitter.off(name, listener));
	}

	wss.on('connection', (ws: ExtendedWebSocket, req: http.IncomingMessage) => {
		// Initialize custom properties.
		ws.isAlive = true;
		ws.subscriptions = new Set();
		const auth = parseConnectionAuth(req);
		ws.isDashboard = auth.isDashboard;
		ws.isAdmin = auth.isAdmin;

		if (config.CONSOLE_DEBUG_LOG) {
			const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
			console.log(unixTime3Decimal(), `- WebSocket connection established from ${ip} (dashboard=${ws.isDashboard}, admin=${ws.isAdmin}).`);
		}

		ws.on('close', () => {
			dashboardSubscribers.delete(ws);
			ws.subscriptions.clear();
			ws.isDashboard = false;
			ws.isAdmin = false;
		});

		ws.on('message', (message: string) => handleMessage(ws, message));
		ws.on('pong', () => { ws.isAlive = true; });
	});

	const heartbeatInterval = setInterval(() => {
		wss.clients.forEach((ws) => {
			const extWs = ws as ExtendedWebSocket;
			if (!extWs.isAlive) {
				return extWs.terminate();
			}
			extWs.isAlive = false;
			extWs.ping();
		});
	}, 30000);

	wss.on('close', () => {
		clearInterval(heartbeatInterval);
		client.off('new_chain_tip', broadcastNewChainTip);
		for (const cleanup of dashboardCleanupFns) cleanup();
		debouncer.dispose();
		dashboardSubscribers.clear();
	});

	return wss;
};