"use client";

import { useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import { ZKPassportQRCode } from "@zkpassport/ui/react";

// ---------------------------------------------------------------------------
// Constants (Sepolia)
// ---------------------------------------------------------------------------
// HumanRegistrar enforces one `*.zkpassport.gwei` name per passport, forever. It
// verifies the zkPassport proof AND mints the subdomain in a single `claim`
// call — no separate "register humanity" step, and you can't mint via the
// SubdomainRegistrar directly (this contract is its sole gate-passer).
// Deployed by script/DeployHumanRegistrar.s.sol — set the address it prints.
const HUMAN_REGISTRAR: Address = "0xdD68beB3E071dA0bD597DF0783DC7Ecbdeef9957"; // Sepolia

const SEPOLIA_CHAIN_ID_HEX = "0xaa36a7";
const SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

// ---------------------------------------------------------------------------
// ABI
// `claim` takes the same nested ProofVerificationParams struct as the old
// `register`, plus the label to mint, and returns the new subdomain id. The
// custom errors are included so viem decodes reverts (AlreadyClaimed, etc.)
// into readable messages instead of raw selectors.
// ---------------------------------------------------------------------------
const humanRegistrarAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct ProofVerificationParams",
        components: [
          { name: "version", type: "bytes32", internalType: "bytes32" },
          {
            name: "proofVerificationData",
            type: "tuple",
            internalType: "struct ProofVerificationData",
            components: [
              { name: "vkeyHash", type: "bytes32", internalType: "bytes32" },
              { name: "proof", type: "bytes", internalType: "bytes" },
              {
                name: "publicInputs",
                type: "bytes32[]",
                internalType: "bytes32[]",
              },
            ],
          },
          { name: "committedInputs", type: "bytes", internalType: "bytes" },
          {
            name: "serviceConfig",
            type: "tuple",
            internalType: "struct ServiceConfig",
            components: [
              {
                name: "validityPeriodInSeconds",
                type: "uint256",
                internalType: "uint256",
              },
              { name: "domain", type: "string", internalType: "string" },
              { name: "scope", type: "string", internalType: "string" },
              { name: "devMode", type: "bool", internalType: "bool" },
            ],
          },
        ],
      },
      { name: "label", type: "string", internalType: "string" },
    ],
    outputs: [{ name: "subId", type: "uint256", internalType: "uint256" }],
  },
  { type: "error", name: "AlreadyClaimed", inputs: [] },
  { type: "error", name: "NotVerified", inputs: [] },
  { type: "error", name: "WrongScope", inputs: [] },
  { type: "error", name: "WrongSender", inputs: [] },
  { type: "error", name: "WrongChain", inputs: [] },
] as const;

// ---------------------------------------------------------------------------
// Public client for reads / receipt waits
// ---------------------------------------------------------------------------
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA_RPC),
});

type Step = "idle" | "verifying" | "claiming" | "done" | "error";

const STEP_LABEL: Record<Step, string> = {
  idle: "",
  verifying: "Verifying your zkPassport proof…",
  claiming: "Claiming your name on-chain (one transaction)…",
  done: "Done!",
  error: "Error",
};

function etherscanTx(hash: string) {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

export default function Home() {
  const [account, setAccount] = useState<Address | undefined>(undefined);
  const [label, setLabel] = useState("");
  // Mirror of the (trimmed, lowercased) label, read inside onResult so the QR
  // never has to depend on label state. Kept in sync by the input's onChange.
  const labelRef = useRef("");

  const [step, setStep] = useState<Step>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [claimTx, setClaimTx] = useState<string>("");
  const [claimedName, setClaimedName] = useState<string>("");

  // -------------------------------------------------------------------------
  // Wallet connection + Sepolia enforcement
  // -------------------------------------------------------------------------
  async function ensureSepolia() {
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No injected wallet found (window.ethereum is undefined).");
    const currentChainId: string = await eth.request({ method: "eth_chainId" });
    if (currentChainId !== SEPOLIA_CHAIN_ID_HEX) {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SEPOLIA_CHAIN_ID_HEX }],
      });
    }
  }

  async function connectWallet() {
    setErrorMsg("");
    try {
      const eth = (window as any).ethereum;
      if (!eth) {
        throw new Error(
          "No injected wallet found. Install MetaMask (or similar) and reload.",
        );
      }
      const accounts: string[] = await eth.request({
        method: "eth_requestAccounts",
      });
      await ensureSepolia();
      setAccount(accounts[0] as Address);
    } catch (err: any) {
      setErrorMsg(err?.message ?? String(err));
    }
  }

  function getWalletClient() {
    const eth = (window as any).ethereum;
    if (!eth) throw new Error("No injected wallet found (window.ethereum is undefined).");
    return createWalletClient({
      chain: sepolia,
      transport: custom(eth),
    });
  }

  function resetFlowState() {
    setErrorMsg("");
    setClaimTx("");
    setClaimedName("");
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const labelTrimmed = label.trim().toLowerCase();
  // The QR is shown as soon as the wallet is connected (NOT gated on the
  // label) so that exactly one bridge WebSocket opens per connected account.
  // The label is read from labelRef inside onResult instead.
  const canShowQR = Boolean(account);

  return (
    <main
      style={{
        maxWidth: 680,
        margin: "0 auto",
        padding: "40px 20px 80px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
        fontFamily: "Arial, Helvetica, sans-serif",
        color: "#171717",
      }}
    >
      <header>
        <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>
          Claim your <code>.zkpassport.gwei</code> name
        </h1>
        <p style={{ color: "#555", marginTop: 8, lineHeight: 1.5 }}>
          Prove you are a human with the{" "}
          <strong>real zkPassport app</strong> and claim a{" "}
          <code>*.zkpassport.gwei</code> subdomain on Sepolia. It's{" "}
          <strong>one transaction</strong> (it verifies your proof and mints the
          name in one go), and <strong>one name per passport</strong>, so the
          connected wallet just needs a little <strong>Sepolia ETH</strong> for
          gas.
        </p>
      </header>

      {/* Step 1 — wallet */}
      <section style={cardStyle}>
        <h2 style={h2Style}>1. Connect your wallet (Sepolia)</h2>
        {account ? (
          <p style={{ margin: 0 }}>
            Connected: <code>{account}</code>
          </p>
        ) : (
          <button style={btnStyle} onClick={connectWallet}>
            Connect wallet
          </button>
        )}
      </section>

      {/* Step 2 — label */}
      <section style={cardStyle}>
        <h2 style={h2Style}>2. Choose your name</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            value={label}
            onChange={(e) => {
              const next = e.target.value;
              setLabel(next);
              // Keep the ref in sync so onResult reads the current label
              // without the QR having to depend on label state.
              labelRef.current = next.trim().toLowerCase();
            }}
            placeholder="alice"
            disabled={!account}
            style={{
              flex: "0 0 160px",
              padding: "10px 12px",
              fontSize: 16,
              border: "1px solid #ccc",
              borderRadius: 8,
            }}
          />
          <span style={{ fontSize: 16, color: "#555" }}>.zkpassport.gwei</span>
        </div>
        {account && labelTrimmed.length === 0 && (
          <p style={{ margin: "8px 0 0", color: "#888", fontSize: 14 }}>
            Enter a label before scanning the QR code below.
          </p>
        )}
      </section>

      {/* Step 3 — QR + proof flow */}
      <section style={cardStyle}>
        <h2 style={h2Style}>3. Prove humanity & claim</h2>
        {!account && (
          <p style={{ margin: 0, color: "#888" }}>
            Connect your wallet first.
          </p>
        )}
        {canShowQR && account && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ margin: 0, color: "#555" }}>
              {labelTrimmed.length > 0 ? (
                <>
                  Scan this with the zkPassport app to claim{" "}
                  <code>{labelTrimmed}.zkpassport.gwei</code>.
                </>
              ) : (
                <>Enter a label above, then scan this with the zkPassport app.</>
              )}
            </p>
            <ZKPassportQRCode
              // Keyed on `account` ONLY so typing the name never remounts the
              // component (which would open a brand-new bridge WebSocket per
              // keystroke and trip the bridge's per-IP rate limit). The label
              // is read from labelRef inside onResult instead.
              key={account}
              domain="gwei.domains"
              scope="zkpassport.gwei"
              name="gwei name service"
              purpose="Prove you're human to claim a .zkpassport.gwei name"
              mode="compressed-evm"
              devMode={false}
              query={(b) =>
                b
                  // Pure proof-of-humanity: the proof attests to a valid passport bound to the
                  // caller's address on this chain, disclosing nothing about the holder.
                  // One-per-passport comes from uniqueIdentifier.
                  .bind("user_address", account)
                  .bind("chain", "ethereum_sepolia")
                  .done()
              }
              // Lifecycle instrumentation: shows in the browser console exactly how far
              // the flow gets, and surfaces any error the bridge relays when the app fails.
              onBridgeConnect={() => console.log("[zkp] bridge connected")}
              onRequestReceived={() =>
                console.log("[zkp] request received (app opened the request)")
              }
              onGeneratingProof={() => console.log("[zkp] generating proof…")}
              onProofGenerated={(p: any) =>
                console.log("[zkp] proof generated:", p?.name ?? p)
              }
              onReject={() => {
                console.warn("[zkp] rejected by the app/user");
                setStep("error");
                setErrorMsg("The zkPassport request was rejected in the app.");
              }}
              onError={(e: any) => {
                console.error("[zkp] error:", e);
                setStep("error");
                setErrorMsg(
                  "zkPassport error: " + (e?.message ?? JSON.stringify(e)),
                );
              }}
              onResult={async ({ verified, proofs, sdkInstance }) => {
                resetFlowState();
                console.log("zkPassport proofs", proofs);
                console.log("verified", verified);

                if (!verified) {
                  setStep("error");
                  setErrorMsg(
                    "zkPassport reported the proof as NOT verified. Please try again with a real passport/ID.",
                  );
                  return;
                }

                try {
                  setStep("verifying");

                  // Read the label from the ref (kept current by the input's
                  // onChange), NOT from the render closure — the QR does not
                  // depend on label state.
                  const mintLabel = labelRef.current.trim().toLowerCase();
                  if (mintLabel.length === 0) {
                    throw new Error(
                      "Please enter a name (the label for your .zkpassport.gwei subdomain) before claiming, then try again.",
                    );
                  }

                  const evmProof = proofs.find((p) =>
                    p.name?.startsWith("outer_evm"),
                  );
                  if (!evmProof) {
                    throw new Error(
                      "No EVM proof (outer_evm*) found in the proofs array. Make sure mode is 'compressed-evm'.",
                    );
                  }

                  const params = sdkInstance.getSolidityVerifierParameters({
                    proof: evmProof,
                    scope: "zkpassport.gwei",
                    devMode: false,
                  });
                  console.log("Solidity verifier params", params);

                  const walletClient = getWalletClient();

                  // Make sure we're still on Sepolia before sending the tx.
                  await ensureSepolia();

                  // ----- One tx: verify humanity + mint the subdomain -----
                  // HumanRegistrar.claim checks the proof (bound to msg.sender),
                  // enforces one name per passport, and mints label.zkpassport.gwei to
                  // the caller — all in a single transaction.
                  setStep("claiming");
                  const claimHash = await walletClient.writeContract({
                    address: HUMAN_REGISTRAR,
                    abi: humanRegistrarAbi,
                    functionName: "claim",
                    // The zkPassport SDK types proof bytes as plain `string`; viem's
                    // ABI wants `0x${string}`. The runtime shape is correct, so we
                    // assert past the branding mismatch.
                    args: [params as never, mintLabel],
                    account,
                  });
                  setClaimTx(claimHash);
                  const claimReceipt =
                    await publicClient.waitForTransactionReceipt({
                      hash: claimHash,
                    });
                  if (claimReceipt.status !== "success") {
                    throw new Error(
                      `Claim tx reverted (status: ${claimReceipt.status}). Hash: ${claimHash}`,
                    );
                  }

                  setClaimedName(`${mintLabel}.zkpassport.gwei`);
                  setStep("done");
                } catch (err: any) {
                  // Surface the revert / error VERBATIM for debugging.
                  console.error("Claim flow error", err);
                  const detail =
                    err?.shortMessage ||
                    err?.details ||
                    err?.message ||
                    String(err);
                  const full = err?.message ?? String(err);
                  setErrorMsg(
                    detail === full ? full : `${detail}\n\n${full}`,
                  );
                  setStep("error");
                }
              }}
            />
          </div>
        )}
      </section>

      {/* Status */}
      {step !== "idle" && (
        <section style={cardStyle}>
          <h2 style={h2Style}>Status</h2>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {STEP_LABEL[step]}
          </p>

          {claimTx && (
            <p style={{ margin: "8px 0 0" }}>
              Claim tx:{" "}
              <a href={etherscanTx(claimTx)} target="_blank" rel="noreferrer">
                {claimTx}
              </a>
            </p>
          )}

          {step === "done" && claimedName && (
            <p
              style={{
                margin: "12px 0 0",
                fontSize: 20,
                fontWeight: 700,
                color: "#0a7d2c",
              }}
            >
              🎉 You now own <code>{claimedName}</code>
            </p>
          )}

          {step === "error" && errorMsg && (
            <pre
              style={{
                margin: "8px 0 0",
                padding: 12,
                background: "#fdecec",
                border: "1px solid #f5c2c2",
                borderRadius: 8,
                color: "#a40000",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 13,
              }}
            >
              {errorMsg}
            </pre>
          )}
        </section>
      )}

      {/* Connection-level errors (outside the flow) */}
      {step === "idle" && errorMsg && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: "#fdecec",
            border: "1px solid #f5c2c2",
            borderRadius: 8,
            color: "#a40000",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 13,
          }}
        >
          {errorMsg}
        </pre>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Inline styles
// ---------------------------------------------------------------------------
const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e2e2",
  borderRadius: 12,
  padding: 20,
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const h2Style: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  margin: 0,
};

const btnStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  padding: "10px 16px",
  fontSize: 16,
  fontWeight: 600,
  color: "#fff",
  background: "#171717",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};
