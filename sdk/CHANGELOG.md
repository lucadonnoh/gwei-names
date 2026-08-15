# gns-utils

## 0.3.0

### Minor Changes

- 0fa0f6a: Add support for names that host their website in a smart contract over web3:// (ERC-6860), pointed at by the ERC-6821 `contentcontract` text record.

  New helpers in `encoding`: `parseWeb3Url`, `formatWeb3Url`, `parseContentContract`, `formatContentContract`, plus the `WEB3_CHAINS` table and the `Web3Pointer` type.

  New client methods: `getContentContract(name)` reads the record, `encodeSetContentContract(name, target)` writes it from a `web3://0x…:1/` URL or a pointer, and `encodeClearContentContract(name)` removes it.

  Note that a non-empty `contenthash` still takes precedence at the gwei.domains gateway, so a name that already has one must clear it before a contract-hosted site is served.

### Patch Changes

- 5991252: Correct the exported NameNFT ABI to match the deployed ownerless contract and correct
  `MAX_SUBDOMAIN_DEPTH` from 5 to 10. Deprecate the unrelated legacy `BASE_PORTAL` export while
  retaining it for compatibility.
