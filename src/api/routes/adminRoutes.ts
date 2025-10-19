import { Router, Request, Response, NextFunction } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { adminRateLimit } from '../middleware/rateLimiter.js';
import { restrictToAdmins } from '../middleware/adminAuth.js';
import { startClient } from '../helpers.js';

export const createAdminRoutes = (client: BlockHeadersClient) => {
	const router = Router();

	router.get('/admin/start', adminRateLimit, restrictToAdmins, async (req: Request, res: Response, next: NextFunction) => {
		try {
			await startClient(client);
			res.json({ message: 'started' });
		} catch (err) {
			next(err);
		}
	});

	router.get('/admin/stop', adminRateLimit, restrictToAdmins, async (req: Request, res: Response, next: NextFunction) => {
		try {
			await client.stop();
			console.log('Stopped.');
			res.json({ message: 'stopped' });
		} catch (err) {
			next(err);
		}
	});

	return router;
};