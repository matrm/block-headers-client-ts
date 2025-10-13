import { expect, test, describe } from 'vitest';

import { RedBlackTree, Color, RedBlackNode } from '../../src/utils/RedBlackTree';

/**
 * Helper function to validate essential Red-Black Tree properties.
 * Checks:
 * 1. Root is black.
 * 2. No red node has a red child (no consecutive reds).
 * 3. All simple paths from a node to a descendant leaf contain the same number of black nodes (black height).
 * 4. Parent pointers are correct.
 */
function validateRedBlackTree<K, V>(tree: RedBlackTree<K, V>) {
	// Access root for testing. This might require a specific test-only method.
	// or casting if the root is not publicly accessible.
	const root = (tree as any).root as RedBlackNode<K, V> | null;

	// Property 1: Root is black (or null for empty tree).
	expect(root === null || root.color === Color.BLACK).toBe(true);

	// Property 2 & 4 (Parent Pointer) Check:
	// If a node is red, its children must be black.
	// Also verify parent pointers during traversal.
	function checkNode(node: RedBlackNode<K, V> | null, parent: RedBlackNode<K, V> | null) {
		if (!node) return;

		// Check Property 2: No consecutive red nodes
		if (node.color === Color.RED && parent?.color === Color.RED) {
			expect.fail(`Validation failed: Two consecutive red nodes detected - Child: ${node.key}, Parent: ${parent.key}`);
		}

		// Check Property 4: Parent pointer correctness.
		expect(node.parent).toBe(parent);

		// Recurse.
		checkNode(node.left, node);
		checkNode(node.right, node);
	}
	checkNode(root, null);

	// Property 3: Every simple path from a node to a descendant leaf has the same black height.
	function getBlackHeight(node: RedBlackNode<K, V> | null): number {
		if (!node) {
			return 1;// Null nodes (leaves) are considered black and contribute 1 to black height.
		}

		const leftHeight = getBlackHeight(node.left);
		const rightHeight = getBlackHeight(node.right);

		// Check black heights of subtrees are equal.
		if (leftHeight !== rightHeight) {
			expect.fail(`Validation failed: Black height mismatch at node ${node.key} - Left: ${leftHeight}, Right: ${rightHeight}`);
		}

		// Return black height of the subtree rooted at 'node'.
		return leftHeight + (node.color === Color.BLACK ? 1 : 0);
	}

	// Start black height check from the root.
	getBlackHeight(root);
}

/**
 * Helper to create a RedBlackTree instance configured for number keys and string values.
 */
function createNumberTree(): RedBlackTree<number, string> {
	return new RedBlackTree<number, string>((a, b) => a - b);
}

/**
 * Helper to create a RedBlackTree instance configured for string keys and number values.
 */
function createStringTree(): RedBlackTree<string, number> {
	return new RedBlackTree<string, number>((a, b) => a.localeCompare(b));
}


describe('RedBlackTree (Number Keys)', () => {
	test('should initialize an empty tree', () => {
		const tree = createNumberTree();
		expect(tree.size).toBe(0);
		expect(tree.get(1)).toBeUndefined();
		validateRedBlackTree(tree);
	});

	test('should insert a single node and find it', () => {
		const tree = createNumberTree();
		tree.set(1, 'one');
		expect(tree.size).toBe(1);
		expect(tree.get(1)).toBe('one');
		expect(tree.get(2)).toBeUndefined();
		validateRedBlackTree(tree);
	});

	test('should overwrite value for existing key', () => {
		const tree = createNumberTree();
		tree.set(1, 'one');
		expect(tree.size).toBe(1);
		tree.set(1, 'one-updated');// Overwrite.
		expect(tree.size).toBe(1);// Size should not change.
		expect(tree.get(1)).toBe('one-updated');
		validateRedBlackTree(tree);
	});

	test('should correctly handle has method', () => {
		const tree = createNumberTree();
		expect(tree.has(1)).toBe(false);
		tree.set(1, 'one');
		expect(tree.has(1)).toBe(true);
		expect(tree.has(2)).toBe(false);
		tree.delete(1);
		expect(tree.has(1)).toBe(false);
		validateRedBlackTree(tree);
	});

	test('should clear the tree', () => {
		const tree = createNumberTree();
		tree.set(1, 'one');
		tree.set(2, 'two');
		expect(tree.size).toBe(2);
		tree.clear();
		expect(tree.size).toBe(0);
		expect(tree.get(1)).toBeUndefined();
		expect([...tree.keys()]).toEqual([]);
		validateRedBlackTree(tree);
	});

	describe('Iterators', () => {
		test('should return empty iterators for an empty tree', () => {
			const tree = createNumberTree();
			expect([...tree.entries()]).toEqual([]);
			expect([...tree.entriesReversed()]).toEqual([]);
			expect([...tree.keys()]).toEqual([]);
			expect([...tree.keysReversed()]).toEqual([]);
			expect([...tree.values()]).toEqual([]);
			expect([...tree.valuesReversed()]).toEqual([]);
		});

		test('should iterate correctly with a single node', () => {
			const tree = createNumberTree();
			tree.set(10, 'ten');
			expect([...tree.entries()]).toEqual([[10, 'ten']]);
			expect([...tree.entriesReversed()]).toEqual([[10, 'ten']]);
			expect([...tree.keys()]).toEqual([10]);
			expect([...tree.keysReversed()]).toEqual([10]);
			expect([...tree.values()]).toEqual(['ten']);
			expect([...tree.valuesReversed()]).toEqual(['ten']);
			validateRedBlackTree(tree);
		});

		test('should iterate entries, keys, and values in ascending order', () => {
			const tree = createNumberTree();
			const items: [number, string][] = [
				[5, 'five'], [3, 'three'], [7, 'seven'], [2, 'two'],
				[4, 'four'], [6, 'six'], [8, 'eight']
			];
			items.forEach(([key, value]) => tree.set(key, value));

			const sortedItems = items.sort((a, b) => a[0] - b[0]);
			const sortedKeys = sortedItems.map(item => item[0]);
			const sortedValues = sortedItems.map(item => item[1]);

			expect([...tree.entries()]).toEqual(sortedItems);
			expect([...tree.keys()]).toEqual(sortedKeys);
			expect([...tree.values()]).toEqual(sortedValues);
			validateRedBlackTree(tree);
		});

		test('should iterate entries, keys, and values in descending order', () => {
			const tree = createNumberTree();
			const items: [number, string][] = [
				[5, 'five'], [3, 'three'], [7, 'seven'], [2, 'two'],
				[4, 'four'], [6, 'six'], [8, 'eight']
			];
			items.forEach(([key, value]) => tree.set(key, value));

			const sortedItemsDesc = items.sort((a, b) => b[0] - a[0]);
			const sortedKeysDesc = sortedItemsDesc.map(item => item[0]);
			const sortedValuesDesc = sortedItemsDesc.map(item => item[1]);

			expect([...tree.entriesReversed()]).toEqual(sortedItemsDesc);
			expect([...tree.keysReversed()]).toEqual(sortedKeysDesc);
			expect([...tree.valuesReversed()]).toEqual(sortedValuesDesc);
			validateRedBlackTree(tree);
		});

		test('should iterate correctly after insertions and deletions', () => {
			const tree = createNumberTree();
			const initialKeys = [10, 20, 5, 15, 25, 3, 8];
			initialKeys.forEach(k => tree.set(k, `val${k}`));

			// Delete some keys.
			tree.delete(20);
			tree.delete(5);

			// Add some new keys.
			tree.set(1, 'val1');
			tree.set(18, 'val18');

			const finalKeys = [10, 15, 25, 3, 8, 1, 18];
			const sortedKeys = finalKeys.sort((a, b) => a - b);
			const sortedValues = sortedKeys.map(k => `val${k}`);
			const sortedEntries = sortedKeys.map(k => [k, `val${k}`] as [number, string]);

			const sortedKeysDesc = [...sortedKeys].reverse();
			const sortedValuesDesc = [...sortedValues].reverse();
			const sortedEntriesDesc = [...sortedEntries].reverse();

			expect([...tree.keys()]).toEqual(sortedKeys);
			expect([...tree.values()]).toEqual(sortedValues);
			expect([...tree.entries()]).toEqual(sortedEntries);

			expect([...tree.keysReversed()]).toEqual(sortedKeysDesc);
			expect([...tree.valuesReversed()]).toEqual(sortedValuesDesc);
			expect([...tree.entriesReversed()]).toEqual(sortedEntriesDesc);

			expect(tree.size).toBe(finalKeys.length);
			validateRedBlackTree(tree);
		});
	});

	describe('Deletion', () => {
		test('should return false when removing a node that doesn’t exist', () => {
			const tree = createNumberTree();
			tree.set(1, 'one');
			expect(tree.size).toBe(1);
			expect(tree.delete(2)).toBe(false);// Remove non-existent key.
			expect(tree.size).toBe(1);// Size should not change.
			validateRedBlackTree(tree);
		});

		test('should correctly remove a red leaf node', () => {
			const tree = createNumberTree();
			tree.set(4, 'four');
			tree.set(3, 'three');
			tree.set(5, 'five');
			tree.set(1, 'one');// 1 is a red leaf.
			expect(tree.size).toBe(4);
			validateRedBlackTree(tree);

			expect(tree.delete(1)).toBe(true);
			expect(tree.size).toBe(3);
			expect(tree.get(1)).toBeUndefined();
			expect([...tree.keys()]).toEqual([3, 4, 5]);
			validateRedBlackTree(tree);
		});

		test('should handle removal of a node with two children where successor is its right child', () => {
			const tree = createNumberTree();
			tree.set(5, 'five');
			tree.set(3, 'three');
			tree.set(7, 'seven');
			tree.set(6, 'six');
			expect(tree.size).toBe(4);
			validateRedBlackTree(tree);

			// Remove 5(B). Successor is 6(R). 6 replaces 5.
			expect(tree.delete(5)).toBe(true);
			expect(tree.size).toBe(3);
			expect(tree.get(5)).toBeUndefined();
			expect([...tree.keys()]).toEqual([3, 6, 7]);
			validateRedBlackTree(tree);
		});

		test('should handle a large number of insertions and deletions', () => {
			const tree = createNumberTree();
			const N = 1000;
			const keys = Array.from({ length: N }, (_, i) => i);

			// Shuffle keys for random insertion order.
			for (let i = keys.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[keys[i], keys[j]] = [keys[j], keys[i]];
			}

			keys.forEach(k => tree.set(k, `val${k}`));
			expect(tree.size).toBe(N);
			validateRedBlackTree(tree);

			// Shuffle keys for random deletion order.
			for (let i = keys.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[keys[i], keys[j]] = [keys[j], keys[i]];
			}

			for (let i = 0; i < N / 2; i++) {
				expect(tree.delete(keys[i])).toBe(true);
			}
			expect(tree.size).toBe(N - N / 2);
			validateRedBlackTree(tree);

			const remainingKeys = keys.slice(N / 2).sort((a, b) => a - b);
			expect([...tree.keys()]).toEqual(remainingKeys);
		});
	});
});

describe('RedBlackTree (String Keys)', () => {
	test('should handle string keys correctly, including iteration and deletion', () => {
		const tree = createStringTree();
		const keys = ['banana', 'apple', 'orange', 'grape', 'cherry'];
		keys.forEach((key) => tree.set(key, key.length));

		const sortedKeys = keys.sort((a, b) => a.localeCompare(b));
		const expectedEntries = sortedKeys.map(key => [key, key.length] as [string, number]);
		const expectedValues = sortedKeys.map(key => key.length);

		expect([...tree.entries()]).toEqual(expectedEntries);
		expect([...tree.keys()]).toEqual(sortedKeys);
		expect([...tree.values()]).toEqual(expectedValues);
		expect(tree.size).toBe(keys.length);
		validateRedBlackTree(tree);

		// Test get & has.
		expect(tree.get('apple')).toBe(5);
		expect(tree.has('orange')).toBe(true);
		expect(tree.get('kiwi')).toBeUndefined();
		expect(tree.has('kiwi')).toBe(false);

		// Test deletion.
		expect(tree.delete('orange')).toBe(true);
		expect(tree.size).toBe(keys.length - 1);
		validateRedBlackTree(tree);

		// Test iteration after deletion.
		const remainingKeys = sortedKeys.filter(key => key !== 'orange');
		const expectedRemainingEntries = remainingKeys.map(key => [key, key.length] as [string, number]);
		const expectedRemainingValues = remainingKeys.map(key => key.length);

		expect([...tree.entries()]).toEqual(expectedRemainingEntries);
		expect([...tree.entriesReversed()]).toEqual([...expectedRemainingEntries].reverse());
		expect([...tree.keys()]).toEqual(remainingKeys);
		expect([...tree.keysReversed()]).toEqual([...remainingKeys].reverse());
		expect([...tree.values()]).toEqual(expectedRemainingValues);
		expect([...tree.valuesReversed()]).toEqual([...expectedRemainingValues].reverse());
	});

	test('should handle string keys with overwrite', () => {
		const tree = createStringTree();
		tree.set('apple', 1);
		expect(tree.get('apple')).toBe(1);
		tree.set('apple', 5);// Overwrite.
		expect(tree.get('apple')).toBe(5);
		expect(tree.size).toBe(1);
		expect([...tree.entries()]).toEqual([['apple', 5]]);
		validateRedBlackTree(tree);
	});
});