import { explorerTxUrl } from "@/lib/chain";
import { shortAddress } from "@/lib/format";

export function TxLink({ hash, label = "View transaction" }: { hash?: string; label?: string }) {
  if (!hash) return null;

  return (
    <a className="tx-link" href={explorerTxUrl(hash)} target="_blank" rel="noreferrer">
      <span>{label}</span>
      <span className="mono">{shortAddress(hash)}</span>
    </a>
  );
}
