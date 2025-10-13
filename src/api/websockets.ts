import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { BlockHeadersClient } from '../BlockHeadersClient.js';
import { unixTime3Decimal } from '../utils/util.js';
import config from './config.js';
import { toBlockHeaderPresented, BlockHeaderPresented } from './presenters.js';

// Extend the WebSocket type to include our custom properties.
interface ExtendedWebSocket extends WebSocket {
	isAlive: boolean;
	subscriptions: Set<string>;
}

const createNewChainTipMessage = (header: BlockHeaderPresented): string => {
	return JSON.stringify({ type: 'new_chain_tip', data: header });
};

// --- Message Handlers ---

const handleSubscribe = (ws: ExtendedWebSocket, channel: string) => {
	if (typeof channel !== 'string') return;
	ws.subscriptions.add(channel);
	if (config.CONSOLE_DEBUG_LOG) {
		console.log(unixTime3Decimal(), `- WebSocket client subscribed to channel: ${channel}`);
	}
};

const handleUnsubscribe = (ws: ExtendedWebSocket, channel: string) => {
	if (typeof channel !== 'string') return;
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
				handleSubscribe(ws, parsed.channel);
				break;
			case 'unsubscribe':
				handleUnsubscribe(ws, parsed.channel);
				break;
		}
	} catch (e) {
		// Ignore invalid JSON messages.
	}
};

// --- WebSocket Server ---

export const createWebSocketServer = (server: http.Server, client: BlockHeadersClient) => {
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

	wss.on('connection', (ws: ExtendedWebSocket, req: http.IncomingMessage) => {
		// Initialize custom properties.
		ws.isAlive = true;
		ws.subscriptions = new Set();

		if (config.CONSOLE_DEBUG_LOG) {
			const ip = req.socket.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
			console.log(unixTime3Decimal(), `- WebSocket connection established from ${ip}.`);

			ws.on('close', () => {
				console.log(unixTime3Decimal(), `- WebSocket connection from ${ip} closed.`);
			});
		}

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
	});

	return wss;
};