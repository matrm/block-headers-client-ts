import { EventEmitter } from 'events';

import { BlockHeader } from './BlockHeader.js';
import { LegacyNodeConnection } from './LegacyNodeConnection.js';
import { NodeConnection } from './NodeConnection.js';
import { NodesDatabase } from './NodesDatabase.js';
import type { NodeConnectionMetrics } from './NodesDatabase.js';
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
// Stuck-detection timeout follows a power decay curve: the more workers, the less time each
// failure window gets before resetting node metrics. 1 worker → ~500s, 16 workers → ~60s,
// asymptotically approaching 40s as the number of workers approaches infinity.
//
// The minimum effective timeout (40s at high worker counts) is intentionally generous to
// avoid spurious deletions. A worker inside a getAddr() call will have
// _nodesCurrentlyRunningGetAddr > 0, which blocks the detection because getAddr() can take
// several minutes per call. Slow connect(), ping(), onValidChain(), or syncHeaders() calls
// do not block detection.
// The timer is also reset on successful connection, getAddr start, stuck-detection purge,
// internet-down detection, and startup, so normal activity keeps the timeout from triggering.
const METRICS_RESET_TIMEOUT_BASE_MS = 40000;
const METRICS_RESET_TIMEOUT_AMPLITUDE_MS = 460000;
const METRICS_RESET_TIMEOUT_EXPONENT = Math.log(23) / Math.log(16);
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

interface DashboardEmitterEvents {
	// Whenever a node connection is added to this._nodeConnectionsConnected.
	'peer_connected': [ipPort: IpPort];
	// Whenever a node connection is removed from this._nodeConnectionsConnected.
	'peer_disconnected': [ipPort: IpPort];
	'peer_reconnected': [ipPort: IpPort];
	'peer_out_of_sync': [ipPort: IpPort];
	'peer_invalid_blocks': [ipPort: IpPort];
	'peer_unintentional_disconnect_before_connect': [ipPort: IpPort];
	'peer_unintentional_disconnect_after_connect': [ipPort: IpPort];
	'peer_addr_discovered': [ipPort: IpPort, count: number];
	'peer_block_hashes_received': [ipPort: IpPort, hashHex: string];
	'peer_pong_received': [ipPort: IpPort, durationMs: number];
	// 'peer_data_received' is commented out because it causes too many WS messages.
	// 'peer_data_received': [ipPort: IpPort, timeMs: number];
	'client_start': [];
	'client_stop': [];
	// Every fetch() call that isn't aborted by ConnectionMonitor asyncDispose
	// will emit one of the following four events. The two of these events that
	// change the status will also be emit as soon as the connection status change
	// is detected.
	'connection_monitor_online_to_online': [];
	'connection_monitor_online_to_offline': [];
	'connection_monitor_offline_to_online': [];
	'connection_monitor_offline_to_offline': [];
	'stuck_detection_purge': [];
	'stuck_detection_recovery': [];
}

export class BlockHeadersClient extends EventEmitter<BlockHeadersClientEvents> {
	private readonly _enableConsoleDebugLog: boolean = false;
	private readonly _dashboardEmitter = new EventEmitter<DashboardEmitterEvents>();
	private readonly _chain: Chain;
	private readonly _nodesDatabase: NodesDatabase;
	private readonly _blockHeadersDatabase: BlockHeadersDatabase;
	// Tracks all nodes that have a live NodeConnection object, regardless of
	// connection-test outcome. Entries are added in _createNodeConnection and
	// removed on disconnect/out_of_sync/invalid_blocks callbacks (registered
	// in _setupNodeConnectionCallbacks). NodeConnection emits one of those
	// events on almost every failure path, so stale entries do not accumulate.
	private readonly _nodeConnections: Map<string, NodeConnection> = new Map();
	// Only including nodes that have passed the tests in this._connectNode().
	// Not including nodes with pending connections.
	private readonly _nodeConnectionsConnected: Map<string, NodeConnection> = new Map();
	private readonly _activeNodeConnectionTests: Map<string, NodeConnection> = new Map();
	private readonly _nodeEventTimes_disconnect_unintentional_after_connect: Map<string, number> = new Map();
	private readonly _seedNodes: readonly IpPort[] = [];
	private _abortController = new AbortController();
	private _stopQueue: Promise<void> | null = null;
	private _startQueue: Promise<void> | null = null;
	private _nodeConnectionsHealthMonitorQueue: Promise<void> | null = null;
	private readonly _connectionMonitor: ConnectionMonitor;
	private _addedSeedNodesFromExternalAPI: boolean = false;
	private _addedSeedNodesFromEnvAndHardcoded: boolean = false;
	private _nodesSyncingHeaders: Set<string> = new Set();
	// Timestamp (performance.now()) of the most recent sign of progress.
	// Reset on successful connection, getAddr start, stuck-detection purge,
	// internet-down detection, and whenever workers begin connecting to nodes.
	// The stuck-detection logic in _createConnectedNodeConnection compares elapsed time
	// against this to decide when to delete non-connected nodes from the database.
	private _lastConnectionProgressTime: number = 0;
	// Shared promise that workers await when the database is temporarily empty after
	// a stuck-detection node deletion. Workers see this promise and wait for seed
	// re-addition to complete instead of exiting with "no more nodes available".
	private _seedReAddPromise: Promise<void> | null = null;
	// Counts workers currently inside a getAddr() call. A worker in getAddr
	// blocks stuck detection to avoid deleting the node database just because
	// getAddr is sometimes slow (sometimes taking several minutes per call).
	// We block getAddr calls from triggering stuck detection instead of other
	// parts of the stuck detection because not all connection tests run getAddr
	// and it is the last part of a connection test so the tested node is most likely
	// going to pass the test successfully.
	private _nodesCurrentlyRunningGetAddr: number = 0;
	// Whether the stuck-detection purge has already fired during the current _connectToNodes()
	// run (each run resets the budget). The purge runs at most once per run so the
	// client gracefully settles at fewer than TARGET_NUM_CONNECTIONS connections when the
	// node pool is flooded with fake/unreachable nodes from hardcoded seeds,
	// whatsonchain, and getAddr. After one wipe + re-seed, the pool is left to
	// degrade naturally (failures accumulate blacklists) until workers run out of
	// nodes. The budget does not apply while zero nodes are connected, since
	// nothing is protected by the purge there and each wipe re-adds fresh seed
	// candidates so the workers keep searching for nodes.
	private _stuckDetectionPurgedThisStart: boolean = false;
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
		const nodesDatabase = await NodesDatabase.create({ databasePath: databasePathNodes, timeMs, enableConsoleDebugLog });

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

				if (this._startQueue) {
					await this._startQueue.catch((error) => {
						this._enableConsoleDebugLog && console.log('stop() continuing despite _startQueue failure:', error.message);
					});
					this._enableConsoleDebugLog && console.log('Flushed _startQueue.');
				}

				if (this._seedReAddPromise) {
					this._enableConsoleDebugLog && console.log('Flushing seed re-add promise.');
					await this._seedReAddPromise.catch((error) => {
						this._enableConsoleDebugLog && console.log('stop() continuing despite seed re-add failure:', error.message);
					});
					this._seedReAddPromise = null;
				}

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

				await this._nodesDatabase[Symbol.asyncDispose]();
				this._enableConsoleDebugLog && console.log('Disposed nodes database.');
				await this._blockHeadersDatabase[Symbol.asyncDispose]();
				this._enableConsoleDebugLog && console.log('Disposed block headers database.');

				this._enableConsoleDebugLog && console.log('BlockHeadersClient stop() end.');
			})
			.finally(() => {
				// Reset _stopQueue first so a re-entrant stop() call observing the in-flight
				// chain's completion sees a null queue and starts a fresh chain (which gets
				// its own emit). The emit fires unconditionally (success or rejection) because
				// even a database error during dispose still means the program is mostly
				// stopped. Promise.prototype.finally schedules its callback as a microtask on
				// the settled promise, so the await in any concurrent stop() caller is
				// guaranteed to observe the new null _stopQueue and the emitted event.
				this._stopQueue = null;
				this._dashboardEmitter.emit('client_stop');
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
		const all = Array.from(this._nodeConnections.values());
		const connectedSet = new Set(this._nodeConnectionsConnected.values());
		this._nodeConnections.clear();
		this._nodeConnectionsConnected.clear();
		for (const connection of all) {
			// dispose() routes to _disconnectNoEmit() on LegacyNodeConnection, which
			// removes socket listeners and destroys the socket without firing the
			// 'disconnect' event. Emit peer_disconnected for the dashboard before the
			// silent cleanup, but only for connections that had completed the handshake
			// (the others never emitted peer_connected, so a peer_disconnected for them
			// would be an unbalanced row in the dashboard event log).
			if (connectedSet.has(connection)) {
				this._dashboardEmitter.emit('peer_disconnected', connection.getIpPort());
			}
			connection[Symbol.dispose]();
		}
	}

	private _destroyNodeConnection = (nodeConnection: NodeConnection): void => {
		const ipPortString = nodeConnection.getIpPortString();
		this._nodeConnections.delete(ipPortString);
		if (this._nodeConnectionsConnected.delete(ipPortString)) {
			this._dashboardEmitter.emit('peer_disconnected', nodeConnection.getIpPort());
		}
		nodeConnection[Symbol.dispose]();
	}

	// Last ping time per connected node, used by _pingHandler to ping the node that has
	// been pinged least recently. Kept small by pruning entries for disconnected nodes.
	private readonly _lastPingTimesMs: Map<string, number> = new Map();

	// Pings the connected node that has been pinged least recently and reports whether a
	// pong was received (null when there are no connected nodes to ping). Used by the
	// connection monitor as a fallback before fetching.
	// The rotation spreads the pings across the connected nodes so that no single node
	// receives every ping (on top of its own scheduled pings) and gets rate limited.
	// A node can never be pinged by a check that its own disconnect triggered: every
	// waitForInternetCheapAsync caller removes the triggering node from
	// _nodeConnectionsConnected synchronously before awaiting the check, and this handler
	// only ever selects from the current map.
	// Note: a ping that times out disconnects the node (see LegacyNodeConnection.ping),
	// so concurrent pings are combined into a single in-flight ping.
	private _pingHandler = async (timeoutMs: number, signal?: AbortSignal): Promise<boolean | null> => {
		let bestConnection: NodeConnection | null = null;
		let bestLastPingTime = Infinity;
		for (const [ipPortString, connection] of this._nodeConnectionsConnected) {
			const lastPingTime = this._lastPingTimesMs.get(ipPortString) ?? -Infinity;
			if (lastPingTime < bestLastPingTime) {
				bestLastPingTime = lastPingTime;
				bestConnection = connection;
			}
		}
		// Prune the entries for disconnected nodes so the map stays small; the entries
		// for connected nodes are kept so the least-recently-pinged rotation continues.
		for (const ipPortString of this._lastPingTimesMs.keys()) {
			if (!this._nodeConnectionsConnected.has(ipPortString)) {
				this._lastPingTimesMs.delete(ipPortString);
			}
		}
		if (!bestConnection) {
			return null;// No connected nodes to ping.
		}
		this._lastPingTimesMs.set(bestConnection.getIpPortString(), performance.now());
		try {
			await bestConnection.ping({ timeoutMs, signal });
			return true;
		} catch {
			return false;
		}
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

	private _addSeedNodesFromExternalApi = async (signal?: AbortSignal): Promise<Set<string>> => {
		const addToThis: Set<string> = new Set();

		const timeoutController = new AbortController();
		const timeoutId = setTimeout(() => timeoutController.abort(), 10000);
		// A missing signal is replaced with a never-aborting signal so the controller is
		// always disposable via `using`.
		using combinedAbortController = combineAbortControllers(signal ?? new AbortController().signal, timeoutController.signal);
		const combinedSignal = combinedAbortController.signal;

		const peers = await fetch('https://api.whatsonchain.com/v1/bsv/main/peer/info', {
			signal: combinedSignal
		}).then((response) => {
			if (!response.ok) throw new Error(`HTTP ${response.status} fetching seed nodes from external API`);
			return response.json();
		}).finally(() => {
			clearTimeout(timeoutId);
		});
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
		this._addedSeedNodesFromExternalAPI = true;
		return addToThis;
	}

	private _addSeedNodesFromEnvAndHardcoded = (): void => {
		const seedNodesNotAddedYet = this._seedNodes.filter((ipPort) => !this._nodesDatabase.has(ipPort));
		seedNodesNotAddedYet.length && this._nodesDatabase.addSeenBatch(seedNodesNotAddedYet, Date.now()).catch((error) => {
			console.error('Failed to add seen nodes to database that were in .env or hardcoded:', error);
		});
		this._addedSeedNodesFromEnvAndHardcoded = true;
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

		const requestMoreNodes = alwaysGetAddr || this._nodesDatabase.getNumNodes() < NUM_WORKERS;
		if (requestMoreNodes) {
			this._enableConsoleDebugLog && console.log(`Worker ${workerId} - About to get peers from node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
			// Not all node connection tests need to call getAddr, so we update the timer both before and after.
			this._lastConnectionProgressTime = performance.now();
			this._nodesCurrentlyRunningGetAddr++;
			try {
				const connectedIpPorts = await nodeConnection.getAddr({ signal });
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Saw ${connectedIpPorts.length} peers from node:`, nodeConnection.getIpPort(), numAttempts, 'attempts.');
				this._nodesDatabase.addSeenBatch(connectedIpPorts, Date.now()).catch((error: Error) => {
					console.error('Nodes database error when adding seen batch:', error);
				});
			} finally {
				this._nodesCurrentlyRunningGetAddr--;
			}
			if (signal.aborted) throw new Error('Aborted after getAddr');
		}

		// Note: The nodeConnection 'connected' callback is not used because that will cause nodes to be added to
		// this._nodeConnectionsConnected before they pass the tests in this function. So instead it is added after
		// passing the tests here.
		this._nodeConnectionsConnected.set(nodeConnection.getIpPortString(), nodeConnection);
		// Reset the stuck-detection timer since we just successfully connected to a node.
		this._lastConnectionProgressTime = performance.now();
		this._dashboardEmitter.emit('peer_connected', nodeConnection.getIpPort());
	}

	private _createConnectedNodeConnection = async ({
		priorityIpPort,
		prioritizeRating,
		numTopNodesToRandomlySelect,
		alwaysGetAddr,
		progressCallback,
		workerId,
		numWorkers,
		signal,// Aborts when this worker should stop (target reached, or stop() called).
		clientStopSignal,// Aborts only when stop() is called.
		maxNumAttempts,
		stopAfterFirstConnection,
		onTargetReached,
		disableStuckDetection
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
		disableStuckDetection?: boolean;// Set to true to prevent the stuck-detection node-deletion logic from firing from this worker.
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

			// If a stuck-detection deletion cleared the database and seeds are being
			// re-added, await the shared promise before calling getNextNode otherwise
			// seed nodes may not be available.
			if (this._seedReAddPromise) {
				this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Awaiting seed re-add before node selection.`);
				await this._seedReAddPromise;
				if (signal.aborted) return;
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

				// Do not call _destroyNodeConnection here; it would dispose the socket
				// (removing its error/close listeners) before those listeners can emit
				// the disconnect / out_of_sync / invalid_blocks events that drive the
				// database metric updates in _setupNodeConnectionCallbacks.

				let aborted = false;
				const connectedToInternetAndNotAborted = await this._connectionMonitor.waitForInternetCheapAsync(signal).catch(() => {
					aborted = true;
					return false;
				});

				// Only check the signal (instead of number of connected nodes) otherwise _launchNodeConnectionsHealthMonitor will stop here.
				if (signal.aborted || aborted) {
					this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Signal aborted. No longer needs to connect to more nodes. Progress: (${this._nodeConnectionsConnected.size}/${Math.min(TARGET_NUM_CONNECTIONS, numWorkers)}).`);
					this._destroyNodeConnection(nodeConnection);
					return;
				}

				// If no new node has connected within the per-worker timeout and we are
				// still under TARGET_NUM_CONNECTIONS, delete all non-connected nodes from the
				// database so falsely-blacklisted nodes can be retried as fresh entries. Then
				// launch an async seed re-add via a shared promise. The triggering worker does
				// NOT await the seed re-add here; it falls through to continue, loops back,
				// and awaits the shared promise on the "no more nodes available" path
				// alongside all other workers.
				//
				// The check is skipped when:
				//  - disableStuckDetection is true (e.g. health monitor)
				//  - another worker is inside a getAddr() call (can take several minutes)
				//  - a seed re-add is already in progress (_seedReAddPromise !== null)
				//  - the purge has already fired during this _connectToNodes() run while at
				//    least one node is connected. One wipe + re-seed is the recovery attempt
				//    for a polluted database. If the pool is genuinely flooded with fake
				//    nodes, repeatedly purging would churn the database forever, so the
				//    client instead gracefully settles at fewer than TARGET_NUM_CONNECTIONS
				//    connections. The once-per-run budget does not apply while zero nodes
				//    are connected, since nothing is protected by the purge there and each
				//    wipe re-adds fresh seed candidates so the workers keep searching for
				//    nodes.
				//
				// The timer is reset by _lastConnectionProgressTime, which is updated
				// on successful connection, getAddr start, stuck-detection purge,
				// internet-down detection, and whenever workers begin connecting to nodes.
				// Combined with _nodesCurrentlyRunningGetAddr > 0 blocking, the effectiveTimeout
				// can safely be tens of seconds.
				const effectiveTimeoutMs = METRICS_RESET_TIMEOUT_BASE_MS + Math.floor(METRICS_RESET_TIMEOUT_AMPLITUDE_MS / Math.pow(numWorkers, METRICS_RESET_TIMEOUT_EXPONENT));
				if (
					connectedToInternetAndNotAborted &&
					this._nodeConnectionsConnected.size < TARGET_NUM_CONNECTIONS &&
					(!this._stuckDetectionPurgedThisStart || this._nodeConnectionsConnected.size === 0) &&
					performance.now() - this._lastConnectionProgressTime > effectiveTimeoutMs &&
					// The whole stuck window must be outage-free. The unreachable
					// timestamp is refreshed by mass disconnects and offline check
					// reports, so this also covers outages too short for a check to
					// report offline and peer drops while HTTP keeps working.
					this._connectionMonitor.getTimeSincePeersWereUnreachableMs() >= effectiveTimeoutMs &&
					!this._seedReAddPromise &&
					!disableStuckDetection &&
					this._nodesCurrentlyRunningGetAddr === 0
				) {
					this._lastConnectionProgressTime = performance.now();
					this._enableConsoleDebugLog && console.log(`No new connections in ${(effectiveTimeoutMs / 1000).toFixed(0)}s. Deleting nodes and re-adding seeds.`);
					// Use _nodeConnections as the exclusion map instead of _nodeConnectionsConnected
					// to avoid removing nodes that are currently running callbacks which may leave
					// the node in a corrupted state if removed from the database.
					this._nodesDatabase.deleteNodes({ excludedIpPortStringsMap: this._nodeConnections });
					this._dashboardEmitter.emit('stuck_detection_purge');
					this._addedSeedNodesFromExternalAPI = false;
					this._addedSeedNodesFromEnvAndHardcoded = false;
					assert(this._seedReAddPromise === null);
					this._seedReAddPromise = (async () => {
						this._addSeedNodesFromEnvAndHardcoded();
						await this._addSeedNodesFromExternalApi(clientStopSignal).catch((error: Error) => {
							console.error('Failed to add seed nodes after node deletion:', error);
						});

						// Run getAddr on the currently connected nodes to fill up the database again.
						// Race the getAddr calls and abort the rest after the first one completes.
						const raceAbortController = new AbortController();
						using combinedAbortController = combineAbortControllers(clientStopSignal, raceAbortController.signal);
						const combinedSignal = combinedAbortController.signal;
						const getAddrPromises: Array<Promise<void>> = [];
						for (const connectedNodeConnection of this._nodeConnectionsConnected.values()) {
							const getAddrPromise = connectedNodeConnection.getAddr({ signal: combinedSignal })
								.then((connectedIpPorts: IpPort[]) => {
									raceAbortController.abort();
									this._nodesDatabase.addSeenBatch(connectedIpPorts, Date.now()).catch((error: Error) => {
										console.error('Nodes database error when adding seen batch:', error);
									});
								})
								.catch((error: Error) => {
									if (!combinedSignal.aborted) {
										this._enableConsoleDebugLog && console.log('Failed to getAddr from node when re-filling database:', connectedNodeConnection.getIpPort(), error);
									}
								});
							getAddrPromises.push(getAddrPromise);
						}
						await Promise.all(getAddrPromises);
						// getAddr can take a long time to complete, so we update this again to
						// prevent another stuck-detection purge from being triggered too soon after.
						// This code is locked behind this._seedReAddPromise, so we do not need to
						// modify the this._nodesCurrentlyRunningGetAddr counter to prevent this if
						// statement from being triggered by another worker.
						this._lastConnectionProgressTime = performance.now();
						this._dashboardEmitter.emit('stuck_detection_recovery');
					})().finally(() => {
						// We use a .finally() in case future devs make changes that forget to handle
						// errors when re-adding seeds. If we do not want that protection then this
						// null assignment could be at the inner end of the async function it is chained to.
						this._seedReAddPromise = null;
					});
					// Consume the once-per-run purge budget only after the purge body has
					// launched (the block above is synchronous, so no other worker can fire
					// another purge in the meantime). A throw in that synchronous launch part
					// (e.g. the dashboard emit) leaves the budget available so the next timeout
					// cycle can retry the recovery; a failure later inside the async seed re-add
					// still consumes the budget because the wipe itself already happened.
					// The budget only applies to purges fired with at least one node connected:
					// a zero-node purge is the recovery loop for a poisoned database, so it
					// leaves the budget intact for a later connected purge in the same run.
					if (this._nodeConnectionsConnected.size > 0) {
						this._stuckDetectionPurgedThisStart = true;
					}
				}

				if (!connectedToInternetAndNotAborted) {
					this._enableConsoleDebugLog && console.log(`Worker ${workerId} - Not connected to the internet. Progress: (${this._nodeConnectionsConnected.size}/${Math.min(TARGET_NUM_CONNECTIONS, numWorkers)}).`);

					await abortableSleepMsNoThrow(1000, signal);

					// No internet: reset the stuck-detection timer so a prolonged
					// outage does not produce a stale timestamp that triggers an
					// immediate database purge the moment connectivity returns.
					this._lastConnectionProgressTime = performance.now();
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
			const timeMs = Date.now();
			// peer_data_received emit commented out: it spams the WS channel.
			// this._dashboardEmitter.emit('peer_data_received', ipPort, timeMs);
			this._nodesDatabase.addLastDataReceivedTimeMs(ipPort, timeMs).catch((error: Error) => {
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
			this._dashboardEmitter.emit('peer_addr_discovered', ipPort, ipPorts.length);
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

			const lastHashHex = hashes.at(-1)!.toString('hex');
			this._dashboardEmitter.emit('peer_block_hashes_received', ipPort, lastHashHex);

			if (this._blockHeadersDatabase.getHeaderFromHashHex(lastHashHex)?.hashHex === lastHashHex) {
				// Another node has already downloaded this header and added it to the database.
				//this._enableConsoleDebugLog && console.log(ipPort, 'Skipping syncing headers for', lastHashHex, 'because another node already downloaded.');
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

			this._dashboardEmitter.emit('peer_out_of_sync', ipPort);

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

			this._dashboardEmitter.emit('peer_invalid_blocks', ipPort);

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

			this._dashboardEmitter.emit('peer_pong_received', ipPort, durationMs);

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

			this._dashboardEmitter.emit('peer_unintentional_disconnect_before_connect', ipPort);
			// Remove this node from this._nodeConnectionsConnected so connected counters are accurate while this function
			// is waiting for promises to resolve.
			if (this._nodeConnectionsConnected.delete(ipPortString)) {
				this._dashboardEmitter.emit('peer_disconnected', ipPort);
			}

			// A failure while peers are known unreachable is attributed to the network
			// and not to this node. Skip the internet check and any rating penalty.
			// An unknown (null) state counts as reachable, so a cold start still runs
			// the check and penalizes by its verdict.
			if (!this._connectionMonitor.arePeersReachable()) {
				this._destroyNodeConnection(nodeConnection);
				return;
			}

			const connectedToInternetAndNotAborted = await this._connectionMonitor.waitForInternetCheapAsync(clientStopSignal).catch(() => {
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
			// Capture the peer reachability state now: if peers are already known
			// unreachable the failure is network-caused and the node is replaced
			// immediately below, without a check or a penalty. The state may change
			// again before the penalty decision of the reachable branch below.
			const peersReachableAtDisconnect = this._connectionMonitor.arePeersReachable();
			this._nodeEventTimes_disconnect_unintentional_after_connect.set(ipPortString, startTimeMs);
			if (this._enableConsoleDebugLog) {
				console.log('nodeEventTimes_disconnect_unintentional_after_connect:');
				for (const [nodeIpPortString, otherNodeDisconnectTime] of this._nodeEventTimes_disconnect_unintentional_after_connect) {
					console.log('\t', stringToIpPort(nodeIpPortString), `: ${startTimeMs - otherNodeDisconnectTime}ms ago.`);
				}
			}

			const nodesBefore = new Set(this._nodeConnectionsConnected.keys());
			const nodesAfter = new Set(nodesBefore);

			this._dashboardEmitter.emit('peer_unintentional_disconnect_after_connect', ipPort);
			// When creating a node connection, it only gets added to this._nodeConnectionsConnected if the
			// connection is both successfully made and successfully tested. _createConnectedNodeConnection()
			// doesn't destroy the node connection if the connection is not completely tested and relies on this callback.
			const wasConnectedAndTested = this._nodeConnectionsConnected.has(ipPortString);
			// Remove this node from this._nodeConnectionsConnected so connected counters are accurate while this function
			// is waiting for promises to resolve.
			if (this._nodeConnectionsConnected.delete(ipPortString)) {
				this._dashboardEmitter.emit('peer_disconnected', ipPort);
			}

			// A failure while peers are already known unreachable is attributed to the
			// network, so the node gets no rating penalty and is replaced immediately
			// instead of running the internet check, which would only re-confirm the
			// known outage. The disconnect time is still recorded above so concurrent
			// handlers' mass-disconnect detection sees this drop. When peers were
			// reachable at the disconnect, the full check still runs below.
			if (!peersReachableAtDisconnect) {
				this._destroyNodeConnection(nodeConnection);
				if (clientStopSignal.aborted) {
					return;
				}
				if (!wasConnectedAndTested) {
					// The worker loop that created this connection is still running and
					// will pick a new node; nothing to replace here.
					return;
				}
				this._enableConsoleDebugLog && console.log('About to replace nodeConnection if not already running _connectToNodes:', ipPort);
				this._start({ priorityIpPort: this._nodesDatabase.isBlacklisted(ipPort, Date.now()) ? undefined : ipPort });
				return;
			}

			const internetConnectionCheckAbortController = new AbortController();
			using combinedAbortControllers = combineAbortControllers(clientStopSignal, internetConnectionCheckAbortController.signal);
			const internetConnectionCheckPromise = this._connectionMonitor.waitForInternetCheapAsync(combinedAbortControllers.signal).catch(() => {
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
			// being penalized or blacklisted while awaiting this._connectionMonitor.waitForInternetCheapAsync().
			if (otherDisconnectsWhileWaiting) {
				this._enableConsoleDebugLog && console.log(numOtherConnectedNodesBeforeWaiting - numOtherConnectedNodesAfterWaiting, 'other nodes disconnected recently after being connected', ipPort);
				// A large portion of the connected nodes dropped. Tell the connection
				// monitor so disconnect failures during the outage carry no rating
				// impact.
				this._connectionMonitor.markMassDisconnect();
				internetConnectionCheckAbortController.abort();
			}

			const connectedToInternetAndNotAborted = await internetConnectionCheckPromise;

			const timeMs = Date.now();
			// peersReachableAtDisconnect is always true here (the unreachable case
			// returned above), so the penalty is decided by the check verdict and the
			// mass-disconnect detection alone.
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
				// connection is both successfully made and successfully tested. _createConnectedNodeConnection()
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
					this._dashboardEmitter.emit('peer_connected', nodeConnection.getIpPort());
					this._enableConsoleDebugLog && console.log('Successfully reconnected to node:', ipPort, performance.now() - startTimeMs, 'ms after disconnecting.');
					if (this._nodeConnectionsConnected.size > TARGET_NUM_CONNECTIONS) {
						this._enableConsoleDebugLog && console.log('Reconnected to node, but target connections exceeded, destroying reconnected to node:', ipPort);
						this._destroyNodeConnection(nodeConnection);
					} else {
						this._dashboardEmitter.emit('peer_reconnected', nodeConnection.getIpPort());
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
		// This method never rejects; all internal errors are caught and logged.
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
					disableStuckDetection: true,
					// onTargetReached: () => {
					// 	if (this._nodeConnectionsConnected.size >= TARGET_NUM_CONNECTIONS) {
					// 		this._enableConsoleDebugLog && console.log('Target connections reached, aborting all pending attempts.');
					// 		abortController.abort();// Abort all ongoing operations.
					// 	}
					// }
				}).catch((error) => {
					this._enableConsoleDebugLog && console.log('Node connections health monitor: Failed to create connected node:', error.message);
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
			}).catch((error) => {
				// All code in the above .then() block should catch and log its own errors, so this catch() is just a safety net.
				this._enableConsoleDebugLog && console.log('Node connections health monitor: Iteration failed:', error.message);
			});
		}
		this._nodeConnectionsHealthMonitorQueue = null;
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
			await this._addSeedNodesFromExternalApi(clientStopSignal).catch((error) => {
				console.error('Failed to add seed nodes from external API:', error.message);
			});
			if (clientStopSignal.aborted) return;
		}
		const timeMs = Date.now();// After the await statement.
		if (!this._addedSeedNodesFromEnvAndHardcoded && this._nodesDatabase.getNumNodesNonBlacklisted({ timeMs }) < NUM_WORKERS) {
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

		// Initialize the stuck-detection timer at the moment workers begin connecting.
		this._lastConnectionProgressTime = performance.now();
		// Each _connectToNodes() run gets one stuck-detection purge budget. The budget
		// resets here (rather than on every worker retry), so within a single run a
		// flooded pool is wiped at most once while any node is connected. Note that
		// disconnect-triggered reconnections launch a fresh _connectToNodes() run, so
		// each such run gets its own wipe.
		this._stuckDetectionPurgedThisStart = false;

		const timeBeforeMs = performance.now();
		// For aborting when finished connecting to nodes.
		const localAbortController = new AbortController();
		// For aborting when finished connecting to nodes or when this.stop() is called.
		// `using` detaches the abort listeners when the function exits (including when a
		// worker throws), so the long-lived client stop signal does not accumulate one
		// listener per _connectToNodes() call.
		using combinedAbortControllers = combineAbortControllers(clientStopSignal, localAbortController.signal);

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

	private _start = async ({
		priorityIpPort,
		progressCallback,
		shouldEmitClientStart = false,
	}: {
		priorityIpPort?: IpPort;
		progressCallback?: ProgressCallback;
		shouldEmitClientStart?: boolean;
	} = {}): Promise<void> => {
		// Wait for an in-progress stop() to complete.
		// This must be OUTSIDE the _startQueue chain to avoid
		// a circular promise dependency with stop()'s await of _startQueue.
		if (this._stopQueue) {
			await this._stopQueue;
		}

		if (this._startQueue) {
			this._enableConsoleDebugLog && console.log('_start is already running.');
			return this._startQueue;
		}

		this._startQueue = (async () => {
			if (this._abortController.signal.aborted) {
				this._abortController = new AbortController();
			}
			const abortController = this._abortController;
			this._enableConsoleDebugLog && console.log(unixTime3Decimal(), '- Starting connection monitor and opening databases.');
			this._connectionMonitor.setOnCheckResult((prev: boolean | null, isConnected: boolean) => {
				// The first report after start (or after a dispose) has prev === null,
				// which means the status was unknown and there is no prior status to
				// compare against. It is classified against the assumed-online
				// baseline, because online is the expected startup state: an online
				// first report emits connection_monitor_online_to_online and an
				// offline first report emits connection_monitor_online_to_offline.
				// The unknown baseline only surfaces when the first check of a
				// session is a fetch before any peer data arrived; peer data normally
				// fills the status in silently first (see
				// ConnectionMonitor.updateLastKnownConnectionTime).
				const prevStatus = prev === null ? true : prev;
				// Classify the check result into one of four dashboard events.
				const eventName = (prevStatus === isConnected)
					? (isConnected ? 'connection_monitor_online_to_online' : 'connection_monitor_offline_to_offline')
					: (isConnected ? 'connection_monitor_offline_to_online' : 'connection_monitor_online_to_offline');
				this._dashboardEmitter.emit(eventName);
			});
			this._connectionMonitor.setPingHandler(this._pingHandler);
			await this._connectionMonitor.start(abortController.signal);
			await this._nodesDatabase.open();
			await this._blockHeadersDatabase.open();
			await this._connectToNodes({ priorityIpPort, progressCallback, clientStopSignal: abortController.signal });
			this._launchNodeConnectionsHealthMonitor(abortController.signal);
			if (shouldEmitClientStart) {
				this._dashboardEmitter.emit('client_start');
			}
		})()
			.finally(() => {
				this._startQueue = null;
			});

		return this._startQueue;
	}

	/**
	 * Connects to nodes and syncs to the longest chain.
	 */
	start = async (): Promise<void> => {
		await this._start({ shouldEmitClientStart: true });
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

	/**
	 * Internal-only variant of getPeersInfoConnected that also returns per-node connection metrics
	 * and the node's live state. Used by the API server (which is not part of the published
	 * library) to power the dashboard's expandable peer rows. Accessed via `as any` casting so it
	 * is not part of the public library API.
	 * @returns An array of connected node's IP, port, rating, historical metrics, and live state.
	 */
	private _getPeersInfoConnectedForDashboard = (): {
		ip: string;
		port: number;
		rating: number;
		metrics: NodeConnectionMetrics;
		liveState: {
			tipHashHex: string;
		};
	}[] => {
		const ratingToNode = new RedBlackMap<number, IpPort>(CompareNumbers);
		const timeMs = Date.now();
		this._nodeConnectionsConnected.forEach((nodeConnection) => {
			const ipPort = nodeConnection.getIpPort();
			ratingToNode.set(this._nodesDatabase.getNodeRating(ipPort, timeMs)!, ipPort);
		});
		const ipPorts = Array.from(ratingToNode.valuesReversed());
		return ipPorts.map(ipPort => {
			const nodeConnection = this._nodeConnectionsConnected.get(ipPortToString(ipPort))!;
			return {
				...ipPort,
				rating: this._nodesDatabase.getNodeRating(ipPort, timeMs)!,
				metrics: this._nodesDatabase.getNodeConnectionMetricsCopy(ipPort)!,
				liveState: {
					tipHashHex: nodeConnection.getTipHashHex(),
				},
			};
		});
	}

	/**
	 * Internal-only snapshot of the discovered-node population summary used by the dashboard to
	 * surface the candidate-pool size and the rating cutoff that contextualizes per-peer ratings.
	 * Accessed via `as any` casting so it is not part of the public library API.
	 * @returns Counts of total, non-blacklisted, and blacklisted nodes plus the blacklist threshold.
	 */
	private _getNodesSummaryForDashboard = (): {
		numTotalNodes: number;
		numNonBlacklistedNodes: number;
		numBlacklistedNodes: number;
		blacklistRatingThreshold: number;
	} => {
		const timeMs = Date.now();
		const numTotalNodes = this._nodesDatabase.getNumNodes();
		const numNonBlacklistedNodes = this._nodesDatabase.getNumNodesNonBlacklisted({ timeMs });
		return {
			numTotalNodes,
			numNonBlacklistedNodes,
			numBlacklistedNodes: numTotalNodes - numNonBlacklistedNodes,
			blacklistRatingThreshold: this._nodesDatabase.getBlacklistedRatingThreshold(),
		};
	}

	/**
	 * Internal-only snapshot of the block-headers database state used by the dashboard to surface
	 * branch counts, orphaned headers, invalid blocks, and chain-tip extension progress. Accessed
	 * via `as any` casting so it is not part of the public library API.
	 * @returns Counts of headers across branches, competing tips, invalid blocks, and chain-tip lag.
	 */
	private _getHeadersDatabaseInfoForDashboard = (): {
		numLongestChainHeaders: number;
		longestChainHeight: number;
		numAllHeaders: number;
		numOrphanedHeaders: number;
		numCompetingTips: number;
		invalidBlocks: string[];
		timeSinceLastChainTipExtensionThisSessionMs: number | undefined;
	} => {
		const tip = this._blockHeadersDatabase.getHeaderTip();
		const numLongestChainHeaders = this._blockHeadersDatabase.getNumLongestChainHeaders();
		const numAllHeaders = this._blockHeadersDatabase.getNumAllHeaders();
		return {
			numLongestChainHeaders,
			longestChainHeight: tip.height,
			numAllHeaders,
			numOrphanedHeaders: numAllHeaders - numLongestChainHeaders,
			numCompetingTips: this._blockHeadersDatabase.getNumCompetingTips(),
			invalidBlocks: this._blockHeadersDatabase.getInvalidBlocksArray(),
			timeSinceLastChainTipExtensionThisSessionMs: this._blockHeadersDatabase.getTimeSinceLastChainTipExtensionThisSessionMs(),
		};
	}
}