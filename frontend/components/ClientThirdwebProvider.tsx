import type { ReactNode } from "react";
import { WalletProvider } from "../lib/wallet";

type ClientThirdwebProviderProps = {
  children: ReactNode;
};

export default function ClientThirdwebProvider({ children }: ClientThirdwebProviderProps) {
  return <WalletProvider>{children}</WalletProvider>;
}
