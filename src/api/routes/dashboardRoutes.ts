import { Router, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

import config from '../config.js';

const dashboardHtml = readFileSync(join(process.cwd(), 'src', 'api', 'routes', 'dashboard.html'), 'utf-8')
	.replace('__BYPASS_ADMIN_AUTH__', String(config.BYPASS_ADMIN_AUTH));

export const createDashboardRoutes = () => {
	const router = Router();

	router.get('/', (req: Request, res: Response) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.send(dashboardHtml);
	});

	return router;
};
