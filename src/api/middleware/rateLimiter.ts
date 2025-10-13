import rateLimit from 'express-rate-limit';

export const publicRateLimit = rateLimit({
	windowMs: 60 * 1000,
	max: 180,
	message: 'Too many requests from this IP, please try again later.',
});

export const adminRateLimit = rateLimit({
	windowMs: 60 * 1000,
	max: 180,
	message: 'Too many requests from this IP, please try again later.',
});