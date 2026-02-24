import { bench, describe } from "vitest";
import { MerkleTree } from "@x811/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeItems(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    "hash-" + i.toString().padStart(6, "0"),
  );
}

// ---------------------------------------------------------------------------
// Tree Construction
// ---------------------------------------------------------------------------
describe("Merkle Tree Construction", () => {
  const items10 = makeItems(10);
  const items100 = makeItems(100);
  const items1000 = makeItems(1000);
  const items10000 = makeItems(10000);

  bench("Build tree with 10 items", () => {
    new MerkleTree(items10);
  });

  bench("Build tree with 100 items", () => {
    new MerkleTree(items100);
  });

  bench("Build tree with 1,000 items", () => {
    new MerkleTree(items1000);
  });

  bench("Build tree with 10,000 items", () => {
    new MerkleTree(items10000);
  });
});

// ---------------------------------------------------------------------------
// Proof Generation
// ---------------------------------------------------------------------------
describe("Merkle Proof Generation", () => {
  const items100 = makeItems(100);
  const items1000 = makeItems(1000);
  const tree100 = new MerkleTree(items100);
  const tree1000 = new MerkleTree(items1000);

  // Pick a middle item for proof generation
  const target100 = items100[50];
  const target1000 = items1000[500];

  bench("Generate proof from 100-item tree", () => {
    tree100.getProof(target100);
  });

  bench("Generate proof from 1,000-item tree", () => {
    tree1000.getProof(target1000);
  });
});

// ---------------------------------------------------------------------------
// Proof Verification
// ---------------------------------------------------------------------------
describe("Merkle Proof Verification", () => {
  const items100 = makeItems(100);
  const items1000 = makeItems(1000);
  const tree100 = new MerkleTree(items100);
  const tree1000 = new MerkleTree(items1000);

  const target100 = items100[50];
  const target1000 = items1000[500];
  const proof100 = tree100.getProof(target100);
  const proof1000 = tree1000.getProof(target1000);
  const root100 = tree100.root;
  const root1000 = tree1000.root;

  bench("Verify proof from 100-item tree", () => {
    MerkleTree.verify(target100, proof100, root100);
  });

  bench("Verify proof from 1,000-item tree", () => {
    MerkleTree.verify(target1000, proof1000, root1000);
  });
});
