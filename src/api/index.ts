import http from 'http';
import net from 'net';

import { createApp } from './express.js';

import { BlockHeadersClient } from '../BlockHeadersClient.js';
import { getMemoryUsageString } from '../utils/util.js';
import config from './config.js';
import { createWebSocketServer } from './websockets.js';

import { startClient } from './helpers.js';

async function main() {
	config.CONSOLE_DEBUG_LOG && console.log('Memory usage before loading client:');
	config.CONSOLE_DEBUG_LOG && console.log(getMemoryUsageString());

	const client = await BlockHeadersClient.create({
		chain: config.CHAIN,
		databasePath: config.DATABASE_PATH,
		seedNodes: config.SEED_NODES,
		enableConsoleDebugLog: config.CONSOLE_DEBUG_LOG,
	});

	const app = createApp(client);
	const server = http.createServer(app);
	const wss = createWebSocketServer(server, client);

	const sockets = new Set<net.Socket>();
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => {
			sockets.delete(socket);
		});
	});

	client.on('new_chain_tip', (height: number, hashHex: string) => {
		const unixTime = Math.floor(Date.now() / 1000);
		console.log(`${unixTime} - Received new chain tip ${height}:`, hashHex);
	});

	if (config.CONSOLE_DEBUG_LOG) {
		console.log("#".repeat(40));
		console.log(`Tip height before syncing: ${client.getHeaderTip().height}`);
		console.log(`Tip hashHex before syncing: ${client.getHeaderTip().hashHex}`);
		console.log('Memory usage before syncing:');
		console.log(getMemoryUsageString());
		console.log("#".repeat(40));
	}

	server.listen(config.PORT, () => {
		console.log(`Server listening at http://localhost:${config.PORT}`);
	});

	if (config.AUTO_START) {
		console.log('AUTO_START is true, starting client...');
		await startClient(client);
	}

	const shutdown = async () => {
		console.log('Closing WebSocket server...');
		for (const ws of wss.clients) {
			ws.terminate();
		}
		await new Promise<void>(resolve => {
			wss.close(() => {
				console.log('WebSocket server closed.');
				resolve();
			});
		});

		console.log('Stopping block headers client...');
		await client.stop();
		console.log('Block headers client Stopped.');

		console.log('Stopping HTTP server...');
		await new Promise<void>(resolve => {
			server.close((err?: Error) => {
				if (err) {
					console.error('Error stopping HTTP server:', err);
				}
				console.log('HTTP server stopped.');
				resolve();
			});
			for (const socket of sockets) {
				socket.destroy();
			}
		});
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	process.on('uncaughtException', (err) => {
		console.error('Uncaught exception:', err);
		process.exit(1);
	});

	process.on('unhandledRejection', (reason, promise) => {
		console.error('Unhandled promise rejection:', reason);
		process.exit(1);
	});
}

main().catch((err) => {
	console.error('Failed to start server:', err);
	process.exit(1);
});