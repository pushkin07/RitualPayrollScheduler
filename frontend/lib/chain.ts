import { defineChain } from "viem";

export const RITUAL_EXPLORER_URL = "https://explorer.ritualfoundation.org";

export const ritualChain = defineChain({
  id: 1979,
  name: "Ritual Chain",
  nativeCurrency: {
    decimals: 18,
    name: "RITUAL",
    symbol: "RITUAL"
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.ritualfoundation.org"]
    }
  },
  blockExplorers: {
    default: {
      name: "Ritual Explorer",
      url: RITUAL_EXPLORER_URL
    }
  },
  contracts: {
    multicall3: {
      address: "0x5577Ea679673Ec7508E9524100a188E7600202a3"
    }
  }
});

export function explorerAddressUrl(address: string) {
  return `${RITUAL_EXPLORER_URL}/address/${address}`;
}

export function explorerTxUrl(hash: string) {
  return `${RITUAL_EXPLORER_URL}/tx/${hash}`;
}
