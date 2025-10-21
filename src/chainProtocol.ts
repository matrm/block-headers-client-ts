export type Chain = 'bsv';// | 'bch' | 'xec' | 'btc' | 'bsv-testnet3' | 'bsv-stn' | 'bsv-regtest';

export const INVALID_BLOCKS_BSV: ReadonlySet<string> = new Set<string>([
	'00000000000000000019f112ec0a9982926f1258cdcc558dd7c3b7e5dc7fa148',// BTC block 478559.
	'0000000000000000004626ff6e3b936941d341c5932ece4357eeccac44e6d56c',// BCH block 556767.
]);

const invalidBlocksByChain: ReadonlyMap<Chain, ReadonlySet<string>> = new Map([
	['bsv', INVALID_BLOCKS_BSV],
]);

const magicByChain: ReadonlyMap<Chain, Readonly<Buffer>> = new Map([
	['bsv', Buffer.from('e3e1f3e8', 'hex')],
	// ['bch', Buffer.from('e3e1f3e8', 'hex')],
	// ['xec', Buffer.from('e3e1f3e8', 'hex')],
	// ['btc', Buffer.from('f9beb4d9', 'hex')],
	// ['bsv-testnet3', Buffer.from('f4e5f3f4', 'hex')],
	// ['bsv-stn', Buffer.from('fbcec4f9', 'hex')],
	// ['bsv-regtest', Buffer.from('dab5bffa', 'hex')],
]);

const userAgentByChain: ReadonlyMap<Chain, string> = new Map([
	['bsv', '/Bitcoin SV/'],
]);

const versionByChain: ReadonlyMap<Chain, number> = new Map([
	['bsv', 70016],
]);

export const getInvalidBlocks = (chain: Chain): ReadonlyArray<string> => {
	const value = invalidBlocksByChain.get(chain);
	if (value === undefined) {
		throw new Error(`Unknown chain: ${chain}`);
	}
	return Array.from(value);
}

export const getMagic = (chain: Chain): Readonly<Buffer> => {
	const value = magicByChain.get(chain);
	if (value === undefined) {
		throw new Error(`Unknown chain: ${chain}`);
	}
	return Buffer.from(value);
};

export const getUserAgent = (chain: Chain): string => {
	const value = userAgentByChain.get(chain);
	if (value === undefined) {
		throw new Error(`Unknown chain: ${chain}`);
	}
	return value;
};

export const getVersion = (chain: Chain): number => {
	const value = versionByChain.get(chain);
	if (value === undefined) {
		throw new Error(`Unknown chain: ${chain}`);
	}
	return value;
};