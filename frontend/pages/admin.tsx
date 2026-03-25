import dynamic from "next/dynamic";
import Head from "next/head";

const AdminPageClient = dynamic(() => import("../components/AdminPageClient"), {
  ssr: false,
});

export default function AdminPage() {
  return (
    <>
      <Head>
        <title>Megahop Admin | Launchpad Control</title>
        <meta
          name="description"
          content="Manage Megahop mint settings, metadata, and phases from the official launchpad admin panel."
        />
        <meta property="og:title" content="Megahop Admin | Launchpad Control" />
        <meta
          property="og:description"
          content="Manage Megahop mint settings, metadata, and phases from the official launchpad admin panel."
        />
      </Head>
      <AdminPageClient />
    </>
  );
}
