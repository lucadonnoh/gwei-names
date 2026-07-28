---
'@donnoh/gns-utils': minor
---

Add support for names that host their website in a smart contract over web3:// (ERC-6860), pointed at by the ERC-6821 `contentcontract` text record.

New helpers in `encoding`: `parseWeb3Url`, `formatWeb3Url`, `parseContentContract`, `formatContentContract`, plus the `WEB3_CHAINS` table and the `Web3Pointer` type.

New client methods: `getContentContract(name)` reads the record, `encodeSetContentContract(name, target)` writes it from a `web3://0x…:1/` URL or a pointer, and `encodeClearContentContract(name)` removes it.

Note that a non-empty `contenthash` still takes precedence at the gwei.domains gateway, so a name that already has one must clear it before a contract-hosted site is served.
