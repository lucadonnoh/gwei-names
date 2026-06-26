# Apex Report - WNS / Scan #1 (Excerpted)

> **Note:** This is an excerpted version containing only findings related to Wei Name Service
> (NameNFT, and the wei.domains dapp). SubdomainRegistrar was not included. The original report contained 15
> findings total — 12 findings related to ZAMM/zRouter (WNS-1 through WNS-9, WNS-11, WNS-12)
> are omitted as they pertain to a separate contract system outside the scope of this repository.
> The full unexcerpted report is available upon request.

## Table of contents

- [Medium](#medium)
  - [WNS-14 — Dapp XSS: unescaped on-chain name injected into innerHTML/href](#finding-wns-14)
  - [WNS-13 — Commit owner set to router breaks commit-reveal and enables mempool name theft](#finding-wns-13)
  - [WNS-10 — NameNFT reveal/renew refunds pay msg.sender; with official zRouter-based registration this misdirects user refunds to zRouter](#finding-wns-10)

---

## Medium

<a id="finding-wns-14"></a>
### WNS-14 — Dapp XSS: unescaped on-chain name injected into innerHTML/href

#### Executive Summary
The `weiNS.html` dapp renders the on-chain name string (`name` / `currentTokenName`) into HTML using `innerHTML` and template literals without applying `escapeHtml`. Because the on-chain contract's label validation only rejects spaces/control characters/dots, an attacker can register a `.wei` label containing HTML-special characters such as `"`, `'`, `<`, or `>`.

When a victim user views that name in the dapp (e.g., by searching it or via a shared `#hash` link), the dapp interpolates the malicious name into HTML attributes and markup, enabling script execution in the dapp origin. This can be escalated into wallet phishing/drain by rewriting UI elements, spoofing transaction prompts, or swapping destination addresses.

#### Details
Code locations (unescaped interpolation into HTML):

```javascript
// showManage(tokenId, name)
const gatewayUrl = `https://${name}.${WEI_GATEWAY}`;
infoHtml += `<div><span>Website:</span><a href="${gatewayUrl}" target="_blank" rel="noopener" style="color:inherit;">${gatewayUrl}</a></div>`;
$('manageInfo').innerHTML = infoHtml;
```

```javascript
// showManageForm(...)
html = `
  <div style="font-size:11px;opacity:0.5;margin-bottom:8px;">Transfers to ${currentTokenName}.wei will go to this address</div>
  ...
  ${WEI_GATEWAY ? `<a href="https://${currentTokenName}.${WEI_GATEWAY}" ...>${currentTokenName}.${WEI_GATEWAY}</a>` : ''}
`;
form.innerHTML = html;
```

The dapp can accept labels that ENSIP-15 normalization rejects because it falls back to contract-compatible validation:

```javascript
function normalizeLabel(label) {
  try {
    const normalized = ens_normalize(s);
    ...
    return normalized;
  } catch (e) {
    return normalizeLabelContract(s);
  }
}

function normalizeLabelContract(s) {
  // Reject control chars, space, dot, DEL (matches contract)
  if (/[\u0000-\u0020\u007f.]/.test(s)) return null;
  ...
  return lowered;
}
```

Exploit sketch:
1. Attacker registers a label containing a payload such as `"><img src=x onerror=...>`.
2. Victim visits the dapp page for that name.
3. The dapp calls `showManage(tokenId, name)` and/or `showManageForm(...)`, assigning `innerHTML` that contains the unescaped name.
4. Payload executes in the dapp origin, enabling transaction phishing.

#### Impact Cascade
- Account compromise: attacker-controlled JS can manipulate transaction recipients/amounts shown to the user.
- Wallet phishing: attacker can present fake UI states or prompt malicious approvals.
- Trust/identity corruption: reverse-name display becomes a delivery mechanism for active attacks.

#### Recommendation
- Escape all on-chain strings before inserting into `innerHTML`, including attribute values.
- Prefer DOM APIs (`textContent`, `setAttribute`) instead of HTML templating for untrusted content.
- Add a strict Content Security Policy (CSP) to reduce XSS blast radius.

> **Response:** Valid finding — patched.
>
> The dapp already has an `escapeHtml()` utility and uses it for text records and CIDs — it was simply missing on the name interpolation points. The auditor is correct that `ens_normalize` (ENSIP-15) does not fully protect because the `catch` block falls back to `normalizeLabelContract()` which allows `<>"'` through.
>
> Applied `escapeHtml()` to all 5 unescaped name interpolation points in `showManage()` and `showManageForm()`:
> - `showManage`: gateway URL (name in href and text)
> - `showManageForm('setAddr')`: `currentTokenName` in description
> - `showManageForm('setContent')`: `currentTokenName` in description and gateway link
> - `showManageForm('subdomain')`: `currentTokenName` in subdomain preview
>
> **NameNFT contract is not affected** — this is a dapp-only issue. The on-chain `tokenURI` SVG generation already uses `_escapeXML()` (`NameNFT.sol:954`) to sanitize name strings, so NFT metadata rendering is safe.

---

<a id="finding-wns-13"></a>
### WNS-13 — Commit owner set to router breaks commit-reveal and enables mempool name theft

#### Executive Summary
The official `weiNS.html` dapp generates commitments with `owner = ZROUTER` (a router contract), not the user's wallet address. This changes the commit-reveal "owner binding" from the registrant to a shared third-party contract. Since `NameNFT.reveal()` recomputes the commitment using `msg.sender` and mints to `msg.sender`, the router becomes the only address that can successfully reveal those commitments. As a result, the reveal step becomes MEV-front-runnable: a searcher can copy the victim's reveal calldata (label + secret) from the mempool and submit their own router reveal first (sending the same ETH fee), setting the recipient to themselves. The first reveal deletes the commitment and transfers the NFT, and the victim's transaction then fails, permanently losing the intended name.

#### Details

##### 1) `NameNFT.reveal` binds commitments to `msg.sender` and mints to `msg.sender`
In `NameNFT.reveal()`, the contract derives the commitment hash with `msg.sender` and then mints to `msg.sender`:

```solidity
bytes32 commitment = keccak256(abi.encode(normalized, msg.sender, secret));
uint256 committedAt = commitments[commitment];
...
delete commitments[commitment];
_register(string(normalized), 0, msg.sender);
```

This design means that whoever is encoded as `owner` inside the commitment must also be the eventual `msg.sender` of `reveal()`.

##### 2) The dapp commits with `owner = ZROUTER`, not the user
In `weiNS.html`, the commitment is computed as:

```javascript
const commitment = await rc.makeCommitment(name, ZROUTER, secret);
const tx = await wcTransaction(contract.commit(commitment), 'Approve commitment');
```

Then, reveal is performed through the router, passing an explicit `to` recipient:

```javascript
tx = await wcTransaction(router.multicall([
  rIface.encodeFunctionData('revealName', [pending.name, pending.secret, connectedAddress])
], { value: total }), 'Approve registration');
```

Because the commitment was made for `owner = ZROUTER`, the router is now the address that must call `NameNFT.reveal()` successfully.

##### 3) Exploit: front-run the reveal via the router and set yourself as recipient
Attack steps:
1. Victim commits using `makeCommitment(label, ZROUTER, secret)` and waits >= 60 seconds.
2. Victim submits the router reveal transaction (router multicall to `revealName(label, secret, connectedAddress)`) with `value = fee + premium`.
3. Searcher copies `label` and `secret` from the pending transaction and submits their own router call first:
   - `revealName(label, secret, attackerAddress)`
   - `value = fee + premium`
4. The attacker's reveal executes first, consuming the stored commitment (`delete commitments[commitment]`) and transferring the minted NFT to the attacker.
5. The victim's reveal then reverts with `CommitmentNotFound()` because the commitment has been deleted.

Root cause: the commitment is not bound to the intended registrant (the user); it is bound to a shared router address.

#### Impact Cascade
- Name theft: an unprivileged searcher can capture any name being revealed through the router flow.
- Censorship/denial: victims reliably lose the name if they reveal via public mempool.
- Ecosystem harm: users may believe commit-reveal prevents front-running, but this integration negates that guarantee.

#### Recommendation
Primary fix (contract-level): add a relayer-safe reveal API that binds the commitment to a specified owner but does not require `msg.sender` to be that owner.

Dapp-side mitigation: do not create commitments with `owner = ZROUTER`. Commitments should be bound to the end owner, and the reveal call should be performed either by that owner or by a relayer-safe `revealTo` function.

> **Response:** Valid finding — patched.
>
> **NameNFT itself is not vulnerable** — direct calls to `NameNFT.reveal()` bind the commitment to the caller's own address, which is correct. The issue only exists in the router path where the commitment is bound to the shared router address to enable atomic swap-to-reveal from USDC/DAI. NameNFT does not need redeployment. The fix is applied entirely in zRouter and the dapp.
>
> **zRouter patch:** `revealName` now derives the actual secret from `keccak256(abi.encode(innerSecret, to))`, binding the commitment to the intended recipient. An attacker who changes `to` produces a different derived secret, which doesn't match any commitment.
>
> ```diff
> -    function revealName(string calldata label, bytes32 secret, address to)
> +    function revealName(string calldata label, bytes32 innerSecret, address to)
>          public payable returns (uint256 tokenId)
>      {
> +        bytes32 secret = keccak256(abi.encode(innerSecret, to));
>          uint256 val = address(this).balance;
>          ...
>      }
> ```
>
> **Dapp patch:** commit phase now generates an `innerSecret`, derives the real secret with the user's address baked in, and saves `innerSecret` for the reveal call.
>
> ```diff
> -    const secret = ethers.hexlify(ethers.randomBytes(32));
> +    const innerSecret = ethers.hexlify(ethers.randomBytes(32));
>      const userAddr = await signer.getAddress();
> +    const secret = ethers.keccak256(
> +        ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [innerSecret, userAddr])
> +    );
>      const commitment = await rc.makeCommitment(name, ZROUTER, secret);
> ```

---

<a id="finding-wns-10"></a>
### WNS-10 — NameNFT reveal/renew refunds pay msg.sender; with official zRouter-based registration this misdirects user refunds to zRouter

#### Executive Summary
`NameNFT.reveal()` refunds any overpayment to `msg.sender` (the caller). The official dapp's registration flow intentionally binds commitments to a fixed router address (`ZROUTER`) and then executes the reveal via the router (so that `msg.sender` inside `reveal()` is the router). As a result, any overpayment/refund during router-based registrations is paid to the router contract, not to the end user who funded the registration.

#### Details
##### Refund recipient is msg.sender
`reveal()` refunds the delta to `msg.sender`:

```solidity
if (msg.value > total) {
    SafeTransferLib.safeTransferETH(msg.sender, msg.value - total);
}
```

The same pattern exists in `renew()`.

##### Official dapp routes reveals through zRouter
The dapp computes commitments with `owner = ZROUTER` and performs the reveal via `ZROUTER.multicall(...)`, so the router becomes `msg.sender` for the `NameNFT.reveal()` call.

##### Concrete exploitability
1. A user registers a name during a non-zero premium window (or otherwise sends more than required).
2. Any refund is paid to `ZROUTER` (not the user) because `msg.sender` is the router in the reveal.
3. Any unprivileged attacker can subsequently steal that ETH if the router has any publicly-callable balance-drain primitive.

#### Recommendation
- Contract-level: add a `revealFor(label, secret, to)` variant where the commitment binds `to` and refunds are paid to `to` (not `msg.sender`).
- Router/dapp-level: always include a final step that immediately returns router-held ETH refunds to the end user.

> **Response:** Valid finding, low practical severity — patched.
>
> The dapp computes `total = fee + premium` and sends exactly that amount, so refunds only occur if the premium decreases between the dapp reading it and the transaction landing on-chain — a narrow edge case. `renew()` is not affected — the dapp calls it directly (not through the router), so `msg.sender` is the user.
>
> The USDC and DAI reveal paths already include a `sweep(ETH, 0, 0, user)` call after `revealName` in the multicall, which returns any excess ETH to the user. The ETH reveal path was simply missing this sweep.
>
> ```diff
>      tx = await wcTransaction(router.multicall([
> -      rIface.encodeFunctionData('revealName', [pending.name, pending.secret, connectedAddress])
> +      rIface.encodeFunctionData('revealName', [pending.name, pending.secret, connectedAddress]),
> +      rIface.encodeFunctionData('sweep', [ethers.ZeroAddress, 0, 0, connectedAddress])
>      ], { value: total }), 'Approve registration');
> ```
>
> **NameNFT contract is not affected** — `reveal()` refunding `msg.sender` is standard and correct behavior. The issue was a missing sweep step in one dapp code path. No contract changes needed.

---

## Omitted Findings

The following 12 findings from the original report are omitted from this excerpt as they pertain to ZAMM/zRouter, a separate contract system not part of the Wei Name Service core:

| ID | Severity | Title |
|---|---|---|
| WNS-1 | High | ZAMM orderbook: taker can bypass paying maker by consuming transient balance in _payOut |
| WNS-8 | High | swapVZ exactOut refunds ERC6909 inputs incorrectly, trapping user idIn balances in router |
| WNS-7 | High | Permissionless zRouter.execute() allows any attacker to spend router-held funds |
| WNS-4 | High | zRouter.addLiquidity sources ERC20 from router balance while minting LP to attacker |
| WNS-12 | Low | Unrestricted zRouter.sweep() lets any attacker steal all ETH/ERC20/ERC6909 held by router |
| WNS-9 | Low | zRouter.swapCurve exactOut refunds all router ETH+WETH to caller |
| WNS-11 | Low | zRouter snwap/snwapMulti drain router-held ERC20 when amountIn==0 |
| WNS-2 | Low | zRouter.swapV2 exactIn ETH swaps can steal router-held ETH with msg.value=0 |
| WNS-5 | Low | swapCurve: attacker-controlled pool drains router tokens via lazy approve |
| WNS-3 | Low | zRouter.swapV3 exactOut (ETH-in) can be executed with msg.value=0 via callback wrapETH |
| WNS-6 | Low | zRouter.swapCurve exactOut refunds router-held ERC20 input balance to caller |
