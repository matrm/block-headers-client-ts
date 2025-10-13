import { EventEmitter } from 'events';
import { BlockHeaderMutable } from './BlockHeader.js';
import { IpPort } from './types.js';

export interface NodeConnectionEvents {
	'data': [];//[buffer: Buffer];
	'addr': [addrs: IpPort[]];// Not including getAddr() usually.
	'block_hashes': [hashes: Buffer[]];
	'new_chain_tip': [height: number, hashHex: string];
	'out_of_sync': [];
	'invalid_blocks': [invalidHeaders: BlockHeaderMutable[]];
	'pong': [durationMs: number, nonceHex: string];
	'connect': [];
	'disconnect': [];// For connect() abort and manual calls to this.disconnect().
	'disconnect_unintentional_before_connect': [];// Including connect() timeout.
	'disconnect_unintentional_after_connect': [];
}

export interface NodeConnection extends EventEmitter<NodeConnectionEvents> {
	[Symbol.dispose](): void;
	getIpPort(): IpPort;
	getIpPortString(): string;
	getDefaultTimeoutMs(): number;
	getDefaultGetAddrTimeoutMs(): number;
	connect(options?: { timeoutMs?: number; signal?: AbortSignal; }): Promise<void>;
	ping(options?: { timeoutMs?: number; signal?: AbortSignal; }): Promise<number>;
	getHeaders(options: { from: Buffer[]; to?: Buffer; timeoutMs?: number; signal?: AbortSignal; }): Promise<BlockHeaderMutable[]>;
	getAddr(options?: { timeoutMs?: number; signal?: AbortSignal; }): Promise<IpPort[]>;
	disconnect(): void;
	connected(): boolean;
	onValidChain(options?: { signal?: AbortSignal; }): Promise<boolean>;
	syncHeaders(options?: { signal?: AbortSignal; }): Promise<void>;
}