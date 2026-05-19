import type { EIP1193Provider } from "viem";
import { RITUAL_EXPLORER_URL } from "@/lib/chain";

export const RITUAL_CHAIN_ID = 1979;
export const RITUAL_CHAIN_HEX = "0x7bb";

type ProviderError = {
  code?: number;
  message?: string;
};

type ProviderWithEvents = EIP1193Provider & {
  on?: (event: string, listener: (value: unknown) => void) => void;
  removeListener?: (event: string, listener: (value: unknown) => void) => void;
};

export function browserEthereumProvider() {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ethereum?: ProviderWithEvents }).ethereum;
}

export function parseProviderChainId(value: unknown) {
  if (typeof value === "string") {
    return value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
  }
  if (typeof value === "number") return value;
  return undefined;
}

export async function readProviderChainId(provider = browserEthereumProvider()) {
  if (!provider) return undefined;
  const chainId = await provider.request({ method: "eth_chainId" });
  return parseProviderChainId(chainId);
}

export async function switchOrAddRitualChain(provider = browserEthereumProvider()) {
  if (!provider) throw new Error("No browser wallet provider was found.");

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: RITUAL_CHAIN_HEX }]
    });
  } catch (error) {
    const providerError = error as ProviderError;
    const message = providerError.message ?? "";
    const shouldAddChain = providerError.code === 4902 || message.includes("Unrecognized chain") || message.includes("not added");

    if (!shouldAddChain) throw error;

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: RITUAL_CHAIN_HEX,
          chainName: "Ritual Chain",
          rpcUrls: ["https://rpc.ritualfoundation.org"],
          nativeCurrency: {
            name: "RITUAL",
            symbol: "RITUAL",
            decimals: 18
          },
          blockExplorerUrls: [RITUAL_EXPLORER_URL]
        }
      ]
    });

    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: RITUAL_CHAIN_HEX }]
    });
  }

  return readProviderChainId(provider);
}

export function subscribeProviderChainChanged(listener: (chainId: number | undefined) => void) {
  const provider = browserEthereumProvider();
  if (!provider?.on) return () => undefined;

  const handleChainChanged = (value: unknown) => listener(parseProviderChainId(value));
  provider.on("chainChanged", handleChainChanged);

  return () => provider.removeListener?.("chainChanged", handleChainChanged);
}

export function knownChainName(chainId?: number) {
  if (!chainId) return "Unknown";
  if (chainId === RITUAL_CHAIN_ID) return "Ritual Chain";
  if (chainId === 1) return "Ethereum";
  if (chainId === 56) return "BNB Smart Chain";
  if (chainId === 11155111) return "Sepolia";
  return `Chain ${chainId}`;
}
