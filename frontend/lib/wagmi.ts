import { createConfig, http } from "wagmi";
import { injected } from "@wagmi/core";
import { ritualChain } from "./chain";

export const wagmiConfig = createConfig({
  chains: [ritualChain],
  connectors: [
    injected({
      shimDisconnect: true
    })
  ],
  transports: {
    [ritualChain.id]: http("https://rpc.ritualfoundation.org")
  },
  ssr: true
});
