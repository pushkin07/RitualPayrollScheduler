import artifact from "./PayrollScheduler.json";
import type { Abi, Hex } from "viem";

export const PAYROLL_STORAGE_KEY = "ritual-payroll-scheduler-contract-address";

function readArtifactBytecode(): Hex {
  const candidate = typeof artifact.bytecode === "string" ? artifact.bytecode : artifact.bytecode?.object;
  if (typeof candidate !== "string") {
    throw new Error("PayrollScheduler creation bytecode is missing from the Foundry artifact.");
  }
  return candidate as Hex;
}

export const payrollSchedulerAbi = [
  {
    type: "constructor",
    inputs: [{ name: "_payrollName", type: "string", internalType: "string" }],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "addRecipient",
    inputs: [
      { name: "wallet", type: "address", internalType: "address" },
      { name: "label", type: "string", internalType: "string" },
      { name: "amount", type: "uint256", internalType: "uint256" },
      { name: "frequency", type: "uint8", internalType: "uint8" },
      { name: "startTime", type: "uint256", internalType: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  { type: "function", name: "fundPayroll", inputs: [], outputs: [], stateMutability: "payable" },
  { type: "function", name: "fundKeeperFees", inputs: [], outputs: [], stateMutability: "payable" },
  {
    type: "function",
    name: "setKeeperRewardAmount",
    inputs: [{ name: "newAmount", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "getAccounting",
    inputs: [],
    outputs: [
      { name: "payrollReserved_", type: "uint256", internalType: "uint256" },
      { name: "keeperFeeReserved_", type: "uint256", internalType: "uint256" },
      { name: "keeperRewardAmount_", type: "uint256", internalType: "uint256" },
      { name: "contractBalance", type: "uint256", internalType: "uint256" }
    ],
    stateMutability: "view"
  },
  { type: "function", name: "executeDuePayments", inputs: [], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "pauseRecipient",
    inputs: [{ name: "recipientId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "resumeRecipient",
    inputs: [{ name: "recipientId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "removeRecipient",
    inputs: [{ name: "recipientId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "withdrawPayrollFunds",
    inputs: [{ name: "amount", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "withdrawKeeperFees",
    inputs: [{ name: "amount", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable"
  }
] as Abi;
export const payrollSchedulerBytecode = readArtifactBytecode();

export function validatePayrollSchedulerArtifact() {
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    throw new Error("PayrollScheduler ABI is missing or invalid.");
  }

  if (typeof payrollSchedulerBytecode !== "string" || !payrollSchedulerBytecode.startsWith("0x") || payrollSchedulerBytecode.length <= 2) {
    throw new Error("PayrollScheduler bytecode is missing or does not start with 0x.");
  }

  const constructor = artifact.abi.find((item) => item.type === "constructor");
  if (
    !constructor ||
    !Array.isArray(constructor.inputs) ||
    constructor.inputs.length !== 1 ||
    constructor.inputs[0]?.type !== "string"
  ) {
    throw new Error("PayrollScheduler constructor ABI must be constructor(string payrollName).");
  }
}

export type Frequency = 0 | 1 | 2 | 3;

export type Recipient = {
  wallet: `0x${string}`;
  label: string;
  amount: bigint;
  frequency: Frequency;
  nextPaymentTime: bigint;
  active: boolean;
  paidCount: bigint;
  removed: boolean;
};

export type PaymentHistory = {
  recipientId: bigint;
  wallet: `0x${string}`;
  label: string;
  amount: bigint;
  timestamp: bigint;
};

export const frequencyLabels: Record<Frequency, string> = {
  0: "one-time",
  1: "daily",
  2: "weekly",
  3: "monthly"
};
