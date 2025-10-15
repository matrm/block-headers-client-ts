import { Router, Request, Response, NextFunction } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { adminRateLimit } from '../middleware/rateLimiter.js';
import { restrictToAdmins } from '../middleware/adminAuth.js';
import { getMemoryUsageString } from '../../utils/util.js';
import config from '../config.js';

export const createAdminRoutes = (client: BlockHeadersClient) => {
	const router = Router();

	router.get('/admin/start', adminRateLimit, restrictToAdmins, async (req: Request, res: Response, next: NextFunction) => {
		try {
			const timeBeforeMs = performance.now();
			await client.start();
			const timeAfterMs = performance.now();
			if (config.CONSOLE_DEBUG_LOG) {
				console.log(`Time to start: ${timeAfterMs - timeBeforeMs}ms.`);
				console.log("#".repeat(40));
				console.log("#".repeat(40));
				console.log("#".repeat(40));
				console.log("#".repeat(15), 'Started', '#'.repeat(15));
				console.log("#".repeat(40));
				console.log("#".repeat(40));
				console.log("#".repeat(40));
				console.log(`Tip height after syncing: ${client.getHeaderTip().height}`);
				console.log(`Tip hashHex after syncing: ${client.getHeaderTip().hashHex}`);
				console.log('Memory usage after syncing:');
				console.log(getMemoryUsageString());
				console.log("#".repeat(40));
			}
			console.log('Started.');
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