# Block Headers Client

A typescript bitcoin sv block headers client.

## Features

- Follows the longest chain by proof of work.
- Distinguishes between forks by using invalid blocks.
- Efficiently re-orgs headers at a rate of 700k headers per second.
- Multiple protections against sybil attacks.
- Uses a reputation network for selecting the best nodes when connecting.

## System Requirements

- 1.2GB of RAM per 1 million block headers.

## Library / Client Mode

You can use this project as a library in your own project that interacts with the bitcoin network and manages block headers.

### Installation

```
npm install block-headers-client
```

### Client Example Usage

```typescript
import { BlockHeadersClient } from 'block-headers-client';

// Takes about 6 seconds to load 1 million previously downloaded headers.
const client = await BlockHeadersClient.create({
	chain: 'bsv',
	databasePath: './db',
});

// React to the newest chain tip after each new chunk of headers
// is downloaded.
// This callback can be assigned after await client.start() to prevent this
// callback from running until after the first initial sync.
// If this callback is assigned before client.start() is called, it
// will run after each chunk of headers is downloaded.
client.on('new_chain_tip', (height, hashHex) => {
	console.log(`New chain tip: ${height} - ${hashHex}`);
});

// Connects to nodes and downloads headers until reaching the chain tip.
// Takes about 20 seconds (depending on connection speed) the first time
// running and 2 seconds every other time.
await client.start();

const tip = client.getHeaderTip();
console.log('Current tip:', tip);

// Always call stop() when done using client.
await client.stop();
```

## Standalone App / Server Mode (Experimental)

In this mode, the project runs as an HTTP and WebSocket server, providing an API to access bitcoin block headers. Server functionality is an experimental feature that may eventually be removed or significantly changed.

### Installation

1. Download or Clone the repository:
```
git clone https://github.com/matrm/block-headers-client-ts.git
```
```
cd block-headers-client-ts
```
2. Install dependencies:
```
npm install
```
3. Create a `.env` file in the root of the project with the following content (all are optional):
```
PORT=3000
CONSOLE_DEBUG_LOG=false
CHAIN=bsv
DATABASE_PATH=./db
SEED_NODES=[{ "ip": "192.168.0.1", "port": 8333 }, { "ip": "192.168.0.2", "port": 8333 }]
BYPASS_ADMIN_AUTH=true
ADMIN_API_KEYS=["your-admin-api-key"]
```
4. Build:
```
npm run build
```

### Server Example Usage

1. Start the server:
```
npm run start-nobuild
```

The server will be running at `http://localhost:3000` but is not syncing to the longest chain yet.

2. Send a GET request to `/admin/start` to start the client, syncing to the longest chain. Requires an admin API key or BYPASS_ADMIN_AUTH set to true.
```
http://localhost:3000/admin/start
```

3. Send a GET request to `/admin/stop` or press ctrl+c to stop the client when done using. Sending the request requires an admin API key or BYPASS_ADMIN_AUTH set to true.
```
http://localhost:3000/admin/stop
```

### API Endpoints

-   `GET /header/:id`: Get a block header by height or hex hash. `:id` can be a block height (e.g., `400000`) or a block hash (e.g., `000000000000000004ec466ce4732fe6f1ed1cddc2ed4b328fff5224276e3f6f`). Use `tip` to get the latest header.
-   `GET /peers/connected`: Get the list of connected peers.
-   `GET /admin/start`: Start the client (requires an admin API key or BYPASS_ADMIN_AUTH set to true).
-   `GET /admin/stop`: Stop the client (requires an admin API key or BYPASS_ADMIN_AUTH set to true).

### WebSockets

The server also provides a WebSocket interface. It emits a `new_chain_tip` event when a new block header is received.