import { createPublicClient, createWalletClient, formatEther, http, isAddress, parseAbiItem, type Address, type Hash, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type RegistryStatus =
  | "registered"
  | "executed"
  | "no_due_payments"
  | "insufficient_funds"
  | "keeper_no_gas"
  | "error"
  | "abi_or_old_contract_error"
  | "invalid_contract"
  | "disabled"
  | "missing_config";

type RegistryEntry = {
  contractAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  payrollName: string;
  chainId: 1979;
  registeredAt: string;
  lastCheckedAt?: string;
  lastStatus?: RegistryStatus;
  lastTxHash?: Hash | "";
  lastError?: string;
  lastExecutionAttemptAt?: string;
  lastReceiptStatus?: TransactionReceipt["status"] | "";
  lastObservedAt?: string;
  appVersion?: string;
  contractVersion?: string;
  createdAt?: string;
  updatedAt?: string;
  failureCount?: number;
  disabled?: boolean;
  disabledReason?: string;
  keeperGasStatus?: "ok" | "low" | "unknown";
};

type RunResult = {
  contractAddress: `0x${string}`;
  status: RegistryStatus;
  txHash: Hash | "";
  receiptStatus: TransactionReceipt["status"] | "";
  error: string;
};

type RegistryStorage = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[] }>;
};

type Env = {
  REGISTRY_KV?: RegistryStorage;
  // KEEPER_PRIVATE_KEY must be a separate keeper wallet, never the payroll owner wallet.
  KEEPER_PRIVATE_KEY?: string;
  RITUAL_RPC_URL?: string;
  ALLOW_DEV_CLEAR?: string;
};

const ritualChain = {
  id: 1979,
  name: "Ritual Chain",
  nativeCurrency: { name: "RITUAL", symbol: "RITUAL", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ritualfoundation.org"] } },
  blockExplorers: { default: { name: "Ritual Explorer", url: "https://explorer.ritualfoundation.org" } }
} as const;

const executeAbi = [
  {
    type: "function",
    name: "executeDuePayments",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: []
  },
  {
    type: "error",
    name: "NoDuePayments",
    inputs: []
  },
  {
    type: "error",
    name: "InsufficientPayrollBalance",
    inputs: [
      { name: "requiredAmount", type: "uint256" },
      { name: "availableAmount", type: "uint256" }
    ]
  },
  {
    type: "error",
    name: "InsufficientKeeperFeeBalance",
    inputs: [
      { name: "requiredAmount", type: "uint256" },
      { name: "availableAmount", type: "uint256" }
    ]
  }
] as const;

const readAbi = [
  {
    type: "function",
    name: "getAccounting",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "payrollReserved_", type: "uint256" },
      { name: "keeperFeeReserved_", type: "uint256" },
      { name: "keeperRewardAmount_", type: "uint256" },
      { name: "contractBalance", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "getRecipients",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "wallet", type: "address" },
          { name: "label", type: "string" },
          { name: "amount", type: "uint256" },
          { name: "frequency", type: "uint8" },
          { name: "nextPaymentTime", type: "uint256" },
          { name: "active", type: "bool" },
          { name: "paidCount", type: "uint256" },
          { name: "removed", type: "bool" }
        ]
      }
    ]
  },
  {
    type: "function",
    name: "getPaymentHistory",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "recipientId", type: "uint256" },
          { name: "wallet", type: "address" },
          { name: "label", type: "string" },
          { name: "amount", type: "uint256" },
          { name: "timestamp", type: "uint256" }
        ]
      }
    ]
  }
] as const;

const paymentExecutedEvent = parseAbiItem("event PaymentExecuted(uint256 indexed recipientId, address indexed wallet, uint256 amount, uint256 timestamp)");

type RegistryDocument = {
  version: 1;
  updatedAt: string;
  registrations: Record<string, RegistryEntry>;
};

const REGISTRY_KEY = "payroll_registry_v1";
const SERVICE_NAME = "Ritual Payroll Scheduler Automation";
const LEGACY_REGISTRY_KEY = "registered-payroll-contracts";
const OBSERVED_AT_THROTTLE_MS = 6 * 60 * 60 * 1000;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function safeStringify(body: unknown) {
  try {
    return JSON.stringify(
      body,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    );
  } catch {
    return JSON.stringify({ ok: false, error: "Response serialization failed." });
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(safeStringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders()
    }
  });
}

function optionsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function errorResponse(error: string, status = 400, path?: string) {
  return jsonResponse({ ok: false, error, ...(path ? { path } : {}) }, status);
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function shortError(error: unknown) {
  return getErrorMessage(error).replace(/\s+/g, " ").slice(0, 500);
}

function normalizeAddress(value: string) {
  return value.toLowerCase() as `0x${string}`;
}

function registryKey(address: string) {
  return address.toLowerCase();
}

function emptyRegistryDocument(updatedAt = new Date().toISOString()): RegistryDocument {
  return { version: 1, updatedAt, registrations: {} };
}

function registryEntries(document: RegistryDocument) {
  return Object.values(document.registrations).sort((a, b) => registryKey(a.contractAddress).localeCompare(registryKey(b.contractAddress)));
}

function documentFromEntries(entries: RegistryEntry[], updatedAt = new Date().toISOString()): RegistryDocument {
  const registrations: Record<string, RegistryEntry> = {};
  for (const entry of entries) {
    registrations[registryKey(entry.contractAddress)] = {
      ...entry,
      contractAddress: normalizeAddress(entry.contractAddress),
      ownerAddress: normalizeAddress(entry.ownerAddress)
    };
  }
  return { version: 1, updatedAt, registrations };
}

function normalizeRegistryDocument(value: unknown): RegistryDocument {
  if (value && typeof value === "object" && !Array.isArray(value) && "registrations" in value) {
    const rawDocument = value as Partial<RegistryDocument>;
    const registrations = rawDocument.registrations && typeof rawDocument.registrations === "object" ? rawDocument.registrations : {};
    return documentFromEntries(Object.values(registrations) as RegistryEntry[], rawDocument.updatedAt || new Date().toISOString());
  }

  if (Array.isArray(value)) {
    return documentFromEntries(value as RegistryEntry[]);
  }

  return emptyRegistryDocument();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizePrivateKey(value?: string): { ok: true; privateKey: Hex } | { ok: false; error: string } {
  const trimmed = value?.trim();
  if (!trimmed) return { ok: false, error: "KEEPER_PRIVATE_KEY secret is missing." };

  const withoutPrefix = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(withoutPrefix)) {
    return { ok: false, error: "KEEPER_PRIVATE_KEY must be 32 bytes hex, with or without 0x prefix." };
  }

  return { ok: true, privateKey: `0x${withoutPrefix}` as Hex };
}

async function loadRegistrySafe(env: Env): Promise<{ ok: true; document: RegistryDocument; registry: RegistryEntry[] } | { ok: false; error: string }> {
  try {
    if (!env.REGISTRY_KV) return { ok: false, error: "REGISTRY_KV binding is missing." };
    const raw = await env.REGISTRY_KV.get(REGISTRY_KEY);
    if (!raw) {
      const document = emptyRegistryDocument();
      return { ok: true, document, registry: [] };
    }
    const document = normalizeRegistryDocument(JSON.parse(raw));
    return { ok: true, document, registry: registryEntries(document) };
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}

async function saveRegistrySafe(env: Env, document: RegistryDocument): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (!env.REGISTRY_KV) return { ok: false, error: "REGISTRY_KV binding is missing." };
    await env.REGISTRY_KV.put(REGISTRY_KEY, JSON.stringify(normalizeRegistryDocument(document)));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}

function shouldUpdateLastObservedAt(entry: RegistryEntry, checkedAt: string) {
  if (!entry.lastObservedAt) return true;
  const previous = Date.parse(entry.lastObservedAt);
  const current = Date.parse(checkedAt);
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return true;
  return current - previous >= OBSERVED_AT_THROTTLE_MS;
}

async function saveRegistryIfChanged(env: Env, oldDocument: RegistryDocument, newDocument: RegistryDocument) {
  const normalizedOld = normalizeRegistryDocument(oldDocument);
  const normalizedNew = normalizeRegistryDocument(newDocument);

  if (stableStringify(normalizedOld.registrations) === stableStringify(normalizedNew.registrations)) {
    return { ok: true as const, written: false };
  }

  const saved = await saveRegistrySafe(env, { ...normalizedNew, updatedAt: new Date().toISOString() });
  return saved.ok ? { ok: true as const, written: true } : saved;
}

function withStorageTiming(oldEntry: RegistryEntry, nextEntry: RegistryEntry, checkedAt: string, attemptAt?: string) {
  const coreChanged = ["lastStatus", "lastTxHash", "lastError", "lastReceiptStatus", "disabled", "disabledReason", "failureCount", "keeperGasStatus"].some(
    (field) => (oldEntry[field as keyof RegistryEntry] ?? "") !== (nextEntry[field as keyof RegistryEntry] ?? "")
  );
  const noRepeatWriteStatus = nextEntry.lastStatus === "no_due_payments" || nextEntry.lastStatus === "keeper_no_gas" || nextEntry.lastStatus === "insufficient_funds" || nextEntry.lastStatus === "disabled";
  const observedDue = !noRepeatWriteStatus && shouldUpdateLastObservedAt(oldEntry, checkedAt);

  if (!coreChanged && !observedDue) {
    return {
      ...nextEntry,
      lastCheckedAt: oldEntry.lastCheckedAt,
      lastExecutionAttemptAt: oldEntry.lastExecutionAttemptAt,
      lastObservedAt: oldEntry.lastObservedAt
    };
  }

  return {
    ...nextEntry,
    lastCheckedAt: coreChanged ? checkedAt : oldEntry.lastCheckedAt,
    lastExecutionAttemptAt: coreChanged ? attemptAt : oldEntry.lastExecutionAttemptAt,
    lastObservedAt: checkedAt
  };
}

async function clearRegistrySafe(env: Env): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const loaded = await loadRegistrySafe(env);
  if (!loaded.ok) return loaded;

  try {
    if (!env.REGISTRY_KV) return { ok: false, error: "REGISTRY_KV binding is missing." };
    const empty = emptyRegistryDocument();
    await saveRegistryIfChanged(env, loaded.document, empty);
    return { ok: true, count: loaded.registry.length };
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}

function classifyExecutionError(error: unknown): RegistryStatus {
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();

  if (
    message.includes("NoDuePayments") ||
    normalized.includes("no due") ||
    normalized.includes("no payments are due") ||
    normalized.includes("0xc8f7c66b")
  ) {
    return "no_due_payments";
  }
  if (
    normalized.includes("unknown selector") ||
    normalized.includes("function selector was not recognized") ||
    normalized.includes("unable to decode signature")
  ) {
    return "abi_or_old_contract_error";
  }
  if (
    normalized.includes("insufficient funds for gas") ||
    normalized.includes("insufficient funds to pay") ||
    normalized.includes("sender doesn't have enough funds") ||
    normalized.includes("does not have enough funds") ||
    normalized.includes("gas required exceeds allowance")
  ) {
    return "keeper_no_gas";
  }
  if (
    message.includes("InsufficientPayrollBalance") ||
    normalized.includes("insufficient payroll") ||
    normalized.includes("balance is too low")
  ) {
    return "insufficient_funds";
  }

  return "error";
}

function toRegistryResponse(entry: RegistryEntry) {
  return {
    contractAddress: entry.contractAddress,
    ownerAddress: entry.ownerAddress,
    payrollName: entry.payrollName,
    chainId: entry.chainId,
    registeredAt: entry.registeredAt,
    lastCheckedAt: entry.lastCheckedAt ?? "",
    lastStatus: entry.lastStatus ?? "registered",
    lastTxHash: entry.lastTxHash ?? "",
    lastError: entry.lastError ?? "",
    lastReceiptStatus: entry.lastReceiptStatus ?? "",
    lastExecutionAttemptAt: entry.lastExecutionAttemptAt ?? "",
    lastObservedAt: entry.lastObservedAt ?? "",
    appVersion: entry.appVersion ?? "",
    contractVersion: entry.contractVersion ?? "",
    createdAt: entry.createdAt ?? "",
    updatedAt: entry.updatedAt ?? "",
    failureCount: entry.failureCount ?? 0,
    disabled: Boolean(entry.disabled),
    disabledReason: entry.disabledReason ?? "",
    keeperGasStatus: entry.keeperGasStatus ?? "unknown"
  };
}

function toRunResult(entry: RegistryEntry): RunResult {
  return {
    contractAddress: entry.contractAddress,
    status: entry.lastStatus ?? "registered",
    txHash: entry.lastTxHash ?? "",
    receiptStatus: entry.lastReceiptStatus ?? "",
    error: entry.lastError ?? ""
  };
}

function resultForContract(contractAddress: `0x${string}`, status: RegistryStatus, error: string): RunResult {
  return { contractAddress, status, txHash: "", receiptStatus: "", error };
}

async function root() {
  return jsonResponse({
    ok: true,
    service: SERVICE_NAME,
    endpoints: ["/health", "/registrations", "/run-once"]
  });
}

async function health(env: Env) {
  const errors: string[] = [];
  let hasKv = false;
  let hasRpcUrl = false;
  let hasKeeperPrivateKey = false;
  let keeperPrivateKeyValid = false;
  let keeperAddress: `0x${string}` | null = null;
  let keeperBalanceRitual = "unavailable";

  try {
    hasKv = Boolean(env.REGISTRY_KV);
  } catch (error) {
    errors.push(`KV check failed: ${shortError(error)}`);
  }

  try {
    hasRpcUrl = Boolean(env.RITUAL_RPC_URL?.trim());
  } catch (error) {
    errors.push(`RPC URL check failed: ${shortError(error)}`);
  }

  try {
    hasKeeperPrivateKey = Boolean(env.KEEPER_PRIVATE_KEY?.trim());
  } catch (error) {
    errors.push(`Keeper key presence check failed: ${shortError(error)}`);
  }

  try {
    const normalized = normalizePrivateKey(env.KEEPER_PRIVATE_KEY);
    if (normalized.ok) {
      const account = privateKeyToAccount(normalized.privateKey);
      keeperPrivateKeyValid = true;
      keeperAddress = account.address;

      if (hasRpcUrl && env.RITUAL_RPC_URL) {
        try {
          const publicClient = createPublicClient({ chain: ritualChain, transport: http(env.RITUAL_RPC_URL) });
          keeperBalanceRitual = formatEther(await publicClient.getBalance({ address: account.address }));
        } catch (error) {
          errors.push(`Keeper balance check failed: ${shortError(error)}`);
        }
      }
    } else if (hasKeeperPrivateKey) {
      errors.push(normalized.error);
    }
  } catch (error) {
    errors.push(`Keeper account derivation failed: ${shortError(error)}`);
  }

  return jsonResponse({
    ok: true,
    hasKv,
    hasRpcUrl,
    hasKeeperPrivateKey,
    keeperPrivateKeyValid,
    keeperAddress,
    keeperBalanceRitual,
    workerTime: new Date().toISOString(),
    chainId: ritualChain.id,
    healthError: errors.join(" | ")
  });
}

async function registrations(env: Env) {
  const loaded = await loadRegistrySafe(env);
  if (!loaded.ok) return errorResponse(loaded.error, 500);
  return jsonResponse({ ok: true, registrations: loaded.registry.map(toRegistryResponse) });
}

async function getPaymentLogs(publicClient: ReturnType<typeof createPublicClient>, contractAddress: Address, recipients: Array<{ wallet: Address; label: string }>) {
  const latestBlock = await publicClient.getBlockNumber();
  const maxLookback = 750_000n;
  const chunkSize = 25_000n;
  const fromBlock = latestBlock > maxLookback ? latestBlock - maxLookback : 0n;
  const logs: Array<{
    recipientId: number;
    wallet: Address;
    label: string;
    amount: string;
    timestamp: number;
    txHash: Hash;
  }> = [];

  for (let start = fromBlock; start <= latestBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > latestBlock ? latestBlock : start + chunkSize;
    const chunk = await publicClient.getLogs({
      address: contractAddress,
      event: paymentExecutedEvent,
      fromBlock: start,
      toBlock: end
    });

    for (const [index, log] of chunk.entries()) {
      const recipientId = Number(log.args.recipientId ?? BigInt(index));
      logs.push({
        recipientId,
        wallet: (log.args.wallet ?? recipients[recipientId]?.wallet ?? "0x0000000000000000000000000000000000000000") as Address,
        label: recipients[recipientId]?.label ?? `Recipient ${recipientId}`,
        amount: formatEther(log.args.amount ?? 0n),
        timestamp: Number(log.args.timestamp ?? 0n),
        txHash: log.transactionHash
      });
    }
  }

  return logs;
}

async function contractState(url: URL, env: Env) {
  const contractAddress = url.searchParams.get("contractAddress")?.trim();
  if (!contractAddress || !isAddress(contractAddress)) {
    return errorResponse("contractAddress query parameter must be a valid 0x address.");
  }
  if (!env.RITUAL_RPC_URL?.trim()) {
    return errorResponse("RITUAL_RPC_URL secret is missing.", 500);
  }

  try {
    const publicClient = createPublicClient({ chain: ritualChain, transport: http(env.RITUAL_RPC_URL) });
    const address = normalizeAddress(contractAddress);
    const [accounting, rawRecipients, rawHistory] = await Promise.all([
      publicClient.readContract({
        address,
        abi: readAbi,
        functionName: "getAccounting"
      }),
      publicClient.readContract({
        address,
        abi: readAbi,
        functionName: "getRecipients"
      }),
      publicClient.readContract({
        address,
        abi: readAbi,
        functionName: "getPaymentHistory"
      }).catch(() => [])
    ]);

    const recipients = rawRecipients.map((recipient, index) => ({
      id: index,
      wallet: recipient.wallet,
      label: recipient.label,
      amount: formatEther(recipient.amount),
      frequency: Number(recipient.frequency),
      nextPaymentTime: Number(recipient.nextPaymentTime),
      active: Boolean(recipient.active),
      paidCount: Number(recipient.paidCount),
      removed: Boolean(recipient.removed)
    }));

    let eventLogs: Awaited<ReturnType<typeof getPaymentLogs>> = [];
    try {
      eventLogs = await getPaymentLogs(publicClient, address, recipients);
    } catch (error) {
      console.log("payment event log sync failed", { contractAddress: address, error: shortError(error) });
    }

    const paymentHistory = rawHistory.map((item, index) => {
      const amount = formatEther(item.amount);
      const timestamp = Number(item.timestamp);
      const eventMatch = eventLogs.find(
        (log) =>
          log.recipientId === Number(item.recipientId) &&
          registryKey(log.wallet) === registryKey(item.wallet) &&
          log.amount === amount &&
          log.timestamp === timestamp
      );

      return {
        id: `${Number(item.recipientId)}-${timestamp}-${index}`,
        recipientId: Number(item.recipientId),
        wallet: item.wallet,
        label: item.label,
        amount,
        timestamp,
        txHash: eventMatch?.txHash ?? ""
      };
    });

    const historyKeys = new Set(paymentHistory.map((item) => `${item.recipientId}-${registryKey(item.wallet)}-${item.amount}-${item.timestamp}`));
    const eventOnlyHistory = eventLogs
      .filter((log) => !historyKeys.has(`${log.recipientId}-${registryKey(log.wallet)}-${log.amount}-${log.timestamp}`))
      .map((log, index) => ({
        id: `${log.txHash}-${index}`,
        recipientId: log.recipientId,
        wallet: log.wallet,
        label: log.label,
        amount: log.amount,
        timestamp: log.timestamp,
        txHash: log.txHash
      }));

    return jsonResponse({
      ok: true,
      contractAddress: address,
      accounting: {
        payrollReserved: formatEther(accounting[0]),
        keeperFeeReserved: formatEther(accounting[1]),
        keeperRewardAmount: formatEther(accounting[2]),
        contractBalance: formatEther(accounting[3])
      },
      recipients,
      paymentHistory: [...paymentHistory, ...eventOnlyHistory].sort((a, b) => b.timestamp - a.timestamp)
    });
  } catch (error) {
    return errorResponse(shortError(error), 500);
  }
}

async function clearRegistrationsDev(env: Env) {
  if (env.ALLOW_DEV_CLEAR !== "true") {
    return jsonResponse({ ok: false, error: "Dev clear disabled" }, 403);
  }
  const cleared = await clearRegistrySafe(env);
  if (!cleared.ok) return errorResponse(cleared.error, 500);
  return jsonResponse({ ok: true, cleared: true, count: cleared.count });
}

async function migrateOldKvDev(env: Env) {
  if (env.ALLOW_DEV_CLEAR !== "true") {
    return jsonResponse({ ok: false, error: "Dev migration disabled" }, 403);
  }
  if (!env.REGISTRY_KV) return errorResponse("REGISTRY_KV binding is missing.", 500);

  const loaded = await loadRegistrySafe(env);
  if (!loaded.ok) return errorResponse(loaded.error, 500);

  try {
    const legacyRaw = await env.REGISTRY_KV.get(LEGACY_REGISTRY_KEY);
    if (!legacyRaw) {
      return jsonResponse({ ok: true, migrated: false, count: loaded.registry.length, message: "No legacy registry key found." });
    }

    const legacyDocument = normalizeRegistryDocument(JSON.parse(legacyRaw));
    const merged = documentFromEntries([...loaded.registry, ...registryEntries(legacyDocument)]);
    const saved = await saveRegistryIfChanged(env, loaded.document, merged);
    if (!saved.ok) return errorResponse(saved.error, 500);
    return jsonResponse({ ok: true, migrated: saved.written, count: registryEntries(merged).length });
  } catch (error) {
    return errorResponse(shortError(error), 500);
  }
}

async function unregister(url: URL, env: Env) {
  const contractAddress = url.searchParams.get("contractAddress")?.trim();
  if (!contractAddress || !isAddress(contractAddress)) {
    return errorResponse("contractAddress query parameter must be a valid 0x address.");
  }

  const loaded = await loadRegistrySafe(env);
  if (!loaded.ok) return errorResponse(loaded.error, 500);

  const key = registryKey(contractAddress);
  const nextDocument = normalizeRegistryDocument(loaded.document);
  delete nextDocument.registrations[key];
  const saved = await saveRegistryIfChanged(env, loaded.document, nextDocument);
  if (!saved.ok) return errorResponse(saved.error, 500);

  return jsonResponse({
    ok: true,
    removed: Boolean(loaded.document.registrations[key]),
    contractAddress: normalizeAddress(contractAddress)
  });
}

async function unregisterPost(request: Request, env: Env) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json<Record<string, unknown>>();
  } catch {
    return errorResponse("Request body must be valid JSON.");
  }

  const contractAddress = payload.contractAddress;
  const ownerAddress = payload.ownerAddress;
  const chainId = payload.chainId;

  if (chainId !== ritualChain.id) return errorResponse("chainId must be 1979.");
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    return errorResponse("contractAddress must be a valid 0x address.");
  }
  if (typeof ownerAddress !== "string" || !isAddress(ownerAddress)) {
    return errorResponse("ownerAddress must be a valid 0x address.");
  }

  const loaded = await loadRegistrySafe(env);
  if (!loaded.ok) return errorResponse(loaded.error, 500);

  const existing = loaded.registry.find((entry) => registryKey(entry.contractAddress) === registryKey(contractAddress));
  if (existing && registryKey(existing.ownerAddress) !== registryKey(ownerAddress)) {
    return errorResponse("ownerAddress does not match stored registration owner.", 403);
  }

  const key = registryKey(contractAddress);
  const nextDocument = normalizeRegistryDocument(loaded.document);
  delete nextDocument.registrations[key];
  const saved = await saveRegistryIfChanged(env, loaded.document, nextDocument);
  if (!saved.ok) return errorResponse(saved.error, 500);

  return jsonResponse({
    ok: true,
    removed: Boolean(loaded.document.registrations[key]),
    contractAddress: normalizeAddress(contractAddress)
  });
}

async function register(request: Request, env: Env) {
  console.log("register received");

  let payload: Record<string, unknown>;
  try {
    payload = await request.json<Record<string, unknown>>();
  } catch {
    return errorResponse("Request body must be valid JSON.");
  }

  const contractAddress = payload.contractAddress;
  const ownerAddress = payload.ownerAddress;
  const payrollName = typeof payload.payrollName === "string" && payload.payrollName.trim() ? payload.payrollName.trim() : "Payroll";
  const chainId = payload.chainId;
  const appVersion = typeof payload.appVersion === "string" ? payload.appVersion : "";
  const contractVersion = typeof payload.contractVersion === "string" ? payload.contractVersion : "";
  const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString();
  const updatedAt = new Date().toISOString();

  if (chainId !== ritualChain.id) return errorResponse("chainId must be 1979.");
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    return errorResponse("contractAddress must be a valid 0x address.");
  }
  if (typeof ownerAddress !== "string" || !isAddress(ownerAddress)) {
    return errorResponse("ownerAddress must be a valid 0x address.");
  }

  const loaded = await loadRegistrySafe(env);
  if (!loaded.ok) return errorResponse(loaded.error, 500);

  const existing = loaded.registry.find((item) => registryKey(item.contractAddress) === registryKey(contractAddress));
  const entry: RegistryEntry = {
    ...existing,
    contractAddress: normalizeAddress(contractAddress),
    ownerAddress: normalizeAddress(ownerAddress),
    payrollName,
    chainId: ritualChain.id,
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
    lastStatus: existing?.lastStatus ?? "registered",
    appVersion,
    contractVersion,
    createdAt: existing?.createdAt ?? createdAt,
    updatedAt,
    failureCount: 0,
    disabled: false,
    disabledReason: ""
  };

  const nextDocument = normalizeRegistryDocument(loaded.document);
  nextDocument.registrations[registryKey(contractAddress)] = entry;
  const saved = await saveRegistryIfChanged(env, loaded.document, nextDocument);
  if (!saved.ok) return errorResponse(saved.error, 500);

  return jsonResponse({
    ok: true,
    registered: true,
    contractAddress: entry.contractAddress,
    ownerAddress: entry.ownerAddress,
    payrollName: entry.payrollName,
    chainId: entry.chainId,
    appVersion: entry.appVersion,
    contractVersion: entry.contractVersion,
    registeredAt: entry.registeredAt,
    updatedAt: entry.updatedAt
  });
}

async function runAutomation(env: Env, source: "cron" | "run-once") {
  console.log(`${source} started`);
  const checkedAt = new Date().toISOString();
  const loaded = await loadRegistrySafe(env);
  if (!loaded.ok) return { ok: false as const, error: loaded.error, results: [] as RunResult[] };
  if (loaded.registry.length === 0) return { ok: true as const, results: [] as RunResult[] };

  if (!env.RITUAL_RPC_URL?.trim()) {
    return { ok: false as const, error: "RITUAL_RPC_URL secret is missing.", results: [] as RunResult[] };
  }

  const normalizedPrivateKey = normalizePrivateKey(env.KEEPER_PRIVATE_KEY);
  if (!normalizedPrivateKey.ok) {
    return { ok: false as const, error: normalizedPrivateKey.error, results: [] as RunResult[] };
  }

  let publicClient: ReturnType<typeof createPublicClient>;
  let walletClient: ReturnType<typeof createWalletClient>;
  let account: ReturnType<typeof privateKeyToAccount>;

  try {
    account = privateKeyToAccount(normalizedPrivateKey.privateKey);
  } catch (error) {
    return { ok: false as const, error: `Keeper account derivation failed: ${shortError(error)}`, results: [] as RunResult[] };
  }

  try {
    const transport = http(env.RITUAL_RPC_URL);
    publicClient = createPublicClient({ chain: ritualChain, transport });
    walletClient = createWalletClient({ account, chain: ritualChain, transport });
  } catch (error) {
    const message = `Client creation failed: ${shortError(error)}`;
    const results = loaded.registry.map((entry) => resultForContract(entry.contractAddress, "error", message));
    return { ok: true as const, results };
  }

  const updated: RegistryEntry[] = [];
  const results: RunResult[] = [];

  for (const entry of loaded.registry) {
    console.log("contract checked", { contractAddress: entry.contractAddress });
    const attemptAt = new Date().toISOString();
    const base = { ...entry };

    if (entry.disabled) {
      updated.push(entry);
      results.push(toRunResult(entry));
      continue;
    }

    if (!isAddress(entry.contractAddress)) {
      const next = withStorageTiming(entry, {
        ...base,
        lastStatus: "invalid_contract",
        lastTxHash: "",
        lastReceiptStatus: "",
        lastError: "Registered contractAddress is invalid."
      }, checkedAt, attemptAt);
      updated.push(next);
      results.push(toRunResult(next));
      continue;
    }

    try {
      const hash = await walletClient.writeContract({
        address: entry.contractAddress,
        abi: executeAbi,
        functionName: "executeDuePayments",
        account,
        chain: ritualChain
      });
      console.log("tx submitted", { contractAddress: entry.contractAddress, txHash: hash });

      let receipt: TransactionReceipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash });
      } catch (error) {
        const next = withStorageTiming(entry, {
          ...base,
          lastStatus: "error",
          lastTxHash: hash,
          lastReceiptStatus: "",
          lastError: `Receipt wait failed: ${shortError(error)}`,
          failureCount: (entry.failureCount ?? 0) + 1
        }, checkedAt, attemptAt);
        updated.push(next);
        results.push(toRunResult(next));
        continue;
      }

      console.log("tx confirmed", { contractAddress: entry.contractAddress, txHash: hash, receiptStatus: receipt.status });
      const receiptFailed = receipt.status !== "success";
      const failureCount = receiptFailed ? (entry.failureCount ?? 0) + 1 : 0;
      const shouldDisable = receiptFailed && failureCount >= 3;
      const next = withStorageTiming(entry, {
        ...base,
        lastStatus: receipt.status === "success" ? "executed" : "error",
        lastTxHash: hash,
        lastReceiptStatus: receipt.status,
        lastError: receipt.status === "success" ? "" : `Receipt status: ${receipt.status}`,
        failureCount,
        disabled: shouldDisable ? true : false,
        disabledReason: shouldDisable ? "Repeated execution errors" : "",
        keeperGasStatus: "ok"
      }, checkedAt, attemptAt);
      updated.push(next);
      results.push(toRunResult(next));
    } catch (error) {
      const status = classifyExecutionError(error);
      const shouldCountFailure = status === "abi_or_old_contract_error" || status === "error";
      const failureCount = shouldCountFailure ? (entry.failureCount ?? 0) + 1 : (entry.failureCount ?? 0);
      const shouldDisable = shouldCountFailure && failureCount >= 3;
      const next = withStorageTiming(entry, {
        ...base,
        lastStatus: shouldDisable ? "disabled" : status,
        lastTxHash: "",
        lastReceiptStatus: "",
        lastError: shortError(error),
        failureCount,
        disabled: shouldDisable ? true : entry.disabled,
        disabledReason: shouldDisable ? "Repeated execution errors" : entry.disabledReason,
        keeperGasStatus: status === "keeper_no_gas" ? "low" : entry.keeperGasStatus
      }, checkedAt, attemptAt);
      console.log("error", { contractAddress: entry.contractAddress, status, error: next.lastError });
      updated.push(next);
      results.push(toRunResult(next));
    }
  }

  const saved = await saveRegistryIfChanged(env, loaded.document, documentFromEntries(updated, loaded.document.updatedAt));
  if (!saved.ok) {
    return { ok: false as const, error: saved.error, results };
  }

  console.log(`${source} finished`, { checked: loaded.registry.length, kvWritten: saved.written });
  return { ok: true as const, results, kvWritten: saved.written };
}

async function runOnce(env: Env) {
  try {
    const result = await runAutomation(env, "run-once");
    return jsonResponse(result, result.ok ? 200 : 500);
  } catch (error) {
    return jsonResponse({ ok: false, error: shortError(error) }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    console.log("worker request path", { method: request.method, path: url.pathname });

    try {
      if (request.method === "OPTIONS") return optionsResponse();
      if (request.method === "GET" && url.pathname === "/") return root();
      if (request.method === "GET" && url.pathname === "/health") return health(env);
      if (request.method === "GET" && url.pathname === "/registrations") return registrations(env);
      if (request.method === "GET" && url.pathname === "/contract-state") return contractState(url, env);
      if (request.method === "GET" && url.pathname === "/clear-registrations-dev") return clearRegistrationsDev(env);
      if (request.method === "GET" && url.pathname === "/migrate-old-kv-dev") return migrateOldKvDev(env);
      if (request.method === "GET" && url.pathname === "/unregister") return unregister(url, env);
      if (request.method === "GET" && url.pathname === "/run-once") return runOnce(env);
      if (request.method === "POST" && url.pathname === "/register") return register(request, env);
      if (request.method === "POST" && url.pathname === "/unregister") return unregisterPost(request, env);
      return errorResponse("Not found.", 404, url.pathname);
    } catch (error) {
      console.log("error", { path: url.pathname, error: shortError(error) });
      return errorResponse(shortError(error), 500, url.pathname);
    }
  },

  async scheduled(_event: unknown, env: Env) {
    try {
      const result = await runAutomation(env, "cron");
      if (!result.ok) console.log("cron error", { error: result.error });
    } catch (error) {
      console.log("cron unexpected error", { error: shortError(error) });
    }
  }
};
