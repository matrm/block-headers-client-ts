import { rm } from 'node:fs/promises';

export const removeDirectoryWithRetries = async (dbPath: string) => {
	const maxRetries = 5;
	const retryDelayMs = 100;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await rm(dbPath, { recursive: true, force: true });
			//console.log(`Successfully removed database path: ${dbPath}`);
			return;
		} catch (error) {
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				error.code === 'EBUSY' &&
				attempt < maxRetries
			) {
				console.log(`Attempt ${attempt}: Resource busy, retrying in ${retryDelayMs}ms...`);
				await new Promise(resolve => setTimeout(resolve, retryDelayMs));
			} else {
				console.error(`Failed to remove database path: ${dbPath}`, error);
				throw error;
			}
		}
	}
};

export const createDbWithRetries = async <T>(dbCreationFn: () => T | Promise<T>): Promise<T> => {
	const maxRetries = 5;
	const retryDelayMs = 100;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const db = await dbCreationFn();
			attempt > 1 && console.log(`Successfully created database on attempt ${attempt}`);
			return db;
		} catch (error) {
			if (attempt < maxRetries) {
				console.log(`Attempt ${attempt}: Database creation failed (file access error), retrying in ${retryDelayMs}ms...`);
				await new Promise(resolve => setTimeout(resolve, retryDelayMs));
			} else {
				console.error(`Failed to create database after ${attempt} attempts`, error);
				throw error;
			}
		}
	}
	throw new Error('Failed to create database after max retries');
};