import dynamic from "next/dynamic";
import Head from "next/head";

const IndexPageClient = dynamic(() => import("../components/IndexPageClient"), {
  ssr: false,
});

export default function HomePage() {
  return (
    <>
      <Head>
        <title>Megahop | Official Mint</title>
        <meta
          name="description"
          content="Official Megahop mint on MegaETH. Connect your wallet, switch to MegaETH, and mint from the live collection."
        />
        <meta property="og:title" content="Megahop | Official Mint" />
        <meta
          property="og:description"
          content="Official Megahop mint on MegaETH. Connect your wallet, switch to MegaETH, and mint from the live collection."
        />
        <meta name="twitter:title" content="Megahop | Official Mint" />
        <meta
          name="twitter:description"
          content="Official Megahop mint on MegaETH. Connect your wallet, switch to MegaETH, and mint from the live collection."
        />
      </Head>
      <IndexPageClient />
    </>
  );
}
