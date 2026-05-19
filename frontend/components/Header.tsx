"use client";

import { useEffect, useState } from "react";
import { useAccount, useChainId, useConnect, useDisconnect } from "wagmi";
import { ritualChain } from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import { readProviderChainId, subscribeProviderChainChanged, switchOrAddRitualChain } from "@/lib/walletChain";

export function Header() {
  const [mounted, setMounted] = useState(false);
  const [providerChainId, setProviderChainId] = useState<number>();
  const [isSwitching, setIsSwitching] = useState(false);
  const { address, isConnected } = useAccount();
  const wagmiChainId = useChainId();
  const { connectors, connect, isPending: isConnecting } = useConnect();
  const { disconnect } = useDisconnect();
  const actualChainId = providerChainId ?? wagmiChainId;
  const isRitual = actualChainId === ritualChain.id;
  const canUseWallet = mounted && connectors.length > 0;

  useEffect(() => {
    setMounted(true);
    readProviderChainId()
      .then(setProviderChainId)
      .catch(() => setProviderChainId(undefined));
    return subscribeProviderChainChanged(setProviderChainId);
  }, []);

  async function switchToRitual() {
    setIsSwitching(true);
    try {
      const nextChainId = await switchOrAddRitualChain();
      setProviderChainId(nextChainId);
    } catch (error) {
      console.error("[Ritual Payroll Scheduler] Switch to Ritual Chain failed", error);
    } finally {
      setIsSwitching(false);
    }
  }

  return (
    <header className="app-header" suppressHydrationWarning>
      <div className="header-brand">
        <img className="header-logo" src="/ritual-logo.jpeg" alt="Ritual logo" />
        <div>
          <p className="eyebrow">Ritual Payroll Scheduler</p>
          <h1>Contributor payouts, held and paid on-chain.</h1>
        </div>
      </div>

      <div className="wallet-cluster">
        <div className={`network-pill ${isConnected && isRitual ? "ok" : "warn"}`}>
          {!mounted ? "Wallet loading" : isConnected ? (isRitual ? "Ritual Chain 1979" : `Wrong network ${actualChainId ?? "unknown"}`) : "Wallet disconnected"}
        </div>
        {mounted && isConnected && <div className="address-pill">{shortAddress(address)}</div>}
        {mounted && isConnected && !isRitual && (
          <button className="button secondary" type="button" onClick={switchToRitual} disabled={isSwitching}>
            {isSwitching ? "Switching..." : "Switch to Ritual Chain"}
          </button>
        )}
        {mounted && isConnected ? (
          <button className="button ghost" type="button" onClick={() => disconnect()}>
            Disconnect
          </button>
        ) : (
          <button className="button primary" type="button" onClick={() => connect({ connector: connectors[0] })} disabled={!canUseWallet || isConnecting}>
            {isConnecting ? "Connecting..." : "Connect wallet"}
          </button>
        )}
      </div>
    </header>
  );
}
