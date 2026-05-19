"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, formatEther, http, isAddress, parseAbiItem, parseEther, type Abi, type Address, type Hash } from "viem";
import { useAccount, useChainId, usePublicClient } from "wagmi";
import { Header } from "@/components/Header";
import { explorerAddressUrl, explorerTxUrl, ritualChain } from "@/lib/chain";
import payrollArtifact from "@/lib/PayrollScheduler.json";
import { PAYROLL_STORAGE_KEY, frequencyLabels, payrollSchedulerAbi, payrollSchedulerBytecode, type Frequency } from "@/lib/contracts";
import { shortAddress } from "@/lib/format";
import { browserEthereumProvider, knownChainName, readProviderChainId, switchOrAddRitualChain } from "@/lib/walletChain";

const AUTOMATION_API_URL = process.env.NEXT_PUBLIC_AUTOMATION_API_URL?.replace(/\/$/, "") ?? "";
const payrollReadAbi = payrollArtifact.abi as Abi;
const ritualReadClient = createPublicClient({ chain: ritualChain, transport: http("https://rpc.ritualfoundation.org") });
const paymentExecutedEvent = parseAbiItem("event PaymentExecuted(uint256 indexed recipientId, address indexed wallet, uint256 amount, uint256 timestamp)");

const PAYROLL_NAME_KEY = "ritual-payroll-scheduler-payroll-name";
const RECIPIENTS_KEY = "ritual-payroll-scheduler-local-recipients";
const HISTORY_KEY = "ritual-payroll-scheduler-local-payment-history";
const PAYROLL_BALANCE_KEY = "ritual-payroll-scheduler-local-funded-balance";
const KEEPER_BALANCE_KEY = "ritual-payroll-scheduler-local-keeper-fee-balance";
const KEEPER_REWARD_KEY = "ritual-payroll-scheduler-keeper-reward-amount";
const AUTOMATION_FLAG_KEY = "ritual-payroll-scheduler-automation-enabled";

const ONE_DAY = 24 * 60 * 60;

type ScheduleType = "one-time" | "daily" | "weekly" | "monthly" | "custom";

type LocalRecipient = {
  id: string;
  contractAddress: string;
  label: string;
  wallet: Address;
  amount: string;
  frequency: Frequency;
  scheduleType: ScheduleType;
  nextPaymentTime: number;
  active: boolean;
  paidCount: number;
  addTxHash: string;
};

type LocalPayment = {
  id: string;
  contractAddress: string;
  recipientLabel: string;
  wallet: Address;
  amount: string;
  timestamp: number;
  txHash: string;
  source?: "wallet" | "backend" | "contract";
};

type TxState = {
  kind: "idle" | "pending" | "success" | "error";
  title: string;
  message: string;
  txHash?: string;
};

type BackendRegistration = {
  contractAddress: string;
  ownerAddress?: string;
  payrollName?: string;
  chainId?: number;
  disabled?: boolean;
  disabledReason?: string;
  failureCount?: number;
  lastObservedAt?: string;
  lastCheckedAt?: string;
  lastStatus?: string;
  lastTxHash?: string;
  lastError?: string;
  lastReceiptStatus?: string;
  lastExecutionAttemptAt?: string;
};

type BackendStatus = {
  connected: boolean;
  loading: boolean;
  registration?: BackendRegistration;
  error: string;
  keeperGas: "OK" | "Low" | "Unknown";
};

type ContractStateResponse = {
  ok: boolean;
  accounting?: {
    payrollReserved: string;
    keeperFeeReserved: string;
    keeperRewardAmount: string;
    contractBalance: string;
  };
  recipients?: Array<{
    id: number;
    wallet: Address;
    label: string;
    amount: string;
    frequency: number;
    nextPaymentTime: number;
    active: boolean;
    paidCount: number;
    removed: boolean;
  }>;
  paymentHistory?: Array<{
    id: string;
    recipientId: number;
    wallet: Address;
    label: string;
    amount: string;
    timestamp: number;
    txHash: string;
  }>;
  error?: string;
};

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function readText(key: string, fallback = "") {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

function normalizeStoredAmount(value: string | null | undefined) {
  const raw = (value ?? "0").trim();
  if (!raw) return "0";

  try {
    if (/^\d+$/.test(raw) && raw.length > 12) {
      return formatEther(BigInt(raw));
    }
    const parsed = parseEther(raw);
    return formatEther(parsed);
  } catch {
    return "0";
  }
}

function displayAmount(value: string) {
  const normalized = normalizeStoredAmount(value);
  const [whole, fraction = ""] = normalized.split(".");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function addAmount(a: string, b: string) {
  return formatEther(parseEther(normalizeStoredAmount(a)) + parseEther(normalizeStoredAmount(b)));
}

function subtractAmount(a: string, b: string) {
  const next = parseEther(normalizeStoredAmount(a)) - parseEther(normalizeStoredAmount(b));
  return formatEther(next > 0n ? next : 0n);
}

function parsePositiveAmount(value: string, label: string): { ok: true; value: bigint } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: `${label} is required.` };
  try {
    const parsed = parseEther(trimmed);
    if (parsed <= 0n) return { ok: false, message: `${label} must be greater than zero.` };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, message: `${label} must be a valid RITUAL amount.` };
  }
}

function localDateTimeValue(minutesFromNow = 5) {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function timestampFromInput(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.floor(time / 1000) : 0;
}

function formatTime(seconds?: number | string) {
  if (!seconds) return "Not available";
  const date = typeof seconds === "string" ? new Date(seconds) : new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function nextTimeAfterPayment(recipient: LocalRecipient) {
  if (recipient.scheduleType === "daily") return recipient.nextPaymentTime + ONE_DAY;
  if (recipient.scheduleType === "weekly") return recipient.nextPaymentTime + ONE_DAY * 7;
  if (recipient.scheduleType === "monthly") return recipient.nextPaymentTime + ONE_DAY * 30;
  return recipient.nextPaymentTime;
}

function statusText(status?: string) {
  if (!status) return "No worker check yet";
  if (status === "registered") return "Registered";
  if (status === "executed") return "Last automated execution succeeded";
  if (status === "no_due_payments") return "No due payments at last check";
  if (status === "insufficient_funds") return "Payroll needs funding";
  if (status === "keeper_no_gas") return "Keeper needs gas";
  if (status === "disabled") return "Automation disabled";
  return status.replaceAll("_", " ");
}

function backendMessage(registration?: BackendRegistration) {
  if (!registration) return "This contract is not registered for automation.";
  if (registration.disabled) return registration.disabledReason || "Automation disabled for this contract.";
  if (registration.lastStatus === "no_due_payments") return "Backend check: no payments were due on-chain at the last check.";
  if (registration.lastStatus === "insufficient_funds") return "Backend check: payroll needs more funds before due payments can execute.";
  if (registration.lastStatus === "executed") return "Backend check: payments were executed successfully.";
  if (registration.lastError) return registration.lastError;
  return "Automation is registered for this contract.";
}

function shouldShowBackendError(registration?: BackendRegistration) {
  return Boolean(
    registration?.lastError &&
      registration.lastStatus !== "no_due_payments" &&
      registration.lastStatus !== "registered" &&
      registration.lastStatus !== "executed"
  );
}

function sameAddress(a?: string, b?: string) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function scheduleTypeFromFrequency(frequency: number): ScheduleType {
  if (frequency === 1) return "daily";
  if (frequency === 2) return "weekly";
  if (frequency === 3) return "monthly";
  return "custom";
}

async function fetchPaymentExecutedLogs(
  readClient: typeof ritualReadClient | ReturnType<typeof usePublicClient>,
  targetAddress: Address,
  chainRecipients: Array<{ wallet: Address; label: string; amount: bigint }>
) {
  if (!readClient) return [];
  const latestBlock = await readClient.getBlockNumber();
  const maxLookback = 750_000n;
  const chunkSize = 25_000n;
  const fromBlock = latestBlock > maxLookback ? latestBlock - maxLookback : 0n;
  const payments: LocalPayment[] = [];

  for (let start = fromBlock; start <= latestBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > latestBlock ? latestBlock : start + chunkSize;
    const logs = await readClient.getLogs({
      address: targetAddress,
      event: paymentExecutedEvent,
      fromBlock: start,
      toBlock: end
    });

    logs.forEach((log, index) => {
      const recipientId = Number(log.args.recipientId ?? 0n);
      const recipient = chainRecipients[recipientId];
      payments.push({
        id: `${log.transactionHash}-${index}`,
        contractAddress: targetAddress.toLowerCase(),
        recipientLabel: recipient?.label ?? `Recipient ${recipientId}`,
        wallet: (log.args.wallet ?? recipient?.wallet ?? "0x0000000000000000000000000000000000000000") as Address,
        amount: formatEther(log.args.amount ?? 0n),
        timestamp: Number(log.args.timestamp ?? 0n),
        txHash: log.transactionHash,
        source: "contract"
      });
    });
  }

  return payments;
}

export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [providerChainId, setProviderChainId] = useState<number>();
  const [contractAddress, setContractAddress] = useState("");
  const [payrollName, setPayrollName] = useState("Ritual Contributor Payroll");
  const [existingAddress, setExistingAddress] = useState("");
  const [recipients, setRecipients] = useState<LocalRecipient[]>([]);
  const [paymentHistory, setPaymentHistory] = useState<LocalPayment[]>([]);
  const [payrollBalance, setPayrollBalance] = useState("0");
  const [keeperBalance, setKeeperBalance] = useState("0");
  const [accountingSource, setAccountingSource] = useState<"Browser view" | "On-chain">("Browser view");
  const [keeperReward, setKeeperReward] = useState("0.01");
  const [txState, setTxState] = useState<TxState>({ kind: "idle", title: "", message: "" });
  const [backend, setBackend] = useState<BackendStatus>({ connected: Boolean(AUTOMATION_API_URL), loading: false, error: "", keeperGas: "Unknown" });

  const [recipientLabel, setRecipientLabel] = useState("");
  const [recipientWallet, setRecipientWallet] = useState("");
  const [recipientAmount, setRecipientAmount] = useState("0.01");
  const [scheduleType, setScheduleType] = useState<ScheduleType>("custom");
  const [startTime, setStartTime] = useState("");
  const [customTimes, setCustomTimes] = useState<string[]>([]);
  const [fundAmount, setFundAmount] = useState("0.05");
  const [keeperFundAmount, setKeeperFundAmount] = useState("0.02");

  const { address, isConnected } = useAccount();
  const wagmiChainId = useChainId();
  const publicClient = usePublicClient({ chainId: ritualChain.id });

  const currentChainId = providerChainId ?? wagmiChainId;
  const isRitual = currentChainId === ritualChain.id;
  const normalizedContract = contractAddress.toLowerCase();

  const visibleRecipients = useMemo(
    () => recipients.filter((recipient) => sameAddress(recipient.contractAddress, normalizedContract)),
    [recipients, normalizedContract]
  );

  const activeRecipients = useMemo(
    () => visibleRecipients.filter((recipient) => recipient.active),
    [visibleRecipients]
  );

  const visibleHistory = useMemo(() => {
    return paymentHistory.filter((item) => sameAddress(item.contractAddress, normalizedContract));
  }, [paymentHistory, normalizedContract]);

  const nowSeconds = mounted ? Math.floor(Date.now() / 1000) : 0;
  const dueRecipients = visibleRecipients.filter((recipient) => recipient.active && recipient.nextPaymentTime <= nowSeconds);
  const nextPayment = visibleRecipients.filter((recipient) => recipient.active).sort((a, b) => a.nextPaymentTime - b.nextPaymentTime)[0];

  const deployed = isAddress(contractAddress);
  const contractRegistered = Boolean(backend.registration && !backend.registration.disabled);
  const automationStatus = !AUTOMATION_API_URL
    ? "Backend not configured"
    : backend.registration?.disabled
      ? "Disabled"
      : contractRegistered
        ? "Contract registered"
        : "Contract not registered";

  useEffect(() => {
    setMounted(true);
    setStartTime(localDateTimeValue(5));
    setCustomTimes([localDateTimeValue(5), localDateTimeValue(7)]);
    readProviderChainId().then(setProviderChainId).catch(() => setProviderChainId(undefined));
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const savedAddress = readText(PAYROLL_STORAGE_KEY);
    const savedName = readText(PAYROLL_NAME_KEY, "Ritual Contributor Payroll");
    const normalizedPayrollBalance = normalizeStoredAmount(readText(PAYROLL_BALANCE_KEY, "0"));
    const normalizedKeeperBalance = normalizeStoredAmount(readText(KEEPER_BALANCE_KEY, "0"));
    setContractAddress(savedAddress);
    setPayrollName(savedName);
    setRecipients([]);
    setPaymentHistory([]);
    setPayrollBalance(normalizedPayrollBalance);
    setKeeperBalance(normalizedKeeperBalance);
    writeJson(RECIPIENTS_KEY, []);
    writeJson(HISTORY_KEY, []);
    window.localStorage.setItem(PAYROLL_BALANCE_KEY, normalizedPayrollBalance);
    window.localStorage.setItem(KEEPER_BALANCE_KEY, normalizedKeeperBalance);
    const normalizedKeeperReward = normalizeStoredAmount(readText(KEEPER_REWARD_KEY, "0.01"));
    setKeeperReward(normalizedKeeperReward === "0" ? "0.01" : normalizedKeeperReward);
    window.localStorage.setItem(KEEPER_REWARD_KEY, normalizedKeeperReward === "0" ? "0.01" : normalizedKeeperReward);
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !isAddress(contractAddress)) return;

    async function syncAccountingOnly() {
      try {
        const accounting = await ritualReadClient.readContract({
          address: contractAddress as Address,
          abi: payrollReadAbi,
          functionName: "getAccounting"
        }) as [bigint, bigint, bigint, bigint];
        const onChainPayroll = formatEther(accounting[0]);
        const onChainKeeper = formatEther(accounting[1]);
        const onChainReward = formatEther(accounting[2]);
        setPayrollBalance(onChainPayroll);
        setKeeperBalance(onChainKeeper);
        setKeeperReward(onChainReward === "0" ? "0.01" : onChainReward);
        setAccountingSource("On-chain");
        window.localStorage.setItem(PAYROLL_BALANCE_KEY, onChainPayroll);
        window.localStorage.setItem(KEEPER_BALANCE_KEY, onChainKeeper);
        window.localStorage.setItem(KEEPER_REWARD_KEY, onChainReward === "0" ? "0.01" : onChainReward);
      } catch (error) {
        setAccountingSource("Browser view");
        console.warn("[Ritual Payroll] Initial accounting sync skipped", error);
      }
    }

    syncAccountingOnly();
  }, [mounted, contractAddress]);

  const persistRecipients = useCallback((next: LocalRecipient[]) => {
    setRecipients(next);
    writeJson(RECIPIENTS_KEY, next);
  }, []);

  const persistHistory = useCallback((next: LocalPayment[]) => {
    setPaymentHistory(next);
    writeJson(HISTORY_KEY, next);
  }, []);

  const applyContractState = useCallback(
    (state: ContractStateResponse) => {
      if (!state.ok) throw new Error(state.error || "Contract state request failed.");

      if (state.accounting) {
        const payroll = normalizeStoredAmount(state.accounting.payrollReserved);
        const keeper = normalizeStoredAmount(state.accounting.keeperFeeReserved);
        const reward = normalizeStoredAmount(state.accounting.keeperRewardAmount);
        setPayrollBalance(payroll);
        setKeeperBalance(keeper);
        setKeeperReward(reward === "0" ? "0.01" : reward);
        setAccountingSource("On-chain");
        window.localStorage.setItem(PAYROLL_BALANCE_KEY, payroll);
        window.localStorage.setItem(KEEPER_BALANCE_KEY, keeper);
        window.localStorage.setItem(KEEPER_REWARD_KEY, reward === "0" ? "0.01" : reward);
      }

      if (state.recipients) {
        const otherRecipients = recipients.filter((recipient) => !sameAddress(recipient.contractAddress, normalizedContract));
        const nextRecipients = state.recipients
          .filter((recipient) => !recipient.removed)
          .map((recipient) => {
            const existing = recipients.find(
              (item) =>
                sameAddress(item.contractAddress, normalizedContract) &&
                sameAddress(item.wallet, recipient.wallet) &&
                item.label === recipient.label &&
                normalizeStoredAmount(item.amount) === normalizeStoredAmount(recipient.amount) &&
                item.nextPaymentTime === recipient.nextPaymentTime
            );
            const frequency = Number(recipient.frequency) as Frequency;
            return {
              id: existing?.id ?? `${normalizedContract}-backend-${recipient.id}`,
              contractAddress: normalizedContract,
              label: recipient.label,
              wallet: recipient.wallet,
              amount: normalizeStoredAmount(recipient.amount),
              frequency,
              scheduleType: existing?.scheduleType ?? scheduleTypeFromFrequency(frequency),
              nextPaymentTime: recipient.nextPaymentTime,
              active: Boolean(recipient.active),
              paidCount: Number(recipient.paidCount),
              addTxHash: existing?.addTxHash ?? ""
            } satisfies LocalRecipient;
          });
        persistRecipients([...otherRecipients, ...nextRecipients]);
      }

      if (state.paymentHistory) {
        const otherPayments = paymentHistory.filter((item) => !sameAddress(item.contractAddress, normalizedContract));
        const nextPayments = state.paymentHistory
          .map((item) => ({
            id: item.id || `${normalizedContract}-backend-history-${item.recipientId}-${item.timestamp}`,
            contractAddress: normalizedContract,
            recipientLabel: item.label,
            wallet: item.wallet,
            amount: normalizeStoredAmount(item.amount),
            timestamp: item.timestamp,
            txHash: item.txHash,
            source: "backend" as const
          }));
        persistHistory([...nextPayments, ...otherPayments]);
      }
    },
    [normalizedContract, paymentHistory, persistHistory, persistRecipients, recipients]
  );

  const syncContractState = useCallback(async () => {
    if (!isAddress(contractAddress)) return;
    const readClient = publicClient ?? ritualReadClient;

    try {
      const accounting = await readClient.readContract({
        address: contractAddress as Address,
        abi: payrollReadAbi,
        functionName: "getAccounting"
      }) as [bigint, bigint, bigint, bigint];
      const onChainPayroll = formatEther(accounting[0]);
      const onChainKeeper = formatEther(accounting[1]);
      const onChainReward = formatEther(accounting[2]);
      setPayrollBalance(onChainPayroll);
      setKeeperBalance(onChainKeeper);
      setKeeperReward(onChainReward === "0" ? keeperReward : onChainReward);
      setAccountingSource("On-chain");
      window.localStorage.setItem(PAYROLL_BALANCE_KEY, onChainPayroll);
      window.localStorage.setItem(KEEPER_BALANCE_KEY, onChainKeeper);
      window.localStorage.setItem(KEEPER_REWARD_KEY, onChainReward === "0" ? keeperReward : onChainReward);
    } catch (accountingError) {
      setAccountingSource("Browser view");
      console.warn("[Ritual Payroll] Accounting sync skipped", accountingError);
    }

    try {
      const chainRecipients = await readClient.readContract({
        address: contractAddress as Address,
        abi: payrollReadAbi,
        functionName: "getRecipients"
      }) as Array<{
        wallet: Address;
        label: string;
        amount: bigint;
        frequency: number;
        nextPaymentTime: bigint;
        active: boolean;
        paidCount: bigint;
        removed: boolean;
      }>;

      let chainHistory: Array<{
        recipientId: bigint;
        wallet: Address;
        label: string;
        amount: bigint;
        timestamp: bigint;
      }> = [];

      try {
        chainHistory = await readClient.readContract({
          address: contractAddress as Address,
          abi: payrollReadAbi,
          functionName: "getPaymentHistory"
        }) as typeof chainHistory;
      } catch (historyError) {
        console.warn("[Ritual Payroll] Payment history sync skipped", historyError);
      }

      let paymentLogs: LocalPayment[] = [];
      try {
        paymentLogs = await fetchPaymentExecutedLogs(readClient, contractAddress as Address, chainRecipients);
      } catch (logsError) {
        console.warn("[Ritual Payroll] Payment event log sync skipped", logsError);
      }

      const nextFromContract = chainRecipients
        .filter((recipient) => !recipient.removed)
        .map((recipient, index) => {
          const amount = formatEther(recipient.amount);
          const nextPaymentTime = Number(recipient.nextPaymentTime);
          const existing = recipients.find(
            (item) =>
              sameAddress(item.contractAddress, normalizedContract) &&
              sameAddress(item.wallet, recipient.wallet) &&
              item.label === recipient.label &&
              item.amount === amount &&
              item.nextPaymentTime === nextPaymentTime
          );
          const frequency = Number(recipient.frequency) as Frequency;
          const scheduleType: ScheduleType = existing?.scheduleType ?? (frequency === 1 ? "daily" : frequency === 2 ? "weekly" : frequency === 3 ? "monthly" : "custom");
          return {
            id: existing?.id ?? `${normalizedContract}-chain-${index}`,
            contractAddress: normalizedContract,
            label: recipient.label,
            wallet: recipient.wallet,
            amount,
            frequency,
            scheduleType,
            nextPaymentTime,
            active: Boolean(recipient.active),
            paidCount: Number(recipient.paidCount),
            addTxHash: existing?.addTxHash ?? ""
          };
        });

      const otherRecipients = recipients.filter((recipient) => !sameAddress(recipient.contractAddress, normalizedContract));
      persistRecipients([...otherRecipients, ...nextFromContract]);

      const contractPayments = chainHistory.map((item, index) => {
        const timestamp = Number(item.timestamp);
        const amount = formatEther(item.amount);
        const eventMatch = paymentLogs.find(
          (payment) =>
            sameAddress(payment.wallet, item.wallet) &&
            payment.amount === amount &&
            payment.timestamp === timestamp
        );
        const existing = paymentHistory.find(
          (history) =>
            sameAddress(history.contractAddress, normalizedContract) &&
            sameAddress(history.wallet, item.wallet) &&
            history.recipientLabel === item.label &&
            history.amount === amount &&
            history.timestamp === timestamp &&
            history.txHash
        );
        return {
          id: existing?.id ?? `${normalizedContract}-history-${index}-${timestamp}`,
          contractAddress: normalizedContract,
          recipientLabel: item.label,
          wallet: item.wallet,
          amount,
          timestamp,
          txHash: existing?.txHash || eventMatch?.txHash || "",
          source: existing?.txHash ? existing.source : "contract"
        } satisfies LocalPayment;
      });

      const historyKeys = new Set(
        contractPayments.map((payment) => `${payment.recipientLabel}-${payment.wallet.toLowerCase()}-${payment.amount}-${payment.timestamp}`)
      );
      const logOnlyPayments = paymentLogs.filter(
        (payment) => !historyKeys.has(`${payment.recipientLabel}-${payment.wallet.toLowerCase()}-${payment.amount}-${payment.timestamp}`)
      );

      const paymentsWithHashes = [...contractPayments, ...logOnlyPayments];
      const otherPayments = paymentHistory.filter((item) => !sameAddress(item.contractAddress, normalizedContract));
      persistHistory([...paymentsWithHashes.reverse(), ...otherPayments]);
    } catch (error) {
      console.warn("[Ritual Payroll] Contract state sync skipped", error);
    }
  }, [contractAddress, normalizedContract, paymentHistory, persistHistory, persistRecipients, publicClient, recipients]);

  const updateLocalAfterBackendExecution = useCallback(
    (registration: BackendRegistration) => {
      const canUseExecutedTx = registration.lastStatus === "executed" && Boolean(registration.lastTxHash);
      if (!canUseExecutedTx) return;
      const attemptTime = registration.lastExecutionAttemptAt
        ? Math.floor(new Date(registration.lastExecutionAttemptAt).getTime() / 1000)
        : registration.lastCheckedAt
          ? Math.floor(new Date(registration.lastCheckedAt).getTime() / 1000)
          : Math.floor(Date.now() / 1000);
      const candidates = recipients.filter(
        (recipient) =>
          sameAddress(recipient.contractAddress, normalizedContract) &&
          recipient.active &&
          recipient.nextPaymentTime <= attemptTime
      );
      if (candidates.length === 0) return;

      const existingForHash = registration.lastTxHash ? paymentHistory.some((item) => item.txHash === registration.lastTxHash) : false;
      const nextRecipients = recipients.map((recipient) => {
        if (!candidates.some((candidate) => candidate.id === recipient.id)) return recipient;
        const recurring = recipient.scheduleType === "daily" || recipient.scheduleType === "weekly" || recipient.scheduleType === "monthly";
        return {
          ...recipient,
          active: recurring,
          paidCount: recipient.paidCount + 1,
          nextPaymentTime: recurring ? nextTimeAfterPayment(recipient) : recipient.nextPaymentTime
        };
      });

      persistRecipients(nextRecipients);
      const nextPayrollBalance = candidates.reduce((balance, recipient) => subtractAmount(balance, recipient.amount), payrollBalance);
      setPayrollBalance(nextPayrollBalance);
      window.localStorage.setItem(PAYROLL_BALANCE_KEY, nextPayrollBalance);

      if (!existingForHash) {
        const newPayments = candidates.map((recipient, index) => ({
          id: registration.lastTxHash ? `${registration.lastTxHash}-${index}` : `${recipient.id}-backend-confirmed-${attemptTime}`,
          contractAddress: normalizedContract,
          recipientLabel: recipient.label,
          wallet: recipient.wallet,
          amount: recipient.amount,
          timestamp: attemptTime,
          txHash: registration.lastTxHash || ""
        }));
        const dedupedNewPayments = newPayments.filter(
          (payment) => !paymentHistory.some((item) => item.id === payment.id)
        );
        if (dedupedNewPayments.length > 0) {
          persistHistory([...dedupedNewPayments, ...paymentHistory]);
        }
      }
    },
    [normalizedContract, paymentHistory, payrollBalance, persistHistory, persistRecipients, recipients]
  );

  async function postAutomationRegistration(targetAddress: string) {
    if (!AUTOMATION_API_URL) throw new Error("Hosted automation backend is not configured.");
    if (!isAddress(targetAddress)) throw new Error("Deploy or load a valid payroll contract first.");

    const response = await fetch(`${AUTOMATION_API_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contractAddress: targetAddress,
        ownerAddress: address ?? "0x0000000000000000000000000000000000000000",
        payrollName,
        chainId: ritualChain.id,
        appVersion: "mvp",
        contractVersion: "PayrollScheduler-v1",
        createdAt: new Date().toISOString()
      })
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) {
      throw new Error(json.error || `Registration failed with HTTP ${response.status}`);
    }
    window.localStorage.setItem(AUTOMATION_FLAG_KEY, "true");
    return json as { contractAddress: string; ownerAddress: string; payrollName: string; chainId: number; registeredAt?: string };
  }

  const refreshAutomation = useCallback(async () => {
    if (!AUTOMATION_API_URL || !isAddress(contractAddress)) {
      if (isAddress(contractAddress)) {
        await syncContractState();
      }
      setBackend({ connected: Boolean(AUTOMATION_API_URL), loading: false, error: "", keeperGas: "Unknown" });
      return;
    }

    setBackend((previous) => ({ ...previous, loading: true, connected: true, error: "" }));
    try {
      const [registrationsResponse, healthResponse] = await Promise.all([
        fetch(`${AUTOMATION_API_URL}/registrations`, { cache: "no-store" }),
        fetch(`${AUTOMATION_API_URL}/health`, { cache: "no-store" }).catch(() => undefined)
      ]);
      const registrationsJson = await registrationsResponse.json();
      const registrations = Array.isArray(registrationsJson.registrations) ? (registrationsJson.registrations as BackendRegistration[]) : [];
      let registration = registrations.find((item) => sameAddress(item.contractAddress, contractAddress));
      if (!registration && address && isConnected) {
        const registered = await postAutomationRegistration(contractAddress);
        registration = {
          contractAddress: registered.contractAddress,
          ownerAddress: registered.ownerAddress,
          payrollName: registered.payrollName,
          chainId: registered.chainId,
          lastStatus: "registered"
        };
      }
      let keeperGas: BackendStatus["keeperGas"] = "Unknown";
      if (healthResponse?.ok) {
        const healthJson = await healthResponse.json();
        keeperGas = healthJson.keeperBalanceRitual && Number(healthJson.keeperBalanceRitual) > 0 ? "OK" : "Low";
      }
      setBackend({ connected: registrationsResponse.ok, loading: false, registration, error: registrationsResponse.ok ? "" : "Backend status request failed.", keeperGas });
      if (registration) updateLocalAfterBackendExecution(registration);
      const stateResponse = await fetch(`${AUTOMATION_API_URL}/contract-state?contractAddress=${contractAddress}`, { cache: "no-store" });
      const stateJson = await stateResponse.json().catch(() => ({ ok: false, error: "Contract state response was not JSON." }));
      if (stateResponse.ok && stateJson.ok !== false) {
        applyContractState(stateJson as ContractStateResponse);
      } else {
        throw new Error(stateJson.error || `Contract state request failed with HTTP ${stateResponse.status}`);
      }
    } catch (error) {
      setBackend({ connected: true, loading: false, error: error instanceof Error ? error.message : "Backend request failed.", keeperGas: "Unknown" });
      await syncContractState();
    }
  }, [address, applyContractState, contractAddress, isConnected, syncContractState, updateLocalAfterBackendExecution]);

  useEffect(() => {
    if (mounted && contractAddress) {
      refreshAutomation();
    }
    // Intentionally only runs when the current contract changes. Manual refresh handles later checks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, contractAddress]);

  async function registerAutomation(targetAddress = contractAddress) {
    if (!AUTOMATION_API_URL) {
      setBackend({ connected: false, loading: false, error: "Hosted automation backend is not configured.", keeperGas: "Unknown" });
      return false;
    }
    if (!isAddress(targetAddress)) {
      setTxState({ kind: "error", title: "Automation", message: "Deploy or load a valid payroll contract first." });
      return false;
    }

    try {
      await postAutomationRegistration(targetAddress);
      await refreshAutomation();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automation registration failed.";
      setBackend((previous) => ({ ...previous, error: message }));
      return false;
    }
  }

  async function getWalletClient() {
    if (!address) throw new Error("Connect your wallet first.");
    if (currentChainId !== ritualChain.id) throw new Error("Switch wallet to Ritual Chain 1979 first.");
    const provider = browserEthereumProvider();
    if (!provider) throw new Error("Browser wallet provider was not found.");
    return createWalletClient({
      account: address as Address,
      chain: ritualChain,
      transport: custom(provider)
    });
  }

  async function switchNetwork() {
    try {
      const next = await switchOrAddRitualChain();
      setProviderChainId(next);
    } catch (error) {
      setTxState({ kind: "error", title: "Network", message: error instanceof Error ? error.message : "Could not switch network." });
    }
  }

  async function waitForReceipt(hash: Hash) {
    return (publicClient ?? ritualReadClient).waitForTransactionReceipt({ hash });
  }

  async function deployPayroll(event: FormEvent) {
    event.preventDefault();
    if (!payrollName.trim()) {
      setTxState({ kind: "error", title: "Deploy payroll", message: "Enter a payroll name first." });
      return;
    }
    try {
      setTxState({ kind: "pending", title: "Deploy payroll", message: "Confirm deployment in your wallet." });
      const walletClient = await getWalletClient();
      const hash = await walletClient.deployContract({
        account: address as Address,
        chain: ritualChain,
        abi: payrollSchedulerAbi,
        bytecode: payrollSchedulerBytecode,
        args: [payrollName.trim()]
      });
      setTxState({ kind: "pending", title: "Deploy payroll", message: "Waiting for Ritual Chain confirmation.", txHash: hash });
      const receipt = await waitForReceipt(hash);
      if (receipt.status !== "success" || !receipt.contractAddress) {
        throw new Error("Deployment completed, but no contract address was returned.");
      }

      const deployedAddress = receipt.contractAddress;
      window.localStorage.setItem(PAYROLL_STORAGE_KEY, deployedAddress);
      window.localStorage.setItem(PAYROLL_NAME_KEY, payrollName.trim());
      writeJson(RECIPIENTS_KEY, []);
      writeJson(HISTORY_KEY, []);
      window.localStorage.setItem(PAYROLL_BALANCE_KEY, "0");
      window.localStorage.setItem(KEEPER_BALANCE_KEY, "0");
      setContractAddress(deployedAddress);
      setRecipients([]);
      setPaymentHistory([]);
      setPayrollBalance("0");
      setKeeperBalance("0");

      const registered = await registerAutomation(deployedAddress);
      setTxState({
        kind: registered ? "success" : "error",
        title: "Deploy payroll",
        message: registered ? "Payroll deployed and automation registered." : "Payroll deployed, but automation registration failed. Use Retry automation registration.",
        txHash: hash
      });
    } catch (error) {
      console.error("[Ritual Payroll] Deploy failed", error);
      setTxState({ kind: "error", title: "Deploy payroll", message: error instanceof Error ? error.message : "Deployment failed." });
    }
  }

  async function useExistingContract() {
    if (!isAddress(existingAddress)) {
      setTxState({ kind: "error", title: "Load contract", message: "Paste a valid contract address." });
      return;
    }
    window.localStorage.setItem(PAYROLL_STORAGE_KEY, existingAddress);
    window.localStorage.setItem(PAYROLL_NAME_KEY, payrollName);
    setContractAddress(existingAddress);
    setTxState({ kind: "success", title: "Load contract", message: "Contract loaded. Checking automation backend." });
    await refreshAutomation();
  }

  async function fundPayroll(event: FormEvent) {
    event.preventDefault();
    const parsed = parsePositiveAmount(fundAmount, "Funding amount");
    if (!parsed.ok) {
      setTxState({ kind: "error", title: "Fund payroll", message: parsed.message });
      return;
    }
    try {
      setTxState({ kind: "pending", title: "Fund payroll", message: "Confirm funding in your wallet." });
      const walletClient = await getWalletClient();
      const hash = await walletClient.writeContract({
        account: address as Address,
        chain: ritualChain,
        address: contractAddress as Address,
        abi: payrollSchedulerAbi,
        functionName: "fundPayroll",
        value: parsed.value
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status !== "success") throw new Error("Funding transaction was not successful.");
      const next = addAmount(payrollBalance, fundAmount);
      setPayrollBalance(next);
      window.localStorage.setItem(PAYROLL_BALANCE_KEY, next);
      setTxState({ kind: "success", title: "Fund payroll", message: "Payroll funds confirmed.", txHash: hash });
      await syncContractState();
    } catch (error) {
      console.error("[Ritual Payroll] Fund payroll failed", error);
      setTxState({ kind: "error", title: "Fund payroll", message: error instanceof Error ? error.message : "Funding failed." });
    }
  }

  async function fundKeeper(event: FormEvent) {
    event.preventDefault();
    const parsed = parsePositiveAmount(keeperFundAmount, "Keeper fee amount");
    if (!parsed.ok) {
      setTxState({ kind: "error", title: "Fund execution fee balance", message: parsed.message });
      return;
    }
    try {
      setTxState({ kind: "pending", title: "Fund execution fee balance", message: "Confirm the RITUAL amount for automation fees in your wallet." });
      const walletClient = await getWalletClient();
      const hash = await walletClient.writeContract({
        account: address as Address,
        chain: ritualChain,
        address: contractAddress as Address,
        abi: payrollSchedulerAbi,
        functionName: "fundKeeperFees",
        value: parsed.value
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status !== "success") throw new Error("Keeper fee transaction was not successful.");
      const next = addAmount(keeperBalance, keeperFundAmount);
      setKeeperBalance(next);
      window.localStorage.setItem(KEEPER_BALANCE_KEY, next);
      setTxState({ kind: "success", title: "Fund execution fee balance", message: "Automation fee balance funded.", txHash: hash });
      await syncContractState();
    } catch (error) {
      console.error("[Ritual Payroll] Fund execution fee balance failed", error);
      setTxState({ kind: "error", title: "Fund execution fee balance", message: error instanceof Error ? error.message : "Automation fee funding failed." });
    }
  }

  async function setReward(event: FormEvent) {
    event.preventDefault();
    const parsed = parsePositiveAmount(keeperReward, "Execution fee");
    if (!parsed.ok) {
      setTxState({ kind: "error", title: "Set execution fee", message: parsed.message });
      return;
    }
    try {
      setTxState({ kind: "pending", title: "Set execution fee", message: "Confirm the execution fee amount in your wallet." });
      const walletClient = await getWalletClient();
      const hash = await walletClient.writeContract({
        account: address as Address,
        chain: ritualChain,
        address: contractAddress as Address,
        abi: payrollSchedulerAbi,
        functionName: "setKeeperRewardAmount",
        args: [parsed.value]
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status !== "success") throw new Error("Execution fee update was not successful.");
      window.localStorage.setItem(KEEPER_REWARD_KEY, keeperReward);
      setTxState({ kind: "success", title: "Set execution fee", message: "Execution fee updated.", txHash: hash });
      await syncContractState();
    } catch (error) {
      console.error("[Ritual Payroll] Set execution fee failed", error);
      setTxState({ kind: "error", title: "Set execution fee", message: error instanceof Error ? error.message : "Execution fee update failed." });
    }
  }

  async function addRecipients(event: FormEvent) {
    event.preventDefault();
    if (!recipientLabel.trim()) {
      setTxState({ kind: "error", title: "Add recipient", message: "Enter a recipient label." });
      return;
    }
    if (!isAddress(recipientWallet)) {
      setTxState({ kind: "error", title: "Add recipient", message: "Enter a valid recipient wallet address." });
      return;
    }
    const parsed = parsePositiveAmount(recipientAmount, "Recipient amount");
    if (!parsed.ok) {
      setTxState({ kind: "error", title: "Add recipient", message: parsed.message });
      return;
    }

    const selectedTimes = scheduleType === "custom" ? customTimes : [startTime];
    const timestamps = selectedTimes.map(timestampFromInput).filter((value) => value > 0);
    if (timestamps.length === 0) {
      setTxState({ kind: "error", title: "Add recipient", message: "Choose at least one valid payout time." });
      return;
    }

    const frequency: Frequency = scheduleType === "daily" ? 1 : scheduleType === "weekly" ? 2 : scheduleType === "monthly" ? 3 : 0;

    try {
      const walletClient = await getWalletClient();
      const added: LocalRecipient[] = [];
      for (let index = 0; index < timestamps.length; index += 1) {
        setTxState({
          kind: "pending",
          title: scheduleType === "custom" ? "Add custom schedule" : "Add recipient",
          message: `Confirm payout entry ${index + 1} of ${timestamps.length} in your wallet.`
        });
        const hash = await walletClient.writeContract({
          account: address as Address,
          chain: ritualChain,
          address: contractAddress as Address,
          abi: payrollSchedulerAbi,
          functionName: "addRecipient",
          args: [recipientWallet as Address, recipientLabel.trim(), parsed.value, frequency, BigInt(timestamps[index])]
        });
        const receipt = await waitForReceipt(hash);
        if (receipt.status !== "success") throw new Error(`Payout entry ${index + 1} was not confirmed.`);
        added.push({
          id: `${contractAddress.toLowerCase()}-${Date.now()}-${index}`,
          contractAddress: contractAddress.toLowerCase(),
          label: recipientLabel.trim(),
          wallet: recipientWallet as Address,
          amount: recipientAmount,
          frequency,
          scheduleType,
          nextPaymentTime: timestamps[index],
          active: true,
          paidCount: 0,
          addTxHash: hash
        });
      }

      persistRecipients([...recipients, ...added]);
      setTxState({
        kind: "success",
        title: scheduleType === "custom" ? "Add custom schedule" : "Add recipient",
        message: `${added.length} payout entr${added.length === 1 ? "y" : "ies"} created.`
      });
      await refreshAutomation();
    } catch (error) {
      console.error("[Ritual Payroll] Add recipient failed", error);
      setTxState({ kind: "error", title: "Add recipient", message: error instanceof Error ? error.message : "Could not add recipient." });
    }
  }

  async function executeDuePayments() {
    if (dueRecipients.length === 0) {
      setTxState({ kind: "error", title: "Manual fallback", message: "No local payouts are due right now." });
      return;
    }
    try {
      setTxState({ kind: "pending", title: "Manual fallback", message: "Confirm executeDuePayments in your wallet." });
      const walletClient = await getWalletClient();
      const hash = await walletClient.writeContract({
        account: address as Address,
        chain: ritualChain,
        address: contractAddress as Address,
        abi: payrollSchedulerAbi,
        functionName: "executeDuePayments"
      });
      const receipt = await waitForReceipt(hash);
      if (receipt.status !== "success") throw new Error("Execute transaction was not successful.");
      const executedAt = Math.floor(Date.now() / 1000);
      const nextRecipients = recipients.map((recipient) => {
        if (!dueRecipients.some((due) => due.id === recipient.id)) return recipient;
        const recurring = recipient.scheduleType === "daily" || recipient.scheduleType === "weekly" || recipient.scheduleType === "monthly";
        return {
          ...recipient,
          active: recurring,
          paidCount: recipient.paidCount + 1,
          nextPaymentTime: recurring ? nextTimeAfterPayment(recipient) : recipient.nextPaymentTime
        };
      });
      persistRecipients(nextRecipients);
      const nextHistory = [
        ...dueRecipients.map((recipient, index) => ({
          id: `${hash}-${index}`,
          contractAddress: normalizedContract,
          recipientLabel: recipient.label,
          wallet: recipient.wallet,
          amount: recipient.amount,
          timestamp: executedAt,
          txHash: hash
        })),
        ...paymentHistory
      ];
      persistHistory(nextHistory);
      const nextPayroll = dueRecipients.reduce((balance, recipient) => subtractAmount(balance, recipient.amount), payrollBalance);
      setPayrollBalance(nextPayroll);
      window.localStorage.setItem(PAYROLL_BALANCE_KEY, nextPayroll);
      if (Number(keeperReward) > 0 && Number(keeperBalance) >= Number(keeperReward)) {
        const nextKeeper = subtractAmount(keeperBalance, keeperReward);
        setKeeperBalance(nextKeeper);
        window.localStorage.setItem(KEEPER_BALANCE_KEY, nextKeeper);
      }
      setTxState({ kind: "success", title: "Manual fallback", message: "Due payments executed.", txHash: hash });
      await refreshAutomation();
    } catch (error) {
      console.error("[Ritual Payroll] Execute due payments failed", error);
      setTxState({ kind: "error", title: "Manual fallback", message: error instanceof Error ? error.message : "Execute failed." });
    }
  }

  function clearLocalContract() {
    [
      PAYROLL_STORAGE_KEY,
      PAYROLL_NAME_KEY,
      RECIPIENTS_KEY,
      HISTORY_KEY,
      PAYROLL_BALANCE_KEY,
      KEEPER_BALANCE_KEY,
      KEEPER_REWARD_KEY,
      AUTOMATION_FLAG_KEY,
      "ritual-payroll-contract-address",
      "ritual-payroll-scheduler-last-contract-address"
    ].forEach((key) => window.localStorage.removeItem(key));
    setContractAddress("");
    setRecipients([]);
    setPaymentHistory([]);
    setPayrollBalance("0");
    setKeeperBalance("0");
    setBackend({ connected: Boolean(AUTOMATION_API_URL), loading: false, error: "", keeperGas: "Unknown" });
    setTxState({ kind: "success", title: "Clear local contract", message: "Local payroll view cleared. You can deploy a fresh payroll contract." });
  }

  function removeRecipient(id: string) {
    const next = recipients.filter((recipient) => recipient.id !== id);
    persistRecipients(next);
  }

  function toggleRecipient(id: string) {
    const next = recipients.map((recipient) => (recipient.id === id ? { ...recipient, active: !recipient.active } : recipient));
    persistRecipients(next);
  }

  const actionDisabled = !deployed || !isConnected || !isRitual;

  return (
    <main>
      <Header />

      <section className="hero">
        <div>
          <div className="system-strip"><span aria-hidden="true" /> Payroll automation online</div>
          <p className="eyebrow">Ritual Testnet Payroll</p>
          <h2>Ritual Payroll Scheduler</h2>
          <p className="subtitle">Schedule contributor payouts on Ritual testnet.</p>
          <p className="hero-text">
            Deploy your payroll contract, fund payouts and automation fees, then let hosted execution pay due recipients without using your wallet.
          </p>
        </div>
        <div className="hero-panel">
          <div className="ritual-logo-frame">
            <img src="/ritual-logo.jpeg" alt="Ritual" />
          </div>
          <span>Due payments ready now</span>
          <strong>{dueRecipients.length}</strong>
          <p>{contractRegistered ? "Automation active" : "Manual fallback available"}</p>
        </div>
      </section>

      {!isConnected && (
        <div className="notice waiting">
          <div>
            <strong>Connect wallet</strong>
            <p>Connect your browser wallet to deploy and manage a payroll contract.</p>
          </div>
        </div>
      )}

      {isConnected && !isRitual && (
        <div className="notice error network-warning">
          <div>
            <strong>Wrong network</strong>
            <p>
              Current chain: {knownChainName(currentChainId)} {currentChainId ?? "unknown"}. Required chain: Ritual Chain 1979.
            </p>
          </div>
          <button className="button secondary network-switch" type="button" onClick={switchNetwork}>
            Switch to Ritual Chain
          </button>
        </div>
      )}

      {txState.kind !== "idle" && (
        <div className={`notice ${txState.kind === "error" ? "error" : txState.kind === "success" ? "success" : "waiting"}`}>
          <div>
            <strong>{txState.title}</strong>
            <p>{txState.message}</p>
          </div>
          {txState.txHash && (
            <a className="tx-link" href={explorerTxUrl(txState.txHash)} target="_blank" rel="noreferrer">
              View transaction {shortAddress(txState.txHash)}
            </a>
          )}
        </div>
      )}

      {!deployed ? (
        <section className="grid two">
          <section className="card stack">
            <p className="eyebrow">Contract</p>
            <h3>Deploy payroll</h3>
            <form className="stack" onSubmit={deployPayroll}>
              <label>
                Payroll name
                <input value={payrollName} onChange={(event) => setPayrollName(event.target.value)} placeholder="Ritual Contributor Payroll" />
              </label>
              <button className="button primary" type="submit" disabled={!isConnected || !isRitual || txState.kind === "pending"}>
                Deploy Payroll Contract
              </button>
            </form>
            <div className="manual-load">
              <label>
                Existing payroll contract
                <input value={existingAddress} onChange={(event) => setExistingAddress(event.target.value)} placeholder="0x..." />
              </label>
              <button className="button secondary" type="button" onClick={useExistingContract}>
                Load existing contract
              </button>
            </div>
          </section>

          <section className="card">
            <p className="eyebrow">Network</p>
            <h3>Wallet status</h3>
            <div className="status-list">
              <div><span>Wallet</span><strong>{shortAddress(address)}</strong></div>
              <div><span>Status</span><strong>{isConnected && isRitual ? "Ready" : "Not ready"}</strong></div>
              <div><span>Actual chain</span><strong>{currentChainId ?? "unknown"}</strong></div>
              <div><span>Expected chain</span><strong>Ritual Chain 1979</strong></div>
            </div>
          </section>
        </section>
      ) : (
        <>
          <section className="grid two">
            <section className="card stack">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">Contract</p>
                  <h3>Payroll contract</h3>
                </div>
                <button className="button ghost small" type="button" onClick={clearLocalContract}>
                  Clear local contract
                </button>
              </div>
              <div className="contract-address">
                <span className="mono">{contractAddress}</span>
                <a href={explorerAddressUrl(contractAddress)} target="_blank" rel="noreferrer">Explorer</a>
              </div>
              <div className="stats-grid">
                <div className="stat-card"><span>Payroll name</span><strong>{payrollName}</strong></div>
                <div className="stat-card purple"><span>Payroll funds ({accountingSource})</span><strong>{displayAmount(payrollBalance)} RITUAL</strong></div>
                <div className="stat-card"><span>Automation fee balance ({accountingSource})</span><strong>{displayAmount(keeperBalance)} RITUAL</strong></div>
                <div className="stat-card"><span>Active payouts</span><strong>{activeRecipients.length}</strong></div>
                <div className="stat-card orange"><span>Due now</span><strong>{dueRecipients.length}</strong></div>
              </div>
              <div className="status-list">
                <div><span>Contract status</span><strong>deployed on Ritual Chain</strong></div>
                <div><span>Dashboard</span><strong>{accountingSource === "On-chain" ? "On-chain accounting" : "Browser view"}</strong></div>
                <p className="hint">
                  This dashboard records successful wallet and automation transactions in this browser. For production, history should be rebuilt from contract events.
                </p>
                <div><span>Next payment</span><strong>{nextPayment ? formatTime(nextPayment.nextPaymentTime) : "Not scheduled"}</strong></div>
              </div>
            </section>

            <section className="card">
              <p className="eyebrow">Network</p>
              <h3>Wallet status</h3>
              <div className="status-list">
                <div><span>Wallet</span><strong>{shortAddress(address)}</strong></div>
                <div><span>Status</span><strong>{isConnected && isRitual ? "Ready" : "Not ready"}</strong></div>
                <div><span>Actual chain ID</span><strong>{currentChainId ?? "unknown"}</strong></div>
                <div><span>Actual chain name</span><strong>{knownChainName(currentChainId)}</strong></div>
                <div><span>Expected chain</span><strong>Ritual Chain 1979</strong></div>
              </div>
            </section>
          </section>

          <section className="grid two">
            <form className="card stack" onSubmit={addRecipients}>
              <p className="eyebrow">Recipients</p>
              <h3>Add scheduled payout</h3>
              <label>
                Label
                <input value={recipientLabel} onChange={(event) => setRecipientLabel(event.target.value)} placeholder="Design contributor" />
              </label>
              <label>
                Wallet address
                <input value={recipientWallet} onChange={(event) => setRecipientWallet(event.target.value)} placeholder="0x..." />
              </label>
              <div className="form-grid">
                <label>
                  Amount in RITUAL
                  <input value={recipientAmount} onChange={(event) => setRecipientAmount(event.target.value)} placeholder="0.01" />
                </label>
                <label>
                  Schedule type
                  <select value={scheduleType} onChange={(event) => setScheduleType(event.target.value as ScheduleType)}>
                    <option value="one-time">One-time</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="custom">Custom dates/times</option>
                  </select>
                </label>
              </div>
              {scheduleType === "custom" ? (
                <div className="custom-schedule stack">
                  <p className="hint">Custom schedule creates one on-chain payout entry per selected time.</p>
                  {customTimes.map((time, index) => (
                    <div className="custom-time-row" key={`${time}-${index}`}>
                      <label>
                        Payout time {index + 1}
                        <input
                          type="datetime-local"
                          value={time}
                          onChange={(event) => setCustomTimes(customTimes.map((item, itemIndex) => (itemIndex === index ? event.target.value : item)))}
                        />
                      </label>
                      <button className="button ghost small" type="button" onClick={() => setCustomTimes(customTimes.filter((_, itemIndex) => itemIndex !== index))}>
                        Remove
                      </button>
                    </div>
                  ))}
                  <button className="button ghost" type="button" onClick={() => setCustomTimes([...customTimes, localDateTimeValue(10 + customTimes.length * 2)])}>
                    Add another payout time
                  </button>
                  <p className="hint">This will create {customTimes.length} payout entries and require {customTimes.length} wallet confirmations.</p>
                </div>
              ) : (
                <label>
                  Start date/time
                  <input type="datetime-local" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
                </label>
              )}
              <button className="button primary" type="submit" disabled={actionDisabled || txState.kind === "pending"}>
                {scheduleType === "custom" ? "Add custom schedule" : "Add recipient"}
              </button>
            </form>

            <div className="stack">
              <form className="card stack" onSubmit={fundPayroll}>
                <p className="eyebrow">Funding</p>
                <h3>Fund payroll</h3>
                <label>
                  Amount in RITUAL
                  <input value={fundAmount} onChange={(event) => setFundAmount(event.target.value)} />
                </label>
                <button className="button primary" type="submit" disabled={actionDisabled || txState.kind === "pending"}>Fund payroll</button>
              </form>

              <form className="card stack" onSubmit={setReward}>
                <p className="eyebrow">Automation fees</p>
                <h3>Execution fee balance</h3>
                <p className="hint">Add RITUAL to the payroll contract so hosted automation can cover execution costs when a real payout is due. The keeper cannot access your wallet.</p>
                <label>
                  Fee paid per successful execution
                  <input value={keeperReward} onChange={(event) => setKeeperReward(event.target.value)} />
                </label>
                <button className="button primary" type="submit" disabled={actionDisabled || txState.kind === "pending"}>Set execution fee</button>
                <label>
                  Add RITUAL for automation fees
                  <input value={keeperFundAmount} onChange={(event) => setKeeperFundAmount(event.target.value)} />
                </label>
                <button className="button secondary" type="button" onClick={fundKeeper} disabled={actionDisabled || txState.kind === "pending"}>Fund execution balance</button>
              </form>

              <section className="card execute-card stack">
                <p className="eyebrow">Execution</p>
                <h3>Manual fallback</h3>
                <p className="hint">Use this only if hosted automation is not enabled. Anyone can execute, but the contract only pays due recipients.</p>
                <button className="button primary" type="button" onClick={executeDuePayments} disabled={actionDisabled || dueRecipients.length === 0 || txState.kind === "pending"}>
                  Execute Due Payments
                </button>
              </section>
            </div>
          </section>

          <section className="card automation-card stack">
            <p className="eyebrow">Automation</p>
            <h3>Automation</h3>
            <p className="hint">Automation runs through the hosted keeper. Your wallet does not need to confirm each payout. Funds stay in the payroll contract.</p>
            <div className="stats-grid">
              <div className="stat-card"><span>Automation status</span><strong>{automationStatus}</strong></div>
              <div className="stat-card purple"><span>Backend connected</span><strong>{AUTOMATION_API_URL ? (backend.connected ? "Yes" : "Check failed") : "Not configured"}</strong></div>
              <div className="stat-card"><span>Contract registration</span><strong>{contractRegistered ? "Registered" : backend.registration?.disabled ? "Disabled" : "Not registered"}</strong></div>
              <div className="stat-card"><span>Keeper gas</span><strong>{backend.keeperGas}</strong></div>
              <div className="stat-card orange"><span>Last execution result</span><strong>{statusText(backend.registration?.lastStatus)}</strong></div>
              <div className="stat-card purple"><span>Last worker check</span><strong>{formatTime(backend.registration?.lastCheckedAt || backend.registration?.lastObservedAt)}</strong></div>
            </div>
            {backend.registration?.lastTxHash && (
              <a className="tx-link" href={explorerTxUrl(backend.registration.lastTxHash)} target="_blank" rel="noreferrer">
                Latest backend execute {shortAddress(backend.registration.lastTxHash)}
              </a>
            )}
            <p className={shouldShowBackendError(backend.registration) ? "error-text" : "hint"}>{backendMessage(backend.registration)}</p>
            <div className="button-row">
              {contractRegistered ? (
                <button className="button primary" type="button" disabled>Automation active</button>
              ) : (
                <button className="button primary" type="button" onClick={() => registerAutomation()} disabled={!deployed || backend.loading}>
                  {backend.registration?.disabled ? "Register current contract again" : "Enable automation"}
                </button>
              )}
              <button className="button secondary" type="button" onClick={refreshAutomation} disabled={backend.loading}>
                {backend.loading ? "Refreshing..." : "Refresh automation status"}
              </button>
              <button className="button ghost" type="button" onClick={() => navigator.clipboard?.writeText(contractAddress)}>Copy contract address</button>
            </div>
          </section>

          <section className="card table-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">Overview</p>
                <h3>Recipients</h3>
                <p className="hint">Only active scheduled payouts are shown here. Completed one-time/custom payouts move to Payment history.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Wallet</th>
                    <th>Amount</th>
                    <th>Schedule</th>
                    <th>Next payment</th>
                    <th>Paid</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRecipients.length === 0 ? (
                    <tr><td colSpan={8}>No active scheduled payouts. Completed payouts are listed in Payment history.</td></tr>
                  ) : (
                    activeRecipients.map((recipient) => (
                      <tr key={recipient.id}>
                        <td>{recipient.label}</td>
                        <td className="mono">{shortAddress(recipient.wallet)}</td>
                        <td>{recipient.amount} RITUAL</td>
                        <td>{recipient.scheduleType === "custom" ? "custom" : frequencyLabels[recipient.frequency]}</td>
                        <td>{formatTime(recipient.nextPaymentTime)}</td>
                        <td>{recipient.paidCount}</td>
                        <td><span className={`status-badge ${recipient.active ? "active" : "paused"}`}>{recipient.active ? "active" : "inactive"}</span></td>
                        <td>
                          <div className="row-actions">
                            <button className="button ghost mini" type="button" onClick={() => toggleRecipient(recipient.id)}>{recipient.active ? "Pause" : "Resume"}</button>
                            <button className="button danger mini" type="button" onClick={() => removeRecipient(recipient.id)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card table-card">
            <p className="eyebrow">Ledger</p>
            <h3>Payment history</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Amount</th>
                    <th>Timestamp</th>
                    <th>Explorer</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHistory.length === 0 ? (
                    <tr><td colSpan={4}>No payments executed yet.</td></tr>
                  ) : (
                    visibleHistory.map((item) => (
                      <tr key={item.id}>
                        <td>{item.recipientLabel}<span className="subtle mono">{shortAddress(item.wallet)}</span></td>
                        <td>{item.amount} RITUAL</td>
                        <td>{formatTime(item.timestamp)}</td>
                        <td>
                          {item.txHash ? (
                            <a className="tx-link" href={explorerTxUrl(item.txHash)} target="_blank" rel="noreferrer">Payment tx {shortAddress(item.txHash)}</a>
                          ) : (
                            <span className="subtle">Synced from contract history</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
