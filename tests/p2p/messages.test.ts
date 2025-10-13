import { expect, test, describe } from 'vitest';
import * as crypto from 'crypto';
import {
	calculateChecksum,
	buildMessage,
	createNetAddr,
	buildVersionPayload,
	buildGetHeadersPayload,
	parseInvPayload,
	parseMessages,
	writeVarInt,
	readVarInt,
	parseAddrPayload,
	ipBufferToString,
} from '../../src/p2p/messages.js';
import { getMagic } from '../../src/chainProtocol.js';

describe('p2p messages', () => {
	const magic = getMagic('bsv');

	describe('calculateChecksum', () => {
		test('should calculate the correct checksum', () => {
			const payload = Buffer.from('hello world');
			const checksum = calculateChecksum(payload);
			const expectedChecksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().slice(0, 4);
			expect(checksum).toEqual(expectedChecksum);
		});
	});

	describe('buildMessage', () => {
		test('should build a valid message structure', () => {
			const command = 'version';
			const payload = Buffer.from([0x01, 0x02]);
			const message = buildMessage(magic, command, payload);

			expect(message.slice(0, 4)).toEqual(magic);
			expect(message.slice(4, 16).toString('ascii').replace(/\0+$/, '')).toBe(command);
			expect(message.readUInt32LE(16)).toBe(payload.length);
			expect(message.slice(20, 24)).toEqual(calculateChecksum(payload));
			expect(message.slice(24)).toEqual(payload);
		});
	});

	describe('VarInt', () => {
		test('should write and read varints correctly', () => {
			const values = [0, 1, 252, 253, 65535, 65536, 0xffffffff, 0x100000000];
			for (const value of values) {
				const buffer = writeVarInt(value);
				const { value: readValue, length } = readVarInt(buffer);
				expect(readValue).toBe(value);
				expect(length).toBe(buffer.length);
			}
		});
	});

	describe('createNetAddr', () => {
		test('should create a net_addr for IPv4', () => {
			const ip = '127.0.0.1';
			const port = 8333;
			const netAddr = createNetAddr(BigInt(1), ip, port);
			expect(netAddr.length).toBe(26);
			// services.
			expect(netAddr.readBigUInt64LE(0)).toBe(BigInt(1));
			// ipv4 mapped ipv6.
			expect(netAddr.slice(8, 24).toString('hex')).toBe('00000000000000000000ffff7f000001');
			// port.
			expect(netAddr.readUInt16BE(24)).toBe(port);
		});

		test('should create a net_addr for IPv6', () => {
			const ip = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
			const port = 8333;
			const netAddr = createNetAddr(BigInt(1), ip, port);
			expect(netAddr.length).toBe(26);
			expect(netAddr.readBigUInt64LE(0)).toBe(BigInt(1));
			expect(netAddr.slice(8, 24).toString('hex')).toBe('20010db885a3000000008a2e03707334');
			expect(netAddr.readUInt16BE(24)).toBe(port);
		});
	});

	describe('version payload', () => {
		test('should build a version payload', () => {
			const payload = buildVersionPayload({
				version: 70016,
				userAgent: '/Bitcoin SV/',
				ip: '127.0.0.1',
			});
			// Basic checks.
			expect(payload.readInt32LE(0)).toBe(70016);
			expect(payload.slice(81, 81 + '/Bitcoin SV/'.length).toString()).toBe('/Bitcoin SV/');
		});
	});

	describe('getheaders payload', () => {
		test('should build a getheaders payload', () => {
			const from = [crypto.randomBytes(32)];
			const to = crypto.randomBytes(32);
			const payload = buildGetHeadersPayload(70016, from, to);
			expect(payload.readUInt32LE(0)).toBe(70016);
			expect(payload[4]).toBe(1);// hash_count.
			expect(payload.slice(5, 37)).toEqual(Buffer.from(from[0]).reverse());
			expect(payload.slice(37)).toEqual(Buffer.from(to).reverse());
		});
	});

	describe('parseMessages', () => {
		test('should parse a single valid message', () => {
			const payload = Buffer.from('test payload');
			const message = buildMessage(magic, 'test', payload);
			const { messages, remaining, errors } = parseMessages(message, magic);
			expect(messages.length).toBe(1);
			expect(messages[0].command).toBe('test');
			expect(messages[0].payload).toEqual(payload);
			expect(remaining.length).toBe(0);
			expect(errors.length).toBe(0);
		});

		test('should parse multiple valid messages', () => {
			const msg1 = buildMessage(magic, 'test1', Buffer.from('p1'));
			const msg2 = buildMessage(magic, 'test2', Buffer.from('p2'));
			const buffer = Buffer.concat([msg1, msg2]);
			const { messages, remaining, errors } = parseMessages(buffer, magic);
			expect(messages.length).toBe(2);
			expect(messages[0].command).toBe('test1');
			expect(messages[1].command).toBe('test2');
			expect(remaining.length).toBe(0);
			expect(errors.length).toBe(0);
		});

		test('should handle buffer with partial message', () => {
			const msg1 = buildMessage(magic, 'test1', Buffer.from('p1'));
			const partialBuffer = msg1.slice(0, msg1.length - 5);
			const { messages, remaining, errors } = parseMessages(partialBuffer, magic);
			expect(messages.length).toBe(0);
			expect(remaining).toEqual(partialBuffer);
			expect(errors.length).toBe(0);
		});

		test('should handle invalid checksum', () => {
			const payload = Buffer.from('p1');
			const msg = buildMessage(magic, 'test1', payload);
			msg[21] = 0;// Corrupt checksum.
			const { messages, remaining, errors } = parseMessages(msg, magic);
			expect(messages.length).toBe(0);
			expect(errors.length).toBe(1);
			expect(errors[0].command).toBe('test1');
			expect(errors[0].message).toContain('Checksum mismatch');
			expect(remaining.length).toBe(0);
		});

		test('should handle garbage data between messages', () => {
			const msg1 = buildMessage(magic, 'test1', Buffer.from('p1'));
			const msg2 = buildMessage(magic, 'test2', Buffer.from('p2'));
			const garbage = Buffer.from('garbage');
			const buffer = Buffer.concat([garbage, msg1, garbage, msg2, garbage]);
			const { messages, remaining, errors } = parseMessages(buffer, magic);
			expect(messages.length).toBe(2);
			expect(messages[0].command).toBe('test1');
			expect(messages[1].command).toBe('test2');
			expect(remaining).toEqual(garbage);
			expect(errors.length).toBe(0);
		});
	});

	describe('parseInvPayload', () => {
		test('should parse an inv payload with block hashes', () => {
			const hash1 = crypto.randomBytes(32);
			const hash2 = crypto.randomBytes(32);
			const count = writeVarInt(2);
			const entry1 = Buffer.concat([Buffer.from([2, 0, 0, 0]), hash1]);
			const entry2 = Buffer.concat([Buffer.from([2, 0, 0, 0]), hash2]);
			const payload = Buffer.concat([count, entry1, entry2]);

			const blockHashes = parseInvPayload(payload);
			expect(blockHashes.length).toBe(2);
			expect(blockHashes[0]).toEqual(Buffer.from(hash1).reverse());
			expect(blockHashes[1]).toEqual(Buffer.from(hash2).reverse());
		});

		test('should filter non-block inventory types', () => {
			const blockHash = crypto.randomBytes(32);
			const txHash = crypto.randomBytes(32);
			const count = writeVarInt(2);
			const entry1 = Buffer.concat([Buffer.from([2, 0, 0, 0]), blockHash]);// type 2 = block.
			const entry2 = Buffer.concat([Buffer.from([1, 0, 0, 0]), txHash]);// type 1 = tx.
			const payload = Buffer.concat([count, entry1, entry2]);

			const blockHashes = parseInvPayload(payload);
			expect(blockHashes.length).toBe(1);
			expect(blockHashes[0]).toEqual(Buffer.from(blockHash).reverse());
		});
	});

	describe('parseAddrPayload and ipBufferToString', () => {
		test('should parse an addr payload with IPv4 and IPv6 addresses', () => {
			const ipv4 = '1.2.3.4';
			const ipv6 = '2001:db8::1';
			const port = 8333;

			const netAddr1 = createNetAddr(BigInt(1), ipv4, port);
			const netAddr2 = createNetAddr(BigInt(1), ipv6, port);

			const count = writeVarInt(2);
			// addr payload has timestamp before net_addr.
			const timestamp = Buffer.alloc(4);
			const payload = Buffer.concat([count, timestamp, netAddr1, timestamp, netAddr2]);

			const peers = parseAddrPayload(payload);
			expect(peers.length).toBe(2);
			expect(peers[0].ip).toBe(ipv4);
			expect(peers[0].port).toBe(port);
			expect(peers[1].ip).toBe('2001:db8:0:0:0:0:0:1');// Expanded form.
			expect(peers[1].port).toBe(port);
		});
	});
});