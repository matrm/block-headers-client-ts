import { Request, Response, NextFunction } from 'express';

import { unixTime3Decimal } from '../../utils/util.js';
import config from '../config.js';

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
	if (config.CONSOLE_DEBUG_LOG) {
		console.log(unixTime3Decimal(), `- ${req.method} ${req.path} from ${req.ip}.`);
	}
	next();
};