import { Router, Request, Response } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { publicRateLimit } from '../middleware/rateLimiter.js';
import { toBlockHeaderPresented } from '../presenters.js';

export const createHeaderRoutes = (client: BlockHeadersClient) => {
	const router = Router();

	router.get('/header/:id', publicRateLimit, (req: Request, res: Response) => {
		const rawId = req.params.id;
		const id = (Array.isArray(rawId) ? rawId[0] : rawId).trim();

		if (id === 'tip') {
			const tip = client.getHeaderTip();
			res.json(toBlockHeaderPresented(tip));
			return;
		} else if (/^[0-9a-fA-F]{64}$/.test(id)) {
			const header = client.getHeaderFromHashHex(id);
			if (!header) {
				res.status(404).send();
				return;
			}
			res.json(toBlockHeaderPresented(header));
			return;
		} else if (/^\d+$/.test(id)) {
			const height = parseInt(id);
			const header = client.getHeaderFromHeight(height);
			if (!header) {
				res.status(404).send();
				return;
			}
			res.json(toBlockHeaderPresented(header));
			return;
		}

		res.status(400).send();
	});

	return router;
};