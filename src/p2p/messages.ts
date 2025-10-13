import * as crypto from 'crypto';
import { IpPort } from '../types.js';

export function calculateChecksum(payload: Buffer): Buffer {
	const hash = crypto.createHash('sha256').update(payload).digest();
	const doubleHash = crypto.createHash('sha256').update(hash).digest();
	return doubleHash.slice(0, 4);
}

export function buildMessage(magic: Buffer, command: string, payload: Buffer): Buffer {
	const commandBuffer = Buffer.alloc(12);
	commandBuffer.write(command, 0, 'ascii');
	const lengthBuffer = Buffer.alloc(4);
	lengthBuffer.writeUInt32LE(payload.length, 0);
	const checksum = calculateChecksum(payload);
	return Buffer.concat([magic, commandBuffer, lengthBuffer, checksum, payload]);
}

export function createNetAddr(services: bigint, ip: string, port: number): Buffer {
	const servicesBuf = Buffer.alloc(8);
	servicesBuf.writeBigUInt64LE(services);

	const ipBuf = Buffer.alloc(16, 0);
	if (ip.includes(':')) {
		// IPv6.
		let segments: number[] = [];
		const parts = ip.split('::');
		if (parts.length > 2) throw new Error('Invalid IPv6 address: multiple ::');
		if (!parts.every(p => p.split(':').every(s => /^[0-9a-fA-F]{0,4}$/.test(s)))) {
			throw new Error('Invalid IPv6 address: segments must be hex');
		}
		if (parts.length === 1) {
			// No ::, expect exactly 8 segments.
			segments = parts[0].split(':').map(x => parseInt(x || '0', 16));
			if (segments.length !== 8) throw new Error('Invalid IPv6 address: must have 8 segments');
		} else {
			// Handle :: abbreviation.
			const left = parts[0] ? parts[0].split(':').map(x => parseInt(x, 16)) : [];
			const right = parts[1] ? parts[1].split(':').map(x => parseInt(x, 16)) : [];
			const zeroCount = 8 - (left.length + right.length);
			if (zeroCount < 0) throw new Error('Invalid IPv6 address: too many segments');
			segments = [...left, ...Array(zeroCount).fill(0), ...right];
		}

		// Write exactly 8 segments to the 16-byte buffer.
		for (let i = 0; i < 8; i++) {
			ipBuf.writeUInt16BE(segments[i], i * 2);
		}
	} else if (ip !== '0.0.0.0') {
		// IPv4 mapped to IPv6.
		ipBuf.writeUInt16BE(0xffff, 10);// ::ffff prefix.
		const octets = ip.split('.').map(Number);
		ipBuf.writeUInt8(octets[0], 12);
		ipBuf.writeUInt8(octets[1], 13);
		ipBuf.writeUInt8(octets[2], 14);
		ipBuf.writeUInt8(octets[3], 15);
	}// Else: 0.0.0.0 is already all zeros.

	const portBuf = Buffer.alloc(2);
	portBuf.writeUInt16BE(port);

	return Buffer.concat([servicesBuf, ipBuf, portBuf]);
}

export function buildVersionPayload({ version, userAgent, ip }: {
	version: number;
	userAgent: string;
	ip: string;
}): Buffer {
	const versionBuffer = Buffer.alloc(4);
	versionBuffer.writeInt32LE(version);
	const servicesBuffer = Buffer.alloc(8, 0);
	const timestampBuffer = Buffer.alloc(8);
	timestampBuffer.writeBigInt64LE(BigInt(Math.round(+new Date() / 1000)));
	const addrRecv = createNetAddr(BigInt(0), ip, 0);
	const addrFrom = createNetAddr(BigInt(0), '0.0.0.0', 0);
	const nonce = crypto.randomBytes(8);
	const userAgentBuffer = Buffer.from(userAgent, 'utf8');
	const userAgentBufferLengthBuffer = Buffer.from([userAgentBuffer.length]);
	const startHeightBuffer = Buffer.alloc(4);
	startHeightBuffer.writeInt32LE(0);
	const relayBuffer = Buffer.from([1]);
	return Buffer.concat([
		versionBuffer,
		servicesBuffer,
		timestampBuffer,
		addrRecv,
		addrFrom,
		nonce,
		userAgentBufferLengthBuffer,
		userAgentBuffer,
		startHeightBuffer,
		relayBuffer
	]);
}

export function buildGetHeadersPayload(version: number, from: Buffer[], to: Buffer = Buffer.alloc(32, 0)): Buffer {
	const versionBuffer = Buffer.alloc(4);
	versionBuffer.writeUInt32LE(version);
	const hashCount = writeVarInt(from.length);
	//const blockLocatorHashesBuffer = Buffer.concat(from);// This can't be used because BlockHeader reverses the buffer.
	const blockLocatorHashesBuffer = Buffer.concat(from.map((hash) => Buffer.from(hash).reverse()));// This must be used because BlockHeader reverses the buffer.
	const toReversed = Buffer.from(to).reverse();// This must be used because BlockHeader reverses the buffer.
	return Buffer.concat([versionBuffer, hashCount, blockLocatorHashesBuffer, toReversed]);
}

export function parseInvPayload(payload: Buffer): Buffer[] {
	const { value: count, length: varIntLength } = readVarInt(payload);
	const blocks: Buffer[] = [];
	let offset = 0;
	offset += varIntLength;
	for (let i = 0; i < count; i++) {
		if (offset + 36 > payload.length) throw new Error('Invalid inv payload: insufficient data');

		const type = payload.readUInt32LE(offset);// Read 4-byte type.
		offset += 4;
		const hash = payload.subarray(offset, offset + 32).reverse();// Extract 32-byte hash.
		offset += 32;
		if (type === 2) {
			blocks.push(hash);
		}
	}
	return blocks;
}

export function parseMessages(buffer: Buffer, magic: Buffer): {
	messages: { command: string; payload: Buffer }[];
	remaining: Buffer;
	errors: { command: string; message: string }[];
} {
	const messages: { command: string; payload: Buffer }[] = [];
	const errors: { command: string; message: string }[] = [];
	let offset = 0;

	while (offset + 24 <= buffer.length) {
		if (!buffer.slice(offset, offset + 4).equals(magic)) {
			offset++;
			continue;
		}
		const command = buffer.slice(offset + 4, offset + 16).toString('ascii').replace(/\0+$/, '');
		const length = buffer.readUInt32LE(offset + 16);
		if (offset + 24 + length > buffer.length) break;
		const payload = buffer.slice(offset + 24, offset + 24 + length);
		const checksum = buffer.slice(offset + 20, offset + 24);
		if (!calculateChecksum(payload).equals(checksum)) {
			errors.push({ command, message: `Checksum mismatch for ${command}` });
			offset += 24 + length;
			continue;
		}
		messages.push({ command, payload });
		offset += 24 + length;
	}
	return { messages, remaining: buffer.slice(offset), errors };
}

export function writeVarInt(value: number): Buffer {
	if (value < 0xfd) {
		return Buffer.from([value]);
	} else if (value <= 0xffff) {
		const buf = Buffer.alloc(3);
		buf[0] = 0xfd;
		buf.writeUInt16LE(value, 1);
		return buf;
	} else if (value <= 0xffffffff) {
		const buf = Buffer.alloc(5);
		buf[0] = 0xfe;
		buf.writeUInt32LE(value, 1);
		return buf;
	} else {
		const buf = Buffer.alloc(9);
		buf[0] = 0xff;
		buf.writeBigUInt64LE(BigInt(value), 1);
		return buf;
	}
}

export function readVarInt(buffer: Buffer): { value: number; length: number } {
	const firstByte = buffer[0];
	if (firstByte < 0xfd) return { value: firstByte, length: 1 };
	if (firstByte === 0xfd) return { value: buffer.readUInt16LE(1), length: 3 };
	if (firstByte === 0xfe) return { value: buffer.readUInt32LE(1), length: 5 };
	return { value: Number(buffer.readBigUInt64LE(1)), length: 9 };
}

export function parseAddrPayload(payload: Buffer): IpPort[] {
	const peers: IpPort[] = [];
	let offset = 0;
	const { value: count, length: varIntLength } = readVarInt(payload);
	offset += varIntLength;

	for (let i = 0; i < count; i++) {
		if (offset + 30 > payload.length) throw new Error('Invalid addr payload: insufficient data');

		// Skip timestamp (4 bytes)
		offset += 4;
		// Skip services (8 bytes)
		offset += 8;
		// Read IP (16 bytes)
		const ipBuffer = payload.subarray(offset, offset + 16);
		offset += 16;
		// Read port (2 bytes)
		const port = payload.readUInt16BE(offset);
		offset += 2;
		// Convert IP to string
		const ip = ipBufferToString(ipBuffer);
		peers.push({ ip, port });
	}
	return peers;
}

export function ipBufferToString(ipBuffer: Buffer): string {
	if (ipBuffer.length !== 16) throw new Error('Invalid IP buffer length');

	// Check for IPv4-mapped IPv6 address.
	if (ipBuffer.subarray(0, 12).equals(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]))) {
		// IPv4.
		return `${ipBuffer[12]}.${ipBuffer[13]}.${ipBuffer[14]}.${ipBuffer[15]}`;
	} else {
		// Basic IPv6 formatting.
		const parts: string[] = [];
		for (let i = 0; i < 16; i += 2) {
			parts.push(ipBuffer.readUInt16BE(i).toString(16));
		}
		return parts.join(':');
	}
}