/// <reference types="node" />
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Static proof of the dashboard client-status badge behavior. The dashboard's
// plain JavaScript is embedded in dashboard.html and cannot be imported, so the
// decision logic is extracted from the real file with regexes and evaluated
// directly, and the server-side no-replay property is asserted from
// websockets.ts. No new dependencies are needed.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const dashboardHtml = readFileSync(join(repoRoot, 'src', 'api', 'routes', 'dashboard.html'), 'utf-8');
const websocketsTs = readFileSync(join(repoRoot, 'src', 'api', 'websockets.ts'), 'utf-8');

// Extract a function body from the dashboard's embedded script. The HTML
// indents with tabs, so the body runs from after the opening `{` up to the
// closing brace at two-tab indentation.
const extractFunction = (source: string, name: string): string => {
	const re = new RegExp(`function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\t\\t\\}`, 'm');
	const match = source.match(re);
	if (!match) {
		throw new Error(`function ${name} not found in dashboard.html`);
	}
	return match[1];
};

// The decision at the heart of updateStatus: the event-driven clientRunning
// flag wins once it is known, and the connected-peer count is only a fallback
// before the first event arrives.
const updateStatusBody = extractFunction(dashboardHtml, 'updateStatus');
const decisionExpression = (() => {
	const match = updateStatusBody.match(/const running = (.+);\n/);
	if (!match) {
		throw new Error('status decision expression not found in updateStatus');
	}
	return match[1];
})();

// Evaluate the extracted expression exactly as the dashboard would, across the
// clientRunning/peers states that matter.
const evaluateDecision = (clientRunning: boolean | null, peers: any[] | null): boolean => {
	const fn = new Function('clientRunning', 'peers', `return (${decisionExpression});`);
	return fn(clientRunning, peers);
};

// Run the literal updateStatus source from the HTML against stubbed badge
// functions and report which badge text it would choose.
const simulateUpdateStatus = (clientRunning: boolean | null, peers: any[] | null): string => {
	const body = [
		'var chosenStatus = null;',
		`let clientRunning = ${JSON.stringify(clientRunning)};`,
		'function setStatusBadge(status) { chosenStatus = status.text; }',
		'function dispatchStatusUpdate() {}',
		"const CLIENT_STATUS_RUNNING = { text: 'Running' };",
		"const CLIENT_STATUS_STOPPED = { text: 'Stopped' };",
		`function updateStatus(peers) {\n${updateStatusBody}\n\t\t}`,
		`updateStatus(${JSON.stringify(peers)});`,
		'return chosenStatus;',
	].join('\n');
	return new Function(body)() as string;
};

const peersSample = [{ ip: '1.2.3.4', port: 8333, rating: 0.9 }];

describe('dashboard client status badge', () => {
	test('the status decision expression is the fallback chain from the real dashboard.html', () => {
		expect(decisionExpression).toBe('clientRunning !== null ? clientRunning : (peers && peers.length > 0)');
	});

	test('decision outcomes for the clientRunning/peers states', () => {
		// clientRunning is null until the first client_start / client_stop /
		// peer_connected / new_chain_tip event arrives after page load (or after
		// a WS reconnect resets it). With zero connected peers the fallback
		// decides STOPPED even though the client may be running: that is the
		// false-Stopped case during an outage.
		expect(evaluateDecision(null, [])).toBe(false);
		// The peer-count fallback works when peers exist.
		expect(evaluateDecision(null, peersSample)).toBe(true);
		// Once an event proves the client is running, it wins over zero peers.
		expect(evaluateDecision(true, [])).toBe(true);
		// client_stop wins over connected peers.
		expect(evaluateDecision(false, peersSample)).toBe(false);
	});

	test('updateStatus maps the decision to the badge text', () => {
		expect(simulateUpdateStatus(null, [])).toBe('Stopped');
		expect(simulateUpdateStatus(null, peersSample)).toBe('Running');
		expect(simulateUpdateStatus(true, [])).toBe('Running');
		expect(simulateUpdateStatus(false, peersSample)).toBe('Stopped');
	});

	test('clientRunning only becomes non-null via live WS events or admin buttons', () => {
		// One null assignment at page load and one in the WS onclose handler.
		expect((dashboardHtml.match(/clientRunning = null;/g) || [])).toHaveLength(2);
		// client_start, new_chain_tip, peer_connected handlers and the start button.
		expect((dashboardHtml.match(/clientRunning = true;/g) || [])).toHaveLength(4);
		// client_stop handler and the stop button.
		expect((dashboardHtml.match(/clientRunning = false;/g) || [])).toHaveLength(2);
	});

	test('server does not replay dashboard events to new subscribers', () => {
		// The subscribe handler only sends a suback: it never re-sends past
		// events, so a client_start emitted before the page loaded (or before
		// the WS reconnect) is never delivered to the dashboard.
		const handleSubscribeStart = websocketsTs.indexOf('const handleSubscribe');
		const handleUnsubscribeStart = websocketsTs.indexOf('const handleUnsubscribe');
		const handleSubscribeSource = websocketsTs.slice(handleSubscribeStart, handleUnsubscribeStart);
		expect(handleSubscribeStart).toBeGreaterThan(-1);
		expect(handleUnsubscribeStart).toBeGreaterThan(-1);
		expect(handleUnsubscribeStart).toBeGreaterThan(handleSubscribeStart);
		expect(handleSubscribeSource).toContain('suback');
		expect(handleSubscribeSource).not.toContain('dashboard:event');
		expect(handleSubscribeSource).not.toContain('client_start');

		// The connection handler also sends nothing on open; the only
		// dashboard:event sends happen from the debounce send callback to
		// currently-subscribed sockets.
		const connectionStart = websocketsTs.indexOf("wss.on('connection'");
		const closeStart = websocketsTs.indexOf("wss.on('close'");
		expect(connectionStart).toBeGreaterThan(-1);
		expect(closeStart).toBeGreaterThan(-1);
		expect(closeStart).toBeGreaterThan(connectionStart);
		const connectionHandlerSource = websocketsTs.slice(connectionStart, closeStart);
		expect(connectionHandlerSource).not.toContain('client_start');
		expect(connectionHandlerSource).not.toContain('dashboard:event');
	});

	test('the static badge markup starts as Stopped before any fetch completes', () => {
		expect(dashboardHtml).toContain('<div id="status-badge" class="badge stopped">');
	});
});
