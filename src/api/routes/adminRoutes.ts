import { Router, Request, Response, NextFunction } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { getMemoryUsageMB } from '../../utils/util.js';
import { adminRateLimit, publicRateLimit } from '../middleware/rateLimiter.js';
import { isAdmin, restrictToAdmins, DASHBOARD_APIS_HEADER } from '../middleware/adminAuth.js';
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

	router.get('/admin/memory', publicRateLimit, (req: Request, res: Response) => {
		if (!isAdmin(req) || req.headers[DASHBOARD_APIS_HEADER] !== 'true') {
			res.status(404).send();
			return;
		}
		res.json(getMemoryUsageMB());
	});

	// GET /verify is the dashboard's admin-key probe: it returns 200 if the
	// caller's x-admin-api-key header validates (or BYPASS_ADMIN_AUTH is true),
	// and 403 otherwise. It carries no body: the dashboard reuses the same
	// long-lived admin API key inside its encrypted WS subscribe frame.
	router.get('/verify', adminRateLimit, restrictToAdmins, (_req: Request, res: Response) => {
		res.sendStatus(200);
	});

	return router;
};