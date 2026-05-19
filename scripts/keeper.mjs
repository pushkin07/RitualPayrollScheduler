import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromFrontend = createRequire(new URL("../frontend/package.json", import.meta.url));
const viemPath = requireFromFrontend.resolve("viem");
const accountsPath = requireFromFrontend.resolve("viem/accounts");
const { createPublicClient, createWalletClient, http } = await import(pathToFileURL(viemPath));
const { privateKeyToAccount } = await import(pathToFileURL(accountsPath));

const ritualChain = {
  id: 1979,
  name: "Ritual Chain",
  nativeCurrency: { name: "RITUAL", symbol: "RITUAL", decimals: 18 },
  rpcUrls: { default: { http: [process.env.RITUAL_RPC_URL ?? "https://rpc.ritualfoundation.org"] } },
  blockExplorers: { default: { name: "Ritual Explorer", url: "https://explorer.ritualfoundation.org" } }
};

const executeAbi = [
  {
    type: "function",
    name: "executeDuePayments",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: []
  }
];

const contractAddress = process.env.PAYROLL_CONTRACT_ADDRESS;
const keeperPrivateKey = process.env.KEEPER_PRIVATE_KEY;

if (!contractAddress) throw new Error("PAYROLL_CONTRACT_ADDRESS is required.");
if (!keeperPrivateKey) throw new Error("KEEPER_PRIVATE_KEY is required for this off-frontend keeper script.");

const account = privateKeyToAccount(keeperPrivateKey);
const transport = http(process.env.RITUAL_RPC_URL ?? ritualChain.rpcUrls.default.http[0]);
const publicClient = createPublicClient({ chain: ritualChain, transport });
const walletClient = createWalletClient({ account, chain: ritualChain, transport });
const intervalMs = Number(process.env.KEEPER_INTERVAL_MS ?? "60000");

const expectedReward = process.env.EXPECTED_KEEPER_REWARD_RITUAL;
console.log("[keeper] starting payroll keeper", {
  contractAddress,
  keeper: account.address,
  intervalSeconds: Math.round(intervalMs / 1000),
  rewardExpected: expectedReward ? `${expectedReward} RITUAL` : "unknown; dashboard tracks this locally"
});

async function runKeeperTick() {
  console.log("[keeper] calling executeDuePayments()", {
    contractAddress,
    keeper: account.address,
    rewardExpected: expectedReward ? `${expectedReward} RITUAL` : "unknown; dashboard tracks this locally"
  });

  try {
    const hash = await walletClient.writeContract({
      address: contractAddress,
      abi: executeAbi,
      functionName: "executeDuePayments",
      account,
      chain: ritualChain
    });

    console.log("[keeper] tx submitted", hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log("[keeper] tx receipt", {
      status: receipt.status,
      gasUsed: receipt.gasUsed.toString(),
      transactionHash: receipt.transactionHash,
      rewardExpected: expectedReward ? `${expectedReward} RITUAL` : "unknown"
    });
  } catch (error) {
    const message = error?.shortMessage ?? error?.message ?? String(error);
    console.log("[keeper] execution skipped or failed", {
      message,
      note: "The keeper only submits executeDuePayments(); it cannot access the owner wallet. Custom payout entries execute when their nextPaymentTime is due."
    });
  }
}

await runKeeperTick();
setInterval(runKeeperTick, intervalMs);
