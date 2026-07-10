import { Router, Request, Response } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { publicRateLimit } from '../middleware/rateLimiter.js';
import { isAdmin, DASHBOARD_APIS_HEADER } from '../middleware/adminAuth.js';

export const createPeerRoutes = (client: BlockHeadersClient) => {
	const router = Router();

	router.get('/peers/connected', publicRateLimit, (req: Request, res: Response) => {
		if (isAdmin(req) && req.headers[DASHBOARD_APIS_HEADER] === 'true') {
			res.json((client as any)._getPeersInfoConnectedWithMetrics());
		} else {
			res.json(client.getPeersInfoConnected());
		}
	});

	return router;
};