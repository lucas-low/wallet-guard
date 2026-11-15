#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import known from "../../data/known.json";
import { MockChainClient } from "../adapters/chain.mock";
import { loadSanctionList, OnchainChainClient } from "../adapters/chain.onchain";
import type { PolicyDeps } from "../policy/engine";
import type { ChainClient } from "../ports";
import { addressShape, inspectAddress, requestShape, reviewRequest } from "./tools";

export function buildServer(chain: ChainClient): McpServer {
  const server = new McpServer({ name: "wallet-guard", version: "0.1.0" });
  const deps = { chain, known: known as PolicyDeps["known"] };
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

  server.registerTool(
    "review_signing_request",
    {
      title: "Review a wallet signing request",
      description:
        "Checks a transaction, EIP-712 typed data or EIP-7702 authorization before the user signs it. Returns allow, warn or block with reasons: unlimited approvals, permits, setApprovalForAll, sanctioned counterparties, address poisoning, lookalike domains, unverified or upgradeable spender contracts. Deterministic rules only, no model.",
      inputSchema: requestShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => json(await reviewRequest(input, deps)),
  );

  server.registerTool(
    "inspect_address",
    {
      title: "Inspect an address before integrating with it",
      description:
        "What the chain says about an address: contract or wallet, EIP-7702 delegation, proxy kind and admin (EIP-1967, ZeppelinOS, beacon, EIP-1167), Sourcify source verification, SELFDESTRUCT in the code, OFAC sanctions. status 'unavailable' means the lookup failed, which is not a clean result.",
      inputSchema: addressShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }) => json(await inspectAddress(address, chain)),
  );

  return server;
}

if (import.meta.main) {
  const chain =
    process.env.CHAIN_PROVIDER === "mock"
      ? new MockChainClient()
      : new OnchainChainClient(loadSanctionList(), { url: process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com" });
  await buildServer(chain).connect(new StdioServerTransport());
}
