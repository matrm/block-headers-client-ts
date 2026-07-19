import { Router, Request, Response } from 'express';

import { BlockHeadersClient } from '../../BlockHeadersClient.js';
import { publicRateLimit } from '../middleware/rateLimiter.js';
import { DASHBOARD_APIS_HEADER } from '../middleware/adminAuth.js';
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

	// Dashboard-only snapshot of the block-headers database state (branch counts, orphaned
	// headers, invalid blocks, chain-tip extension progress). Gated by the x-dashboard-apis
	// header only. Not admin-gated because this route is operational/diagnostic and contains no
	// per-peer or sensitive data beyond what the already-public /header/tip exposes.
	router.get('/headers/info', publicRateLimit, (req: Request, res: Response) => {
		if (req.headers[DASHBOARD_APIS_HEADER] !== 'true') {
			res.status(404).send();
			return;
		}
		res.json((client as any)._getHeadersDatabaseInfoForDashboard());
	});

	return router;
};