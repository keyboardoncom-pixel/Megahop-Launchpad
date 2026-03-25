import dynamic from "next/dynamic";

const AdminPageClient = dynamic(() => import("../components/AdminPageClient"), {
  ssr: false,
});

export default function AdminPage() {
  return <AdminPageClient />;
}
