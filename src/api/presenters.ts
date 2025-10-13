import { BlockHeader } from '../BlockHeader.js';

export type BlockHeaderPresented = {
	readonly prevHashHex: string;
	readonly merkleRootHex: string;
	readonly timestamp: number;
	readonly bitsHex: string;
	readonly nonce: number;
	readonly hashHex: string;
	readonly workHex: string;
	readonly workTotalHex: string;
	readonly height: number;
};

export const toBlockHeaderPresented = (header: BlockHeader): BlockHeaderPresented => {
	return {
		prevHashHex: header.prevHashHex,
		merkleRootHex: header.merkleRootHex,
		timestamp: header.timestamp,
		bitsHex: header.bitsHex,
		nonce: header.nonce,
		hashHex: header.hashHex,
		workHex: header.workHex,
		workTotalHex: header.workTotalHex,
		height: header.height,
	};
};