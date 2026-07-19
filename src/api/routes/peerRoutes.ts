import { Router, Request, Response } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { publicRateLimit } from '../middleware/rateLimiter.js';
import { isAdmin, DASHBOARD_APIS_HEADER } from '../middleware/adminAuth.js';

export const createPeerRoutes = (client: BlockHeadersClient) => {
	const router = Router();

	router.get('/peers/connected', publicRateLimit, (req: Request, res: Response) => {
		if (isAdmin(req) && req.headers[DASHBOARD_APIS_HEADER] === 'true') {
			res.json((client as any)._getPeersInfoConnectedForDashboard());
		} else {
			res.json(client.getPeersInfoConnected());
		}
	});

	// Dashboard-only summary of the discovered-node population.
	router.get('/peers/summary', publicRateLimit, (req: Request, res: Response) => {
		if (!isAdmin(req) || req.headers[DASHBOARD_APIS_HEADER] !== 'true') {
			res.status(404).send();
			return;
		}
		res.json((client as any)._getNodesSummaryForDashboard());
	});

	return router;
};