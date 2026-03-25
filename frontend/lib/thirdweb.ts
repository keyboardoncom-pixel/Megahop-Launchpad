import { createThirdwebClient, defineChain } from "thirdweb";

const clientId = process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID || "";
const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || 6343);
const networkName = process.env.NEXT_PUBLIC_NETWORK_NAME || "MegaETH Testnet";
const nativeSymbol = process.env.NEXT_PUBLIC_NATIVE_SYMBOL || "ETH";
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://carrot.megaeth.com/rpc";
const blockExplorerUrl =
  process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL || "https://megaeth-testnet-v2.blockscout.com";
const fallbackClientId = "local-dev-placeholder-client-id";

if (!clientId && typeof window !== "undefined") {
  console.warn("Missing NEXT_PUBLIC_THIRDWEB_CLIENT_ID for thirdweb ConnectButton.");
}

export const THIRDWEB_CLIENT = createThirdwebClient({
  clientId: clientId || fallbackClientId,
});
export const TARGET_CHAIN = defineChain({
  id: chainId,
  name: networkName,
  nativeCurrency: {
    name: nativeSymbol,
    symbol: nativeSymbol,
    decimals: 18,
  },
  rpc: rpcUrl,
  blockExplorers: [
    {
      name: "MegaETH Explorer",
      url: blockExplorerUrl,
    },
  ],
});
