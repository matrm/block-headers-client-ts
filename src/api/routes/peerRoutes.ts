import { Router, Request, Response } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { publicRateLimit } from '../middleware/rateLimiter.js';

export const createPeerRoutes = (client: BlockHeadersClient) => {
	const router = Router();

	router.get('/peers/connected', publicRateLimit, (req: Request, res: Response) => {
		res.json(client.getPeersInfoConnected());
	});

	return router;
};