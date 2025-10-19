import { ipPortToString, stringToIpPort } from '../utils/util.js';
import { DEFAULT_DATABASE_PATH } from '../constants.js';
import { Chain } from '../chainProtocol.js';
import { IpPort } from '../types.js';

function parseSeedNodes(seedNodesJson?: string): IpPort[] {
	if (!seedNodesJson) {
		return [];
	}
	try {
		const parsed = JSON.parse(seedNodesJson);
		if (!Array.isArray(parsed)) {
			console.error('SEED_NODES environment variable is not a JSON array.');
			return [];
		}
		return Array.from(new Set<string>(parsed.map(ipPortToString))).map(stringToIpPort);
	} catch (error) {
		console.error('Failed to parse environment variable SEED_NODES:', error);
		return [];
	}
}

const config = Object.freeze({
	PORT: process.env.PORT && process.env.PORT.length ? parseInt(process.env.PORT) : 3000,
	CONSOLE_DEBUG_LOG: process.env.CONSOLE_DEBUG_LOG === 'true',
	CHAIN: process.env.CHAIN as Chain || 'bsv' as Chain,
	DATABASE_PATH: process.env.DATABASE_PATH || DEFAULT_DATABASE_PATH,
	AUTO_START: process.env.AUTO_START ? process.env.AUTO_START === 'true' : false,
	SEED_NODES: Object.freeze(parseSeedNodes(process.env.SEED_NODES)),
	BYPASS_ADMIN_AUTH: process.env.BYPASS_ADMIN_AUTH === 'true',
	ADMIN_API_KEYS: Object.freeze(process.env.ADMIN_API_KEYS ? JSON.parse(process.env.ADMIN_API_KEYS) : []),
});

if (config.CONSOLE_DEBUG_LOG) {
	console.log('PORT:', config.PORT);
	console.log('CONSOLE_DEBUG_LOG:', config.CONSOLE_DEBUG_LOG);
	console.log('CHAIN:', config.CHAIN);
	console.log('DATABASE_PATH:', config.DATABASE_PATH);
	console.log('AUTO_START:', config.AUTO_START);
	console.log('SEED_NODES:', config.SEED_NODES);
	console.log('BYPASS_ADMIN_AUTH:', config.BYPASS_ADMIN_AUTH);
	console.log('Number of ADMIN_API_KEYS:', config.ADMIN_API_KEYS.length);
}

export default config;