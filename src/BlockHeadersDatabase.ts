import { Level, BatchOperation } from 'level';

import { BlockHeaderMutable, HEADER_BUFFER_LENGTH, getPrevHashHexFromBuffer, getWorkFromBuffer, getVerifiedWorkFromBuffer } from './BlockHeader.js';
import { sha256sha256 } from './utils/crypto.js';
import { assert } from './utils/util.js';

const BITCOIN_GENESIS_HEADER_HEX = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const BITCOIN_GENESIS_HEADER_HASH_HEX = BlockHeaderMutable.fromHex(BITCOIN_GENESIS_HEADER_HEX).hashHex;
assert(BITCOIN_GENESIS_HEADER_HASH_HEX === '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');

// A header that was removed from the longest chain. Kept lightweight because removed headers
// are only used for LevelDB deletes (height) and chain-change reporting (hashHex). Constructing
// full BlockHeaderMutable objects here would require re-hashing headers whose hash is already known.
type RemovedHeader = {
	height: number;
	hashHex: string;
};

type AddHeadersChanges = {
	headersRemovedFromLongestChain: RemovedHeader[];// Headers that were previously part of the longest chain but are no longer included due to a reorganization.
	headersAddedToLongestChain: BlockHeaderMutable[];// Headers that are newly added into the longest chain.
	headersInvalidated: BlockHeaderMutable[];// Headers that are deemed invalid by being in this._invalidBlocks or after them.
};

type ForkHeader = {
	buffer: Buffer;
	height: number;
	workTotal: bigint;
};

type LevelDbHeaders = Level<number, Buffer>;
type LevelDbHeadersBatch = BatchOperation<LevelDbHeaders, number, Buffer>[];

// Longest chain headers are packed into chunk buffers that each hold this many headers.
// 12500 * 80 = 1,000,000 bytes per chunk.
export const HEADERS_PER_CHUNK = 12500;
// Cumulative work is checkpointed every this many longest chain heights. Lower values make
// workTotal lookups faster and use more memory. Higher values trade the other way.
// 64 keeps historical workTotal lookups well under 0.1ms and costs around 1MB per million headers.
export const WORK_CHECKPOINT_INTERVAL = 64;

const createLevelDbBatchArray = (removed: RemovedHeader[], added: BlockHeaderMutable[]): LevelDbHeadersBatch => {
	const batch: LevelDbHeadersBatch = [];
	removed.forEach((header) => {
		batch.push({
			type: 'del',
			key: header.height
		})
	})
	added.forEach((header) => {
		batch.push({
			type: 'put',
			key: header.height,
			value: header.buffer
		})
	})
	return batch;
}

export class BlockHeadersDatabase {
	private readonly _invalidBlocks: Set<string>;
	// Longest chain header bytes, packed at height * HEADER_BUFFER_LENGTH across fixed-size chunks.
	// This avoids a per-header Buffer object.
	private readonly _chunks: Buffer[] = [];
	private readonly _hashToHeight: Map<string, number>;
	private _heightToHash: string[];// Longest chain hash at each height. The index is the height.
	// Headers that are not part of the longest chain. They are pruned by pruneBranches().
	private readonly _forkHeaders: Map<string, ForkHeader> = new Map();
	private readonly _headersTreeLeafHashes: Set<string>;// Hashes of headers without children (branch tips).
	private readonly _workCheckpoints: bigint[];// Cumulative work of the longest chain at heights that are multiples of WORK_CHECKPOINT_INTERVAL.
	private _tipWorkTotal: bigint;
	private _levelDbHeaders: LevelDbHeaders;
	private _levelDbHeadersSaveQueue: Promise<void> = Promise.resolve();
	private _addHeadersChangesLevelDbSaveQueue: AddHeadersChanges[] = [];
	private _lastTimeChainTipExtendedMs: number | undefined;
	private readonly _enableConsoleDebugLog: boolean;

	private constructor({ databasePath, invalidBlocks, enableConsoleDebugLog }: {
		databasePath: string;
		invalidBlocks: Set<string>;
		enableConsoleDebugLog?: boolean;
	}) {
		this._enableConsoleDebugLog = !!enableConsoleDebugLog;
		this._invalidBlocks = invalidBlocks;

		const genesisHeader = BlockHeaderMutable.fromHex(BITCOIN_GENESIS_HEADER_HEX);
		this._writeHeaderBufferAtHeight(genesisHeader.buffer, 0);
		this._hashToHeight = new Map([
			[genesisHeader.hashHex, 0]
		]);
		this._heightToHash = [genesisHeader.hashHex];
		this._headersTreeLeafHashes = new Set([genesisHeader.hashHex]);
		this._workCheckpoints = [genesisHeader.work];
		this._tipWorkTotal = genesisHeader.work;

		this._levelDbHeaders = new Level(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
	}

	/**
	 * Creates a new BlockHeadersDatabase instance from the genesis block.
	 * @param options - Configuration options for creating the BlockHeadersDatabase.
	 * @param options.databasePath - The path to the database.
	 * @param options.invalidBlocks - An array of invalid block hashes.
	 * @returns A new BlockHeadersDatabase instance.
	 */
	static fromGenesis = ({ databasePath, invalidBlocks, enableConsoleDebugLog }: {
		databasePath: string;
		invalidBlocks: string[];
		enableConsoleDebugLog?: boolean;
	}): BlockHeadersDatabase => {
		return new BlockHeadersDatabase({ databasePath, invalidBlocks: new Set(invalidBlocks), enableConsoleDebugLog });
	}

	/**
	 * Creates a new BlockHeadersDatabase instance from a LevelDB database.
	 * @param options - Configuration options for creating the BlockHeadersDatabase.
	 * @param options.databasePath - The path to the database.
	 * @param options.invalidBlocks - An array of invalid block hashes.
	 * @param options.enableConsoleDebugLog - Whether to enable debug logging (optional).
	 * @returns A new BlockHeadersDatabase instance.
	 */
	static fromDatabase = async ({ databasePath, invalidBlocks, enableConsoleDebugLog }: {
		databasePath: string;
		invalidBlocks: string[];
		enableConsoleDebugLog?: boolean;
	}): Promise<BlockHeadersDatabase> => {
		const blockHeadersDatabase = new BlockHeadersDatabase({ databasePath, invalidBlocks: new Set(invalidBlocks), enableConsoleDebugLog });

		try {
			const startTimeMs = performance.now();
			// First pass over only the keys to find the tip height, which the packed chunk storage
			// must be sized for, and to verify that every height is present.
			let numHeadersLoaded = 0;
			let maxHeight = 0;
			for await (const height of blockHeadersDatabase._levelDbHeaders.keys()) {
				if (!Number.isSafeInteger(height) || height < 1) {
					throw new Error(`Invalid header height in database: ${height}`);
				}
				if (height > maxHeight) {
					maxHeight = height;
				}
				numHeadersLoaded++;
			}
			if (numHeadersLoaded !== maxHeight) {
				throw new Error(`Missing header in database: loaded ${numHeadersLoaded} headers with a tip height of ${maxHeight}`);
			}
			// Chunk 0 already exists because the constructor wrote the genesis header into it.
			for (let i = 1; i <= Math.floor(maxHeight / HEADERS_PER_CHUNK); i++) {
				blockHeadersDatabase._chunks.push(Buffer.allocUnsafe(HEADERS_PER_CHUNK * HEADER_BUFFER_LENGTH));
			}
			blockHeadersDatabase._heightToHash.length = maxHeight + 1;// Keeps the genesis header at height 0.

			for await (const [height, headerBuffer] of blockHeadersDatabase._levelDbHeaders.iterator()) {
				if (headerBuffer.length !== HEADER_BUFFER_LENGTH) {
					throw new Error(`Invalid header buffer length in database: ${headerBuffer.length}`);
				}
				blockHeadersDatabase._writeHeaderBufferAtHeight(headerBuffer, height);
				const hashHex = sha256sha256(headerBuffer).reverse().toString('hex');
				blockHeadersDatabase._heightToHash[height] = hashHex;
				blockHeadersDatabase._hashToHeight.set(hashHex, height);
			}
			const databaseReadDurationMs = performance.now() - startTimeMs;

			// Stored headers are not trusted: chain continuity, invalid blocks and proofs of work
			// are all verified here. Stale entries past a truncation point are deleted from LevelDB.
			const workStartTimeMs = performance.now();
			let cumulativeWork = blockHeadersDatabase._workCheckpoints[0];
			let tipHeight = maxHeight;
			for (let height = 1; height <= maxHeight; height++) {
				const buffer = blockHeadersDatabase._getHeaderBufferFromHeight(height)!;
				if (getPrevHashHexFromBuffer(buffer) !== blockHeadersDatabase._heightToHash[height - 1]) {
					console.error(`Headers database is missing chain continuity at height ${height}. Truncating at height ${height - 1}.`);
					await blockHeadersDatabase._truncateFromHeight(height, maxHeight);
					tipHeight = height - 1;
					break;
				}
				const hashHex = blockHeadersDatabase._heightToHash[height];
				if (blockHeadersDatabase._invalidBlocks.has(hashHex)) {
					console.error(`Headers database contains invalid block ${hashHex} at height ${height}. Truncating at height ${height - 1}.`);
					await blockHeadersDatabase._truncateFromHeight(height, maxHeight);
					tipHeight = height - 1;
					break;
				}
				let work: bigint;
				try {
					work = getVerifiedWorkFromBuffer(buffer, hashHex);
				} catch {
					throw new Error(`Invalid proof of work in database at height ${height} (hash ${hashHex})`);
				}
				cumulativeWork += work;
				if (height % WORK_CHECKPOINT_INTERVAL === 0) {
					blockHeadersDatabase._workCheckpoints.push(cumulativeWork);
				}
			}
			blockHeadersDatabase._tipWorkTotal = cumulativeWork;
			blockHeadersDatabase._headersTreeLeafHashes.clear();
			blockHeadersDatabase._headersTreeLeafHashes.add(blockHeadersDatabase._heightToHash[tipHeight]);
			blockHeadersDatabase._trimChunksToChainLength();

			enableConsoleDebugLog && console.log(`Loaded ${tipHeight} headers from database file after ${databaseReadDurationMs}ms.`);
			enableConsoleDebugLog && console.log(`Computed work totals for ${tipHeight} headers after ${performance.now() - workStartTimeMs}ms.`);
			enableConsoleDebugLog && console.log(`Longest chain height: ${tipHeight}.`);
			return blockHeadersDatabase;
		} catch (error) {
			// The LevelDB handle auto-opened during the load, so close it to avoid leaking
			// the file lock when the load fails.
			await blockHeadersDatabase._levelDbHeaders.close().catch(() => { /* Already closed or never opened. */ });
			throw error;
		}
	}

	/**
	 * Opens the database.
	 */
	open = async (): Promise<void> => {
		await this._levelDbHeaders.open();
	}

	/**
	 * Closes the database.
	 */
	close = async (): Promise<void> => {
		// LevelDB .close() doesn't wait for pending writes to finish.
		// So we use a queue to wait for them to finish here.
		await this._levelDbHeadersSaveQueue;

		await this._levelDbHeaders.close();
	}

	/**
	 * Closes the database.
	 */
	[Symbol.asyncDispose] = async (): Promise<void> => {
		await this.close();
	}

	// Removes the in-memory chain and forks at and above fromHeight and deletes the
	// corresponding LevelDB entries so stale data is not reloaded on the next startup.
	private _truncateFromHeight = async (fromHeight: number, maxHeight: number): Promise<void> => {
		for (let height = fromHeight; height <= maxHeight; height++) {
			this._hashToHeight.delete(this._heightToHash[height]);
		}
		this._heightToHash.length = fromHeight;
		if (fromHeight > maxHeight) {
			return;
		}
		const batch: LevelDbHeadersBatch = [];
		for (let height = fromHeight; height <= maxHeight; height++) {
			batch.push({
				type: 'del',
				key: height
			});
		}
		await this._levelDbHeaders.batch(batch);
	};

	private _writeHeaderBufferAtHeight = (buffer: Buffer, height: number): void => {
		const chunkIndex = Math.floor(height / HEADERS_PER_CHUNK);
		while (this._chunks.length <= chunkIndex) {
			this._chunks.push(Buffer.allocUnsafe(HEADERS_PER_CHUNK * HEADER_BUFFER_LENGTH));
		}
		buffer.copy(this._chunks[chunkIndex], (height % HEADERS_PER_CHUNK) * HEADER_BUFFER_LENGTH);
	};

	private _getHeaderBufferFromHeight = (height: number): Buffer | undefined => {
		if (height < 0 || height >= this._heightToHash.length) {
			return undefined;
		}
		const chunk = this._chunks[Math.floor(height / HEADERS_PER_CHUNK)];
		if (!chunk) {
			return undefined;
		}
		const offset = (height % HEADERS_PER_CHUNK) * HEADER_BUFFER_LENGTH;
		return chunk.subarray(offset, offset + HEADER_BUFFER_LENGTH);
	};

	// Releases packed chunks above the longest chain. A reorg to a shorter chain leaves the
	// chunks for the abandoned heights allocated unless they are dropped here.
	private _trimChunksToChainLength = (): void => {
		const numChunksNeeded = Math.floor((this._heightToHash.length - 1) / HEADERS_PER_CHUNK) + 1;
		if (this._chunks.length > numChunksNeeded) {
			this._chunks.length = numChunksNeeded;
		}
	};

	private _createHeaderFromBuffer = (buffer: Buffer, height: number, workTotal: bigint): BlockHeaderMutable => {
		// Proof of work was already validated before the header entered the database.
		const header = BlockHeaderMutable.fromBuffer(buffer, true);
		header.setHeight(height);
		header.setWorkTotal(workTotal);
		return header;
	};

	private _getHeightFromHashHex = (hashHex: string): number | undefined => {
		const height = this._hashToHeight.get(hashHex);
		if (height !== undefined) {
			return height;
		}
		return this._forkHeaders.get(hashHex)?.height;
	};

	private _getWorkTotalFromHashHex = (hashHex: string): bigint | undefined => {
		const height = this._hashToHeight.get(hashHex);
		if (height !== undefined) {
			return this._getWorkTotalFromHeight(height);
		}
		return this._forkHeaders.get(hashHex)?.workTotal;
	};

	private _getWorkTotalFromHeight = (height: number): bigint => {
		if (height === this._heightToHash.length - 1) {
			return this._tipWorkTotal;
		}
		const checkpointIndex = Math.floor(height / WORK_CHECKPOINT_INTERVAL);
		let workTotal = this._workCheckpoints[checkpointIndex];
		for (let h = checkpointIndex * WORK_CHECKPOINT_INTERVAL + 1; h <= height; h++) {
			workTotal += getWorkFromBuffer(this._getHeaderBufferFromHeight(h)!);
		}
		return workTotal;
	};

	// Assumes newHeaders are sorted but will not throw an error if they aren't.
	private _insert = (newHeaders: BlockHeaderMutable[]): AddHeadersChanges => {
		const headersInvalidated: BlockHeaderMutable[] = [];
		newHeaders = newHeaders.filter(header => !this._hashToHeight.has(header.hashHex) && !this._forkHeaders.has(header.hashHex));
		if (!newHeaders.length) {
			return {
				headersRemovedFromLongestChain: [],
				headersAddedToLongestChain: [],
				headersInvalidated
			};
		}

		const batchHeaders = new Map<string, BlockHeaderMutable>();
		for (
			let newHeadersIndex = 0;
			newHeadersIndex < newHeaders.length;
			newHeadersIndex++
		) {
			const header = newHeaders[newHeadersIndex];
			if (this._hashToHeight.has(header.hashHex) || this._forkHeaders.has(header.hashHex)) {
				// A duplicate within this same batch. The filter above only removes headers that
				// were known before the call, so repeats must be skipped here. Processing a
				// repeated ancestor would re-add its hash to the leaf set and _forkHeaders even
				// though it already has children recorded.
				continue;
			}
			const prevHashHex = header.prevHashHex;
			const prevHeight = this._getHeightFromHashHex(prevHashHex);
			if (prevHeight === undefined) {
				// Broken chain.
				break;// Still use all processed headers so far.
			}

			// Check for invalid blocks.
			if (this._invalidBlocks.has(header.hashHex)) {
				let lastHeaderChecked = header;
				headersInvalidated.push(lastHeaderChecked);
				// Add all next headers until there there is a sort problem.
				for (let i = newHeadersIndex + 1; i < newHeaders.length; i++) {
					const nextHeader = newHeaders[i];
					if (nextHeader.prevHashHex !== lastHeaderChecked.hashHex) {
						break;
					}
					lastHeaderChecked = nextHeader;
					headersInvalidated.push(lastHeaderChecked);
				}
				break;// Still use all processed headers so far.
			}

			const height = prevHeight + 1;
			const workTotal = this._getWorkTotalFromHashHex(prevHashHex)! + header.work;
			header.setHeight(height);
			header.setWorkTotal(workTotal);
			this._forkHeaders.set(header.hashHex, { buffer: header.buffer, height, workTotal });
			this._headersTreeLeafHashes.delete(prevHashHex);
			this._headersTreeLeafHashes.add(header.hashHex);
			batchHeaders.set(header.hashHex, header);
		}

		// Find the leaf header with the highest work total.
		const currentChainTipHash = this._heightToHash[this._heightToHash.length - 1];
		let newChainTipHash = currentChainTipHash;
		let maxWorkTotal = this._tipWorkTotal;
		for (const leafHeaderHash of this._headersTreeLeafHashes) {
			const leafWorkTotal = leafHeaderHash === currentChainTipHash ? this._tipWorkTotal : this._forkHeaders.get(leafHeaderHash)!.workTotal;
			if (leafWorkTotal > maxWorkTotal) {
				maxWorkTotal = leafWorkTotal;
				newChainTipHash = leafHeaderHash;
			}
		}

		if (newChainTipHash === currentChainTipHash) {
			// The chain has not been extended by any new headers.
			return {
				headersRemovedFromLongestChain: [],
				headersAddedToLongestChain: [],
				headersInvalidated
			};
		}

		// Collect headers between the new chain tip and the divergence point.
		const headersToAddHashes: string[] = [];
		let divergenceHash = newChainTipHash;
		while (!this._hashToHeight.has(divergenceHash)) {
			headersToAddHashes.push(divergenceHash);
			divergenceHash = getPrevHashHexFromBuffer(this._forkHeaders.get(divergenceHash)!.buffer);
		}
		headersToAddHashes.reverse();
		const newStartingHeight = this._hashToHeight.get(divergenceHash)! + 1;// Divergence point height + 1.

		// Keep the headers that were in the longest chain but are not in the new one as forks.
		const headersRemovedFromLongestChain: RemovedHeader[] = [];
		{
			let workTotal = this._tipWorkTotal;
			for (let height = this._heightToHash.length - 1; height >= newStartingHeight; height--) {
				const hashHex = this._heightToHash[height];
				const buffer = Buffer.from(this._getHeaderBufferFromHeight(height)!);
				const work = getWorkFromBuffer(buffer);
				headersRemovedFromLongestChain.push({ height, hashHex });
				this._forkHeaders.set(hashHex, { buffer, height, workTotal });
				this._hashToHeight.delete(hashHex);
				workTotal -= work;
			}
		}
		this._heightToHash.length = newStartingHeight;
		headersRemovedFromLongestChain.reverse();

		// Add the new longest chain headers.
		const headersAddedToLongestChain: BlockHeaderMutable[] = [];
		// Drop the work checkpoints at or after the divergence point because their cumulative work changes.
		this._workCheckpoints.length = Math.min(this._workCheckpoints.length, Math.ceil(newStartingHeight / WORK_CHECKPOINT_INTERVAL));
		for (let i = 0; i < headersToAddHashes.length; i++) {
			const hashHex = headersToAddHashes[i];
			const height = newStartingHeight + i;
			const forkHeader = this._forkHeaders.get(hashHex)!;
			this._writeHeaderBufferAtHeight(forkHeader.buffer, height);
			this._hashToHeight.set(hashHex, height);
			this._heightToHash[height] = hashHex;
			if (height % WORK_CHECKPOINT_INTERVAL === 0) {
				this._workCheckpoints.push(forkHeader.workTotal);
			}
			headersAddedToLongestChain.push(batchHeaders.get(hashHex) ?? this._createHeaderFromBuffer(forkHeader.buffer, height, forkHeader.workTotal));
			this._forkHeaders.delete(hashHex);
		}
		this._tipWorkTotal = maxWorkTotal;
		this._trimChunksToChainLength();

		return {
			headersRemovedFromLongestChain,
			headersAddedToLongestChain,
			headersInvalidated
		};
	}

	/**
	 * Adds new headers to the database.
	 * @param headers - The headers to add.
	 * @returns The changes to the longest chain.
	 */
	addHeaders = (headers: BlockHeaderMutable[]): AddHeadersChanges => {
		const addHeadersChanges = this._insert(headers);
		if (addHeadersChanges.headersRemovedFromLongestChain.length || addHeadersChanges.headersAddedToLongestChain.length) {
			this._lastTimeChainTipExtendedMs = performance.now();

			// Queue changes to be saved to LevelDB.
			this._levelDbHeadersSaveQueue = this._levelDbHeadersSaveQueue
				.then(async () => {
					// Combine with headers that were previously unsaved from errors.
					this._addHeadersChangesLevelDbSaveQueue.push(addHeadersChanges);
					while (this._addHeadersChangesLevelDbSaveQueue.length) {
						const nextAddHeadersChanges = this._addHeadersChangesLevelDbSaveQueue[0];
						await this._levelDbHeaders.batch(createLevelDbBatchArray(nextAddHeadersChanges.headersRemovedFromLongestChain, nextAddHeadersChanges.headersAddedToLongestChain));
						this._addHeadersChangesLevelDbSaveQueue.shift();
					}
				})
				.catch((error) => {
					console.error(error);
				});
		}
		return addHeadersChanges;
	}

	/**
	 * Prunes branches that are not part of the longest chain.
	 * This method is intended to be called when no nodes are syncing because it depends
	 * on preserving branches that could extend and cause the longest chain to change.
	 * @returns The number of branches pruned.
	 */
	pruneBranches = (): number => {
		const numBranchesBefore = this._headersTreeLeafHashes.size;
		const mainChainTipHash = this._heightToHash[this._heightToHash.length - 1];
		const staleHeaderHashes = new Set<string>();
		Array.from(this._headersTreeLeafHashes).forEach(leafHashHex => {
			// Iterate backwards from leaf headers until reaching the longest chain.
			let currentHashHex = leafHashHex;
			while (!this._hashToHeight.has(currentHashHex) && !staleHeaderHashes.has(currentHashHex)) {
				staleHeaderHashes.add(currentHashHex);
				currentHashHex = getPrevHashHexFromBuffer(this._forkHeaders.get(currentHashHex)!.buffer);
			}
		});
		staleHeaderHashes.forEach(hashHex => {
			this._forkHeaders.delete(hashHex);
			this._headersTreeLeafHashes.delete(hashHex);
		});
		// Every branch that is not the longest chain is gone after the deletions above, so the
		// main chain tip is the only header left without children. It can be missing from the
		// leaf set when a child branch that ties the tip's work displaced it instead of taking
		// over the chain, so it is restored here to keep pruning from failing.
		this._headersTreeLeafHashes.add(mainChainTipHash);
		assert(this._headersTreeLeafHashes.size === 1);
		return numBranchesBefore - this._headersTreeLeafHashes.size;
	}

	/**
	 * Gets the time since the last chain tip extension in this session.
	 * @returns The time in milliseconds, or undefined if the chain tip has not been extended.
	 */
	getTimeSinceLastChainTipExtensionThisSessionMs = (): number | undefined => this._lastTimeChainTipExtendedMs === undefined ? undefined : performance.now() - this._lastTimeChainTipExtendedMs;

	/**
	 * Gets an array of invalid block hashes.
	 * @returns An array of invalid block hashes.
	 */
	getInvalidBlocksArray = (): string[] => Array.from(this._invalidBlocks);

	/**
	 * Gets the total number of headers stored across all branches (including the longest chain and competing forks).
	 * @returns The number of headers in the database.
	 */
	getNumAllHeaders = (): number => this._heightToHash.length + this._forkHeaders.size;

	/**
	 * Gets the number of competing chain tips (leaf headers without children).
	 * A value greater than 1 indicates a live reorg with multiple branches held in memory.
	 * @returns The number of header-tree leaves.
	 */
	getNumCompetingTips = (): number => this._headersTreeLeafHashes.size;

	/**
	 * Gets the number of headers in the longest chain (the main chain).
	 * Equal to the chain tip height plus one (for the genesis header).
	 * @returns The number of headers in the longest chain.
	 */
	getNumLongestChainHeaders = (): number => this._heightToHash.length;

	/**
	 * Gets the block locator hash buffers.
	 * @returns An array of block locator hash buffers.
	 */
	getBlockLocatorHashBuffers = (): Buffer[] => {
		// https://en.bitcoin.it/wiki/Protocol_documentation#getblocks
		const hashes: Buffer[] = [];
		let step = 1;
		// Start at the top of the chain and work backwards.
		for (let i = this._heightToHash.length - 1; i > 0; i -= step) {
			// Push top 10 indexes first, then back off exponentially.
			if (hashes.length >= 10) {
				step *= 2;
			}
			hashes.push(Buffer.from(this._heightToHash[i], 'hex'));
		}
		hashes.push(Buffer.from(this._heightToHash[0], 'hex'));
		return hashes;
	}

	/**
	 * Gets a header from a given height.
	 * Each call returns a new copy; mutating the returned header does not affect the database.
	 * @param height - The height of the header.
	 * @returns The block header, or undefined if not found.
	 */
	getHeaderFromHeight = (height: number): BlockHeaderMutable | undefined => {
		if (!Number.isInteger(height) || height < 0 || height >= this._heightToHash.length) {
			return undefined;
		}
		return this._createHeaderFromBuffer(this._getHeaderBufferFromHeight(height)!, height, this._getWorkTotalFromHeight(height));
	}

	/**
	 * Gets a header from a given hash.
	 * Each call returns a new copy; mutating the returned header does not affect the database.
	 * @param hashHex - The hash of the header.
	 * @returns The block header, or undefined if not found.
	 */
	getHeaderFromHashHex = (hashHex: string): BlockHeaderMutable | undefined => {
		const height = this._hashToHeight.get(hashHex);
		if (height !== undefined) {
			return this._createHeaderFromBuffer(this._getHeaderBufferFromHeight(height)!, height, this._getWorkTotalFromHeight(height));
		}
		const forkHeader = this._forkHeaders.get(hashHex);
		if (!forkHeader) {
			return undefined;
		}
		return this._createHeaderFromBuffer(forkHeader.buffer, forkHeader.height, forkHeader.workTotal);
	}

	/**
	 * Gets the header at the tip of the longest chain.
	 * Each call returns a new copy; mutating the returned header does not affect the database.
	 * @returns The block header at the tip.
	 */
	getHeaderTip = (): BlockHeaderMutable => {
		return this.getHeaderFromHeight(this._heightToHash.length - 1)!;
	}
}
