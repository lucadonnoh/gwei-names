# Audited by [V12](https://zellic.ai/)

The only autonomous Solidity auditor that finds critical bugs. Not all audits are equal, so stop paying for bad ones. Just use V12. No calls, demos, or intros.


---

# Temporary transfer poisons escrow mapping
**#2**
- Severity: Medium
- Validity: Invalid

## Targets
- registerFor (SubdomainRegistrar)

## Affected Locations
- **SubdomainRegistrar.registerFor**: Single finding location

## Description

`registerFor` treats a parent as non‑escrowed when `escrowedController[parentId]` is zero and temporarily transfers the parent into the registrar and back in the same call. The contract also implements `onERC721Received`, which unconditionally writes `escrowedController[tokenId] = from` for any inbound ERC721 transfer. If the Name NFT invokes the receiver hook on `transferFrom` (or uses safe‑transfer semantics internally), the temporary transfer in `registerFor` will trigger `onERC721Received` and persistently set `escrowedController` even though the token is returned to the controller. This leaves the mapping indicating escrow while the registrar no longer owns the token, causing future `registerFor` calls to revert with `NotEscrowed`. The only recovery path is `clearStaleEscrow`, which disables the configuration and forces the controller to reconfigure, making repeated registrations an effective DoS vector.

## Root cause

`onERC721Received` treats every inbound transfer as a deposit and writes `escrowedController` without distinguishing between real deposits and the temporary transfers performed inside `registerFor`.

## Impact

Any user can trigger a stale escrow record by registering once when the parent is not escrowed if the Name NFT fires the receiver hook on transfers. Subsequent registrations for that parent will fail until the controller clears the stale mapping and re‑enables the configuration, allowing repeated calls to block or disrupt subdomain registrations.

## Comments

- "Invalid. Flash mode calls transferFrom, not safeTransferFrom. Solady's transferFrom never invokes onERC721Received. The receiver hook
  cannot fire on this code path." *(Feb 24, 2026, 11:57 AM)*

### Response

**Confirmed invalid.** The premise of this finding is incorrect — flash mode uses `transferFrom` (`SubdomainRegistrar.sol:289,291`), not `safeTransferFrom`. Solady's `ERC721.transferFrom` (line 252 in `solady/tokens/ERC721.sol`) performs a direct storage update with no receiver callback. `onERC721Received` is only invoked by `safeTransferFrom` / `_safeMint`, neither of which is used in the flash transfer path. The described attack vector cannot occur.

---

# Owner set via tx.origin
**#1**
- Severity: Low
- Validity: Invalid

## Targets
- constructor (NameNFT)

## Affected Locations
- **NameNFT.constructor**: Single finding location

## Description

The constructor initializes ownership using `tx.origin`, which binds the owner to the externally owned account that originated the deployment transaction rather than the actual deployer contract. If this contract is deployed through a factory, proxy, or relayer, the owner becomes whichever EOA triggered that intermediary instead of the intended controlling contract or governance address. This misassignment is silent and permanent because it happens at deployment and there is no subsequent validation. Since the owner can configure pricing/premiums and withdraw collected fees, the wrong owner directly translates into unauthorized control of critical protocol functions.

## Root cause

Ownership is derived from `tx.origin` instead of `msg.sender` or an explicit owner parameter, causing ownership to follow the top-level EOA even when deployment is mediated by another contract.

## Impact

An attacker who can trigger deployment via an intermediary becomes the owner and can change registration fees or premium parameters to their advantage. They can also withdraw the protocol’s collected fees, diverting revenue and potentially disrupting the registration service. The intended governance or factory loses control over the contract.

## Comments

- The use of tx.origin is intention to the deployment plan of using a create3 factor and assigning ownership of the contract to the EOA calling the factory. Therefore in the context of this code this finding does not discover a bug or contract vulnerability since this is per the intent and the actual deployment worked as expected. *(Feb 24, 2026, 11:46 AM)*

### Response

**Confirmed invalid.** `tx.origin` is intentional — the contract is deployed via a CREATE2/CREATE3 factory (deterministic address), where `msg.sender` would be the factory contract rather than the deploying EOA. Using `tx.origin` ensures ownership goes to the human deployer, not the intermediary factory. This is documented in the README and the deployment executed as intended. The "attacker who can trigger deployment via an intermediary" scenario described does not apply — only the deployer's own EOA initiates the factory call.