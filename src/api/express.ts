import express from 'express';
import { BlockHeadersClient } from '../BlockHeadersClient.js';
import { requestLogger } from './middleware/logger.js';
import { errorHandler } from './middleware/errorHandlers.js';
import { createHeaderRoutes } from './routes/headerRoutes.js';
import { createPeerRoutes } from './routes/peerRoutes.js';
import { createAdminRoutes } from './routes/adminRoutes.js';

export const createApp = (client: BlockHeadersClient) => {
	const app = express();

	app.use(express.json());
	app.use(requestLogger);

	app.use('/', createHeaderRoutes(client));
	app.use('/', createPeerRoutes(client));
	app.use('/', createAdminRoutes(client));

	app.use(errorHandler);

	return app;
};