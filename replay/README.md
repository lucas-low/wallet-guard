# Replay against real mainnet history

Scripts that measure the policy floor on transactions it did not write tests for. Python 3 and Bun, no extra packages. They need a free archive RPC and the label lists downloaded into `labels/`:
scamsniffer (`scam-database/blacklist/address.json`), MyEtherWallet `addresses-darklist.json`, and the Forta/Etherscan `phishing_scams.csv`.

1. `collect_mal.py` scans every ERC-20 `Approval` and `ApprovalForAll` log whose spender is a labelled address.
2. `prep_mal.py` fetches the transactions behind a random sample and rebuilds each request: a signed approval, or an off-chain permit rebuilt from the log.
3. `collect_benign.py` samples direct approvals from random recent blocks, excluding labelled spenders.
4. `replay.ts <cases.jsonl> <out.json> <rpc>` runs `assess` on each case against chain state from the block before it, with the page-origin rule off because history has no origin.
5. `feats.py` fetches Sourcify status for each spender, for analysis.

Retry cases that report `CHAIN_DATA_UNAVAILABLE`: public RPCs rate-limit and a failed lookup can only warn.
