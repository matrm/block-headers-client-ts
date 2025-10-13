import { Level, BatchOperation } from 'level';

import { BlockHeaderMutable, HEADER_BUFFER_LENGTH } from './BlockHeader.js';
import { assert } from './utils/util.js';

const BITCOIN_GENESIS_HEADER_HEX = '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c';
const BITCOIN_GENESIS_HEADER_HASH_HEX = BlockHeaderMutable.fromHex(BITCOIN_GENESIS_HEADER_HEX).hashHex;
assert(BITCOIN_GENESIS_HEADER_HASH_HEX === '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');

type AddHeadersChanges = {
	headersRemovedFromLongestChain: BlockHeaderMutable[];// Headers that are newly added into the longest chain.
	headersAddedToLongestChain: BlockHeaderMutable[];// Headers that were previously part of the longest chain but are no longer included due to a reorganization.
	headersInvalidated: BlockHeaderMutable[];// Headers that are deemed invalid by being in this._invalidBlocks or after them.
};

type LevelDbHeaders = Level<number, Buffer>;
type LevelDbHeadersBatch = BatchOperation<LevelDbHeaders, number, Buffer>[];

const createLevelDbBatchArray = (removed: BlockHeaderMutable[], added: BlockHeaderMutable[]): LevelDbHeadersBatch => {
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
	private readonly _invalidBlocks: Set<string> = new Set();
	private _allHeaders: Map<string, BlockHeaderMutable>;
	private _headersTree: Map<string, Set<string>>;// Computed tree of header hex hashes.
	private _headersTreeLeafHashes: Set<string>;// Keys of _headersTree that map to an empty set.
	private _sortedHeaders: BlockHeaderMutable[] = [];// Longest chain of headers.
	private _sortedHeadersIndex: Map<string, number> = new Map();
	private _levelDbHeaders: LevelDbHeaders;
	private _levelDbHeadersSaveQueue: Promise<void> = Promise.resolve();
	private _addHeadersChangesLevelDbSaveQueue: AddHeadersChanges[] = [];
	private _lastTimeChainTipExtendedMs: number | undefined;

	private constructor({ databasePath, invalidBlocks, headers, headersTree, headersTreeLeafHashes, sortedHeaders, sortedHeadersIndex }: {
		databasePath: string;
		invalidBlocks: Set<string>;
		headers?: Map<string, BlockHeaderMutable>;
		headersTree?: Map<string, Set<string>>;
		headersTreeLeafHashes?: Set<string>;
		sortedHeaders?: BlockHeaderMutable[];
		sortedHeadersIndex?: Map<string, number>;
	}) {
		const genesisHeader = BlockHeaderMutable.fromHex(BITCOIN_GENESIS_HEADER_HEX);
		genesisHeader.setHeight(0);
		genesisHeader.setWorkTotal(genesisHeader.work);
		this._invalidBlocks = invalidBlocks;
		this._allHeaders = headers || new Map([
			[genesisHeader.hashHex, genesisHeader]// Genesis block.
		]);
		this._headersTree = headersTree || new Map([
			[genesisHeader.hashHex, new Set<string>()]
		]);
		this._headersTreeLeafHashes = headersTreeLeafHashes || new Set([genesisHeader.hashHex]);
		this._sortedHeaders = sortedHeaders || [this._allHeaders.get(genesisHeader.hashHex) as BlockHeaderMutable];
		this._sortedHeadersIndex = sortedHeadersIndex || new Map([
			[genesisHeader.hashHex, 0]
		]);

		// Expected hex conversion for genesis header's prevHashHex.
		assert(this._sortedHeaders[0].prevHashHex === '0000000000000000000000000000000000000000000000000000000000000000');

		this._levelDbHeaders = new Level(databasePath, { keyEncoding: 'json', valueEncoding: 'buffer' });
	}

	/**
	 * Creates a new BlockHeadersDatabase instance from the genesis block.
	 * @param options - Configuration options for creating the BlockHeadersDatabase.
	 * @param options.databasePath - The path to the database.
	 * @param options.invalidBlocks - An array of invalid block hashes.
	 * @returns A new BlockHeadersDatabase instance.
	 */
	static fromGenesis = ({ databasePath, invalidBlocks }: {
		databasePath: string;
		invalidBlocks: string[];
	}): BlockHeadersDatabase => {
		return new BlockHeadersDatabase({ databasePath, invalidBlocks: new Set(invalidBlocks) });
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
		const blockHeadersDatabase = new BlockHeadersDatabase({ databasePath, invalidBlocks: new Set(invalidBlocks) });

		const startTimeMs = performance.now();
		const headersMap = new Map<number, BlockHeaderMutable>();
		for await (const [height, headerBuffer] of blockHeadersDatabase._levelDbHeaders.iterator()) {
			const header = BlockHeaderMutable.fromBuffer(headerBuffer);
			assert(Number.isSafeInteger(height));
			headersMap.set(height, header);
		}
		const headers: BlockHeaderMutable[] = [];
		const tipHeight = headersMap.size;
		for (let i = 1; i <= tipHeight; i++) {// Skip genesis. It shouldn't be in the database.
			const header = headersMap.get(i);
			if (!header) {
				throw new Error(`Missing header at height ${i}`);
			}
			headers.push(header);
		}
		const databaseReadDurationMs = performance.now() - startTimeMs;
		enableConsoleDebugLog && console.log(`Loaded ${headers.length} headers from database file after ${databaseReadDurationMs}ms.`);
		const sortStartTimeMs = performance.now();
		blockHeadersDatabase._insert(headers);
		const sortDurationMs = performance.now() - sortStartTimeMs;
		enableConsoleDebugLog && console.log(`Added and sorted ${headers.length} headers from database file after ${sortDurationMs}ms.`);
		enableConsoleDebugLog && console.log(`Longest chain height: ${blockHeadersDatabase._sortedHeaders.length - 1}.`);
		return blockHeadersDatabase;
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

	// Assumes newHeaders are sorted but will not throw an error if they aren't.
	private _insert = (newHeaders: BlockHeaderMutable[]): AddHeadersChanges => {
		if (this._sortedHeaders.length > 1) {
			// Prevent overriding with headers that don't have height and workTotal set.
			newHeaders = newHeaders.filter(header => !this._allHeaders.has(header.hashHex));
		}
		const headersInvalidated: BlockHeaderMutable[] = [];
		if (!newHeaders.length) {
			return {
				headersRemovedFromLongestChain: [],
				headersAddedToLongestChain: [],
				headersInvalidated
			};
		}

		for (
			let newHeadersIndex = 0;
			newHeadersIndex < newHeaders.length;
			newHeadersIndex++
		) {
			const header = newHeaders[newHeadersIndex];
			const prevHeader = this._allHeaders.get(header.prevHashHex);
			if (!prevHeader) {
				// Broken chain.
				break;// Still use all processed headers so far.
			}
			const prevHeaderChildren = this._headersTree.get(prevHeader.hashHex);
			if (!prevHeaderChildren) {
				// Broken chain.
				break;// Still use all processed headers so far.
			}

			// Check for invalid blocks.
			if (this._invalidBlocks.has(header.hashHex)) {
				let lastHeaderChecked = header;
				headersInvalidated.push(lastHeaderChecked);
				// Add all next headers until there there is a sort problem.
				for (let i = newHeadersIndex + 1; i < newHeaders.length; i++) {
					const header = newHeaders[i];
					if (header.prevHashHex !== lastHeaderChecked.hashHex) {
						break;
					}
					lastHeaderChecked = header;
					headersInvalidated.push(lastHeaderChecked);
				}
				break;// Still use all processed headers so far.
			}

			this._allHeaders.set(header.hashHex, header);
			prevHeaderChildren.add(header.hashHex);
			this._headersTreeLeafHashes.delete(prevHeader.hashHex);
			this._headersTree.set(header.hashHex, new Set());
			this._headersTreeLeafHashes.add(header.hashHex);

			(header as BlockHeaderMutable).setHeight(prevHeader.height + 1);
			(header as BlockHeaderMutable).setWorkTotal(prevHeader.workTotal + header.work);
		}

		// Find the leaf header with the highest work total.
		let newChainTipHash = this._sortedHeaders.at(-1)!.hashHex;
		{
			let maxWorkTotal = this._sortedHeaders.at(-1)!.workTotal;
			for (const leafHeaderHash of this._headersTreeLeafHashes) {
				const leafHeader = this._allHeaders.get(leafHeaderHash)!;
				if (leafHeader.workTotal > maxWorkTotal) {
					maxWorkTotal = leafHeader.workTotal;
					newChainTipHash = leafHeaderHash;
				}
			}
		}

		if (newChainTipHash === this._sortedHeaders.at(-1)!.hashHex) {
			// The chain has not been extended by any new headers.
			return {
				headersRemovedFromLongestChain: [],
				headersAddedToLongestChain: [],
				headersInvalidated
			};
		}

		// Collect headers between the new chain tip and the divergence point and update this._sortedHeaders.
		let currentHeader = this._allHeaders.get(newChainTipHash)!;
		const headersToAdd: BlockHeaderMutable[] = [];
		while (currentHeader && !this._sortedHeadersIndex.has(currentHeader.hashHex)) {
			headersToAdd.push(currentHeader);
			currentHeader = this._allHeaders.get(currentHeader.prevHashHex)!;
			// currentHeader will end on the last header in common with the old chain.
		}
		headersToAdd.reverse();
		const newStartingHeight = currentHeader.height + 1;// Last header in common with the old chain + 1.

		const headersRemoved = this._sortedHeaders.splice(newStartingHeight);
		headersRemoved.forEach(header => this._sortedHeadersIndex.delete(header.hashHex));
		headersToAdd.forEach((header, index) => {
			this._sortedHeaders.push(header);
			this._sortedHeadersIndex.set(header.hashHex, newStartingHeight + index);
		});
		assert(this._sortedHeadersIndex.size === this._sortedHeaders.length);

		return {
			headersRemovedFromLongestChain: headersRemoved,
			headersAddedToLongestChain: headersToAdd,
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
	 * Prunes branches from the headers tree that are not part of the longest chain.
	 * This method is intended to be called when no nodes are syncing because it depends
	 * on preserving branches that could extend and cause the longest chain to change.
	 * @returns The number of branches pruned.
	 */
	pruneBranches = (): number => {
		const numBranchesBefore = this._headersTreeLeafHashes.size;
		// Key is a stale branch divergence point (not part of longest chain), value is the earliest header in its chain that is still part of the main chain.
		const staleHeaderDivergenceParentHashes = new Map<string, string>();
		const staleHeaderHashes = new Set(this._headersTreeLeafHashes);
		staleHeaderHashes.delete(this._sortedHeaders.at(-1)!.hashHex);
		Array.from(staleHeaderHashes).forEach(leafHashHex => {
			// Iterate backwards from leaf headers until reaching the divergence point with the longest chain.
			let currentHashHex = leafHashHex;
			let prevHashHex = leafHashHex;
			while (!this._sortedHeadersIndex.has(prevHashHex)) {
				staleHeaderHashes.add(prevHashHex);
				currentHashHex = prevHashHex;
				prevHashHex = this._allHeaders.get(prevHashHex)!.prevHashHex
			}
			staleHeaderDivergenceParentHashes.set(currentHashHex, prevHashHex);
		});


		// Selectively update the children of staleHeaderDivergenceParentHashes values. 1 of the children
		// is part of the longest chain, the rest are stale.
		for (const [divergenceHeaderHash, divergenceParentHeaderHash] of staleHeaderDivergenceParentHashes) {
			assert(!this._sortedHeadersIndex.has(divergenceHeaderHash));
			assert(this._sortedHeadersIndex.has(divergenceParentHeaderHash));
			const children = this._headersTree.get(divergenceParentHeaderHash);
			assert(children);
			assert(children!.size);
			children!.delete(divergenceHeaderHash);

		}
		staleHeaderHashes.forEach(hashHex => {
			this._allHeaders.delete(hashHex);
			this._headersTree.delete(hashHex);
			this._headersTreeLeafHashes.delete(hashHex);
			assert(!this._sortedHeadersIndex.has(hashHex));
		});
		assert(this._headersTreeLeafHashes.has(this._sortedHeaders.at(-1)!.hashHex));
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
	 * Gets the block locator hash buffers.
	 * @returns An array of block locator hash buffers.
	 */
	getBlockLocatorHashBuffers = (): Buffer[] => {
		// https://en.bitcoin.it/wiki/Protocol_documentation#getblocks
		const hashes: Buffer[] = [];
		let step = 1;
		// Start at the top of the chain and work backwards.
		for (let i = this._sortedHeaders.length - 1; i > 0; i -= step) {
			// Push top 10 indexes first, then back off exponentially.
			if (hashes.length >= 10) {
				step *= 2;
			}
			hashes.push(this._sortedHeaders[i].hashBuffer);
		}
		hashes.push(this._sortedHeaders[0].hashBuffer);
		return hashes;
	}

	/**
	 * Gets a header from a given height.
	 * @param height - The height of the header.
	 * @returns The block header, or undefined if not found.
	 */
	getHeaderFromHeight = (height: number): BlockHeaderMutable | undefined => {
		return this._sortedHeaders[height];
	}

	/**
	 * Gets a header from a given hash.
	 * @param hashHex - The hash of the header.
	 * @returns The block header, or undefined if not found.
	 */
	getHeaderFromHashHex = (hashHex: string): BlockHeaderMutable | undefined => {
		return this._allHeaders.get(hashHex);
	}

	/**
	 * Gets the header at the tip of the longest chain.
	 * @returns The block header at the tip.
	 */
	getHeaderTip = (): BlockHeaderMutable => {
		return this._sortedHeaders.at(-1)!;
	}
}