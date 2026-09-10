/**
 * Canned API responses, shaped exactly like the real ones.
 *
 * The numbers are a real crawl of express@4.21.2, kept because the interesting property is
 * arithmetic: 232 paths reach only 72 distinct packages, and the size counted per path is
 * 2.4x the size actually downloaded. A rounder set of numbers would not exercise that.
 */
export const SIZE = {
  unique_packages: 72,
  paths: 232,
  deduped_bytes: 2_212_659,
  naive_bytes: 5_274_140,
  max_depth_seen: 8,
  unknown_size: 19,
  size_is_partial: true,
};

export const DUPLICATES = {
  duplicates: [
    { name: "get-intrinsic", versions: 4, which: ["1.1.3", "1.2.2", "1.2.3", "1.2.4"] },
    { name: "content-type", versions: 2, which: ["1.0.4", "1.0.5"] },
  ],
};

export const LICENSES = {
  licenses: [
    { license: "MIT", packages: 66 },
    { license: "unknown", packages: 3 },
    { license: "ISC", packages: 2 },
    { license: "BSD-3-Clause", packages: 1 },
  ],
};

export const TREE = {
  nodes: [
    { name: "express", version: "4.21.2", depth: 0, license: "MIT", unpacked_bytes: 209_000 },
    { name: "accepts", version: "1.3.8", depth: 1, license: "MIT", unpacked_bytes: 5_000 },
    { name: "send", version: "0.19.0", depth: 1, license: "MIT", unpacked_bytes: 30_000 },
    { name: "ms", version: "2.1.3", depth: 2, license: null, unpacked_bytes: null },
  ],
};

export const WHY = { path: ["express@4.21.2", "send@0.19.0", "ms@2.1.3"] };
