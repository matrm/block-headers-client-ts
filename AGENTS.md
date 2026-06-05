# Context: Block Headers Client

A typescript bitcoin sv block headers client.

## Build & Test

```bash
npm run build           # TypeScript compile → dist/ (also serves as typecheck)
npm run test            # Unit + integration tests (excludes long-running BlockHeadersClient.spec.ts)
npm run test:connections # Long-running BlockHeadersClient.spec.ts test (needs live network)
npm run test:coverage   # Tests with coverage report
npm run start-build     # Build then run the HTTP/WebSocket server
npm run start-nobuild   # Run server without rebuilding (requires prior build)
```

## Project Structure

### Source Files (`src/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | Library entrypoint that exports `BlockHeadersClient` class and `BlockHeader` (the TypeScript type and not the class) |
| `src/BlockHeader.ts` | Block header TypeScript type and internally used class (BlockHeaderMutable) |
| `src/BlockHeadersClient.ts` | Main client that manages node connections, header download, chain selection, and re-orgs |
| `src/BlockHeadersDatabase.ts` | Organizes in memory data structures of block headers and saves them in LevelDB |
| `src/chainProtocol.ts` | Chain protocol params where only `'bsv'` is active and others are commented out |
| `src/ConnectionMonitor.ts` | Monitors internet connection health |
| `src/constants.ts` | Shared constants like database path/version |
| `src/LegacyNodeConnection.ts` | Primary node TCP connection (send/receive P2P messages) |
| `src/NodeConnection.ts` | Interface of LegacyNodeConnection for future compatibility |
| `src/NodesDatabase.ts` | Organizes and maintains a reputation network of node addresses in memory and saves them in LevelDB |
| `src/types.ts` | Shared TypeScript type definitions |
| `src/p2p/messages.ts` | Bitcoin P2P protocol message construction and parsing |
| `src/utils/crypto.ts` | Cryptographic utilities |
| `src/utils/util.ts` | General utilities including custom `assert()` and sleep functions |

### Server Source Files (`src/api/`) (Experimental, excluded from npm package)

| File | Purpose |
|------|---------|
| `src/api/index.ts` | Server entrypoint for Express + WebSocket startup |
| `src/api/config.ts` | Loads configuration from `.env` |
| `src/api/express.ts` | Express app setup and middleware wiring |
| `src/api/helpers.ts` | Server utility functions |
| `src/api/presenters.ts` | Data formatting for API JSON responses |
| `src/api/websockets.ts` | WebSocket server setup and event broadcasting |
| `src/api/middleware/adminAuth.ts` | Admin API key authentication |
| `src/api/middleware/errorHandlers.ts` | Express error handling middleware |
| `src/api/middleware/logger.ts` | Request logging middleware |
| `src/api/middleware/rateLimiter.ts` | Rate limiting middleware |
| `src/api/routes/adminRoutes.ts` | `GET /admin/start`, `GET /admin/stop`, `GET /verify`(doesn't use /admin path so it can be later used for non-admin auth) |
| `src/api/routes/dashboard.html` | Server dashboard HTML page |
| `src/api/routes/dashboardRoutes.ts` | Dashboard page route |
| `src/api/routes/headerRoutes.ts` | `GET /header/:id` (by height or hash or 'tip') |
| `src/api/routes/peerRoutes.ts` | `GET /peers/connected` |

### Test Files (`tests/`)

| File | Type / What it tests |
|------|----------------------|
| `tests/testUtils.ts` | Test utilities providing `removeDirectoryWithRetries` for LevelDB cleanup |
| `tests/BlockHeader.test.ts` | Unit tests for the `BlockHeader` class |
| `tests/BlockHeadersClient.test.ts` | Long-running integration test requiring a live network connection (AI Agents should never run this!) |
| `tests/BlockHeadersDatabase.test.ts` | Unit and integration tests for the header store, sorting, and chain tip emit invariant |
| `tests/BlockHeadersClient.test.ts` | Unit tests for `BlockHeadersClient` logic that doesn't require a live network connection |
| `tests/BlockHeadersClient.spec.ts` | Long-running integration test requiring a live network connection (AI Agents should never run this!) |
| `tests/ConnectionMonitor.test.ts` | Unit tests for `ConnectionMonitor` logic |
| `tests/LegacyNodeConnection.test.ts` | Unit tests for `LegacyNodeConnection` logic that doesn't require a live network connection |
| `tests/NodesDatabase.test.ts` | Unit and integration tests for the LevelDB node store and reputation system |
| `tests/api/websockets.test.ts` | Unit tests for WebSocket server behavior |
| `tests/api/routes/adminRoutes.test.ts` | Unit tests for admin API endpoints |
| `tests/api/routes/headerRoutes.test.ts` | Unit tests for the header lookup endpoint |
| `tests/api/routes/peerRoutes.test.ts` | Unit tests for the peer listing endpoint |
| `tests/p2p/messages.test.ts` | Unit tests for P2P message serialization and parsing |
| `tests/utils/util.test.ts` | Unit tests for utility functions |

### Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Package manifest (scripts, deps, exports, files) |
| `tsconfig.json` | TypeScript compiler config (strict, NodeNext, ES2025) |
| `.editorconfig` | Editor formatting rules |
| `.gitignore` | Git ignore rules (root) |
| `tests/.gitignore` | Git ignore rules for test-level `db/` |
| `.github/workflows/publish.yml` | GitHub Actions CI/CD that runs tests and publishes to npm on push to main when there is a new version |
| `.env` | Environment variables (gitignored, secrets) |

### Documentation Files

| File | Purpose |
|------|---------|
| `README.md` | User-facing docs (library usage, server mode, API endpoints) |
| `AGENTS.md` | This file containing AI agent instructions |
| `LICENSE.txt` | License |

### Generated / Excluded Directories (gitignored)

| Directory | Description |
|-----------|-------------|
| `node_modules/` | npm dependencies |
| `dist/` | Compiled JS output (published to npm) |
| `coverage/` | Test coverage reports |
| `db/` | Runtime LevelDB database files (this is the default directory) |

### Key Notes

- **Module system**: ESM (`"type": "module"`), NodeNext resolution → **imports must use `.js` extensions** (e.g. `import { x } from './foo.js'`)
- **Published package** (via `"files"` in `package.json`): `dist/` (minus `dist/api/`), `README.md`, `LICENSE.txt`; no source, tests, or config are published
- **Runtime deps**: `level` (LevelDB) and `red-black-map` only; Express/ws are dev-only dependencies and not in the published package because server users are expected to install via git clone instead of npm.
- **Database async save strategy**: In-memory state is updated synchronously; LevelDB writes are queued asynchronously via internal promise chains (`_metricsSaveQueue`, etc.) and not awaited during normal operation. The DB flush is awaited in `dispose()` / `stop()` methods. If a queued LevelDB write fails, the error is logged unconditionally via `console.error` and then swallowed to avoid poisoning the queue. The in-memory data is the source of truth for the next save.

## Testing Quirks

- Database cleanup uses retries with `removeDirectoryWithRetries` in `tests/testUtils.ts` because LevelDB files may be locked (`EBUSY`) on Windows between tests
- The integration test (`test:connections`) connects to real BSV nodes and downloads headers; it needs a working internet connection and can take minutes. This should only ever be run by human developers.
- `tests/BlockHeadersClient.spec.ts` is the excluded long-running integration test (requires live network). Unit-level BlockHeadersClient tests are in `tests/BlockHeadersClient.test.ts`.

## Conventions

- The following files and directories must only be modified by human developers; do not edit them: `package.json`, `tsconfig.json`, `.github/workflows/publish.yml`.
- Avoid adding dependencies unless essential. The user must be asked for permission before installing any.
- Assertions use the project's own `assert()` in `src/utils/util.ts` which calls `process.exit(1)` on failure (not Node's built-in `assert`)
- Avoid using algorithms that have too much time-complexity for the data involved.
- Avoid hardcoding values as much as reasonably possible.
- Never reference line numbers, non example dates, issue numbers, or workflow items in commit messages, tests, or code.
- Comments shouldn't reference older versions of the codebase unless the context is backwards compatibility.
- Comment style: Use `/** ... */` JSDoc only for public method documentation describing the API contract (parameters, return values, purpose). All other comments, including internal implementation notes, design decisions, test documentation, benchmark comments, and section headers, must use the `// ` prefix. Inline single-word comments inside code blocks (e.g., `catch (e) { /* expected */ }`) are an exception and may remain `/* */` for readability.
- The em dash character (—) must not be used anywhere in the codebase.

## Logging Strategy

- **Informational / debug output** (`console.log`): Must be guarded by the `enableConsoleDebugLog` flag using the `this._enableConsoleDebugLog && console.log(...)` pattern. This includes progress messages, sync status, and other routine operational logging.
- **Errors and noteworthy failures** (`console.error`): Must be logged unconditionally (without the `enableConsoleDebugLog` guard). This includes LevelDB/database save failures, network errors, and unexpected exceptions. These are always important for operational awareness regardless of debug mode.
- The `enableConsoleDebugLog` flag is passed through constructors from `BlockHeadersClient.create()` down to child modules (`NodesDatabase`, `BlockHeadersDatabase`, `LegacyNodeConnection`, etc.).
- Unconditional `console.log` (without the guard) is also acceptable in:
  - The entry point (`src/api/index.ts`) for startup/shutdown messages and uncaught exception reporting
  - Assertion failures in `src/utils/util.ts`
  - API middleware (`src/api/middleware/errorHandlers.ts`)
  - Config loading (`src/api/config.ts`)
