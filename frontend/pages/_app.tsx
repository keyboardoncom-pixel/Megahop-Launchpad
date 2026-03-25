import "../styles/globals.css";
import type { AppProps } from "next/app";
import dynamic from "next/dynamic";

const ClientThirdwebProvider = dynamic(() => import("../components/ClientThirdwebProvider"), {
  ssr: false,
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <ClientThirdwebProvider>
      <Component {...pageProps} />
    </ClientThirdwebProvider>
  );
}
