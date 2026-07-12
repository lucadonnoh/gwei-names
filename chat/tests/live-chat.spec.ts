import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Wallet } from "ethers";
import {
  GNS_CONTRACT_ADDRESS,
  contactBindingMessage,
  encodeGnsChatRecord,
  gweiTokenId,
} from "../src/gns-chat";

const TEST_HOLDER_WALLET = new Wallet(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const TEST_HOLDER = TEST_HOLDER_WALLET.address;
const MOCK_EXECUTION_RPC = "http://127.0.0.1:8546";
const MOCK_EXECUTION_RPC_QUERY = encodeURIComponent(MOCK_EXECUTION_RPC);

async function installTestWallet(page: Page): Promise<void> {
  await page.addInitScript(({ address }) => {
    const ethereum = {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [address];
        if (method === "eth_chainId") return "0xaa36a7";
        if (method === "personal_sign") {
          const data = params?.[0];
          if (typeof data !== "string") throw new Error("missing signing input");
          const response = await fetch("http://127.0.0.1:8546/sign", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ data }),
          });
          const result = await response.json() as { signature?: unknown };
          if (typeof result.signature !== "string") throw new Error("mock signing failed");
          return result.signature;
        }
        throw new Error(`Unsupported test wallet method ${method}`);
      },
    };
    Object.defineProperty(window, "ethereum", { value: ethereum, configurable: true });
  }, { address: TEST_HOLDER });
}

async function contactCode(page: Page): Promise<string> {
  await page.locator("#identity-button").click();
  const dialog = page.locator("#identity-dialog");
  await dialog.locator("#identity-advanced > summary").click();
  const code = await dialog.getByLabel("Your contact code").inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  return code;
}

async function addContact(page: Page, code: string, label: string): Promise<void> {
  await page.locator("#add-button").click();
  const dialog = page.locator("#add-dialog");
  await dialog.locator("#manual-contact > summary").click();
  await dialog.locator("#new-contact-code").fill(code);
  await dialog.getByLabel(/Local name/u).fill(label);
  await dialog.getByRole("button", { name: "Verify and add" }).click();
  await expect(dialog).toBeHidden();
}

async function configureMockGnsContact(
  name: string,
  code: string,
  discover = false,
): Promise<void> {
  const binding = {
    chainId: 11_155_111n,
    contractAddress: GNS_CONTRACT_ADDRESS,
    tokenId: gweiTokenId(name),
    contactCode: code,
  };
  const value = encodeGnsChatRecord(
    code,
    await TEST_HOLDER_WALLET.signMessage(contactBindingMessage(binding)),
  );
  const response = await fetch("http://127.0.0.1:8546/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, value, discover }),
  });
  expect(response.ok).toBe(true);
}

async function rememberTestPublication(page: Page, profile: string, name: string): Promise<void> {
  await page.evaluate(async ({ databaseName, publishedName }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("private-state", "readwrite");
    const store = transaction.objectStore("private-state");
    const state = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get("state");
      request.addEventListener(
        "success",
        () => resolve(request.result as Record<string, unknown>),
        { once: true },
      );
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    store.put({ ...state, publishedGweiName: publishedName }, "state");
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
    database.close();
  }, {
    databaseName: `gwei-chat-prototype-v0:${profile.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 32)}`,
    publishedName: name,
  });
}

async function publishTestIdentity(
  page: Page,
  profile: string,
  name: string,
  waitForApp: (page: Page) => Promise<void> = waitUntilLive,
  discover = false,
): Promise<string> {
  const code = await contactCode(page);
  await configureMockGnsContact(name, code, discover);
  await rememberTestPublication(page, profile, name);
  await page.reload();
  await waitForApp(page);
  return code;
}

async function resetMockGnsContacts(): Promise<void> {
  const response = await fetch(`${MOCK_EXECUTION_RPC}/records/reset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.ok).toBe(true);
}

async function acceptChatRequest(page: Page, senderName: string): Promise<void> {
  const requestButton = page.locator("#request-button");
  await expect(requestButton).toContainText("Chat request", { timeout: 10_000 });
  await requestButton.click();
  const dialog = page.locator("#request-dialog");
  const card = dialog.locator(".request-card").filter({ hasText: senderName });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(dialog).toBeHidden();
}

async function activateRelayPasses(page: Page, name: string): Promise<void> {
  const identity = page.locator("#identity-dialog");
  if (!await identity.isVisible()) await page.locator("#identity-button").click();
  await identity.getByLabel("Name you own").fill(name);
  const advanced = identity.locator("#identity-advanced");
  if (!await advanced.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await advanced.locator("summary").click();
  }
  await identity.getByRole("button", { name: "Get relay passes" }).click();
  await expect(identity.locator("#publish-status")).toContainText(
    "unlinkable relay passes ready",
    { timeout: 15_000 },
  );
  await identity.getByRole("button", { name: "Close" }).click();
}

async function waitUntilLive(page: Page): Promise<void> {
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#connection-label")).toHaveText("live relay");
}

async function waitUntilBlobPolling(page: Page): Promise<void> {
  await expect(page.locator("#app")).toBeVisible();
  await expect(page.locator("#connection-label")).toHaveText("blob polling");
}

async function installVirtualPasskey(page: Page): Promise<() => Promise<void>> {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      hasHmacSecret: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
    },
  });
  return async () => {
    await session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await session.send("WebAuthn.disable");
    await session.detach();
  };
}

test("two browser identities chat, reload ratchets, and retain no readable history", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const aliceProfile = `alice-${suffix}`;
  const bobProfile = `bob-${suffix}`;
  const aliceName = `alice-${suffix.slice(-10)}.gwei`;
  const bobName = `bob-${suffix.slice(-10)}.gwei`;
  const alice = await context.newPage();
  const bob = await context.newPage();

  await Promise.all([
    alice.goto(
      `/?profile=${aliceProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&onchain=0&vault=off`,
    ),
    bob.goto(
      `/?profile=${bobProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&onchain=0&vault=off`,
    ),
  ]);
  await Promise.all([waitUntilLive(alice), waitUntilLive(bob)]);
  await expect(alice.getByRole("heading", { name: "Publish your identity" })).toBeVisible();
  await expect(alice.locator("#contact-code")).toBeHidden();

  const [aliceCode, bobCode] = await Promise.all([
    publishTestIdentity(alice, aliceProfile, aliceName),
    publishTestIdentity(bob, bobProfile, bobName),
  ]);
  const aliceBundle = JSON.parse(Buffer.from(aliceCode, "base64url").toString("utf8")) as {
    v?: unknown;
    f?: unknown;
  };
  expect(aliceBundle.v).toBe(1);
  expect(aliceBundle).not.toHaveProperty("f");
  await addContact(alice, bobCode, "Bob");
  await acceptChatRequest(bob, aliceName);

  await expect(alice.locator("#chat-status")).toHaveText("Private session ready");
  await expect(alice.locator("#message-input")).toBeEnabled();

  const largestPrototypeMessage = "x".repeat(600);
  await alice.locator("#message-input").fill(largestPrototypeMessage);
  await alice.getByRole("button", { name: "Send message" }).click();
  await expect(bob.locator(".message.incoming .bubble")).toHaveText(largestPrototypeMessage);
  await bob.waitForTimeout(800);
  await expect(bob.locator(".message.incoming .bubble")).toHaveCount(1);

  await bob.locator("#message-input").fill("hello from bob");
  await bob.getByRole("button", { name: "Send message" }).click();
  await expect(alice.locator(".message.incoming .bubble")).toHaveText("hello from bob");

  await Promise.all([alice.reload(), bob.reload()]);
  await Promise.all([waitUntilLive(alice), waitUntilLive(bob)]);
  await alice.getByRole("button", { name: /Bob/u }).click();
  await bob.getByRole("button", { name: new RegExp(aliceName, "u") }).click();
  await expect(alice.locator(".message")).toHaveCount(0);
  await expect(bob.locator(".message")).toHaveCount(0);

  await alice.locator("#message-input").fill("ratchet survived reload");
  await alice.getByRole("button", { name: "Send message" }).click();
  await expect(bob.locator(".message.incoming .bubble")).toHaveText("ratchet survived reload");

  await context.close();
});

test("ignoring a verified request sends no reply and creates no one-time key offer", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const aliceProfile = `ignore-alice-${suffix}`;
  const bobProfile = `ignore-bob-${suffix}`;
  const aliceName = `ignore-alice-${suffix.slice(-8)}.gwei`;
  const bobName = `ignore-bob-${suffix.slice(-8)}.gwei`;
  const alice = await context.newPage();
  const bob = await context.newPage();

  await Promise.all([
    alice.goto(
      `/?profile=${aliceProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&onchain=0&vault=off`,
    ),
    bob.goto(
      `/?profile=${bobProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&onchain=0&vault=off`,
    ),
  ]);
  await Promise.all([waitUntilLive(alice), waitUntilLive(bob)]);
  const [, bobCode] = await Promise.all([
    publishTestIdentity(alice, aliceProfile, aliceName),
    publishTestIdentity(bob, bobProfile, bobName),
  ]);
  await addContact(alice, bobCode, "Bob");

  const requestButton = bob.locator("#request-button");
  await expect(requestButton).toContainText("Chat request", { timeout: 10_000 });
  await requestButton.click();
  const requestDialog = bob.locator("#request-dialog");
  const request = requestDialog.locator(".request-card").filter({ hasText: aliceName });
  await request.getByRole("button", { name: "Ignore" }).click();

  await expect(requestDialog).toBeHidden();
  await expect(requestButton).toBeHidden();
  await expect(alice.locator("#chat-status")).toHaveText("Waiting for them to accept");
  await expect(alice.locator("#message-input")).toBeDisabled();
  const bobHandshakeState = await bob.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(databaseName);
      open.addEventListener("success", () => resolve(open.result), { once: true });
      open.addEventListener("error", () => reject(open.error), { once: true });
    });
    const transaction = database.transaction("private-state", "readonly");
    const read = transaction.objectStore("private-state").get("state");
    const state = await new Promise<Record<string, unknown>>((resolve, reject) => {
      read.addEventListener("success", () => resolve(read.result as Record<string, unknown>), {
        once: true,
      });
      read.addEventListener("error", () => reject(read.error), { once: true });
    });
    database.close();
    return {
      incoming: Object.keys(state.incomingSessionRequests as Record<string, unknown>),
      offers: Object.keys(state.sessionOffers as Record<string, unknown>),
      outbox: state.outbox as unknown[],
    };
  }, `gwei-chat-prototype-v0:${bobProfile.slice(0, 32)}`);
  expect(bobHandshakeState).toEqual({ incoming: [], offers: [], outbox: [] });

  await context.close();
});

test("a browser with live reception disabled discovers and decrypts a padded blob", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const aliceProfile = `blob-alice-${suffix}`;
  const bobProfile = `blob-bob-${suffix}`;
  const aliceName = `blob-alice-${suffix.slice(-8)}.gwei`;
  const bobName = `blob-bob-${suffix.slice(-8)}.gwei`;
  const alice = await context.newPage();
  const bob = await context.newPage();

  await Promise.all([
    alice.goto(
      `/?profile=${aliceProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&onchain=0&vault=off`,
    ),
    bob.goto(
      `/?profile=${bobProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&live=0&onchain=0&vault=off`,
    ),
  ]);
  await Promise.all([waitUntilLive(alice), waitUntilBlobPolling(bob)]);

  const [, bobCode] = await Promise.all([
    publishTestIdentity(alice, aliceProfile, aliceName),
    publishTestIdentity(bob, bobProfile, bobName, waitUntilBlobPolling),
  ]);
  await addContact(alice, bobCode, "Blob Bob");
  await acceptChatRequest(bob, aliceName);

  await alice.locator("#message-input").fill("delivered through a padded blob");
  await alice.getByRole("button", { name: "Send message" }).click();
  await expect(bob.locator(".message.incoming .bubble")).toHaveText(
    "delivered through a padded blob",
    { timeout: 10_000 },
  );

  await context.close();
});

test("transport settings persist a custom RPC and batcher without exposing keys", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await page.goto(`/?profile=settings-${suffix}&onchain=0&vault=off`);
  await expect(page.locator("#app")).toBeVisible();

  await page.locator("#settings-button").click();
  const dialog = page.locator("#settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Batcher URL").fill("http://127.0.0.1:8791");
  await dialog.getByLabel("Sepolia execution RPC").fill("https://rpc.example/v1/test");
  await dialog.getByLabel("Sepolia Beacon API").fill("https://beacon.example");
  await dialog.getByLabel("Read finalized onchain batches").uncheck();
  await dialog.getByRole("button", { name: "Save & reconnect" }).click();

  await expect(page.locator("#app")).toBeVisible();
  await page.locator("#settings-button").click();
  await expect(dialog.getByLabel("Batcher URL")).toHaveValue("http://127.0.0.1:8791");
  await expect(dialog.getByLabel("Sepolia execution RPC")).toHaveValue(
    "https://rpc.example/v1/test",
  );
  await expect(dialog.getByLabel("Sepolia Beacon API")).toHaveValue(
    "https://beacon.example",
  );
  await expect(dialog.getByLabel("Read finalized onchain batches")).not.toBeChecked();

  await context.close();
});

test("guided setup leads with publication and then presents contact discovery", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const profile = `guide-${suffix}`.slice(0, 32);
  await page.goto(`/?profile=${profile}&onchain=0&vault=off`);
  await waitUntilLive(page);

  await expect(page.locator("#guide-identity-state")).toHaveAttribute("data-state", "current");
  await expect(page.getByRole("heading", { name: "Publish your identity" })).toBeVisible();
  await expect(page.locator("#contact-code")).toBeHidden();
  await page.locator("#empty-identity-button").click();
  await page.locator("#publish-name").fill("alice.gwei");
  await expect(page.locator("#publish-name")).toHaveValue("alice");
  await expect(page.locator("#publish-form .name-input")).toContainText(".gwei");
  await page.locator("#identity-dialog").getByRole("button", { name: "Close" }).click();

  await page.evaluate(async ({ databaseName, publishedName }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("private-state", "readwrite");
    const store = transaction.objectStore("private-state");
    const state = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get("state");
      request.addEventListener(
        "success",
        () => resolve(request.result as Record<string, unknown>),
        { once: true },
      );
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    store.put({ ...state, publishedGweiName: publishedName }, "state");
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
    });
    database.close();
  }, {
    databaseName: `gwei-chat-prototype-v0:${profile}`,
    publishedName: "alice.gwei",
  });

  await page.reload();
  await waitUntilLive(page);
  await expect(page.locator("#guide-identity-state")).toHaveAttribute("data-state", "complete");
  await expect(page.locator("#guide-people-state")).toHaveAttribute("data-state", "current");
  await expect(page.getByRole("heading", { name: "Who do you want to message?" })).toBeVisible();
  await expect(page.locator("#onboarding-contact-name")).toBeVisible();
  await expect(page.locator("#onboarding-name-form .name-input")).toContainText(".gwei");
  await expect(page.locator("#identity-button")).toHaveText("Identity ✓");

  await page.locator("#identity-button").click();
  await expect(page.locator("#identity-published-name")).toHaveText("alice.gwei");
  await expect(page.locator("#contact-code")).toBeHidden();

  await context.close();
});

test("the browser resolves alice.gwei and verifies both owner and chat signatures", async ({
  browser,
}) => {
  await resetMockGnsContacts();
  const context = await browser.newContext();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const aliceProfile = `gns-alice-${suffix}`;
  const bobProfile = `gns-bob-${suffix}`;
  const senderName = `requester-${suffix.slice(-8)}.gwei`;
  const alice = await context.newPage();
  const bob = await context.newPage();
  await Promise.all([
    alice.goto(
      `/?profile=${aliceProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&gnsFromBlock=0&onchain=0&vault=off`,
    ),
    bob.goto(
      `/?profile=${bobProfile}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&gnsFromBlock=0&onchain=0&vault=off`,
    ),
  ]);
  await Promise.all([waitUntilLive(alice), waitUntilLive(bob)]);
  await Promise.all([
    publishTestIdentity(alice, aliceProfile, senderName),
    publishTestIdentity(bob, bobProfile, "alice.gwei", waitUntilLive, true),
  ]);

  await alice.locator("#add-button").click();
  const dialog = alice.locator("#add-dialog");
  await expect(dialog.getByRole("button", { name: "Message alice.gwei" })).toBeVisible();
  await expect(dialog.locator("#directory-status")).toContainText("1 verified name");
  await dialog.getByRole("button", { name: "Message alice.gwei" }).click();
  await expect(dialog).toBeHidden();
  await expect(alice.getByRole("button", { name: /alice\.gwei/u })).toBeVisible();
  await acceptChatRequest(bob, senderName);
  await expect(alice.locator("#chat-status")).toHaveText("Private session ready");

  await alice.locator("#message-input").fill("found you through your gwei name");
  await alice.getByRole("button", { name: "Send message" }).click();
  await expect(bob.locator(".message.incoming .bubble")).toHaveText(
    "found you through your gwei name",
    { timeout: 10_000 },
  );
  await context.close();
});

test("a gwei holder gets blind passes and submits through the protected public relay", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const aliceProfile = `pass-alice-${suffix}`;
  const bobProfile = `pass-bob-${suffix}`;
  const aliceName = `pass-alice-${suffix.slice(-8)}.gwei`;
  const bobName = `pass-bob-${suffix.slice(-8)}.gwei`;
  const alice = await context.newPage();
  const bob = await context.newPage();
  await Promise.all([installTestWallet(alice), installTestWallet(bob)]);
  const protectedRelay = encodeURIComponent("http://127.0.0.1:8792");

  await Promise.all([
    alice.goto(
      `/?profile=${aliceProfile}&batcher=${protectedRelay}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&onchain=0&vault=off`,
    ),
    bob.goto(
      `/?profile=${bobProfile}&batcher=${protectedRelay}&executionRpc=${MOCK_EXECUTION_RPC_QUERY}&onchain=0&vault=off`,
    ),
  ]);
  await Promise.all([waitUntilLive(alice), waitUntilLive(bob)]);
  const [, bobCode] = await Promise.all([
    publishTestIdentity(alice, aliceProfile, aliceName),
    publishTestIdentity(bob, bobProfile, bobName),
  ]);
  await activateRelayPasses(alice, aliceName.replace(/\.gwei$/u, ""));
  await activateRelayPasses(bob, bobName.replace(/\.gwei$/u, ""));
  await addContact(alice, bobCode, "Bob");
  await acceptChatRequest(bob, aliceName);

  await alice.locator("#message-input").fill("holder-gated and anonymously redeemed");
  await alice.getByRole("button", { name: "Send message" }).click();
  await expect(bob.locator(".message.incoming .bubble")).toHaveText(
    "holder-gated and anonymously redeemed",
    { timeout: 10_000 },
  );
  await context.close();
});

test("a passkey migrates, encrypts, locks, and restores the browser vault", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const removeAuthenticator = await installVirtualPasskey(page);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const profile = `vault-${suffix}`;

  await page.goto(`http://localhost:5174/?profile=${profile}&onchain=0&vault=off`);
  await waitUntilLive(page);
  const originalCode = await contactCode(page);

  await page.goto(`http://localhost:5174/?profile=${profile}&onchain=0`);
  const vault = page.locator("#vault-dialog");
  await expect(vault).toBeVisible();
  await expect(vault.getByRole("heading")).toHaveText("Protect your existing identity");
  await vault.getByRole("button", { name: "Protect with passkey" }).click();
  await waitUntilLive(page);
  await expect(vault).toBeHidden();
  expect(await contactCode(page)).toBe(originalCode);

  const stored = await page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const transaction = database.transaction("private-state", "readonly");
    const store = transaction.objectStore("private-state");
    const read = (key: string): Promise<unknown> => new Promise((resolve, reject) => {
      const request = store.get(key);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
    const [legacy, config, encrypted] = await Promise.all([
      read("state"),
      read("vault-config"),
      read("vault-state"),
    ]);
    database.close();
    return {
      legacyPresent: legacy !== undefined,
      config: JSON.stringify(config),
      encrypted: JSON.stringify(encrypted),
    };
  }, `gwei-chat-prototype-v0:${profile.slice(0, 32)}`);
  expect(stored.legacyPresent).toBe(false);
  expect(stored.config).toContain("webauthn-prf");
  expect(stored.encrypted).not.toContain(originalCode);
  expect(stored.encrypted).not.toContain("pickleKey");

  await page.reload();
  await expect(page.locator("#app")).toBeHidden();
  await expect(vault.getByRole("heading")).toHaveText("Unlock private chat");
  await vault.getByRole("button", { name: "Unlock with passkey" }).click();
  await waitUntilLive(page);
  expect(await contactCode(page)).toBe(originalCode);

  await page.locator("#identity-button").click();
  await expect(page.locator("#vault-control")).toContainText("Passkey vault unlocked");
  await page.getByRole("button", { name: "Lock now" }).click();
  await expect(vault.getByRole("heading")).toHaveText("Unlock private chat");

  page.once("dialog", (dialog) => dialog.accept());
  await vault.getByRole("button", { name: "Reset a lost vault" }).click();
  await expect(vault.getByRole("heading")).toHaveText("Protect your chat keys");
  await expect(page.locator("#app")).toBeHidden();

  await removeAuthenticator();
  await context.close();
});
