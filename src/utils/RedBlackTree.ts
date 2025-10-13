export enum Color {
	RED,
	BLACK,
}

export class RedBlackNode<K, V> {
	key: K;
	value: V;
	color: Color;
	left: RedBlackNode<K, V> | null = null;
	right: RedBlackNode<K, V> | null = null;
	parent: RedBlackNode<K, V> | null = null;

	constructor(key: K, value: V) {
		this.key = key;
		this.value = value;
		this.color = Color.RED;// New nodes are initially RED.
	}
}

export class RedBlackTree<K, V> {
	private root: RedBlackNode<K, V> | null = null;
	private comparator: (a: K, b: K) => number;
	private _size: number = 0;

	constructor(comparator: (a: K, b: K) => number) {
		this.comparator = comparator;
	}

	// Get the number of key-value pairs in the tree.
	public get size(): number {
		return this._size;
	}

	// Rotates left at the given node.
	private rotateLeft(node: RedBlackNode<K, V>): void {
		const rightChild = node.right!;// rightChild cannot be null.
		node.right = rightChild.left;
		if (rightChild.left) {
			rightChild.left.parent = node;
		}
		rightChild.parent = node.parent;
		if (!node.parent) {
			this.root = rightChild;
		} else if (node === node.parent.left) {
			node.parent.left = rightChild;
		} else {
			node.parent.right = rightChild;
		}
		rightChild.left = node;
		node.parent = rightChild;
	}

	// Rotates right at the given node.
	private rotateRight(node: RedBlackNode<K, V>): void {
		const leftChild = node.left!;// leftChild cannot be null.
		node.left = leftChild.right;
		if (leftChild.right) {
			leftChild.right.parent = node;
		}
		leftChild.parent = node.parent;
		if (!node.parent) {
			this.root = leftChild;
		} else if (node === node.parent.right) {
			node.parent.right = leftChild;
		} else {
			node.parent.left = leftChild;
		}
		leftChild.right = node;
		node.parent = leftChild;
	}

	// Fixes violations after insertion.
	private fixInsertion(node: RedBlackNode<K, V>): void {
		let current = node;
		// Loop as long as current node is not root and its parent is RED.
		while (current !== this.root && current.parent && current.parent.color === Color.RED) {
			const parent = current.parent;
			const grandparent = parent.parent!;// Grandparent must exist if parent is RED (and not root).

			if (parent === grandparent.left) {
				const uncle = grandparent.right;
				if (uncle && uncle.color === Color.RED) {// Case 1: Uncle is RED.
					parent.color = Color.BLACK;
					uncle.color = Color.BLACK;
					grandparent.color = Color.RED;
					current = grandparent;// Move up to grandparent.
				} else {// Uncle is BLACK or null.
					if (current === parent.right) {// Case 2: Current is right child (triangle).
						current = parent;
						this.rotateLeft(current);
					}
					// After rotation (if any), current is now the original parent or original current.
					// Update parent for Case 3.
					current.parent!.color = Color.BLACK;// Case 3: Current is left child (line).
					grandparent.color = Color.RED;
					this.rotateRight(grandparent);
				}
			} else {// Parent is right child of Grandparent (symmetric to above).
				const uncle = grandparent.left;
				if (uncle && uncle.color === Color.RED) {// Case 1: Uncle is RED.
					parent.color = Color.BLACK;
					uncle.color = Color.BLACK;
					grandparent.color = Color.RED;
					current = grandparent;
				} else {// Uncle is BLACK or null.
					if (current === parent.left) {// Case 2: Current is left child (triangle).
						current = parent;
						this.rotateRight(current);
					}
					// After rotation (if any), current is now the original parent or original current.
					// Update parent for Case 3.
					current.parent!.color = Color.BLACK;// Case 3: Current is right child (line).
					grandparent.color = Color.RED;
					this.rotateLeft(grandparent);
				}
			}
		}
		if (this.root) {
			this.root.color = Color.BLACK;// Root must always be BLACK.
		}
	}

	public set(key: K, value: V): void {
		let node = this.root;
		let parent: RedBlackNode<K, V> | null = null;

		// Traverse the tree to find the correct position for the new node.
		while (node) {
			parent = node;
			const cmp = this.comparator(key, node.key);
			if (cmp < 0) {
				node = node.left;
			} else if (cmp > 0) {
				node = node.right;
			} else {
				node.value = value;// Key already exists, update value.
				return;
			}
		}

		const newNode = new RedBlackNode(key, value);
		newNode.parent = parent;

		if (!parent) {
			this.root = newNode;// Tree was empty.
		} else if (this.comparator(key, parent.key) < 0) {
			parent.left = newNode;
		} else {
			parent.right = newNode;
		}
		this._size++;
		this.fixInsertion(newNode);// Fix any Red-Black property violations.
	}

	public get(key: K): V | undefined {
		let node = this.root;
		while (node) {
			const cmp = this.comparator(key, node.key);
			if (cmp < 0) {
				node = node.left;
			} else if (cmp > 0) {
				node = node.right;
			} else {
				return node.value;// Key found.
			}
		}
		return undefined;// Key not found.
	}

	// Replaces subtree rooted at u with subtree rooted at v.
	private transplant(u: RedBlackNode<K, V>, v: RedBlackNode<K, V> | null): void {
		if (!u.parent) {
			this.root = v;
		} else if (u === u.parent.left) {
			u.parent.left = v;
		} else {
			u.parent.right = v;
		}
		if (v) {
			v.parent = u.parent;
		}
	}

	// Finds the node with the minimum key in the subtree rooted at node.
	private minimum(node: RedBlackNode<K, V>): RedBlackNode<K, V> {
		let current = node;
		while (current.left) {
			current = current.left;
		}
		return current;
	}

	// Deletes the given node from the tree.
	private deleteNode(nodeToDelete: RedBlackNode<K, V>): void {
		let y = nodeToDelete;// y is the node to be spliced out or copied from.
		let yOriginalColor = y.color;
		let x: RedBlackNode<K, V> | null;// x is the child that replaces y.
		let parentOfX: RedBlackNode<K, V> | null;// Parent of x's position.

		if (!nodeToDelete.left) {
			x = nodeToDelete.right;
			parentOfX = nodeToDelete.parent;// x will be child of nodeToDelete.parent.
			this.transplant(nodeToDelete, x);
		} else if (!nodeToDelete.right) {
			x = nodeToDelete.left;
			parentOfX = nodeToDelete.parent;// x will be child of nodeToDelete.parent.
			this.transplant(nodeToDelete, x);
		} else {
			y = this.minimum(nodeToDelete.right);// y is the successor.
			yOriginalColor = y.color;
			x = y.right;// x is y's right child (might be null).

			if (y.parent === nodeToDelete) {
				// If y is direct child of nodeToDelete, x's conceptual parent is y.
				// After y moves to nodeToDelete's spot, x (if not null) will be y.right.
				// If x is null, its conceptual parent (for fixDelete) is y.
				parentOfX = y;
				if (x) x.parent = y;// Ensure x.parent is set if x is not null.
			} else {
				// y is not a direct child of nodeToDelete.
				// x will take y's original spot. So x's parent is y's original parent.
				parentOfX = y.parent;
				this.transplant(y, x);// x replaces y in its original position.
				y.right = nodeToDelete.right;
				y.right.parent = y;
			}
			this.transplant(nodeToDelete, y);// y replaces nodeToDelete.
			y.left = nodeToDelete.left;
			y.left.parent = y;
			y.color = nodeToDelete.color;// y takes nodeToDelete's color.
		}

		if (yOriginalColor === Color.BLACK) {
			// If x is not null, x.parent is its actual current parent.
			// If x is null, parentOfX is its conceptual parent for fixDelete.
			// The parent passed to fixDelete must be the actual parent of x's position.
			const actualParentOfX = x ? x.parent : parentOfX;
			this.fixDelete(x, actualParentOfX);
		}
	}

	// Fixes violations after deletion.
	private fixDelete(x: RedBlackNode<K, V> | null, parentOfX: RedBlackNode<K, V> | null): void {
		let currentX = x;
		let currentParent = parentOfX;

		while (currentX !== this.root && (!currentX || currentX.color === Color.BLACK)) {
			if (!currentParent) {// Should only happen if x is root and null/black (loop terminates).
				break;
			}

			if (currentX === currentParent.left) {// currentX is a left child (or null in left child's position).
				let siblingW = currentParent.right;

				if (siblingW && siblingW.color === Color.RED) {// Case 1: Sibling w is RED.
					siblingW.color = Color.BLACK;
					currentParent.color = Color.RED;
					this.rotateLeft(currentParent);
					siblingW = currentParent.right;// Update siblingW, it's now black and further down.
				}

				// Sibling w is now effectively BLACK (or null, treated as black).
				// Case 2: Sibling w is BLACK, and both of w's children are BLACK (or null).
				if (
					(!siblingW || !siblingW.left || siblingW.left.color === Color.BLACK) &&
					(!siblingW || !siblingW.right || siblingW.right.color === Color.BLACK)
				) {
					if (siblingW) {
						siblingW.color = Color.RED;
					}
					currentX = currentParent;// Move "problem" (double blackness) up.
					currentParent = currentX.parent;
				} else {// Sibling w is BLACK, and at least one of w's children is RED.
					// Case 3: Sibling w is BLACK, w.left is RED, w.right is BLACK (or null).
					if (!siblingW!.right || siblingW!.right.color === Color.BLACK) {// w cannot be null here.
						if (siblingW!.left) siblingW!.left.color = Color.BLACK;
						siblingW!.color = Color.RED;
						this.rotateRight(siblingW!);
						siblingW = currentParent.right;// Update siblingW.
					}
					// Case 4: Sibling w is BLACK, w.right is RED.
					// Sibling w is new sibling from Case 3 or original if Case 3 was skipped.
					siblingW!.color = currentParent.color;// w cannot be null here.
					currentParent.color = Color.BLACK;
					if (siblingW!.right) siblingW!.right.color = Color.BLACK;
					this.rotateLeft(currentParent);
					currentX = this.root;// Fixup complete, exit loop.
				}
			} else {// currentX is a right child (or null in right child's position) - symmetric to above.
				let siblingW = currentParent.left;

				if (siblingW && siblingW.color === Color.RED) {// Case 1.
					siblingW.color = Color.BLACK;
					currentParent.color = Color.RED;
					this.rotateRight(currentParent);
					siblingW = currentParent.left;
				}

				// Case 2
				if (
					(!siblingW || !siblingW.left || siblingW.left.color === Color.BLACK) &&
					(!siblingW || !siblingW.right || siblingW.right.color === Color.BLACK)
				) {
					if (siblingW) {
						siblingW.color = Color.RED;
					}
					currentX = currentParent;
					currentParent = currentX.parent;
				} else {
					// Case 3
					if (!siblingW!.left || siblingW!.left.color === Color.BLACK) {// w cannot be null.
						if (siblingW!.right) siblingW!.right.color = Color.BLACK;
						siblingW!.color = Color.RED;
						this.rotateLeft(siblingW!);
						siblingW = currentParent.left;
					}
					// Case 4
					siblingW!.color = currentParent.color;// w cannot be null.
					currentParent.color = Color.BLACK;
					if (siblingW!.left) siblingW!.left.color = Color.BLACK;
					this.rotateRight(currentParent);
					currentX = this.root;
				}
			}
		}
		if (currentX) {
			currentX.color = Color.BLACK;// Ensure x (or the node it became) is BLACK if it's not null.
		}
		if (this.root) {
			this.root.color = Color.BLACK;// Ensure root is always black.
		}
	}

	public has(key: K): boolean {
		let node = this.root;
		while (node) {
			const cmp = this.comparator(key, node.key);
			if (cmp < 0) {
				node = node.left;
			} else if (cmp > 0) {
				node = node.right;
			} else {
				return true;// Key found.
			}
		}
		return false;// Key not found.
	}

	public delete(key: K): boolean {
		let node = this.root;
		// Find the node to delete.
		while (node) {
			const cmp = this.comparator(key, node.key);
			if (cmp < 0) {
				node = node.left;
			} else if (cmp > 0) {
				node = node.right;
			} else {
				this.deleteNode(node);// Node found, delete it.
				this._size--;
				return true;
			}
		}
		return false;// Node not found.
	}

	// In-order iterator.
	public *entries(): Generator<[K, V], void, undefined> {
		const stack: RedBlackNode<K, V>[] = [];
		let current = this.root;

		while (stack.length > 0 || current !== null) {
			while (current !== null) {
				stack.push(current);
				current = current.left;
			}
			const node = stack.pop()!;
			yield [node.key, node.value];
			current = node.right;
		}
	}

	// Reverse in-order iterator.
	public *entriesReversed(): Generator<[K, V], void, undefined> {
		const stack: RedBlackNode<K, V>[] = [];
		let current = this.root;

		while (stack.length > 0 || current !== null) {
			while (current !== null) {
				stack.push(current);
				current = current.right;
			}
			const node = stack.pop()!;
			yield [node.key, node.value];
			current = node.left;
		}
	}

	public *keys(): Generator<K, void, undefined> {
		const stack: RedBlackNode<K, V>[] = [];
		let current = this.root;

		while (stack.length > 0 || current !== null) {
			while (current !== null) {
				stack.push(current);
				current = current.left;
			}
			const node = stack.pop()!;
			yield node.key;
			current = node.right;
		}
	}

	public *keysReversed(): Generator<K, void, undefined> {
		const stack: RedBlackNode<K, V>[] = [];
		let current = this.root;

		while (stack.length > 0 || current !== null) {
			while (current !== null) {
				stack.push(current);
				current = current.right;
			}
			const node = stack.pop()!;
			yield node.key;
			current = node.left;
		}
	}

	public *values(): Generator<V, void, undefined> {
		const stack: RedBlackNode<K, V>[] = [];
		let current = this.root;

		while (stack.length > 0 || current !== null) {
			while (current !== null) {
				stack.push(current);
				current = current.left;
			}
			const node = stack.pop()!;
			yield node.value;
			current = node.right;
		}
	}

	public *valuesReversed(): Generator<V, void, undefined> {
		const stack: RedBlackNode<K, V>[] = [];
		let current = this.root;

		while (stack.length > 0 || current !== null) {
			while (current !== null) {
				stack.push(current);
				current = current.right;
			}
			const node = stack.pop()!;
			yield node.value;
			current = node.left;
		}
	}

	public clear(): void {
		this.root = null;
		this._size = 0;
	}
}