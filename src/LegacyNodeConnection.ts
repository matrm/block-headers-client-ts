import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import { BlockHeaderMutable } from './BlockHeader.js';
import { BlockHeadersDatabase } from './BlockHeadersDatabase.js';
import { ConnectionMonitor, INIT_lastKnownConnectionTimeMs } from './ConnectionMonitor.js';
import { IpPort } from './types.js';
import { getMagic, getUserAgent, getVersion, Chain } from './chainProtocol.js';
import { assert, abortableSleepMsThrow, ipPortToString } from './utils/util.js';
import { NodeConnection, NodeConnectionEvents } from './NodeConnection.js';
import { buildGetHeadersPayload, buildMessage, buildVersionPayload, parseAddrPayload, parseInvPayload, parseMessages, readVarInt } from './p2p/messages.js';

export class LegacyNodeConnection extends EventEmitter<NodeConnectionEvents> implements NodeConnection {
	private static existingNodeConnectionsStrings = new Set<string>();

	private readonly _ip: string;
	private readonly _port: number;
	private readonly _magic: Buffer;
	private readonly _userAgent: string;
	private readonly _version: number;
	private readonly _defaultTimeoutMs: number = 8 * 1000;
	private readonly _defaultGetAddrTimeoutMs: number = 2 * 60 * 1000;
	private readonly _blockHeadersDatabase: BlockHeadersDatabase;
	private readonly _connectionMonitor: ConnectionMonitor;
	private readonly _startingTipHashHex: string;
	private _tipHashHex: string;// The last known chain tip hash hex seen by this node when syncing headers. Used to check if out of sync by comparing to the headers database chain tip.
	private _enableConsoleDebugLog: boolean = false;
	private _socket?: net.Socket;
	private _buffer: Buffer = Buffer.alloc(0);
	private _verackSent: boolean = false;
	private _wasConnected: boolean = false;// For classifying disconnects as before/after a complete connect().
	private _pingIntervalAbortController = new AbortController();
	private _pingIntervalId: NodeJS.Timeout | null = null;
	private _pendingConnect: {
		promise: Promise<void>;
		resolve: () => void;
		reject: (err: Error) => void;
		timeout: NodeJS.Timeout;
	} | null = null;
	private _pendingPongs: Map<string, {
		resolve: (durationMs: number) => void;
		reject: (err: Error) => void;
		timeout: NodeJS.Timeout;
		startTimeMs: number;
	}> = new Map();
	private _pendingGetHeaders: {
		resolve: (headers: BlockHeaderMutable[]) => void;
		reject: (err: Error) => void;
		timeout: NodeJS.Timeout;
	} | null = null;
	private _pendingGetAddr: {
		promise: Promise<IpPort[]>;
		resolve: (peers: IpPort[]) => void;
		reject: (err: Error) => void;
		timeout: NodeJS.Timeout;
	} | null = null;
	private _syncingHeaders: boolean = false;
	private _syncHeadersQueue = Promise.resolve();

	constructor({ ip, port, chain, blockHeadersDatabase, connectionMonitor, enableConsoleDebugLog, defaultTimeoutMs, defaultGetAddrTimeoutMs }: {
		ip: string;
		port: number;
		chain: Chain;
		blockHeadersDatabase: BlockHeadersDatabase;
		connectionMonitor: ConnectionMonitor;
		enableConsoleDebugLog?: boolean;
		defaultTimeoutMs?: number;
		defaultGetAddrTimeoutMs?: number;
	}) {
		const ipPortString = ipPortToString({ ip, port });
		if (LegacyNodeConnection.existingNodeConnectionsStrings.has(ipPortString)) {
			throw new Error('NodeConnection already exists');
		}
		LegacyNodeConnection.existingNodeConnectionsStrings.add(ipPortString);

		super();
		this._ip = ip;
		this._port = port;
		this._magic = getMagic(chain);
		this._userAgent = getUserAgent(chain);
		this._version = getVersion(chain);
		this._blockHeadersDatabase = blockHeadersDatabase;
		this._startingTipHashHex = blockHeadersDatabase.getHeaderFromHeight(0)!.hashHex;
		this._tipHashHex = this._startingTipHashHex;
		this._connectionMonitor = connectionMonitor;
		this._enableConsoleDebugLog = !!enableConsoleDebugLog;
		this._defaultTimeoutMs = defaultTimeoutMs || this._defaultTimeoutMs;
		this._defaultGetAddrTimeoutMs = defaultGetAddrTimeoutMs || this._defaultGetAddrTimeoutMs;
	}

	[Symbol.dispose] = (): void => {
		this._enableConsoleDebugLog && console.log('NodeConnection', this.getIpPort(), 'disposing.');
		this._clearPingInterval();
		this._pingIntervalAbortController.abort();
		this._disconnectNoEmit();
		LegacyNodeConnection.existingNodeConnectionsStrings.delete(this.getIpPortString());
	}

	getIpPort = (): IpPort => {
		return {
			ip: this._ip,
			port: this._port
		};
	}

	getIpPortString = (): string => {
		return ipPortToString(this.getIpPort());
	}

	getDefaultTimeoutMs = (): number => {
		return this._defaultTimeoutMs;
	}

	getDefaultGetAddrTimeoutMs = (): number => {
		return this._defaultGetAddrTimeoutMs;
	}

	private _setPingInterval = (): void => {
		if (this._pingIntervalId !== null) {
			return;
		}
		this._pingIntervalAbortController = new AbortController();
		let lastPingIntervalTimeMs = INIT_lastKnownConnectionTimeMs;
		assert(INIT_lastKnownConnectionTimeMs <= 0);
		this._pingIntervalId = setInterval(async () => {
			if (!this.connected()) {
				return;
			}
			if (this._pingIntervalAbortController.signal.aborted) {
				return;
			}
			if (this._connectionMonitor.getTimeSinceLastKnownConnectionMs() < 1000 &&
				performance.now() - lastPingIntervalTimeMs < 10 * 60 * 1000) {// Still ping every 10 minutes to test connection.
				// The main purpose of pinging is to update the last known connection time, so
				// it isn't necessary to ping frequently if the last known connection time is recent enough.
				return;
			}
			await this.ping({ signal: this._pingIntervalAbortController.signal }).catch(() => {
				this._enableConsoleDebugLog && console.log('Failed to ping', this.getIpPort());
			});
			lastPingIntervalTimeMs = performance.now();
		}, this._connectionMonitor.getIntervalMs());
	}

	private _clearPingInterval = (): void => {
		if (this._pingIntervalId === null) {
			return;
		}
		this._enableConsoleDebugLog && console.log('Clearing ping interval of', this.getIpPort());
		clearInterval(this._pingIntervalId);
		this._pingIntervalId = null;
	}

	private _sendMessage = (command: string, payload: Buffer): void => {
		if (!this._socket) {
			throw new Error('Not connected');
		}
		if (this._pendingConnect) {
			throw new Error('Connection is pending');
		}
		const msg = buildMessage(this._magic, command, payload);
		this._socket.write(msg);
	}

	private _handleMessage({ command, payload }: { command: string; payload: Buffer }): void {
		if (command === 'version' && !this._verackSent && this._pendingConnect) {
			this._socket!.write(buildMessage(this._magic, 'verack', Buffer.alloc(0)));
			this._verackSent = true;
		} else if (command === 'verack' && this._verackSent && this._pendingConnect) {
			clearTimeout(this._pendingConnect.timeout);
			this._setPingInterval();
			const { resolve } = this._pendingConnect;
			this._pendingConnect = null;
			this._wasConnected = true;
			this.emit('connect');
			resolve();
		} else if (command === 'pong' && this._pendingPongs.size > 0) {
			const nonceHex = payload.toString('hex');
			const pending = this._pendingPongs.get(nonceHex);
			if (pending) {
				clearTimeout(pending.timeout);
				this._pendingPongs.delete(nonceHex);
				const durationMs = performance.now() - pending.startTimeMs;
				this.emit('pong', durationMs, nonceHex);
				pending.resolve(durationMs);
			}
		} else if (command === 'headers' && this._pendingGetHeaders) {
			try {
				const { value: count, length: varIntLength } = readVarInt(payload);
				let offset = varIntLength;
				const headers: BlockHeaderMutable[] = [];
				for (let i = 0; i < count && offset + 80 <= payload.length; i++) {
					const headerBuffer = payload.subarray(offset, offset + 80);
					headers.push(BlockHeaderMutable.fromBuffer(headerBuffer));
					offset += 80;
					if (offset >= payload.length) {
						throw new Error('Invalid headers payload: no space for varint');
					}
					const { length } = readVarInt(payload.subarray(offset));
					offset += length;
				}
				if (this._pendingGetHeaders) {
					clearTimeout(this._pendingGetHeaders.timeout);
					const { resolve } = this._pendingGetHeaders;
					this._pendingGetHeaders = null;
					resolve(headers);
				}
			} catch (error) {
				if (this._pendingGetHeaders) {
					clearTimeout(this._pendingGetHeaders.timeout);
					const { reject } = this._pendingGetHeaders;
					this._pendingGetHeaders = null;
					reject(error instanceof Error ? error : new Error('Failed to parse headers payload'));
				}
			}
		} else if (command === 'addr') {
			try {
				const peers = parseAddrPayload(payload);
				if (this._pendingGetAddr) {
					clearTimeout(this._pendingGetAddr.timeout);
					const { resolve } = this._pendingGetAddr;
					this._pendingGetAddr = null;
					resolve(peers);
				} else {
					// Sometimes emits only the connected node.
					// This code could be changed to filter out this._ip.
					this.emit('addr', peers);
				}
			} catch (error) {
				if (this._pendingGetAddr) {
					clearTimeout(this._pendingGetAddr.timeout);
					const { reject } = this._pendingGetAddr;
					this._pendingGetAddr = null;
					reject(error instanceof Error ? error : new Error('Failed to parse addr payload'));
				}
			}
		} else if (command === 'inv') {
			try {
				const blockHashes = parseInvPayload(payload);
				if (blockHashes.length > 0) {
					this.emit('block_hashes', blockHashes);
				}
			} catch (error) {
				console.error('Error parsing inv payload:', error);
			}
		} else if (command === 'ping') {
			// Respond to pings to keep the connection alive.
			this._sendMessage('pong', payload);
		}
	}

	connect = async ({ timeoutMs, signal }: {
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {}): Promise<void> => {
		timeoutMs = timeoutMs || this._defaultTimeoutMs;
		if (timeoutMs <= 0) throw new Error('Timeout must be greater than 0');
		if (this._socket && !this._pendingConnect) return;// Already connected.
		if (signal?.aborted) throw new Error('Aborted');
		if (this._pendingConnect) return this._pendingConnect.promise;// Return existing promise.

		this._wasConnected = false;

		{
			let resolveFunc: () => void;
			let rejectFunc: (err: Error) => void;
			const promise = new Promise<void>((resolve, reject) => {
				resolveFunc = resolve;
				rejectFunc = reject;
			});
			const timeout = setTimeout(() => {
				if (this._pendingConnect) {
					// Set pending = null here otherwise this._disconnectNoEmit() will
					// call reject without the timed out error.
					this._pendingConnect = null;

					this._disconnectNoEmit();
					this.emit('disconnect_unintentional_before_connect');
					rejectFunc!(new Error('Connection timed out'));
				}
			}, timeoutMs);
			this._pendingConnect = { promise, resolve: resolveFunc!, reject: rejectFunc!, timeout };
		}

		const currentSocket = this._socket = net.connect(this._port, this._ip, () => {
			const versionPayload = buildVersionPayload({
				version: this._version,
				userAgent: this._userAgent,
				ip: this._ip
			});
			this._socket!.write(buildMessage(this._magic, 'version', versionPayload));
		});

		currentSocket.on('data', (data) => {
			// Assert event listeners were cleared before a new socket was created.
			assert(this._socket === currentSocket);

			this._connectionMonitor.updateLastKnownConnectionTime();

			this._buffer = Buffer.concat([this._buffer, data]);
			const { messages, remaining, errors } = parseMessages(this._buffer, this._magic);
			this._buffer = remaining;

			// Handle parseMessages errors.
			for (const error of errors) {
				if (this._pendingConnect && (error.command === 'version' || error.command === 'verack')) {
					const { reject } = this._pendingConnect;
					clearTimeout(this._pendingConnect.timeout);
					this._pendingConnect = null;
					reject(new Error(error.message));
				} else if (this._pendingPongs.size > 0 && error.command === 'pong') {
					// Let the ping that has an error timeout. Alternative strategies below:

					// Clear oldest ping (may get the wrong one if pings are out of order).
					// const nonceHex = this._pendingPongs.keys().next().value;
					// const pending = this._pendingPongs.get(nonceHex!);
					// if (pending) {
					// 	clearTimeout(pending.timeout);
					// 	this._pendingPongs.delete(nonceHex!);
					// 	pending.reject(new Error(error.message));
					// }

					// Clear all pings for safety (will cause unrelated pings to get an error too).
					// for (const pendingPong of this._pendingPongs.values()) {
					// 	clearTimeout(pendingPong.timeout);
					// }
					// const pendingPongsRejects = Array.from(this._pendingPongs.values()).map(({ reject }) => reject);
					// this._pendingPongs.clear();
					// pendingPongsRejects.forEach(reject => reject(new Error(error.message)));
				} else if (this._pendingGetHeaders && error.command === 'headers') {
					const { reject } = this._pendingGetHeaders;
					clearTimeout(this._pendingGetHeaders.timeout);
					this._pendingGetHeaders = null;
					reject(new Error(error.message));
				} else if (this._pendingGetAddr && error.command === 'addr') {
					const { reject } = this._pendingGetAddr;
					clearTimeout(this._pendingGetAddr.timeout);
					this._pendingGetAddr = null;
					reject(new Error(error.message));
				}
			}

			// Process only messages that are valid.
			for (const message of messages) {
				this._handleMessage(message);
			}

			if (messages.length) {
				this.emit('data');//, data);
			}
		});

		currentSocket.on('error', (error) => {
			this._enableConsoleDebugLog && console.log('Socket error for', this.getIpPort(), ':', error.message);

			// Assert event listeners were cleared before a new socket was created.
			assert(this._socket === currentSocket);

			const wasConnected = this._wasConnected;// Reset to false in _disconnectNoEmit().
			this._disconnectNoEmit();
			if (wasConnected) {
				this.emit('disconnect_unintentional_after_connect');
			} else {
				this.emit('disconnect_unintentional_before_connect');
			}
		});

		currentSocket.on('close', () => {
			this._enableConsoleDebugLog && console.log('Socket closed unexpectedly for', this.getIpPort());

			// Assert event listeners were cleared before a new socket was created.
			assert(this._socket === currentSocket);

			const wasConnected = this._wasConnected;// Reset to false in _disconnectNoEmit().
			this._disconnectNoEmit();
			if (wasConnected) {
				this.emit('disconnect_unintentional_after_connect');
			} else {
				this.emit('disconnect_unintentional_before_connect');
			}
		});

		if (signal) {
			const abortListener = () => {
				this._enableConsoleDebugLog && console.log('Aborting connection', this._ip, this._port);
				this.disconnect();
			};
			signal.addEventListener('abort', abortListener, { once: true });
			this._pendingConnect.promise = this._pendingConnect.promise.finally(() => {
				signal.removeEventListener('abort', abortListener);
			});
		}

		return this._pendingConnect.promise;
	}

	ping = async ({ timeoutMs, signal }: {
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {}): Promise<number> => {
		timeoutMs = timeoutMs || this._defaultTimeoutMs;
		if (timeoutMs <= 0) throw new Error('Timeout must be greater than 0');
		if (!this.connected()) throw new Error('Not connected');
		if (signal?.aborted) throw new Error('Aborted');

		const startTimeMs = performance.now();
		const nonce = crypto.randomBytes(8);
		const nonceHex = nonce.toString('hex');
		let promise = new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this._pendingPongs.delete(nonceHex);
				this._disconnectNoEmit();
				this.emit('disconnect_unintentional_after_connect');
				reject(new Error('Ping timed out'));
			}, timeoutMs);
			this._pendingPongs.set(nonceHex, { resolve, reject, timeout, startTimeMs });
			try {
				this._sendMessage('ping', nonce);
			} catch (error) {
				clearTimeout(timeout);
				this._pendingPongs.delete(nonceHex);
				reject(error);
			}
		});

		if (signal) {
			const abortListener = () => {
				const pending = this._pendingPongs.get(nonceHex);
				if (pending) {
					this._enableConsoleDebugLog && console.log(`Aborting ${nonceHex} ping`, this._ip, this._port);
					clearTimeout(pending.timeout);
					this._pendingPongs.delete(nonceHex);
					pending.reject(new Error('Aborted'));
				}
			};
			signal.addEventListener('abort', abortListener, { once: true });
			promise = promise.finally(() => {
				signal.removeEventListener('abort', abortListener);
			});
		}

		return promise;
	}

	getHeaders = async ({ from, to, timeoutMs, signal }: {
		from: Buffer[];
		to?: Buffer;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<BlockHeaderMutable[]> => {
		timeoutMs = timeoutMs || this._defaultTimeoutMs;
		if (from.length === 0) throw new Error('At least one "from" hash is required');
		for (const hash of from) {
			if (!Buffer.isBuffer(hash) || hash.length !== 32) throw new Error('Each "from" hash must be a 32-byte buffer');
		}
		if (to && (!Buffer.isBuffer(to) || to.length !== 32)) throw new Error('"to" hash must be a 32-byte buffer');
		if (timeoutMs <= 0) throw new Error('Timeout must be greater than 0');
		if (this._pendingGetHeaders) throw new Error('Another getHeaders request is already pending');
		if (!this.connected()) throw new Error('Not connected');
		if (signal?.aborted) throw new Error('Aborted');

		const payload = buildGetHeadersPayload(this._version, from, to);
		let promise = new Promise<BlockHeaderMutable[]>((resolve, reject) => {
			const timeout = setTimeout(() => {
				// Set pending = null here otherwise this._disconnectNoEmit() will
				// call reject without the timed out error.
				this._pendingGetHeaders = null;

				this._disconnectNoEmit();
				this.emit('disconnect_unintentional_after_connect');
				reject(new Error('getHeaders timed out'));
			}, timeoutMs);
			this._pendingGetHeaders = { resolve, reject, timeout };
			try {
				this._sendMessage('getheaders', payload);
			} catch (error) {
				clearTimeout(timeout);
				this._pendingGetHeaders = null;
				reject(error);
			}
		});

		if (signal) {
			const abortListener = () => {
				if (this._pendingGetHeaders) {
					this._enableConsoleDebugLog && console.log('Aborting getHeaders', this._ip, this._port);
					const { reject } = this._pendingGetHeaders;
					clearTimeout(this._pendingGetHeaders.timeout);
					this._pendingGetHeaders = null;
					reject(new Error('Aborted'));
				}
			};
			signal.addEventListener('abort', abortListener, { once: true });
			promise = promise.finally(() => {
				signal.removeEventListener('abort', abortListener);
			});
		}

		return promise;
	}

	getAddr = async ({ timeoutMs, signal }: {
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {}): Promise<IpPort[]> => {
		timeoutMs = timeoutMs || this._defaultGetAddrTimeoutMs || this._defaultTimeoutMs;
		if (timeoutMs <= 0) throw new Error('Timeout must be greater than 0');
		if (!this.connected()) throw new Error('Not connected');
		if (signal?.aborted) throw new Error('Aborted');
		if (this._pendingGetAddr) return this._pendingGetAddr.promise;// Return existing promise.

		{
			let resolveFunc: (peers: IpPort[]) => void;
			let rejectFunc: (err: Error) => void;
			const promise = new Promise<IpPort[]>((resolve, reject) => {
				resolveFunc = resolve;
				rejectFunc = reject;
			});
			const timeout = setTimeout(() => {
				if (this._pendingGetAddr) {
					this._pendingGetAddr = null;
					this._disconnectNoEmit();
					this.emit('disconnect_unintentional_after_connect');
					rejectFunc!(new Error('getAddr timed out'));
				}
			}, timeoutMs);
			this._pendingGetAddr = { promise, resolve: resolveFunc!, reject: rejectFunc!, timeout };

			try {
				this._sendMessage('getaddr', Buffer.alloc(0));
			} catch (error) {
				clearTimeout(timeout);
				this._pendingGetAddr = null;
				throw error;
			}
		}

		if (signal) {
			const abortListener = () => {
				if (this._pendingGetAddr) {
					this._enableConsoleDebugLog && console.log('Aborting getAddr', this._ip, this._port);
					const { reject } = this._pendingGetAddr;
					clearTimeout(this._pendingGetAddr.timeout);
					this._pendingGetAddr = null;
					reject(new Error('Aborted'));
				}
			};
			signal.addEventListener('abort', abortListener, { once: true });
			this._pendingGetAddr.promise = this._pendingGetAddr.promise.finally(() => {
				signal.removeEventListener('abort', abortListener);
			});
		}

		return this._pendingGetAddr.promise;
	}

	private _disconnectNoEmit = (): void => {
		if (!this._socket && !this._pendingConnect) return;
		if (this._socket) {
			this._socket.removeAllListeners();// Prevents 'close' and 'error' listeners from being called when destroying the socket.
			this._socket.destroy();
		}
		this._clearPingInterval();
		this._socket = undefined;
		this._verackSent = false;
		this._buffer = Buffer.alloc(0);

		// Setting this to false here will cause failed reconnects to be classified as
		// disconnect_unintentional_before_connect instead of disconnect_unintentional_after_connect.
		this._wasConnected = false;

		if (this._pendingConnect) {
			const { reject } = this._pendingConnect;
			clearTimeout(this._pendingConnect.timeout);
			this._pendingConnect = null;
			reject(new Error(`Connection to ${this.getIpPortString()} closed during a pending connect`));
		}

		{
			const pendingPongsRejects = Array.from(this._pendingPongs.values()).map(({ reject }) => reject);
			for (const pendingPong of this._pendingPongs.values()) {
				clearTimeout(pendingPong.timeout);
			}
			this._pendingPongs.clear();
			pendingPongsRejects.forEach(reject => reject(new Error(`Connection to ${this.getIpPortString()} closed during a pending pong`)));
		}

		if (this._pendingGetHeaders) {
			const { reject } = this._pendingGetHeaders;
			clearTimeout(this._pendingGetHeaders.timeout);
			this._pendingGetHeaders = null;
			reject(new Error(`Connection to ${this.getIpPortString()} closed during a pending getheaders request`));
		}

		if (this._pendingGetAddr) {
			const { reject } = this._pendingGetAddr;
			clearTimeout(this._pendingGetAddr.timeout);
			this._pendingGetAddr = null;
			reject(new Error(`Connection to ${this.getIpPortString()} closed during a pending getaddr request`));
		}
	};

	disconnect = (): void => {
		this._disconnectNoEmit();
		this.emit('disconnect');
	}

	connected = (): boolean => {
		return !!this._socket && !this._pendingConnect;
	}

	onValidChain = async ({ signal }: {
		signal?: AbortSignal;
	} = {}): Promise<boolean> => {
		if (!this.connected()) {
			throw new Error('Not connected');
		}
		if (signal?.aborted) throw new Error('Aborted');

		const invalidBlocksArray = this._blockHeadersDatabase.getInvalidBlocksArray();
		const invalidBlocksUsed: string[] = [];
		for (let i = 0; i < invalidBlocksArray.length; i++) {
			const invalidBlock = invalidBlocksArray[i];
			const invalidBlockBuffer = Buffer.from(invalidBlock, 'hex');
			const headers = await this.getHeaders({ from: [invalidBlockBuffer], signal });
			if (signal?.aborted) throw new Error('Aborted');

			for (const header of headers) {
				if (header.prevHashHex === invalidBlock) {
					this.emit('invalid_blocks', headers);
					return false;
					//this._enableConsoleDebugLog && console.log(`Invalid block ${i} - Found invalid block header:`, header.prevHashHex, 'height:', this._blockHeadersDatabase.getHeightFromHashHex(header.prevHashHex));
					invalidBlocksUsed.push(header.prevHashHex);
					break;
				}
			}
			//this._enableConsoleDebugLog && console.log(`Invalid block ${i} - First downloaded header hash:`, headers[0].hashHex, 'height:', this._blockHeadersDatabase.getHeightFromHashHex(headers[0].hashHex));
			//this._enableConsoleDebugLog && console.log(`Invalid block ${i} - Last downloaded header hash:`, headers[headers.length - 1].hashHex, 'height:', this._blockHeadersDatabase.getHeightFromHashHex(headers[headers.length - 1].hashHex));
		}
		return true;
		//return invalidBlocksUsed;
	}

	private _syncHeaders = async (signal?: AbortSignal): Promise<void> => {
		if (!this.connected()) {
			throw new Error('Not connected');
		}
		if (signal?.aborted) throw new Error('Aborted');

		let waitedForOtherNodeToSync = false;
		let from = this._blockHeadersDatabase.getBlockLocatorHashBuffers();
		while (true) {
			const headers = await this.getHeaders({ from, signal });
			if (signal?.aborted) throw new Error('Aborted');

			if (headers.length === 0) {
				//this._enableConsoleDebugLog && console.log('No headers downloaded by', this.getIpPort());
				if (this._tipHashHex !== this._blockHeadersDatabase.getHeaderTip().hashHex &&
					this._tipHashHex !== this._startingTipHashHex) {
					const chainTipHeight = this._blockHeadersDatabase.getHeaderTip().height;
					const nodeTipHeight = this._blockHeadersDatabase.getHeaderFromHashHex(this._tipHashHex)?.height || 0;
					// This node is allowed to be 100 blocks behind the longest known chain before being considered out of sync.
					if (nodeTipHeight + 100 < chainTipHeight) {
						this._enableConsoleDebugLog && console.log(`Node is ${chainTipHeight - nodeTipHeight} blocks behind the longest known chain:`, this.getIpPort());
						this.emit('out_of_sync');
					}
				}
				break;
			}
			from = [headers[headers.length - 1].hashBuffer];
			const lastTipHashHex = this._tipHashHex;
			this._tipHashHex = headers.at(-1)!.hashHex;

			const result = this._blockHeadersDatabase.addHeaders(headers);
			const nInvalid = result.headersInvalidated.length;
			const nRemoved = result.headersRemovedFromLongestChain.length;
			const nAdded = result.headersAddedToLongestChain.length;

			if (nInvalid > 0) {
				// Node connection may be on the wrong chain despite the chain protocol (version, user againt, magic) being correct.
				this.emit('invalid_blocks', result.headersInvalidated);
				break;
			}

			if (!this._blockHeadersDatabase.getHeaderFromHashHex(this._tipHashHex)) {
				// Downloading headers out of order.
				this._enableConsoleDebugLog && console.log(this.getIpPort(), 'Downloading headers out of order:', 'lastTipHashHex:', lastTipHashHex, 'this._tipHashHex:', this._tipHashHex);
				throw new Error('Downloading headers out of order');
			}

			const headerChainTip = this._blockHeadersDatabase.getHeaderTip();
			const heightChainTip = headerChainTip.height;
			const heightDownloaded = this._blockHeadersDatabase.getHeaderFromHashHex(this._tipHashHex)!.height;
			const downloadedTipInLongestChain = this._blockHeadersDatabase.getHeaderFromHeight(heightDownloaded)!.hashHex === this._blockHeadersDatabase.getHeaderFromHashHex(this._tipHashHex)!.hashHex;// To check for a known reorg.

			this._enableConsoleDebugLog && console.log({
				cH: heightChainTip,
				dlH: heightDownloaded,
				dl: headers.length,
				add: nAdded,
				rem: nRemoved,
				//lastTip: lastTipHashHex.slice(-4),
				//tip: this._tipHashHex.slice(-4)
			}, `${this._ip}`);

			if (nAdded > 0) {
				this.emit('new_chain_tip', heightDownloaded as number, headers[headers.length - 1].hashHex);
			}

			// This hasn't happened yet and shouldn't be needed. If a node is configured to return the
			// last 2000 headers this will prevent an infinite loop. The if statement below that assigns
			// from = this._blockHeadersDatabase.getBlockLocatorHashBuffers() can trigger this if it
			// doesn't check from.length === 1.
			if (nAdded === 0 && lastTipHashHex === this._tipHashHex && from.length === 1) {
				this._enableConsoleDebugLog && console.warn(`${headers.length} duplicate headers downloaded.`);
				break;
			}

			// If this node is 4 iterations behind the fastest syncing node then
			// wait for it to finish syncing before this node continues.
			if (heightDownloaded + headers.length * 4 < heightChainTip && downloadedTipInLongestChain && !waitedForOtherNodeToSync) {
				// This could be a reorg that hasn't diverged yet because it started at an
				// early block locator hash or it could also be a slow syncing node.
				this._enableConsoleDebugLog && console.log(this.getIpPort(), `is temporarily ${heightChainTip - heightDownloaded} blocks behind the longest known chain.`);

				// Sleep until the chain tip stops being extended for 5 seconds.
				// This is to save data while doing the initial sync.
				let timeSinceLastChainTipExtension = this._blockHeadersDatabase.getTimeSinceLastChainTipExtensionThisSessionMs();
				if (timeSinceLastChainTipExtension === undefined) {
					continue;
				}
				this._enableConsoleDebugLog && console.log(this.getIpPort(), 'waiting for chain tip to stop being extended before continuing sync.');
				while (timeSinceLastChainTipExtension! < 5000) {
					await abortableSleepMsThrow(500, signal);
					if (!this.connected()) {
						throw new Error('Not connected');
					}
					timeSinceLastChainTipExtension = this._blockHeadersDatabase.getTimeSinceLastChainTipExtensionThisSessionMs();
				}
				this._enableConsoleDebugLog && console.log(this.getIpPort(), 'finished waiting for chain tip to stop being extended.');

				// Only reset from to block locator hashes once in case its alarge reorg to prevent
				// it from being reset again.
				waitedForOtherNodeToSync = true;

				from = this._blockHeadersDatabase.getBlockLocatorHashBuffers();
				this._tipHashHex = this._startingTipHashHex;// Reset this node's tip hash so it doesn't get considered for being out of sync.
			}
		}
	}

	syncHeaders = async ({ signal }: {
		signal?: AbortSignal;
	} = {}): Promise<void> => {
		if (this._syncingHeaders) {
			return this._syncHeadersQueue;
		}
		this._syncHeadersQueue = this._syncHeadersQueue
			.then(async () => {
				assert(!this._syncingHeaders);
				this._syncingHeaders = true;
				await this._syncHeaders(signal);
			})
			.catch((error) => {
				// Reset this node's tip hash so it doesn't get considered for being out of sync on
				// the next syncHeaders call since the previous one (this one) failed.
				this._tipHashHex = this._startingTipHashHex;
				throw error;
			})
			.finally(() => {
				this._syncingHeaders = false;
			});
		return this._syncHeadersQueue;
	}
}