export interface BytecodeFacts {
  /** Executable bytes, with the compiler's trailing CBOR metadata removed. */
  size: number;
  hasSelfdestruct: boolean;
  /** EIP-1167 clone: the fixed implementation it forwards to. */
  minimalProxyTarget?: string;
}

const MINIMAL_PROXY = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/;
const PUSH1 = 0x60;
const PUSH32 = 0x7f;
const SELFDESTRUCT = 0xff;

/** Solidity appends CBOR metadata and a 2-byte length. Its bytes are data, not code, and would trip the opcode scan. */
function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) return bytes;
  const metaLen = ((bytes[bytes.length - 2] as number) << 8) | (bytes[bytes.length - 1] as number);
  const start = bytes.length - 2 - metaLen;
  const first = bytes[start];
  // 0xa1 to 0xa5 is a CBOR map header, which is how the metadata begins.
  return start > 0 && first !== undefined && first >= 0xa1 && first <= 0xa5 ? bytes.subarray(0, start) : bytes;
}

/**
 * Reads deployed bytecode for the opcodes that matter to someone about to approve it.
 * It walks instructions so bytes inside PUSH data are not mistaken for opcodes.
 * Not hex, or empty, gives an empty result rather than an error.
 */
export function inspectBytecode(code: string): BytecodeFacts {
  const hex = code.toLowerCase().replace(/^0x/, "");
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return { size: 0, hasSelfdestruct: false };
  const clone = MINIMAL_PROXY.exec(hex);
  const raw = Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
  const bytes = stripMetadata(raw);
  let hasSelfdestruct = false;
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i] as number;
    if (op === SELFDESTRUCT) hasSelfdestruct = true;
    else if (op >= PUSH1 && op <= PUSH32) i += op - PUSH1 + 1;
  }
  return { size: bytes.length, hasSelfdestruct, ...(clone ? { minimalProxyTarget: `0x${clone[1]}` } : {}) };
}
