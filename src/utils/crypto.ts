import crypto from 'crypto';

export const sha256 = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest();

export const sha256sha256 = (buffer: Buffer) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(buffer).digest()).digest();