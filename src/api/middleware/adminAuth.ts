import { Request, Response, NextFunction } from 'express';

import { unixTime3Decimal } from '../../utils/util.js';
import config from '../config.js';

export const restrictToAdmins = (req: Request, res: Response, next: NextFunction) => {
	if (config.BYPASS_ADMIN_AUTH) {
		config.CONSOLE_DEBUG_LOG && console.log(unixTime3Decimal(), `- Admin auth bypassed for ${req.path} (development mode).`);
		return next();
	}

	const apiKey = req.headers['x-admin-api-key'] as string | undefined;
	if (!apiKey || !config.ADMIN_API_KEYS.includes(apiKey)) {
		res.status(403).json({ error: 'Admin access required' });
		return;
	}
	next();
};