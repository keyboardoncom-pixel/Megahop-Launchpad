import dynamic from "next/dynamic";

const IndexPageClient = dynamic(() => import("../components/IndexPageClient"), {
  ssr: false,
});

export default function HomePage() {
  return <IndexPageClient />;
}
