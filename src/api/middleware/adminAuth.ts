import { Request, Response, NextFunction } from 'express';

import { unixTime3Decimal } from '../../utils/util.js';
import config from '../config.js';

// Header used by the dashboard to opt into dashboard-specific API responses
// that may change and are not part of the stable public API.
export const DASHBOARD_APIS_HEADER = 'x-dashboard-apis';
export const ADMIN_API_KEY_HEADER = 'x-admin-api-key';

export const restrictToAdmins = (req: Request, res: Response, next: NextFunction) => {
	if (config.BYPASS_ADMIN_AUTH) {
		config.CONSOLE_DEBUG_LOG && console.log(unixTime3Decimal(), `- Admin auth bypassed for ${req.path} (development mode).`);
		return next();
	}

	const apiKey = req.headers[ADMIN_API_KEY_HEADER] as string | undefined;
	if (!apiKey || !config.ADMIN_API_KEYS.includes(apiKey)) {
		res.status(403).json({ error: 'Admin access required' });
		return;
	}
	next();
};

export const isAdmin = (req: Request): boolean => {
	if (config.BYPASS_ADMIN_AUTH) {
		return true;
	}

	const apiKey = req.headers[ADMIN_API_KEY_HEADER] as string | undefined;
	return !!apiKey && config.ADMIN_API_KEYS.includes(apiKey);
};
