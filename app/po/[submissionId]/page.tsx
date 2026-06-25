import { PoEditor } from "@/components/PoEditor";

// Next.js 15: dynamic route params are async.
export default async function Page({
  params,
}: {
  params: Promise<{ submissionId: string }>;
}) {
  const { submissionId } = await params;
  return <PoEditor submissionId={decodeURIComponent(submissionId)} />;
}
