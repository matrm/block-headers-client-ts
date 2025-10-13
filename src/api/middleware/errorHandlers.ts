import { Request, Response, NextFunction } from 'express';

import { unixTime3Decimal } from '../../utils/util.js';

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
	console.error(unixTime3Decimal(), `- Error: ${err.message}`);
	console.error(err.stack);
	res.status(500).json({ error: 'Internal server error' });
};