import { unpackEnvelopeSlots } from "./blob-batch";
import { sha256Base64Url } from "./encoding";
import {
  GNS_CONTRACT_ADDRESS,
  publishGweiContact,
  resolveGweiContact,
} from "./gns-chat";
import type { ResolvedGweiContact } from "./gns-chat";
import {
  browserGnsDirectoryCache,
  discoverGweiChatContacts,
} from "./gns-directory";
import type { GnsDirectoryProgress } from "./gns-directory";
import type { Eip1193Provider } from "ethers";
import {
  acknowledgeOutbox,
  acceptSessionRequest,
  advanceBatchCursor,
  advanceOnchainBatchCursor,
  establishFreshIdentityOnchainBaseline,
  getBatchCursor,
  getOnchainBatchCursor,
  getOutbox,
  getSnapshot,
  getUnverifiedSessionRequests,
  ignoreSessionRequest,
  importContact,
  initializeProtocol,
  prepareMessage,
  receiveEnvelope,
  receiveEnvelopes,
  rememberPublishedGweiName,
  requestSession,
  resetProtocol,
  verifySessionRequest,
} from "./protocol";
import type { ProtocolSnapshot } from "./protocol";
import {
  activateRelayAccess,
  connectRelay,
  fetchBatcherHealth,
  fetchBatchBlob,
  listBatches,
  relayAccessName,
  rememberRelayAccessName,
  submitEnvelope,
} from "./relay";
import type { BatcherHealth, PublishedBatchNotice, RelayStatus } from "./relay";
import {
  currentTransportSettings,
  restoreDefaultTransportSettings,
  saveTransportSettings,
} from "./settings";
import type { TransportSettings } from "./settings";
import { RelayHolderNameRequiredError } from "./admission/protocol";
import {
  destroyPrivateVault,
  getVaultBootstrap,
  lockPrivateVault,
  privateVaultProtected,
  profile,
  setupPasskeyProtection,
  unlockPrivateVault,
} from "./storage";
import type { VaultBootstrap } from "./storage";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing required element #${id}`);
  return value as T;
}

function selector<T extends Element>(query: string): T {
  const value = document.querySelector<T>(query);
  if (!value) throw new Error(`Missing required element ${query}`);
  return value;
}

const elements = {
  addButton: element<HTMLButtonElement>("add-button"),
  addDialog: element<HTMLDialogElement>("add-dialog"),
  addError: element<HTMLParagraphElement>("add-error"),
  addForm: element<HTMLFormElement>("add-form"),
  addNameForm: element<HTMLFormElement>("add-name-form"),
  app: element<HTMLElement>("app"),
  boot: element<HTMLElement>("boot"),
  chat: element<HTMLElement>("chat"),
  chatKey: element<HTMLElement>("chat-key"),
  chatStatus: element<HTMLElement>("chat-status"),
  chatTitle: element<HTMLHeadingElement>("chat-title"),
  composer: element<HTMLFormElement>("composer"),
  composerHint: element<HTMLElement>("composer-hint"),
  connection: selector<HTMLElement>(".connection"),
  connectionLabel: element<HTMLElement>("connection-label"),
  contactCode: element<HTMLTextAreaElement>("contact-code"),
  contacts: element<HTMLElement>("contacts"),
  copyCodeButton: element<HTMLButtonElement>("copy-code-button"),
  directoryList: element<HTMLElement>("directory-list"),
  directoryRefresh: element<HTMLButtonElement>("directory-refresh"),
  directoryStatus: element<HTMLParagraphElement>("directory-status"),
  emptyAddButton: element<HTMLButtonElement>("empty-add-button"),
  emptyIdentityButton: element<HTMLButtonElement>("empty-identity-button"),
  emptyState: element<HTMLElement>("empty-state"),
  guideChatState: element<HTMLElement>("guide-chat-state"),
  guideIdentityState: element<HTMLElement>("guide-identity-state"),
  guidePeopleState: element<HTMLElement>("guide-people-state"),
  identityButton: element<HTMLButtonElement>("identity-button"),
  identityAdvanced: element<HTMLDetailsElement>("identity-advanced"),
  identityCopy: element<HTMLParagraphElement>("identity-copy"),
  identityDialog: element<HTMLDialogElement>("identity-dialog"),
  identityPublished: element<HTMLElement>("identity-published"),
  identityPublishedName: element<HTMLElement>("identity-published-name"),
  identityTitle: element<HTMLHeadingElement>("identity-title"),
  manualContact: element<HTMLDetailsElement>("manual-contact"),
  messageInput: element<HTMLTextAreaElement>("message-input"),
  messages: element<HTMLElement>("messages"),
  newContactCode: element<HTMLTextAreaElement>("new-contact-code"),
  newContactLabel: element<HTMLInputElement>("new-contact-label"),
  newContactName: element<HTMLInputElement>("new-contact-name"),
  onboardingAddError: element<HTMLParagraphElement>("onboarding-add-error"),
  onboardingContactName: element<HTMLInputElement>("onboarding-contact-name"),
  onboardingDirectoryList: element<HTMLElement>("onboarding-directory-list"),
  onboardingDirectoryRefresh: element<HTMLButtonElement>("onboarding-directory-refresh"),
  onboardingDirectoryStatus: element<HTMLParagraphElement>("onboarding-directory-status"),
  onboardingNameForm: element<HTMLFormElement>("onboarding-name-form"),
  onboardingResolveName: element<HTMLButtonElement>("onboarding-resolve-name"),
  outboxLabel: element<HTMLElement>("outbox-label"),
  profileLabel: element<HTMLElement>("profile-label"),
  publishButton: element<HTMLButtonElement>("publish-button"),
  publishError: element<HTMLParagraphElement>("publish-error"),
  publishForm: element<HTMLFormElement>("publish-form"),
  publishName: element<HTMLInputElement>("publish-name"),
  publishStatus: element<HTMLParagraphElement>("publish-status"),
  requestButton: element<HTMLButtonElement>("request-button"),
  requestDialog: element<HTMLDialogElement>("request-dialog"),
  requestList: element<HTMLElement>("request-list"),
  requestStatus: element<HTMLParagraphElement>("request-status"),
  relayAccessButton: element<HTMLButtonElement>("relay-access-button"),
  resetButton: element<HTMLButtonElement>("reset-button"),
  resolveNameButton: element<HTMLButtonElement>("resolve-name-button"),
  settingsBatcherUrl: element<HTMLInputElement>("settings-batcher-url"),
  settingsBeaconApi: element<HTMLInputElement>("settings-beacon-api"),
  settingsButton: element<HTMLButtonElement>("settings-button"),
  settingsDefaults: element<HTMLButtonElement>("settings-defaults"),
  settingsDialog: element<HTMLDialogElement>("settings-dialog"),
  settingsError: element<HTMLParagraphElement>("settings-error"),
  settingsExecutionRpc: element<HTMLInputElement>("settings-execution-rpc"),
  settingsForm: element<HTMLFormElement>("settings-form"),
  settingsOnchainEnabled: element<HTMLInputElement>("settings-onchain-enabled"),
  settingsStatus: element<HTMLElement>("settings-status"),
  sendButton: element<HTMLButtonElement>("send-button"),
  setupIdentityStep: element<HTMLElement>("setup-identity-step"),
  setupPeopleStep: element<HTMLElement>("setup-people-step"),
  themeButton: element<HTMLButtonElement>("theme-button"),
  toast: element<HTMLElement>("toast"),
  vaultControl: element<HTMLElement>("vault-control"),
  vaultCopy: element<HTMLParagraphElement>("vault-copy"),
  vaultDialog: element<HTMLDialogElement>("vault-dialog"),
  vaultError: element<HTMLParagraphElement>("vault-error"),
  vaultLock: element<HTMLButtonElement>("vault-lock"),
  vaultPrimary: element<HTMLButtonElement>("vault-primary"),
  vaultReset: element<HTMLButtonElement>("vault-reset"),
  vaultStatus: element<HTMLParagraphElement>("vault-status"),
  vaultTitle: element<HTMLHeadingElement>("vault-title"),
};

interface ThreadMessage {
  id: string;
  text: string;
  sentAt: number;
  direction: "in" | "out";
  status?: string;
}

interface OnchainSettings {
  executionRpcUrl: string;
  beaconApiUrl: string;
  contractAddress: string;
  expectedChainId?: bigint;
}

const query = new URLSearchParams(location.search);
const transportSettings = currentTransportSettings();
const liveReceptionEnabled = query.get("live") !== "0";
const BATCH_POLL_INTERVAL_MS = 750;
const ONCHAIN_POLL_INTERVAL_MS = 12_000;
const ONCHAIN_FETCH_CONCURRENCY = 4;
const BATCHER_HEALTH_INTERVAL_MS = 5_000;
const SEPOLIA_ERC8179 = "0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314";
const SEPOLIA_CHAIN_ID = 11_155_111n;

function configuredChainId(): bigint {
  const value = query.get("chainId") || import.meta.env.VITE_CHAIN_ID;
  if (!value) return SEPOLIA_CHAIN_ID;
  try {
    const chainId = BigInt(value);
    if (chainId <= 0n) throw new Error("invalid");
    return chainId;
  } catch {
    throw new Error("The configured chain ID is invalid");
  }
}

function configuredGnsAddress(): string {
  return query.get("gns") || import.meta.env.VITE_GNS_ADDRESS || GNS_CONTRACT_ADDRESS;
}

function configuredGnsFromBlock(): number | undefined {
  const value = query.get("gnsFromBlock") || import.meta.env.VITE_GNS_FROM_BLOCK;
  if (!value) return undefined;
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < 0) {
    throw new Error("The configured GNS deployment block is invalid");
  }
  return block;
}

function configuredOnchainSource(): OnchainSettings | null {
  if (!transportSettings.onchainEnabled) return null;
  const contractAddress = query.get("erc8179") ||
    import.meta.env.VITE_ERC8179_ADDRESS ||
    SEPOLIA_ERC8179;
  return {
    executionRpcUrl: transportSettings.executionRpcUrl,
    beaconApiUrl: transportSettings.beaconApiUrl,
    contractAddress,
    expectedChainId: configuredChainId(),
  };
}

let snapshot: ProtocolSnapshot = {
  contactCode: null,
  publishedGweiName: null,
  contacts: [],
  incomingRequests: [],
  unverifiedRequestCount: 0,
  outboxCount: 0,
};
let selectedContactId: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let batchTimer: ReturnType<typeof setInterval> | undefined;
let onchainTimer: ReturnType<typeof setInterval> | undefined;
let batcherHealthTimer: ReturnType<typeof setInterval> | undefined;
let outboxRetryTimer: ReturnType<typeof setTimeout> | undefined;
let drainPromise: Promise<void> | null = null;
let batchPollPromise: Promise<void> | null = null;
let onchainPollPromise: Promise<void> | null = null;
let batcherHealthPromise: Promise<void> | null = null;
let directoryScanPromise: Promise<void> | null = null;
let requestVerificationPromise: Promise<void> | null = null;
let requestVerificationQueued = false;
let directoryHasScanned = false;
let vaultAction: "setup" | "locked" | null = null;
let vaultBackgroundTimer: ReturnType<typeof setTimeout> | undefined;
let applicationStarted = false;
let receiveQueue: Promise<void> = Promise.resolve();
let disconnectRelay: (() => void) | null = null;
let onchainSource: import("./onchain/source").OnchainBlobSource | null = null;
let batcherHealth: BatcherHealth | null = null;
let batcherHealthState: "checking" | "ready" | "error" = "checking";
let directoryContacts: ResolvedGweiContact[] = [];
let onchainState: "disabled" | "connecting" | "ready" | "error" = transportSettings.onchainEnabled
  ? "connecting"
  : "disabled";
const threads = new Map<string, ThreadMessage[]>();
const unread = new Map<string, number>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected prototype error";
}

function fullGweiName(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().endsWith(".gwei") ? trimmed : `${trimmed}.gwei`;
}

function gweiNameLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().endsWith(".gwei") ? trimmed.slice(0, -5) : trimmed;
}

function showToast(message: string): void {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2_800);
}

function shortTransaction(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function renderTransportStatus(): void {
  const publisher = batcherHealth?.publisher;
  let label = "sepolia · checking";
  let state = "checking";
  if (batcherHealthState === "error") {
    label = "sepolia · batcher offline";
    state = "error";
  } else if (onchainState === "error") {
    label = "sepolia · rpc error";
    state = "error";
  } else if (publisher?.state === "retrying" || publisher?.state === "stopped") {
    label = "sepolia · publish retry";
    state = "error";
  } else if (publisher?.state === "publishing") {
    label = "sepolia · publishing";
    state = "publishing";
  } else if (batcherHealthState === "ready" && publisher?.enabled && onchainState === "ready") {
    label = "sepolia · ready";
    state = "ready";
  } else if (batcherHealthState === "ready" && !publisher?.enabled) {
    label = transportSettings.onchainEnabled ? "sepolia · read only" : "local batcher";
    state = "ready";
  } else if (!transportSettings.onchainEnabled && batcherHealthState === "ready") {
    label = "onchain reads off";
    state = "ready";
  }
  elements.settingsButton.textContent = label;
  elements.settingsButton.dataset.state = state;
  elements.settingsButton.title = `Batcher: ${transportSettings.batcherUrl}\n` +
    `Execution RPC: ${transportSettings.executionRpcUrl}\n` +
    `Beacon API: ${transportSettings.beaconApiUrl}`;

  const lines: string[] = [];
  if (batcherHealthState === "error") {
    lines.push("Batcher: unreachable; outgoing envelopes remain queued locally.");
  } else if (batcherHealthState === "checking") {
    lines.push("Batcher: checking…");
  } else if (publisher?.enabled) {
    lines.push(`Batcher: ${publisher.state}; ${publisher.queued} batch${publisher.queued === 1 ? "" : "es"} queued.`);
    if (publisher.latest) {
      lines.push(`Latest publication: ${shortTransaction(publisher.latest.transactionHash)} at block ${publisher.latest.blockNumber}.`);
    }
  } else {
    lines.push("Batcher: reachable, but this operator has onchain publication disabled.");
  }
  if (onchainState === "ready") lines.push("Reader: finalized permissionless discovery is active.");
  if (onchainState === "connecting") lines.push("Reader: connecting to the configured RPC and Beacon API…");
  if (onchainState === "error") lines.push("Reader: endpoint error; edit the URLs and reconnect.");
  if (onchainState === "disabled") lines.push("Reader: onchain discovery is disabled.");
  if (batcherHealth?.admission.required) {
    const quota = batcherHealth.admission.quotaPerName;
    lines.push(
      `Relay access: top-level .gwei holders${quota ? `; ${quota} blind passes per name/day` : ""}.`,
    );
  } else if (batcherHealthState === "ready") {
    lines.push("Relay access: this operator is not holder-gated.");
  }
  elements.settingsStatus.textContent = lines.join("\n");
}

function pollBatcherHealth(): Promise<void> {
  if (batcherHealthPromise) return batcherHealthPromise;
  batcherHealthPromise = fetchBatcherHealth()
    .then((health) => {
      batcherHealth = health;
      batcherHealthState = "ready";
      renderTransportStatus();
    })
    .catch(() => {
      batcherHealth = null;
      batcherHealthState = "error";
      renderTransportStatus();
    })
    .finally(() => {
      batcherHealthPromise = null;
    });
  return batcherHealthPromise;
}

function requestBatcherHealth(): void {
  void pollBatcherHealth();
}

function handlePublication(notice: PublishedBatchNotice): void {
  showToast(`Encrypted batch posted · ${shortTransaction(notice.transactionHash)}`);
  requestBatcherHealth();
}

function populateSettings(settings: TransportSettings): void {
  elements.settingsBatcherUrl.value = settings.batcherUrl;
  elements.settingsExecutionRpc.value = settings.executionRpcUrl;
  elements.settingsBeaconApi.value = settings.beaconApiUrl;
  elements.settingsOnchainEnabled.checked = settings.onchainEnabled;
}

function initials(label: string): string {
  return label
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase();
}

function shortKey(contactId: string): string {
  return `${contactId.slice(0, 6)}…${contactId.slice(-6)}`;
}

function thread(contactId: string): ThreadMessage[] {
  let messages = threads.get(contactId);
  if (!messages) {
    messages = [];
    threads.set(contactId, messages);
  }
  return messages;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(timestamp),
  );
}

function renderContacts(): void {
  elements.contacts.replaceChildren();
  for (const contact of snapshot.contacts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `contact${contact.id === selectedContactId ? " active" : ""}`;
    button.dataset.contactId = contact.id;

    const avatar = document.createElement("span");
    avatar.className = "contact-avatar";
    avatar.textContent = initials(contact.label);

    const copy = document.createElement("span");
    copy.className = "contact-copy";
    const name = document.createElement("strong");
    name.textContent = contact.label;
    const detail = document.createElement("span");
    detail.textContent = contact.connectionState === "connected"
      ? "Private chat ready"
      : contact.connectionState === "ready"
        ? "Ready for your first message"
        : contact.connectionState === "accepted"
          ? "Request accepted"
        : contact.connectionState === "waiting"
          ? "Request sent"
          : "Starting private chat…";
    copy.append(name, detail);
    button.append(avatar, copy);

    const count = unread.get(contact.id) || 0;
    if (count) {
      const badge = document.createElement("span");
      badge.className = "unread";
      badge.textContent = String(count);
      button.append(badge);
    }

    elements.contacts.append(button);
  }
}

function renderIncomingRequests(): void {
  const verified = snapshot.incomingRequests.length;
  const total = verified + snapshot.unverifiedRequestCount;
  elements.requestButton.hidden = total === 0;
  elements.requestButton.textContent = verified > 0
    ? `Chat request${verified === 1 ? "" : "s"} · ${verified}`
    : "Checking chat request…";
  elements.requestButton.classList.toggle("primary", verified > 0);
  elements.requestButton.classList.toggle("secondary", verified === 0);

  elements.requestList.replaceChildren();
  for (const request of snapshot.incomingRequests) {
    const card = document.createElement("article");
    card.className = "request-card";
    card.dataset.requestId = request.id;
    const name = document.createElement("strong");
    name.textContent = request.senderName;
    const detail = document.createElement("p");
    detail.textContent = "Identity and current GNS ownership verified.";
    const actions = document.createElement("div");
    actions.className = "request-actions";
    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.className = "button secondary";
    ignore.dataset.requestAction = "ignore";
    ignore.textContent = "Ignore";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "button primary";
    accept.dataset.requestAction = "accept";
    accept.textContent = "Accept";
    actions.append(ignore, accept);
    card.append(name, detail, actions);
    elements.requestList.append(card);
  }
  elements.requestStatus.textContent = snapshot.unverifiedRequestCount > 0
    ? "Checking another request against GNS…"
    : "";
  if (elements.requestDialog.open && total === 0) elements.requestDialog.close();
}

function renderMessages(): void {
  elements.messages.replaceChildren();
  if (!selectedContactId) return;
  for (const message of thread(selectedContactId)) {
    const item = document.createElement("article");
    item.className = `message ${message.direction === "out" ? "outgoing" : "incoming"}`;
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.text;
    const meta = document.createElement("p");
    meta.className = "message-meta";
    const state = message.direction === "out" ? ` · ${message.status || "queued"}` : "";
    meta.textContent = `${formatTime(message.sentAt)}${state}`;
    item.append(bubble, meta);
    elements.messages.append(item);
  }
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderConversation(): void {
  const contact = snapshot.contacts.find((item) => item.id === selectedContactId);
  elements.emptyState.hidden = Boolean(contact);
  elements.chat.hidden = !contact;
  if (!contact) return;

  unread.delete(contact.id);
  elements.chatTitle.textContent = contact.label;
  elements.chatKey.textContent = shortKey(contact.id);
  const canSend = contact.connectionState === "connected" || contact.connectionState === "ready";
  elements.messageInput.disabled = !canSend;
  elements.sendButton.disabled = !canSend;
  if (contact.connectionState === "connected") {
    elements.chatStatus.textContent = "End-to-end encrypted";
    elements.messageInput.placeholder = "Write a private message…";
    elements.composerHint.textContent =
      "Messages are not saved as readable history. 600-byte limit.";
  } else if (contact.connectionState === "ready") {
    elements.chatStatus.textContent = "Private session ready";
    elements.messageInput.placeholder = "Write your first private message…";
    elements.composerHint.textContent =
      "Your first message completes the private session. Keep this tab open until it is sent.";
  } else if (contact.connectionState === "accepted") {
    elements.chatStatus.textContent = "Request accepted";
    elements.messageInput.placeholder = `Waiting for ${contact.label}'s first message…`;
    elements.composerHint.textContent =
      "Your signed one-time key is on its way. No readable message has been received yet.";
  } else {
    elements.chatStatus.textContent = "Waiting for them to accept";
    elements.messageInput.placeholder = `Waiting for ${contact.label}…`;
    elements.composerHint.textContent =
      "Only they can see your signed .gwei identity. The request expires after 24 hours.";
  }
  renderMessages();
}

function setGuideState(element: HTMLElement, state: "complete" | "current" | "upcoming"): void {
  element.dataset.state = state;
}

function renderOnboarding(): void {
  const publishedName = snapshot.publishedGweiName;
  const hasPublishedIdentity = publishedName !== null;
  const hasSelectedContact = snapshot.contacts.some((contact) => contact.id === selectedContactId);

  elements.setupIdentityStep.hidden = hasPublishedIdentity;
  elements.setupPeopleStep.hidden = !hasPublishedIdentity;
  setGuideState(elements.guideIdentityState, hasPublishedIdentity ? "complete" : "current");
  setGuideState(
    elements.guidePeopleState,
    hasSelectedContact ? "complete" : hasPublishedIdentity ? "current" : "upcoming",
  );
  setGuideState(elements.guideChatState, hasSelectedContact ? "current" : "upcoming");

  elements.identityButton.textContent = hasPublishedIdentity ? "Identity ✓" : "Set up identity";
  elements.identityButton.title = hasPublishedIdentity
    ? `Published as ${publishedName}`
    : "Publish your public chat identity to a .gwei name";
  elements.identityButton.classList.toggle("primary", !hasPublishedIdentity);
  elements.identityButton.classList.toggle("secondary", hasPublishedIdentity);
  elements.addButton.classList.toggle("primary", hasPublishedIdentity);
  elements.addButton.classList.toggle("secondary", !hasPublishedIdentity);
  elements.addButton.textContent = snapshot.contacts.length === 0 ? "Choose person" : "New chat";

  elements.identityPublished.hidden = !hasPublishedIdentity;
  elements.identityPublishedName.textContent = publishedName || "";
  elements.identityTitle.textContent = hasPublishedIdentity
    ? "Your chat identity"
    : "Publish your chat identity";
  elements.identityCopy.textContent = hasPublishedIdentity
    ? "Your public chat keys are published through GNS. Updating the record keeps the same name bound to this browser identity."
    : "Publishing lets other people discover your public encryption keys by typing your .gwei name. No private key or message goes onchain.";
  elements.publishButton.textContent = hasPublishedIdentity
    ? "Update published keys"
    : "Publish identity";
  if (publishedName && !elements.publishName.value) {
    elements.publishName.value = gweiNameLabel(publishedName);
  }

  if (hasPublishedIdentity && !directoryHasScanned) void scanGnsDirectory();
}

function render(): void {
  elements.contactCode.value = snapshot.contactCode || "";
  elements.outboxLabel.textContent = snapshot.outboxCount
    ? `· ${snapshot.outboxCount} queued`
    : "";
  elements.profileLabel.textContent = profile === "default" ? "" : profile;
  elements.profileLabel.hidden = profile === "default";
  elements.vaultControl.hidden = !privateVaultProtected();
  renderOnboarding();
  renderIncomingRequests();
  renderContacts();
  renderConversation();
}

async function refresh(): Promise<void> {
  snapshot = await getSnapshot();
  if (selectedContactId && !snapshot.contacts.some((item) => item.id === selectedContactId)) {
    selectedContactId = null;
  }
  render();
}

function selectContact(contactId: string): void {
  selectedContactId = contactId;
  render();
  void ensureContactSession(contactId);
  if (!elements.messageInput.disabled) elements.messageInput.focus();
}

const sessionRequestsInFlight = new Set<string>();

async function ensureContactSession(contactId: string): Promise<void> {
  if (sessionRequestsInFlight.has(contactId)) return;
  const contact = snapshot.contacts.find((item) => item.id === contactId);
  if (!contact || contact.connectionState !== "not-started") return;
  sessionRequestsInFlight.add(contactId);
  try {
    const result = await requestSession(contactId);
    await refresh();
    if (result.queued) void drainOutbox();
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    sessionRequestsInFlight.delete(contactId);
  }
}

function verifyPendingChatRequests(): Promise<void> {
  if (requestVerificationPromise) {
    requestVerificationQueued = true;
    return requestVerificationPromise;
  }
  requestVerificationPromise = (async () => {
    const pending = await getUnverifiedSessionRequests();
    const newlyVerified: string[] = [];
    for (const request of pending) {
      try {
        const resolved = await resolveGweiContact({
          rpcUrl: transportSettings.executionRpcUrl,
          name: request.senderName,
          expectedChainId: configuredChainId(),
          contractAddress: configuredGnsAddress(),
        });
        await verifySessionRequest(request.id, resolved.name, resolved.contactCode);
        newlyVerified.push(resolved.name);
      } catch (error) {
        console.warn("could not verify incoming chat request", error);
      }
    }
    await refresh();
    if (newlyVerified.length === 1) showToast(`${newlyVerified[0]} wants to chat`);
    if (newlyVerified.length > 1) showToast(`${newlyVerified.length} verified chat requests`);
  })().finally(() => {
    requestVerificationPromise = null;
    if (requestVerificationQueued) {
      requestVerificationQueued = false;
      void verifyPendingChatRequests();
    }
  });
  return requestVerificationPromise;
}

function setRelayState(state: RelayStatus): void {
  elements.connection.dataset.state = state;
  elements.connectionLabel.textContent = state === "live" ? "live relay" : "reconnecting";
  if (state === "live") void drainOutbox();
}

function markSent(messageId: string): void {
  for (const messages of threads.values()) {
    const message = messages.find((item) => item.id === messageId);
    if (message) message.status = "accepted by batcher";
  }
}

function drainOutbox(): Promise<void> {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    let relayFailed = false;
    while (!relayFailed) {
      const pending = await getOutbox();
      if (pending.length === 0) break;
      for (const item of pending) {
        try {
          await submitEnvelope(item.bytes);
          await acknowledgeOutbox(item.messageId);
          markSent(item.messageId);
        } catch (error) {
          if (error instanceof RelayHolderNameRequiredError) {
            elements.publishError.textContent = error.message;
            elements.publishStatus.textContent = "";
            openIdentityDialog(true);
          } else if (!outboxRetryTimer) {
            outboxRetryTimer = setTimeout(() => {
              outboxRetryTimer = undefined;
              void drainOutbox();
            }, 15_000);
          }
          relayFailed = true;
          break;
        }
      }
    }
    await refresh();
  })().finally(() => {
    drainPromise = null;
  });
  return drainPromise;
}

async function handleReceived(received: NonNullable<Awaited<ReturnType<typeof receiveEnvelope>>>): Promise<void> {
  if (received.kind === "handshake") {
    await refresh();
    if (received.responseQueued) void drainOutbox();
    if (received.phase === "request") {
      void verifyPendingChatRequests();
    } else if (received.contactId) {
      const contact = snapshot.contacts.find((item) => item.id === received.contactId);
      if (contact) showToast(`${contact.label} is ready for your first message`);
    }
    return;
  }

  thread(received.contactId).push({
    id: received.messageId,
    text: received.text,
    sentAt: received.sentAt,
    direction: "in",
  });
  if (!selectedContactId) selectedContactId = received.contactId;
  if (selectedContactId !== received.contactId) {
    unread.set(received.contactId, (unread.get(received.contactId) || 0) + 1);
    showToast(`New encrypted message from ${received.contact.label}`);
  }
  await refresh();
}

async function handleIncoming(transportId: string, bytes: Uint8Array): Promise<void> {
  const received = await receiveEnvelope(transportId, bytes);
  if (received) await handleReceived(received);
}

function queueIncoming(transportId: string, bytes: Uint8Array): Promise<void> {
  const operation = receiveQueue.then(() => handleIncoming(transportId, bytes));
  receiveQueue = operation.catch(() => undefined);
  return operation;
}

function queueBlob(blob: Uint8Array): Promise<void> {
  const operation = receiveQueue.then(async () => {
    const envelopes = await Promise.all(unpackEnvelopeSlots(blob).map(async (envelope) => ({
      transportId: await sha256Base64Url(envelope),
      envelope,
    })));
    const received = await receiveEnvelopes(envelopes);
    for (const item of received) await handleReceived(item.event);
  });
  receiveQueue = operation.catch(() => undefined);
  return operation;
}

function pollBatches(): Promise<void> {
  if (batchPollPromise) return batchPollPromise;
  batchPollPromise = (async () => {
    let cursor = await getBatchCursor();
    while (true) {
      const list = await listBatches(cursor);
      if (list.oldestSequence !== null && list.oldestSequence > cursor + 1) {
        console.warn(
          `blob batch history starts at ${list.oldestSequence}; batches through ${cursor} are unavailable`,
        );
      }
      if (list.batches.length === 0) break;

      for (const metadata of list.batches) {
        if (metadata.sequence <= cursor) continue;
        const blob = await fetchBatchBlob(metadata);
        await queueBlob(blob);
        cursor = await advanceBatchCursor(metadata.sequence);
      }
      if (list.batches.length < 16) break;
    }
  })().finally(() => {
    batchPollPromise = null;
  });
  return batchPollPromise;
}

function requestBatchPoll(): void {
  void pollBatches().catch((error: unknown) => {
    console.warn("blob batch poll failed", error);
  });
}

function pollOnchainBatches(): Promise<void> {
  if (!onchainSource) return Promise.resolve();
  if (onchainPollPromise) return onchainPollPromise;
  onchainPollPromise = (async () => {
    let cursor = await getOnchainBatchCursor();
    while (onchainSource) {
      const page = await onchainSource.list(cursor);
      for (let offset = 0; offset < page.segments.length; offset += ONCHAIN_FETCH_CONCURRENCY) {
        const window = page.segments.slice(offset, offset + ONCHAIN_FETCH_CONCURRENCY);
        const fetched = await Promise.all(window.map(async (segment) => ({
          segment,
          blob: segment.sequence <= cursor ? null : await onchainSource!.fetch(segment),
        })));
        // Ratchets and handshake state are order-dependent, so only retrieval
        // is concurrent; decrypted envelopes are still committed in chain order.
        for (const { segment, blob } of fetched) {
          if (segment.sequence <= cursor) continue;
          if (blob) {
            await queueBlob(blob);
          }
          cursor = await advanceOnchainBatchCursor(segment.sequence);
        }
      }
      if (page.scannedThrough > cursor) {
        cursor = await advanceOnchainBatchCursor(page.scannedThrough);
      }
      if (!page.hasMore) break;
    }
    onchainState = "ready";
    renderTransportStatus();
  })().finally(() => {
    onchainPollPromise = null;
  });
  return onchainPollPromise;
}

function requestOnchainPoll(): void {
  void pollOnchainBatches().catch((error: unknown) => {
    onchainState = "error";
    renderTransportStatus();
    console.warn("onchain blob poll failed", error);
  });
}

function appendDirectoryContacts(container: HTMLElement): void {
  for (const contact of directoryContacts) {
    const row = document.createElement("div");
    row.className = "directory-entry";
    row.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "directory-contact";
    button.dataset.directoryName = contact.name;
    button.setAttribute("aria-label", `Message ${contact.name}`);
    const name = document.createElement("span");
    name.textContent = contact.name;
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    button.append(name, arrow);
    row.append(button);
    container.append(row);
  }
}

function renderDirectoryContacts(): void {
  elements.directoryList.replaceChildren();
  elements.onboardingDirectoryList.replaceChildren();
  appendDirectoryContacts(elements.directoryList);
  appendDirectoryContacts(elements.onboardingDirectoryList);
}

function setDirectoryStatus(message: string): void {
  elements.directoryStatus.textContent = message;
  elements.onboardingDirectoryStatus.textContent = message;
}

function renderDirectoryProgress(progress: GnsDirectoryProgress): void {
  if (progress.stage === "scanning") {
    setDirectoryStatus(
      `Indexing GNS through block ${progress.currentBlock.toLocaleString()} · ` +
      `${progress.candidateCount} published candidate${progress.candidateCount === 1 ? "" : "s"}`,
    );
    return;
  }
  setDirectoryStatus(
    `Verifying current owners and chat keys · ${progress.checked}/${progress.total}`,
  );
}

function scanGnsDirectory(force = false): Promise<void> {
  if (directoryScanPromise) return directoryScanPromise;
  if (directoryHasScanned && !force) return Promise.resolve();
  directoryScanPromise = (async () => {
    elements.directoryRefresh.disabled = true;
    elements.onboardingDirectoryRefresh.disabled = true;
    setDirectoryStatus("Indexing published GNS chat contacts…");
    directoryContacts = [];
    renderDirectoryContacts();
    try {
      const fromBlock = configuredGnsFromBlock();
      const result = await discoverGweiChatContacts({
        rpcUrl: transportSettings.executionRpcUrl,
        expectedChainId: configuredChainId(),
        contractAddress: configuredGnsAddress(),
        cache: browserGnsDirectoryCache,
        onProgress: renderDirectoryProgress,
        ...(fromBlock === undefined ? {} : { fromBlock }),
      });
      directoryContacts = result.contacts.filter(
        (contact) => contact.contactCode !== snapshot.contactCode,
      );
      renderDirectoryContacts();
      if (directoryContacts.length === 0) {
        setDirectoryStatus("No other chat identities found yet.");
      } else {
        setDirectoryStatus(
          `${directoryContacts.length} verified name${directoryContacts.length === 1 ? "" : "s"} · ` +
          `current at block ${result.latestBlock.toLocaleString()}`,
        );
      }
    } catch (error) {
      setDirectoryStatus(
        `Directory unavailable from this RPC: ${errorMessage(error)} ` +
        "You can still enter a name directly.",
      );
    }
  })().finally(() => {
    directoryHasScanned = true;
    elements.directoryRefresh.disabled = false;
    elements.onboardingDirectoryRefresh.disabled = false;
    directoryScanPromise = null;
  });
  return directoryScanPromise;
}

async function addGweiName(name: string): Promise<void> {
  const resolved = await resolveGweiContact({
    rpcUrl: transportSettings.executionRpcUrl,
    name,
    expectedChainId: configuredChainId(),
    contractAddress: configuredGnsAddress(),
  });
  const contact = await importContact(resolved.contactCode, resolved.name);
  selectedContactId = contact.id;
  elements.addNameForm.reset();
  elements.onboardingNameForm.reset();
  if (elements.addDialog.open) elements.addDialog.close();
  await refresh();
  selectContact(contact.id);
  showToast(`${resolved.name} · owner and chat keys verified`);
}

async function restorePreviouslyPublishedIdentity(): Promise<void> {
  if (snapshot.publishedGweiName || !snapshot.contactCode) return;
  const candidate = await relayAccessName();
  if (!candidate) return;
  try {
    const resolved = await resolveGweiContact({
      rpcUrl: transportSettings.executionRpcUrl,
      name: candidate,
      expectedChainId: configuredChainId(),
      contractAddress: configuredGnsAddress(),
    });
    if (resolved.contactCode !== snapshot.contactCode) return;
    await rememberPublishedGweiName(resolved.name);
    await refresh();
  } catch {
    // Older profiles can continue through setup if their previous record is stale or unavailable.
  }
}

function vaultErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "The passkey request was cancelled or timed out";
  }
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return "That passkey could not be created for this vault";
  }
  return errorMessage(error);
}

function presentVaultGate(bootstrap: VaultBootstrap): void {
  if (bootstrap.status !== "setup" && bootstrap.status !== "locked") return;
  vaultAction = bootstrap.status;
  elements.vaultError.textContent = "";
  elements.vaultStatus.textContent = "";
  if (bootstrap.status === "setup") {
    elements.vaultTitle.textContent = bootstrap.hasExistingState
      ? "Protect your existing identity"
      : "Protect your chat keys";
    elements.vaultCopy.textContent = bootstrap.hasExistingState
      ? "Create a passkey to migrate this browser's identity, ratchets, and relay passes into an encrypted local vault."
      : "Create a passkey to unlock an encrypted local vault. Chat and ratchet keys remain independent from the passkey.";
    elements.vaultPrimary.textContent = "Protect with passkey";
    elements.vaultReset.hidden = true;
  } else {
    elements.vaultTitle.textContent = "Unlock private chat";
    elements.vaultCopy.textContent =
      "Use the passkey that protects this browser's encrypted chat identity and ratchet state.";
    elements.vaultPrimary.textContent = "Unlock with passkey";
    elements.vaultReset.hidden = false;
  }
  selector<HTMLParagraphElement>("#boot p").textContent = bootstrap.status === "setup"
    ? "waiting for private vault setup…"
    : "private vault locked…";
  if (!elements.vaultDialog.open) elements.vaultDialog.showModal();
  elements.vaultPrimary.focus();
}

function lockAndReload(): void {
  lockPrivateVault();
  location.reload();
}

function updateBackgroundVaultLock(): void {
  if (vaultBackgroundTimer) {
    clearTimeout(vaultBackgroundTimer);
    vaultBackgroundTimer = undefined;
  }
  if (document.hidden && privateVaultProtected()) {
    vaultBackgroundTimer = setTimeout(lockAndReload, 5 * 60_000);
  }
}

function openIdentityDialog(showRelayAccess = false): void {
  elements.publishError.textContent = "";
  elements.publishStatus.textContent = "";
  elements.identityAdvanced.open = showRelayAccess;
  if (!elements.identityDialog.open) elements.identityDialog.showModal();
  void relayAccessName().then((name) => {
    if (name && !elements.publishName.value) elements.publishName.value = gweiNameLabel(name);
    if (showRelayAccess) elements.relayAccessButton.focus();
    else elements.publishName.focus();
  });
}

function openAddDialog(showManualContact = false): void {
  elements.addError.textContent = "";
  elements.manualContact.open = showManualContact;
  if (!elements.addDialog.open) elements.addDialog.showModal();
  if (showManualContact) elements.newContactCode.focus();
  else elements.newContactName.focus();
  void scanGnsDirectory();
}

elements.vaultDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
});
elements.vaultPrimary.addEventListener("click", async () => {
  if (!vaultAction) return;
  elements.vaultPrimary.disabled = true;
  elements.vaultError.textContent = "";
  elements.vaultStatus.textContent = vaultAction === "setup"
    ? "Confirm passkey creation with your device…"
    : "Verify with your device to unlock…";
  try {
    if (vaultAction === "setup") await setupPasskeyProtection();
    else await unlockPrivateVault();
    vaultAction = null;
    await startUnlockedApplication();
    elements.vaultDialog.close();
  } catch (error) {
    elements.vaultStatus.textContent = "";
    elements.vaultError.textContent = vaultErrorMessage(error);
  } finally {
    elements.vaultPrimary.disabled = false;
  }
});
elements.vaultReset.addEventListener("click", async () => {
  if (!confirm(
    "Delete this encrypted vault? Its chat identity, contacts, sessions, passes, and queued envelopes cannot be recovered.",
  )) return;
  await destroyPrivateVault();
  location.reload();
});
elements.vaultLock.addEventListener("click", lockAndReload);
document.addEventListener("visibilitychange", updateBackgroundVaultLock);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});

elements.identityButton.addEventListener("click", () => openIdentityDialog());
elements.emptyIdentityButton.addEventListener("click", () => openIdentityDialog());
selector<HTMLButtonElement>("[data-close-identity]").addEventListener("click", () => {
  elements.identityDialog.close();
});
elements.addButton.addEventListener("click", () => openAddDialog());
elements.emptyAddButton.addEventListener("click", () => openAddDialog(true));
elements.directoryRefresh.addEventListener("click", () => {
  void scanGnsDirectory(true);
});
elements.onboardingDirectoryRefresh.addEventListener("click", () => {
  void scanGnsDirectory(true);
});
selector<HTMLButtonElement>("[data-close-add]").addEventListener("click", () => {
  elements.addDialog.close();
});
elements.requestButton.addEventListener("click", () => {
  if (snapshot.incomingRequests.length > 0) {
    elements.requestStatus.textContent = "";
    elements.requestDialog.showModal();
  } else {
    void verifyPendingChatRequests();
  }
});
selector<HTMLButtonElement>("[data-close-requests]").addEventListener("click", () => {
  elements.requestDialog.close();
});
elements.requestList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const action = event.target.closest<HTMLButtonElement>("[data-request-action]");
  const card = action?.closest<HTMLElement>("[data-request-id]");
  const requestId = card?.dataset.requestId;
  const request = snapshot.incomingRequests.find((item) => item.id === requestId);
  if (!action || !card || !requestId || !request) return;
  void (async () => {
    for (const button of card.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = true;
    }
    elements.requestStatus.textContent = "";
    try {
      if (action.dataset.requestAction === "ignore") {
        await ignoreSessionRequest(requestId);
        await refresh();
        showToast("Request ignored · no response sent");
        return;
      }

      elements.requestStatus.textContent = `Re-checking ${request.senderName} before accepting…`;
      const resolved = await resolveGweiContact({
        rpcUrl: transportSettings.executionRpcUrl,
        name: request.senderName,
        expectedChainId: configuredChainId(),
        contractAddress: configuredGnsAddress(),
      });
      await verifySessionRequest(requestId, resolved.name, resolved.contactCode);
      const accepted = await acceptSessionRequest(requestId, resolved.contactCode);
      selectedContactId = accepted.contact.id;
      await refresh();
      if (accepted.queued) void drainOutbox();
      showToast(`${resolved.name} accepted · waiting for their first message`);
    } catch (error) {
      elements.requestStatus.textContent = errorMessage(error);
      for (const button of card.querySelectorAll<HTMLButtonElement>("button")) {
        button.disabled = false;
      }
    }
  })();
});
elements.settingsButton.addEventListener("click", () => {
  populateSettings(transportSettings);
  elements.settingsError.textContent = "";
  renderTransportStatus();
  elements.settingsDialog.showModal();
});
selector<HTMLButtonElement>("[data-close-settings]").addEventListener("click", () => {
  elements.settingsDialog.close();
});
elements.settingsDefaults.addEventListener("click", () => {
  try {
    populateSettings(restoreDefaultTransportSettings());
    elements.settingsError.textContent = "Defaults restored. Save to reconnect now.";
  } catch (error) {
    elements.settingsError.textContent = errorMessage(error);
  }
});
elements.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.settingsError.textContent = "";
  try {
    saveTransportSettings({
      batcherUrl: elements.settingsBatcherUrl.value,
      executionRpcUrl: elements.settingsExecutionRpc.value,
      beaconApiUrl: elements.settingsBeaconApi.value,
      onchainEnabled: elements.settingsOnchainEnabled.checked,
    });
    location.reload();
  } catch (error) {
    elements.settingsError.textContent = errorMessage(error);
  }
});

for (const input of [
  elements.publishName,
  elements.newContactName,
  elements.onboardingContactName,
]) {
  const removeVisibleSuffix = (): void => {
    input.value = gweiNameLabel(input.value);
  };
  input.addEventListener("input", removeVisibleSuffix);
  input.addEventListener("blur", removeVisibleSuffix);
}

elements.contacts.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLElement>("[data-contact-id]");
  const contactId = button?.dataset.contactId;
  if (contactId) selectContact(contactId);
});

function handleDirectorySelection(event: Event): void {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("[data-directory-name]");
  const name = button?.dataset.directoryName;
  if (!button || !name) return;
  void (async () => {
    elements.addError.textContent = "";
    elements.onboardingAddError.textContent = "";
    button.disabled = true;
    setDirectoryStatus(`Re-verifying ${name} at the latest block…`);
    try {
      await addGweiName(name);
    } catch (error) {
      elements.addError.textContent = errorMessage(error);
      elements.onboardingAddError.textContent = errorMessage(error);
      setDirectoryStatus(
        "That entry changed after the directory scan. Refresh or enter a name directly.",
      );
    } finally {
      button.disabled = false;
    }
  })();
}

elements.directoryList.addEventListener("click", handleDirectorySelection);
elements.onboardingDirectoryList.addEventListener("click", handleDirectorySelection);

elements.copyCodeButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.contactCode.value);
    showToast("Contact code copied");
  } catch {
    elements.contactCode.select();
    showToast("Select and copy the contact code");
  }
});

elements.addNameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.addError.textContent = "";
  elements.resolveNameButton.disabled = true;
  const previousLabel = elements.resolveNameButton.textContent;
  elements.resolveNameButton.textContent = "Verifying…";
  try {
    await addGweiName(fullGweiName(elements.newContactName.value));
  } catch (error) {
    elements.addError.textContent = errorMessage(error);
  } finally {
    elements.resolveNameButton.disabled = false;
    elements.resolveNameButton.textContent = previousLabel;
  }
});

elements.onboardingNameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.onboardingAddError.textContent = "";
  elements.onboardingResolveName.disabled = true;
  const previousLabel = elements.onboardingResolveName.textContent;
  elements.onboardingResolveName.textContent = "Verifying…";
  try {
    await addGweiName(fullGweiName(elements.onboardingContactName.value));
  } catch (error) {
    elements.onboardingAddError.textContent = errorMessage(error);
  } finally {
    elements.onboardingResolveName.disabled = false;
    elements.onboardingResolveName.textContent = previousLabel;
  }
});

elements.addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.addError.textContent = "";
  try {
    const contact = await importContact(
      elements.newContactCode.value,
      elements.newContactLabel.value,
    );
    selectedContactId = contact.id;
    elements.addForm.reset();
    elements.addDialog.close();
    await refresh();
    selectContact(contact.id);
    showToast("Signed contact code verified");
  } catch (error) {
    elements.addError.textContent = errorMessage(error);
  }
});

elements.publishForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.publishError.textContent = "";
  elements.publishStatus.textContent = "";
  const ethereum = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!ethereum) {
    elements.publishError.textContent = "No browser wallet was found";
    return;
  }
  if (!snapshot.contactCode) {
    elements.publishError.textContent = "The browser chat identity is not ready";
    return;
  }

  elements.publishButton.disabled = true;
  const previousLabel = elements.publishButton.textContent;
  elements.publishButton.textContent = "Publishing…";
  elements.publishStatus.textContent = "Confirm the owner signature, then the GNS transaction.";
  try {
    const published = await publishGweiContact({
      ethereum,
      name: fullGweiName(elements.publishName.value),
      contactCode: snapshot.contactCode,
      expectedChainId: configuredChainId(),
      contractAddress: configuredGnsAddress(),
    });
    await rememberPublishedGweiName(published.name);
    await rememberRelayAccessName(published.name);
    elements.publishName.value = gweiNameLabel(published.name);
    elements.publishStatus.textContent =
      `${published.name} is ready · ${shortTransaction(published.transactionHash)}`;
    showToast(`${published.name} can now receive private messages`);
    directoryHasScanned = false;
    await refresh();
    elements.identityDialog.close();
    void scanGnsDirectory(true);
  } catch (error) {
    elements.publishStatus.textContent = "";
    elements.publishError.textContent = errorMessage(error);
  } finally {
    elements.publishButton.disabled = false;
    elements.publishButton.textContent = previousLabel;
  }
});

elements.relayAccessButton.addEventListener("click", async () => {
  elements.publishError.textContent = "";
  elements.publishStatus.textContent = "";
  const ethereum = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!ethereum) {
    elements.publishError.textContent = "No browser wallet was found";
    return;
  }
  if (!elements.publishName.reportValidity()) return;

  elements.relayAccessButton.disabled = true;
  const previousLabel = elements.relayAccessButton.textContent;
  elements.relayAccessButton.textContent = "Verifying…";
  elements.publishStatus.textContent = "Sign in once to receive blinded one-time passes.";
  try {
    const access = await activateRelayAccess(fullGweiName(elements.publishName.value), ethereum);
    if (!access.required) {
      elements.publishStatus.textContent = "This custom batcher does not require holder passes.";
    } else {
      elements.publishStatus.textContent =
        `${access.passes} unlinkable relay passes ready for ${access.utcDate}.`;
      showToast("Private relay access is ready");
      void drainOutbox();
    }
  } catch (error) {
    elements.publishStatus.textContent = "";
    elements.publishError.textContent = errorMessage(error);
  } finally {
    elements.relayAccessButton.disabled = false;
    elements.relayAccessButton.textContent = previousLabel;
  }
});

elements.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedContactId) return;
  const contactId = selectedContactId;
  const text = elements.messageInput.value;
  elements.messageInput.value = "";
  try {
    const message = await prepareMessage(contactId, text);
    thread(contactId).push({
      id: message.messageId,
      text: message.text,
      sentAt: message.sentAt,
      direction: "out",
      status: "queued",
    });
    renderMessages();
    await refresh();
    void drainOutbox();
  } catch (error) {
    elements.messageInput.value = text;
    showToast(errorMessage(error));
  }
});

elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    elements.composer.requestSubmit();
  }
});

elements.messageInput.addEventListener("input", () => {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 128)}px`;
});

elements.resetButton.addEventListener("click", async () => {
  if (!confirm("Delete this prototype identity, contacts, sessions, and queued envelopes?")) return;
  await resetProtocol();
  location.reload();
});

elements.themeButton.addEventListener("click", () => {
  const enabled = document.documentElement.classList.toggle("dark");
  try {
    localStorage.setItem("dark", enabled ? "1" : "0");
  } catch {
    // Theme persistence is optional.
  }
});

let pageClosing = false;

async function startOnchainReception(): Promise<void> {
  const onchain = configuredOnchainSource();
  if (!onchain) {
    onchainState = "disabled";
    renderTransportStatus();
    return;
  }
  try {
    const { OnchainBlobSource } = await import("./onchain/source");
    if (pageClosing) return;
    onchainSource = new OnchainBlobSource(onchain);
    const chainId = await onchainSource.chainId();
    if (pageClosing) return;
    const baseline = await onchainSource.finalizedCursor();
    await establishFreshIdentityOnchainBaseline(baseline);
    if (pageClosing) return;
    onchainState = "ready";
    renderTransportStatus();
    console.info(`permissionless onchain discovery enabled on chain ${chainId}`);
    requestOnchainPoll();
    onchainTimer = setInterval(requestOnchainPoll, ONCHAIN_POLL_INTERVAL_MS);
  } catch (error) {
    onchainSource = null;
    onchainState = "error";
    renderTransportStatus();
    console.warn("could not enable permissionless onchain discovery", error);
  }
}

async function startUnlockedApplication(): Promise<void> {
  if (applicationStarted) return;
  await initializeProtocol();
  await refresh();
  elements.boot.hidden = true;
  elements.app.hidden = false;
  void verifyPendingChatRequests();

  if (liveReceptionEnabled) {
    disconnectRelay = connectRelay({
      onEnvelope: (transportId, bytes) => void queueIncoming(transportId, bytes),
      onBatch: requestBatchPoll,
      onPublication: handlePublication,
      onStatus: setRelayState,
    });
  } else {
    elements.connection.dataset.state = "live";
    elements.connectionLabel.textContent = "blob polling";
    void drainOutbox();
  }

  requestBatchPoll();
  batchTimer = setInterval(requestBatchPoll, BATCH_POLL_INTERVAL_MS);
  renderTransportStatus();
  requestBatcherHealth();
  batcherHealthTimer = setInterval(requestBatcherHealth, BATCHER_HEALTH_INTERVAL_MS);
  void startOnchainReception();
  void restorePreviouslyPublishedIdentity();
  applicationStarted = true;
  updateBackgroundVaultLock();
  window.addEventListener(
    "pagehide",
    () => {
      pageClosing = true;
      disconnectRelay?.();
      if (batchTimer) clearInterval(batchTimer);
      if (onchainTimer) clearInterval(onchainTimer);
      if (batcherHealthTimer) clearInterval(batcherHealthTimer);
      if (outboxRetryTimer) clearTimeout(outboxRetryTimer);
      if (vaultBackgroundTimer) clearTimeout(vaultBackgroundTimer);
      lockPrivateVault();
    },
    { once: true },
  );
}

async function start(): Promise<void> {
  try {
    const bootstrap = await getVaultBootstrap();
    if (bootstrap.status === "setup" || bootstrap.status === "locked") {
      presentVaultGate(bootstrap);
      return;
    }
    await startUnlockedApplication();
  } catch (error) {
    selector<HTMLParagraphElement>("#boot p").textContent = `Could not start: ${errorMessage(error)}`;
  }
}

console.info(
  `gwei chat prototype · profile ${profile} · batcher configured · ` +
    `${liveReceptionEnabled ? "live + blob" : "blob only"}`,
);
void start();
