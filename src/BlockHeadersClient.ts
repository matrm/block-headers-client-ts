import { EventEmitter } from 'events';

import { BlockHeader } from './BlockHeader.js';
import { LegacyNodeConnection } from './LegacyNodeConnection.js';
import { NodeConnection } from './NodeConnection.js';
import { NodesDatabase } from './NodesDatabase.js';
import { BlockHeadersDatabase } from './BlockHeadersDatabase.js';
import { DATABASE_VERSION_FOLDER } from './constants.js';
import { IpPort, ProgressCallback } from './types.js';
import { Chain, getInvalidBlocks } from './chainProtocol.js';
import { ipPortToString, unixTime3Decimal, combineAbortControllers, abortableSleepMsNoThrow, stringToIpPort, assert, stringifyWithTabs } from './utils/util.js';
import { ConnectionMonitor } from './ConnectionMonitor.js';
import { RedBlackMap, CompareNumbers } from 'red-black-map';

const MAX_SAVED_NODES = 4000;
const RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS = 1000;
const TARGET_NUM_CONNECTIONS = 8;
const NUM_WORKERS = 2 * TARGET_NUM_CONNECTIONS;
const SEED_NODES_HARDCODED = Object.freeze(Array.from(new Set<string>([
	{ ip: '47.186.181.232', port: 8333 },
	{ ip: '13.57.104.213', port: 8333 },
	{ ip: '78.110.160.26', port: 8333 },
	{ ip: '44.213.141.106', port: 8333 },
	{ ip: '2600:1f18:573a:32f:ba74:c04d:50a3:ca7d', port: 8333 },
	{ ip: '99.127.49.102', port: 8333 },
	{ ip: '18.199.12.185', port: 8333 },
	{ ip: '141.95.126.79', port: 8333 },
].map(ipPortToString))).map(stringToIpPort));

interface BlockHeadersClientEvents {
	'new_chain_tip': [height: number, hashHex: string];
}

export class BlockHeadersClient extends EventEmitter<BlockHeadersClientEvents> {
	private readonly _enableConsoleDebugLog: boolean = false;
	private readonly _chain: Chain;
	private readonly _nodesDatabase: NodesDatabase;
	private readonly _blockHeadersDatabase: BlockHeadersDatabase;
	private readonly _nodeConnections: Map<string, NodeConnection> = new Map();// Including nodes that are disonnected or with pending connections.
	private readonly _nodeConnectionsConnected: Map<string, NodeConnection> = new Map();// Only including nodes that have passed the tests in this._connectNode(). Not including nodes with pending connections.
	private readonly _activeNodeConnectionTests: Map<string, NodeConnection> = new Map();
	private readonly _nodeEventTimes_disconnect_unintentional_after_connect: Map<string, number> = new Map();
	private readonly _seedNodes: readonly IpPort[] = [];
	private _numConnectToNodesQueues: number = 0;
	private _abortController = new AbortController();
	private _stopQueue: Promise<void> | null = null;
	private _connectToNodesQueue: Promise<void> = Promise.resolve();
	private _nodeConnectionsHealthMonitorQueue: Promise<void> | null = null;
	private readonly _connectionMonitor: ConnectionMonitor;
	private _addedSeedNodesFromExternalAPI: boolean = false;
	private _addedSeedNodesFromEnvAndHardcoded: boolean = false;
	private _nodesSyncingHeaders: Set<string> = new Set();

	private constructor({ chain, nodesDatabase, blockHeadersDatabase, seedNodes, enableConsoleDebugLog }: {
		chain: Chain;
		nodesDatabase: NodesDatabase;
		blockHeadersDatabase: BlockHeadersDatabase;
		seedNodes?: readonly IpPort[];
		enableConsoleDebugLog?: boolean;
	}) {
		super();

		seedNodes = seedNodes ?? [];
		seedNodes = Object.freeze(Array.from(new Set<string>([
			...seedNodes,
			...SEED_NODES_HARDCODED
		].map(ipPortToString))).map(stringToIpPort));
		this._seedNodes = seedNodes;

		this._chain = chain;
		this._nodesDatabase = nodesDatabase;
		this._blockHeadersDatabase = blockHeadersDatabase;
		this._connectionMonitor = new ConnectionMonitor();
		this._enableConsoleDebugLog = !!enableConsoleDebugLog;
	}

	/**
	 * Creates a new BlockHeadersClient instance.
	 * @param options - Configuration options for creating the BlockHeadersClient.
	 * @param options.chain - The blockchain to use.
	 * @param options.databasePath - The path to the database.
	 * @param options.invalidBlocks - An array of invalid block hashes to use in addition to the chain's hardcoded ones (optional).
	 * @param options.seedNodes - An array of seed nodes to connect to (optional).
	 * @param options.enableConsoleDebugLog - Whether to enable console debug logging (optional).
	 * @returns A new BlockHeadersClient instance.
	 */
	static create = async ({ chain, databasePath, invalidBlocks, seedNodes, enableConsoleDebugLog }: {
		chain: Chain;
		databasePath: string;
		invalidBlocks?: string[];
		seedNodes?: readonly IpPort[];
		enableConsoleDebugLog?: boolean;
	}): Promise<BlockHeadersClient> => {
		const invalidBlocksCombined = new Set(getInvalidBlocks(chain));
		invalidBlocks && invalidBlocks.forEach(invalidBlock => invalidBlocksCombined.add(invalidBlock));
		databasePath = databasePath + DATABASE_VERSION_FOLDER + `/${chain}`;

		const databasePathHeaders = databasePath + '/headers';
		const databasePathNodes = databasePath + '/nodes/legacy';
		enableConsoleDebugLog && console.log('databasePathHeaders:', databasePathHeaders);
		enableConsoleDebugLog && console.log('databasePathNodes:  ', databasePathNodes);

		const blockHeadersDatabasePromise = BlockHeadersDatabase.fromDatabase({
			databasePath: databasePathHeaders,
			invalidBlocks: Array.from(invalidBlocksCombined),
			enableConsoleDebugLog
		});
		const timeMs = Date.now();
		const nodesDatabase = await NodesDatabase.create({ databasePath: databasePathNodes, timeMs });

		if (enableConsoleDebugLog && nodesDatabase.getNumNodes() > 0) {
			const numNodes = nodesDatabase.getNumNodes();
			const allNodes = nodesDatabase.getTopRatedNodes({ timeMs, amount: Number.MAX_SAFE_INTEGER, allowBlacklisted: true });
			assert(numNodes === allNodes.length);
			const nonBlacklistedNodes = nodesDatabase.getTopRatedNodes({ timeMs, amount: Number.MAX_SAFE_INTEGER, allowBlacklisted: false });
			const numNonBlacklistedNodes = nonBlacklistedNodes.length;
			const numBlacklistedNodes = numNodes - numNonBlacklistedNodes;

			console.log("#".repeat(40));
			console.log('Number of seen nodes:', numNodes);
			console.log('Number of blacklisted nodes:', numBlacklistedNodes);
			console.log("#".repeat(40));
			{
				const numBestNodesToLog = Math.min(nonBlacklistedNodes.length, 10);
				console.log(`Best ${numBestNodesToLog} nodes:`);
				for (let i = 0; i < numBestNodesToLog; i++) {
					const ipPort = nonBlacklistedNodes[i];
					console.log(`  ${ipPort.ip}:${ipPort.port} rating:\t${nodesDatabase.getNodeRating(ipPort, timeMs)}`);
				}
				console.log("#".repeat(40));
			}
			{
				const numWorstNonBlacklistedNodesToLog = Math.min(nonBlacklistedNodes.length, 10);
				console.log(`Worst ${numWorstNonBlacklistedNodesToLog} non blacklisted nodes:`);
				for (let i = 0; i < numWorstNonBlacklistedNodesToLog; i++) {
					const ipPort = nonBlacklistedNodes[nonBlacklistedNodes.length - 1 - i];
					console.log(`  ${ipPort.ip}:${ipPort.port} rating:\t${nodesDatabase.getNodeRating(ipPort, timeMs)}`);
				}
				console.log("#".repeat(40));
			}
			{
				const numWorstNodesToLog = Math.min(allNodes.length, 10);
				console.log(`Worst ${numWorstNodesToLog} nodes:`);
				for (let i = 0; i < numWorstNodesToLog; i++) {
					const ipPort = allNodes[allNodes.length - 1 - i];
					console.log(`  ${ipPort.ip}:${ipPort.port} rating:\t${nodesDatabase.getNodeRating(ipPort, timeMs)}`);
				}
				console.log("#".repeat(40));
			}
		}

		const blockHeadersDatabase = await blockHeadersDatabasePromise;
		return new BlockHeadersClient({ chain, nodesDatabase, blockHeadersDatabase, seedNodes, enableConsoleDebugLog });
	}

	/**
	 * Stops the client and disconnects from all nodes.
	 */
	stop = async (): Promise<void> => {
		if (this._stopQueue) {
			this._enableConsoleDebugLog && console.log('BlockHeadersClient stop() already running.');
			return this._stopQueue;
		}
		this._stopQueue = Promise.resolve()
			.then(async () => {
				this._enableConsoleDebugLog && console.log('BlockHeadersClient stop() start.');

				this._abortController.abort();

				await this._connectToNodesQueue;
				this._enableConsoleDebugLog && console.log('Flushed _connectToNodesQueue.');

				if (this._nodeConnectionsHealthMonitorQueue) {
					this._enableConsoleDebugLog && console.log('Flushing _nodeConnectionsHealthMonitorQueue.');
					await this._nodeConnectionsHealthMonitorQueue;
					this._nodeConnectionsHealthMonitorQueue = null;
				}

				const numConnections = this._nodeConnections.size;
				const numConnectionsConnected = this._nodeConnectionsConnected.size;
				this._closeNodeConnections();
				this._enableConsoleDebugLog && console.log(`Closed ${numConnections} node connections. ${numConnectionsConnected} were connected.`);

				await this._connectionMonitor[Symbol.asyncDispose]();
				this._enableConsoleDebugLog && console.log('Stopped connection monitor.');

				// These are commented out because quick calls to stop() and start() were causing errors.
				// await this._nodesDatabase[Symbol.asyncDispose]();
				// this._enableConsoleDebugLog && console.log('Disposed nodes database.');
				// await this._blockHeadersDatabase[Symbol.asyncDispose]();
				// this._enableConsoleDebugLog && console.log('Disposed block headers database.');

				this._enableConsoleDebugLog && console.log('BlockHeadersClient stop() end.');
			})
			.finally(() => {
				this._stopQueue = null;
			});
		return this._stopQueue;
	}

	/**
	 * Stops the client and disconnects from all nodes.
	 */
	[Symbol.asyncDispose] = async (): Promise<void> => {
		await this.stop();
	}

	private _closeNodeConnections = (): void => {
		const connections = Array.from(this._nodeConnections.values());
		this._nodeConnections.clear();
		this._nodeConnectionsConnected.clear();
		for (const connection of connections) {
			connection[Symbol.dispose]();
		}
	}

	private _destroyNodeConnection = (nodeConnection: NodeConnection): void => {
		const ipPortString = nodeConnection.getIpPortString();
		this._nodeConnections.delete(ipPortString);
		this._nodeConnectionsConnected.delete(ipPortString);
		nodeConnection[Symbol.dispose]();
	}

	private _createNodeConnection = (ipPort: IpPort, clientStopSignal: AbortSignal): NodeConnection => {
		const ipPortString = ipPortToString(ipPort);

		assert(this._nodeConnections.get(ipPortString) === undefined);

		const nodeConnection = new LegacyNodeConnection({
			ip: ipPort.ip,
			port: ipPort.port,
			chain: this._chain,
			blockHeadersDatabase: this._blockHeadersDatabase,
			connectionMonitor: this._connectionMonitor,
			enableConsoleDebugLog: this._enableConsoleDebugLog
		});

		// Remove old disconnect times that aren't needed anymore.
		// See the 'disconnect_unintentional_after_connect' event for details.
		const lastDisconnectTime = this._nodeEventTimes_disconnect_unintentional_after_connect.get(ipPortString);
		if (lastDisconnectTime && lastDisconnectTime < performance.now() - RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS) {
			this._nodeEventTimes_disconnect_unintentional_after_connect.delete(ipPortString);
		}

		this._nodeConnections.set(ipPortString, nodeConnection);

		this._setupNodeConnectionCallbacks(nodeConnection, clientStopSignal);

		return nodeConnection;
	}

	private _addSeedNodesFromExternalApi = async (): Promise<Set<string>> => {
		const addToThis: Set<string> = new Set();
		const peers = await fetch('https://api.whatsonchain.com/v1/bsv/main/peer/info').then((response) => response.json());
		const timeMs = Date.now();
		const additionalIpPorts: IpPort[] = peers
			.map((peer: any) => {
				const addr: string = peer.addr;
				const delimiter = ':';
				const addrSplit = addr.split(delimiter);
				const port = parseInt(addrSplit.pop() as string);
				if (isNaN(port)) {
					return null;
				}
				const ip = addrSplit.join(delimiter);
				if (!ip) {
					return null;
				}
				if (peer.banscore) {
					// Filter nodes marked by whatsonchain.com as bad.
					return null;
				}
				return {
					ip,
					port
				};
			})
			.filter((ipPort: IpPort | null) => !!ipPort);
		this._enableConsoleDebugLog && console.log(`Fetched ${additionalIpPorts.length} additional nodes from whatsonchain.com`);
		let numBlacklisted = 0;
		for (const ipPort of additionalIpPorts) {
			const ipPortString = ipPortToString(ipPort);
			assert(ipPort);
			if (this._nodesDatabase.isBlacklisted(ipPort, timeMs)) {
				numBlacklisted++;
			}
			addToThis.add(ipPortString);
		}
		this._enableConsoleDebugLog && console.log(`${numBlacklisted} nodes from whatsonchain.com were blacklisted.`);

		this._nodesDatabase.addSeenBatch(Array.from(addToThis).map(stringToIpPort), timeMs).catch((error) => {
			console.error('Failed to add seen nodes to database that were fetched from an external API:', error);
		});
		return addToThis;
	}

	private _addSeedNodesFromEnvAndHardcoded = (): void => {
		const seedNodesNotAddedYet = this._seedNodes.filter((ipPort) => !this._nodesDatabase.has(ipPort));
		seedNodesNotAddedYet.length && this._nodesDatabase.addSeenBatch(seedNodesNotAddedYet, Date.now()).catch((error) => {
			console.error('Failed to add seen nodes to database that were in .env or hardcoded:', error);
		});
		this._enableConsoleDebugLog && seedNodesNotAddedYet.length && console.log(`Added ${seedNodesNotAddedYet.length} seed nodes from .env or hardcoded.`);
	}

	// Connects the nodeConnection, sends a ping, gets connected peers, and downloads headers until at chain tip.
	private _connectAndTestNode = async ({ nodeConnection, alwaysGetAddr, workerId, numAttempts, signal }: {
		nodeConnection: NodeConnection;
		alwaysGetAddr: boolean;
		workerId: number | string;
		numAttempts: number;
		signal: AbortSignal;
	}): Promise<void> => {
		assert(this._nodeConnections.has(nodeConnection.getIpPortString()));

		if (signal.aborted) {
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Aborted before connecting to node:`, nodeConnection.getIpPort());
			throw new Error('Connection attempt aborted');
		}

		this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Connecting to node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
		await nodeConnection.connect({ signal });
		if (signal.aborted) throw new Error('Aborted after connect');

		this._nodesDatabase.addLastConnectTimeMs(nodeConnection.getIpPort(), Date.now()).catch((error: Error) => {
			console.error('Nodes database error when addLastConnectTimeMs', nodeConnection.getIpPort(), ':', error);
		});

		this._enableConsoleDebugLog && console.log(`Worker ${workerId} - About to ping node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
		const pingDurationMs = await nodeConnection.ping({ signal });
		this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Got a ping response from`, nodeConnection.getIpPort(), `in ${pingDurationMs}ms.`, numAttempts, 'attempts.');
		if (signal.aborted) throw new Error('Aborted after ping');

		const onValidChain = await nodeConnection.onValidChain({ signal });
		if (!onValidChain) {
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Node:`, nodeConnection.getIpPort(), `is on invalid chain.`, numAttempts, 'attempts.');
			throw new Error('Node is on invalid chain');
		}
		if (signal.aborted) throw new Error('Aborted after onValidChain');

		this._enableConsoleDebugLog && console.log(`Worker ${workerId} - About to sync headers from node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
		this._nodesSyncingHeaders.add(nodeConnection.getIpPortString());
		await nodeConnection.syncHeaders({ signal })
			.then(() => {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Finished syncing headers from node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
			})
			.catch((error: Error) => {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Failed to sync headers from node after connecting:`, nodeConnection.getIpPort(), ':', error.message);
				throw error;
			})
			.finally(() => {
				this._nodesSyncingHeaders.delete(nodeConnection.getIpPortString());
			});
		if (signal.aborted) throw new Error('Aborted after syncHeaders');

		this._nodesDatabase.addLastConnectAndTestTimeMs(nodeConnection.getIpPort(), Date.now()).catch((error: Error) => {
			console.error('Nodes database error when addLastConnectAndTestTimeMs', nodeConnection.getIpPort(), ':', error);
		});

		const requestMoreNodes = alwaysGetAddr || this._nodesDatabase.getNumNodes() < NUM_WORKERS;// Can be adjusted as necessary or always true.
		if (requestMoreNodes) {
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - About to get peers from node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
			const connectedIpPorts = await nodeConnection.getAddr({ signal });
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Saw ${connectedIpPorts.length} peers from node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
			this._nodesDatabase.addSeenBatch(connectedIpPorts, Date.now()).catch((error: Error) => {
				console.error('Nodes database error when adding seen batch:', error);
			});
			if (signal.aborted) throw new Error('Aborted after getAddr');
		}

		// Note: The nodeConnection 'connected' callback is not used because that will cause nodes to be added to
		// this._nodeConnectionsConnected before they pass the tests in this function. So instead it is added after
		// passing the tests here.
		this._nodeConnectionsConnected.set(nodeConnection.getIpPortString(), nodeConnection);
	}

	private _createConnectedNodeConnection = async ({
		priorityIpPort,
		prioritizeRating,
		numTopNodesToRandomlySelect,
		alwaysGetAddr,
		progressCallback,
		workerId,
		numWorkers,
		signal,
		clientStopSignal,
		maxNumAttempts,
		stopAfterFirstConnection,
		onTargetReached
	}: {
		priorityIpPort?: IpPort;
		prioritizeRating: boolean;
		numTopNodesToRandomlySelect: number;
		alwaysGetAddr: boolean;
		progressCallback?: ProgressCallback;
		workerId: number | string;
		numWorkers: number;
		signal: AbortSignal;
		clientStopSignal: AbortSignal;
		maxNumAttempts: number;
		stopAfterFirstConnection?: boolean;
		onTargetReached?: (workerId: number | string) => void;// Callback to check and abort other workers if target is reached.
	}): Promise<void> => {
		if (priorityIpPort && this._nodeConnections.has(ipPortToString(priorityIpPort))) {
			// Prevents a race condition.
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Another worked connected to priority node first:`, priorityIpPort);
			priorityIpPort = undefined;
		}
		const getNextNode = prioritizeRating ? this._nodesDatabase.getTopRatedNodes : this._nodesDatabase.getMostRecentlySeenNodes;
		let lastIpPortString = '';
		let numAttempts = 0;
		while (true) {
			if (numAttempts >= maxNumAttempts) {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Failed to connect to any node after reaching the maximum number of attempts.`, numAttempts, 'attempts.');
				return;
			}

			if (signal.aborted) {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Aborted from signal.`);
				return;
			}

			const timeMs = Date.now();
			const newIpPorts = priorityIpPort && !this._nodesDatabase.isBlacklisted(priorityIpPort, timeMs) ?
				[priorityIpPort] :
				getNextNode({ timeMs, amount: numTopNodesToRandomlySelect, excludedIpPortStringsMap: this._nodeConnections });
			priorityIpPort = undefined;
			if (!newIpPorts.length) {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - No more nodes available.`, numAttempts, 'attempts.');
				return;
			}
			const newIpPort = newIpPorts[Math.floor(Math.random() * newIpPorts.length)];
			assert(this._nodesDatabase.has(newIpPort));
			const nodeConnection = this._createNodeConnection(newIpPort, clientStopSignal);
			if (nodeConnection.getIpPortString() === lastIpPortString) {
				this._enableConsoleDebugLog && console.warn(`Worker ${workerId} - Node connection reused.`, nodeConnection.getIpPort(), `Rating: ${this._nodesDatabase.getNodeRating(newIpPort, timeMs)}. Progress: (${this._nodeConnectionsConnected.size}/${Math.min(TARGET_NUM_CONNECTIONS, numWorkers)}).`);
			}
			lastIpPortString = nodeConnection.getIpPortString();

			numAttempts++;

			try {
				try {
					this._activeNodeConnectionTests.set(nodeConnection.getIpPortString(), nodeConnection);
					await this._connectAndTestNode({
						nodeConnection,
						alwaysGetAddr,
						workerId,
						numAttempts,
						signal
					});
				} finally {
					this._activeNodeConnectionTests.delete(nodeConnection.getIpPortString());
				}
				onTargetReached?.(workerId);// Abort other workers if target is reached.
			} catch (error) {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Failed to connectAndTestNode:`, nodeConnection.getIpPort(), `Progress: (${this._nodeConnectionsConnected.size}/${Math.min(TARGET_NUM_CONNECTIONS, numWorkers)}).`, numAttempts, 'attempts.', `${error}.`);
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - this._nodeConnections.size:`, this._nodeConnections.size);
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - this._nodeConnectionsConnected.size:`, this._nodeConnectionsConnected.size);

				// Do not call _destroyNodeConnection here because it will prevent the connection metrics from being updated in the database.

				let aborted = false;
				const connectedToInternetAndNotAborted = await this._connectionMonitor.connectedToInternetCheapAsync(signal).catch(() => {
					aborted = true;
					return false;
				});

				// Only check the signal (instead of number of connected nodes) otherwise _launchNodeConnectionsHealthMonitor will stop here.
				if (signal.aborted || aborted) {
					this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Signal aborted. No longer needs to connect to more nodes. Progress: (${this._nodeConnectionsConnected.size}/${Math.min(TARGET_NUM_CONNECTIONS, numWorkers)}).`);
					this._destroyNodeConnection(nodeConnection);
					return;
				}

				if (!connectedToInternetAndNotAborted) {
					this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Not connected to the internet. Progress: (${this._nodeConnectionsConnected.size}/${Math.min(TARGET_NUM_CONNECTIONS, numWorkers)}).`);
					await abortableSleepMsNoThrow(1000, signal);
				}

				continue;
			}
			// Successfully connected to node.

			if (this._nodeConnectionsConnected.size > TARGET_NUM_CONNECTIONS && this._nodeConnectionsConnected.has(nodeConnection.getIpPortString())) {
				// TODO: Change this to remove the lowest rated node.
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Connected to too many nodes.`, numAttempts, 'attempts. Removing', nodeConnection.getIpPort());
				this._destroyNodeConnection(nodeConnection);
				return;
			}

			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Connected to node:`, nodeConnection.getIpPort(), `Progress: (${this._nodeConnectionsConnected.size}/${Math.min(TARGET_NUM_CONNECTIONS, numWorkers)}).`);
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - this._nodeConnections.size:`, this._nodeConnections.size);
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - this._nodeConnectionsConnected.size:`, this._nodeConnectionsConnected.size);

			progressCallback?.({
				current: this._nodeConnectionsConnected.size,
				total: TARGET_NUM_CONNECTIONS
			});

			if (stopAfterFirstConnection || this._nodeConnectionsConnected.size >= TARGET_NUM_CONNECTIONS || signal.aborted) {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Successfully connected`, nodeConnection.getIpPort(), numAttempts, 'attempts. Not trying to add more.');
				return;
			}

			// Successfully connected to a node. Trying to add more.
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Successfully connected`, nodeConnection.getIpPort(), 'Trying to add more...');
			assert(this._nodeConnectionsConnected.size < TARGET_NUM_CONNECTIONS);
			numAttempts = 0;
		}
	}

	private _setupNodeConnectionCallbacks = (nodeConnection: NodeConnection, clientStopSignal: AbortSignal): void => {
		nodeConnection.removeAllListeners();

		const ipPort = nodeConnection.getIpPort();
		const ipPortString = nodeConnection.getIpPortString();

		// Note: Only nodes that pass the tests in in this._connectNode() are added to this map.
		// nodeConnection.on('connect', () => {
		// 	this._nodeConnectionsConnected.set(ipPortString, nodeConnection);
		// });

		nodeConnection.on('disconnect', () => {
			this._enableConsoleDebugLog && console.log('Node disconnected:', ipPort);

			if (clientStopSignal.aborted) {
				return;
			}

			this._destroyNodeConnection(nodeConnection);
		});

		nodeConnection.on('data', () => {
			this._nodesDatabase.addLastDataReceivedTimeMs(ipPort, Date.now()).catch((error: Error) => {
				console.error('Nodes database error when addLastDataReceivedTimeMs', ipPort, ':', error);
			});
		});

		nodeConnection.on('addr', (ipPorts: IpPort[]) => {
			// if (this._enableConsoleDebugLog) {
			// 	console.log(ipPort, 'Received new peers:');
			// 	ipPorts.forEach((ipPort) => console.log(`  ${ipPort.ip}:${ipPort.port}`));
			// }

			if (clientStopSignal.aborted) {
				return;
			}

			const timeMs = Date.now();
			assert(this._nodesDatabase.has(ipPort));
			this._nodesDatabase.addSeenBatch(ipPorts, timeMs).catch((error: Error) => {
				console.error('Nodes database error when adding seen nodes', ipPorts, ':', error);
			});
		});

		nodeConnection.on('block_hashes', async (hashes: Buffer[]) => {
			if (this._enableConsoleDebugLog) {
				if (hashes.length > 1) {
					console.log(ipPort, 'Received new block hashes:');
					hashes.forEach((hash) => console.log(`  ${hash.toString('hex')}`));
				} else {
					console.log(ipPort, 'Received new block hash:', hashes[0].toString('hex'));
				}
			}

			if (clientStopSignal.aborted) {
				this._enableConsoleDebugLog && console.log(ipPort, 'Aborted before syncing headers.');
				return;
			}

			if (this._blockHeadersDatabase.getHeaderTip().hashHex === hashes.at(-1)!.toString('hex')) {
				// Another node has already downloaded this header.
				//this._enableConsoleDebugLog && console.log(ipPort, 'Skipping syncing headers for', hashes.at(-1)!.toString('hex'), 'because another node already downloaded.');
				return;
			}
			this._nodesSyncingHeaders.add(nodeConnection.getIpPortString());
			await nodeConnection.syncHeaders({ signal: clientStopSignal })
				.catch((error) => {
					this._enableConsoleDebugLog && console.log('Failed to sync headers for', ipPort, 'on new block hashes:', error);
				})
				.finally(() => {
					this._nodesSyncingHeaders.delete(nodeConnection.getIpPortString());
				});
			// Not needed but saves resources.
			if (!this._nodesSyncingHeaders.size) {
				const numBranchesPruned = this._blockHeadersDatabase.pruneBranches();
				this._enableConsoleDebugLog && numBranchesPruned && console.log(`Pruned ${numBranchesPruned} header branches.`);
			}
		});

		nodeConnection.on('new_chain_tip', (height: number, hashHex: string) => {
			// if (this._enableConsoleDebugLog) {
			// 	console.log(ipPort, `Received new chain tip ${height}:`, hashHex);
			// }

			if (clientStopSignal.aborted) {
				return;
			}

			this.emit('new_chain_tip', height, hashHex);
		});

		nodeConnection.on('out_of_sync', () => {
			this._enableConsoleDebugLog && console.log('Node out of sync:', ipPort);

			if (clientStopSignal.aborted) {
				return;
			}

			assert(this._nodesDatabase.has(ipPort));
			const timeMs = Date.now();
			const ratingBefore = this._nodesDatabase.getNodeRating(ipPort, timeMs);
			this._nodesDatabase.addLastOutOfSyncTimeMs(ipPort, Date.now()).catch((error: Error) => {
				console.error('Nodes database error when addLastOutOfSyncTimeMs', ipPort, ':', error);
			});
			const ratingAfter = this._nodesDatabase.getNodeRating(ipPort, timeMs);
			this._enableConsoleDebugLog && console.log(`${this._nodesDatabase.isBlacklisted(ipPort, timeMs) ? 'B' : 'Did not b'}lacklisted node:`, ipPort, 'rating before:', ratingBefore, 'rating after:', ratingAfter);

			this._destroyNodeConnection(nodeConnection);

			this._enableConsoleDebugLog && console.log('About to replace nodeConnection if not already running _connectToNodes:', ipPort);
			this._start();
		});

		nodeConnection.on('invalid_blocks', (invalidHeaders: BlockHeader[]) => {
			if (this._enableConsoleDebugLog) {
				console.log('Node downloaded invalid headers:', ipPort);
				console.log(`  First: ${invalidHeaders[0].hashHex}`);
				console.log(`  Last: ${invalidHeaders[invalidHeaders.length - 1].hashHex}`);
			}

			if (clientStopSignal.aborted) {
				return;
			}

			assert(this._nodesDatabase.has(ipPort));
			const timeMs = Date.now();
			const ratingBefore = this._nodesDatabase.getNodeRating(ipPort, timeMs);
			this._nodesDatabase.addLastInvalidChainDetectedTimeMs(ipPort, Date.now()).catch((error: Error) => {
				console.error('Nodes database error when addLastInvalidChainDetectedTimeMs', ipPort, ':', error);
			});
			const ratingAfter = this._nodesDatabase.getNodeRating(ipPort, timeMs);
			this._enableConsoleDebugLog && console.log(`${this._nodesDatabase.isBlacklisted(ipPort, timeMs) ? 'B' : 'Did not b'}lacklisted node:`, ipPort, 'for invalid_blocks. rating before:', ratingBefore, 'rating after:', ratingAfter);

			this._destroyNodeConnection(nodeConnection);

			this._enableConsoleDebugLog && console.log('About to replace nodeConnection if not already running _connectToNodes:', ipPort);
			this._start();
		});

		nodeConnection.on('pong', (durationMs: number, nonceHex: string) => {
			// if (this._enableConsoleDebugLog) {
			// 	console.log(ipPort, `Received pong in ${Math.floor(durationMs)}ms at`, unixTime3Decimal());
			// }

			if (clientStopSignal.aborted) {
				return;
			}

			assert(this._nodesDatabase.has(ipPort));
			const timeMs = Date.now();
			const blacklistedBeforeAndDebugLogging = this._enableConsoleDebugLog && this._nodesDatabase.isBlacklisted(ipPort, timeMs);
			const ratingBefore = this._nodesDatabase.getNodeRating(ipPort, timeMs);
			this._nodesDatabase.addPingTimeMs(ipPort, timeMs, durationMs).catch((error: Error) => {
				console.error('Nodes database error when addPingTimeMs', ipPort, ':', error);
			});
			const ratingAfter = this._nodesDatabase.getNodeRating(ipPort, timeMs);
			this._enableConsoleDebugLog && !blacklistedBeforeAndDebugLogging && this._nodesDatabase.isBlacklisted(ipPort, timeMs) && console.log('Blacklisted node:', ipPort, `after a ${durationMs}ms ping.`, 'rating before:', ratingBefore, 'rating after:', ratingAfter);
		});

		nodeConnection.on('disconnect_unintentional_before_connect', async () => {
			this._enableConsoleDebugLog && console.log('Node unintentionally disconnected before connecting:', ipPort);

			if (clientStopSignal.aborted) {
				return;
			}

			assert(this._nodesDatabase.has(ipPort));

			// Remove this node from this._nodeConnectionsConnected so connected counters are accurate while this function
			// is waiting for promises to resolve.
			this._nodeConnectionsConnected.delete(ipPortString);

			const connectedToInternetAndNotAborted = await this._connectionMonitor.connectedToInternetCheapAsync(clientStopSignal).catch(() => {
				this._enableConsoleDebugLog && console.log('Node unintentionally disconnected before connecting: ABORTED', ipPort);
				return false;
			});

			if (connectedToInternetAndNotAborted) {
				assert(this._nodesDatabase.has(ipPort));
				const timeMs = Date.now();
				const ratingBefore = this._nodesDatabase.getNodeRating(ipPort, timeMs);
				this._nodesDatabase.addRecentUnintentionalDisconnectTimesMs(ipPort, Date.now()).catch((error: Error) => {
					console.error('Nodes database error when addRecentUnintentionalDisconnectTimesMs', ipPort, ':', error);
				});
				const ratingAfter = this._nodesDatabase.getNodeRating(ipPort, timeMs);
				this._enableConsoleDebugLog && console.log(`${this._nodesDatabase.isBlacklisted(ipPort, timeMs) ? 'B' : 'Did not b'}lacklisted node:`, ipPort, 'for disconnect_unintentional_before_connect. rating before:', ratingBefore, 'rating after:', ratingAfter);
			}

			// Must come after the awaits above. Otherwise another worker may connect to this node before its metrics are updated.
			this._destroyNodeConnection(nodeConnection);
		});

		nodeConnection.on('disconnect_unintentional_after_connect', async () => {
			this._enableConsoleDebugLog && console.log('Node unintentionally disconnected after connecting:', ipPort, 'at', unixTime3Decimal());

			if (clientStopSignal.aborted) {
				return;
			}

			assert(this._nodesDatabase.has(ipPort));

			// Other nodes that disconnect in the previous RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS and the
			// next (at least) RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS milliseconds
			// are assumed to be a part of a mass disconnect that should not be penalized.
			const startTimeMs = performance.now();
			this._nodeEventTimes_disconnect_unintentional_after_connect.set(ipPortString, startTimeMs);
			if (this._enableConsoleDebugLog) {
				console.log('nodeEventTimes_disconnect_unintentional_after_connect:');
				for (const [nodeIpPortString, otherNodeDisconnectTime] of this._nodeEventTimes_disconnect_unintentional_after_connect) {
					console.log('\t', stringToIpPort(nodeIpPortString), `: ${startTimeMs - otherNodeDisconnectTime}ms ago.`);
				}
			}

			const nodesBefore = new Set(this._nodeConnectionsConnected.keys());
			const nodesAfter = new Set(nodesBefore);

			// When creating a node connection, it only gets added to this._nodeConnectionsConnected if the
			// connection is both successfully made and successfully tested. this_createConnectedNodeConnection()
			// doesn't destroy the node connection if the connection is not completely tested and relys on this callback.
			const wasConnectedAndTested = this._nodeConnectionsConnected.has(ipPortString);
			// Remove this node from this._nodeConnectionsConnected so connected counters are accurate while this function
			// is waiting for promises to resolve.
			this._nodeConnectionsConnected.delete(ipPortString);

			const internetConnectionCheckAbortController = new AbortController();
			const combinedAbortControllers = combineAbortControllers(clientStopSignal, internetConnectionCheckAbortController.signal);
			const internetConnectionCheckPromise = this._connectionMonitor.connectedToInternetCheapAsync(combinedAbortControllers.signal).catch(() => {
				return false;
			});

			const nodesDisconnectedRecently: Set<string> = new Set();
			await abortableSleepMsNoThrow(RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS, clientStopSignal)
				.then(() => {
					const nodesToRemove: string[] = [];
					// All nodes that disconnect since startTimeMs - RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS
					// and before startTimeMs + RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS.
					for (const [nodeIpPortString, otherNodeDisconnectTime] of this._nodeEventTimes_disconnect_unintentional_after_connect) {
						const afterMs = startTimeMs - RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS;
						const beforeMs = startTimeMs + RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS;
						if (otherNodeDisconnectTime >= afterMs && otherNodeDisconnectTime <= beforeMs) {
							nodesDisconnectedRecently.add(nodeIpPortString);
							nodesBefore.add(nodeIpPortString);
						}

						// To free up memory and speed up this function.
						if (otherNodeDisconnectTime < afterMs) {
							nodesToRemove.push(nodeIpPortString);
						}
					}
					nodesToRemove.forEach((nodeIpPortString) => {
						// Cleanup old values.
						this._nodeEventTimes_disconnect_unintentional_after_connect.delete(nodeIpPortString);
					});
					for (const nodeDisconnectedRecently of nodesDisconnectedRecently) {
						nodesAfter.delete(nodeDisconnectedRecently);
					}
				});

			const numOtherConnectedNodesBeforeWaiting = nodesBefore.has(ipPortString) ? nodesBefore.size - 1 : nodesBefore.size;
			const numOtherConnectedNodesAfterWaiting = nodesAfter.has(ipPortString) ? nodesAfter.size - 1 : nodesAfter.size;
			// 2 other nodes disconnected while waiting if started with more than 2 nodes, or 1 other node disconnected while waiting if started with 2 or less nodes.
			// Sometimes all connected nodes randomly disconnect. This may prevent some of them from being penalized or blacklisted.
			const otherDisconnectsWhileWaitingThreshold = Math.max(0, Math.floor(numOtherConnectedNodesBeforeWaiting / 2) - 1);// Requires most other nodes to disconnect.
			const otherDisconnectsWhileWaiting = numOtherConnectedNodesAfterWaiting + otherDisconnectsWhileWaitingThreshold < numOtherConnectedNodesBeforeWaiting;
			this._enableConsoleDebugLog && console.log(ipPort, `- ${numOtherConnectedNodesBeforeWaiting - numOtherConnectedNodesAfterWaiting} other nodes disconnected within ${RECENT_UNINTENTIONAL_DISCONNECT_TIME_THRESHOLD_MS}ms. ${otherDisconnectsWhileWaiting ? 'E' : 'Not e'}nough other nodes disconnected to avoid being added to database.`);
			// Threshold examples:
			// before -> after: numOtherConnectedNodesAfterWaiting + otherDisconnectsWhileWaitingThreshold < numOtherConnectedNodesBeforeWaiting
			// 1 -> 0: 0 + 0 < 1 = true
			// 2 -> 1: 1 + 0 < 2 = true
			// 3 -> 1: 1 + 0 < 3 = true
			// 3 -> 2: 2 + 0 < 3 = true
			// 3 -> 3: 3 + 0 < 3 = false
			// 4 -> 3: 3 + 1 < 4 = false
			// 5 -> 3: 3 + 1 < 5 = true
			// 7 -> 4: 4 + 2 < 7 = true
			// 7 -> 5: 5 + 2 < 7 = false
			// 8 -> 4: 4 + 3 < 8 = true
			// 8 -> 5: 5 + 3 < 8 = false
			// TLDR: When the normal 7 other nodes are connected, at least 3 other nodes need to disconnect to avoid
			// being penalized or blacklisted while awaiting this._connectionMonitor.connectedToInternetCheapAsync().
			if (otherDisconnectsWhileWaiting) {
				this._enableConsoleDebugLog && console.log(numOtherConnectedNodesBeforeWaiting - numOtherConnectedNodesAfterWaiting, 'other nodes disconnected recently after being connected', ipPort);
				internetConnectionCheckAbortController.abort();
			}

			const connectedToInternetAndNotAborted = await internetConnectionCheckPromise;

			const timeMs = Date.now();
			if (connectedToInternetAndNotAborted && !otherDisconnectsWhileWaiting) {
				assert(this._nodesDatabase.has(ipPort));
				const ratingBefore = this._nodesDatabase.getNodeRating(ipPort, timeMs);
				this._nodesDatabase.addRecentUnintentionalDisconnectTimesMs(ipPort, Date.now()).catch((error: Error) => {
					console.error('Nodes database error when addRecentUnintentionalDisconnectTimesMs', ipPort, ':', error);
				});
				const ratingAfter = this._nodesDatabase.getNodeRating(ipPort, timeMs);
				this._enableConsoleDebugLog && console.log(`${this._nodesDatabase.isBlacklisted(ipPort, timeMs) ? 'B' : 'Did not b'}lacklisted node:`, ipPort, 'for disconnect_unintentional_after_connect. rating before:', ratingBefore, 'rating after:', ratingAfter);
			}

			if (!wasConnectedAndTested) {
				// When creating a node connection, it only gets added to this._nodeConnectionsConnected if the
				// connection is both successfully made and successfully tested. this_createConnectedNodeConnection()
				// doesn't destroy the node connection if the connection is not completely tested and relies on this callback.
				this._enableConsoleDebugLog && console.log('Node', ipPort, 'was removed from or never added to this._nodeConnectionsConnected from outside disconnect_unintentional_after_connect callback.');
				this._destroyNodeConnection(nodeConnection);
				return;
			}

			if (clientStopSignal.aborted) {
				this._destroyNodeConnection(nodeConnection);
				return;
			}

			// Try to reconnect.
			if (!this._nodesDatabase.isBlacklisted(ipPort, timeMs) && this._nodeConnectionsConnected.size < TARGET_NUM_CONNECTIONS) {
				this._enableConsoleDebugLog && console.log('Reconnecting to node:', ipPort);
				try {
					await nodeConnection.connect({ signal: clientStopSignal });
					if (this._blockHeadersDatabase.getHeaderTip().height) {
						// Sync headers in case a block is missed during multiple disconnects.
						this._nodesSyncingHeaders.add(ipPortString);
						try {
							await nodeConnection.syncHeaders({ signal: clientStopSignal });
						} finally {
							this._nodesSyncingHeaders.delete(ipPortString);
						}
					}
					this._nodeConnectionsConnected.set(ipPortString, nodeConnection);
					this._enableConsoleDebugLog && console.log('Successfully reconnected to node:', ipPort, performance.now() - startTimeMs, 'ms after disconnecting.');
					if (this._nodeConnectionsConnected.size > TARGET_NUM_CONNECTIONS) {
						this._enableConsoleDebugLog && console.log('Reconnected to node, but target connections exceeded, destroying reconnected to node:', ipPort);
						this._destroyNodeConnection(nodeConnection);
					}
					return;
				} catch (error) {
					this._enableConsoleDebugLog && console.log('Error reconnecting to node', ipPort, ':', error);
				}
			}

			// Must come after the awaits above. Otherwise another worker may connect to this node before its metrics are updated.
			this._destroyNodeConnection(nodeConnection);

			if (clientStopSignal.aborted) {
				return;
			}

			// Reconnect (if not blacklisted) by setting this nodeConnection as the priority when connectToNodes is called.
			// The node could become blacklisted before this.start() calls _createConnectedNodeConnection() and tries to connect to
			// it even if it isn't currently blacklisted here. In that case it will try to connect to another node.
			this._enableConsoleDebugLog && console.log('About to replace nodeConnection if not already running _connectToNodes:', ipPort);
			this._start({ priorityIpPort: this._nodesDatabase.isBlacklisted(ipPort, timeMs) ? undefined : ipPort });
		});
	}

	// This function runs a loop that starts after _connectToNodes(). The loop has a few purposes:
	// - Gives a rating to nodes it tries to connect to, allowing faster _createConnectedNodeConnection() calls in the future.
	// - Protects against sybil attacks by discovering new peers with a getAddr() call on recently seen nodes.
	// - Reduces the chance of there not being enough nodes to connect to by discovering new ones with getAddr().
	// - Adds to connected nodes when there are less than TARGET_NUM_CONNECTIONS active connections.
	// - Checks for out of sync nodes by calling syncHeaders on connected nodes.
	// - Frees up resources by clearing the oldest (by seen time) nodes from database if there are too many.
	// - Frees up resources by pruning header branches in the block headers database.
	private _launchNodeConnectionsHealthMonitor = async (clientStopSignal: AbortSignal): Promise<void> => {
		if (this._nodeConnectionsHealthMonitorQueue) {
			return this._nodeConnectionsHealthMonitorQueue;
		}

		this._enableConsoleDebugLog && console.log('Starting node connections health monitor.');

		this._nodeConnectionsHealthMonitorQueue = Promise.resolve();

		const MIN_TIME_BETWEEN_MS = 30 * 60 * 1000;// Should be set to significantly less than the time it takes for a node to be considered out of sync.
		while (!clientStopSignal.aborted) {
			await this._nodeConnectionsHealthMonitorQueue;
			this._nodeConnectionsHealthMonitorQueue = this._nodeConnectionsHealthMonitorQueue.then(async () => {
				if (clientStopSignal.aborted) {
					return;
				}

				// Create a single connected node and call getAddr() on it.
				this._enableConsoleDebugLog && console.log('Node connections health monitor: Creating a single connected node...');
				const workerId = 'node-health-monitor';
				const numTopNodesToRandomlySelect = NUM_WORKERS * 2;
				await this._createConnectedNodeConnection({
					prioritizeRating: false,
					numTopNodesToRandomlySelect,
					alwaysGetAddr: true,
					//progressCallback,
					workerId,
					numWorkers: 1,
					signal: clientStopSignal,
					clientStopSignal,
					maxNumAttempts: 100,
					stopAfterFirstConnection: true,
					// onTargetReached: () => {
					// 	if (this._nodeConnectionsConnected.size >= TARGET_NUM_CONNECTIONS) {
					// 		this._enableConsoleDebugLog && console.log('Target connections reached, aborting all pending attempts.');
					// 		abortController.abort();// Abort all ongoing operations.
					// 	}
					// }
				});

				// Clear the nodes with the oldest last seen time if there are too many.
				{
					const numBefore = this._nodesDatabase.getNumNodes();
					const numToRemove = numBefore - MAX_SAVED_NODES;
					if (numToRemove > 0) {
						this._nodesDatabase.clearOld({ amount: numToRemove, excludedIpPortStringsMap: this._nodeConnections });
						const numAfter = this._nodesDatabase.getNumNodes();
						this._enableConsoleDebugLog && console.log(`Node connections health monitor: Cleared ${numBefore - numAfter} nodes.`);
					}
				}

				if (clientStopSignal.aborted) {
					return;
				}

				// Check if any nodes are out of sync.
				this._enableConsoleDebugLog && console.log('Node connections health monitor: Checking if any nodes are out of sync...');
				await Promise.all(Array.from(this._nodeConnectionsConnected.values()).map(nodeConnection => {
					this._nodesSyncingHeaders.add(nodeConnection.getIpPortString());
					return nodeConnection.syncHeaders({ signal: clientStopSignal })
						.catch((error) => {
							this._enableConsoleDebugLog && console.log('Node connections health monitor: Failed to sync headers for', nodeConnection.getIpPort(), ':', error.message);
						}).finally(() => {
							this._nodesSyncingHeaders.delete(nodeConnection.getIpPortString());
						});
				}));
				// Prune header branches in the block headers database. Not needed but saves resources.
				if (!this._nodesSyncingHeaders.size) {
					const numBranchesPruned = this._blockHeadersDatabase.pruneBranches();
					this._enableConsoleDebugLog && numBranchesPruned && console.log(`Pruned ${numBranchesPruned} header branches.`);
				}

				if (clientStopSignal.aborted) {
					return;
				}

				this._enableConsoleDebugLog && console.log(`Node connections health monitor: Sleeping for ${MIN_TIME_BETWEEN_MS}ms...`);
				await abortableSleepMsNoThrow(MIN_TIME_BETWEEN_MS, clientStopSignal);
			});
		}
	}

	private _connectToNodes = async ({ priorityIpPort, progressCallback, clientStopSignal }: {
		priorityIpPort?: IpPort;
		progressCallback?: ProgressCallback;
		clientStopSignal: AbortSignal;
	}): Promise<void> => {
		if (this._nodeConnectionsConnected.size >= TARGET_NUM_CONNECTIONS) {
			this._enableConsoleDebugLog && console.log('Target connections reached already before _connectToNodes.');
			return;
		}

		if (!this._addedSeedNodesFromExternalAPI && this._nodesDatabase.getNumNodesNonBlacklisted({ timeMs: Date.now() }) < NUM_WORKERS) {
			this._addedSeedNodesFromExternalAPI = true;
			await this._addSeedNodesFromExternalApi().catch((error) => {
				this._enableConsoleDebugLog && console.error('Failed to add seed nodes from external API:', error.message);
			});
		}
		const timeMs = Date.now();// After the await statement.
		if (!this._addedSeedNodesFromEnvAndHardcoded && this._nodesDatabase.getNumNodesNonBlacklisted({ timeMs }) < NUM_WORKERS) {
			this._addedSeedNodesFromEnvAndHardcoded = true;
			this._addSeedNodesFromEnvAndHardcoded();
		}

		const numNodesConnectedBefore = this._nodeConnectionsConnected.size;
		this._enableConsoleDebugLog && console.log("#".repeat(60));
		this._enableConsoleDebugLog && console.log("#".repeat(60));
		this._enableConsoleDebugLog && console.log(`About to attempt to connect to ${TARGET_NUM_CONNECTIONS - this._nodeConnectionsConnected.size} nodes. Currently connected nodes:`);
		Array.from(this._nodeConnectionsConnected.values()).forEach((connection: NodeConnection) => {
			this._enableConsoleDebugLog && console.log('  \t', connection.getIpPort());
		});
		this._enableConsoleDebugLog && console.log('this._nodeConnections.size:', this._nodeConnections.size);
		this._enableConsoleDebugLog && console.log('this._nodeConnectionsConnected.size:', this._nodeConnectionsConnected.size);
		this._enableConsoleDebugLog && console.log('Number of non blacklisted nodes remaining:', this._nodesDatabase.getNumNodesNonBlacklisted({ timeMs }));
		if (this._enableConsoleDebugLog && this._nodeConnections.size > this._nodeConnectionsConnected.size) {
			console.log('this._nodeConnections not in this._nodeConnectionsConnected:');
			for (const [ipPortString, nodeConnection] of this._nodeConnections) {
				if (!this._nodeConnectionsConnected.has(ipPortString)) {
					console.log('  \t', nodeConnection.getIpPort());
				}
			}
		}
		this._enableConsoleDebugLog && console.log("#".repeat(50));

		const timeBeforeMs = performance.now();
		// For aborting when finished connecting to nodes.
		const localAbortController = new AbortController();
		// For aborting when finished connecting to nodes or when this.stop() is called.
		const combinedAbortControllers = combineAbortControllers(clientStopSignal, localAbortController.signal);

		const onTargetReached = (workerId: number | string) => {
			if (this._nodeConnectionsConnected.size >= TARGET_NUM_CONNECTIONS) {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Target connections reached, aborting all pending attempts by other workers.`);
				localAbortController.abort();
			}
		}

		// If only need to connect to 1 more node.
		if (priorityIpPort && !this._nodeConnectionsConnected.has(ipPortToString(priorityIpPort)) && this._nodeConnectionsConnected.size + 1 === TARGET_NUM_CONNECTIONS) {
			const workerId = `connect-to-priority-${ipPortToString(priorityIpPort)}`;
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Started.`);
			await this._createConnectedNodeConnection({
				priorityIpPort,
				prioritizeRating: true,
				numTopNodesToRandomlySelect: 1,
				alwaysGetAddr: false,
				progressCallback,
				workerId,
				numWorkers: NUM_WORKERS,
				signal: combinedAbortControllers.signal,
				clientStopSignal,
				maxNumAttempts: 1,// Only try to reconnect once before launching other workers.
				stopAfterFirstConnection: true,// Only try to reconnect once before launching other workers.
				onTargetReached
			});
			const reconnected = this._nodeConnectionsConnected.has(ipPortToString(priorityIpPort));
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Completed and ${this._nodeConnectionsConnected.size === TARGET_NUM_CONNECTIONS ? 'successfully' : 'unsuccessfully'} connected to ${reconnected ? 'the priority node' : 'another node'}.`);
		}

		if (this._nodeConnectionsConnected.size < TARGET_NUM_CONNECTIONS && !combinedAbortControllers.signal.aborted) {
			// Launch NUM_WORKERS workers (in the same thread) that connect to nodes and adds them
			// to this._nodeConnectionsConnected until there are TARGET_NUM_CONNECTIONS connections or the database has no more
			// available nodes to connect to. Workers in the console logs are identified by the index variable (workerId).
			await Promise.all(Array(NUM_WORKERS).fill(null).map(async (_, workerId): Promise<void> => {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Started.`);
				await this._createConnectedNodeConnection({
					priorityIpPort,
					prioritizeRating: true,
					numTopNodesToRandomlySelect: 1,
					alwaysGetAddr: false,
					progressCallback,
					workerId,
					numWorkers: NUM_WORKERS,
					signal: combinedAbortControllers.signal,
					clientStopSignal,
					maxNumAttempts: Math.max(this._nodesDatabase.getNumNodes(), 3000),// For safety.
					onTargetReached
				});
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Completed successfully.`);
			}));
		}

		this._enableConsoleDebugLog && console.log("#".repeat(50));
		this._enableConsoleDebugLog && console.log(`Connected to ${this._nodeConnectionsConnected.size - numNodesConnectedBefore} nodes totaling ${this._nodeConnectionsConnected.size} nodes after ${performance.now() - timeBeforeMs}ms.`);
		Array.from(this._nodeConnectionsConnected.values()).forEach((connection: NodeConnection) => {
			this._enableConsoleDebugLog && console.log('  \t', connection.getIpPort());
		});
		this._enableConsoleDebugLog && console.log('this._nodeConnections.size:', this._nodeConnections.size);
		this._enableConsoleDebugLog && console.log('this._nodeConnectionsConnected.size:', this._nodeConnectionsConnected.size);
		this._enableConsoleDebugLog && console.log('Number of non blacklisted nodes remaining:', this._nodesDatabase.getNumNodesNonBlacklisted({ timeMs: Date.now() }));
		if (this._enableConsoleDebugLog && this._nodeConnections.size > this._nodeConnectionsConnected.size) {
			console.log('this._nodeConnections not in this._nodeConnectionsConnected:');
			for (const [ipPortString, nodeConnection] of this._nodeConnections) {
				if (!this._nodeConnectionsConnected.has(ipPortString)) {
					console.log('  \t', nodeConnection.getIpPort());
				}
			}
		}
		this._enableConsoleDebugLog && console.log("#".repeat(60));
		this._enableConsoleDebugLog && console.log("#".repeat(60));
	}

	private _start = async (options: {
		priorityIpPort?: IpPort;
		progressCallback?: ProgressCallback;
	} = {}): Promise<void> => {
		// Limit queue size to 1.
		if (this._numConnectToNodesQueues < 1) {
			this._connectToNodesQueue = this._connectToNodesQueue
				.then(async () => {
					this._numConnectToNodesQueues++;
					await this._stopQueue;
					if (this._abortController.signal.aborted) {
						this._abortController = new AbortController();
					}
					const abortController = this._abortController;
					this._enableConsoleDebugLog && console.log(unixTime3Decimal(), '- Starting connection monitor and opening databases.');
					await this._connectionMonitor.start(abortController.signal);
					await this._nodesDatabase.open();
					await this._blockHeadersDatabase.open();
					await this._connectToNodes({ ...options, clientStopSignal: abortController.signal });
					this._launchNodeConnectionsHealthMonitor(abortController.signal);
				})
				.finally(() => {
					this._numConnectToNodesQueues--;
				});
		} else if (this._enableConsoleDebugLog) {
			console.log('_connectToNodes is already running.');
		}
		return this._connectToNodesQueue;
	}

	/**
	 * Connects to nodes and syncs to the longest chain.
	 */
	start = async (): Promise<void> => {
		return this._start();
	}

	/**
	 * Gets a header from a given height.
	 * @param height - The height of the header.
	 * @returns The block header, or undefined if not found.
	 */
	getHeaderFromHeight = (height: number): BlockHeader | undefined => {
		return this._blockHeadersDatabase.getHeaderFromHeight(height)?.toMinimalObject();
	}

	/**
	 * Gets a header from a given hash.
	 * @param hashHex - The hash of the header.
	 * @returns The block header, or undefined if not found.
	 */
	getHeaderFromHashHex = (hashHex: string): BlockHeader | undefined => {
		return this._blockHeadersDatabase.getHeaderFromHashHex(hashHex)?.toMinimalObject();
	}

	/**
	 * Gets the header at the tip of the longest chain.
	 * @returns The block header at the tip.
	 */
	getHeaderTip = (): BlockHeader => {
		return this._blockHeadersDatabase.getHeaderTip().toMinimalObject();
	}

	/**
	 * Gets an array of connected node's IP, port, and rating, sorted by rating in descending order.
	 * @returns An array of connected node's IP, port, and rating.
	 */
	getPeersInfoConnected = (): { ip: string, port: number, rating: number }[] => {
		const ratingToNode = new RedBlackMap<number, IpPort>(CompareNumbers);
		const timeMs = Date.now();
		this._nodeConnectionsConnected.forEach((nodeConnection) => {
			const ipPort = nodeConnection.getIpPort();
			ratingToNode.set(this._nodesDatabase.getNodeRating(ipPort, timeMs)!, ipPort);
		});
		const ipPorts = Array.from(ratingToNode.valuesReversed());
		return ipPorts.map(ipPort => ({ ...ipPort, rating: this._nodesDatabase.getNodeRating(ipPort, timeMs)! }));
	}
}